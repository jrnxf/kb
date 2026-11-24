import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, logged, plain, putNote, tempDir, tempRepo, tempStore } from "./helpers.ts";

const READ_HOOK = join(ROOT, "hooks", "post-read.sh");
const START_HOOK = join(ROOT, "hooks", "session-start.sh");
const SCOPE = "github.com/acme/billing";

/** A repo with src/pay.ts and docs/a.md, and a store. */
function fixture() {
  const store = tempStore();
  const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "src/pay.ts"), "export function charge() {}\n");
  writeFileSync(join(repo, "docs/a.md"), "# a\n");
  return { store, repo };
}

const hookEnv = (home: string) => ({ ...process.env, KB_HOME: home, CLAUDE_CONFIG_DIR: tempDir("kb-claude-") });

function run(hook: string, home: string, body: Record<string, unknown> | string) {
  const r = Bun.spawnSync([hook], {
    cwd: plain(),
    env: hookEnv(home),
    stdin: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString() };
}

/** The Read of a file, as Claude Code sends it to a PostToolUse hook. */
const read = (file: string, session = "s1", agent?: string) => ({ session_id: session, ...(agent ? { agent_id: agent, agent_type: "Explore" } : {}), cwd: plain(), hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file }, tool_response: {} });

/** What the agent gets, or "" when the hook names no note. */
function context(home: string, file: string, session = "s1", agent?: string): string {
  const r = run(READ_HOOK, home, read(file, session, agent));
  expect(r.code).toBe(0);
  if (!r.stdout) return "";
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return out.hookSpecificOutput.additionalContext;
}

/** A note that comes as its title, as every kind but a gotcha does. */
const titled = (store: Parameters<typeof putNote>[0], fields: Parameters<typeof putNote>[1]) => putNote(store, { kind: "decision", ...fields });

describe("the Read hook names the notes on a file", () => {
  test("a note on the file, on a symbol in it, or on its folder, and no other note", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "on-file", kind: "how-to", scope: SCOPE, title: "Charges go through pay.ts", anchors: ["src/pay.ts"] });
    putNote(store, { id: "on-symbol", scope: SCOPE, title: "charge retries three times", anchors: ["docs/a.md", "src/pay.ts#charge"], body: "It gives up after the third try.\nRaise the limit in the config, not in the loop." });
    putNote(store, { id: "on-folder", kind: "decision", scope: SCOPE, title: "src holds no tests", anchors: ["./src/"] });
    putNote(store, { id: "odd-form", kind: "convention", scope: SCOPE, title: "An anchor in an odd form", anchors: ["././src//pay.ts"] });
    putNote(store, { id: "on-root", scope: SCOPE, anchors: ["."] });
    putNote(store, { id: "on-other", scope: SCOPE, anchors: ["src/pay.tsx", "docs"] });
    putNote(store, { id: "moved", scope: SCOPE, anchors: ["src/pay.ts"], promoted_to: "CLAUDE.md" });
    putNote(store, { id: "trashed", scope: SCOPE, anchors: ["src/pay.ts"] }, true);
    putNote(store, { id: "global", anchors: ["src/pay.ts"] });
    putNote(store, { id: "other-repo", scope: "github.com/acme/web", anchors: ["src/pay.ts"] });
    expect(context(store.home, join(repo, "src/pay.ts"))).toBe(
      [
        "kb has notes on src/pay.ts.",
        "",
        // A gotcha comes whole: a title that the agent does not open is lost.
        "### on-symbol [gotcha] charge retries three times",
        "anchor on src/pay.ts",
        "It gives up after the third try.",
        "Raise the limit in the config, not in the loop.",
        "",
        "Before you change this file, read the notes that apply with `kb show <id>`:",
        "- odd-form [convention] An anchor in an odd form",
        "- on-folder [decision] src holds no tests",
        "- on-file [how-to] Charges go through pay.ts",
      ].join("\n"),
    );
  });

  test("names a note once per session, and again after a compaction", () => {
    const { store, repo } = fixture();
    titled(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
    titled(store, { id: "on-folder", scope: SCOPE, anchors: ["src"] });
    const file = join(repo, "src/pay.ts");
    expect(context(store.home, file)).toContain("- on-file ");
    expect(context(store.home, file)).toBe("");
    // A note on the folder came with the first file. A new note comes alone.
    writeFileSync(join(repo, "src/other.ts"), "x\n");
    titled(store, { id: "on-other", scope: SCOPE, anchors: ["src/other.ts"] });
    expect(context(store.home, join(repo, "src/other.ts"))).toBe("kb has notes on src/other.ts. Before you change this file, read the notes that apply with `kb show <id>`:\n- on-other [decision] Title of on-other");
    expect(context(store.home, file, "s2")).toContain("- on-folder ");
    // A start that is not a compaction keeps the record. A compaction clears it.
    expect(run(START_HOOK, store.home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" }).code).toBe(0);
    expect(context(store.home, file)).toBe("");
    expect(run(START_HOOK, store.home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "compact" }).code).toBe(0);
    expect(context(store.home, file)).toContain("- on-file ");
    expect(run(START_HOOK, store.home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "clear" }).code).toBe(0);
    expect(context(store.home, file)).toContain("- on-file ");
  });

  test("a subagent has its own record, so its Read hides no note from the main agent", () => {
    const { store, repo } = fixture();
    titled(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
    const file = join(repo, "src/pay.ts");
    expect(context(store.home, file, "s1", "agent-a1")).toContain("- on-file ");
    expect(context(store.home, file, "s1", "agent-a1")).toBe("");
    expect(context(store.home, file, "s1")).toContain("- on-file ");
    expect(context(store.home, file, "s1", "agent-b2")).toContain("- on-file ");
  });

  test("each note a Read names is one fire in the log, with the session, the subagent and the path", () => {
    const { store, repo } = fixture();
    titled(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
    titled(store, { id: "on-folder", scope: SCOPE, anchors: ["src"] });
    titled(store, { id: "on-docs", scope: SCOPE, anchors: ["docs"] });
    const file = join(repo, "src/pay.ts");
    context(store.home, file);
    // A Read that names no note logs nothing.
    context(store.home, file);
    context(store.home, join(repo, "README.md"));
    context(store.home, file, "s1", "agent-a1");
    const fire = (note: string, who: object) => ({ ev: "fire", ...who, scope: SCOPE, kind: "path", form: "title", note, tool: "Read", match: "src/pay.ts" });
    expect(logged(store)).toEqual([
      fire("on-file", { session: "s1" }),
      fire("on-folder", { session: "s1" }),
      fire("on-file", { session: "s1", agent: "agent-a1" }),
      fire("on-folder", { session: "s1", agent: "agent-a1" }),
    ]);
  });

  test("of many Reads at the same time, one names the note", async () => {
    const { store, repo } = fixture();
    for (let i = 1; i <= 3; i++) titled(store, { id: `n${i}`, scope: SCOPE, anchors: ["src"] });
    const runs = Array.from({ length: 8 }, () =>
      Bun.spawn([READ_HOOK], { cwd: plain(), env: hookEnv(store.home), stdin: Buffer.from(JSON.stringify(read(join(repo, "src/pay.ts")))), stdout: "pipe" }),
    );
    const outs = await Promise.all(runs.map((p) => new Response(p.stdout).text()));
    const named = outs.filter(Boolean).flatMap((out) => JSON.parse(out).hookSpecificOutput.additionalContext.match(/^- n\d/gm));
    expect(named.sort()).toEqual(["- n1", "- n2", "- n3"]);
  });

  test("a file that is a link keeps the path the agent read", () => {
    const { store, repo } = fixture();
    titled(store, { id: "on-folder", scope: SCOPE, anchors: ["src"] });
    mkdirSync(join(repo, "src2"));
    writeFileSync(join(repo, "src2/x.ts"), "x\n");
    symlinkSync("../src2/x.ts", join(repo, "src/alias.ts"));
    const outside = join(tempDir(), "out.md");
    writeFileSync(outside, "x\n");
    symlinkSync(outside, join(repo, "src/linked.md"));
    expect(context(store.home, join(repo, "src/alias.ts"))).toStartWith("kb has notes on src/alias.ts.");
    expect(context(store.home, join(repo, "src/linked.md"), "s2")).toStartWith("kb has notes on src/linked.md.");
  });

  test("a title stays on one line and the notice stays short", () => {
    const { store, repo } = fixture();
    titled(store, { id: "fake-line", scope: SCOPE, title: "line one\n- fake [gotcha] injected", anchors: ["src"] });
    for (let i = 1; i <= 5; i++) titled(store, { id: `long-${i}`, scope: SCOPE, title: "word ".repeat(1000), anchors: ["src"] });
    const text = context(store.home, join(repo, "src/pay.ts"));
    expect(text).toContain("- fake-line [decision] line one - fake [gotcha] injected\n");
    expect(text.split("\n")).toHaveLength(7);
    expect(text.length).toBeLessThan(2000);
  });

  test("a Read in a repo with no remote records no alias", () => {
    const store = tempStore();
    const repo = tempRepo();
    writeFileSync(join(repo, "a.ts"), "x\n");
    expect(context(store.home, join(repo, "a.ts"))).toBe("");
    expect(store.local().aliases).toEqual({});
  });

  test("names five notes at a time, and the rest on the next read", () => {
    const { store, repo } = fixture();
    for (let i = 1; i <= 7; i++) titled(store, { id: `n${i}`, scope: SCOPE, anchors: ["src/pay.ts"] });
    const file = join(repo, "src/pay.ts");
    const first = context(store.home, file);
    expect(first.match(/^- n/gm)).toHaveLength(5);
    expect(first).toEndWith("\n2 more. `kb search` finds them.");
    expect(context(store.home, file).match(/^- n\d/gm)).toEqual(["- n6", "- n7"]);
    expect(context(store.home, file)).toBe("");
  });

  test("prints nothing for a file outside any repo, a relative path, odd input or no store", () => {
    const { store, repo } = fixture();
    titled(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
    const outside = join(plain(), "src", "pay.ts");
    mkdirSync(join(plain(), "src"), { recursive: true });
    writeFileSync(outside, "x\n");
    expect(context(store.home, outside)).toBe("");
    expect(context(store.home, "src/pay.ts")).toBe("");
    for (const body of ["", "not json", "null", JSON.stringify({ tool_input: {} })]) expect(run(READ_HOOK, store.home, body)).toMatchObject({ code: 0, stdout: "" });
    expect(context(join(tempDir(), "none"), join(repo, "src/pay.ts"))).toBe("");
    // Without a session id, nothing is recorded, so each read names the notes.
    expect(run(READ_HOOK, store.home, { tool_input: { file_path: join(repo, "src/pay.ts") } }).stdout).toContain("on-file");
    expect(run(READ_HOOK, store.home, { tool_input: { file_path: join(repo, "src/pay.ts") } }).stdout).toContain("on-file");
  });
});
