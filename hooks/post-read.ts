// Reads the PostToolUse JSON of a Read on stdin. When kb has repo notes on the file that this
// session, or this subagent, has not got yet, it gives them, so the agent has them when it works
// on that file: a gotcha whole, another kind as its title. Each note is one `fire` in the event log.

import { afterRead } from "../cli/fire.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) ?? {};
  const file = input.tool_input?.file_path;
  if (typeof file === "string" && file) {
    const store = new Store();
    const fired = afterRead(store, file, input);
    if (fired) {
      // Plain output of a PostToolUse hook does not reach the agent. additionalContext does.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: fired.text } }));
      // The log comes after the output, so it can never change or delay what the agent gets.
      logEvent(store, fired.fires.map((fire) => ({ ev: "fire" as const, ...fire, tool: "Read", ...hookWho(input), scope: fired.scope })));
    }
  }
} catch {
  // A broken store or odd input: the Read result stands on its own.
}
process.exit(0);
