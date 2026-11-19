// The event log: what each session was shown, what it opened, and what came of it. One JSON object
// per line in .state/log/<YYYY-MM>.jsonl. Per machine, never committed and never synced, so a read
// of a note is no longer a write to the store. The audit reads the log through `kb log`.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Store, writeAtomic } from "./store.ts";

export const VERDICTS = ["helped", "not-needed", "wrong"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** task: the agent needed the note for its work. check: bookkeeping, such as an audit or a search before a write. */
export type Why = "task" | "check";

export type WriteOp = "add" | "update" | "trash" | "restore" | "delete" | "verify";

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

/** A note that a trigger loaded. Today only a Read of an anchored file, which gives the title. */
export interface FireEvent {
  ev: "fire";
  kind: "path";
  form: "title";
  note: string;
  tool: string;
  /** What matched: for a path, the repo-relative path of the file. */
  match: string;
}

export type LogEvent = Who &
  (
    | StartEvent
    | FireEvent
    | { ev: "show"; note: string; why: Why }
    | { ev: "search"; query: string; hits: number; why: Why }
    | { ev: "write"; note: string; op: WriteOp }
    | { ev: "verdict"; note: string; verdict: Verdict }
    | { ev: "checkpoint" }
    | { ev: "unsaved"; reason?: string }
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
 * The session a command belongs to: the --session flag, else KB_SESSION. The launcher in bin/ sets
 * KB_SESSION from the harness, so the CLI needs no harness name.
 */
export function sessionOf(flag: unknown, env: Record<string, string | undefined> = process.env): string | undefined {
  return logId(flag) ?? logId(env.KB_SESSION);
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

/** The events in time order. A line that does not parse is skipped. */
export function readLog(store: Store, filter: { since?: Date; session?: string } = {}): Logged[] {
  const from = filter.since ? stamp(filter.since) : "";
  const events: Logged[] = [];
  for (const name of logFiles(store)) {
    if (name.slice(0, 7) < from.slice(0, 7)) continue;
    let text: string;
    try {
      text = readFileSync(join(logDir(store), name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const event = parseLine(line);
      if (!event || event.t < from) continue;
      if (filter.session !== undefined && event.session !== filter.session) continue;
      events.push(event);
    }
  }
  // Each file is in the order of the appends. The sort is stable, so it only mends a clock that went back.
  return events.sort((a, b) => a.t.localeCompare(b.t));
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
  /** Times a trigger loaded the note, such as a Read of a file it is anchored to. */
  fired: number;
  /** One verdict per session and note: the last one counts. */
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
  unsaved: number;
  /** Every note the events name, by id. */
  notes: NoteLog[];
}

export const emptyNoteLog = (id: string): NoteLog => ({ id, body: 0, index: 0, hidden: 0, opened: { task: 0, check: 0 }, fired: 0, verdicts: { helped: 0, "not-needed": 0, wrong: 0 } });

const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);
const isWhy = (value: unknown): value is Why => value === "task" || value === "check";

export function summarize(events: Logged[]): LogSummary {
  const notes = new Map<string, NoteLog>();
  const of = (id: unknown): NoteLog | null => {
    if (typeof id !== "string" || !id) return null;
    if (!notes.has(id)) notes.set(id, emptyNoteLog(id));
    return notes.get(id)!;
  };
  const summary: LogSummary = { from: events[0]?.t ?? null, to: events.at(-1)?.t ?? null, events: events.length, sessions: 0, starts: 0, searches: { task: 0, check: 0 }, checkpoints: 0, unsaved: 0, notes: [] };
  const sessions = new Set<string>();
  // A session that gives its verdicts twice, or corrects one, still judged each note once.
  const verdicts = new Map<string, { note: string; verdict: Verdict }>();
  // The fields are read as unknown: a later kb, or a hand edit, may have written another shape.
  for (const [i, event] of (events as (Who & { t: string; ev: string } & Record<string, unknown>)[]).entries()) {
    if (event.session) sessions.add(event.session);
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
      case "verdict": {
        const note = of(event.note);
        if (note && VERDICTS.includes(event.verdict as Verdict)) verdicts.set(event.session ? `${event.session}\n${event.agent ?? ""}\n${note.id}` : `\n${i}`, { note: note.id, verdict: event.verdict as Verdict });
        break;
      }
      case "search":
        if (isWhy(event.why)) summary.searches[event.why]++;
        break;
      case "checkpoint":
        summary.checkpoints++;
        break;
      case "unsaved":
        summary.unsaved++;
        break;
      case "write":
        // A note that only a write names still gets a row, so a new note is in the summary.
        of(event.note);
        break;
    }
  }
  for (const { note, verdict } of verdicts.values()) notes.get(note)!.verdicts[verdict]++;
  summary.sessions = sessions.size;
  summary.notes = [...notes.values()].sort((a, b) => a.id.localeCompare(b.id));
  return summary;
}

// ---- last activity ----

/** The note of an event that shows the note was of use: a show for a task, a fire, or a verdict "helped". */
function activeNote(event: Logged): string | null {
  const e = event as { ev: string; note?: unknown; why?: unknown; verdict?: unknown };
  if (typeof e.note !== "string" || !e.note) return null;
  return (e.ev === "show" && e.why === "task") || e.ev === "fire" || (e.ev === "verdict" && e.verdict === "helped") ? e.note : null;
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

/**
 * The last activity of each note on this machine: the newest of a `kb show` for a task, a fire, a
 * verdict "helped", and the `last_used` that kb recorded in usage/ before it had a log. A note
 * with no activity is not in the map. The ranking and `kb stale` both read it here.
 */
export function lastActivity(store: Store): Map<string, string> {
  const last = new Map<string, string>();
  const take = (id: string, t: string) => {
    if (t > (last.get(id) ?? "")) last.set(id, t);
  };
  for (const [id, legacy] of store.usage()) if (legacy.last_used) take(id, legacy.last_used);
  try {
    for (const [id, t] of logActivity(store)) take(id, t);
  } catch {
    // a log that cannot be read ranks the notes as if nobody opened them
  }
  return last;
}
