import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tempDir } from "./helpers.ts";

// bin/kb-run.ts picks the install and runs it. The README function only finds that file.
const RUN = join(ROOT, "bin", "kb-run.ts");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const FUNCTION = README.match(/```bash\n(kb\(\) \{\n[\s\S]*?\n\})\n```/)?.[1] ?? "";

// A fake install. Its CLI prints its label and the arguments, so a test sees which install ran.
function install(label: string, withRun = false) {
  const dir = tempDir(`kb install ${label}-`);
  mkdirSync(join(dir, "cli"));
  writeFileSync(join(dir, "cli", "main.ts"), `console.log(JSON.stringify({ label: ${JSON.stringify(label)}, args: process.argv.slice(2) }));`);
  if (withRun) {
    mkdirSync(join(dir, "bin"));
    symlinkSync(RUN, join(dir, "bin", "kb-run.ts"));
  }
  return dir;
}

// A home with an installed_plugins.json. The file is written as given.
function home(plugins: Record<string, unknown>, folder = ".claude") {
  const dir = tempDir("kb-home-");
  mkdirSync(join(dir, folder, "plugins"), { recursive: true });
  writeFileSync(join(dir, folder, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  return dir;
}

function env(dir: string, extra: Record<string, string> = {}) {
  return { PATH: process.env.PATH ?? "", HOME: dir, KB_HOME: join(dir, "store"), ...extra };
}

function run(dir: string, cwd = tempDir("kb-cwd-"), extra: Record<string, string> = {}, args = ["a", "b"]) {
  const r = Bun.spawnSync(["bun", RUN, ...args], { cwd, env: env(dir, extra), stdout: "pipe", stderr: "pipe" });
  const stdout = r.stdout.toString();
  return { code: r.exitCode, stdout, stderr: r.stderr.toString(), label: stdout.startsWith("{") ? JSON.parse(stdout).label : undefined };
}

const user = (installPath: string) => ({ scope: "user", installPath });
const project = (installPath: string, projectPath: string, scope = "project") => ({ scope, projectPath, installPath });

test("kb-run runs the CLI of the user install with the arguments", () => {
  const u = install("user");
  const r = run(home({ "kb@jrnxf": [user(u)] }));
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ label: "user", args: ["a", "b"] });
});

test("kb-run reads CLAUDE_CONFIG_DIR when it is set", () => {
  const dir = home({ "kb@jrnxf": [user(install("user"))] }, "config");
  const r = run(dir, undefined, { CLAUDE_CONFIG_DIR: join(dir, "config") });
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(r.label).toBe("user");
});

test("kb-run reads a version 1 entry, an object with no scope", () => {
  const r = run(home({ "kb@jrnxf": { version: "1.0.0", installPath: install("v1") } }));
  expect(r.code).toBe(0);
  expect(r.label).toBe("v1");
});

test("kb-run prefers kb@jrnxf over another kb@ key and ignores other plugins", () => {
  const r = run(home({ "other@x": [user(install("other"))], "kb@aaa": [user(install("aaa"))], "kb@jrnxf": [user(install("jrnxf"))] }));
  expect(r.label).toBe("jrnxf");
});

test("kb-run runs a local install that holds the folder", () => {
  const cwd = tempDir("kb-project-");
  const r = run(home({ "kb@jrnxf": [user(install("user")), project(install("local"), cwd, "local")] }), cwd);
  expect(r.stderr).toBe("");
  expect(r.label).toBe("local");
});

test("kb-run prefers local, then project, then user", () => {
  const cwd = tempDir("kb-project-");
  const user1 = user(install("user"));
  const proj = project(install("project"), cwd);
  const local = project(install("local"), cwd, "local");
  expect(run(home({ "kb@jrnxf": [user1, proj, local] }), cwd).label).toBe("local");
  expect(run(home({ "kb@jrnxf": [user1, proj] }), cwd).label).toBe("project");
  expect(run(home({ "kb@jrnxf": [user1] }), cwd).label).toBe("user");
});

test("kb-run picks the deepest project that holds the folder", () => {
  const outer = tempDir("kb-project-");
  const inner = join(outer, "inner");
  mkdirSync(join(inner, "deep"), { recursive: true });
  const r = run(home({ "kb@jrnxf": [project(install("outer"), outer), project(install("inner"), inner)] }), join(inner, "deep"));
  expect(r.label).toBe("inner");
});

test("kb-run matches a project on a folder boundary, not a string prefix", () => {
  const base = tempDir("kb-project-");
  mkdirSync(join(base, "app"));
  mkdirSync(join(base, "app2"));
  const r = run(home({ "kb@jrnxf": [project(install("app"), join(base, "app"))] }), join(base, "app2"));
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("not inside it");
});

test("kb-run compares real paths, so a symlinked folder still matches", () => {
  const base = tempDir("kb-project-");
  mkdirSync(join(base, "real"));
  symlinkSync(join(base, "real"), join(base, "link"));
  const entry = (p: string) => run(home({ "kb@jrnxf": [project(install("p"), p)] }), join(base, "real"));
  expect(entry(join(base, "link")).label).toBe("p");
});

test("kb-run skips an install whose files are gone", () => {
  const gone = { scope: "user", installPath: "/home/user/gone" };
  expect(run(home({ "kb@jrnxf": [gone, user(install("live"))] })).label).toBe("live");
  const r = run(home({ "kb@jrnxf": [gone] }));
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("files are missing: /home/user/gone");
  expect(r.stderr).toContain("claude plugin install kb@jrnxf");
  expect(r.stderr).not.toContain("Cannot find module");
});

test("kb-run names the installs that do not apply", () => {
  const r = run(home({ "kb@jrnxf": [project(install("p"), "/home/user/other"), project(install("l"), "/home/user/third", "local")] }));
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("kb is installed for project /home/user/other, local /home/user/third");
  expect(r.stderr).toContain("no user install");
});

test("kb-run treats an entry with no installPath as not installed", () => {
  const r = run(home({ "kb@jrnxf": [{ scope: "user" }] }));
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("not installed");
  expect(r.stderr).not.toContain("undefined");
});

test("kb-run shows the real error when the file cannot be read", () => {
  const dir = tempDir("kb-home-");
  mkdirSync(join(dir, ".claude", "plugins", "installed_plugins.json"), { recursive: true });
  const r = run(dir);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("cannot read");
  expect(r.stderr).toContain("EISDIR");
  const broken = home({});
  writeFileSync(join(broken, ".claude", "plugins", "installed_plugins.json"), "{ not json");
  expect(run(broken).stderr).toContain("cannot read");
});

test("kb-run says that kb is not installed", () => {
  const missing = tempDir("kb-home-");
  const none = run(missing);
  expect(none.code).toBe(1);
  expect(none.stdout).toBe("");
  expect(none.stderr).toBe(`kb: the kb plugin is not in ${join(missing, ".claude", "plugins", "installed_plugins.json")}. Run: claude plugin install kb@jrnxf\n`);
  expect(run(home({ "other@x": [user(install("other"))] })).stderr).toContain("not installed");
});

// The README function, run as a user would run it. It must find kb-run.ts and pass the arguments on.
test("the README has the shell function", () => {
  expect(FUNCTION).toStartWith("kb() {");
});

function stub(shell: string, dir: string, extra: Record<string, string> = {}) {
  const file = join(tempDir("kb-fn-"), "kb.sh");
  writeFileSync(file, FUNCTION);
  // The PATH is set again in the shell, because a system zshenv can reset it. The values go in as variables, so no quoting is needed.
  const r = Bun.spawnSync([shell, "-c", 'PATH="$KB_TEST_PATH"; . "$KB_TEST_FILE"; kb x "y z"'], {
    cwd: tempDir("kb-cwd-"),
    env: { ...env(dir, extra), KB_TEST_PATH: process.env.PATH ?? "", KB_TEST_FILE: file },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

for (const shell of ["bash", "zsh"].filter((s) => Bun.which(s))) {
  test(`the README function runs the picked install end to end, in ${shell}`, () => {
    // A decoy with "/kb/" in its path and no kb-run.ts comes first, and the install path holds a space.
    const real = install("real", true);
    const decoy = tempDir("kb-decoy-");
    const r = stub(shell, home({ "kb-extras@other": [user(join(decoy, "kb", "1.0"))], "kb@jrnxf": [user(real)] }));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ label: "real", args: ["x", "y z"] });
  });

  test(`the README function reads CLAUDE_CONFIG_DIR, in ${shell}`, () => {
    const dir = home({ "kb@jrnxf": [user(install("cfg", true))] }, "config");
    const r = stub(shell, dir, { CLAUDE_CONFIG_DIR: join(dir, "config") });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).label).toBe("cfg");
  });

  test(`the README function exits with the code of kb, in ${shell}`, () => {
    const r = stub(shell, home({ "kb@jrnxf": [user(install("p", true))] }));
    expect(r.code).toBe(0);
    const none = stub(shell, home({ "kb@jrnxf": [user(install("old"))] }));
    expect(none.code).toBe(1);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("claude plugin install kb@jrnxf");
    expect(stub(shell, tempDir("kb-home-")).code).toBe(1);
  });
}
