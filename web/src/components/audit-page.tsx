import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
import { ACCEPT_KEY, ACCEPT_REST_KEY, type Choice, KEYS, type Pick, agentPick, changes, choiceForKey, choiceLabel, choices, pickLabel, promoteFile, promoteLines, steps, stillHidden, summary, textChoices, toPicks } from "@/lib/audit";
import { diffLines, wordDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { scopeName } from "@/lib/view";
import { Dot } from "./bits";

/** What the card shows instead of its keys: a box for the user's text, or for what is wrong. */
type Mode = null | "edit" | "ask";

const storageKey = (data: AuditData) => `kb-audit:${data.scope}:${data.created}`;

/** What survives a reload: each card's pick and whether the user has seen it, by note id. */
/** A keep the user picks on the card itself says they looked, so the note records the check. A group keep does not. */
const onCard = (pick: Pick): Pick => (pick.action === "keep" ? { ...pick, checked: true } : pick);

type Saved = Record<string, { pick: Pick; seen: boolean }>;

function saved(data: AuditData): { picks: Pick[]; seen: boolean[] } {
  let store: Saved = {};
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(data)) ?? "null") as Saved | null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) store = raw;
  } catch {}
  // A card that left since the reload drops out. The other cards keep the user's picks, if the card still offers them.
  const pick = (card: AuditCard): Pick => {
    const old = store[card.id]?.pick;
    const offered: string[] = [...choices(card), ...textChoices(card)];
    return old && offered.includes(old.action) ? old : agentPick(card);
  };
  return { picks: data.cards.map(pick), seen: data.cards.map((card) => store[card.id]?.seen ?? false) };
}

/** The audit as a deck: one note per card, the agent's pick on each, and Apply at the end. */
export function AuditPage({ scope }: { scope: string }) {
  const { data, error } = useQuery(auditQuery(scope));
  const failed = error?.message ?? "";
  const { resolved } = useTheme();

  return (
    <div className="flex h-dvh flex-col">
      {!(data && !data.result && data.cards.length > 0) && <Header scope={scope} data={data} />}
      {failed ? (
        <p className="min-h-0 flex-1 overflow-y-auto p-8 text-sm text-muted-foreground">kb: {failed}</p>
      ) : !data ? null : data.result ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Result result={data.result} />
        </div>
      ) : data.cards.length === 0 ? (
        <p className="min-h-0 flex-1 overflow-y-auto p-8 text-sm text-muted-foreground">Every note in this audit changed since the agent proposed it. Run /kb:audit again.</p>
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
      title={`A session lists at most ${data.index.budget} notes. ${data.index.hidden} did not fit, so no session sees them. Each trash or merge gives one of them a line.`}
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
    decide([[step.i, onCard({ action: choice })]]);
  }

  /** The cards the user has not picked yet. */
  const rest = data.cards.flatMap((_, i) => (seen[i] ? [] : [i]));

  /**
   * Take the agent's pick on every card the user has not picked, and go to the summary. Picks the
   * user made stay. A keep taken this way records no check of its own: nobody looked at the card.
   */
  function acceptRest() {
    if (rest.length === 0) return;
    decide(rest.map((i) => [i, agentPick(data.cards[i]!)]), flow.length);
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
    else if (key === ACCEPT_REST_KEY && !end && rest.length > 0) acceptRest();
    else if (end) {
      if (key === "Enter" && !applying) void apply();
      else return;
    } else if (key === "Enter") {
      if (step!.type === "card") decide([[step!.i, onCard(picks[step!.i]!)]]);
      else go(pos + 1);
    } else if (step!.type === "divider") {
      if (key !== KEYS.keep) return;
      decide(step!.cards.map((i) => [i, { action: "keep" }]), pos + step!.cards.length + 1);
    } else {
      const choice = choiceForKey(step!.card, key);
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
    <main className="mx-auto flex min-h-0 w-[min(720px,100%)] flex-1 flex-col px-4 pt-6 pb-4">
      <div className="flex items-center gap-3 text-[13px] text-muted-foreground tabular-nums">
        <span>{end ? "the end" : `${flow.slice(0, pos + 1).filter((s) => s.type === "card").length || 1} of ${data.cards.length}`}</span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
          <span className="block h-full rounded-full bg-muted-foreground/60 transition-[width] duration-200" style={{ width: `${(Math.min(pos + 1, flow.length) / flow.length) * 100}%` }} />
        </span>
        {!end && rest.length > 0 && (
          <Button
            variant="outline"
            size="xs"
            data-accept-rest
            title="Take the agent's pick on every card you have not picked, then see the summary. Nothing changes until Apply."
            className="-my-1 text-muted-foreground hover:text-foreground"
            onClick={acceptRest}
          >
            accept the rest ({rest.length}) <Kbd>⇧A</Kbd>
          </Button>
        )}
      </div>
      <Strip data={data} flow={flow} picks={picks} seen={seen} pos={pos} onJump={go} />

      {/* Only the edit box fills the space. Any other step is as tall as its content, and the key hint follows it. */}
      <div className={cn("mt-5 flex min-h-0 flex-col", mode === "edit" && "flex-1")}>
        {end ? (
          <End data={data} picks={picks} left={left} applying={applying} error={error} onApply={apply} />
        ) : step!.type === "divider" ? (
          <Divider
            group={step!.group}
            count={step!.cards.length}
            onOneByOne={() => go(pos + 1)}
            onKeepAll={() => decide(step!.cards.map((i) => [i, { action: "keep" }]), pos + step!.cards.length + 1)}
          />
        ) : (
          <Card
            key={step!.i}
            card={step!.card}
            pick={picks[step!.i]!}
            seen={seen[step!.i]!}
            mode={mode}
            onCancel={() => setMode(null)}
            onSave={(pick) => decide([[step!.i, pick]])}
            keys={choices(step!.card).map((choice, at) => (
              <KeyButton
                key={choice}
                k={at === 0 ? ACCEPT_KEY : KEYS[choice]}
                label={at === 0 ? `accept: ${choiceLabel(step!.card, choice)}` : choiceLabel(step!.card, choice)}
                on={picks[step!.i]!.action === choice}
                action={choice}
                onClick={() => choose(choice)}
              />
            ))}
            textKeys={textChoices(step!.card).map((choice, at) => (
              <Fragment key={choice}>
                {at > 0 && " · "}
                <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground hover:underline" data-choice={choice} onClick={() => choose(choice)}>
                  {choiceLabel(step!.card, choice)} <Kbd>{KEYS[choice]}</Kbd>
                </button>
              </Fragment>
            ))}
          />
        )}
      </div>

      {!mode && (
        <p className="mt-3 shrink-0 text-center text-[12px] text-faint" data-keys-only>
          {end ? "Enter applies" : "Enter takes the highlighted pick and goes on"} · <Kbd>←</Kbd> <Kbd>→</Kbd> move · <Kbd>z</Kbd> undo
        </p>
      )}
    </main>
    </>
  );
}

/**
 * The frame of every step in the deck: a fixed head, one body that scrolls, and the buttons in a
 * footer. The panel is as tall as its content, at most the space under the strip: then only the body scrolls.
 */
function Panel({ head, footer, children, className, ...rest }: { head?: React.ReactNode; footer: React.ReactNode; children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLElement> & Record<`data-${string}`, string>) {
  return (
    <article className={cn("flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card", className)} {...rest}>
      {head && <div className="shrink-0 px-6 pt-5 pb-3 max-wide:px-4">{head}</div>}
      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-5 max-wide:px-4", !head && "pt-5")} data-panel-body>
        {children}
      </div>
      <div className="shrink-0 border-t bg-card px-6 py-3 max-wide:px-4" data-keys>
        {footer}
      </div>
    </article>
  );
}

function KeyButton({ k, label, on, action, onClick }: { k: string; label: string; on?: boolean; action?: Choice; onClick: () => void }) {
  return (
    <Button variant={on ? "default" : "outline"} className={cn("h-9 gap-2 px-2.5 text-[13.5px]", action && `a-${action}`)} onClick={onClick} data-choice={action}>
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
            {action === "ask" ? "ask the agent" : action === "keep" ? "keep as is" : action === "promote" ? "move to an instruction file" : action}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11.5px] text-faint">Pale squares are the agent's picks you have not seen.</p>
    </div>
  );
}

function Divider({ group, count, onOneByOne, onKeepAll }: { group: string; count: number; onOneByOne: () => void; onKeepAll: () => void }) {
  return (
    <Panel
      className="border-dashed"
      footer={
        <div className="flex flex-wrap justify-center gap-2">
          <KeyButton k="Enter" label="one by one" on onClick={onOneByOne} />
          <KeyButton k="k" label={`keep all ${count} as is`} onClick={onKeepAll} />
        </div>
      }
    >
      <div className="flex min-h-full flex-col items-center justify-center py-6 text-center">
        <h2 className="text-lg font-semibold">{group}</h2>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">
          {count} {count === 1 ? "card" : "cards"} next. Go through them one by one, or keep them all as they are.
        </p>
      </div>
    </Panel>
  );
}

/** Where sessions see the note now, in the user's words. */
const placeText = { body: "sessions load it in full", index: "sessions see its title only", hidden: "no session sees it" } as const;

const usesText = (n: number) => `${n} ${n === 1 ? "use" : "uses"}`;

function Meta({ note, reason }: { note: AuditNote; reason?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted-foreground", `k-${note.kind}`)}>
      <Dot />
      <span className="font-[550] text-(--k)">{note.kind}</span>
      <span>· {note.scope === "global" ? "global" : scopeName(note.scope)}</span>
      <span>· {placeText[note.place]}</span>
      {reason && <span>· {reason}</span>}
      {!/\buse/.test(reason ?? "") && <span>· {usesText(note.uses)}</span>}
    </div>
  );
}

const textBlock = "rounded-lg border px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]";
const label = "mb-1 block font-mono text-[10.5px] font-semibold tracking-wider uppercase";

const removed = "rounded-sm bg-(--destructive)/12 text-(--destructive) line-through decoration-(--destructive)/50";
const added = "rounded-sm bg-(--k-convention)/15 text-(--k-convention) no-underline [del+&]:ml-0.5";

/** The note's text with only the changed words marked: removed ones struck through in red, new ones in green. */
function Diff({ before, after }: { before: string; after: string }) {
  return diffLines(wordDiff(before, after)).map((line, index) => (
    <div key={index} data-diff-line={line.whole} className={cn("min-h-[1lh]", line.whole && "-mx-1.5 rounded-sm px-1.5", line.whole === "-" && "bg-(--destructive)/8", line.whole === "+" && "bg-(--k-convention)/10")}>
      {line.pieces.map(({ op, text }, i) => {
        if (op === "=") return text;
        // Spaces at the edges stay plain, and normal white space inside drops a space where the line
        // wraps, so no colored stub hangs at the end of a line.
        const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
        const Mark = op === "-" ? "del" : "ins";
        return <Fragment key={i}>{lead}<Mark className={cn(op === "-" ? removed : added, "whitespace-normal", line.whole && "bg-transparent")}>{core}</Mark>{trail}</Fragment>;
      })}
    </div>
  ));
}

/** What the current pick does to the i-th note of a card with several notes. */
function fate(card: AuditCard, pick: Pick, i: number): string {
  if (pick.action === "trash") return "goes to the trash";
  if (pick.action === "promote") return `moves to ${promoteFile(card)}`;
  if (pick.action === "merge") return i === 0 ? "stays, with every fact" : "goes to the trash";
  return card.promote ? "stays in kb" : "stays";
}

/** The card's head: what kind of note, and its title. It stays put while the body scrolls. */
function Head({ card }: { card: AuditCard }) {
  return (
    <>
      <Meta note={card.note} reason={card.reason} />
      <h2 className="mt-2 text-[19px]/snug font-semibold text-balance">{card.merge ? (card.promote ? "These notes become one rule" : "These notes look like one idea") : card.note.title}</h2>
    </>
  );
}

/** The lines a promote card adds to the instructions file, under the last lines above them. */
function PromoteBox({ card, pick }: { card: AuditCard; pick: Pick }) {
  const promote = card.promote!;
  const file = promoteFile(card);
  const where = promote.section && promote.added[0] !== "" ? `, under ${promote.section}` : promote.section ? ", in a new section" : ", at the end";
  // The user's own text is checked again at Apply. The agent's text the file holds already is not added.
  if (promote.present && pick.rule === undefined)
    return (
      <div className={cn(textBlock, "mt-2.5 text-foreground")} data-promote="present">
        <span className={cn(label, "text-faint")}>already in {file}, so Apply adds nothing</span>
        {promote.rule.split("\n").map((line, i) => (
          <div key={i} className="min-h-[1lh] text-muted-foreground">
            {line}
          </div>
        ))}
      </div>
    );
  return (
    <div className={cn(textBlock, "mt-2.5 text-foreground")} data-promote>
      <span className={cn(label, "text-(--k-convention)")}>
        + {pick.rule !== undefined ? "your text, " : ""}added to {file}
        {where}
      </span>
      {promote.above.slice(-2).filter((line, i, all) => all.slice(0, i + 1).some((l) => l.trim())).map((line, i) => (
        <div key={`a${i}`} className="min-h-[1lh] truncate whitespace-pre text-faint">
          {line}
        </div>
      ))}
      {promoteLines(card, pick).map((line, i) => (
        <div key={i} data-diff-line="+" className="-mx-1.5 min-h-[1lh] rounded-sm bg-(--k-convention)/10 px-1.5 text-(--k-convention)">
          {line}
        </div>
      ))}
      <div className="mt-1.5 text-[12px] text-faint [overflow-wrap:anywhere]">
        Apply writes {promote.path}
        {promote.link ? ` (${promote.file} links to it)` : ""} and does not commit it.
      </div>
    </div>
  );
}

function Card({ card, pick, seen, mode, keys, textKeys, onCancel, onSave }: { card: AuditCard; pick: Pick; seen: boolean; mode: Mode; keys: React.ReactNode; textKeys: React.ReactNode; onCancel: () => void; onSave: (pick: Pick) => void }) {
  if (card.promote && mode === "edit") return <RuleCard card={card} initial={pick.rule ?? card.promote.rule} onCancel={onCancel} onSave={(rule) => onSave({ action: "promote", rule })} />;
  const own = pick.title !== undefined || pick.body !== undefined || pick.rule !== undefined;
  const newTitle = pick.title ?? card.proposed?.title ?? card.note.title;
  const newBody = pick.body ?? card.proposed?.body ?? card.note.body;
  const changed = own || !!card.proposed;
  if (mode === "edit") return <EditCard card={card} title={newTitle} body={newBody} onCancel={onCancel} onSave={(title, body) => onSave({ action: card.merge ? "merge" : "rewrite", title, body })} />;
  if (mode === "ask") return <AskCard card={card} initial={pick.request ?? ""} onCancel={onCancel} onSave={(request) => onSave({ action: "ask", request })} />;
  return (
    <Panel head={<Head card={card} />} footer={<div className="flex flex-wrap justify-center gap-1.5">{keys}</div>} data-card={card.id}>
      {card.merge ? (
        <div className="grid gap-2.5 wide:grid-cols-2">
          {[card.note, ...card.merge].map((note, i) => (
            <div key={note.id} className="rounded-lg border px-3.5 py-2.5">
              <div className="text-[13.5px] font-semibold">{note.title}</div>
              <div className="mt-1 text-[13px] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{note.body}</div>
              <div className="mt-1.5 text-[11.5px] text-faint">{fate(card, pick, i)}</div>
            </div>
          ))}
        </div>
      ) : changed && !card.promote ? (
        <div className={cn(textBlock, "text-foreground")}>
          <span className={cn(label, "flex gap-3")}>
            <span className="text-(--destructive)">− now</span>
            <span className="text-(--k-convention)">+ {own ? "your text" : "proposed by the agent"}</span>
          </span>
          {newTitle !== card.note.title && <b className="block"><Diff before={card.note.title} after={newTitle} /></b>}
          <Diff before={card.note.body} after={newBody} />
        </div>
      ) : (
        <div className={cn(textBlock, "text-foreground")}>{card.note.body}</div>
      )}

      {card.promote && pick.action === "promote" && <PromoteBox card={card} pick={pick} />}

      {card.merge && changed && !card.promote && (
        <div className={cn(textBlock, "mt-2.5 border-(--k-convention)/35 bg-(--k-convention)/6 text-foreground")}>
          <span className={cn(label, "text-(--k-convention)")}>{own ? "your merged text" : "merged text, proposed by the agent"}</span>
          {newTitle !== card.note.title && <b className="block">{newTitle}</b>}
          {newBody}
        </div>
      )}

      <div className="mt-1.5 flex justify-end gap-1 text-[12.5px] text-faint" data-text-keys>
        <span className="mr-auto">Not right?</span>
        {textKeys}
      </div>

      <div className={cn("mt-3 rounded-lg bg-muted px-3.5 py-3 text-[13.5px]", `a-${card.action}`)} data-recommendation>
        <div className="flex items-center gap-2">
          <span className="size-2 flex-none rounded-[2px] bg-(--a)" aria-hidden />
          <span className="text-muted-foreground">The agent suggests</span>
          <b className="font-semibold">{card.action === "promote" ? choiceLabel(card, "promote") : card.action}</b>
        </div>
        <p className="mt-1.5 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{card.why}</p>
      </div>
      <div className="mt-3 text-[13px] text-muted-foreground" data-pick-line>
        {seen ? "Your pick" : "Picked now"}: <b className={cn("font-semibold text-foreground")}>{pickLabel(card, pick)}</b>
        {pick.action === card.action && !own && !pick.request ? " (the agent's)" : ""}
        {pick.request && <span className="block text-faint">“{pick.request}”</span>}
      </div>
    </Panel>
  );
}

function EditCard({ card, title, body, onCancel, onSave }: { card: AuditCard; title: string; body: string; onCancel: () => void; onSave: (title: string, body: string) => void }) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const ok = !!t.trim() && !!b.trim();
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onCancel();
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && ok) onSave(t.trim(), b.trim());
    else return;
    event.preventDefault();
  };
  return (
    <Panel
      className="flex-1"
      head={<Head card={card} />}
      data-card={card.id}
      onKeyDown={keys}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-9 gap-2" onClick={onCancel}>
            <Kbd>Esc</Kbd> cancel
          </Button>
          <Button className="h-9 gap-2" disabled={!ok} onClick={() => onSave(t.trim(), b.trim())}>
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">{MAC ? "⌘" : "ctrl"} Enter</Kbd> save
          </Button>
        </div>
      }
    >
      <div className="flex min-h-full flex-col gap-2">
        <span className={cn(label, "mb-0 text-(--k-convention)")}>{card.merge ? "your merged text" : "your text"}</span>
        <Input value={t} onChange={(e) => setT(e.target.value)} aria-label="Title" className="font-semibold" />
        <Textarea ref={ref} value={b} onChange={(e) => setB(e.target.value)} aria-label="Body" className="min-h-40 flex-1 resize-none text-[13.5px]" />
      </div>
    </Panel>
  );
}

/** Edit the rule a promote card adds. It is plain lines of the instructions file, so it has no title. */
function RuleCard({ card, initial, onCancel, onSave }: { card: AuditCard; initial: string; onCancel: () => void; onSave: (rule: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const ok = !!text.trim();
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onCancel();
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && ok) onSave(text.trim());
    else return;
    event.preventDefault();
  };
  return (
    <Panel
      className="flex-1"
      head={<Head card={card} />}
      data-card={card.id}
      onKeyDown={keys}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-9 gap-2" onClick={onCancel}>
            <Kbd>Esc</Kbd> cancel
          </Button>
          <Button className="h-9 gap-2" disabled={!ok} onClick={() => onSave(text.trim())}>
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">{MAC ? "⌘" : "ctrl"} Enter</Kbd> save
          </Button>
        </div>
      }
    >
      <div className="flex min-h-full flex-col gap-2">
        <span className={cn(label, "mb-0 text-(--k-convention)")}>your text for {promoteFile(card)}</span>
        <Textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} aria-label="Rule" className="min-h-40 flex-1 resize-none font-mono text-[13px]" />
      </div>
    </Panel>
  );
}

function AskCard({ card, initial, onCancel, onSave }: { card: AuditCard; initial: string; onCancel: () => void; onSave: (request: string) => void }) {
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
    <Panel
      head={<Head card={card} />}
      data-card={card.id}
      onKeyDown={keys}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-9 gap-2" onClick={onCancel}>
            <Kbd>Esc</Kbd> cancel
          </Button>
          <Button className="h-9 gap-2" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">Enter</Kbd> save
          </Button>
        </div>
      }
    >
      <div className="grid gap-2">
        <label className="text-[13px] text-muted-foreground" htmlFor="ask-box">
          What is wrong with it? After Apply, tell the agent. It rewrites the note, and you see the new text in the next audit.
        </label>
        <Input id="ask-box" ref={ref} value={text} onChange={(e) => setText(e.target.value)} />
        <div className={cn(textBlock, "mt-1")}>{card.note.body}</div>
      </div>
    </Panel>
  );
}

function End({ data, picks, left, applying, error, onApply }: { data: AuditData; picks: Pick[]; left: number; applying: boolean; error: string; onApply: () => void }) {
  const groups = summary(data.cards, picks);
  const { changed, total } = changes(data.cards, picks);
  return (
    <Panel
      head={
        <>
          <h2 className="text-[19px] font-semibold">Ready to apply</h2>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            {changed} of {total} notes change.
            {data.index.hidden > 0 && (left === 0 ? " Every note will reach a session." : ` ${left} ${left === 1 ? "note" : "notes"} will still reach no session.`)}
          </p>
        </>
      }
      footer={
        <div className="flex items-center justify-end gap-3">
          {error && <p className="mr-auto text-[13px] text-destructive">{error}</p>}
          <Button className="h-9 gap-2 px-4" disabled={applying} onClick={onApply}>
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">Enter</Kbd> {applying ? "applying…" : "apply"}
          </Button>
        </div>
      }
    >
      <ul className="grid gap-2.5">
        {groups.map((group) => (
          <li key={group.label} className={cn("text-[13.5px]", `a-${group.action}`)}>
            <span className="flex items-center gap-2 font-semibold">
              <span className="size-2.5 rounded-[3px] bg-(--a)" />
              {group.label} <span className="font-normal text-faint">{group.titles.length}</span>
            </span>
            <span className="mt-0.5 block pl-4.5 text-[12.5px] text-muted-foreground">
              {group.titles.join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
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
