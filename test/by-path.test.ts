import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, plain, putNote, tempDir, tempRepo, tempStore } from "./helpers.ts";

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

function run(hook: string, home: string, body: Record<string, unknown> | string) {
  const started = performance.now();
  const r = Bun.spawnSync([hook], {
    cwd: plain(),
    env: { ...process.env, KB_HOME: home, CLAUDE_CONFIG_DIR: tempDir("kb-claude-") },
    stdin: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), ms: performance.now() - started };
}

/** The Read of a file, as Claude Code sends it to a PostToolUse hook. */
const read = (file: string, session = "s1") => ({ session_id: session, cwd: plain(), hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: file }, tool_response: {} });

/** What the agent gets, or "" when the hook names no note. */
function context(home: string, file: string, session = "s1"): string {
  const r = run(READ_HOOK, home, read(file, session));
  expect(r.code).toBe(0);
  if (!r.stdout) return "";
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return out.hookSpecificOutput.additionalContext;
}

describe("the Read hook names the notes on a file", () => {
  test("a note on the file, on a symbol in it, or on its folder, and no other note", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "on-file", kind: "how-to", scope: SCOPE, title: "Charges go through pay.ts", anchors: ["src/pay.ts"] });
    putNote(store, { id: "on-symbol", scope: SCOPE, title: "charge retries three times", anchors: ["docs/a.md", "src/pay.ts#charge"] });
    putNote(store, { id: "on-folder", kind: "decision", scope: SCOPE, title: "src holds no tests", anchors: ["src/"] });
    putNote(store, { id: "on-root", scope: SCOPE, anchors: ["."] });
    putNote(store, { id: "on-other", scope: SCOPE, anchors: ["src/pay.tsx", "docs"] });
    putNote(store, { id: "moved", scope: SCOPE, anchors: ["src/pay.ts"], promoted_to: "CLAUDE.md" });
    putNote(store, { id: "trashed", scope: SCOPE, anchors: ["src/pay.ts"] }, true);
    putNote(store, { id: "global", anchors: ["src/pay.ts"] });
    putNote(store, { id: "other-repo", scope: "github.com/acme/web", anchors: ["src/pay.ts"] });
    const r = run(READ_HOOK, store.home, read(join(repo, "src/pay.ts")));
    expect(r.ms).toBeLessThan(1500);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(
      [
        "kb has notes on src/pay.ts. Before you change this file, read the notes that apply with `kb show <id>`:",
        "- on-symbol [gotcha] charge retries three times",
        "- on-folder [decision] src holds no tests",
        "- on-file [how-to] Charges go through pay.ts",
      ].join("\n"),
    );
  });

  test("names a note once per session, and again after a compaction", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
    putNote(store, { id: "on-folder", scope: SCOPE, anchors: ["src"] });
    const file = join(repo, "src/pay.ts");
    expect(context(store.home, file)).toContain("- on-file ");
    expect(context(store.home, file)).toBe("");
    // A note on the folder came with the first file. A new note comes alone.
    writeFileSync(join(repo, "src/other.ts"), "x\n");
    putNote(store, { id: "on-other", scope: SCOPE, anchors: ["src/other.ts"] });
    expect(context(store.home, join(repo, "src/other.ts"))).toBe("kb has notes on src/other.ts. Before you change this file, read the notes that apply with `kb show <id>`:\n- on-other [gotcha] Title of on-other");
    expect(context(store.home, file, "s2")).toContain("- on-folder ");
    // A start that is not a compaction keeps the record. A compaction clears it.
    expect(run(START_HOOK, store.home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "resume" }).code).toBe(0);
    expect(context(store.home, file)).toBe("");
    expect(run(START_HOOK, store.home, { session_id: "s1", cwd: repo, hook_event_name: "SessionStart", source: "compact" }).code).toBe(0);
    expect(context(store.home, file)).toContain("- on-file ");
  });

  test("names five notes at a time, and the rest on the next read", () => {
    const { store, repo } = fixture();
    for (let i = 1; i <= 7; i++) putNote(store, { id: `n${i}`, scope: SCOPE, anchors: ["src/pay.ts"] });
    const file = join(repo, "src/pay.ts");
    const first = context(store.home, file);
    expect(first.match(/^- n/gm)).toHaveLength(5);
    expect(first).toEndWith("\n2 more. `kb search` finds them.");
    expect(context(store.home, file).match(/^- n\d/gm)).toEqual(["- n6", "- n7"]);
    expect(context(store.home, file)).toBe("");
  });

  test("prints nothing for a file outside any repo, a relative path, odd input or no store", () => {
    const { store, repo } = fixture();
    putNote(store, { id: "on-file", scope: SCOPE, anchors: ["src/pay.ts"] });
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
