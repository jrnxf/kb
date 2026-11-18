// Reads the PostToolUse JSON of a Read on stdin. When kb has repo notes on the file that the
// session has not got yet, it names them, so the agent sees them when it works on that file.

import { byPathNotice, markSeen } from "../cli/by-path.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) ?? {};
  const file = input.tool_input?.file_path;
  if (typeof file === "string" && file) {
    const store = new Store();
    const notice = byPathNotice(store, file, input.session_id);
    if (notice) {
      // Plain output of a PostToolUse hook does not reach the agent. additionalContext does.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notice.text } }));
      markSeen(store, input.session_id, notice.ids);
    }
  }
} catch {
  // A broken store or odd input: the Read result stands on its own.
}
process.exit(0);
