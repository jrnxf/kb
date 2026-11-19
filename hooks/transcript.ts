// Reads a Claude Code transcript (.jsonl) and keeps only what the user and the agent said.
// Tool calls and tool results are left out: they are large, and a tool result can hold a secret.
// `bun hooks/transcript.ts <transcript>` writes the conversation to a temp file for /kb:recover.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface Conversation {
  /** The prompts the user typed. */
  prompts: number;
  /** The length of `text`. */
  chars: number;
  /** The conversation as Markdown: a heading per turn, then its text. */
  text: string;
}

type Block = { type?: string; text?: string };
type Line = { type?: string; isMeta?: boolean; isSidechain?: boolean; isCompactSummary?: boolean; message?: { content?: string | Block[] } };

// The harness adds these to user turns. They are not the user's words.
const NOISE = /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>/g;

function words(content: string | Block[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // A user turn that holds tool_result blocks is the answer of a tool, not the user.
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n\n");
}

export function readConversation(path: string): Conversation {
  const turns: { role: "user" | "agent"; text: string }[] = [];
  let prompts = 0;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    // A compaction summary repeats turns the file still holds. A sidechain is a subagent's own work.
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta || line.isSidechain || line.isCompactSummary) continue;
    const text = words(line.message?.content).replace(NOISE, "").trim();
    if (!text) continue;
    const role = line.type === "user" ? "user" : "agent";
    if (role === "user") prompts++;
    const last = turns.at(-1);
    // The agent's text arrives in several lines per turn. Join them, so each turn has one heading.
    if (last?.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  }
  const text = turns.map((turn) => `## ${turn.role}\n\n${turn.text}\n`).join("\n");
  return { prompts, chars: text.length, text };
}

/** The size of a transcript's conversation, or 0 and 0 when the file cannot be read. */
export function worthRecovering(path: string): { prompts: number; chars: number } {
  try {
    const { prompts, chars } = readConversation(path);
    return { prompts, chars };
  } catch {
    return { prompts: 0, chars: 0 };
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun hooks/transcript.ts <transcript.jsonl>");
    process.exit(1);
  }
  const conversation = readConversation(path);
  const file = join(tmpdir(), `kb-recover-${basename(path, ".jsonl")}.md`);
  writeFileSync(file, conversation.text);
  console.log(JSON.stringify({ file, prompts: conversation.prompts, chars: conversation.chars }));
}
