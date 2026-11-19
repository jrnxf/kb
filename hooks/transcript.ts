// Reads a Claude Code transcript (.jsonl) and keeps only what the user and the agent said.
// Tool calls and tool results are left out: they are large, and a tool result can hold a secret.
// `kb-transcript <session id>` (bin/kb-transcript) writes the conversation of an unsaved session
// to the store's per-machine state folder for /kb:recover.

import { readFileSync } from "node:fs";
import { unsavedSession, writeRecoverFile } from "../cli/session.ts";
import { Store, git } from "../cli/store.ts";

export interface Conversation {
  /** The times the user said something: a prompt, the reason for a rejected tool call, an answer to a question. */
  prompts: number;
  /** The characters the user and the agent said. Headings and the name of a slash command do not count. */
  chars: number;
  /** The conversation as Markdown: a heading per turn, then its text. */
  text: string;
}

type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  toolUseResult?: unknown;
  message?: { content?: string | Block[] };
};

// The harness adds these to user turns. They are not the user's words. A task notification is
// the result of a background task, and it arrives as a user turn. The bash tags hold a `!` shell
// command and its output, which is tool output like any other.
const NOISE = /<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;

// A turn that starts with one of these is output from its first character to its last. It goes
// whole, because the output can hold the closing tag and so end the match above too early.
const OUTPUT_TURN = /^\s*<(local-command-stdout|local-command-stderr|task-notification|bash-input|bash-stdout|bash-stderr)>/;

// A slash command arrives as a user turn that holds only these tags. The command is no prompt.
// The arguments are: the user typed them, and a custom command can get a whole instruction there.
const COMMAND = /^(?:\s*<command-(name|message|args)>[\s\S]*?<\/command-\1>)+\s*$/;
const commandTag = (text: string, name: string) => new RegExp(`<command-${name}>([\\s\\S]*?)</command-${name}>`).exec(text)?.[1]?.trim() ?? "";
/** A session that only ran this command has nothing of its own to save. */
const RECOVER = "/kb:recover";

// What Claude Code writes when the user stops the agent. The user typed nothing.
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

// The fixed text around the reason a user types when they reject a tool call.
const REJECTED = "The user doesn't want to proceed with this tool use.";
const SAID = "To tell you how to proceed, the user said:";
const AFTER_REASON = "\n\nNote: The user's next message may contain";

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block: Block) => block?.type === "text" && typeof block.text === "string").map((block: Block) => block.text!).join("\n\n")
      : "";

/** The reason the user typed when they rejected a tool call, or "". */
function rejectionReason(block: Block): string {
  const text = textOf(block.content);
  if (block.is_error !== true || !text.startsWith(REJECTED)) return "";
  const at = text.indexOf(SAID);
  if (at < 0) return "";
  const reason = text.slice(at + SAID.length);
  const note = reason.lastIndexOf(AFTER_REASON);
  return (note < 0 ? reason : reason.slice(0, note)).trim();
}

/** The user's answers to an AskUserQuestion call, each under its question, or "". */
function answers(line: Line, block: Block, asked: Set<string>): string {
  const result = line.toolUseResult as { answers?: unknown; annotations?: Record<string, { notes?: unknown } | undefined> } | null | undefined;
  if (!block.tool_use_id || !asked.has(block.tool_use_id) || !result || typeof result !== "object") return "";
  if (!result.answers || typeof result.answers !== "object") return "";
  const pairs: string[] = [];
  for (const [question, given] of Object.entries(result.answers)) {
    const answer = Array.isArray(given) ? given.join(", ") : typeof given === "string" ? given : "";
    if (!answer.trim()) continue;
    const notes = result.annotations?.[question]?.notes;
    pairs.push(`Q: ${question}\nA: ${answer}${typeof notes === "string" && notes.trim() ? `\nNote: ${notes}` : ""}`);
  }
  return pairs.join("\n\n");
}

type Said =
  | { kind: "prompt" | "reply" | "interrupt"; text: string }
  | { kind: "command"; text: string; name: string; args: string };

/** What the user said in one transcript line. A tool result gives only the user's own words in it. */
function userSaid(line: Line, asked: Set<string>): Said[] {
  const content = line.message?.content;
  const said: Said[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const reason = rejectionReason(block);
      if (reason) said.push({ kind: "reply", text: `(the user rejected a tool call and said)\n${reason}` });
      const given = answers(line, block, asked);
      if (given) said.push({ kind: "reply", text: `(the user answered a question)\n${given}` });
    }
  }
  const typed = textOf(content);
  const text = OUTPUT_TURN.test(typed) ? "" : typed.replace(NOISE, "").trim();
  if (!text) return said;
  if (COMMAND.test(text)) {
    const name = commandTag(text, "name") || `/${commandTag(text, "message")}`;
    const args = commandTag(text, "args");
    said.push({ kind: "command", name, args, text: args ? `${name} ${args}` : `(the user ran ${name})` });
  } else said.push({ kind: INTERRUPTED.test(text) ? "interrupt" : "prompt", text });
  return said;
}

/** Throws when the file cannot be read. */
export function readConversation(path: string): Conversation {
  const turns: { role: "user" | "agent"; text: string }[] = [];
  const asked = new Set<string>();
  let prompts = 0;
  let chars = 0;
  // Inside a /kb:recover turn: from the command to the next prompt the user types. Its text is
  // the report on another session, which that session's recovery saved already.
  let recovering = false;
  const add = (role: "user" | "agent", text: string, counted: number) => {
    if (recovering) return;
    chars += counted;
    const last = turns.at(-1);
    // The agent's text arrives in several lines per turn. Join them, so each turn has one heading.
    if (last?.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  };
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let line: Line | null;
    try {
      line = JSON.parse(raw) as Line | null;
    } catch {
      continue;
    }
    // A line can parse to null or to a bare value.
    if (!line || typeof line !== "object") continue;
    // A compaction summary repeats turns the file still holds. A sidechain is a subagent's own work.
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta || line.isSidechain || line.isCompactSummary) continue;
    if (line.type === "assistant") {
      const content = line.message?.content;
      if (Array.isArray(content)) for (const block of content) if (block?.type === "tool_use" && block.name === "AskUserQuestion" && block.id) asked.add(block.id);
      const text = textOf(content).trim();
      if (text) add("agent", text, text.length);
      continue;
    }
    for (const said of userSaid(line, asked)) {
      if (said.kind === "command") {
        recovering = said.name === RECOVER;
        if (said.args && !recovering) prompts++;
        add("user", said.text, said.args.length);
      } else if (said.kind === "interrupt") add("user", said.text, 0);
      else {
        // A reason or an answer belongs to the turn it is in. Only a typed prompt ends a recover turn.
        if (said.kind === "prompt") recovering = false;
        if (!recovering) prompts++;
        add("user", said.text, said.text.length);
      }
    }
  }
  const text = turns.map((turn) => `## ${turn.role}\n\n${turn.text}\n`).join("\n");
  return { prompts, chars, text };
}

/**
 * The size of a transcript's conversation, or null when the file cannot be read now.
 * Null is not "empty": the caller keeps the session and measures it at a later start.
 */
export function worthRecovering(path: string): { prompts: number; chars: number } | null {
  try {
    const { prompts, chars } = readConversation(path);
    return { prompts, chars };
  } catch {
    return null;
  }
}

/** The commits a later session made, newest first. /kb:recover reads them to see what work is finished. */
function commitsSince(cwd: string, time: string): string {
  const log = git(cwd, "log", "--oneline", "-30", `--since=${time}`);
  return log.ok && log.out ? log.out : "none";
}

/**
 * The notes that an earlier /kb:recover of this session wrote, as its mark names them. A search
 * can miss a note that says the fact in other words, so the second recovery gets the list and
 * adds no twin. A note that went to the trash since then stays in the list, so it does not come back.
 */
function savedBefore(store: Store, ids: string[] = []): string {
  const lines = ids.flatMap((id) => {
    const note = store.find(id);
    return note ? [`${note.id}${note.trashed ? " (in the trash)" : ""} | ${note.title}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : "none";
}

/** A failure is one JSON line, as the result is. The skill reads it and goes on to the next session. */
function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

if (import.meta.main) {
  const session = process.argv[2];
  if (!session) {
    console.error("usage: kb-transcript <session id>");
    process.exit(1);
  }
  const store = new Store();
  // Only a session with a mark is read, so the command never reads a path that a caller makes up.
  const mark = store.exists() ? unsavedSession(store, session) : null;
  if (!mark) fail(`no unsaved session ${session}. \`kb unsaved\` lists them.`);
  try {
    const conversation = readConversation(mark.transcript);
    const head = [
      `# Session that ended ${mark.ended} in ${mark.cwd}\n`,
      `Commits in that directory since it ended:\n${commitsSince(mark.cwd, mark.ended)}\n`,
      `Notes that an earlier /kb:recover of this session saved:\n${savedBefore(store, mark.notes)}\n`,
    ].join("\n");
    // The user's own words can hold a secret. The file is private, and it goes when the session is
    // marked or forgotten, or after 7 days.
    const file = writeRecoverFile(store, session, `${head}\n${conversation.text}`);
    console.log(JSON.stringify({ file, prompts: conversation.prompts, chars: conversation.chars }));
  } catch (error) {
    // No path and no stack: the caller must not go and read the raw transcript, which holds tool output.
    fail(`the conversation of session ${session} cannot be read now (${(error as { code?: string })?.code ?? "error"}). Its mark stays.`);
  }
}
