// Reads the JSON of a tool call on stdin: PreToolUse of Bash, Edit, Write or NotebookEdit, or
// PostToolUseFailure of any tool. When a note of kb applies to the call and this session, or this
// subagent, has not got it yet, the agent gets it now: before a command that a `cmd` trigger names,
// after an error that an `err` trigger names, and on a file that an anchor names. A `stop` trigger
// refuses the command once, with the note as the reason. Each note is one `fire` in the event log.
// Most calls match nothing: then this reads one small table and prints nothing.

import { type Fired, afterFailure, beforeCommand, beforeEdit } from "../cli/fire.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { Store } from "../cli/store.ts";

try {
  const input = JSON.parse(await Bun.stdin.text()) ?? {};
  const event: unknown = input.hook_event_name;
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const store = new Store();
  let fired: Fired | null = null;
  if (event === "PreToolUse") {
    if (tool === "Bash") fired = beforeCommand(store, text(input.tool_input?.command), cwd, input);
    // NotebookEdit names its file notebook_path.
    else fired = beforeEdit(store, text(input.tool_input?.file_path) || text(input.tool_input?.notebook_path), input);
  } else if (event === "PostToolUseFailure" && input.is_interrupt !== true) {
    // A failed Bash call gives `error`: "Exit code 1" and the output. A PostToolUse never comes for it.
    fired = afterFailure(store, text(input.error), cwd, input);
  }
  if (fired) {
    // A stop refuses the call, and the reason is all the agent gets. The record of the note is
    // written already, so the same call passes the next time.
    const out = fired.stop
      ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: fired.text }
      : { hookEventName: event, additionalContext: fired.text };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
    // The log comes after the output, so it can never change or delay what the agent gets.
    logEvent(store, fired.fires.map((fire) => ({ ev: "fire" as const, ...fire, tool, ...hookWho(input), scope: fired.scope })));
  }
} catch {
  // A broken store or odd input: the tool call goes on as if kb were not there.
}
process.exit(0);
