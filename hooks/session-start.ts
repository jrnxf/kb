// Reads the SessionStart JSON on stdin and prints `kb context` for the session's directory.
// This file is the only place, with the skills, that knows about Claude Code.

import { buildContext } from "../cli/context.ts";
import { Store } from "../cli/store.ts";
import { kickSync } from "../cli/sync.ts";

try {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(await Bun.stdin.text());
    if (typeof input?.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    // no stdin or not JSON: use the process directory
  }
  const store = new Store();
  const { text } = buildContext(store, cwd);
  if (text) process.stdout.write(text);
  // Fetch changes from other machines in the background, at most once per 5 minutes.
  kickSync(store, 5 * 60_000);
} catch {
  // silent on purpose
}
process.exit(0);
