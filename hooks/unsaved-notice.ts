// The SessionStart line about sessions that ended with /clear and no checkpoint.
// Kept out of session-start.ts, so that file only gathers the notices.

import { forgetUnsaved, recordUnsaved, unsavedSessions } from "../cli/session.ts";
import type { Store } from "../cli/store.ts";
import { worthRecovering } from "./transcript.ts";

/** A session shorter than this has nothing to recover. One prompt is mostly a headless run. */
const MIN_PROMPTS = 2;
const MIN_CHARS = 3000;

/**
 * One line for the sessions of this directory or checkout that /kb:recover can save, or null.
 * It comes at each new start until /kb:recover saves them or the user forgets them.
 */
export function unsavedNotice(store: Store, cwd: string, root: string | null): string | null {
  const lost = unsavedSessions(store, cwd, root).filter((entry) => {
    // Measured once, then kept in the mark. A short session is forgotten: it has nothing to save.
    // Write only a new size: a write resets the 7-day clock of the mark.
    const measured = !entry.size;
    entry.size ??= worthRecovering(entry.transcript);
    if (entry.size.prompts >= MIN_PROMPTS && entry.size.chars >= MIN_CHARS) {
      if (measured) recordUnsaved(store, entry);
      return true;
    }
    forgetUnsaved(store, entry.session);
    return false;
  });
  if (lost.length === 0) return null;
  const one = lost.length === 1;
  const what = one ? "An earlier session here" : `${lost.length} earlier sessions here`;
  return `${what} ended with /clear before /kb:checkpoint ran. Tell the user in one line, in your first reply, that /kb:recover saves ${one ? "its" : "their"} knowledge or forgets ${one ? "it" : "them"}.`;
}
