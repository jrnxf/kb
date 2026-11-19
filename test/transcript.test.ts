import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConversation, worthRecovering } from "../hooks/transcript.ts";
import { ROOT, tempDir } from "./helpers.ts";

const write = (lines: (object | string)[]) => {
  const path = join(tempDir("kb-transcript-"), "s1.jsonl");
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
  return path;
};
const user = (content: unknown, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const agent = (content: unknown[], extra = {}) => ({ type: "assistant", message: { role: "assistant", content }, ...extra });

// /kb:recover hands this text to a subagent. A tool result can hold a secret, so it must never get through.
describe("the transcript reader", () => {
  const path = write([
    { type: "summary", summary: "a title" },
    user("Fix the login bug <system-reminder>harness text</system-reminder>"),
    agent([{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "I will look." }]),
    agent([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "API_KEY=SECRET123" }]),
    agent([{ type: "text", text: "The cookie had no SameSite." }]),
    user([{ type: "text", text: "Why?" }, { type: "image", source: {} }]),
    user("sidechain prompt", { isSidechain: true }),
    agent([{ type: "text", text: "subagent work" }], { isSidechain: true }),
    user("Summary of the earlier part", { isCompactSummary: true }),
    user("<local-command-stdout>output of /cost</local-command-stdout>"),
    user("Caveat: ...", { isMeta: true }),
    "{not json",
    agent([{ type: "text", text: "Because the proxy drops it." }]),
  ]);

  test("keeps what the user and the agent said, one heading per turn", () => {
    expect(readConversation(path)).toEqual({
      prompts: 2,
      chars: expect.any(Number),
      text: "## user\n\nFix the login bug\n\n## agent\n\nI will look.\n\nThe cookie had no SameSite.\n\n## user\n\nWhy?\n\n## agent\n\nBecause the proxy drops it.\n",
    });
  });

  test("leaves out tool calls, tool output, thinking, subagents and harness text", () => {
    const { text } = readConversation(path);
    for (const left of ["SECRET123", ".env", "private reasoning", "subagent work", "harness text", "/cost", "Summary of the earlier part", "Caveat"]) expect(text).not.toContain(left);
  });

  test("a file that cannot be read has size 0, and the script writes the text to a file", () => {
    expect(worthRecovering(join(tempDir(), "missing.jsonl"))).toEqual({ prompts: 0, chars: 0 });
    const r = Bun.spawnSync([process.execPath, join(ROOT, "hooks", "transcript.ts"), path], { stdout: "pipe" });
    const out = JSON.parse(r.stdout.toString());
    expect(out).toMatchObject({ prompts: 2 });
    expect(readFileSync(out.file, "utf8")).toBe(readConversation(path).text);
  });
});
