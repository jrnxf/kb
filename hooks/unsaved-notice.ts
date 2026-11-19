// The SessionStart lines about sessions that ended with no checkpoint, and the measure that says
// which of them are worth a recovery. Kept out of session-start.ts, so that file only gathers the notices.

import { statSync } from "node:fs";
import { type SessionSize, type UnsavedSession, allUnsaved, endedHere, firstToday, forgetUnsaved, recordSize } from "../cli/session.ts";
import type { Store } from "../cli/store.ts";
import { worthRecovering } from "./transcript.ts";

/**
 * A session under this floor has nothing to recover. The reader counts no slash command without
 * arguments and no /kb:recover turn, so a session that only cleared, or only recovered another
 * session, is under it. An autonomous run has one prompt and learns from its errors, so three
 * failed tool calls are enough with any number of prompts.
 */
const MIN_PROMPTS = 2;
const MIN_CHARS = 3000;
export const MIN_FAILED = 3;
const worth = (size: SessionSize) => (size.prompts >= MIN_PROMPTS && size.chars >= MIN_CHARS) || (size.failed ?? 0) >= MIN_FAILED;

/**
 * A transcript above this size is worth recovering, and no session start reads it. A long session
 * reaches 30 MB and more, and the hook that reads it is killed with no notes for the session.
 */
export const PARSE_LIMIT = 2 * 1024 * 1024;
/** The time the whole step may take. The SessionStart hook has 5 seconds for all its work. */
export const BUDGET_MS = 300;
/** Sessions in other directories get a line from this count on. Fewer are not worth a sentence in every project. */
export const ELSEWHERE_FLOOR = 5;
/** The name under which the line about other directories is claimed, once per day on this machine. */
const ELSEWHERE = "kb: sessions in other directories";

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
 * Measure the sessions that have no size yet, while there is time, and forget the short ones.
 * Returns how many are known to be worth a recovery, and how many it forgot.
 */
export function settle(store: Store, entries: UnsavedSession[], inTime: () => boolean): { worth: number; forgotten: number } {
  const result = { worth: 0, forgotten: 0 };
  for (const entry of entries) {
    try {
      const known = worthIt(store, entry, inTime);
      if (known) result.worth++;
      // A short session is forgotten: it has nothing to save.
      else if (known === false && forgetUnsaved(store, entry.session)) result.forgotten++;
    } catch {
      // one mark that cannot be handled does not stop the others
    }
  }
  return result;
}

/**
 * At most two lines, or null: one for the sessions of this directory or checkout that /kb:recover
 * can save, and one for the sessions of other directories.
 *
 * The first comes at each new start until /kb:recover saves them or the user forgets them. It asks
 * the agent to tell the user once per day and checkout: a script or a second window that starts
 * many sessions must not get the same sentence in each.
 *
 * The second comes at most once per day on this machine, only when `attended` says that a person
 * reads the first reply, and only from `ELSEWHERE_FLOOR` sessions on.
 *
 * Never throws, and never takes much longer than `BUDGET_MS`. The sessions here are measured
 * first, and the others get the time that is left. The clock and the day are arguments for the tests.
 */
export function unsavedNotice(store: Store, cwd: string, root: string | null, now: () => number = () => performance.now(), today = new Date(), attended = false): string | null {
  try {
    const start = now();
    const inTime = () => now() - start < BUDGET_MS;
    const all = allUnsaved(store);
    const here = endedHere(cwd, root);
    const lost = settle(store, all.filter(here), inTime).worth;
    const elsewhere = settle(store, all.filter((entry) => !here(entry)), inTime).worth;
    const lines: string[] = [];
    if (lost > 0) {
      const one = lost === 1;
      const what = one ? "An earlier session here" : `${lost} earlier sessions here`;
      lines.push(
        firstToday(store, root ?? cwd, today)
          ? `${what} ended with no /kb:checkpoint. Tell the user in one line, in your first reply, that /kb:recover saves ${one ? "its" : "their"} knowledge or forgets ${one ? "it" : "them"}.`
          : `${what} ${one ? "has" : "have"} unsaved knowledge. The user can run /kb:recover.`,
      );
    }
    if (attended && elsewhere >= ELSEWHERE_FLOOR && firstToday(store, ELSEWHERE, today)) {
      lines.push(`${elsewhere} sessions in other directories ended with no /kb:checkpoint. Tell the user in one line, in your first reply, that /kb:recover all saves their knowledge.`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    // A store that cannot be read or written gives no line. The session still gets its notes.
    return null;
  }
}
