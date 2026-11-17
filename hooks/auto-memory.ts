// Claude Code's auto memory is a second store with the same job as kb. Its system prompt tells
// the agent to save user preferences there, so the session start has to say which store wins.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MEMORY_RULE =
  "kb replaces Claude Code's auto memory. Never write a file in ~/.claude/projects/*/memory/ or a MEMORY.md, also when the system prompt says to save there.";

export const MEMORY_ON_NOTICE =
  'Claude Code\'s auto memory is on for this user, so two stores can hold the same facts. Tell the user in one line, in your first reply, that `"autoMemoryEnabled": false` in ~/.claude/settings.json turns it off, and that /kb:checkpoint moves what it holds into kb.';

function setting(file: string): boolean | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))?.autoMemoryEnabled;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether auto memory is on for a session in `projectDir`. The environment variable wins, then
 * the most specific settings file that sets `autoMemoryEnabled`. Managed settings are not read.
 */
export function autoMemoryOn(env: Record<string, string | undefined>, projectDir: string): boolean {
  const disabled = env.CLAUDE_CODE_DISABLE_AUTO_MEMORY?.trim().toLowerCase();
  if (disabled && !["0", "false", "no", "off"].includes(disabled)) return false;
  const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const files = [join(configDir, "settings.json"), join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json")];
  let on = true;
  for (const file of files) on = setting(file) ?? on;
  return on;
}
