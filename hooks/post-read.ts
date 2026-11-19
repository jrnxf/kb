// Reads the PostToolUse JSON of a Read on stdin. When kb has repo notes on the file that this
// session, or this subagent, has not got yet, it names them, so the agent sees them when it works
// on that file.

import { byPathNotice } from "../cli/by-path.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) ?? {};
  const file = input.tool_input?.file_path;
  if (typeof file === "string" && file) {
    const text = byPathNotice(new Store(), file, input);
    // Plain output of a PostToolUse hook does not reach the agent. additionalContext does.
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
  }
} catch {
  // A broken store or odd input: the Read result stands on its own.
}
process.exit(0);
