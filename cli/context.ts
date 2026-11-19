// `kb context`: the text a session gets at start. The briefs, the index and the budget live here.

import { bodyBlock, fillBodies, inHoldback } from "./holdback.ts"; // HOLDBACK
import { lastActivity } from "./log.ts";
import { KINDS, localDate, normalizeTitle } from "./note.ts";
import { rememberRepo, repoRoot } from "./repos.ts";
import { resolveRepo } from "./scope.ts";
import { anchorReader, missingAnchors } from "./stale.ts";
import { HARD_CONTEXT_CAP, type Store, type StoredNote } from "./store.ts";
import { readTriggers } from "./trigger.ts";

/**
 * What a session start gives. It comes before the task is known, so no gotcha, convention,
 * decision or how-to gets its body here: such a note reaches the agent at its trigger, at a path,
 * or by `kb show`. Each note is in one of four lists.
 */
export interface ContextResult {
  text: string;
  scope: string | null;
  /** Open work of this scope with a brief: the title, the next step and a pointer. The newest verified first. */
  briefs: string[];
  /** Ids shown as index lines, in rank order. */
  index: string[];
  /** Global notes with a `cmd`, `stop` or `err` trigger. They take no line: each loads at its trigger. */
  triggerOnly: string[];
  /** Notes whose index line did not fit the character budget, the lowest ranked. A session cannot see them. */
  hidden: string[];
  /** HOLDBACK: true when this start kept the old policy, and the ids it then printed with a whole body. */
  holdback: boolean;
  bodies: string[];
  /** Notes in the session whose anchor is gone from the checkout, with what is gone. */
  gone: { id: string; detail: string }[];
  chars: number;
  /** `chars` by what it pays for: the briefs, the index section, the bodies of the hold-back arm, and `fixed` for all the rest. */
  charsBy: { fixed: number; briefs: number; index: number; bodies: number };
}

/**
 * The write path, split by source. A rule the user states goes to an instruction file, which every
 * session loads whole. A fact the agent learns goes to kb. Without this a session saves both in
 * whatever store its harness offers.
 */
export const SAVE_RULE =
  "When the user states a rule, a preference or a correction, write it to an instruction file in that turn with /kb:note, not to kb. Save what you learn (a gotcha, a decision, a how-to, open work) with `kb add` (`kb help` shows the JSON). Run `kb search` first, so you update a note instead of adding a twin.";

/**
 * How to read the notes, in one line. It is fixed text that every session pays for, so it says
 * only what the text below cannot show: a note is never there twice, and an id is a title that was
 * cut, with the words it lost after "...".
 */
export const FORMAT_LINE = 'Each note is below once. An index line is the id, then "..." and the rest of the title.';

/**
 * Characters a session may get. The save rule is fixed text, so it comes on top of the notes
 * budget: a store tuned for N index lines still shows N. The hard cap holds for the whole text.
 */
export function contextBudget(contextChars: number): number {
  return Math.min(Math.max(500, contextChars) + SAVE_RULE.length + 1, HARD_CONTEXT_CAP);
}

const EMPTY: ContextResult = { text: "", scope: null, briefs: [], index: [], triggerOnly: [], hidden: [], holdback: false, bodies: [], gone: [], chars: 0, charsBy: { fixed: 0, briefs: 0, index: 0, bodies: 0 } };

/**
 * The order of the index. Repo notes before global notes, so the notes of the repo are never
 * crowded out. Repo notes go by kind (open-work, gotcha, convention, decision, how-to), then by
 * last activity on any machine, then last_verified. Global notes go open work first, then by last
 * activity, then by kind, then last_verified: when the index is over its budget the lines drop
 * from the bottom, and a note that sessions open must not lose its line to a kind. A note with no
 * activity comes after the notes that have some. No count of reads is in the order: a count
 * measures neither the value of a note nor the need for it. `active` is `lastActivity` of the store.
 */
export function rank(notes: StoredNote[], active: Map<string, string>): StoredNote[] {
  const desc = (a: string | undefined, b: string | undefined) => (b ?? "").localeCompare(a ?? "");
  const open = (note: StoredNote) => (note.kind === "open-work" ? 0 : 1);
  return [...notes].sort((a, b) => {
    const global = a.scope === "global";
    if (global !== (b.scope === "global")) return global ? 1 : -1;
    // Open work is the first kind, so in a repo the order of the kinds puts it first.
    const kind = KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
    const activity = desc(active.get(a.id), active.get(b.id));
    const rest = desc(a.last_verified, b.last_verified) || a.id.localeCompare(b.id);
    return global ? open(a) - open(b) || activity || kind || rest : kind || activity || rest;
  });
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

/** At most this many open-work notes get a brief. The others get an index line. */
export const MAX_BRIEFS = 3;

/** A brief of a note with no `Next` line shows this much of the body. */
export const BRIEF_BODY_CHARS = 240;

/** A `Next` line is cut here, so one long line cannot take the room of the other briefs. */
export const BRIEF_NEXT_CHARS = 400;

/** A line that names the next step: it starts with "Next", in any case, after a list or emphasis mark. */
const NEXT_LINE = /^[\s>*_#-]*next\b/i;

/** "Next:" or "Next steps:" with no step on the line. The step is on the lines below it. */
const NEXT_LABEL = /^\W*next(\s+steps?)?\W*$/i;

/** The next step of open work: the first line of the body that starts with "Next", or null. */
function nextStep(body: string): string | null {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => NEXT_LINE.test(line));
  if (at < 0) return null;
  let step = lines[at]!.trim();
  if (NEXT_LABEL.test(step)) for (let i = at + 1; i < lines.length && lines[i]!.trim(); i++) step += `\n${lines[i]!.trimEnd()}`;
  return step;
}

/**
 * Open work in short form: the id, the kind and the title, then the next step, then the day of the
 * last check and where the rest is. The next step is what a new session needs to go on. A body
 * with no `Next` line gives its start. The pointer is left out when the brief holds the whole body.
 */
export function briefBlock(note: Pick<StoredNote, "id" | "kind" | "title" | "body" | "last_verified">): string {
  const body = note.body.trim();
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}...` : text);
  const next = nextStep(body);
  const shown = next === null ? cut(body, BRIEF_BODY_CHARS) : cut(next, BRIEF_NEXT_CHARS);
  const rest = shown === body ? "" : ` \`kb show ${note.id}\` prints the rest.`;
  return `### ${note.id} [${note.kind}] ${note.title}\n${shown}\nVerified ${localDate(note.last_verified)}.${rest}`;
}

/** A global note that a command or an error loads. It needs no line in the index of a session. */
const loadsAtTrigger = (note: StoredNote) => note.scope === "global" && readTriggers(note.triggers).length > 0;

function pointer(triggerOnly: number): string {
  const one = triggerOnly === 1;
  const at = triggerOnly > 0 ? `${triggerOnly} more global ${one ? "note loads" : "notes load"} only at ${one ? "its" : "their"} trigger, a command or an error. ` : "";
  return `${at}\`kb show <id>\` prints one note. \`kb search <words>\` searches every note.`;
}

/**
 * The context of the directory at `repoPath`. A path that is not in a git repo gets global notes
 * only. `session` is the id of the session that starts, when there is one: it picks the arm.
 */
export function buildContext(store: Store, repoPath: string, session?: string): ContextResult {
  if (!store.exists()) return EMPTY;
  const { scope, root } = resolveRepo(repoPath, store);
  if (scope && root) rememberRepo(store, scope, root);
  return contextFor(store, scope, root, session);
}

/** At most this many characters say what is gone from one note, so one note cannot fill the budget. */
const GONE_DETAIL_CHARS = 120;

/** At most this many notes are listed under "Anchors gone". A checkout that lacks many files must not push notes out of the index. */
const GONE_LINES = 5;

/** The notes of a session start by form, as the text shows them. */
interface Shown {
  briefs: StoredNote[];
  listed: StoredNote[];
  triggerOnly: StoredNote[];
  hidden: StoredNote[];
  /** HOLDBACK: the notes with a whole body. */
  bodies: StoredNote[];
}

/**
 * The context of a scope: a repo id, or null for a session outside any repo. With the checkout at
 * `root`, each repo note in the session has its anchors checked, and a note whose file or symbol is
 * gone says so. The check reads files only, so a session start can afford it. `kb stale` runs the
 * git checks later.
 */
export function contextFor(store: Store, scope: string | null, root: string | null = null, session?: string): ContextResult {
  if (!store.exists()) return EMPTY;
  const config = store.config();
  // HOLDBACK: a share of the sessions keeps the old policy. `kb budget` passes no session, so it shows the new one.
  const holdback = inHoldback(session, config.holdback);

  // A promoted note loads from the instruction file that holds it now, so it is not here too.
  const visible = store.notes().filter((n) => !n.promoted_to && (n.scope === "global" || n.scope === scope));
  const syncError = store.syncError();
  if (visible.length === 0 && !syncError) return { ...EMPTY, scope, holdback };

  const ranked = rank(visible, lastActivity(store));
  const charBudget = contextBudget(config.budgets.contextChars);
  const goneOf = new Map<string, string>();
  if (scope && root) {
    const read = anchorReader();
    for (const note of ranked) {
      if (note.scope !== scope || note.anchors.length === 0) continue;
      const missing = missingAnchors(note, root, read).map((m) => m.detail).join("; ");
      if (missing) goneOf.set(note.id, missing.length > GONE_DETAIL_CHARS ? `${missing.slice(0, GONE_DETAIL_CHARS - 3)}...` : missing);
    }
  }
  const goneIn = (shown: StoredNote[]) => shown.filter((n) => goneOf.has(n.id)).map((n) => ({ id: n.id, detail: goneOf.get(n.id)! }));

  // The text is built once per candidate while the index is cut to fit, so each line is made once.
  const lineOf = new Map(ranked.map((n) => [n.id, indexLine(n)]));

  // `sizes` takes the characters of each section, each line with its newline.
  const size = (lines: string[], from: number, to: number) => lines.slice(from, to).reduce((sum, line) => sum + line.length + 1, 0);
  const render = ({ briefs, listed, triggerOnly, hidden, bodies }: Shown, sizes?: { briefs: number; index: number; bodies: number }): string => {
    const lines = [`# kb: saved knowledge for ${scope ?? "this machine"}`, FORMAT_LINE, SAVE_RULE];
    if (syncError) lines.push(`kb sync did not finish: ${syncError} \`kb sync\` shows the detail.`);
    // A note whose file or symbol is gone may be wrong now. The session checks it before it acts on it.
    const gone = goneIn([...briefs, ...bodies, ...listed]);
    if (gone.length > 0) {
      lines.push("", "## Anchors gone", "These notes name a file or a symbol that is not in the checkout now. Check a note before you act on it, then update it or trash it.", ...gone.slice(0, GONE_LINES).map((g) => `- ${g.id}: ${g.detail}`));
      if (gone.length > GONE_LINES) lines.push(`${gone.length - GONE_LINES} more. \`kb stale\` lists them.`);
    }
    const briefsFrom = lines.length;
    if (briefs.length > 0) lines.push("", "## Open work", ...briefs.map(briefBlock));
    const indexFrom = lines.length;
    if (listed.length > 0) {
      lines.push("", "## Index");
      for (const section of [scope, "global"]) {
        const inSection = listed.filter((n) => n.scope === section);
        if (inSection.length === 0) continue;
        lines.push(`### ${section} (${inSection.length})`, ...inSection.map((n) => lineOf.get(n.id)!));
      }
      if (hidden.length > 0) lines.push(`${hidden.length} more index ${hidden.length === 1 ? "line is" : "lines are"} over the index budget.`);
    }
    const bodiesFrom = lines.length;
    // HOLDBACK: the bodies come after the index, as they did before. No other start has this section.
    if (bodies.length > 0) {
      lines.push("", `## Notes (${bodies.length} of ${ranked.length}, by rank)`);
      for (const note of bodies) lines.push(bodyBlock(note));
    } else {
      lines.push("");
    }
    if (sizes) Object.assign(sizes, { briefs: size(lines, briefsFrom, indexFrom), index: size(lines, indexFrom, bodiesFrom), bodies: bodies.length > 0 ? size(lines, bodiesFrom, lines.length) : 0 });
    if (ranked.length > 0) lines.push(pointer(triggerOnly.length));
    return `${lines.join("\n")}\n`;
  };

  // Each note that is not on top (a brief, or a body in the hold-back arm) is in the index, in rank
  // order. A global note that loads at its trigger takes no line. `lines` is how many lines fit.
  const atTrigger = new Set(ranked.filter(loadsAtTrigger));
  const place = (briefs: StoredNote[], bodies: StoredNote[], lines: number): Shown => {
    const rest = ranked.filter((n) => !briefs.includes(n) && !bodies.includes(n));
    const lined = rest.filter((n) => !atTrigger.has(n));
    return { briefs, bodies, listed: lined.slice(0, lines), hidden: lined.slice(lines), triggerOnly: rest.filter((n) => atTrigger.has(n)) };
  };
  // The character budget is the one limit of the index. Lines drop from the bottom, so the global
  // notes of the lowest rank go first.
  const fit = (briefs: StoredNote[]): number => {
    let lines = place(briefs, [], ranked.length).listed.length;
    while (lines > 1 && render(place(briefs, [], lines)).length > charBudget) lines--;
    return lines;
  };

  // Open work has its own lane: the notes of this scope only, the newest verified first. A global
  // open-work note is open work of no repo, so in a repo session it is an index line.
  const briefs: StoredNote[] = [];
  if (!holdback) {
    const own = scope ?? "global";
    const open = ranked.filter((n) => n.kind === "open-work" && n.scope === own).sort((a, b) => b.last_verified.localeCompare(a.last_verified) || a.id.localeCompare(b.id));
    let chars = 0;
    for (const note of open) {
      chars += briefBlock(note).length + 1;
      // The first brief that does not fit ends the lane, so an older note never jumps ahead of a newer one.
      if (briefs.length === MAX_BRIEFS || chars > config.budgets.briefChars || render(place([...briefs, note], [], 0)).length > charBudget) break;
      briefs.push(note);
    }
  }
  const lines = fit(briefs);
  // HOLDBACK: the old policy. The index is cut to fit first, then whole bodies fill the room that is left.
  const bodies = holdback ? fillBodies(ranked, (top) => render(place([], top, lines)).length <= charBudget) : [];

  const shown = place(briefs, bodies, lines);
  const sizes = { briefs: 0, index: 0, bodies: 0 };
  const text = render(shown, sizes);
  const ids = (notes: StoredNote[]) => notes.map((n) => n.id);
  return {
    text,
    scope,
    briefs: ids(shown.briefs),
    index: ids(shown.listed),
    triggerOnly: ids(shown.triggerOnly),
    hidden: ids(shown.hidden),
    holdback,
    bodies: ids(shown.bodies),
    gone: goneIn([...shown.briefs, ...shown.bodies, ...shown.listed]),
    chars: text.length,
    charsBy: { fixed: text.length - sizes.briefs - sizes.index - sizes.bodies, ...sizes },
  };
}

export interface BudgetResult {
  scope: string | null;
  /** The characters of a session start, and the budget that is its hard limit. */
  context: { chars: number; budget: number };
  /** Open work with a brief: `count` of the `open` open-work notes of this scope, at most `limit`, and their characters of `budget`. */
  briefs: { count: number; limit: number; open: number; chars: number; budget: number };
  /** lines: notes with an index line. triggerOnly: global notes that take no line, because each loads at its trigger. hidden: notes whose line did not fit. */
  index: { lines: number; triggerOnly: number; hidden: number };
  /** True only when a note reaches no session: its index line did not fit the character budget. */
  over: boolean;
  /** Every note of a session of this scope, in rank order. `chars` is the size of its brief or of its index line, and 0 for a note that loads at its trigger. */
  notes: { id: string; kind: string; scope: string; chars: number; shown: "brief" | "index" | "trigger" | "hidden" }[];
  /** Notes to look at first to make room, at most as many as are hidden: the lowest ranked decisions and how-tos of this scope (the repo, or global outside a repo), because its audit covers only them. The reason gives the rank. Each may be trashed or merged. Empty when no note is hidden. */
  trim: { id: string; reason: string }[];
  /** The rest of the hidden count, as gotchas and conventions, the lowest ranked first. A rule that works leaves no trace in the log, so only the user can remove one. */
  ask: { id: string; kind: string; reason: string }[];
}

/** `kb budget`: what a session loads, which notes reach no session, and which notes to look at to make room. */
export function buildBudget(store: Store, repoPath: string): BudgetResult {
  return budgetFor(store, buildContext(store, repoPath));
}

/** The budget of a scope: a repo id, or null for global notes only. */
export function budgetOf(store: Store, scope: string | null): BudgetResult {
  return budgetFor(store, contextFor(store, scope, scope ? repoRoot(store, scope) : null));
}

function budgetFor(store: Store, context: ContextResult): BudgetResult {
  const config = store.config();
  const form = new Map<string, BudgetResult["notes"][number]["shown"]>();
  for (const id of context.briefs) form.set(id, "brief");
  for (const id of context.index) form.set(id, "index");
  for (const id of context.triggerOnly) form.set(id, "trigger");
  for (const id of context.hidden) form.set(id, "hidden");
  const notes = rank(store.notes().filter((n) => form.has(n.id)), lastActivity(store)).map((n) => {
    const shown = form.get(n.id)!;
    return { id: n.id, kind: n.kind, scope: n.scope, chars: shown === "brief" ? briefBlock(n).length + 1 : shown === "trigger" ? 0 : indexLine(n).length + 1, shown };
  });
  // Only a note with no line is a reason to make room. A note that loads at its trigger is where it belongs.
  const hidden = context.hidden.length;
  const over = hidden > 0;
  const position = new Map(notes.map((n, i) => [n.id, i]));
  // Open work is never a candidate: it leaves the index when it is done. A gotcha or a convention
  // that works leaves no trace in the log, so nothing can say it is unneeded: those go to `ask`,
  // for the user to name. The lowest rank goes first, and the reason gives the rank.
  const reason = (n: (typeof notes)[number]) => `low rank, ${position.get(n.id)! + 1} of ${notes.length}`;
  const order = (a: (typeof notes)[number], b: (typeof notes)[number]) => position.get(b.id)! - position.get(a.id)!;
  const rule = (kind: string) => kind === "gotcha" || kind === "convention";
  // An audit covers one scope, so only its notes are candidates. A note that takes no line frees none.
  const own = notes.filter((n) => n.scope === (context.scope ?? "global") && n.shown !== "trigger");
  const trim = over
    ? own.filter((n) => n.kind !== "open-work" && !rule(n.kind)).sort(order).slice(0, hidden).map((n) => ({ id: n.id, reason: reason(n) }))
    : [];
  const ask = over
    ? own.filter((n) => rule(n.kind)).sort(order).slice(0, hidden - trim.length).map((n) => ({ id: n.id, kind: n.kind, reason: reason(n) }))
    : [];
  return {
    scope: context.scope,
    context: { chars: context.chars, budget: contextBudget(config.budgets.contextChars) },
    briefs: {
      count: context.briefs.length,
      limit: MAX_BRIEFS,
      open: notes.filter((n) => n.kind === "open-work" && n.scope === (context.scope ?? "global")).length,
      chars: notes.reduce((sum, n) => sum + (n.shown === "brief" ? n.chars : 0), 0),
      budget: config.budgets.briefChars,
    },
    index: { lines: context.index.length, triggerOnly: context.triggerOnly.length, hidden },
    over,
    notes,
    trim,
    ask,
  };
}
