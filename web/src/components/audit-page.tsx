import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { type AuditCard, type AuditData, type AuditNote, type AuditResult, resultGroups } from "../../../cli/wire.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { useTheme } from "@/hooks/use-theme";
import { MAC } from "@/hooks/use-media";
import * as api from "@/lib/api";
import { auditQuery, queryClient, reloadPage } from "@/lib/queries";
import { type Choice, KEYS, type Pick, agentPick, choiceLabel, choices, pickLabel, steps, stillHidden, summary, toPicks } from "@/lib/audit";
import { cn } from "@/lib/utils";
import { scopeName } from "@/lib/view";
import { Dot } from "./bits";

/** What the card shows instead of its keys: a box for the user's text, or for what is wrong. */
type Mode = null | "edit" | "ask";

const storageKey = (data: AuditData) => `kb-audit:${data.scope}:${data.created}`;

/** What survives a reload: each card's pick and whether the user has seen it, by note id. */
type Saved = Record<string, { pick: Pick; seen: boolean }>;

function saved(data: AuditData): { picks: Pick[]; seen: boolean[] } {
  let store: Saved = {};
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(data)) ?? "null") as Saved | null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) store = raw;
  } catch {}
  // A card that left since the reload drops out. The other cards keep the user's picks.
  return { picks: data.cards.map((card) => store[card.id]?.pick ?? agentPick(card)), seen: data.cards.map((card) => store[card.id]?.seen ?? false) };
}

/** The audit as a deck: one note per card, the agent's pick on each, and Apply at the end. */
export function AuditPage({ scope }: { scope: string }) {
  const { data, error } = useQuery(auditQuery(scope));
  const failed = error?.message ?? "";
  const { resolved } = useTheme();

  return (
    <div className="flex min-h-dvh flex-col">
      {!(data && !data.result && data.cards.length > 0) && <Header scope={scope} data={data} />}
      {failed ? (
        <p className="p-8 text-sm text-muted-foreground">kb: {failed}</p>
      ) : !data ? null : data.result ? (
        <Result result={data.result} />
      ) : data.cards.length === 0 ? (
        <p className="p-8 text-sm text-muted-foreground">Every note in this audit changed since the agent proposed it. Run /kb:audit again.</p>
      ) : (
        <Deck data={data} />
      )}
      <Toaster theme={resolved} position="bottom-center" />
    </div>
  );
}

function Header({ scope, data, children }: { scope: string; data: AuditData | undefined; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-3.5 max-wide:px-4">
      <a href="#" className="text-xl/none font-bold tracking-[-0.01em]" title="Back to the notes">
        kb
      </a>
      <span className="text-[13.5px] text-muted-foreground">
        audit · {scopeName(data?.scope ?? scope)}
      </span>
      {children && <span className="ml-auto flex items-center gap-3">{children}</span>}
    </header>
  );
}

/** How many notes still reach no session: it counts down as the picks take notes out of the index. */
function Meter({ data, left }: { data: AuditData; left: number }) {
  if (data.index.hidden === 0) return null;
  const done = left === 0;
  return (
    <span
      className="flex items-center gap-3 text-[13px]"
      title={`A session lists at most ${data.index.budget} notes. ${data.index.hidden} did not fit, so no session sees them. Each trash, demote or merge gives one of them a line.`}
    >
      <span className={cn("tabular-nums", done ? "text-(--k-convention)" : "text-muted-foreground")}>
        {done ? (
          "every note reaches a session"
        ) : (
          <>
            <b className="font-semibold text-(--k-open-work)">{left}</b> {left === 1 ? "note still reaches" : "notes still reach"} no session
          </>
        )}
      </span>
      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-secondary max-wide:w-16">
        <span className="block h-full rounded-full bg-(--k-open-work) transition-[width] duration-300" style={{ width: `${(left / data.index.hidden) * 100}%` }} />
      </span>
    </span>
  );
}

function Deck({ data }: { data: AuditData }) {
  const flow = useMemo(() => steps(data.cards), [data.cards]);
  const over = data.index.hidden > 0;
  const [initial] = useState(() => saved(data));
  const [picks, setPicks] = useState<Pick[]>(initial.picks);
  const [seen, setSeen] = useState<boolean[]>(initial.seen);
  const [pos, setPos] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  const applyPicks = useMutation({
    mutationFn: (picks: Pick[]) => api.applyAudit(data.scope, toPicks(data.cards, picks)),
    onSuccess: (result) => {
      try {
        sessionStorage.removeItem(storageKey(data));
      } catch {}
      // The page shows what the picks did, and the notes reload for the way back.
      queryClient.setQueryData(auditQuery(data.scope).queryKey, { ...data, result });
      void reloadPage();
    },
  });
  const error = applyPicks.error?.message ?? "";
  const applying = applyPicks.isPending;
  const history = useRef<{ pos: number; picks: Pick[]; seen: boolean[] }[]>([]);
  const step = flow[pos];
  const end = pos >= flow.length;

  useEffect(() => {
    try {
      const out: Saved = Object.fromEntries(data.cards.map((card, i) => [card.id, { pick: picks[i]!, seen: seen[i]! }]));
      sessionStorage.setItem(storageKey(data), JSON.stringify(out));
    } catch {}
  }, [data, picks, seen]);

  // A new card starts with its keys, never in the middle of an edit. This happens in the same
  // render as the move: in an effect, the next card would mount its edit box for one frame and take the focus.
  const go = (to: number) => {
    setMode(null);
    setPos(Math.max(0, Math.min(flow.length, to)));
  };
  const remember = () => history.current.push({ pos, picks, seen });

  /** Set the picks of these cards, then go to the step after `next`. */
  function decide(changes: [number, Pick][], next = pos + 1) {
    remember();
    setPicks((all) => {
      const copy = [...all];
      for (const [i, pick] of changes) copy[i] = pick;
      return copy;
    });
    setSeen((all) => {
      const copy = [...all];
      for (const [i] of changes) copy[i] = true;
      return copy;
    });
    go(next);
  }

  function undo() {
    const last = history.current.pop();
    if (!last) return;
    setPicks(last.picks);
    setSeen(last.seen);
    go(last.pos);
  }

  function choose(choice: Choice) {
    if (step?.type !== "card") return;
    if (choice === "edit" || choice === "ask") return setMode(choice);
    decide([[step.i, { action: choice }]]);
  }

  function apply() {
    applyPicks.mutate(picks);
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement).closest?.("input, textarea")) return;
    const key = event.key;
    if (key === "ArrowRight") go(pos + 1);
    else if (key === "ArrowLeft") go(pos - 1);
    else if (key === "z") undo();
    else if (end) {
      if (key === "Enter" && !applying) void apply();
      else return;
    } else if (key === "Enter") {
      if (step!.type === "card") decide([[step!.i, picks[step!.i]!]]);
      else go(pos + 1);
    } else if (step!.type === "divider") {
      if (key !== "a") return;
      decide(step!.cards.map((i) => [i, { action: "keep" }]), pos + step!.cards.length + 1);
    } else {
      const choice = choices(step!.card, over).find((c) => KEYS[c] === key);
      if (!choice) return;
      choose(choice);
    }
    event.preventDefault();
  });
  useEffect(() => {
    if (mode) return;
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [mode]);

  const left = stillHidden(data, picks);

  return (
    <>
    <Header scope={data.scope} data={data}>
      <Meter data={data} left={left} />
    </Header>
    <main className="mx-auto flex w-[min(660px,100%)] flex-1 flex-col px-4 pt-6 pb-8">
      <div className="flex items-center gap-3 text-[13px] text-muted-foreground tabular-nums">
        <span>{end ? "the end" : `${flow.slice(0, pos + 1).filter((s) => s.type === "card").length || 1} of ${data.cards.length}`}</span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
          <span className="block h-full rounded-full bg-muted-foreground/60 transition-[width] duration-200" style={{ width: `${(Math.min(pos + 1, flow.length) / flow.length) * 100}%` }} />
        </span>
      </div>
      <Strip data={data} flow={flow} picks={picks} seen={seen} pos={pos} onJump={go} />

      <div className="flex flex-1 flex-col justify-center py-6">
        {end ? (
          <End data={data} picks={picks} left={left} applying={applying} error={error} onApply={apply} />
        ) : step!.type === "divider" ? (
          <Divider group={step!.group} count={step!.cards.length} />
        ) : (
          <Card
            key={step!.i}
            card={step!.card}
            pick={picks[step!.i]!}
            seen={seen[step!.i]!}
            mode={mode}
            onCancel={() => setMode(null)}
            onSave={(pick) => decide([[step!.i, pick]])}
          />
        )}
      </div>

      {!mode && !end && (
        <div className="flex flex-wrap justify-center gap-2" data-keys>
          {step!.type === "divider" ? (
            <>
              <KeyButton k="Enter" label="one by one" on onClick={() => go(pos + 1)} />
              <KeyButton k="a" label={`keep all ${step!.cards.length}`} onClick={() => decide(step!.cards.map((i) => [i, { action: "keep" }]), pos + step!.cards.length + 1)} />
            </>
          ) : (
            choices(step!.card, over).map((choice) => {
              const current = picks[step!.i]!.action === choice;
              return <KeyButton key={choice} k={KEYS[choice]} label={choiceLabel(step!.card, choice)} on={current} action={choice} onClick={() => choose(choice)} />;
            })
          )}
        </div>
      )}
      {!mode && (
        <p className="mt-4 text-center text-[12px] text-faint" data-keys-only>
          {end ? "Enter applies" : "Enter takes the highlighted pick and goes on"} · <Kbd>←</Kbd> <Kbd>→</Kbd> move · <Kbd>z</Kbd> undo
        </p>
      )}
    </main>
    </>
  );
}

function KeyButton({ k, label, on, action, onClick }: { k: string; label: string; on?: boolean; action?: Choice; onClick: () => void }) {
  return (
    <Button variant={on ? "default" : "outline"} className={cn("h-9 gap-2 px-3 text-[13.5px]", action && `a-${action}`)} onClick={onClick} data-choice={action}>
      <Kbd className={cn(on ? "bg-primary-foreground/15 text-primary-foreground" : "")}>{k}</Kbd>
      {label}
    </Button>
  );
}

/** One square per card, in the colour of its pick. A click goes to the card. */
function Strip({ data, flow, picks, seen, pos, onJump }: { data: AuditData; flow: ReturnType<typeof steps>; picks: Pick[]; seen: boolean[]; pos: number; onJump: (to: number) => void }) {
  const used = [...new Set(picks.map((p) => p.action))];
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-[3px]">
        {flow.map((step, at) =>
          step.type === "divider" ? (
            <span key={`d${at}`} className="mx-1 h-3 w-px self-center bg-border" />
          ) : (
            <button
              key={step.i}
              type="button"
              tabIndex={-1}
              title={`${data.cards[step.i]!.note.title}: ${pickLabel(step.card, picks[step.i]!)}`}
              onClick={() => onJump(at)}
              data-pick={picks[step.i]!.action}
              className={cn(
                "size-3 rounded-[3px] bg-(--a)",
                `a-${picks[step.i]!.action}`,
                !seen[step.i] && "opacity-35",
                at === pos && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
              )}
            />
          ),
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-faint">
        {used.map((action) => (
          <span key={action} className={cn("flex items-center gap-1.5", `a-${action}`)}>
            <span className="size-2 rounded-[2px] bg-(--a)" />
            {action === "ask" ? "ask for rewrite" : action}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11.5px] text-faint">Pale squares are the agent's picks you have not seen.</p>
    </div>
  );
}

function Divider({ group, count }: { group: string; count: number }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-8 text-center">
      <h2 className="text-lg font-semibold">{group}</h2>
      <p className="mt-1.5 text-[13.5px] text-muted-foreground">
        {count} {count === 1 ? "card" : "cards"} next. Go through them one by one, or keep them all as they are.
      </p>
    </div>
  );
}

const usesText = (n: number) => `${n} ${n === 1 ? "use" : "uses"}`;

function Meta({ note, reason }: { note: AuditNote; reason?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground", `k-${note.kind}`)}>
      <Dot />
      <span className="font-[550] text-(--k)">{note.kind}</span>
      <span>· {note.scope === "global" ? "global" : scopeName(note.scope)}</span>
      {reason && <span>· {reason}</span>}
      <span>· {usesText(note.uses)}</span>
    </div>
  );
}

const textBlock = "max-h-56 overflow-y-auto rounded-lg border px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]";
const label = "mb-1 block font-mono text-[10.5px] font-semibold tracking-wider uppercase";

function Card({ card, pick, seen, mode, onCancel, onSave }: { card: AuditCard; pick: Pick; seen: boolean; mode: Mode; onCancel: () => void; onSave: (pick: Pick) => void }) {
  const own = pick.title !== undefined || pick.body !== undefined;
  const newTitle = pick.title ?? card.proposed?.title ?? card.note.title;
  const newBody = pick.body ?? card.proposed?.body ?? card.note.body;
  const changed = own || !!card.proposed;
  return (
    <article className="rounded-xl border bg-card px-6 py-5 max-wide:px-4" data-card={card.id}>
      <Meta note={card.note} reason={card.reason} />
      <h2 className="mt-2 text-[19px]/snug font-semibold text-balance">{card.merge ? "These notes look like one idea" : card.note.title}</h2>

      {card.merge ? (
        <div className="mt-3 grid gap-2.5 wide:grid-cols-2">
          {[card.note, ...card.merge].map((note, i) => (
            <div key={note.id} className="rounded-lg border px-3.5 py-2.5">
              <div className="text-[13.5px] font-semibold">{note.title}</div>
              <div className="mt-1 line-clamp-6 text-[13px] whitespace-pre-wrap text-muted-foreground">{note.body}</div>
              <div className="mt-1.5 text-[11.5px] text-faint">{i === 0 ? "stays, with every fact" : "goes to the trash"}</div>
            </div>
          ))}
        </div>
      ) : changed && mode !== "edit" ? (
        <div className="mt-3 grid gap-2">
          <div className={cn(textBlock, "border-(--destructive)/30 bg-(--destructive)/5 line-through decoration-(--destructive)/50")}>
            <span className={cn(label, "text-(--destructive) no-underline")}>now</span>
            {newTitle !== card.note.title && <b className="block">{card.note.title}</b>}
            {card.note.body}
          </div>
          <div className={cn(textBlock, "border-(--k-convention)/35 bg-(--k-convention)/6 text-foreground")}>
            <span className={cn(label, "text-(--k-convention)")}>{own ? "your text" : "proposed by the agent"}</span>
            {newTitle !== card.note.title && <b className="block">{newTitle}</b>}
            {newBody}
          </div>
        </div>
      ) : mode !== "edit" ? (
        <div className={cn(textBlock, "mt-3")}>{card.note.body}</div>
      ) : null}

      {card.merge && changed && mode !== "edit" && (
        <div className={cn(textBlock, "mt-2.5 border-(--k-convention)/35 bg-(--k-convention)/6 text-foreground")}>
          <span className={cn(label, "text-(--k-convention)")}>{own ? "your merged text" : "merged text, proposed by the agent"}</span>
          {newTitle !== card.note.title && <b className="block">{newTitle}</b>}
          {newBody}
        </div>
      )}

      {mode === "edit" && <EditBox title={newTitle} body={newBody} merge={!!card.merge} onCancel={onCancel} onSave={(title, body) => onSave({ action: card.merge ? "merge" : "rewrite", title, body })} />}
      {mode === "ask" && <AskBox initial={pick.request ?? ""} onCancel={onCancel} onSave={(request) => onSave({ action: "ask", request })} />}

      {!mode && (
        <>
          <div className="mt-3.5 rounded-lg bg-muted px-3.5 py-2.5 text-[13.5px]">
            <b className="font-semibold">Agent: {card.action}.</b> {card.why}
          </div>
          <div className="mt-3 text-[13px] text-muted-foreground" data-pick-line>
            {seen ? "Your pick" : "Picked now"}: <b className={cn("font-semibold text-foreground")}>{pickLabel(card, pick)}</b>
            {pick.action === card.action && !own && !pick.request ? " (the agent's)" : ""}
            {pick.request && <span className="block text-faint">“{pick.request}”</span>}
          </div>
        </>
      )}
    </article>
  );
}

function EditBox({ title, body, merge, onCancel, onSave }: { title: string; body: string; merge: boolean; onCancel: () => void; onSave: (title: string, body: string) => void }) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onCancel();
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && t.trim() && b.trim()) onSave(t.trim(), b.trim());
    else return;
    event.preventDefault();
  };
  return (
    <div className="mt-3 grid gap-2" onKeyDown={keys}>
      <span className={cn(label, "mb-0 text-(--k-convention)")}>{merge ? "your merged text" : "your text"}</span>
      <Input value={t} onChange={(e) => setT(e.target.value)} aria-label="Title" className="font-semibold" />
      <Textarea ref={ref} value={b} onChange={(e) => setB(e.target.value)} aria-label="Body" className="max-h-[50vh] min-h-32 text-[13.5px]" />
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-9 gap-2" onClick={onCancel}>
          <Kbd>Esc</Kbd> cancel
        </Button>
        <Button className="h-9 gap-2" disabled={!t.trim() || !b.trim()} onClick={() => onSave(t.trim(), b.trim())}>
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">{MAC ? "⌘" : "ctrl"} Enter</Kbd> save
        </Button>
      </div>
    </div>
  );
}

function AskBox({ initial, onCancel, onSave }: { initial: string; onCancel: () => void; onSave: (request: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onCancel();
    else if (event.key === "Enter" && text.trim()) onSave(text.trim());
    else return;
    event.preventDefault();
  };
  return (
    <div className="mt-3 grid gap-2" onKeyDown={keys}>
      <label className="text-[13px] text-muted-foreground" htmlFor="ask-box">
        What is wrong with it? After Apply, tell the agent. It rewrites the note, and you see the new text in the next audit.
      </label>
      <Input id="ask-box" ref={ref} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-9 gap-2" onClick={onCancel}>
          <Kbd>Esc</Kbd> cancel
        </Button>
        <Button className="h-9 gap-2" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">Enter</Kbd> save
        </Button>
      </div>
    </div>
  );
}

function End({ data, picks, left, applying, error, onApply }: { data: AuditData; picks: Pick[]; left: number; applying: boolean; error: string; onApply: () => void }) {
  const groups = summary(data.cards, picks);
  const changes = picks.filter((p) => p.action !== "keep").length;
  return (
    <section className="rounded-xl border bg-card px-6 py-5 max-wide:px-4">
      <h2 className="text-[19px] font-semibold">Ready to apply</h2>
      <p className="mt-1 text-[13.5px] text-muted-foreground">
        {changes} of {data.cards.length} notes change.
        {data.index.hidden > 0 && (left === 0 ? " Every note will reach a session." : ` ${left} ${left === 1 ? "note" : "notes"} will still reach no session.`)}
      </p>
      <ul className="mt-4 grid gap-2.5">
        {groups.map((group) => (
          <li key={group.label} className={cn("text-[13.5px]", `a-${group.action}`)}>
            <span className="flex items-center gap-2 font-semibold">
              <span className="size-2.5 rounded-[3px] bg-(--a)" />
              {group.label} <span className="font-normal text-faint">{group.ids.length}</span>
            </span>
            <span className="mt-0.5 block pl-4.5 text-[12.5px] text-muted-foreground">
              {group.ids.map((id) => data.cards.find((c) => c.id === id)!.note.title).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-4 text-[13px] text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end">
        <Button className="h-9 gap-2 px-4" disabled={applying} onClick={onApply}>
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">Enter</Kbd> {applying ? "applying…" : "apply"}
        </Button>
      </div>
    </section>
  );
}

function Result({ result }: { result: AuditResult }) {
  const rows = resultGroups(result, "←");
  return (
    <main className="mx-auto w-[min(660px,100%)] px-4 py-10">
      <section className="rounded-xl border bg-card px-6 py-5 max-wide:px-4">
        <h2 className="text-[19px] font-semibold">Applied</h2>
        <dl className="mt-3 grid gap-2 text-[13.5px]">
          {rows
            .filter(([, ids]) => ids.length)
            .map(([name, ids]) => (
              <div key={name}>
                <dt className="font-semibold">
                  {name} <span className="font-normal text-faint">{ids.length}</span>
                </dt>
                <dd className="text-[12.5px] break-words text-muted-foreground">{ids.join(" · ")}</dd>
              </div>
            ))}
        </dl>
        {result.requests.length > 0 && (
          <div className="mt-4 rounded-lg bg-muted px-3.5 py-2.5 text-[13.5px]">
            <b className="font-semibold">Tell the agent it is applied.</b> It reads the result with <code>kb audit</code> and rewrites the {result.requests.length === 1 ? "note" : `${result.requests.length} notes`} you sent back:
            <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-muted-foreground">
              {result.requests.map((r) => (
                <li key={r.id}>
                  {r.id}: {r.request}
                </li>
              ))}
            </ul>
          </div>
        )}
        <a href="#" className="mt-5 inline-block text-[13.5px] text-link hover:underline">
          Back to the notes
        </a>
      </section>
    </main>
  );
}
