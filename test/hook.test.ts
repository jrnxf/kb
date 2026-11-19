import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SAVE_RULE } from "../cli/context.ts";
import { MEMORY_ON_NOTICE, MEMORY_RULE } from "../hooks/auto-memory.ts";
import { ROOT, kb, plain, putNote, tempDir, tempRepo, tempStore } from "./helpers.ts";

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

// Auto memory is off in QUIET_CONFIG, so its rule is not there.
const SAVING = `# kb\n${SAVE_RULE}\n`;

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

  test("stays under the 10,000 character limit at the largest budget, with every notice", () => {
    const store = tempStore();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 1, contextChars: 20000 } }));
    for (let i = 0; i < 40; i++) putNote(store, { id: `big-${i}`, body: "x".repeat(400) });
    const repo = tempRepo();
    const END = join(ROOT, "hooks", "session-end.sh");
    const dir = tempDir("kb-transcripts-");
    for (let i = 0; i < 20; i++) {
      const path = join(dir, `${"t".repeat(150)}-${i}.jsonl`);
      const prompt = JSON.stringify({ type: "user", message: { content: "x".repeat(2000) } });
      writeFileSync(path, `${prompt}\n${prompt}\n`);
      const body = { session_id: `lost-${i}`, transcript_path: path, cwd: repo, hook_event_name: "SessionEnd", reason: "clear" };
      Bun.spawnSync([END], { env: { ...process.env, KB_HOME: store.home }, stdin: Buffer.from(JSON.stringify(body)) });
    }
    const out = runHook({ home: store.home, stdin: input(repo), env: { CLAUDE_CONFIG_DIR: tempDir("kb-claude-") } }).stdout;
    expect(out).toContain("20 earlier sessions here ended with /clear");
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

  // /kb:recover hands the checkpoint skill to a subagent by step number and section name.
  test("the recover skill names steps and sections that the checkpoint skill has", () => {
    const recover = readFileSync(join(ROOT, "skills", "recover", "SKILL.md"), "utf8");
    const checkpoint = readFileSync(join(ROOT, "skills", "checkpoint", "SKILL.md"), "utf8");
    expect(recover).toContain("Follow steps 1, 2, 3, 4 and 7 of");
    for (const heading of ["## 1. ", "## 2. ", "## 3. ", "## 4. ", "## 5. ", "## 6. ", "## 7. Report"]) expect(checkpoint).toContain(`\n${heading}`);
    for (const section of ["Move Claude Code's auto memory into kb", "Write a rule"]) {
      expect(recover).toContain(`"${section}"`);
      expect(checkpoint).toContain(`\n### ${section}\n`);
    }
    expect(existsSync(join(ROOT, "skills", "recover", "..", "checkpoint", "SKILL.md"))).toBe(true);
  });

  // The skill reads what an old session said, which is untrusted text. It allows by name only what it runs.
  test("the recover skill allows only the commands that it and its subagent run", () => {
    const recover = readFileSync(join(ROOT, "skills", "recover", "SKILL.md"), "utf8");
    const checkpoint = readFileSync(join(ROOT, "skills", "checkpoint", "SKILL.md"), "utf8");
    const allowed = /^allowed-tools: (.*)$/m.exec(recover)![1]!.split(", ");
    const commands = allowed.filter((tool) => tool.startsWith("Bash(")).map((tool) => tool.slice(5, -1));
    // A fixed command name, then a wildcard: a wildcard in front of or inside the name allows other programs.
    for (const command of commands) expect(command).toMatch(/^(kb [a-z-]+ ?|kb-transcript )\*$/);
    expect(allowed.filter((tool) => !tool.startsWith("Bash("))).toEqual(["Read", "Agent"]);
    const names = commands.map((command) => command.replace(/ ?\*$/, ""));
    // Every command in the skill, and in the checkpoint steps that the subagent follows, has its line.
    const steps = checkpoint.slice(checkpoint.indexOf("\n## 1. "), checkpoint.indexOf("\n## 5. ")).replace(/### Move Claude Code's auto memory into kb[\s\S]*?(?=\n## 3\. )/, "");
    const run = [...`${recover}\n${steps}`.matchAll(/`(kb(?:-transcript| [a-z-]+))\b[^`]*`/g)].map((match) => match[1]!);
    expect(run).toContain("kb-transcript");
    expect([...new Set(run)].filter((name) => !names.includes(name))).toEqual([]);
    for (const name of names) expect(run).toContain(name);
    expect(statSync(join(ROOT, "bin", "kb-transcript")).mode & 0o111).toBe(0o111);
  });

  // The subagent reads an old session. Only the main session, after the user settled the rules, says that it is saved.
  test("the recover skill marks a session last, and its report never reads as a verdict on this session", () => {
    const recover = readFileSync(join(ROOT, "skills", "recover", "SKILL.md"), "utf8");
    const prompt = recover.split("\n").filter((line) => line.startsWith("> ")).join("\n");
    expect(prompt).toContain("Never run `kb checkpointed`.");
    expect(prompt.replace("Never run `kb checkpointed`.", "")).not.toContain("kb checkpointed");
    expect(recover.indexOf("kb checkpointed <session>")).toBeGreaterThan(recover.indexOf("## 5. Settle the rules, then mark each session"));
    expect(prompt).toContain("**Recovered the session of <date of ended> in <cwd>**");
    expect(prompt).toContain('Never write "Safe to clear".');
    expect(recover).toContain("This session still needs its own /kb:checkpoint if it did other work.");
    // A note from an old conversation is verified when the session ended, and it is a guess until somebody checks it.
    expect(prompt).toContain("Pass `--as-of <ended>` to every `kb add`.");
    expect(prompt).toContain('Set `"confidence": "low"`');
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
  // A transcript on disk, long enough to recover: a session whose transcript is gone or short is forgotten.
  const transcripts = tempDir("kb-transcripts-");
  const transcript = (session: string, prompts = 3) => {
    const path = join(transcripts, `${session}.jsonl`);
    const turn = (type: string, text: string) => JSON.stringify({ type, message: { content: [{ type: "text", text }] } });
    writeFileSync(path, Array.from({ length: prompts }, (_, i) => [turn("user", `prompt ${i} ${"word ".repeat(300)}`), turn("assistant", "answer")]).flat().join("\n"));
    return path;
  };
  const endInput = (cwd: string, session: string, reason = "clear", path = transcript(session)) => ({ session_id: session, transcript_path: path, cwd, hook_event_name: "SessionEnd", reason });
  const startInput = (cwd: string, source: string, session = "next") => JSON.stringify({ session_id: session, transcript_path: "/home/user/next.jsonl", cwd, hook_event_name: "SessionStart", source });
  const NOTICE = "An earlier session here ended with /clear before /kb:checkpoint ran. Tell the user in one line, in your first reply, that /kb:recover saves its knowledge or forgets it.";
  const unsaved = (store: ReturnType<typeof tempStore>, cwd: string) => kb(store, ["unsaved", "--json"], { cwd }).json.map((s: { session: string }) => s.session);

  test("a /clear with no checkpoint is reported at each new start in the same directory, until it is recovered", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    const other = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "g" });
    const r = end(store.home, endInput(repo, "lost"));
    expect({ code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }).toEqual({ code: 0, out: "", err: "" });

    expect(runHook({ home: store.home, stdin: startInput(other, "clear") }).stdout).not.toContain(NOTICE);
    expect(unsaved(store, other)).toEqual([]);
    const first = runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout;
    expect(first).toContain("### g [gotcha]");
    expect(first).toContain(NOTICE);
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain(NOTICE);
    // A resume or a compaction is the same session, which already had the notice.
    for (const source of ["resume", "compact"]) expect(runHook({ home: store.home, stdin: startInput(repo, source) }).stdout).not.toContain(NOTICE);
    expect(unsaved(store, repo)).toEqual(["lost"]);
    expect(kb(store, ["unsaved", "--json"], { cwd: repo }).json[0]).toMatchObject({ session: "lost", transcript: join(transcripts, "lost.jsonl"), cwd: repo });

    // /kb:recover ends with the old session's checkpoint.
    kb(store, ["checkpointed", "lost"]);
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).not.toContain(NOTICE);
    expect(unsaved(store, repo)).toEqual([]);
  });

  test("forget stops the notice, and two sessions give one line", () => {
    const store = tempStore();
    const repo = tempRepo();
    end(store.home, endInput(repo, "one"));
    end(store.home, endInput(repo, "two"));
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain("2 earlier sessions here ended with /clear before /kb:checkpoint ran. Tell the user in one line, in your first reply, that /kb:recover saves their knowledge or forgets them.");
    expect(kb(store, ["unsaved", "--forget", "one", "--json"], { cwd: repo }).json).toEqual({ session: "one", forgotten: true });
    expect(kb(store, ["unsaved", "--forget", "one", "--json"], { cwd: repo }).json).toEqual({ session: "one", forgotten: false });
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain(NOTICE);
    expect(unsaved(store, repo)).toEqual(["two"]);
  });

  test("a short session, or one whose transcript is gone, is forgotten with no notice", () => {
    const store = tempStore();
    const repo = tempRepo();
    end(store.home, endInput(repo, "headless", "clear", transcript("headless", 1)));
    end(store.home, endInput(repo, "gone", "clear", join(transcripts, "missing.jsonl")));
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).not.toContain("ended with /clear");
    expect(unsaved(store, repo)).toEqual([]);
  });

  // A read that fails is not a short session. Only a transcript that is gone, or one measured as short, ends a mark.
  test("a transcript that cannot be read now keeps its mark, and a later start reports it", () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const store = tempStore();
    const repo = tempRepo();
    const path = transcript("locked");
    end(store.home, endInput(repo, "locked", "clear", path));
    chmodSync(path, 0o000);
    try {
      expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).not.toContain("ended with /clear");
      expect(unsaved(store, repo)).toEqual(["locked"]);
    } finally {
      chmodSync(path, 0o600);
    }
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain(NOTICE);
  });

  // A slash command is no prompt, and a /kb:recover turn is the report on another session.
  test("a session that only cleared and asked once, or only ran /kb:recover, is forgotten", () => {
    const store = tempStore();
    const repo = tempRepo();
    const say = (type: string, content: unknown) => JSON.stringify({ type, message: { content } });
    const long = "word ".repeat(700);
    const cleared = say("user", "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>");
    const recover = [
      say("user", "<command-message>kb:recover</command-message>\n<command-name>/kb:recover</command-name>"),
      say("assistant", [{ type: "text", text: `**Recovered the session of 2026-01-05 in /home/user/shop** ${long}` }]),
      say("assistant", [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }]),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "answered" }] }, toolUseResult: { answers: { "Does the rule still hold?": "Still holds" } } }),
      say("assistant", [{ type: "text", text: `I wrote the rule. ${long}` }]),
    ];
    const work = [say("user", `Fix the cart total ${long}`), say("assistant", [{ type: "text", text: "Done." }]), say("user", "Now the rounding"), say("assistant", [{ type: "text", text: "Done." }])];
    const sessions: Record<string, string[]> = {
      "one-prompt": [cleared, say("user", `Fix the login bug ${long}`), say("assistant", [{ type: "text", text: "Done." }])],
      "recover-only": [cleared, ...recover],
      "recover-and-work": [cleared, ...recover, ...work],
    };
    for (const [session, lines] of Object.entries(sessions)) {
      const path = join(transcripts, `${session}.jsonl`);
      writeFileSync(path, lines.join("\n"));
      end(store.home, endInput(repo, session, "clear", path));
    }
    expect(unsaved(store, repo).sort()).toEqual(["one-prompt", "recover-and-work", "recover-only"]);
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toContain(NOTICE);
    expect(unsaved(store, repo)).toEqual(["recover-and-work"]);
  });

  // The hook gets the directory from Claude Code and `kb unsaved` from the shell. A notice that the
  // skill cannot list would never clear.
  test("outside a repo, a directory matches through a link", () => {
    const store = tempStore();
    const dir = tempDir("kb-plain-");
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);
    end(store.home, endInput(link, "lost"));
    expect(runHook({ home: store.home, stdin: startInput(dir, "startup") }).stdout).toContain(NOTICE);
    expect(unsaved(store, dir)).toEqual(["lost"]);
    expect(unsaved(store, link)).toEqual(["lost"]);
  });

  // A /clear start does three things: it forgets the Read record, checks the anchors and names the unsaved session.
  test("a /clear start names the unsaved session, lists the anchors that are gone, and lets a Read name its notes again", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    const scope = "github.com/acme/billing";
    putNote(store, { id: "on-readme", scope, anchors: ["README.md"] });
    putNote(store, { id: "deleted", scope, anchors: ["src/rates.ts"] });
    const body = { session_id: "next", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: join(repo, "README.md") }, tool_response: {} };
    const read = () => Bun.spawnSync([join(ROOT, "hooks", "post-read.sh")], { cwd: plain(), env: { ...process.env, KB_HOME: store.home }, stdin: Buffer.from(JSON.stringify(body)), stdout: "pipe", stderr: "pipe" }).stdout.toString();
    expect(read()).toContain("- on-readme ");
    expect(read()).toBe("");
    end(store.home, endInput(repo, "lost"));

    const out = runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout;
    expect(out).toContain("## Anchors gone");
    expect(out).toContain("- deleted: src/rates.ts does not exist");
    expect(out).toContain(NOTICE);
    expect(read()).toContain("- on-readme ");
    expect(unsaved(store, repo)).toEqual(["lost"]);
  });

  // The agent can change directory inside the project, so the two hooks do not always get the same cwd.
  test("a /clear with no checkpoint in a subdirectory is reported at the next start in the repo root", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    const other = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "g" });
    mkdirSync(join(repo, "src"));
    end(store.home, endInput(join(repo, "src"), "lost"));

    expect(runHook({ home: store.home, stdin: startInput(other, "clear") }).stdout).not.toContain(NOTICE);
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).toContain(NOTICE);
    expect(unsaved(store, repo)).toEqual(["lost"]);
  });

  test("no report after a checkpoint, for another end reason, from a subagent, or with no store", () => {
    const store = tempStore();
    const repo = tempRepo();
    putNote(store, { id: "g" });
    expect(kb(store, ["checkpointed", "saved-one", "--json"]).json).toEqual({ session: "saved-one", recorded: true });
    end(store.home, endInput(repo, "saved-one"));
    end(store.home, endInput(repo, "just-quit", "prompt_input_exit"));
    end(store.home, { ...endInput(repo, "subagent"), agent_id: "agent-a1" });
    expect(runHook({ home: store.home, stdin: startInput(repo, "clear") }).stdout).not.toContain("ended with /clear");

    const missing = join(tempDir(), "missing");
    expect(end(missing, endInput(repo, "x")).exitCode).toBe(0);
    expect(end(missing, {}).exitCode).toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(kb(missing, ["checkpointed", "x", "--json"]).json.recorded).toBe(false);
    expect(kb(missing, ["unsaved", "--json"]).json).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  test("a notice is shown also when no note is visible", () => {
    const store = tempStore();
    const repo = tempRepo();
    end(store.home, endInput(repo, "lost"));
    expect(runHook({ home: store.home, stdin: startInput(repo, "startup") }).stdout).toStartWith(`${SAVING}\n${NOTICE}`);
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

  test("the rule to stay out of auto memory comes only while auto memory is on, at every start", () => {
    const store = tempStore();
    const repo = tempRepo();
    putNote(store, { id: "g" });
    const on = tempDir("kb-claude-");
    const start = (source: string, env: Record<string, string | undefined> = {}, home = store.home) => runHook({ home, stdin: startInput(repo, source), env }).stdout;
    for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
      // Off: the fixed text is the header, the format line and the save rule.
      expect(start(source)).not.toContain(MEMORY_RULE);
      expect(start(source)).toContain(`${SAVE_RULE}\n\n## Notes`);
      // On: the rule is right under the save rule, also after a compaction.
      expect(start(source, { CLAUDE_CONFIG_DIR: on })).toContain(`${SAVE_RULE}\n${MEMORY_RULE}\n\n## Notes`);
    }
    expect(start("compact", { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" })).toContain(MEMORY_RULE);
    expect(start("compact", { CLAUDE_CONFIG_DIR: on, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })).not.toContain(MEMORY_RULE);
    // The text for a missing or a broken store follows the same setting.
    const missing = join(tempDir(), "missing");
    expect(start("resume", { CLAUDE_CONFIG_DIR: on }, missing)).toBe(`# kb\n${SAVE_RULE}\n${MEMORY_RULE}\n`);
    expect(start("resume", {}, missing)).toBe(SAVING);
    const broken = join(tempDir(), "file");
    writeFileSync(broken, "x");
    expect(start("resume", { CLAUDE_CONFIG_DIR: on }, broken)).toBe(`# kb\n${SAVE_RULE}\n${MEMORY_RULE}\n`);
    expect(start("resume", {}, broken)).toBe(SAVING);
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
    kb(store, ["use", "g"]);
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
