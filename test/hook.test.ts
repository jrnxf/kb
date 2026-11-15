import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, plain, putNote, tempDir, tempRepo, tempStore } from "./helpers.ts";

const HOOK = join(ROOT, "hooks", "session-start.sh");

function runHook(options: { home: string; stdin: string; path?: string }) {
  const started = performance.now();
  const r = Bun.spawnSync([HOOK], {
    cwd: plain(),
    env: { ...process.env, KB_HOME: options.home, PATH: options.path ?? process.env.PATH },
    stdin: Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms: performance.now() - started };
}

const input = (cwd: string, source = "startup") => JSON.stringify({ session_id: "abc", transcript_path: "/home/user/t.jsonl", cwd, hook_event_name: "SessionStart", source });

describe("SessionStart hook", () => {
  test("exits 0 and prints nothing when there is no store", () => {
    const home = join(tempDir(), "missing");
    const result = runHook({ home, stdin: input(plain()) });
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(home)).toBe(false);
  });

  test("exits 0 and prints nothing when bun is missing", () => {
    // A PATH with the shell tools but no bun.
    const bin = tempDir("kb-nobun-");
    for (const tool of ["sh", "dirname"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
    const store = tempStore();
    putNote(store, { id: "a" });
    const result = runHook({ home: store.home, stdin: input(plain()), path: bin });
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  test("exits 0 and prints nothing on bad stdin, a missing directory or a broken store", () => {
    const store = tempStore();
    expect(runHook({ home: store.home, stdin: "" })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(runHook({ home: store.home, stdin: "{not json" })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(runHook({ home: store.home, stdin: input("/does/not/exist") })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    writeFileSync(join(store.home, "kb.config.json"), "{broken");
    writeFileSync(join(store.home, "notes", "bad.md"), "no frontmatter here");
    expect(runHook({ home: store.home, stdin: input(plain()) })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    // A file where the store should be.
    const file = join(tempDir(), "file");
    writeFileSync(file, "x");
    expect(runHook({ home: file, stdin: input(plain()) })).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  test("prints the context for the session directory on every source", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    putNote(store, { id: "repo-note", scope: "github.com/acme/billing" });
    putNote(store, { id: "global-note" });
    for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
      const result = runHook({ home: store.home, stdin: input(repo, source) });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("# kb: saved knowledge for github.com/acme/billing");
      expect(result.stdout).toContain("### repo-note [gotcha]");
      expect(result.stdout).toContain("### global-note [gotcha]");
    }
    const elsewhere = runHook({ home: store.home, stdin: input(tempRepo({ remote: "git@github.com:acme/web.git" })) });
    expect(elsewhere.stdout).not.toContain("repo-note");
    expect(elsewhere.stdout).toContain("global-note");
  });

  test("finishes well under a second with a large store", () => {
    const store = tempStore();
    for (let i = 0; i < 500; i++) putNote(store, { id: `note-${i}`, scope: i % 2 ? "global" : "github.com/acme/billing", body: "line\n".repeat(10) });
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    runHook({ home: store.home, stdin: input(repo) }); // warm the caches
    const result = runHook({ home: store.home, stdin: input(repo) });
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(1000);
    expect(result.stdout.length).toBeLessThanOrEqual(9500);
    expect(result.ms).toBeLessThan(500);
  });
});

describe("plugin files", () => {
  test("hooks.json registers SessionStart for all five sources", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
    const entry = hooks.hooks.SessionStart[0];
    expect(entry.matcher.split("|").sort()).toEqual(["clear", "compact", "fork", "resume", "startup"]);
    expect(entry.hooks[0].command).toBe('"${CLAUDE_PLUGIN_ROOT}"/hooks/session-start.sh');
  });

  test("the CLI source reads no CLAUDE_ variable", async () => {
    const glob = new Bun.Glob("cli/**/*.ts");
    for await (const file of glob.scan(ROOT)) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/CLAUDE_/);
    }
  });

  test("bin/kb runs from another directory", () => {
    const r = Bun.spawnSync([join(ROOT, "bin", "kb"), "scope", "--json"], { cwd: dirname(ROOT), env: { ...process.env, KB_HOME: join(tempDir(), "none") }, stdout: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toHaveProperty("scope");
  });
});
