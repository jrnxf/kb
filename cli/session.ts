// Session marks: which sessions saved their knowledge, and which ended without doing so.
// Per-machine state in .state/, never committed. One small file per session, so sessions never race.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, ftruncateSync, futimesSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { type Store, writeAtomic } from "./store.ts";

const KEEP_MS = 7 * 86_400_000;

export interface UnsavedSession {
  session: string;
  transcript: string;
  cwd: string;
  ended: string;
  /** How much the session said, measured once by a later session start. */
  size?: { prompts: number; chars: number };
  /** The notes that a recovery of this session wrote: `kb add --recovered-from`. */
  notes?: string[];
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

export function markSaved(store: Store, session: string): void {
  store.ensure(); // keeps .state/ out of git in a store made by an older version
  writeAtomic(store.statePath(`saved-${safe(session)}`), `${new Date().toISOString()}\n`);
  rmSync(store.statePath(`unsaved-${safe(session)}.json`), { force: true });
  rmSync(recoverPath(store, session), { force: true });
}

export function isSaved(store: Store, session: string): boolean {
  return existsSync(store.statePath(`saved-${safe(session)}`));
}

export function recordUnsaved(store: Store, entry: UnsavedSession): void {
  store.ensure();
  writeAtomic(store.statePath(`unsaved-${safe(entry.session)}.json`), JSON.stringify(entry));
}

/** The mark of one unsaved session, or null. */
export function unsavedSession(store: Store, session: string): UnsavedSession | null {
  try {
    return JSON.parse(readFileSync(store.statePath(`unsaved-${safe(session)}.json`), "utf8")) as UnsavedSession;
  } catch {
    return null;
  }
}

/**
 * Change the mark of an unsaved session, and say if it was written. The mark is written in place,
 * and only while it exists: a write to a new file would bring back a mark that `kb checkpointed`
 * or a forget removed a moment ago. The mark keeps its age, so it still goes 7 days after the
 * session ended. Never throws: a store that cannot be written changes nothing.
 */
function changeMark(store: Store, session: string, change: (mark: UnsavedSession) => void): boolean {
  if (isSaved(store, session)) return false;
  let file: number;
  try {
    file = openSync(store.statePath(`unsaved-${safe(session)}.json`), "r+");
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

/** Keep the measured size of an unsaved session in its mark, so no later start reads the transcript again. */
export function recordSize(store: Store, session: string, size: { prompts: number; chars: number }): boolean {
  return changeMark(store, session, (mark) => {
    mark.size = size;
  });
}

/** Record that a recovery of this session wrote a note, so a second recovery does not add it again. */
export function recordRecovered(store: Store, session: string, id: string): boolean {
  return changeMark(store, session, (mark) => {
    mark.notes = [...new Set([...(mark.notes ?? []), id])];
  });
}

/**
 * True once per day (local time) for a directory, on this machine. The claim is a file made with
 * "wx", so of two sessions that start together only one gets it. False when it cannot be recorded.
 */
export function firstToday(store: Store, dir: string, now = new Date()): boolean {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const key = createHash("sha256").update(real(dir)).digest("hex").slice(0, 16);
  try {
    writeFileSync(store.statePath(`told-${key}-${day}`), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
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

/** Remove a file that is older than the marks live, and say if it is gone. */
function dropOld(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs <= KEEP_MS) return false;
    rmSync(path, { force: true });
  } catch {
    // gone already
  }
  return true;
}

/** The files that hold state of a session or of a day, which lose their value with age. */
const AGES = /^(unsaved|saved|told)-/;

/** Stop reporting an unsaved session: it holds nothing worth a note. */
export function forgetUnsaved(store: Store, session: string): boolean {
  rmSync(recoverPath(store, session), { force: true });
  const path = store.statePath(`unsaved-${safe(session)}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * The unsaved sessions of a directory. Each stays until /kb:recover saves it or the user forgets
 * it, or for 7 days. With `root`, the root of the repo around `cwd`, a session that ended anywhere
 * in that checkout counts: a session can end in a subdirectory and the next one start at the root.
 * A session whose transcript is gone is forgotten, as nothing can recover it. A transcript that is
 * there and cannot be read now keeps its session.
 */
export function unsavedSessions(store: Store, cwd: string, root: string | null = null): UnsavedSession[] {
  const top = root && real(root);
  // Compare real paths: the hook gets the directory from Claude Code, the CLI from the shell, and
  // one of them can go through a link (/tmp on macOS).
  const self = real(cwd);
  const here = (ended: string) => real(ended) === self || (top !== null && (real(ended) === top || real(ended).startsWith(top + sep)));
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
      // Old marks have no value: the transcript is gone or nobody will ask for it.
      if (AGES.test(name) && dropOld(path)) continue;
      if (!name.startsWith("unsaved-")) continue;
      const entry = JSON.parse(readFileSync(path, "utf8")) as UnsavedSession;
      if (gone(entry.transcript)) {
        rmSync(path, { force: true });
        rmSync(recoverPath(store, entry.session), { force: true });
      }
      else if (here(entry.cwd)) found.push(entry);
    } catch {
      // a broken mark is not worth a failure
    }
  }
  return found.sort((a, b) => a.ended.localeCompare(b.ended));
}
