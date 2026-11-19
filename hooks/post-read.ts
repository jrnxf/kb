// Reads the PostToolUse JSON of a Read on stdin. When kb has repo notes on the file that this
// session, or this subagent, has not got yet, it names them, so the agent sees them when it works
// on that file. Each note it names is one `fire` in the event log.

import { byPathNotice } from "../cli/by-path.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) ?? {};
  const file = input.tool_input?.file_path;
  if (typeof file === "string" && file) {
    const store = new Store();
    const found = byPathNotice(store, file, input);
    if (found) {
      // Plain output of a PostToolUse hook does not reach the agent. additionalContext does.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: found.text } }));
      // The log comes after the output, so it can never change or delay what the agent gets.
      logEvent(store, found.notes.map((note) => ({ ev: "fire" as const, kind: "path" as const, form: "title" as const, note, tool: "Read", match: found.path, ...hookWho(input), scope: found.scope })));
    }
  }
} catch {
  // A broken store or odd input: the Read result stands on its own.
}
process.exit(0);
