// The SessionStart line about sessions that ended with /clear and no checkpoint.
// Kept out of session-start.ts, so that file only gathers the notices.

import { forgetUnsaved, recordUnsaved, unsavedSessions } from "../cli/session.ts";
import type { Store } from "../cli/store.ts";
import { worthRecovering } from "./transcript.ts";

/**
 * A session shorter than this has nothing to recover. One prompt is mostly a headless run.
 * The reader counts no slash command and no /kb:recover turn, so a session that only cleared, or
 * only recovered another session, is under the floor.
 */
const MIN_PROMPTS = 2;
const MIN_CHARS = 3000;
const worth = (size: { prompts: number; chars: number }) => size.prompts >= MIN_PROMPTS && size.chars >= MIN_CHARS;

/**
 * One line for the sessions of this directory or checkout that /kb:recover can save, or null.
 * It comes at each new start until /kb:recover saves them or the user forgets them.
 */
export function unsavedNotice(store: Store, cwd: string, root: string | null): string | null {
  const lost = unsavedSessions(store, cwd, root).filter((entry) => {
    // Measured once, then kept in the mark. Write only a new size: a write resets the 7-day clock of the mark.
    if (!entry.size) {
      const size = worthRecovering(entry.transcript);
      // The transcript is there and this read failed. Keep the mark: a later start measures it.
      if (!size) return false;
      entry.size = size;
      if (worth(size)) recordUnsaved(store, entry);
    }
    if (worth(entry.size)) return true;
    // A short session is forgotten: it has nothing to save.
    forgetUnsaved(store, entry.session);
    return false;
  });
  if (lost.length === 0) return null;
  const one = lost.length === 1;
  const what = one ? "An earlier session here" : `${lost.length} earlier sessions here`;
  return `${what} ended with /clear before /kb:checkpoint ran. Tell the user in one line, in your first reply, that /kb:recover saves ${one ? "its" : "their"} knowledge or forgets ${one ? "it" : "them"}.`;
}
