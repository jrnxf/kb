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
  /** Global notes over the global cap in a repo session, the least used. `kb search` still finds them. */
  capped: string[];
  chars: number;
}

/**
 * The write path, split by source. A rule the user states goes to an instruction file, which every
 * session loads whole. A fact the agent learns goes to kb. Without this a session saves both in
 * whatever store its harness offers.
 */
export const SAVE_RULE =
  "When the user states a rule, a preference or a correction, write it to an instruction file in that turn with /kb:note, not to kb. Save what you learn (a gotcha, a decision, a how-to, open work) with `kb add` (`kb help` shows the JSON). Run `kb search` first, so you update a note instead of adding a twin.";

/**
 * Characters a session may get. The save rule is fixed text, so it comes on top of the notes
 * budget: a store tuned for N bodies still shows N. The hard cap holds for the whole text.
 */
export function contextBudget(contextChars: number): number {
  return Math.min(Math.max(500, contextChars) + SAVE_RULE.length + 1, HARD_CONTEXT_CAP);
}

const EMPTY: ContextResult = { text: "", scope: null, index: [], bodies: [], dropped: [], hiddenIndexLines: 0, capped: [], chars: 0 };

/**
 * Repo notes before global notes, so the notes of the repo are never crowded out. Repo notes go by
 * kind (open-work, gotcha, convention, decision, how-to), then last_used, then last_verified. Global
 * notes go open work first, then by uses, so the global cap keeps the notes that sessions use.
 */
export function rank(notes: StoredNote[], usage: Map<string, Usage>): StoredNote[] {
  const desc = (a: string | undefined, b: string | undefined) => (b ?? "").localeCompare(a ?? "");
  const uses = (n: StoredNote) => usage.get(n.id)?.uses ?? 0;
  return [...notes].sort((a, b) => {
    const global = a.scope === "global";
    if (global !== (b.scope === "global")) return global ? 1 : -1;
    const kind = KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
    const used = desc(usage.get(a.id)?.last_used, usage.get(b.id)?.last_used);
    const rest = desc(a.last_verified, b.last_verified) || a.id.localeCompare(b.id);
    if (!global) return kind || used || rest;
    return Number(b.kind === "open-work") - Number(a.kind === "open-work") || uses(b) - uses(a) || used || kind || rest;
  });
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

function pointer(dropped: number, capped: number): string {
  const fit = dropped > 0 ? `${dropped} ${dropped === 1 ? "note is" : "notes are"} in the index only, because the bodies did not fit. ` : "";
  const out = capped > 0 ? `${capped} global ${capped === 1 ? "note" : "notes"} with fewer uses ${capped === 1 ? "is" : "are"} left out here. ` : "";
  return `${fit}${out}\`kb show <id>\` prints one note. \`kb search <words>\` searches every note.`;
}

/** The context of the directory at `repoPath`. A path that is not in a git repo gets global notes only. */
export function buildContext(store: Store, repoPath: string): ContextResult {
  if (!store.exists()) return EMPTY;
  const { scope, root } = resolveRepo(repoPath, store);
  if (scope && root) rememberRepo(store, scope, root);
  return contextFor(store, scope);
}

/** The context of a scope: a repo id, or null for a session outside any repo. */
export function contextFor(store: Store, scope: string | null): ContextResult {
  if (!store.exists()) return EMPTY;
  const usage = store.usage();
  const config = store.config();

  // A promoted note loads from the instruction file that holds it now, so it is not here too.
  const visible = store.notes().filter((n) => !n.promoted_to && (n.scope === "global" || n.scope === scope));
  const syncError = store.syncError();
  if (visible.length === 0 && !syncError) return { ...EMPTY, scope };

  // In a repo, global notes take at most globalIndexLines places, the most used first. The rest
  // stay out, so the repo's own notes always fit. Outside a repo, global notes are all there is.
  const all = rank(visible, usage);
  const globals = all.filter((n) => n.scope === "global");
  const capped = scope ? globals.slice(Math.max(0, config.budgets.globalIndexLines)) : [];
  const ranked = all.filter((n) => !capped.includes(n));
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
      for (const section of [scope, "global"]) {
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
    if (ranked.length > 0) lines.push(pointer(listed.length, capped.length));
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
    capped: capped.map((n) => n.id),
    chars: text.length,
  };
}

export interface BudgetResult {
  scope: string | null;
  /** capped: global notes over the global cap, which a repo session leaves out on purpose. They count in no hidden number. */
  index: { lines: number; budget: number; hidden: number; capped: number; globalBudget: number };
  context: { chars: number; budget: number; bodies: number; dropped: number };
  /** True only when a note reaches no session: it has no body and no index line. Bodies that drop to an index line are the normal state. */
  over: boolean;
  /** Every note a session of this scope can see, in rank order. */
  notes: { id: string; kind: string; scope: string; uses: number; last_used: string | null; chars: number; shown: "body" | "index" | "hidden" }[];
  /** Notes to look at first to make room, at most as many as are hidden: fewest uses, longest unused, lowest rank. Only decisions and how-tos of this scope (the repo, or global outside a repo), because its audit covers only them. Each may be trashed or merged. Shortening one frees nothing, because it ranks low. Empty when no note is hidden. */
  trim: { id: string; reason: string }[];
  /** The rest of the hidden count, as gotchas and conventions in the same order. A rule that works leaves no use count, so only the user can remove one. */
  ask: { id: string; kind: string; reason: string }[];
}

/** `kb budget`: what a session loads, which notes reach no session, and which notes to look at to make room. */
export function buildBudget(store: Store, repoPath: string): BudgetResult {
  return budgetFor(store, buildContext(store, repoPath));
}

/** The budget of a scope: a repo id, or null for global notes only. */
export function budgetOf(store: Store, scope: string | null): BudgetResult {
  return budgetFor(store, contextFor(store, scope));
}

function budgetFor(store: Store, context: ContextResult): BudgetResult {
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
  // An audit covers one scope, so only its notes are candidates.
  const own = notes.filter((n) => n.scope === (context.scope ?? "global"));
  const trim = over
    ? own.filter((n) => n.kind !== "open-work" && !rule(n.kind)).sort(order).slice(0, context.hiddenIndexLines).map((n) => ({ id: n.id, reason: reason(n) }))
    : [];
  const ask = over
    ? own.filter((n) => rule(n.kind)).sort(order).slice(0, context.hiddenIndexLines - trim.length).map((n) => ({ id: n.id, kind: n.kind, reason: reason(n) }))
    : [];
  return {
    scope: context.scope,
    index: { lines: context.index.length, budget: config.budgets.indexLines, hidden: context.hiddenIndexLines, capped: context.capped.length, globalBudget: config.budgets.globalIndexLines },
    context: { chars: context.chars, budget: contextBudget(config.budgets.contextChars), bodies: context.bodies.length, dropped: context.dropped.length },
    over,
    notes,
    trim,
    ask,
  };
}
