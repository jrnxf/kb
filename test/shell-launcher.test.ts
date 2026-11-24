import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tempDir } from "./helpers.ts";

// The README gives a shell function that runs the installed kb from your own terminal. This runs that exact text.
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const FUNCTION = README.match(/```bash\n(kb\(\) \{\n[\s\S]*?\n\})\n```/)?.[1] ?? "";

function run(shell: string, home: string, env: Record<string, string> = {}) {
  const file = join(tempDir("kb-fn-"), "kb.sh");
  writeFileSync(file, FUNCTION);
  // The PATH is set again in the shell, because a system zshenv can reset it.
  const r = Bun.spawnSync([shell, "-c", `PATH='${process.env.PATH}'; . ${file}; kb scope --json`], {
    cwd: tempDir("kb-cwd-"),
    env: { PATH: process.env.PATH, HOME: home, KB_HOME: join(home, "store"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

// A home whose installed_plugins.json lists another plugin first, with "/kb/" in its path.
function home(plugins: Record<string, unknown>, folder = ".claude") {
  const dir = tempDir("kb-home-");
  mkdirSync(join(dir, folder, "plugins"), { recursive: true });
  writeFileSync(join(dir, folder, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  return dir;
}
const decoy = { "kb-extras@other": [{ scope: "user", installPath: "/home/user/.claude/plugins/cache/other/kb/1.0.0" }] };
const kb = { "kb@example": [{ scope: "project", installPath: "/home/user/elsewhere" }, { scope: "user", installPath: ROOT }] };

test("the README has the shell function", () => {
  expect(FUNCTION).toStartWith("kb() {");
});

for (const shell of ["bash", "zsh"].filter((s) => Bun.which(s))) {
  test(`the shell function runs the kb@ install of the user scope, in ${shell}`, () => {
    const r = run(shell, home({ ...decoy, ...kb }));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty("scope");
  });

  test(`the shell function reads CLAUDE_CONFIG_DIR when it is set, in ${shell}`, () => {
    const dir = home({ ...decoy, ...kb }, "config");
    expect(run(shell, dir, { CLAUDE_CONFIG_DIR: join(dir, "config") }).code).toBe(0);
  });

  test(`the shell function says that kb is not installed, in ${shell}`, () => {
    for (const dir of [home(decoy), tempDir("kb-home-")]) {
      const r = run(shell, dir);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`kb: the kb plugin is not in ${join(dir, ".claude", "plugins", "installed_plugins.json")}. Run: claude plugin install kb@jrnxf\n`);
    }
  });
}
