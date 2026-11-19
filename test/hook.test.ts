import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SAVE_RULE } from "../cli/context.ts";
import { MEMORY_ON_NOTICE, MEMORY_RULE } from "../hooks/auto-memory.ts";
import { ROOT, kb, logged, plain, putNote, tempDir, tempRepo, tempStore } from "./helpers.ts";

const HOOK = join(ROOT, "hooks", "session-start.sh");

// A Claude Code config folder with auto memory off, so the developer's own settings never reach a test.
const QUIET_CONFIG = tempDir("kb-claude-");
writeFileSync(join(QUIET_CONFIG, "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));

function runHook(options: { home: string; stdin: string; path?: string; env?: Record<string, string | undefined> }) {
  const started = performance.now();
  const r = Bun.spawnSync([HOOK], {
    cwd: plain(),
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: undefined, CLAUDE_PROJECT_DIR: undefined, CLAUDE_CONFIG_DIR: QUIET_CONFIG, KB_HOME: options.home, PATH: options.path ?? process.env.PATH, ...options.env },
    stdin: Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms: performance.now() - started };
}

const SAVING = `# kb\n${SAVE_RULE}\n${MEMORY_RULE}\n`;

const input = (cwd: string, source = "startup") => JSON.stringify({ session_id: "abc", transcript_path: "/home/user/t.jsonl", cwd, hook_event_name: "SessionStart", source });

describe("SessionStart hook", () => {
  test("prints only the rules for saving when there is no store, and creates none", () => {
    const home = join(tempDir(), "missing");
    const result = runHook({ home, stdin: input(plain()) });
    expect(result).toMatchObject({ code: 0, stdout: SAVING, stderr: "" });
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

  test("exits 0 on bad stdin, a missing directory or a broken store", () => {
    const store = tempStore();
    // No note to show: only the rules for saving.
    expect(runHook({ home: store.home, stdin: "" })).toMatchObject({ code: 0, stdout: SAVING, stderr: "" });
    expect(runHook({ home: store.home, stdin: "{not json" })).toMatchObject({ code: 0, stdout: SAVING, stderr: "" });
    expect(runHook({ home: store.home, stdin: input("/does/not/exist") })).toMatchObject({ code: 0, stdout: SAVING, stderr: "" });
    writeFileSync(join(store.home, "kb.config.json"), "{broken");
    writeFileSync(join(store.home, "notes", "bad.md"), "no frontmatter here");
    expect(runHook({ home: store.home, stdin: input(plain()) })).toMatchObject({ code: 0, stdout: SAVING, stderr: "" });
    // A file where the store should be.
    const file = join(tempDir(), "file");
    writeFileSync(file, "x");
    expect(runHook({ home: file, stdin: input(plain()) })).toMatchObject({ code: 0, stdout: SAVING, stderr: "" });
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

  test("logs one start per run: the source, the scope, the notes by form and the characters by part", () => {
    const store = tempStore();
    const scope = "github.com/acme/billing";
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    // One body fits, the index has one line and one global note may load. So a repo note and a
    // global note are over the index budget, and one global note is over the global cap.
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 1, contextChars: 1100, globalIndexLines: 1 } }));
    for (const id of ["r-1", "r-2", "r-3"]) putNote(store, { id, scope, body: "x".repeat(400) });
    putNote(store, { id: "g-new", body: "x".repeat(400), last_verified: "2026-02-01T00:00:00Z" });
    putNote(store, { id: "g-old", body: "x".repeat(400) });
    const out = runHook({ home: store.home, stdin: input(repo, "resume") }).stdout;
    const events = logged(store) as any[];
    expect(events).toHaveLength(1);
    const { chars, ...start } = events[0];
    expect(start).toEqual({ ev: "start", session: "abc", scope, source: "resume", bodies: ["r-1"], index: ["r-2"], hidden: ["r-3", "g-new", "g-old"] });
    // The parts are measured where the text is built. They add up to what the session got.
    const at = (text: string) => out.indexOf(text);
    expect(chars.total).toBe(out.length);
    expect(chars.index).toBe(at("\n\n## Notes") - at("\n\n## Index"));
    expect(chars.bodies).toBe(at("1 note is in the index only") - at("\n\n## Notes") - 1);
    expect(chars.fixed).toBe(chars.total - chars.index - chars.bodies);
    expect(out).toContain("The kb store is over its index budget here: 2 notes are hidden");

    // A start outside any repo has the scope "global". A store with no note still logs the start.
    const empty = tempStore();
    runHook({ home: empty.home, stdin: JSON.stringify({ session_id: "s9", cwd: plain(), source: "clear" }) });
    expect(logged(empty)).toEqual([{ ev: "start", session: "s9", scope: "global", source: "clear", bodies: [], index: [], hidden: [], chars: { fixed: SAVING.length, index: 0, bodies: 0, total: SAVING.length } }]);
  });

  test("a log that cannot be written changes nothing in the output", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    putNote(store, { id: "repo-note", scope: "github.com/acme/billing" });
    const first = runHook({ home: store.home, stdin: input(repo) });
    expect(logged(store)).toHaveLength(1);
    rmSync(join(store.home, ".state", "log"), { recursive: true });
    writeFileSync(join(store.home, ".state", "log"), "a file where the folder should be");
    const second = runHook({ home: store.home, stdin: input(repo) });
    expect(second).toMatchObject({ code: 0, stdout: first.stdout, stderr: "" });
    expect(first.stdout).toContain("### repo-note [gotcha]");
  });

  test("stays under the 10,000 character limit at the largest budget, with every notice", () => {
    const store = tempStore();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 1, contextChars: 20000 } }));
    for (let i = 0; i < 40; i++) putNote(store, { id: `big-${i}`, body: "x".repeat(400) });
    const repo = tempRepo();
    const END = join(ROOT, "hooks", "session-end.sh");
    for (let i = 0; i < 20; i++) {
      const body = { session_id: `lost-${i}`, transcript_path: `/home/user/${"t".repeat(150)}-${i}.jsonl`, cwd: repo, hook_event_name: "SessionEnd", reason: "clear" };
      Bun.spawnSync([END], { env: { ...process.env, KB_HOME: store.home }, stdin: Buffer.from(JSON.stringify(body)) });
    }
    const out = runHook({ home: store.home, stdin: input(repo), env: { CLAUDE_CONFIG_DIR: tempDir("kb-claude-") } }).stdout;
    expect(out).toContain("An earlier session in this directory");
    expect(out.length).toBeLessThan(10000);
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
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "PreCompact", "SessionEnd", "SessionStart"]);
    expect(hooks.hooks.SessionEnd[0].matcher).toBe("clear");
    // An exact name, so the hook never runs for an MCP tool with "Read" in its name.
    expect(hooks.hooks.PostToolUse[0]).toMatchObject({ matcher: "Read", hooks: [{ command: '"${CLAUDE_PLUGIN_ROOT}"/hooks/post-read.sh', timeout: 3 }] });
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

describe("session notices", () => {
  const END = join(ROOT, "hooks", "session-end.sh");
  const end = (home: string, body: object) =>
    Bun.spawnSync([END], { cwd: plain(), env: { ...process.env, KB_HOME: home }, stdin: Buffer.from(JSON.stringify(body)), stdout: "pipe", stderr: "pipe" });
  const endInput = (cwd: string, session: string, reason = "clear") => ({ session_id: session, transcript_path: `/home/user/${session}.jsonl`, cwd, hook_event_name: "SessionEnd", reason });
  const startInput = (cwd: string, source: string, session = "next") => JSON.stringify({ session_id: session, transcript_path: "/home/user/next.jsonl", cwd, hook_event_name: "SessionStart", source });

  test("a /clear with no checkpoint is reported once, at the next start in the same directory", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    const other = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "g" });
    const r = end(store.home, endInput(repo, "lost"));
    expect({ code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }).toEqual({ code: 0, out: "", err: "" });
    expect(logged(store)).toEqual([{ ev: "unsaved", session: "lost", reason: "clear" }]);

    expect(runHook({ home: store.home, stdin: startInput(other, "clear") }).stdout).not.toContain("/home/user/lost.jsonl");
    const first = runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout;
    expect(first).toContain("### g [gotcha]");
    expect(first).toContain("ended with /clear before /kb:checkpoint ran. Its transcript is /home/user/lost.jsonl.");
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).not.toContain("lost.jsonl");
  });

  // The agent can change directory inside the project, so the two hooks do not always get the same cwd.
  test("a /clear with no checkpoint in a subdirectory is reported at the next start in the repo root", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    const other = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "g" });
    mkdirSync(join(repo, "src"));
    end(store.home, endInput(join(repo, "src"), "lost"));

    expect(runHook({ home: store.home, stdin: startInput(other, "clear") }).stdout).not.toContain("lost.jsonl");
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).toContain("Its transcript is /home/user/lost.jsonl.");
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).not.toContain("lost.jsonl");
  });

  test("no report after a checkpoint, for another end reason, or with no store", () => {
    const store = tempStore();
    const repo = tempRepo();
    putNote(store, { id: "g" });
    expect(kb(store, ["checkpointed", "saved-one", "--json"]).json).toEqual({ session: "saved-one", recorded: true });
    end(store.home, endInput(repo, "saved-one"));
    end(store.home, endInput(repo, "just-quit", "prompt_input_exit"));
    // The log has the checkpoint, and no session that ended unsaved.
    expect(logged(store)).toEqual([{ ev: "checkpoint", session: "saved-one", scope: "global" }]);
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).not.toContain("ended with /clear");

    const missing = join(tempDir(), "missing");
    expect(end(missing, endInput(repo, "x")).exitCode).toBe(0);
    expect(end(missing, {}).exitCode).toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(kb(missing, ["checkpointed", "x", "--json"]).json.recorded).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  test("a notice is shown also when no note is visible", () => {
    const store = tempStore();
    const repo = tempRepo();
    end(store.home, endInput(repo, "lost"));
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toStartWith(`${SAVING}\nAn earlier session`);
  });

  test("after a compaction it says once per start that no checkpoint ran, unless one did", () => {
    const store = tempStore();
    const repo = tempRepo();
    putNote(store, { id: "g" });
    const line = "This session was compacted and /kb:checkpoint has not run in it.";
    expect(runHook({ home: store.home, stdin: startInput(repo, "compact", "s1") }).stdout).toContain(line);
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup", "s1") }).stdout).not.toContain(line);
    kb(store, ["checkpointed", "s1"]);
    expect(runHook({ home: store.home, stdin: startInput(repo, "compact", "s1") }).stdout).not.toContain(line);
  });

  test("more than 5 stale notes give one line, from the cache, and the cache fills in the background", async () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    for (let i = 0; i < 6; i++) putNote(store, { id: `old-${i}`, scope: "github.com/acme/billing", last_verified: "2020-01-01T00:00:00Z" });
    // The first start has no cache: no line, but it starts the checks.
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).not.toContain("may be stale");
    const cache = join(store.home, ".state", "stale.json");
    for (let i = 0; i < 100 && !existsSync(cache); i++) await Bun.sleep(50);
    expect(JSON.parse(readFileSync(cache, "utf8"))["github.com/acme/billing"].notes).toBe(6);
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain("6 kb notes for this scope may be stale. Tell the user in one line, in your first reply, that /kb:audit checks them.");
    // 5 or fewer: no line. A write clears the cache.
    kb(store, ["trash", "old-0"]);
    expect(existsSync(cache)).toBe(false);
    kb(store, ["stale"], { cwd: repo });
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).not.toContain("may be stale");
  });

  test("auto memory that is on gives one line, and the env variable or a settings file turns it off", () => {
    const store = tempStore();
    const repo = tempRepo();
    putNote(store, { id: "g" });
    const run = (env: Record<string, string | undefined>) => runHook({ home: store.home, stdin: startInput(repo, "startup"), env }).stdout;
    const on = tempDir("kb-claude-");
    // The rule to stay out of auto memory is there either way.
    expect(run({})).toContain(MEMORY_RULE);
    expect(run({})).not.toContain(MEMORY_ON_NOTICE);
    expect(run({ CLAUDE_CONFIG_DIR: on })).toContain(MEMORY_ON_NOTICE);
    expect(run({ CLAUDE_CONFIG_DIR: on, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })).not.toContain(MEMORY_ON_NOTICE);
    // A false value forces it on over every setting, as Claude Code does.
    expect(run({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" })).toContain(MEMORY_ON_NOTICE);
    // Once per session: not again after a /clear or a resume.
    for (const source of ["clear", "resume", "compact"]) {
      expect(runHook({ home: store.home, stdin: startInput(repo, source), env: { CLAUDE_CONFIG_DIR: on } }).stdout).not.toContain(MEMORY_ON_NOTICE);
    }
    // The project's local settings win over the user's.
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ autoMemoryEnabled: true }));
    expect(run({})).toContain(MEMORY_ON_NOTICE);
    expect(run({ CLAUDE_PROJECT_DIR: plain() })).not.toContain(MEMORY_ON_NOTICE);
  });

  test("a store over its index budget gives one line, and a store within it gives none", () => {
    const store = tempStore();
    const repo = tempRepo();
    // Long bodies: one fits the small budget below, so the other three need an index line each.
    for (let i = 0; i < 4; i++) putNote(store, { id: `n-${i}`, body: "x".repeat(400) });
    const line = "The kb store is over its index budget here";
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).not.toContain(line);
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 2, contextChars: 1100 } }));
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain(`${line}: 1 note is hidden from the index. Tell the user in one line, in your first reply, that /kb:audit fixes this.`);
  });

  test("the state directory stays out of git, also in a store made by an older version", () => {
    const store = tempStore();
    writeFileSync(join(store.home, ".gitignore"), "INDEX.md\nindex.html\nlocal.json\n.sync-*\n*.tmp-*\n");
    Bun.spawnSync(["git", "-C", store.home, "init", "-q", "-b", "main"]);
    putNote(store, { id: "g" });
    kb(store, ["checkpointed", "s1"]);
    kb(store, ["show", "g"]);
    kb(store, ["verify", "g"]);
    const tracked = Bun.spawnSync(["git", "-C", store.home, "ls-files"], { stdout: "pipe" }).stdout.toString();
    expect(tracked).toContain(".gitignore");
    expect(tracked).not.toContain(".state");
  });

  test("the PreCompact hook prints static summary instructions and needs no bun", () => {
    const bin = tempDir("kb-nobun-");
    for (const tool of ["sh", "cat"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
    const r = Bun.spawnSync([join(ROOT, "hooks", "pre-compact.sh")], { env: { PATH: bin }, stdin: Buffer.from("{}"), stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("unfinished work");
    expect(r.stdout.toString().length).toBeLessThan(1000);
  });
});
