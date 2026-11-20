// Reads a Claude Code transcript (.jsonl) and keeps what the user and the agent said. For each
// tool call that FAILED it also keeps three short spans: the call, the error, and the next call
// the agent made. An autonomous run has one prompt, and it learns its lessons from errors.
// Nothing of a tool call that worked gets through: a tool result is large, and it can hold a
// secret. What `cli/secrets.ts` knows as a secret is masked in every line, and a span gets the
// wider masks for tool text. An error is text that a tool wrote, so it stands in a marked block.
// `kb-transcript <session id>` (hooks/kb-transcript.ts) writes the result for /kb:recover.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { maskKeys, maskSecrets, maskToolText } from "../cli/secrets.ts";

/** How much a session holds. A later session start measures it once, and the mark keeps it. */
export interface Size {
  /** The times the user said something: a prompt, the reason for a rejected tool call, an answer to a question. */
  prompts: number;
  /** The characters the user and the agent said. Headings and the name of a slash command do not count. */
  chars: number;
  /**
   * The assistant messages with a tool call that failed. Parallel calls are one message, so they
   * count once. A call that the user refused or stopped, and a call that did not run, is not one.
   */
  failed: number;
}

export interface Conversation extends Size {
  /** The conversation as Markdown: a heading per turn, then its text and its failed tool calls. */
  text: string;
}

type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; input?: unknown };
type Line = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  /** When Claude Code wrote the line, as an ISO time. */
  timestamp?: string;
  toolUseResult?: unknown;
  message?: { id?: string; content?: string | Block[] };
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

// The fixed text that starts the result of a tool call the user refused. Claude Code has two wordings.
const REFUSED = /^The user doesn't want to (?:proceed with this tool use|take this action right now)\./;
// The result of a call that the user stopped while it ran: the stop itself, or output that ends with it.
const STOPPED = /^\[Request interrupted by user[^\]]*\]|\[Request interrupted by user[^\]]*\]$/;
// The fixed text around the reason a user types when they refuse a tool call.
// The fixed text that starts the result of a call that did not run: a parallel call that the
// harness cancelled when another one failed (two wordings), a call that it dropped, and a write
// to a file that the agent must read first. No tool gave an error, so there is no lesson in it.
const NOT_RUN = /^(?:Cancelled: |Sibling tool call errored|(?:Error: )?Streaming fallback - tool execution discarded|File has not been read yet|File has been modified since read)/;
const SAID = "To tell you how to proceed, the user said:";
const AFTER_REASON = "\n\nNote: The user's next message may contain";

/** The longest call, error or next call that gets through. */
export const SPAN_LIMIT = 300;
/** No mask of a line reads more of a tool result than this. */
export const READ_LIMIT = 20_000;
/** The fields of a tool input that say what the call did. Never the new text of a file. */
const INPUT_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query"];
/** The tools that write a file, and the field that names the file. Their call is the path, and nothing more. */
const FILE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
/** A shorter text of a file is not worth a search in the error. */
const MIN_HIDDEN = 4;
/** The lines around an error. The text between them is what a tool wrote, never what somebody said. */
export const OUTPUT_OPEN = "<tool-output>";
export const OUTPUT_CLOSE = "</tool-output>";
const LEFT_OUT = "(text of the file left out)";

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
/** A text as one line. The mask for a private key reads lines, so it comes before they are joined. */
const oneLine = (text: string) => flat(maskKeys(text));

/** The first `READ_LIMIT` characters. The cut is at a space, so it splits no token. A text with no space there is cut at the limit. */
function head(text: string): string {
  if (text.length <= READ_LIMIT) return text;
  const cut = text.slice(0, READ_LIMIT);
  const space = cut.search(/\s\S*$/);
  return space > 0 ? cut.slice(0, space) : cut;
}

/** One line of at most `SPAN_LIMIT` characters. The mask comes before the cut, so no half of a secret is left. */
function short(text: string): string {
  const line = maskToolText(oneLine(head(text)));
  return line.length > SPAN_LIMIT ? `${line.slice(0, SPAN_LIMIT)}...` : line;
}

// The first line of a heredoc: `<<`, the word that ends it, and the rest of that line.
const HEREDOC = /(?<!<)<<-?[ \t]*(?:"[^"\n]+"|'[^'\n]+'|\\?[A-Za-z_][\w.-]*)[^\n]*/;

/** A shell command up to the body of its first heredoc. The body is the text of a file, or of a message. */
function commandOf(command: string): string {
  const found = HEREDOC.exec(command);
  if (!found) return command;
  const end = found.index + found[0].length;
  return command.slice(end).trim() ? `${command.slice(0, end)} (heredoc body left out)` : command;
}

/** A tool call as the reader keeps it until its result comes. */
interface Call {
  /** The call in one line: the tool, then its command, path or pattern. */
  text: string;
  /** The texts that a file tool was given for the file. Its error can repeat them. */
  hide: string[];
}

function callOf(block: Block): Call {
  const name = block.name ?? "tool";
  const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  const pathKey = FILE_TOOLS[name];
  if (pathKey) {
    const path = typeof input[pathKey] === "string" ? (input[pathKey] as string) : "";
    return { text: short(path ? `${name}: ${path}` : name), hide: fileTexts(input, pathKey) };
  }
  const key = INPUT_KEYS.find((each) => typeof input[each] === "string" && input[each]);
  const value = key ? (input[key] as string) : "";
  return { text: short(`${name}${key ? `: ${key === "command" ? commandOf(value) : value}` : ""}`), hide: [] };
}

/** Every text in the input of a file tool but the path, the longest first: the old and new text of an edit, at any depth. */
function fileTexts(input: unknown, pathKey: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      // As the error is read: a key in the text of the file is masked in both.
      if (key !== pathKey && oneLine(value).length >= MIN_HIDDEN) found.push(oneLine(value));
    } else if (Array.isArray(value)) for (const each of value) walk(each);
    else if (value && typeof value === "object") for (const [name, each] of Object.entries(value)) walk(each, name);
  };
  walk(input);
  return found.sort((a, b) => b.length - a.length);
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block: Block) => block?.type === "text" && typeof block.text === "string").map((block: Block) => block.text!).join("\n\n")
      : "";

/** The text of a tool result without the tags of the harness. */
const resultText = (block: Block) => textOf(block.content).replace(NOISE, "").replace(/<\/?tool_use_error>/g, "").trim();

/** A tool call that the user refused. Their reason, when they typed one, is in its result. */
const refused = (block: Block) => block.is_error === true && REFUSED.test(resultText(block));

/** A tool call that the user refused, or stopped while it ran. It did not fail: no tool gave an error. */
const stoppedByUser = (block: Block) => refused(block) || (block.is_error === true && STOPPED.test(resultText(block)));

/** A tool call that ran and gave an error. */
const failedCall = (block: Block) => block?.type === "tool_result" && block.is_error === true && !stoppedByUser(block) && !NOT_RUN.test(resultText(block));

const TAG = /<\/?tool-output>/gi;

/**
 * A text with no open or close mark of the block in it, in any case. Taking a mark out can join
 * the text around it to a new one (`<</tool-output>/tool-output>`), so this goes on until none is left.
 */
function unmarked(text: string): string {
  let out = text;
  for (let before = ""; before !== out; ) {
    before = out;
    out = out.replace(TAG, "");
  }
  return out;
}

/**
 * The error of a failed call as a block of one line. The error of a file tool can repeat the text
 * it was given for the file, which goes. A mark that would end the block goes too, so what a tool
 * wrote cannot stand outside of it. The masks and the cut come after that: they add no mark, and
 * a secret that a mark stood in is whole when they read it.
 */
function errorOf(block: Block, call: Call | undefined): string {
  let text = oneLine(resultText(block));
  for (const hidden of call?.hide ?? []) text = text.replaceAll(hidden, LEFT_OUT);
  return `${OUTPUT_OPEN}\n${short(unmarked(head(text))) || "(no error text)"}\n${OUTPUT_CLOSE}`;
}

/** The reason the user typed when they refused a tool call, or "". */
function rejectionReason(block: Block): string {
  const text = textOf(block.content);
  if (!refused(block)) return "";
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

/**
 * Throws when the file cannot be read. With `measure`, it only counts: no text is kept and no
 * mask runs, so a session start pays for one pass over the file and no more.
 */
export function readConversation(path: string, measure = false, part: Part = {}): Conversation {
  const turns: { role: "user" | "agent"; text: string }[] = [];
  const asked = new Set<string>();
  /** Each tool call that waits for its result, by its id, so a result that failed can name its call. */
  const calls = new Map<string, Call>();
  /** The assistant message of each tool call that waits for its result. Parallel calls share one. */
  const messages = new Map<string, string>();
  /** The assistant messages with a failed call. Three failures of one message are one for the floor. */
  const failed = new Set<string>();
  let prompts = 0;
  let chars = 0;
  let lines = 0;
  /** A call failed, and the next call is not written yet. */
  let awaiting = false;
  /** The call that was written last as the next call. When it fails too, its error goes under it. */
  let shown = "";
  // Inside a /kb:recover turn: from the command to the next prompt the user types. Its text is
  // the report on another session, which that session's recovery saved already.
  let recovering = false;
  const add = (role: "user" | "agent", text: string, counted: number) => {
    if (recovering) return;
    chars += counted;
    if (measure) return;
    const last = turns.at(-1);
    // The agent's text arrives in several lines per turn. Join them, so each turn has one heading.
    if (last?.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  };
  const since = part.since ? Date.parse(part.since) : Number.NaN;
  // From the byte that the end found, every line is after the checkpoint.
  let after = Number.isNaN(since) || part.offset !== undefined;
  for (const raw of readFrom(path, part.offset ?? 0).split("\n")) {
    if (!raw.trim()) continue;
    let line: Line | null;
    try {
      line = JSON.parse(raw) as Line | null;
    } catch {
      continue;
    }
    // A line can parse to null or to a bare value.
    if (!line || typeof line !== "object") continue;
    lines++;
    // What came before a checkpoint is saved. A line with no time belongs where the last time was.
    if (!after) {
      const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
      if (Number.isNaN(at) || at <= since) continue;
      after = true;
    }
    // A compaction summary repeats turns the file still holds. A sidechain is a subagent's own work.
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta || line.isSidechain || line.isCompactSummary) continue;
    if (line.type === "assistant") {
      const content = line.message?.content;
      const text = textOf(content).trim();
      if (text) add("agent", text, text.length);
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== "tool_use" || !block.id) continue;
        if (block.name === "AskUserQuestion") asked.add(block.id);
        // Claude Code writes each call of a message as a line of its own, with the id of the message.
        messages.set(block.id, line.message?.id ?? `line ${lines}`);
        if (measure) continue;
        const call = callOf(block);
        calls.set(block.id, call);
        if (!awaiting) continue;
        // What the agent did after the error is half of the lesson.
        add("agent", `(the next tool call)\ncall: ${call.text}`, 0);
        awaiting = false;
        shown = block.id;
      }
      continue;
    }
    for (const block of Array.isArray(line.message?.content) ? (line.message!.content as Block[]) : []) {
      if (block?.type !== "tool_result") continue;
      const id = block.tool_use_id ?? "";
      const call = calls.get(id);
      // The call has its result now. The text of a file that it holds is not kept to the end of the read.
      calls.delete(id);
      const message = messages.get(id) ?? `result ${lines} ${id}`;
      messages.delete(id);
      if (!failedCall(block) || recovering) continue;
      failed.add(message);
      if (measure) continue;
      const error = errorOf(block, call);
      add("agent", id && id === shown ? `(it failed too)\n${error}` : `(a tool call failed)\ncall: ${call?.text ?? "(not in the transcript)"}\n${error}`, 0);
      awaiting = true;
      shown = "";
    }
    for (const said of userSaid(line, asked)) {
      // A new prompt starts other work. Its first tool call is not what the agent did about an old error.
      if (said.kind === "prompt" || said.kind === "command") {
        awaiting = false;
        shown = "";
      }
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
  // The user and the agent can have typed a secret. The file goes to a subagent, so each line is masked.
  const text = turns.map((turn) => `## ${turn.role}\n\n${maskSecrets(turn.text)}\n`).join("\n");
  return { prompts, chars, failed: failed.size, text };
}

/**
 * The size of a transcript's conversation, or null when the file cannot be read now.
 * Null is not "empty": the caller keeps the session and measures it at a later start.
 */
export function worthRecovering(path: string, part: Part = {}): Size | null {
  try {
    const { prompts, chars, failed } = readConversation(path, true, part);
    return { prompts, chars, failed };
  } catch {
    return null;
  }
}

/** The part of a transcript to read: what came after a checkpoint. With neither field, all of it. */
export interface Part {
  /** The time of the checkpoint. Lines at this time or before are skipped. */
  since?: string;
  /** The byte where the part after the checkpoint starts. */
  offset?: number;
}

/** The bytes of a file from a byte on. */
function readBytes(path: string, offset: number): Buffer {
  const file = openSync(path, "r");
  try {
    const size = fstatSync(file).size;
    const start = Math.min(Math.max(0, offset), size);
    const bytes = Buffer.alloc(size - start);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(file, bytes, read, bytes.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return bytes.subarray(0, read);
  } finally {
    closeSync(file);
  }
}

/** The text of a file from a byte on. The byte must start a line. */
const readFrom = (path: string, offset: number) => readBytes(path, offset).toString("utf8");

/** How much of the end of a transcript the end of a session reads. A session end has 1.5 seconds. */
export const TAIL_BYTES = 256 * 1024;

/**
 * If the user typed a prompt after a checkpoint at `since`, and where the part after it starts.
 * Null when nothing was typed after it, and also for a transcript with no times, or one that
 * cannot be read: then the checkpoint stands, as before. It reads only the last TAIL_BYTES. When
 * even the first line there is after the checkpoint, the session went on far past it, so it is
 * unsaved, and the start of that part is not known.
 */
export function promptAfter(path: string, since: string): { offset?: number } | null {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return null;
  let bytes: Buffer;
  let start: number;
  try {
    start = Math.max(0, statSync(path).size - TAIL_BYTES);
    // Bytes, not text: a cut in a character would change the length of the text, and so each offset.
    bytes = readBytes(path, start);
  } catch {
    return null;
  }
  let pos = 0;
  // A cut in the middle of a line: that line is not whole, so the read starts at the next one.
  if (start > 0) {
    const nl = bytes.indexOf(10);
    pos = nl < 0 ? bytes.length : nl + 1;
  }
  let timed = false;
  let before = false;
  /** The byte of the first line after the last line at or before `since`. */
  let first: number | undefined;
  let typed = false;
  const none = new Set<string>();
  while (pos < bytes.length) {
    const nl = bytes.indexOf(10, pos);
    const end = nl < 0 ? bytes.length : nl;
    const lineStart = pos;
    pos = end + 1;
    let line: Line | null;
    try {
      line = JSON.parse(bytes.subarray(lineStart, end).toString("utf8")) as Line | null;
    } catch {
      continue;
    }
    if (!line || typeof line !== "object" || typeof line.timestamp !== "string") continue;
    const time = Date.parse(line.timestamp);
    if (Number.isNaN(time)) continue;
    timed = true;
    if (time <= at) {
      before = true;
      first = undefined;
      typed = false;
      continue;
    }
    first ??= start + lineStart;
    if (line.type !== "user" || line.isMeta || line.isSidechain || line.isCompactSummary) continue;
    // A tool result, such as the one of `kb checkpointed`, is no prompt. Nor is a bare slash command, such as /clear.
    if (userSaid(line, none).some((said) => said.kind === "prompt" || (said.kind === "command" && said.args !== "" && said.name !== RECOVER))) typed = true;
  }
  if (!timed) return null;
  if (!before && start > 0) return {};
  return typed ? { offset: first } : null;
}
