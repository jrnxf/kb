// The event log: what each session was shown, what it opened, and what came of it. One JSON object
// per line in .state/log/<YYYY-MM>.jsonl. Per machine, never committed and never synced, so a read
// of a note is no longer a write to the store. The audit reads the log through `kb log`.
// What the other machines need of it syncs as a small roll-up, one file per machine in activity/.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Store, writeAtomic } from "./store.ts";

export const VERDICTS = ["helped", "not-needed", "wrong"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** task: the agent needed the note for its work. check: bookkeeping, such as an audit or a search before a write. */
export type Why = "task" | "check";

export type WriteOp = "add" | "update" | "trash" | "restore" | "delete" | "verify";

/**
 * Why the record of an unsaved session was dropped. short: a measure found nothing to recover.
 * user: `kb unsaved --forget`. aged: 7 days passed. gone: its transcript is no longer on disk.
 */
export const FORGET_WHYS = ["short", "user", "aged", "gone"] as const;
export type ForgetWhy = (typeof FORGET_WHYS)[number];

/**
 * Who an event belongs to, when known. `agent` is set for a subagent. `scope` is the repo id of the
 * directory the event came from, or "global" outside any repo.
 */
export interface Who {
  session?: string;
  agent?: string;
  scope?: string;
}

export interface StartEvent {
  ev: "start";
  /** startup, resume, clear, compact or fork. */
  source: string;
  /** The note ids by the form the session got: a whole body, or an index line. */
  bodies: string[];
  index: string[];
  /** Notes in no session: over the index budget, or over the global cap. */
  hidden: string[];
  /** Characters of the whole hook output. `fixed` is all that is not an index line or a body. */
  chars: { fixed: number; index: number; bodies: number; total: number };
  /** Room for later forms. Nothing writes them yet. */
  briefs?: string[];
  holdback?: boolean;
}

/**
 * A note that a trigger loaded: a command (`cmd`), a command that was refused once (`stop`), an
 * error (`err`), or a file that an anchor names (`path`). The agent got the body or the title.
 */
export interface FireEvent {
  ev: "fire";
  kind: "cmd" | "stop" | "err" | "path";
  form: "body" | "title";
  note: string;
  /** The tool of the call, as the harness names it. */
  tool: string;
  /** What matched: the words of the trigger, the text of the error trigger, or the repo-relative path of the file. */
  match: string;
}

export type LogEvent = Who &
  (
    | StartEvent
    | FireEvent
    /** `trashed`: the note was in the trash. A look into the trash is never activity. */
    | { ev: "show"; note: string; why: Why; trashed?: true }
    /**
     * `hits` counts the notes that have every word. When no note has every word, `complete` is
     * false, `hits` is 0 and `closest` counts the notes with the most words, which the search printed.
     */
    | { ev: "search"; query: string; hits: number; complete?: boolean; closest?: number; why: Why }
    /** `from`: the write came from a recovery, and this is the unsaved session it read. */
    | { ev: "write"; note: string; op: WriteOp; from?: string }
    | { ev: "verdict"; note: string; verdict: Verdict }
    | { ev: "checkpoint" }
    /**
     * A session ended. `reason` is the word of the harness: clear, other, and so on. `checkpoint`
     * says if /kb:checkpoint had run in it. A session that is resumed ends more than once.
     */
    | { ev: "ended"; reason: string; checkpoint: boolean }
    /**
     * A session that ended with no checkpoint is worth a recovery. Written once per session, by the
     * measure of a later session start or of /kb:recover, with what it counted. A transcript too
     * large to measure at a start has no counts. A log line of an older kb means only that a
     * session ended with no checkpoint after /clear.
     */
    | { ev: "unsaved"; reason?: string; prompts?: number; failed?: number }
    /**
     * Another session saved the knowledge of an unsaved one. `session` is the session that was
     * recovered, `by` the session that did it, and `notes` the notes the recovery wrote.
     */
    | { ev: "recover"; by?: string; notes: string[]; reason?: string }
    /**
     * The record of an unsaved session was dropped, and nothing recovered it. `worth` is there
     * when the log has an `unsaved` line for the session. `by` is the session that asked.
     */
    | { ev: "forgotten"; why: ForgetWhy; worth?: true; by?: string }
  );

/** An event as the log holds it. A reader must expect kinds and fields that a later kb wrote. */
export type Logged = LogEvent & { t: string };

const logDir = (store: Store) => store.statePath("log");

/** Times in the log have the form of every other time in the store, so they compare as text. */
const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

// ---- who ----

/** A session or agent id as the log keeps it: a short text, or nothing. */
function logId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

/**
 * The session a command belongs to: the --session flag, else KB_SESSION, else the id that Claude
 * Code gives each command of a session. That name is the one thing the CLI knows of a harness. An
 * agent runs `kb show` with no flag, often through a shell function and not the launcher, and an
 * event with no session tells the audit little. Every id of a session is resolved here.
 */
export function sessionOf(flag: unknown, env: Record<string, string | undefined> = process.env): string | undefined {
  return logId(flag) ?? logId(env.KB_SESSION) ?? logId(env.CLAUDE_CODE_SESSION_ID);
}

/** Who a hook input names: the session, and the subagent when a subagent did it. */
export function hookWho(input: { session_id?: unknown; agent_id?: unknown } | null | undefined): Who {
  return { session: logId(input?.session_id), agent: logId(input?.agent_id) };
}

let actor: () => Who = () => ({});

/** The CLI names who runs the command once. Each event of the command then carries it, unless the event says otherwise. */
export function setActor(who: () => Who): void {
  actor = who;
}

// ---- write ----

/**
 * Append events to the log, each with the time `t`. It never throws, and it does one small append:
 * a hook and a read command must not fail or wait for the log. Sessions that append at the same
 * time each add whole lines. Returns false when nothing was written.
 */
export function logEvent(store: Store, events: LogEvent | LogEvent[], now: Date = new Date()): boolean {
  try {
    const list = Array.isArray(events) ? events : [events];
    // A log must not create a store: only a command that writes a note does.
    if (list.length === 0 || !store.exists()) return false;
    const t = stamp(now);
    let who: Who = {};
    try {
      who = actor();
    } catch {
      // an event with no session is better than no event
    }
    const text = list
      .map(({ ev, session, agent, scope, ...rest }) => `${JSON.stringify({ t, ev, session: session ?? who.session, agent: agent ?? who.agent, scope: scope ?? who.scope, ...rest })}\n`)
      .join("");
    const path = join(logDir(store), `${t.slice(0, 7)}.jsonl`);
    try {
      appendFileSync(path, text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      store.ensure(); // keeps .state/ out of git in a store made by an older version
      mkdirSync(logDir(store), { recursive: true });
      appendFileSync(path, text);
    }
    return true;
  } catch {
    return false;
  }
}

// ---- read ----

/** The monthly files, oldest first. The folder also holds the activity cache. */
function logFiles(store: Store): string[] {
  try {
    return readdirSync(logDir(store)).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    return [];
  }
}

/** One line of the log, or null for a line that is not an event: a hand edit or a write that was cut. */
function parseLine(line: string): Logged | null {
  if (!line) return null;
  try {
    const event = JSON.parse(line);
    return event !== null && typeof event === "object" && typeof event.t === "string" && typeof event.ev === "string" ? (event as Logged) : null;
  } catch {
    return null;
  }
}

/**
 * The events in time order. A line that does not parse is skipped. `has` is a text that each line
 * of interest holds: a line without it is not parsed, because most lines are long and of no use to
 * a caller that wants one session or one kind of event.
 */
function scanLog(store: Store, from: string, has?: string): Logged[] {
  const events: Logged[] = [];
  for (const name of logFiles(store)) {
    if (name.slice(0, 7) < from.slice(0, 7)) continue;
    let lines: string;
    try {
      lines = readFileSync(join(logDir(store), name), "utf8");
    } catch {
      continue;
    }
    for (const line of lines.split("\n")) {
      if (has !== undefined && !line.includes(has)) continue;
      const event = parseLine(line);
      if (event && event.t >= from) events.push(event);
    }
  }
  // Each file is in the order of the appends. The sort is stable, so it only mends a clock that went back.
  return events.sort((a, b) => a.t.localeCompare(b.t));
}

/** The events in time order, of one session or from a start time on. A line that does not parse is skipped. */
export function readLog(store: Store, filter: { since?: Date; session?: string } = {}): Logged[] {
  const from = filter.since ? stamp(filter.since) : "";
  if (filter.session === undefined) return scanLog(store, from);
  // A line holds its session id as JSON text. Only a line with that text can belong to the session.
  return scanLog(store, from, JSON.stringify(filter.session).slice(1, -1)).filter((event) => event.session === filter.session);
}

// ---- summary ----

/** What the log says about one note. */
export interface NoteLog {
  id: string;
  /** Session starts that gave the note whole, as an index line, or not at all. */
  body: number;
  index: number;
  hidden: number;
  /** `kb show`: for a task, and as a check. */
  opened: { task: number; check: number };
  /** Times a trigger loaded the note: a command, an error, or a tool call on a file it is anchored to. */
  fired: number;
  /** One verdict per session and note: the last one counts. See `finalVerdicts`. */
  verdicts: Record<Verdict, number>;
}

export interface LogSummary {
  /** The first and the last event time, or null for an empty log. */
  from: string | null;
  to: string | null;
  events: number;
  /** Distinct session ids. */
  sessions: number;
  starts: number;
  searches: { task: number; check: number };
  checkpoints: number;
  /** Session ends, and those of a session in which a checkpoint had run. */
  ended: { all: number; checkpointed: number };
  /** Sessions that were worth a recovery, each once, and those that another session saved later. */
  unsaved: number;
  recovered: number;
  /** Records of unsaved sessions that were dropped, by why. `worth` counts those that were worth a recovery. */
  forgotten: Record<ForgetWhy, number> & { worth: number };
  /** Every note the events name, by id. */
  notes: NoteLog[];
}

export const emptyNoteLog = (id: string): NoteLog => ({ id, body: 0, index: 0, hidden: 0, opened: { task: 0, check: 0 }, fired: 0, verdicts: { helped: 0, "not-needed": 0, wrong: 0 } });

/** A field of a line as the reader takes it: a later kb, or a hand edit, may have written another shape. */
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => text(each) !== null) : []);
const isWhy = (value: unknown): value is Why => value === "task" || value === "check";

/** An event with its fields not yet checked. */
type Raw = { t: string; ev: string } & Record<string, unknown>;

/**
 * The verdicts that count, in time order. A session that gives its verdicts twice, or corrects
 * one, still judged each note once: its last verdict counts, with the time of that verdict. A
 * subagent judges for itself. A verdict with no session cannot be matched to one, so the same
 * verdict on the same note on the same day counts once.
 */
function finalVerdicts(events: Logged[]): { note: string; verdict: Verdict; t: string }[] {
  const last = new Map<string, { note: string; verdict: Verdict; t: string }>();
  for (const event of events as Raw[]) {
    const note = event.ev === "verdict" ? text(event.note) : null;
    if (!note || !VERDICTS.includes(event.verdict as Verdict)) continue;
    const verdict = event.verdict as Verdict;
    const session = text(event.session);
    const key = session ? `${session}\n${text(event.agent) ?? ""}\n${note}` : `\n${note}\n${verdict}\n${event.t.slice(0, 10)}`;
    // A later verdict takes the place of the first one in time order too.
    last.delete(key);
    last.set(key, { note, verdict, t: event.t });
  }
  return [...last.values()];
}

export function summarize(events: Logged[]): LogSummary {
  const notes = new Map<string, NoteLog>();
  const of = (id: unknown): NoteLog | null => {
    if (typeof id !== "string" || !id) return null;
    if (!notes.has(id)) notes.set(id, emptyNoteLog(id));
    return notes.get(id)!;
  };
  const summary: LogSummary = { from: events[0]?.t ?? null, to: events.at(-1)?.t ?? null, events: events.length, sessions: 0, starts: 0, searches: { task: 0, check: 0 }, checkpoints: 0, ended: { all: 0, checkpointed: 0 }, unsaved: 0, recovered: 0, forgotten: { short: 0, user: 0, aged: 0, gone: 0, worth: 0 }, notes: [] };
  const sessions = new Set<string>();
  /** A session is worth a recovery once, also when two starts measured it at the same moment. */
  const unsaved = new Set<string>();
  // The fields are read as unknown: a later kb, or a hand edit, may have written another shape.
  for (const event of events as Raw[]) {
    const session = text(event.session);
    if (session) sessions.add(session);
    switch (event.ev) {
      case "start":
        summary.starts++;
        for (const id of texts(event.bodies)) of(id)!.body++;
        for (const id of texts(event.index)) of(id)!.index++;
        for (const id of texts(event.hidden)) of(id)!.hidden++;
        break;
      case "show": {
        const note = of(event.note);
        if (note && isWhy(event.why)) note.opened[event.why]++;
        break;
      }
      case "fire": {
        const note = of(event.note);
        if (note) note.fired++;
        break;
      }
      case "verdict":
        // A note that only a verdict of an unknown kind names still gets a row.
        of(event.note);
        break;
      case "search":
        if (isWhy(event.why)) summary.searches[event.why]++;
        break;
      case "checkpoint":
        summary.checkpoints++;
        break;
      case "ended":
        summary.ended.all++;
        if (event.checkpoint === true) summary.ended.checkpointed++;
        break;
      case "unsaved":
        if (!session) summary.unsaved++;
        else unsaved.add(session);
        break;
      case "recover":
        summary.recovered++;
        break;
      case "forgotten":
        if (FORGET_WHYS.includes(event.why as ForgetWhy)) summary.forgotten[event.why as ForgetWhy]++;
        if (event.worth === true) summary.forgotten.worth++;
        break;
      case "write":
        // A note that only a write names still gets a row, so a new note is in the summary.
        of(event.note);
        break;
    }
  }
  for (const { note, verdict } of finalVerdicts(events)) of(note)!.verdicts[verdict]++;
  summary.sessions = sessions.size;
  summary.unsaved += unsaved.size;
  summary.notes = [...notes.values()].sort((a, b) => a.id.localeCompare(b.id));
  return summary;
}

// ---- last activity ----

/**
 * The note of an event that shows the note was of use: a show for a task, a fire, or a verdict
 * "helped". A show of a note in the trash is a look at what was retired, not a use of it.
 */
function activeNote(event: Logged): string | null {
  const e = event as { ev: string; note?: unknown; why?: unknown; verdict?: unknown; trashed?: unknown };
  if (typeof e.note !== "string" || !e.note) return null;
  return (e.ev === "show" && e.why === "task" && !e.trashed) || e.ev === "fire" || (e.ev === "verdict" && e.verdict === "helped") ? e.note : null;
}

/** How far each file is read, in bytes, and the newest activity found up to there. */
interface ActivityCache {
  read: Record<string, number>;
  last: Map<string, string>;
}

const cachePath = (store: Store) => join(logDir(store), "activity.json");

function readCache(store: Store): ActivityCache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(store), "utf8")) as { read: Record<string, number>; last: [string, string][] };
    if (raw.read && typeof raw.read === "object" && Array.isArray(raw.last)) return { read: raw.read, last: new Map(raw.last) };
  } catch {
    // no cache yet, or a broken one: read the log from the start
  }
  return { read: {}, last: new Map() };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readBytes(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, from));
  } finally {
    closeSync(fd);
  }
}

/**
 * The newest activity of each note in the log. The log grows with every session and the ranking
 * needs this at every session start, so a cache keeps the answer and how far each file is read.
 * Only the new lines are read. Two sessions that update the cache at once each write a whole,
 * correct state.
 */
function logActivity(store: Store): Map<string, string> {
  const names = logFiles(store);
  if (names.length === 0) return new Map();
  const sizes = new Map(names.map((name) => [name, fileSize(join(logDir(store), name))]));
  let cache = readCache(store);
  // A file that is gone or shorter was changed by hand, so what was read no longer holds.
  if (Object.entries(cache.read).some(([name, read]) => !(read <= (sizes.get(name) ?? -1)))) cache = { read: {}, last: new Map() };
  let changed = false;
  for (const name of names) {
    const from = cache.read[name] ?? 0;
    const size = sizes.get(name)!;
    if (size <= from) continue;
    const bytes = readBytes(join(logDir(store), name), from, size - from);
    // A line that another session writes right now has no end yet. It waits for the next read.
    const end = bytes.lastIndexOf(10) + 1;
    if (end === 0) continue;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      // A start is the longest line and never an activity, so it is not worth a parse.
      if (line.includes('"ev":"start"')) continue;
      const event = parseLine(line);
      const note = event && activeNote(event);
      if (note && event.t > (cache.last.get(note) ?? "")) cache.last.set(note, event.t);
    }
    cache.read[name] = from + end;
    changed = true;
  }
  if (changed) {
    try {
      writeAtomic(cachePath(store), JSON.stringify({ read: cache.read, last: [...cache.last] }));
    } catch {
      // the cache only saves time
    }
  }
  return cache.last;
}

// ---- the roll-up: what the other machines need of this log ----

/** A note is "not needed" when this many sessions said so. A roll-up keeps that many times per note. */
export const NOT_NEEDED_SESSIONS = 3;

/** The log keeps this many months. A monthly file older than that is removed. */
export const LOG_MONTHS = 12;

/** What one machine knows of a note, in the form that syncs. Each time has the form of the log. */
export interface NoteRollUp {
  /** The last activity. */
  last?: string;
  /** The newest verdict "helped", and the newest verdict "wrong". */
  helped?: string;
  wrong?: string;
  /** The newest verdicts "not-needed", one per session, the newest first. At most NOT_NEEDED_SESSIONS. */
  not_needed?: string[];
}

const rollUpDir = (store: Store) => join(store.home, "activity");

/** A machine id that is safe as a file name. */
const SAFE_MACHINE = /^[A-Za-z0-9_-]{1,64}$/;

/** A roll-up file as a map. It accepts any shape, and takes only the fields that are a time. */
function readRollUp(path: string): Map<string, NoteRollUp> {
  const notes = new Map<string, NoteRollUp>();
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(path, "utf8")) as { notes?: unknown } | null)?.notes;
  } catch {
    return notes;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return notes;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || value === null || typeof value !== "object") continue;
    const { last, helped, wrong, not_needed } = value as Record<string, unknown>;
    const entry: NoteRollUp = {};
    if (text(last)) entry.last = last as string;
    if (text(helped)) entry.helped = helped as string;
    if (text(wrong)) entry.wrong = wrong as string;
    if (texts(not_needed).length > 0) entry.not_needed = texts(not_needed);
    if (Object.keys(entry).length > 0) notes.set(id, entry);
  }
  return notes;
}

/** The roll-up of each machine that has one, this machine too. */
function rollUps(store: Store): { machine: string; notes: Map<string, NoteRollUp> }[] {
  let files: string[];
  try {
    files = readdirSync(rollUpDir(store)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files.map((name) => ({ machine: name.slice(0, -5), notes: readRollUp(join(rollUpDir(store), name)) }));
}

const newest = (a: string | undefined, b: string | undefined) => ((a ?? "") >= (b ?? "") ? a : b);

/** The verdicts on each note. `notNeeded` has one time per session, the newest first. */
export interface Judgment {
  helped?: string;
  wrong?: string;
  notNeeded: string[];
}

/** What the log of this machine says of the verdicts on each note. Only the verdict lines are parsed. */
function logJudgments(store: Store): Map<string, Judgment> {
  const judged = new Map<string, Judgment>();
  for (const { note, verdict, t } of finalVerdicts(scanLog(store, "", '"verdict"'))) {
    const entry = judged.get(note) ?? { notNeeded: [] };
    if (verdict === "not-needed") entry.notNeeded.push(t);
    else entry[verdict] = newest(entry[verdict], t);
    judged.set(note, entry);
  }
  for (const entry of judged.values()) entry.notNeeded.sort().reverse();
  return judged;
}

/**
 * The verdicts on each note over all machines: the log of this machine, and the roll-up of each
 * other machine. `kb stale` reads them. A roll-up keeps at most NOT_NEEDED_SESSIONS times per note,
 * which is enough to tell if that many sessions said "not-needed".
 */
export function judgments(store: Store): Map<string, Judgment> {
  let judged = new Map<string, Judgment>();
  try {
    judged = logJudgments(store);
  } catch {
    // a log that cannot be read gives no verdict
  }
  // The roll-up of this machine says what its log says, as of the day it was written.
  const own = store.local().machine;
  for (const { machine, notes } of rollUps(store)) {
    if (machine === own) continue;
    for (const [id, theirs] of notes) {
      const entry = judged.get(id) ?? { notNeeded: [] };
      if (theirs.helped) entry.helped = newest(entry.helped, theirs.helped);
      if (theirs.wrong) entry.wrong = newest(entry.wrong, theirs.wrong);
      if (theirs.not_needed) entry.notNeeded = [...entry.notNeeded, ...theirs.not_needed].sort().reverse();
      judged.set(id, entry);
    }
  }
  return judged;
}

/**
 * The roll-up of this machine, as it is now: the last activity and the verdicts in the log. The
 * last activity never goes back, so a note keeps it after its month left the log.
 */
function buildRollUp(store: Store, before: Map<string, NoteRollUp>): Map<string, NoteRollUp> {
  const notes = new Map<string, NoteRollUp>();
  const of = (id: string): NoteRollUp => {
    if (!notes.has(id)) notes.set(id, {});
    return notes.get(id)!;
  };
  for (const [id, was] of before) if (was.last) of(id).last = was.last;
  for (const [id, t] of logActivity(store)) of(id).last = newest(of(id).last, t);
  for (const [id, judged] of logJudgments(store)) {
    const entry = of(id);
    if (judged.helped) entry.helped = judged.helped;
    if (judged.wrong) entry.wrong = judged.wrong;
    if (judged.notNeeded.length > 0) entry.not_needed = judged.notNeeded.slice(0, NOT_NEEDED_SESSIONS);
  }
  return notes;
}

/** One line per note, in id order, so a commit of the file shows only the notes that changed. */
function rollUpText(notes: Map<string, NoteRollUp>): string {
  const rows = [...notes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, n]) => `${JSON.stringify(id)}: ${JSON.stringify({ last: n.last, helped: n.helped, wrong: n.wrong, not_needed: n.not_needed })}`);
  return `{\n"v": 1,\n"notes": {\n${rows.join(",\n")}\n}\n}\n`;
}

/**
 * The daily care of the log, at most once per day: write the roll-up of this machine to
 * activity/<machine>.json, when it changed, and remove the monthly files older than LOG_MONTHS.
 * Each machine writes only its own file, so two machines never change the same one. Nothing is
 * committed here: a command that writes a note calls this before its commit, and so does a sync.
 * A read never calls it. It never throws. Returns true when the roll-up file changed.
 */
export function rollUp(store: Store, now: Date = new Date()): boolean {
  try {
    // No log: nothing to roll up and nothing to remove. A store with no log gets no file.
    if (!store.exists() || logFiles(store).length === 0) return false;
    const day = stamp(now).slice(0, 10);
    const mark = join(logDir(store), "rolled-up");
    try {
      if (readFileSync(mark, "utf8").trim() === day) return false;
    } catch {
      // no mark yet
    }

    let changed = false;
    const machine = store.machine();
    if (SAFE_MACHINE.test(machine)) {
      const path = join(rollUpDir(store), `${machine}.json`);
      const before = readRollUp(path);
      const notes = buildRollUp(store, before);
      const next = rollUpText(notes);
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        // no roll-up yet
      }
      if (next !== current && (notes.size > 0 || current)) {
        writeAtomic(path, next);
        changed = true;
      }
    }
    // The day is done only now. A roll-up that failed above left no mark, so the next write tries
    // again, and no month is removed before its last activity is in the roll-up.
    writeAtomic(mark, `${day}\n`);

    // The roll-up is written first, so the last activity in a month that goes now is kept. A file
    // that cannot be removed waits for the next day: the roll-up of this day still counts.
    const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - LOG_MONTHS, 1)).toISOString().slice(0, 7);
    try {
      for (const name of logFiles(store)) if (name.slice(0, 7) < oldest) rmSync(join(logDir(store), name), { force: true });
    } catch {
      // the next day removes it
    }
    return changed;
  } catch {
    return false;
  }
}

// ---- last activity over all machines ----

/**
 * The last activity of each note on any machine: the newest of a `kb show` for a task, a fire and
 * a verdict "helped" in the log of this machine, the roll-up of each machine, and the `last_used`
 * that kb recorded in usage/ before it had a log. A note with no activity is not in the map. The
 * ranking and `kb stale` both read it here.
 */
export function lastActivity(store: Store): Map<string, string> {
  const last = new Map<string, string>();
  const take = (id: string, t: string) => {
    if (t > (last.get(id) ?? "")) last.set(id, t);
  };
  for (const [id, legacy] of store.usage()) if (legacy.last_used) take(id, legacy.last_used);
  for (const { notes } of rollUps(store)) for (const [id, entry] of notes) if (entry.last) take(id, entry.last);
  try {
    for (const [id, t] of logActivity(store)) take(id, t);
  } catch {
    // a log that cannot be read ranks the notes by what the roll-ups say
  }
  return last;
}

/**
 * The ids that have a history on any machine: an event of any kind in the log of this machine,
 * activity or a verdict in a roll-up, or counters of an older kb. A verdict "wrong", a check and a
 * session start are a history too, and none of them is in the roll-up of this machine before the
 * next day. `kb add` gives none of these ids to a new note, so a new note never takes the history
 * of a deleted one.
 */
export function idsWithHistory(store: Store): Set<string> {
  const ids = new Set<string>([...store.usage().keys(), ...lastActivity(store).keys()]);
  for (const { notes } of rollUps(store)) for (const id of notes.keys()) ids.add(id);
  try {
    for (const event of scanLog(store, "") as Raw[]) {
      const note = text(event.note);
      if (note) ids.add(note);
      // A session start names its notes by the form the session got.
      for (const form of ["bodies", "index", "hidden", "briefs"]) for (const id of texts(event[form])) ids.add(id);
    }
  } catch {
    // a log that cannot be read leaves the ids that the roll-ups name
  }
  return ids;
}
