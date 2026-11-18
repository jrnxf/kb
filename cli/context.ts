// `kb context`: the text a session gets at start. Ranking and both budgets live here.

import { KINDS, normalizeTitle } from "./note.ts";
import { rememberRepo } from "./repos.ts";
import { resolveRepo } from "./scope.ts";
import { HARD_CONTEXT_CAP, type Store, type StoredNote, type Usage } from "./store.ts";

export interface ContextResult {
  text: string;
  scope: string | null;
  /** Ids shown as index lines: the notes with no body, up to the index budget. */
  index: string[];
  /** Ids printed with a full body. */
  bodies: string[];
  /** Ids whose body did not fit the character budget. */
  dropped: string[];
  /** Notes with no body and no index line: the index budget cut them. A session cannot see them. */
  hiddenIndexLines: number;
  chars: number;
}

/**
 * The write path. Without it a session sees only how to read notes, and saves a rule the user
 * states in whatever store its harness offers instead.
 */
export const SAVE_RULE =
  "When the user states a rule, a preference or a correction, save it in that turn with `kb add` (`kb help` shows the JSON). Run `kb search` first, so you update a note instead of adding a twin.";

/**
 * Characters a session may get. The save rule is fixed text, so it comes on top of the notes
 * budget: a store tuned for N bodies still shows N. The hard cap holds for the whole text.
 */
export function contextBudget(contextChars: number): number {
  return Math.min(Math.max(500, contextChars) + SAVE_RULE.length + 1, HARD_CONTEXT_CAP);
}

const EMPTY: ContextResult = { text: "", scope: null, index: [], bodies: [], dropped: [], hiddenIndexLines: 0, chars: 0 };

/** open-work, gotcha, convention, decision, how-to. Then repo before global, last_used, last_verified. */
export function rank(notes: StoredNote[], usage: Map<string, Usage>): StoredNote[] {
  const desc = (a: string | undefined, b: string | undefined) => (b ?? "").localeCompare(a ?? "");
  return [...notes].sort(
    (a, b) =>
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      Number(a.scope === "global") - Number(b.scope === "global") ||
      desc(usage.get(a.id)?.last_used, usage.get(b.id)?.last_used) ||
      desc(a.last_verified, b.last_verified) ||
      a.id.localeCompare(b.id),
  );
}

function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One index line. An id is the slug of its title, cut at 48 characters, so a title next to it
 * says the same thing twice and doubles the cost of the index. For most notes the line is the
 * only thing a session gets, so it must not lose the words that the cut removed: they follow
 * after "...". The full title is added only when the id does not come from it: a rewritten
 * title, or an id with a number suffix.
 */
export function indexLine(note: StoredNote): string {
  const head = `- ${note.id} [${note.kind}]`;
  const full = normalizeTitle(note.title);
  if (full === note.id) return head;
  if (!full.startsWith(`${note.id}-`)) return `${head} ${note.title}`;
  // The shortest start of the title that gives the id. What follows is the part that was cut.
  let end = 0;
  while (end < note.title.length && normalizeTitle(note.title.slice(0, end)) !== note.id) end++;
  const rest = note.title.slice(end).replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return rest ? `${head} ...${rest}` : head;
}

function bodyBlock(note: StoredNote): string {
  const meta = [`verified ${localDate(note.last_verified)}${note.verified_at_commit ? ` at ${note.verified_at_commit}` : ""}`, `confidence ${note.confidence}`];
  if (note.anchors.length > 0) meta.push(`anchors: ${note.anchors.join(", ")}`);
  return `### ${note.id} [${note.kind}] ${note.title}\n${meta.join(" | ")}\n${note.body}\n`;
}

function pointer(dropped: number): string {
  const fit = dropped > 0 ? `${dropped} ${dropped === 1 ? "note is" : "notes are"} in the index only, because the bodies did not fit. ` : "";
  return `${fit}\`kb show <id>\` prints one note. \`kb search <words>\` searches every note.`;
}

export function buildContext(store: Store, repoPath: string): ContextResult {
  if (!store.exists()) return EMPTY;
  const { scope, root } = resolveRepo(repoPath, store);
  if (scope && root) rememberRepo(store, scope, root);
  const usage = store.usage();
  const config = store.config();

  // Promoted notes are already loaded by the repo's own CLAUDE.md or AGENTS.md.
  const visible = store.notes().filter((n) => n.indexed && !n.promoted_to && (n.scope === "global" || n.scope === scope));
  const syncError = store.syncError();
  if (visible.length === 0 && !syncError) return { ...EMPTY, scope };

  const ranked = rank(visible, usage);
  const charBudget = contextBudget(config.budgets.contextChars);
  let indexCount = Math.min(ranked.length, Math.max(1, config.budgets.indexLines));

  // A note with a body needs no index line: the body starts with its id and title. Bodies are
  // the top of the ranking, so the index is the next notes, up to the index budget.
  const listedFor = (bodyCount: number, lines: number) => ranked.slice(bodyCount, bodyCount + lines);

  const render = (listed: StoredNote[], bodies: StoredNote[]): string => {
    const lines = [`# kb: saved knowledge for ${scope ?? "this machine"}`, "These notes come from earlier sessions. Each is below once: with its body, or as an index line. An index line is the id, then after \"...\" the words of the title that the id cut.", SAVE_RULE];
    if (syncError) lines.push(`kb sync did not finish: ${syncError} \`kb sync\` shows the detail.`);
    if (listed.length > 0) {
      lines.push("", "## Index");
      for (const section of ["global", scope]) {
        const inSection = listed.filter((n) => n.scope === section);
        if (inSection.length === 0) continue;
        lines.push(`### ${section} (${inSection.length})`, ...inSection.map(indexLine));
      }
      const hidden = ranked.length - bodies.length - listed.length;
      if (hidden > 0) lines.push(`${hidden} more index ${hidden === 1 ? "line is" : "lines are"} over the index budget.`);
    }
    if (bodies.length > 0) {
      lines.push("", `## Notes (${bodies.length} of ${ranked.length}, by rank)`);
      for (const note of bodies) lines.push(bodyBlock(note));
    } else {
      lines.push("");
    }
    if (ranked.length > 0) lines.push(pointer(listed.length));
    return `${lines.join("\n")}\n`;
  };

  // The index comes first. If it alone is over the character budget, cut it from the bottom.
  while (indexCount > 1 && render(listedFor(0, indexCount), []).length > charBudget) indexCount--;

  // Whole bodies in rank order. The first one that does not fit ends the list, so a note is
  // never cut in half and a low-ranked short note never jumps ahead of a higher one.
  const bodies: StoredNote[] = [];
  for (const note of ranked) {
    const candidate = render(listedFor(bodies.length + 1, indexCount), [...bodies, note]);
    if (candidate.length > charBudget) break;
    bodies.push(note);
  }

  const listed = listedFor(bodies.length, indexCount);
  const dropped = ranked.slice(bodies.length);
  const text = render(listed, bodies);
  return {
    text,
    scope,
    index: listed.map((n) => n.id),
    bodies: bodies.map((n) => n.id),
    dropped: dropped.map((n) => n.id),
    hiddenIndexLines: dropped.length - listed.length,
    chars: text.length,
  };
}

export interface BudgetResult {
  scope: string | null;
  index: { lines: number; budget: number; hidden: number };
  context: { chars: number; budget: number; bodies: number; dropped: number };
  /** True only when a note reaches no session: it has no body and no index line. Bodies that drop to an index line are the normal state. */
  over: boolean;
  /** Every note a session of this scope can see, in rank order. */
  notes: { id: string; kind: string; scope: string; uses: number; last_used: string | null; chars: number; shown: "body" | "index" | "hidden" }[];
  /** Notes to look at first to make room, at most as many as are hidden: fewest uses, longest unused, lowest rank. Only decisions and how-tos. Each may be trashed, merged or shortened. Empty when no note is hidden. */
  trim: { id: string; reason: string }[];
  /** The rest of the hidden count, as gotchas and conventions in the same order. A rule that works leaves no use count, so only the user can remove one. */
  ask: { id: string; kind: string; reason: string }[];
  /** Notes of this scope that were demoted (`indexed: false`): no session loads them. */
  demoted: string[];
}

/** `kb budget`: what a session loads, which notes reach no session, and which notes to look at to make room. */
export function buildBudget(store: Store, repoPath: string): BudgetResult {
  const context = buildContext(store, repoPath);
  const config = store.config();
  const usage = store.usage();
  const all = store.notes();
  const byId = new Map(all.map((n) => [n.id, n]));
  const ranked = [...context.bodies, ...context.dropped].map((id) => byId.get(id)!).filter(Boolean);
  const bodies = new Set(context.bodies);
  const index = new Set(context.index);
  const notes = ranked.map((n) => ({
    id: n.id,
    kind: n.kind,
    scope: n.scope,
    uses: usage.get(n.id)?.uses ?? 0,
    last_used: usage.get(n.id)?.last_used ?? null,
    chars: bodyBlock(n).length,
    shown: bodies.has(n.id) ? ("body" as const) : index.has(n.id) ? ("index" as const) : ("hidden" as const),
  }));
  // A body that did not fit still reaches the session as an index line: that is how the store
  // stays small, not a fault. Only a note with neither is a reason to make room.
  const over = context.hiddenIndexLines > 0;
  const position = new Map(notes.map((n, i) => [n.id, i]));
  // Open work is never a candidate: it leaves the index when it is done. A gotcha or a convention
  // that works leaves no use count, so the count cannot say it is unneeded: those go to `ask`, for
  // the user to name. Among notes that nobody used, the lowest rank goes first.
  const reason = (n: (typeof notes)[number]) => (n.uses === 0 ? "never used" : `${n.uses} ${n.uses === 1 ? "use" : "uses"}, last ${n.last_used?.slice(0, 10)}`);
  const order = (a: (typeof notes)[number], b: (typeof notes)[number]) =>
    a.uses - b.uses || (a.last_used ?? "").localeCompare(b.last_used ?? "") || position.get(b.id)! - position.get(a.id)!;
  const rule = (kind: string) => kind === "gotcha" || kind === "convention";
  const trim = over
    ? notes.filter((n) => n.kind !== "open-work" && !rule(n.kind)).sort(order).slice(0, context.hiddenIndexLines).map((n) => ({ id: n.id, reason: reason(n) }))
    : [];
  const ask = over
    ? notes.filter((n) => rule(n.kind)).sort(order).slice(0, context.hiddenIndexLines - trim.length).map((n) => ({ id: n.id, kind: n.kind, reason: reason(n) }))
    : [];
  const demoted = all.filter((n) => !n.indexed && !n.promoted_to && (n.scope === "global" || n.scope === context.scope)).map((n) => n.id);
  return {
    scope: context.scope,
    index: { lines: context.index.length, budget: config.budgets.indexLines, hidden: context.hiddenIndexLines },
    context: { chars: context.chars, budget: contextBudget(config.budgets.contextChars), bodies: context.bodies.length, dropped: context.dropped.length },
    over,
    notes,
    trim,
    ask,
    demoted,
  };
}
