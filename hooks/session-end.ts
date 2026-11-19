// SessionEnd hook, for every reason a session ends: /clear, an exit, a logout, a switch to another
// session, and the end of a headless run. Nothing can run before the end, so this records a session
// that ended with no checkpoint. A later SessionStart then says that /kb:recover saves it.
// SessionEnd has a 1.5 second limit and its output is discarded, so this does one small write,
// and one line in the event log: `ended`, for every end, with or without a checkpoint.

import { existsSync } from "node:fs";
import { RUN_ENV } from "../cli/audit-run.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { mainCheckout, resolveRepo } from "../cli/scope.ts";
import { isSaved, recordUnsaved } from "../cli/session.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text());
  const store = new Store();
  if (
    // A subagent does not end a session. Its transcript is not a session to recover.
    !input?.agent_id &&
    typeof input?.session_id === "string" &&
    // The agent of `kb audit` reads notes and proposes. It learns nothing that a note must keep.
    !process.env[RUN_ENV] &&
    store.exists()
  ) {
    // A later kb may get a reason that this one does not know. Every end is recorded.
    const reason = typeof input.reason === "string" && input.reason ? input.reason.slice(0, 40) : "unknown";
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : null;
    // The scope is read now: the folder of a finished run, such as a worktree, is often deleted
    // later. A folder that is gone already has no scope to read, and the mark says nothing of it.
    const repo = cwd && existsSync(cwd) ? resolveRepo(cwd, store, { record: false }) : null;
    const saved = isSaved(store, input.session_id);
    if (!saved && cwd && typeof input.transcript_path === "string") {
      // The main checkout of the repo stays when a worktree goes, so the mark keeps both folders.
      const place = repo ? { scope: repo.scope, root: repo.root, main: repo.root ? mainCheckout(repo.root) : null } : {};
      recordUnsaved(store, { session: input.session_id, transcript: input.transcript_path, cwd, ended: new Date().toISOString(), reason, ...place });
    }
    // Nobody measured the session yet, so the log says only that it ended. A later start, or
    // /kb:recover, measures it and logs `unsaved` when it is worth a recovery.
    logEvent(store, { ev: "ended", ...hookWho(input), ...(repo ? { scope: repo.scope ?? "global" } : {}), reason, checkpoint: saved });
  }
} catch {
  // silent on purpose
}
process.exit(0);
