// Session marks: which sessions saved their knowledge, and which ended without doing so.
// Per-machine state in .state/, never committed. One small file per session, so sessions never race.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, ftruncateSync, futimesSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { type ForgetWhy, type LogEvent, logEvent } from "./log.ts";
import { type Store, writeAtomic } from "./store.ts";

const KEEP_MS = 7 * 86_400_000;

/** How much a session holds: what was said, and the tool calls that failed. */
export interface SessionSize {
  prompts: number;
  chars: number;
  /** Not in a mark that an older kb measured. */
  failed?: number;
}

export interface UnsavedSession {
  session: string;
  transcript: string;
  cwd: string;
  ended: string;
  /** Why the session ended, in the word of the harness: clear, other, and so on. */
  reason?: string;
  /**
   * The repo id of `cwd` when the session ended, or null outside any repo. The mark keeps it,
   * because the directory of a finished run is often deleted later. A mark of an older kb, and a
   * session whose directory was gone when it ended, have none.
   */
  scope?: string | null;
  /** The root of the checkout around `cwd` at that time, or null outside any repo. */
  root?: string | null;
  /**
   * The main checkout of that repo. For a session in a linked worktree it is another folder than
   * `root`, and it is still there when the worktree of a finished run is deleted.
   */
  main?: string | null;
  /** Measured once by a later session start. */
  size?: SessionSize;
  /** The log has the `unsaved` line of this session: a measure found it worth a recovery. */
  logged?: true;
  /** The notes that a recovery of this session wrote: `kb add --recovered-from`. */
  notes?: string[];
  /**
   * The session saved its knowledge at this time, and the user typed more after it. Only the
   * part after it is unsaved, so a measure and a recovery read only that part.
   */
  since?: string;
  /** The byte in the transcript where the part after `since` starts, when the end found it. */
  offset?: number;
}

const safe = (session: string) => session.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);

/** Where /kb:recover keeps what a session said, until the session is marked or forgotten. */
const recoverPath = (store: Store, session: string) => store.statePath(join("recover", `${safe(session)}.md`));

/**
 * Write what a session said for /kb:recover, and return the path. The user's own words can hold
 * a secret, so only the user can read the file and its folder.
 */
export function writeRecoverFile(store: Store, session: string, text: string): string {
  const path = recoverPath(store, session);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700); // the folder can be older than this rule
  writeAtomic(path, text, 0o600);
  return path;
}

const markPath = (store: Store, session: string) => store.statePath(`unsaved-${safe(session)}.json`);
/** The mark of a session that ended and runs again. It is no unsaved session while it runs. */
const livePath = (store: Store, session: string) => store.statePath(`live-${safe(session)}.json`);

function readMark(path: string): UnsavedSession | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UnsavedSession;
  } catch {
    return null;
  }
}

export function markSaved(store: Store, session: string): void {
  store.ensure(); // keeps .state/ out of git in a store made by an older version
  writeAtomic(store.statePath(`saved-${safe(session)}`), `${new Date().toISOString()}\n`);
  rmSync(markPath(store, session), { force: true });
  rmSync(livePath(store, session), { force: true });
  rmSync(recoverPath(store, session), { force: true });
}

export function isSaved(store: Store, session: string): boolean {
  return existsSync(store.statePath(`saved-${safe(session)}`));
}

/** When the session last saved its knowledge, or null. A record with no time it can read says "". */
export function savedAt(store: Store, session: string): string | null {
  try {
    return readFileSync(store.statePath(`saved-${safe(session)}`), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * The session saved its knowledge, and the user typed more after it: the record that it is saved
 * goes. The end writes the new mark first, so a hook that is killed in between loses nothing.
 */
export function unsave(store: Store, session: string): void {
  rmSync(store.statePath(`saved-${safe(session)}`), { force: true });
}

/**
 * Record a session that ended with no checkpoint. A session can end twice: it ends, the user
 * resumes it, and it ends again. The new mark keeps the notes that a recovery wrote in between,
 * the word that the log has its `unsaved` line, and the time of a checkpoint that came before. It loses the size, which is measured again.
 */
export function recordUnsaved(store: Store, entry: UnsavedSession): void {
  store.ensure();
  const before = unsavedSession(store, entry.session) ?? readMark(livePath(store, entry.session));
  const notes = entry.notes ?? before?.notes;
  const logged = entry.logged ?? before?.logged;
  // A session that saved, went on, ended and was resumed: what it saved is still saved.
  const since = entry.since ?? before?.since;
  const offset = entry.since ? entry.offset : before?.offset;
  writeAtomic(markPath(store, entry.session), JSON.stringify({ ...entry, ...(notes ? { notes } : {}), ...(logged ? { logged } : {}), ...(since ? { since } : {}), ...(since && offset !== undefined ? { offset } : {}) }));
  rmSync(livePath(store, entry.session), { force: true });
}

/** The mark of one unsaved session, or null. */
export function unsavedSession(store: Store, session: string): UnsavedSession | null {
  return readMark(markPath(store, session));
}

/**
 * A session that ended with no checkpoint runs again: the user resumed it. Its mark is set aside,
 * so no other session recovers it while it works. Its next end makes a new mark from it. Returns
 * true when there was a mark. Never throws.
 */
export function reopenSession(store: Store, session: string): boolean {
  try {
    // What a recovery read is older than what the session says from now on.
    rmSync(recoverPath(store, session), { force: true });
    renameSync(markPath(store, session), livePath(store, session));
    return true;
  } catch {
    return false; // no mark, or the store is read-only
  }
}

/** True for a session that ended with no checkpoint and runs again now. */
export function isLive(store: Store, session: string): boolean {
  return existsSync(livePath(store, session));
}

/**
 * Change the mark of an unsaved session, and say if it was written. The mark is written in place,
 * and only while it exists: a write to a new file would bring back a mark that `kb saved`
 * or a forget removed a moment ago. The mark keeps its age, so it still goes 7 days after the
 * session ended. Never throws: a store that cannot be written changes nothing.
 */
function changeMark(store: Store, session: string, change: (mark: UnsavedSession) => void): boolean {
  if (isSaved(store, session)) return false;
  let file: number;
  try {
    file = openSync(markPath(store, session), "r+");
  } catch {
    return false; // gone, or the store is read-only
  }
  try {
    const { atime, mtime } = fstatSync(file);
    const mark = JSON.parse(readFileSync(file, "utf8")) as UnsavedSession;
    change(mark);
    const text = Buffer.from(JSON.stringify(mark));
    // One write from the first byte, then the cut: a reader never sees an empty mark.
    writeSync(file, text, 0, text.length, 0);
    ftruncateSync(file, text.length);
    futimesSync(file, atime, mtime);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(file);
  }
}

/** The scope of a mark for the log. A mark with no scope names none. */
const scopeOf = (mark: UnsavedSession) => (mark.scope !== undefined ? { scope: mark.scope ?? "global" } : {});

/**
 * Record in its mark that a measure found the session worth a recovery, with the size when it was
 * measured, so no later start reads the transcript again. With no size, the transcript is too
 * large to measure, and the line says so. Says if the mark was written.
 * The log gets one `unsaved` line per session: the first time only, and only when the mark took
 * the word, so a store that cannot be written does not log the session at every start.
 */
export function recordWorth(store: Store, session: string, size?: SessionSize): boolean {
  let line: LogEvent | null = null;
  const written = changeMark(store, session, (mark) => {
    if (size) mark.size = size;
    if (!mark.logged) line = { ev: "unsaved", session, ...scopeOf(mark), ...(mark.reason ? { reason: mark.reason } : {}), ...(size ? { prompts: size.prompts, failed: size.failed ?? 0 } : { large: true as const }) };
    mark.logged = true;
  });
  if (written && line) logEvent(store, line);
  return written;
}

/**
 * Add to the mark where the session ran: the repo id, the checkout and the main checkout. The end
 * of a session writes the mark first and reads these from git after, in the time that is left.
 */
export function recordPlace(store: Store, session: string, place: Pick<UnsavedSession, "scope" | "root" | "main">): boolean {
  return changeMark(store, session, (mark) => Object.assign(mark, place));
}

/** Record that a recovery of this session wrote a note, so a second recovery does not add it again. */
export function recordRecovered(store: Store, session: string, id: string): boolean {
  return changeMark(store, session, (mark) => {
    mark.notes = [...new Set([...(mark.notes ?? []), id])];
  });
}

/** The file that claims one day (local time) for a directory or a fixed name, on this machine. */
function claimPath(store: Store, dir: string, now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const key = createHash("sha256").update(real(dir)).digest("hex").slice(0, 16);
  return store.statePath(`told-${key}-${day}`);
}

/**
 * True once per day (local time) for a directory or a fixed name, on this machine. The claim is a file made with
 * "wx", so of two sessions that start together only one gets it. False when it cannot be recorded.
 */
export function firstToday(store: Store, dir: string, now = new Date()): boolean {
  try {
    writeFileSync(claimPath(store, dir, now), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** True when `firstToday` gave the day away already. It takes nothing, so a caller can look before it does work. */
export function claimedToday(store: Store, dir: string, now = new Date()): boolean {
  return existsSync(claimPath(store, dir, now));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A file that is not there. A file that only cannot be read now (no permission) is not gone. */
function gone(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** True for a file that is older than the marks live, and for one that is gone. */
function old(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > KEEP_MS;
  } catch {
    return true;
  }
}

/** Remove a file that is older than the marks live, and say if it is gone. */
function dropOld(path: string): boolean {
  if (!old(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** The files that hold state of a session or of a day, which lose their value with age. */
const AGES = /^(unsaved|live|saved|told)-/;

/**
 * Drop the mark of an unsaved session, and say in the log why: it is short, the user said so, it
 * aged out, or its transcript is gone. `by` is the session that asked. The line says if the
 * session was worth a recovery, so an audit can count what was lost. False when there was no mark.
 */
export function forgetUnsaved(store: Store, session: string, why: ForgetWhy, by?: string): boolean {
  rmSync(recoverPath(store, session), { force: true });
  const path = markPath(store, session);
  if (!existsSync(path)) return false;
  // A broken mark is dropped too. Its line has the session and the reason only.
  const mark = readMark(path);
  rmSync(path, { force: true });
  logEvent(store, { ev: "forgotten", session, ...(mark ? scopeOf(mark) : {}), why, ...(mark?.logged ? { worth: true as const } : {}), ...(by ? { by } : {}) });
  return true;
}

/** A directory that is there now. */
export function isDir(path: string | null | undefined): path is string {
  try {
    return typeof path === "string" && path !== "" && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The unsaved sessions of every directory on this machine, the oldest first. Each stays until
 * /kb:recover saves it or the user forgets it, or for 7 days. A session whose transcript is gone
 * is forgotten, as nothing can recover it. A transcript that is there and cannot be read now
 * keeps its session.
 */
export function allUnsaved(store: Store): UnsavedSession[] {
  const dir = store.statePath("");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // What a session said can hold a secret, so a file that no recovery finished does not stay.
  const recover = store.statePath("recover");
  try {
    for (const name of readdirSync(recover)) dropOld(join(recover, name));
  } catch {
    // no recovery ran on this machine
  }
  const found: UnsavedSession[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!name.startsWith("unsaved-")) {
        if (AGES.test(name)) dropOld(path);
        continue;
      }
      const entry = readMark(path);
      // A broken mark names no session. It only ages out.
      if (!entry) {
        dropOld(path);
        continue;
      }
      // An old mark has no value: nobody will ask for it. With no transcript, nothing can recover it.
      const why = old(path) ? "aged" : gone(entry.transcript) ? "gone" : null;
      if (!why) found.push(entry);
      // A mark under a name that its session does not give is removed with no line.
      else if (!forgetUnsaved(store, entry.session, why)) rmSync(path, { force: true });
    } catch {
      // a broken mark is not worth a failure
    }
  }
  return found.sort((a, b) => a.ended.localeCompare(b.ended));
}

/**
 * Says if a session ended in a directory or in the checkout around it. With `root`, the root of
 * the repo around `cwd`, a session that ended anywhere in that checkout counts: a session can end
 * in a subdirectory and the next one start at the root.
 */
export function endedHere(cwd: string, root: string | null = null): (entry: UnsavedSession) => boolean {
  const top = root && real(root);
  // Compare real paths: the hook gets the directory from Claude Code, the CLI from the shell, and
  // one of them can go through a link (/tmp on macOS).
  const self = real(cwd);
  return (entry) => {
    const ended = real(entry.cwd);
    return ended === self || (top !== null && (ended === top || ended.startsWith(top + sep)));
  };
}

/** The unsaved sessions of a directory or of the checkout around it, the oldest first. */
export function unsavedSessions(store: Store, cwd: string, root: string | null = null): UnsavedSession[] {
  return allUnsaved(store).filter(endedHere(cwd, root));
}
