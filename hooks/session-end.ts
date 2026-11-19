// SessionEnd hook for /clear. Nothing can run before /clear, so this records a session that
// ended with no checkpoint. Each new SessionStart in the same checkout then says that /kb:recover saves it.
// SessionEnd has a 1.5 second limit and its output is discarded, so this does one small write,
// and one line in the event log.

import { hookWho, logEvent } from "../cli/log.ts";
import { isSaved, recordUnsaved } from "../cli/session.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text());
  const store = new Store();
  if (
    input?.reason === "clear" &&
    // A subagent has no /clear. Its transcript is not a session to recover.
    !input.agent_id &&
    typeof input.session_id === "string" &&
    typeof input.transcript_path === "string" &&
    typeof input.cwd === "string" &&
    store.exists() &&
    !isSaved(store, input.session_id)
  ) {
    recordUnsaved(store, { session: input.session_id, transcript: input.transcript_path, cwd: input.cwd, ended: new Date().toISOString() });
    logEvent(store, { ev: "unsaved", ...hookWho(input), reason: input.reason });
  }
} catch {
  // silent on purpose
}
process.exit(0);
