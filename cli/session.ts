// Session marks: which sessions saved their knowledge, and which ended without doing so.
// Per-machine state in .state/, never committed. One small file per session, so sessions never race.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { type Store, writeAtomic } from "./store.ts";

const KEEP_MS = 7 * 86_400_000;

export interface UnsavedSession {
  session: string;
  transcript: string;
  cwd: string;
  ended: string;
  /** How much the session said, measured once by the next session start. */
  size?: { prompts: number; chars: number };
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
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
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

/** Remove what is older than the marks live. */
function dropOld(dir: string, names: string[]): void {
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
    } catch {
      // gone already
    }
  }
}

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
    dropOld(recover, readdirSync(recover));
  } catch {
    // no recovery ran on this machine
  }
  const found: UnsavedSession[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      // Old marks have no value: the transcript is gone or nobody will ask for it.
      if ((name.startsWith("unsaved-") || name.startsWith("saved-")) && Date.now() - statSync(path).mtimeMs > KEEP_MS) {
        rmSync(path, { force: true });
        continue;
      }
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
