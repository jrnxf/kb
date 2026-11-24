import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tempDir } from "./helpers.ts";

// The README gives a shell function that runs the installed kb from your own terminal. This runs that exact text.
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const FUNCTION = README.match(/```bash\n(kb\(\) \{\n[\s\S]*?\n\})\n```/)?.[1] ?? "";

function run(shell: string, home: string, env: Record<string, string> = {}, cwd = tempDir("kb-cwd-")) {
  const file = join(tempDir("kb-fn-"), "kb.sh");
  writeFileSync(file, FUNCTION);
  // The PATH is set again in the shell, because a system zshenv can reset it. The values go in as variables, so no quoting is needed.
  const r = Bun.spawnSync([shell, "-c", 'PATH="$KB_TEST_PATH"; . "$KB_TEST_FILE"; kb scope --json'], {
    cwd,
    env: { PATH: process.env.PATH, KB_TEST_PATH: process.env.PATH ?? "", KB_TEST_FILE: file, HOME: home, KB_HOME: join(home, "store"), ...env },
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
    // The home has no .claude folder, so only the config folder can lead to kb.
    const dir = home({ ...decoy, ...kb }, "config");
    const r = run(shell, dir, { CLAUDE_CONFIG_DIR: join(dir, "config") });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toHaveProperty("scope");
  });

  test(`the shell function prefers kb@jrnxf over another kb@ key, in ${shell}`, () => {
    const gone = { scope: "user", installPath: "/home/user/gone" };
    const r = run(shell, home({ "kb@aaa": [gone], "kb@jrnxf": [{ scope: "user", installPath: ROOT }] }));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  test(`the shell function reads a v1 entry, an object with no scope, in ${shell}`, () => {
    const r = run(shell, home({ "kb@jrnxf": { version: "1.0.0", installPath: ROOT } }));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  test(`the shell function does not run the project install of another project, in ${shell}`, () => {
    const other = { "kb@jrnxf": [{ scope: "project", projectPath: "/home/user/other", installPath: ROOT }] };
    const r = run(shell, home(other));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no user install of the kb plugin");
  });

  test(`the shell function runs a project install that holds the current directory, in ${shell}`, () => {
    const cwd = realpathSync(tempDir("kb-project-"));
    const mine = { "kb@jrnxf": [{ scope: "project", projectPath: cwd, installPath: ROOT }] };
    const r = run(shell, home(mine), {}, join(cwd, ".."));
    expect(r.code).toBe(1);
    const inside = run(shell, home(mine), {}, cwd);
    expect(inside.stderr).toBe("");
    expect(inside.code).toBe(0);
  });

  test(`the shell function treats an entry with no installPath as not installed, in ${shell}`, () => {
    const r = run(shell, home({ "kb@jrnxf": [{ scope: "user" }] }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no user install of the kb plugin");
    expect(r.stderr).not.toContain("undefined");
  });

  test(`the shell function shows the real error when the file cannot be read, in ${shell}`, () => {
    const dir = tempDir("kb-home-");
    mkdirSync(join(dir, ".claude", "plugins", "installed_plugins.json"), { recursive: true });
    const r = run(shell, dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read");
    expect(r.stderr).toContain("EISDIR");
    expect(r.stderr).not.toContain("is not in");
    const broken = home({});
    writeFileSync(join(broken, ".claude", "plugins", "installed_plugins.json"), "{ not json");
    expect(run(shell, broken).stderr).toContain("cannot read");
  });

  test(`the shell function says that kb is not installed, in ${shell}`, () => {
    const missing = tempDir("kb-home-");
    const none = run(shell, missing);
    expect(none.code).toBe(1);
    expect(none.stdout).toBe("");
    expect(none.stderr).toBe(`kb: the kb plugin is not in ${join(missing, ".claude", "plugins", "installed_plugins.json")}. Run: claude plugin install kb@jrnxf\n`);
    const other = run(shell, home(decoy));
    expect(other.code).toBe(1);
    expect(other.stdout).toBe("");
    expect(other.stderr).toContain("no user install of the kb plugin");
  });
}
