import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { NoteEdit, PageNote } from "../../cli/wire.ts";
import { Banner, Combo } from "@/components/bits";
import { type Confirm, ConfirmDialog } from "@/components/confirm-dialog";
import { KeysDialog } from "@/components/keys-dialog";
import { NoteForm } from "@/components/note-form";
import { NoteList } from "@/components/note-list";
import { NoteView } from "@/components/note-view";
import { Rail, type RailItem } from "@/components/rail";
import { Drawer, DrawerContent, DrawerIndent, DrawerIndentBackground, DrawerProvider, DrawerSwipeHandle, DrawerTitle } from "@/components/ui/drawer";
import { Toaster } from "@/components/ui/sonner";
import { MAC, PHONE, useMedia } from "@/hooks/use-media";
import { useTheme } from "@/hooks/use-theme";
import * as api from "@/lib/api";
import { pageQuery, reloadPage, useStoreWatch } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { auditScope, fromHash, neighbour, scopeName, scopesOf, show, toHash, type View } from "@/lib/view";

/** The longest the drawer takes to close. */
const CLOSE_MS = 450;
const UNDO_MS = 5000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function App() {
  const { data, error: loadError } = useQuery(pageQuery);
  const failed = loadError?.message ?? "";
  const [view, setView] = useState<View>(() => fromHash(location.hash));
  const [editing, setEditing] = useState(false);
  const [help, setHelp] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  // The scope to go back to when the cursor walks on from the scopes into the kinds.
  const held = useRef<string | null>(view.scope);
  // What ⌘Z and the toast's Undo bring back while the toast shows: one note, or one project.
  const undoing = useRef<(() => Promise<unknown>) | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const indent = useRef<HTMLDivElement>(null);
  const phone = useMedia(PHONE);
  const { theme, resolved, next: nextTheme } = useTheme();

  const watch = useStoreWatch();
  // The poll fails while the server is down, and the first load says the same.
  // Only a failed fetch means the server is down: a refusal or a 500 shows its own message.
  const offline = watch.error?.message === api.OFFLINE || (!data && failed === api.OFFLINE);
  const readOnly = !offline && watch.data?.write === false;
  const toastError = (error: Error) => void toast(error.message, { id: "kb" });

  // The repo whose audit agent this page started. When the agent ends, the page opens its cards, or says why there are none.
  const auditing = useRef<string | null>(null);
  useEffect(() => {
    const scope = auditing.current;
    const run = scope ? data?.runs[scope] : undefined;
    if (!scope || !run || run.status === "running") return;
    auditing.current = null;
    if (data!.audits.includes(scope)) location.hash = `#audit=${encodeURIComponent(scope)}`;
    else if (run.status === "nothing") toast(`The agent found nothing to change in ${scopeName(scope)}`, { id: "kb" });
    else toast(`The audit agent stopped with no cards. Its log: ${run.log}`, { id: "kb" });
  }, [data]);

  const notes = data?.notes ?? [];
  const kinds = data?.kinds ?? [];
  const shown = useMemo(() => show(notes, view), [notes, view]);
  // A scope with no notes where the list looks is not in the sidebar: a trashed project is gone
  // from the notes, and shows in the trash only while it has notes there.
  const scopes = useMemo(() => scopesOf(notes.filter((n) => n.trashed === shown.trash)), [notes, shown.trash]);
  const current = shown.current;
  const reading = phone && view.read && !!current;

  // A view from the address that no longer fits the store falls back to what is there.
  useEffect(() => {
    if (!data) return;
    const scope = view.scope && !scopes.includes(view.scope) ? null : view.scope;
    const kindsOk = view.kinds.filter((k) => kinds.includes(k));
    const trash = view.trash && shown.trashCount > 0;
    if (scope !== view.scope || kindsOk.length !== view.kinds.length || trash !== view.trash) {
      setView((v) => ({ ...v, scope, kinds: kindsOk, trash }));
    }
  }, [data, scopes, kinds, view.scope, view.kinds, view.trash, shown.trashCount]);

  // The address keeps the view, so a reload comes back to the same place. On a wide screen a note
  // the user clicks gets its own history entry, so Back goes to the note before. A j/k move only
  // replaces the entry, so holding j does not fill the history. A phone has the drawer's entry instead.
  const picked = useRef(false);
  const shownNote = useRef<string | null>(null);
  useEffect(() => {
    // A link to an audit changes the address before the page swaps to it: leave that address alone.
    if (!data || auditScope()) return;
    const id = current?.id ?? null;
    const hash = toHash({ ...view, note: id, read: reading });
    if (picked.current && !phone && shownNote.current && id && id !== shownNote.current) history.pushState(null, "", hash);
    else history.replaceState(history.state, "", hash);
    picked.current = false;
    shownNote.current = id;
  }, [data, view, current?.id, reading, phone]);

  // The tab shows the open note.
  useEffect(() => {
    document.title = current ? `${current.title} - kb` : "kb";
  }, [current?.title]);

  // A new note starts at its top, and an edit does not carry over to another note.
  useEffect(() => {
    reader.current?.scrollTo({ top: 0 });
    setEditing(false);
  }, [current?.id]);

  // ---- the sidebar ----

  const items = useMemo<RailItem[]>(
    () => [
      ...["*", ...scopes].map((scope): RailItem => ({ key: `scope:${scope}`, type: "scope", scope })),
      ...kinds.map((kind, i): RailItem => ({ key: `kind:${kind}`, type: "kind", kind, n: i + 1 })),
      ...(shown.trashCount > 0 ? [{ key: "trash", type: "trash" } as RailItem] : []),
    ],
    [scopes, kinds, shown.trashCount],
  );
  const scopeKey = `scope:${view.scope ?? "*"}`;
  const cursorKey = cursor && items.some((i) => i.key === cursor) ? cursor : scopeKey;
  const pressed = (item: RailItem) =>
    item.type === "scope" ? (view.scope ?? "*") === item.scope : item.type === "kind" ? view.kinds.includes(item.kind) : shown.trash;
  const count = (item: RailItem) =>
    item.type === "scope" ? (shown.byScope.get(item.scope) ?? 0) : item.type === "kind" ? (shown.byKind.get(item.kind) ?? 0) : shown.trashCount;
  const scopeOf = (item: RailItem) => (item.type === "scope" && item.scope !== "*" ? item.scope : null);
  const toggleKind = (kind: string) =>
    setView((v) => ({ ...v, kinds: v.kinds.includes(kind) ? v.kinds.filter((k) => k !== kind) : [...v.kinds, kind] }));

  /** A click or Enter on a sidebar item. A scope chosen this way is held. */
  function activate(item: RailItem) {
    if (item.type === "scope") {
      held.current = scopeOf(item);
      setView((v) => ({ ...v, scope: scopeOf(item) }));
    } else if (item.type === "kind") toggleKind(item.kind);
    else setView((v) => ({ ...v, trash: !v.trash }));
  }

  function moveCursor(by: number) {
    const i = items.findIndex((it) => it.key === cursorKey);
    const was = items[i]!, to = items[Math.max(0, Math.min(items.length - 1, i + by))]!;
    setCursor(to.key);
    // Scopes apply as the cursor moves. Walking on into the kinds puts the held scope back.
    if (to.type === "scope") {
      if (was.type !== "scope") held.current = view.scope;
      setView((v) => ({ ...v, scope: scopeOf(to) }));
    } else if (was.type === "scope") setView((v) => ({ ...v, scope: held.current }));
    const el = document.querySelector<HTMLElement>(`[data-rail="${CSS.escape(to.key)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // The focus follows the cursor while it is in the sidebar, as the tab order has only that item.
    if (document.activeElement?.closest("[data-rail]")) el?.focus({ preventScroll: true });
  }

  // On a phone the scopes are one row that scrolls sideways. Start with the picked scope in view.
  useEffect(() => {
    if (!data) return;
    const chip = document.querySelector<HTMLElement>(`[data-rail="${CSS.escape(scopeKey)}"]`), strip = chip?.parentElement;
    if (chip && strip) strip.scrollLeft = chip.offsetLeft - strip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!data]);

  // ---- the drawer on a phone ----

  /** The open note gets a history entry, so the back gesture closes it. */
  function openNote() {
    if (!current) return;
    // The list behind the drawer shrinks toward the top of the screen, and only the part on screen
    // shows, with round corners.
    const el = indent.current;
    if (el) {
      const top = scrollY - el.offsetTop;
      el.style.setProperty("--indent-top", `${top}px`);
      el.style.setProperty("--indent-bottom", `${Math.max(0, el.offsetHeight - top - innerHeight)}px`);
    }
    history.pushState({ reading: true }, "", location.href);
    setView((v) => ({ ...v, note: current.id, read: true }));
  }
  function closeNote() {
    setView((v) => ({ ...v, read: false }));
    setEditing(false);
  }
  /** When the note has its own history entry, going back closes it, as the gesture does. */
  function back() {
    if (history.state?.reading) history.back();
    else closeNote();
  }
  // Back on a wide screen goes to the view of the entry before.
  const popView = useEffectEvent(() => {
    if (!phone) setView(fromHash(location.hash));
  });
  useEffect(() => {
    const pop = () => {
      if (history.state?.reading || auditScope()) return;
      closeNote();
      popView();
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  // A reload after a change keeps the drawer open, but with no history entry of its own.
  // A phone that turns wide shows the note in its pane.
  useEffect(() => {
    if (!phone && view.read) setView((v) => ({ ...v, read: false }));
  }, [phone, view.read]);

  // ---- changes ----

  // Each change is a mutation. Its onSuccess closes what the change closes, then reloads the
  // notes, and the mutation stays pending until that ends, so the store poll waits for it.

  /** The drawer closes first on a phone, with the note still in it, then the view moves on. */
  async function leave(view: (v: View) => View) {
    if (reading) {
      back();
      await sleep(CLOSE_MS);
    }
    setView(view);
    await reloadPage();
  }

  const saveNote = useMutation({
    mutationFn: ({ id, edit }: { id: string; edit: NoteEdit }) => api.saveNote(id, edit),
    onSuccess: async () => {
      await reloadPage();
      setEditing(false);
    },
  });
  // The form shows the error itself.
  const save = async (edit: NoteEdit) => {
    if (current) await saveNote.mutateAsync({ id: current.id, edit });
  };

  const restoreNote = useMutation({
    mutationFn: api.restoreNote,
    // The list has the note again before it is selected. Else the first row is selected for a frame.
    onSuccess: async (_, id) => {
      await reloadPage();
      setView((v) => ({ ...v, note: id }));
    },
  });
  const moveNote = useMutation({
    mutationFn: ({ id, restore }: { id: string; title: string; after: string | null; restore: boolean }) => (restore ? api.restoreNote(id) : api.trashNote(id)),
    onError: toastError,
    onSuccess: async (_, { id, title, after, restore }) => {
      // The note leaves the list it is in.
      await leave((v) => ({ ...v, note: after }));
      // The toast names the note, as the note it moved is gone from the screen.
      if (!restore) offerUndo("Moved to the trash", title, () => restoreNote.mutateAsync(id));
    },
  });

  /** Move the open note to the trash, or restore it. Each works only on a note it fits. */
  function trash(restore: boolean) {
    if (!current || editing || current.trashed !== restore) return;
    moveNote.mutate({ id: current.id, title: current.title, after: neighbour(shown.notes, current.id), restore });
  }

  /** A toast with Undo, which ⌘Z also presses while the toast shows. */
  function offerUndo(text: string, description: string, run: () => Promise<unknown>) {
    undoing.current = run;
    toast(text, {
      id: "kb",
      description,
      duration: UNDO_MS,
      action: {
        label: (
          <span className="inline-flex items-center gap-1.5">
            Undo <Combo keyName="Z" />
          </span>
        ),
        onClick: () => void undo(),
      },
      onAutoClose: () => {
        if (undoing.current === run) undoing.current = null;
      },
    });
  }
  async function undo() {
    const run = undoing.current;
    if (!run) return;
    undoing.current = null;
    toast.dismiss("kb");
    try {
      await run();
    } catch (error) {
      toast((error as Error).message, { id: "kb" });
    }
  }

  const startAudit = useMutation({
    mutationFn: api.startAudit,
    onSuccess: (run) => {
      auditing.current = run.scope;
      toast(`An agent audits ${scopeName(run.scope)}. This takes a few minutes.`, { id: "kb" });
    },
    onError: toastError,
    onSettled: () => reloadPage(),
  });

  /** The Audit button of a repo the page can audit: start an agent, wait for it, or open its cards. */
  function auditButton(scope: string) {
    if (!data) return undefined;
    const go = () => (location.hash = `#audit=${encodeURIComponent(scope)}`);
    if (data.audits.includes(scope)) return { state: "open" as const, run: go };
    if (!data.auditable.includes(scope)) return undefined;
    if (startAudit.isPending || data.runs[scope]?.status === "running") return { state: "running" as const, run: () => {} };
    return { state: "start" as const, run: () => startAudit.mutate(scope) };
  }

  const restoreProject = useMutation({
    mutationFn: api.restoreProject,
    onSuccess: async (_, scope) => {
      await reloadPage();
      held.current = scope;
      setView((v) => ({ ...v, scope, trash: false, note: null }));
    },
  });
  const trashProject = useMutation({
    mutationFn: ({ scope }: { scope: string; name: string }) => api.trashProject(scope),
    onError: toastError,
    onSuccess: async (_, { scope, name }) => {
      // The project is gone from the sidebar, so the list shows every scope.
      held.current = null;
      setCursor(null);
      await leave((v) => ({ ...v, scope: null, note: null }));
      offerUndo("Moved the project to the trash", name, () => restoreProject.mutateAsync(scope));
    },
  });

  /** Move every note of a project to the trash, after the dialog. Undo brings the project back. */
  function askTrashProject(scope: string) {
    if (editing || scope === "global") return;
    const n = notes.filter((note) => !note.trashed && note.scope === scope).length;
    if (n === 0) return;
    const name = scopeName(scope);
    setConfirm({
      title: "Move this project to the trash?",
      description: `${n === 1 ? "The 1 note" : `All ${n} notes`} of ${name} go to the trash. The trash deletes them after ${data!.trashDays} days.`,
      action: "Trash project",
      run: () => trashProject.mutate({ scope, name }),
    });
  }

  /** A change that cannot be undone: the dialog asks first, then this runs it. */
  const removeForGood = useMutation({
    mutationFn: (what: { note: string; after: string | null } | { trashOf: string | undefined }) =>
      "note" in what ? api.deleteNote(what.note) : api.emptyTrash(what.trashOf),
    onError: toastError,
    onSuccess: (_, what) => leave((v) => ({ ...v, note: "note" in what ? what.after : null })),
  });

  /** Delete the open note for good. Only a note in the trash, and only after the dialog. */
  function askDelete() {
    if (!current || editing || !current.trashed) return;
    const id = current.id, after = neighbour(shown.notes, id);
    setConfirm({
      title: "Delete this note for good?",
      description: current.title,
      action: "Delete",
      run: () => removeForGood.mutate({ note: id, after }),
    });
  }

  /** Empty the trash the list shows: all of it, or only the trash of the picked scope. */
  function askEmpty() {
    const scope = view.scope;
    const n = scope ? notes.filter((note) => note.trashed && note.scope === scope).length : shown.trashCount;
    if (n === 0) return;
    const what = n === 1 ? "1 note is" : `${n} notes are`;
    setConfirm({
      title: scope ? `Empty the trash of ${scopeName(scope)}?` : "Empty the trash?",
      description: `${what} deleted for good.${scope ? " The trash of other scopes stays." : ""}`,
      action: "Empty trash",
      run: () => removeForGood.mutate({ trashOf: scope ?? undefined }),
    });
  }

  function edit() {
    if (!current || current.trashed) return;
    // On a phone the form is in the drawer, so the drawer opens with it.
    if (phone && !reading) openNote();
    setEditing(true);
  }

  function pickRow(note: PageNote) {
    blur();
    picked.current = true;
    setView((v) => ({ ...v, note: note.id, pane: "list" }));
    if (phone) {
      // openNote reads the current note, which is this one after the render. Set it here directly.
      const el = indent.current;
      if (el) {
        const top = scrollY - el.offsetTop;
        el.style.setProperty("--indent-top", `${top}px`);
        el.style.setProperty("--indent-bottom", `${Math.max(0, el.offsetHeight - top - innerHeight)}px`);
      }
      history.pushState({ reading: true }, "", location.href);
      setView((v) => ({ ...v, read: true }));
    }
  }

  /** The keys belong to the page, not to the button that took the click. */
  function blur() {
    if (document.activeElement !== search.current) (document.activeElement as HTMLElement | null)?.blur();
  }

  // ---- keys ----

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const key = event.key;
    if (!data || editing) return;
    const mod = MAC ? event.metaKey : event.ctrlKey;
    // The question before a delete takes every key. Its own buttons answer Enter and Escape. An
    // Enter that comes before the dialog has moved the focus to its action still confirms.
    if (confirm) {
      if (key === "Enter" && !mod && !(document.activeElement as HTMLElement | null)?.closest("[role=dialog]")) {
        event.preventDefault();
        confirm.run();
        setConfirm(null);
      }
      return;
    }
    // ⌘Z undoes a move to the trash while its toast shows. In the filter it stays the field's own undo.
    if (key.toLowerCase() === "z" && mod && !event.shiftKey && undoing.current && document.activeElement !== search.current) {
      event.preventDefault();
      void undo();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The open list of keys takes every key. It closes itself on Escape.
    if (help) {
      if (key === "?") {
        event.preventDefault();
        setHelp(false);
      }
      return;
    }
    // The drawer closes itself on Escape.
    if (key === "Escape" && reading) return;
    if (document.activeElement === search.current) {
      if (key === "Escape") {
        setView((v) => ({ ...v, q: "" }));
        search.current?.blur();
      } else if (key === "ArrowDown" || key === "Enter") {
        event.preventDefault();
        search.current?.blur();
        setView((v) => ({ ...v, pane: "list" }));
      }
      return;
    }
    // Other fields, such as an open select, keep their keys. The note's drawer is a dialog too, but
    // its note takes the page's keys, as the note's pane does on a wide screen.
    const field = (event.target as HTMLElement).closest?.("input, textarea, select, [role=listbox], [role=dialog]");
    if (field && !field.hasAttribute("data-note-drawer")) return;

    const by = key === "ArrowDown" || key === "j" ? 1 : key === "ArrowUp" || key === "k" ? -1 : 0;
    const pane = view.pane;
    if (key === "/") {
      search.current?.focus();
      search.current?.select();
    } else if (key === "ArrowLeft" || key === "h") {
      if (pane === "list") {
        setCursor(scopeKey);
        held.current = view.scope;
        setView((v) => ({ ...v, pane: "rail" }));
      }
    } else if (key === "ArrowRight" || key === "l") setView((v) => ({ ...v, pane: "list" }));
    else if (by && pane === "list") {
      const list = shown.notes;
      if (list.length) {
        const i = current ? list.indexOf(current) : 0;
        setView((v) => ({ ...v, note: list[Math.max(0, Math.min(list.length - 1, i + by))]!.id }));
      }
    } else if (by) moveCursor(by);
    else if ((key === "Enter" || key === " ") && pane === "rail") {
      const item = items.find((i) => i.key === cursorKey);
      if (item) activate(item);
    }
    // On a phone the note is in a drawer. Enter or space on a row opens it, as a tap does. In the open drawer space scrolls.
    else if ((key === "Enter" || key === " ") && pane === "list" && phone && current && !reading) openNote();
    // The note has no keys of its own. Space pages through it from the list.
    else if (key === " ") reader.current?.scrollBy({ top: (event.shiftKey ? -0.8 : 0.8) * reader.current.clientHeight });
    else if (key === "e" && pane === "list") edit();
    // Backspace on a project in the sidebar asks to move the whole project to the trash.
    else if ((key === "Backspace" || key === "Delete") && pane === "rail") {
      const item = items.find((i) => i.key === cursorKey);
      const scope = item && scopeOf(item);
      if (scope && scope !== "global" && !shown.trash) askTrashProject(scope);
    }
    // Backspace moves a note to the trash. In the trash it asks to delete the note for good.
    else if ((key === "Backspace" || key === "Delete") && pane === "list" && current) {
      if (current.trashed) askDelete();
      else trash(false);
    } else if (key === "r" && pane === "list") trash(true);
    else if (key === "t") nextTheme();
    else if (key === "?") setHelp(true);
    else if (kinds[Number(key) - 1]) toggleKind(kinds[Number(key) - 1]!);
    else return;
    event.preventDefault();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const banner = offline ? (
    <Banner>
      <strong>kb serve is not running.</strong> Start it with <code>kb serve</code>, and the page reconnects.
    </Banner>
  ) : readOnly ? (
    <Banner>
      <strong>Read only.</strong> To change notes, open the link that <code>kb serve</code> printed.
    </Banner>
  ) : watch.isError ? (
    <Banner>
      <strong>kb:</strong> {watch.error.message}
    </Banner>
  ) : null;

  if (!data) return failed && !offline ? <p className="p-8 text-sm text-muted-foreground">kb: {failed}</p> : banner;

  // An empty list says so once, and offers the shortest way to notes: the other scopes when the
  // same search finds notes there, otherwise the list without the search and the kinds.
  const elsewhere = view.scope ? (shown.byScope.get("*") ?? 0) : 0;
  const live = notes.some((n) => !n.trashed);
  const empty =
    notes.length === 0
      ? {
          text: "No notes yet.",
          hint: (
            <>
              Run <code className="whitespace-nowrap">/kb:save</code> in a Claude Code session, or <code className="whitespace-nowrap">kb add</code> in a
              terminal. Notes show here as they come.
            </>
          ),
        }
      : !live && !shown.trash && !view.q && !view.kinds.length
        ? { text: "Every note is in the trash.", action: { label: "show the trash", run: () => setView((v) => ({ ...v, trash: true })) } }
      : elsewhere
        ? {
            text: "no notes match in this scope",
            action: {
              label: `show ${elsewhere} in all scopes`,
              run: () => {
                held.current = null;
                setCursor("scope:*");
                setView((v) => ({ ...v, scope: null }));
              },
            },
          }
        : {
            text: "no notes match",
            action: view.q || view.kinds.length ? { label: "clear filters", run: () => setView((v) => ({ ...v, q: "", kinds: [] })) } : undefined,
          };

  const page = current && (
    editing ? (
      <NoteForm key={current.id} note={current} kinds={kinds} onCancel={() => setEditing(false)} onSave={save} />
    ) : (
      <NoteView
        note={current}
        onEdit={() => {
          setView((v) => ({ ...v, pane: "list" }));
          edit();
        }}
        onTrash={() => {
          setView((v) => ({ ...v, pane: "list" }));
          trash(false);
        }}
        onRestore={() => {
          setView((v) => ({ ...v, pane: "list" }));
          trash(true);
        }}
        onDelete={() => {
          setView((v) => ({ ...v, pane: "list" }));
          askDelete();
        }}
      />
    )
  );

  return (
    <DrawerProvider>
      <div
        data-pane={view.pane}
        className={cn("group/page wide:grid wide:h-screen wide:grid-cols-[248px_380px_minmax(0,1fr)]", banner && "wide:grid-rows-[auto_minmax(0,1fr)]")}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest("[data-rail], [data-id], [data-slot=button]")) blur();
        }}
        // Tab into the sidebar or the list gives that pane the keys.
        onFocus={(event) => {
          const target = event.target as HTMLElement;
          const rail = target.closest<HTMLElement>("[data-rail]");
          if (rail) {
            setCursor(rail.dataset.rail!);
            if (view.pane !== "rail") {
              held.current = view.scope;
              setView((v) => ({ ...v, pane: "rail" }));
            }
          } else if (target.closest("[data-id]") && view.pane !== "list") setView((v) => ({ ...v, pane: "list" }));
        }}
      >
        {/* Behind an open drawer the list shrinks back from the edges and is black around it, as in Vaul. */}
        <DrawerIndentBackground className="fixed inset-0 bg-black wide:hidden" />
        {banner}
        <DrawerIndent
          ref={indent}
          className={cn(
            "contents",
            "max-wide:relative max-wide:block max-wide:min-h-dvh max-wide:bg-background",
            "[--indent-transition:calc(1-clamp(0,calc(var(--drawer-swipe-progress)*100000),1))] origin-[50%_var(--indent-top,0px)] transition-[transform,clip-path] duration-[calc(450ms*var(--indent-transition))] ease-[cubic-bezier(0.32,0.72,0,1)]",
            "max-wide:data-active:[transform:translateY(calc((env(safe-area-inset-top)+14px)*(1-var(--drawer-swipe-progress))))_scale(calc(0.96+0.04*var(--drawer-swipe-progress)))]",
            "max-wide:data-active:[clip-path:inset(var(--indent-top,0px)_0_var(--indent-bottom,0px)_0_round_calc(8px*(1-var(--drawer-swipe-progress))))]",
          )}
        >
          <Rail
            items={items}
            pressed={pressed}
            count={count}
            cursor={cursorKey}
            onPick={(item) => {
              setCursor(item.key);
              setView((v) => ({ ...v, pane: "rail" }));
              activate(item);
            }}
            theme={theme}
            onTheme={nextTheme}
            onKeys={() => setHelp(true)}
            audits={data.audits}
          />
          <NoteList notes={shown.notes} current={current} q={view.q} onQ={(q) => setView((v) => ({ ...v, q }))} searchRef={search} onOpen={pickRow} empty={empty} trash={shown.trash ? { days: data.trashDays, onEmpty: askEmpty } : undefined}
            project={shown.trash || !view.scope ? undefined : view.scope === "global" ? { audit: auditButton("global") } : { onTrash: () => askTrashProject(view.scope!), audit: auditButton(view.scope) }}
          />
        </DrawerIndent>
        {!phone && (
          <main ref={reader} className="min-w-0 overflow-y-auto px-12 pt-6 pb-20">
            {page}
          </main>
        )}
      </div>
      {phone && (
        <Drawer
          open={reading}
          onOpenChange={(open, details) => {
            if (open) return;
            // In the form Escape cancels the edit, and the drawer stays.
            if (editing && details.reason === "escape-key") {
              details.cancel();
              return;
            }
            back();
          }}
        >
          <DrawerContent data-note-drawer="" className="h-[82dvh] max-h-none bg-background shadow-[0_-10px_40px_rgba(0,0,0,0.35)]">
            <DrawerSwipeHandle className="h-auto pt-2 pb-2 after:h-[5px] after:w-9 after:bg-faint/50 group-data-[swipe-axis=y]/drawer-popup:h-auto group-data-[swipe-axis=y]/drawer-popup:after:h-[5px] group-data-[swipe-axis=y]/drawer-popup:after:w-9" />
            <DrawerTitle className="sr-only">{current?.title ?? "Note"}</DrawerTitle>
            <div ref={reader} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[60px] text-[15px]">
              {page}
            </div>
          </DrawerContent>
        </Drawer>
      )}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      <KeysDialog open={help} onOpenChange={setHelp} kinds={kinds.length} />
      <Toaster theme={resolved} position="bottom-center" />
    </DrawerProvider>
  );
}
