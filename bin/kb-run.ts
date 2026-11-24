#!/usr/bin/env bun
// Runs kb from your own terminal. The `kb` shell function in the README finds this file and calls it,
// so the lookup below can change without anyone editing their shell rc.
// It reads Claude Code's list of installed plugins, picks the install that Claude Code would use here,
// and runs that install's CLI in this process.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Install = { scope?: string; projectPath?: string; installPath?: string };
type Entry = { key: string; scope: string; projectPath?: string; installPath: string };

const HINT = "Run: claude plugin install kb@jrnxf";
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const fail = (why: string): never => {
  console.error(`kb: ${why}`);
  process.exit(1);
};

/** The depth of the project folder when it holds the folder, else -1. Both sides use real paths, and the match stops at a folder boundary. */
export function holds(projectPath: string, cwd: string): number {
  const root = real(projectPath).replace(/\/+$/, "");
  const here = real(cwd);
  return here === root || here.startsWith(`${root}/`) ? root.length : -1;
}

/** The install that Claude Code would use in this folder: local, then project (the deepest folder), then user. */
export function pick(plugins: Record<string, unknown>, cwd: string): { install?: Entry; error?: string } {
  const keys = Object.keys(plugins)
    .filter((k) => k.startsWith("kb@"))
    .sort((a, b) => Number(b === "kb@jrnxf") - Number(a === "kb@jrnxf"));
  // A version 1 file holds one object per key, with no scope. That is a user install.
  const all: Entry[] = keys.flatMap((key) =>
    [plugins[key] as Install]
      .flat()
      .filter((i) => i?.installPath)
      .map((i) => ({ key, scope: i.scope ?? "user", projectPath: i.projectPath, installPath: i.installPath as string })),
  );
  if (all.length === 0) return { error: `the kb plugin is not installed. ${HINT}` };
  const present = all.filter((i) => existsSync(join(i.installPath, "cli", "main.ts")));
  if (present.length === 0) return { error: `the kb plugin files are missing: ${all.map((i) => i.installPath).join(", ")}. ${HINT}` };
  const depth = (i: Entry) => (i.projectPath ? holds(i.projectPath, cwd) : -1);
  const scoped = (scope: string[]) =>
    present
      .filter((i) => scope.includes(i.scope) && depth(i) >= 0)
      .sort((a, b) => depth(b) - depth(a));
  const install = scoped(["local"])[0] ?? scoped(["project"])[0] ?? present.find((i) => i.scope === "user");
  if (install) return { install };
  const where = present.map((i) => `${i.scope} ${i.projectPath ?? ""}`.trim()).join(", ");
  return { error: `kb is installed for ${where}, but this folder is not inside it, and there is no user install. ${HINT}` };
}

if (import.meta.main) {
  const env = process.env;
  const file = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "plugins", "installed_plugins.json");
  let plugins: Record<string, unknown> = {};
  try {
    plugins = JSON.parse(readFileSync(file, "utf8")).plugins ?? {};
  } catch (e) {
    fail((e as NodeJS.ErrnoException).code === "ENOENT" ? `the kb plugin is not in ${file}. ${HINT}` : `cannot read ${file}: ${(e as Error).message}`);
  }
  const { install, error } = pick(plugins, process.cwd());
  if (!install) fail(`${error} (${file})`);
  // The CLI reads its command from argv at index 2, so put a program name at index 1.
  process.argv = [process.argv[0], "kb", ...process.argv.slice(2)];
  await import(join(install!.installPath, "cli", "main.ts"));
}
