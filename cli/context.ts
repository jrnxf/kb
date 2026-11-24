// `kb context`: the text a session gets at start. The briefs, the index and the budget live here.

import { readFileSync } from "node:fs";
import { inHoldback, oldStart } from "./holdback.ts"; // HOLDBACK
import { lastActivity } from "./log.ts";
import { KINDS, localDate, normalizeTitle } from "./note.ts";
import { rememberRepo, repoRoot, scopesElsewhere } from "./repos.ts";
import { resolveRepo } from "./scope.ts";
import { anchorReader, changedAtLoad, missingAnchors } from "./stale.ts";
import { HARD_CONTEXT_CAP, type Config, type Store, type StoredNote, writeAtomic } from "./store.ts";
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
  /** `hidden` by owner: notes of the repo, and global notes. Repo notes rank first, so global notes are the first to go. */
  hiddenBy: { repo: number; global: number };
  /**
   * True when only the global audit makes room. In a repo, no repo note is hidden, and the hidden
   * global notes do not fit outside a repo either. An audit of the repo covers repo notes only,
   * so it is the wrong tool. False when the global notes fit on their own and the notes of this
   * repo take their room: then the audit of the repo makes room.
   */
  globalAudit: boolean;
  /** HOLDBACK: true when this start kept the old policy, and the ids it then printed with a whole body. */
  holdback: boolean;
  bodies: string[];
  /** Notes in the session whose anchor is gone from the checkout, with what is gone. */
  gone: { id: string; detail: string }[];
  /** Notes with an index line that says "changed": an anchored file changed after the last check of the note. */
  changed: string[];
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
  "When the user states a rule, a preference or a correction, write it to an instruction file in that turn with /kb:note, not to kb. Save what you learn (a gotcha, a decision, a how-to, open work) with `kb add --file` (`kb help` shows the JSON). Run `kb search` first, so you update a note instead of adding a twin.";

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

const EMPTY: ContextResult = { text: "", scope: null, briefs: [], index: [], triggerOnly: [], hidden: [], hiddenBy: { repo: 0, global: 0 }, globalAudit: false, holdback: false, bodies: [], gone: [], changed: [], chars: 0, charsBy: { fixed: 0, briefs: 0, index: 0, bodies: 0 } };

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
 * title, or an id with a number suffix. `changed` adds the word to the kind: an anchored file of
 * the note changed after its last check.
 */
export function indexLine(note: StoredNote, changed = false): string {
  const head = `- ${note.id} [${note.kind}${changed ? ", changed" : ""}]`;
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

/** A brief of a note with no next step shows this much of the body. */
export const BRIEF_BODY_CHARS = 240;

/** A next step is cut here, so one long step cannot take the room of the other briefs. */
export const BRIEF_NEXT_CHARS = 400;

/** What may come before the word "Next": a quote, heading or list mark, a number, a checkbox, and bold or italic marks. */
const LEAD = String.raw`[\s>#*+-]*(?:\d+[.)]\s+)?(?:\[[ xX]\]\s+)?[*_]*`;

/** The label of a next step: "Next", "Next step" or "Next steps", in any case. */
const LABEL = String.raw`next(?:\s+steps?)?`;

/**
 * A line that names the next step: the label, then a colon. The group takes the step, which is
 * empty when the step is on the lines below. The colon is what tells a label from a sentence:
 * "Next.js upgrade is half done" and "Next week the vendor ships" are no next step.
 */
const NEXT_LINE = new RegExp(`^${LEAD}${LABEL}[*_]*\\s*:[*_]*\\s*(.*)$`, "i");

/** A heading that is the label and nothing more, such as "## Next steps". It needs no colon. */
const NEXT_HEADING = new RegExp(`^\\s*#{1,6}\\s+[*_]*${LABEL}[*_]*\\s*$`, "i");

const HEADING = /^\s*#{1,6}\s/;

/**
 * The next step of open work, or null: the first line with the label and a step. A label with no
 * step on its line takes the list or the paragraph below it, after any empty lines. A label with
 * nothing below it is no next step.
 */
function nextStep(body: string): string | null {
  const lines = body.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const match = NEXT_LINE.exec(line);
    if (match?.[1]!.trim()) return line.trim();
    if (!match && !NEXT_HEADING.test(line)) continue;
    let from = at + 1;
    while (from < lines.length && !lines[from]!.trim()) from++;
    let to = from;
    while (to < lines.length && lines[to]!.trim() && !HEADING.test(lines[to]!)) to++;
    if (to > from) return [line.trim(), ...lines.slice(from, to).map((each) => each.trimEnd())].join("\n");
  }
  return null;
}

/**
 * The text of a brief with no heading marks. A brief is under "## Open work", so a "##" line in it
 * would read as a new section of the session text. A line in a code block keeps its "#": there it
 * starts a comment.
 */
function noHeadings(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced ? line : line.replace(/^\s*#{1,6}\s+/, "");
    })
    .join("\n");
}

/**
 * Open work in short form: the id, the kind and the title, then the next step, then the day of the
 * last check and where the rest is. The next step is what a new session needs to go on. A body
 * with no next step gives its start. The pointer is left out when the brief holds the whole body.
 */
export function briefBlock(note: Pick<StoredNote, "id" | "kind" | "title" | "body" | "last_verified">): string {
  const body = note.body.trim();
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}...` : text);
  const next = nextStep(body);
  const shown = next === null ? cut(body, BRIEF_BODY_CHARS) : cut(next, BRIEF_NEXT_CHARS);
  // Empty lines do not count: a brief leaves out the ones under a label.
  const squash = (text: string) => text.replace(/\n\s*\n/g, "\n");
  const rest = squash(shown) === squash(body) ? "" : ` \`kb show ${note.id}\` prints the rest.`;
  return `### ${note.id} [${note.kind}] ${note.title}\n${noHeadings(shown)}\nVerified ${localDate(note.last_verified)}.${rest}`;
}

/**
 * A global note that a command or an error loads. It needs no line in the index of a session.
 * Open work is never one of them: it is work to go on with, so a session must see it.
 */
const loadsAtTrigger = (note: StoredNote) => note.scope === "global" && note.kind !== "open-work" && readTriggers(note.triggers).length > 0;

function pointer(triggerOnly: number): string {
  const one = triggerOnly === 1;
  const at = triggerOnly > 0 ? `${triggerOnly} more global ${one ? "note loads" : "notes load"} only at ${one ? "its" : "their"} trigger, a command or an error. ` : "";
  return `${at}\`kb show <id>\` prints one note. \`kb search <words>\` searches every note.`;
}

/** Under the heading of an index that has a line with "changed". A title in the index reads as a fact, so the line says what the word means. */
export const CHANGED_LINE = 'A line with "changed" is a note on a file that changed after the last check of the note. Read the code before you act on it.';

/** The last line of an index that is cut: how many notes have no line. */
const overLine = (hidden: number) => `${hidden} more index ${hidden === 1 ? "line is" : "lines are"} over the index budget.`;

/**
 * The context of the directory at `repoPath`. A path that is not in a git repo gets global notes
 * only. `session` is the id of the session that starts, when there is one: it picks the arm.
 */
export function buildContext(store: Store, repoPath: string, session?: string): ContextResult {
  const start = startAt(store, repoPath, session);
  if (start.movedFrom && start.context.scope) rememberHint(store, start.context.scope, start.movedFrom);
  return start.context;
}

/**
 * The context of a scope: a repo id, or null for a session outside any repo. With the checkout at
 * `root`, each repo note in the session has its anchors checked: a note whose file or symbol is
 * gone says so, and a note whose file is not what its last check saw gets the word "changed". The
 * check reads files only, so a session start can afford it. `kb stale` runs the git checks later,
 * for the anchors that have no hash.
 */
export function contextFor(store: Store, scope: string | null, root: string | null = null, session?: string): ContextResult {
  return startOf(store, scope, root, session).context;
}

/** A session start with what it was built from, so `kb budget` reads neither the store nor the log a second time. */
interface Start {
  context: ContextResult;
  /** Every note of the session, in rank order. */
  ranked: StoredNote[];
  /** The ids of the notes on a changed file. */
  changed: Set<string>;
  config: Config;
  /** The other scope that the moved hint named, so a session start can record that it showed the hint. */
  movedFrom: string | null;
}

function startAt(store: Store, repoPath: string, session?: string): Start {
  // No store yet: no note loads, but the scope is still the repo here, as `kb scope` says.
  if (!store.exists()) return startOf(store, resolveRepo(repoPath, store, { record: false }).scope);
  const { scope, root } = resolveRepo(repoPath, store);
  if (scope && root) rememberRepo(store, scope, root);
  return startOf(store, scope, root, session);
}

/** At most this many characters say what is gone from one note, so one note cannot fill the budget. */
const GONE_DETAIL_CHARS = 120;

/** At most this many notes are listed under "Anchors gone". A checkout that lacks many files must not push notes out of the index. */
const GONE_LINES = 5;

/** What a start is laid out from. Nothing below reads the store, so a second layout costs no read. */
interface Session {
  scope: string | null;
  /** Every note of the session, in rank order. */
  ranked: StoredNote[];
  /** What is gone from a note, by id. */
  goneOf: Map<string, string>;
  /** The notes on a file that is not what their last check saw. */
  changed: Set<string>;
  syncError: string | null;
  /** When the repo has no notes, a line that names the scopes of the same repo name that have some. */
  moved: string | null;
  charBudget: number;
  briefChars: number;
}

function startOf(store: Store, scope: string | null, root: string | null = null, session?: string): Start {
  const config = store.config();
  const none = new Set<string>();
  if (!store.exists()) return { context: { ...EMPTY, scope }, ranked: [], changed: none, config, movedFrom: null };
  // HOLDBACK: a share of the sessions keeps the old policy. `kb budget` passes no session, so it shows the new one.
  const holdback = inHoldback(session, config.holdback);

  // A promoted note loads from the instruction file that holds it now, so it is not here too.
  const all = store.notes();
  const visible = all.filter((n) => !n.promoted_to && (n.scope === "global" || n.scope === scope));
  const syncError = store.syncError();
  const hint = scope ? movedHint(all, scope, new Set([...scopesElsewhere(store, scope, root), ...shownHints(store, scope)])) : null;
  const moved = hint?.text ?? null;
  const movedFrom = hint?.from ?? null;
  if (visible.length === 0 && !syncError && !moved) return { context: { ...EMPTY, scope, holdback }, ranked: [], changed: none, config, movedFrom };

  const ranked = rank(visible, lastActivity(store));
  const goneOf = new Map<string, string>();
  const changed = new Set<string>();
  if (scope && root) {
    const read = anchorReader();
    const changedOf = changedAtLoad(store, scope, root, read);
    for (const note of ranked) {
      if (note.scope !== scope || note.anchors.length === 0) continue;
      const missing = missingAnchors(note, root, read).map((m) => m.detail).join("; ");
      if (missing) goneOf.set(note.id, missing.length > GONE_DETAIL_CHARS ? `${missing.slice(0, GONE_DETAIL_CHARS - 3)}...` : missing);
      // A note under "Anchors gone" has its warning. The word is for the note that has none.
      else if (changedOf(note).length > 0) changed.add(note.id);
    }
  }
  const laid: Session = { scope, ranked, goneOf, changed, syncError, moved, charBudget: contextBudget(config.budgets.contextChars), briefChars: config.budgets.briefChars };
  if (holdback) return { context: heldStart(laid), ranked, changed, config, movedFrom }; // HOLDBACK

  const context = newStart(laid);
  // Only global notes are hidden here. Which audit makes room? Lay out the global notes alone, as
  // a session outside any repo gets them. If they do not fit there either, it is the global audit.
  if (scope && context.hiddenBy.repo === 0 && context.hiddenBy.global > 0) {
    const alone = newStart({ ...laid, scope: null, ranked: ranked.filter((n) => n.scope === "global"), goneOf: new Map(), changed: none });
    context.globalAudit = alone.hidden.length > 0;
  }
  return { context, ranked, changed, config, movedFrom };
}

const HINTS = "moved-hints.json";

function readHints(store: Store): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(store.statePath(HINTS), "utf8")) as Record<string, string[]>;
  } catch {
    return {};
  }
}

/** The scopes that a session start named already for this scope. The hint shows once for each pair, so it can be ignored. */
const shownHints = (store: Store, scope: string): string[] => readHints(store)[scope] ?? [];

/** Record that the hint named `from` for `scope`. It is per machine and never committed. */
function rememberHint(store: Store, scope: string, from: string): void {
  try {
    const seen = readHints(store);
    writeAtomic(store.statePath(HINTS), `${JSON.stringify({ ...seen, [scope]: [...(seen[scope] ?? []), from] }, null, 2)}\n`);
  } catch {
    // the hint shows again at the next start, which costs nothing
  }
}

/**
 * When no note that loads has the repo's scope, but another scope with the same repo name (the
 * last part of the id) has some, one line that names it and the move. The repo may have got a
 * remote, or its remote moved. It may also be another repo of that name, so kb moves nothing by
 * itself. The move goes only to a scope with a remote (an id with a "/"), never to a bare scope
 * that stands for no remote. `skip` holds the scopes that the line must not name: a scope that
 * another checkout uses, and a scope that the line named already.
 */
export function movedHint(notes: StoredNote[], scope: string, skip: ReadonlySet<string> = new Set()): { from: string; text: string } | null {
  const name = (id: string) => id.split("/").at(-1);
  // A promoted note loads from an instruction file, so it does not count as a note of the scope.
  const loads = notes.filter((n) => !n.promoted_to);
  if (scope === "global" || !scope.includes("/") || loads.some((n) => n.scope === scope)) return null;
  const counts = new Map<string, number>();
  for (const n of loads) if (n.scope !== "global" && n.scope !== scope && !skip.has(n.scope) && name(n.scope) === name(scope)) counts.set(n.scope, (counts.get(n.scope) ?? 0) + 1);
  const others = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (others.length === 0) return null;
  const [top, n] = others[0]!;
  const also = others.length > 1 ? ` (also ${others.slice(1, 3).map(([s]) => s).join(", ")}${others.length > 3 ? ", ..." : ""})` : "";
  return { from: top, text: `No note has the scope ${scope}, but ${top} has ${n} ${n === 1 ? "note" : "notes"} and the same repo name${also}. If they belong to this repo, tell the user: \`kb scope move ${top} ${scope} --dry-run\` shows what moves, and with no --dry-run it moves them. This line shows once.` };
}

/**
 * The parts of the text that every start has: `head`, the lines before the notes, and `index`, the
 * index section of the notes listed, with a last line that counts the hidden ones. `goneIn` gives
 * what is gone from the notes shown.
 */
function partsOf({ scope, goneOf, changed, syncError, moved }: Session, line: (note: StoredNote) => string) {
  const goneIn = (shown: StoredNote[]): ContextResult["gone"] => (goneOf.size === 0 ? [] : shown.filter((n) => goneOf.has(n.id)).map((n) => ({ id: n.id, detail: goneOf.get(n.id)! })));
  const head = (shown: StoredNote[]): string[] => {
    const lines = [`# kb: saved knowledge for ${scope ?? "this machine"}`, FORMAT_LINE, SAVE_RULE];
    if (syncError) lines.push(`kb sync did not finish: ${syncError} \`kb sync\` shows the detail.`);
    if (moved) lines.push(moved);
    // A note whose file or symbol is gone may be wrong now. The session checks it before it acts on it.
    const gone = goneIn(shown);
    if (gone.length > 0) {
      lines.push("", "## Anchors gone", "These notes name a file or a symbol that is not in the checkout now. Check a note before you act on it, then update it or trash it.", ...gone.slice(0, GONE_LINES).map((g) => `- ${g.id}: ${g.detail}`));
      if (gone.length > GONE_LINES) lines.push(`${gone.length - GONE_LINES} more. \`kb stale\` lists them.`);
    }
    return lines;
  };
  const index = (listed: StoredNote[], hidden: number): string[] => {
    if (listed.length === 0) return [];
    const lines = ["", "## Index"];
    if (listed.some((n) => changed.has(n.id))) lines.push(CHANGED_LINE);
    for (const section of [scope, "global"]) {
      const inSection = listed.filter((n) => n.scope === section);
      if (inSection.length === 0) continue;
      lines.push(`### ${section} (${inSection.length})`, ...inSection.map(line));
    }
    if (hidden > 0) lines.push(overLine(hidden));
    return lines;
  };
  return { goneIn, head, index };
}

const ids = (notes: StoredNote[]) => notes.map((n) => n.id);

/** `hidden` by owner. In a session outside any repo every note is global. */
const hiddenBy = (hidden: StoredNote[]) => {
  const global = hidden.filter((n) => n.scope === "global").length;
  return { repo: hidden.length - global, global };
};

/** The notes of a session start by form, as the text shows them. */
interface Shown {
  briefs: StoredNote[];
  listed: StoredNote[];
  triggerOnly: StoredNote[];
  hidden: StoredNote[];
}

/** A session start: the fixed text, the briefs of the open work, the index, and the pointer. */
function newStart(session: Session): ContextResult {
  const { scope, ranked, charBudget, briefChars } = session;
  // The text is built several times while the index is cut to fit, so each line and each brief is made once.
  const once = (make: (note: StoredNote) => string) => {
    const made = new Map<StoredNote, string>();
    return (note: StoredNote): string => {
      let text = made.get(note);
      if (text === undefined) made.set(note, (text = make(note)));
      return text;
    };
  };
  const line = once((note) => indexLine(note, session.changed.has(note.id)));
  const brief = once(briefBlock);
  const { goneIn, head, index } = partsOf(session, line);

  // `sizes` takes the characters of each section, each line with its newline.
  const size = (lines: string[], from: number, to: number) => lines.slice(from, to).reduce((sum, each) => sum + each.length + 1, 0);
  const render = ({ briefs, listed, triggerOnly, hidden }: Shown, sizes?: { briefs: number; index: number }): string => {
    const lines = head([...briefs, ...listed]);
    const briefsFrom = lines.length;
    if (briefs.length > 0) lines.push("", "## Open work", ...briefs.map(brief));
    const indexFrom = lines.length;
    lines.push(...index(listed, hidden.length));
    if (sizes) Object.assign(sizes, { briefs: size(lines, briefsFrom, indexFrom), index: size(lines, indexFrom, lines.length) });
    lines.push("");
    if (ranked.length > 0) lines.push(pointer(triggerOnly.length));
    return `${lines.join("\n")}\n`;
  };

  // Each note that has no brief is in the index, in rank order. A global note that loads at its
  // trigger takes no line. The result takes a count of lines and gives the start with that many.
  const place = (briefs: StoredNote[]) => {
    const rest = ranked.filter((n) => !briefs.includes(n));
    const lined = rest.filter((n) => !loadsAtTrigger(n));
    const triggerOnly = rest.filter(loadsAtTrigger);
    return { total: lined.length, at: (lines: number): Shown => ({ briefs, listed: lined.slice(0, lines), hidden: lined.slice(lines), triggerOnly }) };
  };
  // The character budget is the one limit of the index. Lines drop from the bottom, so the global
  // notes of the lowest rank go first. The answer is the largest count of lines that fits, and at
  // least one line. A store can hold thousands of notes, so the search builds the text a few times
  // only, not once for each line that drops.
  const fit = ({ total, at }: ReturnType<typeof place>): number => {
    const fits = (lines: number) => render(at(lines)).length <= charBudget;
    // The whole index is a case of its own: it has no line that counts the hidden notes, so it
    // can be shorter than the index with one line less.
    if (total <= 1 || fits(total)) return total;
    // Below that, each line makes the text longer, so a binary search finds the last count that fits.
    let low = 1;
    let high = total - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  // Open work has its own lane: the notes of this scope only, the newest verified first. A global
  // open-work note is open work of no repo, so in a repo session it is an index line.
  const briefs: StoredNote[] = [];
  const own = scope ?? "global";
  const open = ranked.filter((n) => n.kind === "open-work" && n.scope === own).sort((a, b) => b.last_verified.localeCompare(a.last_verified) || a.id.localeCompare(b.id));
  let chars = 0;
  for (const note of open) {
    chars += brief(note).length + 1;
    // The first brief that does not fit ends the lane, so an older note never jumps ahead of a newer one.
    if (briefs.length === MAX_BRIEFS || chars > briefChars || render(place([...briefs, note]).at(0)).length > charBudget) break;
    briefs.push(note);
  }
  const placed = place(briefs);
  const shown = placed.at(fit(placed));
  const sizes = { briefs: 0, index: 0 };
  const text = render(shown, sizes);
  return {
    text,
    scope,
    briefs: ids(shown.briefs),
    index: ids(shown.listed),
    triggerOnly: ids(shown.triggerOnly),
    hidden: ids(shown.hidden),
    hiddenBy: hiddenBy(shown.hidden),
    globalAudit: false,
    holdback: false,
    bodies: [],
    gone: goneIn([...shown.briefs, ...shown.listed]),
    changed: ids(shown.listed.filter((n) => session.changed.has(n.id))),
    chars: text.length,
    charsBy: { fixed: text.length - sizes.briefs - sizes.index, ...sizes, bodies: 0 },
  };
}

/** HOLDBACK: a start of the arm. The old policy picks the notes and builds the text, with the fixed text and the index lines of today. */
function heldStart(session: Session): ContextResult {
  const { goneIn, head, index } = partsOf(session, (note) => indexLine(note, session.changed.has(note.id)));
  const old = oldStart(session.ranked, session.scope !== null, { head, index }, session.charBudget);
  return {
    text: old.text,
    scope: session.scope,
    briefs: [],
    index: ids(old.listed),
    triggerOnly: [],
    hidden: ids(old.hidden),
    hiddenBy: hiddenBy(old.hidden),
    globalAudit: false,
    holdback: true,
    bodies: ids(old.bodies),
    gone: goneIn([...old.bodies, ...old.listed]),
    changed: ids(old.listed.filter((n) => session.changed.has(n.id))),
    chars: old.text.length,
    charsBy: { fixed: old.text.length - old.sizes.index - old.sizes.bodies, briefs: 0, ...old.sizes },
  };
}

export interface BudgetResult {
  scope: string | null;
  /** The characters of a session start, and the budget that is its hard limit. */
  context: { chars: number; budget: number };
  /** Open work with a brief: `count` of the `open` open-work notes of this scope, at most `limit`, and their characters of `budget`. */
  briefs: { count: number; limit: number; open: number; chars: number; budget: number };
  /**
   * lines: notes with an index line. triggerOnly: global notes that take no line, because each
   * loads at its trigger. hidden: notes whose line did not fit, which is hiddenRepo (notes of the
   * repo) and hiddenGlobal (global notes) together.
   */
  index: { lines: number; triggerOnly: number; hidden: number; hiddenRepo: number; hiddenGlobal: number };
  /** True only when a note reaches no session: its index line did not fit the character budget. */
  over: boolean;
  /**
   * True when only the global audit makes room: in a repo, no repo note is hidden, and the global
   * notes do not fit outside a repo either. Then `trim` and `ask` are empty here, and `kb budget`
   * outside any repo lists the global candidates.
   */
  globalAudit: boolean;
  /** Every note of a session of this scope, in rank order. `chars` is the size of its brief or of its index line, and 0 for a note that loads at its trigger. */
  notes: { id: string; kind: string; scope: string; chars: number; shown: "brief" | "index" | "trigger" | "hidden" }[];
  /**
   * The hidden notes that the audit of this scope can give a line, in rank order: the hidden notes
   * of the repo. When the repo has none, the hidden global notes, because the notes of the repo
   * take their room. Outside a repo, every hidden note. Empty when `globalAudit` is true.
   */
  makeRoomFor: string[];
  /** The characters that the lines of `makeRoomFor` can take now: what the budget has left, less the heading of their section when it has no line yet. */
  room: number;
  /**
   * Notes to look at first to make room: the lowest ranked decisions and how-tos of this scope (the
   * repo, or global outside a repo), because its audit covers only them. The limit is characters,
   * so the list ends when its lines make room for every line of `makeRoomFor`, and it can be
   * longer or shorter than that list. The reason gives the rank. Each may be trashed or merged.
   */
  trim: { id: string; reason: string }[];
  /** The rest of the room, as gotchas and conventions, the lowest ranked first. A rule that works leaves no trace in the log, so only the user can remove one. */
  ask: { id: string; kind: string; reason: string }[];
}

/** `kb budget`: what a session loads, which notes reach no session, and which notes to look at to make room. */
export function buildBudget(store: Store, repoPath: string): BudgetResult {
  return budgetFor(startAt(store, repoPath));
}

/** The budget of a scope: a repo id, or null for global notes only. */
export function budgetOf(store: Store, scope: string | null): BudgetResult {
  return budgetFor(startOf(store, scope, scope ? repoRoot(store, scope) : null));
}

function budgetFor({ context, ranked, changed, config }: Start): BudgetResult {
  const form = new Map<string, BudgetResult["notes"][number]["shown"]>();
  for (const id of context.briefs) form.set(id, "brief");
  for (const id of context.index) form.set(id, "index");
  for (const id of context.triggerOnly) form.set(id, "trigger");
  for (const id of context.hidden) form.set(id, "hidden");
  const notes = ranked.filter((n) => form.has(n.id)).map((n) => {
    const shown = form.get(n.id)!;
    return { id: n.id, kind: n.kind, scope: n.scope, chars: shown === "brief" ? briefBlock(n).length + 1 : shown === "trigger" ? 0 : indexLine(n, changed.has(n.id)).length + 1, shown };
  });
  type Row = (typeof notes)[number];
  const budget = contextBudget(config.budgets.contextChars);
  const own = context.scope ?? "global";
  // Only a note with no line is a reason to make room. A note that loads at its trigger is where it belongs.
  const hidden = notes.filter((n) => n.shown === "hidden");
  const over = hidden.length > 0;
  // The audit of a scope changes the notes of that scope only. So it makes room for its own hidden
  // notes first. A repo with none makes room for the global notes that its own notes push out.
  const ownHidden = hidden.filter((n) => n.scope === own);
  const makeRoomFor = context.globalAudit ? [] : ownHidden.length > 0 ? ownHidden : hidden;
  // A section with no line yet needs its heading too.
  const section = makeRoomFor[0]?.scope;
  const heading = section === undefined || notes.some((n) => n.shown === "index" && n.scope === section) ? 0 : `### ${section} (${makeRoomFor.length})`.length + 1;
  const room = budget - context.chars - heading;
  // The limit is characters, so a note makes room by the size of its line, not by one place. A
  // note that leaves takes its own characters out: of the text, or of what the hidden lines need.
  let need = makeRoomFor.reduce((sum, n) => sum + n.chars, 0) - room;
  const position = new Map(notes.map((n, i) => [n.id, i]));
  // Open work is never a candidate: it leaves the index when it is done. A gotcha or a convention
  // that works leaves no trace in the log, so nothing can say it is unneeded: those go to `ask`,
  // for the user to name. The lowest rank goes first, and the reason gives the rank.
  const reason = (n: Row) => `low rank, ${position.get(n.id)! + 1} of ${notes.length}`;
  const rule = (kind: string) => kind === "gotcha" || kind === "convention";
  // A note that takes no line frees none.
  const candidates = makeRoomFor.length === 0 ? [] : notes.filter((n) => n.scope === own && n.shown !== "trigger" && n.kind !== "open-work").reverse();
  const take = (from: Row[]) =>
    from.filter((n) => {
      if (need <= 0) return false;
      need -= n.chars;
      return true;
    });
  const trim = take(candidates.filter((n) => !rule(n.kind))).map((n) => ({ id: n.id, reason: reason(n) }));
  const ask = take(candidates.filter((n) => rule(n.kind))).map((n) => ({ id: n.id, kind: n.kind, reason: reason(n) }));
  return {
    scope: context.scope,
    context: { chars: context.chars, budget },
    briefs: {
      count: context.briefs.length,
      limit: MAX_BRIEFS,
      open: notes.filter((n) => n.kind === "open-work" && n.scope === own).length,
      chars: notes.reduce((sum, n) => sum + (n.shown === "brief" ? n.chars : 0), 0),
      budget: config.budgets.briefChars,
    },
    index: { lines: context.index.length, triggerOnly: context.triggerOnly.length, hidden: hidden.length, hiddenRepo: context.hiddenBy.repo, hiddenGlobal: context.hiddenBy.global },
    over,
    globalAudit: context.globalAudit,
    notes,
    makeRoomFor: makeRoomFor.map((n) => n.id),
    room,
    trim,
    ask,
  };
}
