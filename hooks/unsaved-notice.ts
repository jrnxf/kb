// The SessionStart line about sessions that ended with /clear and no checkpoint.
// Kept out of session-start.ts, so that file only gathers the notices.

import { statSync } from "node:fs";
import { type UnsavedSession, firstToday, forgetUnsaved, recordSize, unsavedSessions } from "../cli/session.ts";
import type { Store } from "../cli/store.ts";
import { worthRecovering } from "./transcript.ts";

/**
 * A session shorter than this has nothing to recover. One prompt is mostly a headless run.
 * The reader counts no slash command without arguments and no /kb:recover turn, so a session that
 * only cleared, or only recovered another session, is under the floor.
 */
const MIN_PROMPTS = 2;
const MIN_CHARS = 3000;
const worth = (size: { prompts: number; chars: number }) => size.prompts >= MIN_PROMPTS && size.chars >= MIN_CHARS;

/**
 * A transcript above this size is worth recovering, and no session start reads it. A long session
 * reaches 30 MB and more, and the hook that reads it is killed with no notes for the session.
 */
export const PARSE_LIMIT = 2 * 1024 * 1024;
/** The time the whole step may take. The SessionStart hook has 5 seconds for all its work. */
export const BUDGET_MS = 300;

/** If a session is worth recovering, or null when this start cannot say. */
function worthIt(store: Store, entry: UnsavedSession, inTime: () => boolean): boolean | null {
  // Measured once, then kept in the mark.
  if (entry.size) return worth(entry.size);
  let bytes: number;
  try {
    bytes = statSync(entry.transcript).size;
  } catch {
    return null;
  }
  if (bytes > PARSE_LIMIT) return true;
  // Out of time: the mark stays as it is, and a later start measures it.
  if (!inTime()) return null;
  const size = worthRecovering(entry.transcript);
  // The transcript is there and this read failed. Keep the mark: a later start measures it.
  if (!size) return null;
  if (worth(size)) recordSize(store, entry.session, size);
  return worth(size);
}

/**
 * One line for the sessions of this directory or checkout that /kb:recover can save, or null.
 * It comes at each new start until /kb:recover saves them or the user forgets them. It asks the
 * agent to tell the user once per day and checkout: a script or a second window that starts many
 * sessions must not get the same sentence in each. Never throws, and never takes much longer
 * than `BUDGET_MS`. The clock and the day are arguments for the tests.
 */
export function unsavedNotice(store: Store, cwd: string, root: string | null, now: () => number = () => performance.now(), today = new Date()): string | null {
  try {
    const start = now();
    const inTime = () => now() - start < BUDGET_MS;
    let lost = 0;
    for (const entry of unsavedSessions(store, cwd, root)) {
      try {
        const known = worthIt(store, entry, inTime);
        if (known) lost++;
        // A short session is forgotten: it has nothing to save.
        else if (known === false) forgetUnsaved(store, entry.session);
      } catch {
        // one mark that cannot be handled does not stop the others
      }
    }
    if (lost === 0) return null;
    const one = lost === 1;
    const what = one ? "An earlier session here" : `${lost} earlier sessions here`;
    if (!firstToday(store, root ?? cwd, today)) return `${what} ${one ? "has" : "have"} unsaved knowledge. The user can run /kb:recover.`;
    return `${what} ended with /clear before /kb:checkpoint ran. Tell the user in one line, in your first reply, that /kb:recover saves ${one ? "its" : "their"} knowledge or forgets ${one ? "it" : "them"}.`;
  } catch {
    // A store that cannot be read or written gives no line. The session still gets its notes.
    return null;
  }
}
