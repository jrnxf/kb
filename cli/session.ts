// Session marks: which sessions saved their knowledge, and which ended without doing so.
// Per-machine state in .state/, never committed. One small file per session, so sessions never race.

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
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

export function markSaved(store: Store, session: string): void {
  store.ensure(); // keeps .state/ out of git in a store made by an older version
  writeAtomic(store.statePath(`saved-${safe(session)}`), `${new Date().toISOString()}\n`);
  rmSync(store.statePath(`unsaved-${safe(session)}.json`), { force: true });
}

export function isSaved(store: Store, session: string): boolean {
  return existsSync(store.statePath(`saved-${safe(session)}`));
}

export function recordUnsaved(store: Store, entry: UnsavedSession): void {
  store.ensure();
  writeAtomic(store.statePath(`unsaved-${safe(entry.session)}.json`), JSON.stringify(entry));
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Stop reporting an unsaved session: it holds nothing worth a note. */
export function forgetUnsaved(store: Store, session: string): boolean {
  const path = store.statePath(`unsaved-${safe(session)}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * The unsaved sessions of a directory. Each stays until /kb:recover saves it or the user forgets
 * it, or for 7 days. With `root`, the root of the repo around `cwd`, a session that ended anywhere
 * in that checkout counts: a session can end in a subdirectory and the next one start at the root.
 * A session whose transcript is gone is forgotten, as nothing can recover it.
 */
export function unsavedSessions(store: Store, cwd: string, root: string | null = null): UnsavedSession[] {
  const top = root && real(root);
  const here = (ended: string) => ended === cwd || (top !== null && (real(ended) === top || real(ended).startsWith(top + sep)));
  const dir = store.statePath("");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
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
      if (!existsSync(entry.transcript)) rmSync(path, { force: true });
      else if (here(entry.cwd)) found.push(entry);
    } catch {
      // a broken mark is not worth a failure
    }
  }
  return found.sort((a, b) => a.ended.localeCompare(b.ended));
}
