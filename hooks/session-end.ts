// SessionEnd hook, for every reason a session ends: /clear, an exit, a logout, a switch to another
// session, and the end of a headless run. Nothing can run before the end, so this records a session
// that ended with no checkpoint. A later SessionStart then says that /kb:recover saves it.
// SessionEnd has a 1.5 second limit and its output is discarded, so this does one small write,
// and one line in the event log.

import { existsSync } from "node:fs";
import { RUN_ENV } from "../cli/audit-run.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { resolveRepo } from "../cli/scope.ts";
import { isSaved, recordUnsaved } from "../cli/session.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text());
  const store = new Store();
  if (
    // A subagent does not end a session. Its transcript is not a session to recover.
    !input?.agent_id &&
    typeof input?.session_id === "string" &&
    typeof input.transcript_path === "string" &&
    typeof input.cwd === "string" &&
    // The agent of `kb audit` reads notes and proposes. It learns nothing that a note must keep.
    !process.env[RUN_ENV] &&
    store.exists() &&
    !isSaved(store, input.session_id)
  ) {
    // A later kb may get a reason that this one does not know. Every end is recorded.
    const reason = typeof input.reason === "string" && input.reason ? input.reason.slice(0, 40) : "unknown";
    // The scope is read now: the folder of a finished run, such as a worktree, is often deleted
    // later. A folder that is gone already has no scope to read, and the mark says nothing of it.
    const repo = existsSync(input.cwd) ? resolveRepo(input.cwd, store, { record: false }) : null;
    recordUnsaved(store, { session: input.session_id, transcript: input.transcript_path, cwd: input.cwd, ended: new Date().toISOString(), reason, ...(repo ? { scope: repo.scope, root: repo.root } : {}) });
    logEvent(store, { ev: "unsaved", ...hookWho(input), ...(repo ? { scope: repo.scope ?? "global" } : {}), reason });
  }
} catch {
  // silent on purpose
}
process.exit(0);
