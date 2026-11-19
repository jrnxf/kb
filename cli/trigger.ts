// Triggers: when a note loads outside the session start. A note may carry a list of them, each
// `<kind>: <text>`. `cmd` and `stop` name a shell command, `err` names a part of an error text.
// This file reads a trigger, reads a shell command line, and says whether the two match.

import { KbError } from "./note.ts";

export const TRIGGER_KINDS = ["cmd", "stop", "err"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export interface Trigger {
  kind: TriggerKind;
  /** cmd and stop: the words of the command. err: one item, the text in lower case. */
  words: string[];
  /** The trigger as a note stores it: `<kind>: <text>`, with single spaces. */
  text: string;
}

/** An error text shorter than this is in too many errors. */
export const ERR_MIN_CHARS = 8;
const MAX_TRIGGER_CHARS = 200;
const MAX_TRIGGERS = 12;

/**
 * Commands that most sessions run many times. A trigger of one such word alone would load its note
 * in every session, which is what the session start is for. It needs a second word.
 */
const COMMON = new Set(
  "awk bash bun bunx cargo cat cd chmod cp curl cut date diff docker echo env export find gh git go grep head jq kill ls make mkdir mv node npm npx pip pip3 pnpm printf pwd python python3 rg rm sed sh sleep sort source ssh sudo tail tar tee test touch tr uniq wc which xargs yarn zsh".split(" "),
);

/** A word of a `cmd` trigger is plain: the matcher compares it with one word of the command. */
const SHELL_CHARS = /[;|&()<>'"`\\]/;

/** One space for each run of whitespace, so a line break in an error or a trigger changes nothing. */
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Read one trigger as written. Returns the trigger, or a sentence that says what is wrong with it. */
export function parseTrigger(raw: unknown): Trigger | string {
  if (typeof raw !== "string") return "a trigger is a text such as \"cmd: pkill -f\"";
  const match = /^\s*([A-Za-z]+)\s*:([\s\S]*)$/.exec(raw);
  const kind = match?.[1]!.toLowerCase() as TriggerKind | undefined;
  if (!match || !TRIGGER_KINDS.includes(kind!)) return `"${collapse(raw).slice(0, 40)}" must start with ${TRIGGER_KINDS.map((k) => `${k}:`).join(", ")}`;
  const rest = collapse(match[2]!);
  if (!rest) return `"${kind}:" needs a text after it`;
  if (rest.length > MAX_TRIGGER_CHARS) return `"${kind}: ${rest.slice(0, 30)}..." is over ${MAX_TRIGGER_CHARS} characters`;
  const text = `${kind}: ${rest}`;
  if (kind === "err") {
    if (rest.length < ERR_MIN_CHARS) return `"${text}" needs at least ${ERR_MIN_CHARS} characters of the error text`;
    return { kind, words: [rest.toLowerCase()], text };
  }
  const words = rest.split(" ");
  if (words.some((word) => SHELL_CHARS.test(word))) return `"${text}" takes plain words only: no quotes, and no ; | & ( ) < >`;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return `"${text}" must start with the command, not with a variable`;
  if (words.length === 1 && COMMON.has(words[0]!)) return `"${text}" matches too many commands. Add a second word, such as a subcommand or a flag`;
  return { kind: kind!, words, text };
}

/**
 * The triggers of a note as kb stores them, from what a writer gave. Throws a KbError that names
 * every trigger that is wrong. A read of a stored note does not come here: a trigger that a later
 * kb wrote stays in the file, and loads nothing.
 */
export function requireTriggers(value: unknown): string[] {
  if (!Array.isArray(value)) throw new KbError("invalid note: triggers: must be a list such as [\"cmd: pkill -f\", \"err: address already in use\"]");
  if (value.length > MAX_TRIGGERS) throw new KbError(`invalid note: triggers: at most ${MAX_TRIGGERS}`);
  const parsed = value.map(parseTrigger);
  const problems = parsed.filter((each): each is string => typeof each === "string");
  if (problems.length > 0) throw new KbError(`invalid note: triggers: ${problems.join("; ")}`);
  return [...new Set((parsed as Trigger[]).map((trigger) => trigger.text))];
}

/** The triggers of a stored note that this kb can match. */
export function readTriggers(triggers: string[] | undefined): Trigger[] {
  return (triggers ?? []).map(parseTrigger).filter((each): each is Trigger => typeof each !== "string");
}

// ---- a shell command line ----

/** A longer command is cut here. A command this long is a file written through a heredoc. */
const MAX_COMMAND_CHARS = 100_000;
const MAX_DEPTH = 12;

interface Heredoc {
  tag: string;
  /** `<<-`: the end line may start with tabs. */
  tabs: boolean;
}

/**
 * Read a part of a command line into simple commands, each a list of words with the quotes taken
 * off. It stops at `close` (the end of a `$(...)` or of a backtick) and returns the index of it.
 * It is no shell: it only has to find the words a shell would run, and to leave out the text that
 * is data, such as the body of a heredoc, a comment and a quoted argument.
 */
function read(src: string, from: number, close: ")" | "`" | null, out: string[][], depth: number): number {
  let words: string[] = [];
  /** The word that is open, or null between words. A pair of quotes opens a word that can be empty. */
  let word: string | null = null;
  let parens = 0;
  const heredocs: Heredoc[] = [];
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  /** A `$(...)` or a backtick part: its commands run too. Returns the index of its end. */
  const nested = (start: number, end: ")" | "`"): number => (depth >= MAX_DEPTH ? src.length : read(src, start, end, out, depth + 1));

  let i = from;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === close && (c !== ")" || parens === 0)) {
      endCommand();
      return i;
    }
    if (c === "\\") {
      // A backslash before a line break joins the two lines. Before any other character it makes it plain.
      if (src[i + 1] !== "\n") word = (word ?? "") + (src[i + 1] ?? "");
      i++;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word = (word ?? "") + src.slice(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\" && i + 1 < src.length) {
          if (src[i + 1] !== "\n") word += src[i + 1];
          i++;
        } else if (src[i] === "$" && src[i + 1] === "(") i = nested(i + 2, ")");
        else if (src[i] === "`") i = nested(i + 1, "`");
        else word += src[i];
      }
    } else if (c === "$" && src[i + 1] === "(") {
      word ??= "";
      i = nested(i + 2, ")");
    } else if (c === "`") {
      word ??= "";
      i = nested(i + 1, "`");
    } else if (c === "#" && word === null) {
      // A comment runs to the end of the line. The line break itself ends the command below.
      const end = src.indexOf("\n", i);
      i = (end === -1 ? src.length : end) - 1;
    } else if (c === " " || c === "\t" || c === "\r") endWord();
    else if (c === "\n") {
      endCommand();
      // The body of each heredoc that this line opened is data, up to its end line.
      for (const doc of heredocs.splice(0)) {
        let at = i + 1;
        for (;;) {
          const end = src.indexOf("\n", at);
          const line = src.slice(at, end === -1 ? src.length : end);
          at = end === -1 ? src.length : end + 1;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.tag || end === -1) break;
        }
        i = at - 1;
      }
    } else if (c === ";" || c === "|") endCommand();
    else if (c === "&") {
      // `2>&1` and `&>file` send output somewhere. They end no command.
      if (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">") endWord();
      else endCommand();
    } else if (c === "(") {
      endCommand();
      parens++;
    } else if (c === ")") {
      endCommand();
      if (parens > 0) parens--;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      endWord();
      const doc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;|&()<>'"]+))/.exec(src.slice(i, i + 300));
      if (doc) {
        heredocs.push({ tabs: doc[1] === "-", tag: doc[2] ?? doc[3] ?? doc[4]! });
        i += doc[0].length - 1;
      } else i++;
    } else if (c === "<" || c === ">") {
      endWord();
      // `<<<` gives a text on stdin, and `>|` writes a file: neither is a pipe.
      while (src[i + 1] === "<" || src[i + 1] === ">" || (c === ">" && src[i + 1] === "|")) i++;
    } else word = (word ?? "") + c;
  }
  endCommand();
  return i;
}

/** Words that come before the command in a simple command: they change how it runs, not what runs. */
const RESERVED = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Commands that run another command, which follows somewhere in the same simple command. kb does
 * not know the options of each, so after one of them every later word may be the command.
 */
export const WRAPPERS = ["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "nice", "time", "timeout", "xargs", "watch", "ssh"];
const WRAPPER = new Set(WRAPPERS);

/** Commands that take a command line as one quoted argument. */
export const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "eval", "ssh", "su", "watch"];
const SHELL = new Set(SHELLS);

/** `find -exec <command>` and its forms run the word that follows. */
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/**
 * The simple commands of a command line: it is cut at `;`, `&&`, `||`, `|`, `&`, a line break, and
 * the ends of `( )`, `$( )` and backticks. The body of a heredoc and a comment are left out. In a
 * command that names a shell (`bash -c '...'`, `ssh host '...'`, `eval`), a quoted argument is a
 * command line of its own, so its commands are in the list too.
 */
export function simpleCommands(command: string): string[][] {
  const out: string[][] = [];
  read(command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command, 0, null, out, 0);
  // The list grows while it is read: a script in a script is found the same way.
  for (let i = 0, scripts = 0; i < out.length && scripts < 50; i++) {
    const words = out[i]!;
    if (!words.some((word) => SHELL.has(baseName(word)))) continue;
    for (const word of words) {
      if (!/\s/.test(word)) continue;
      scripts++;
      read(word, 0, null, out, 0);
    }
  }
  return out;
}

/** The places in a simple command where the command word can be. */
function commandPlaces(words: string[]): number[] {
  let first = 0;
  while (first < words.length && (RESERVED.has(words[first]!) || ASSIGNMENT.test(words[first]!))) first++;
  if (first >= words.length) return [];
  if (WRAPPER.has(baseName(words[first]!))) return words.map((_, i) => i).slice(first);
  const places = [first];
  for (let i = first + 1; i < words.length - 1; i++) if (EXEC_FLAGS.has(words[i]!)) places.push(i + 1);
  return places;
}

/** `/usr/bin/pkill` runs `pkill`, and `./scripts/up.sh` runs `scripts/up.sh`. */
const sameCommand = (word: string, want: string) => word === want || word.endsWith(`/${want}`);
/** `--force=yes` holds the word `--force`. No other word matches inside a longer word. */
const sameWord = (word: string, want: string) => word === want || (want.startsWith("--") && word.startsWith(`${want}=`));

/**
 * True when one simple command holds the words of the trigger in order, the first as its command
 * word. Other words may stand between them: `pkill -f` matches `sudo pkill -9 -f x`.
 */
export function matchesCommand(trigger: string[], commands: string[][]): boolean {
  for (const words of commands) {
    for (const place of commandPlaces(words)) {
      if (!sameCommand(words[place]!, trigger[0]!)) continue;
      let at = place + 1;
      const all = trigger.slice(1).every((want) => {
        while (at < words.length && !sameWord(words[at]!, want)) at++;
        return at++ < words.length;
      });
      if (all) return true;
    }
  }
  return false;
}

/** A cheap test before the command is read: a command that lacks a word of the trigger cannot match. */
export const mayMatchCommand = (trigger: string[], command: string) => trigger.every((word) => command.includes(word));

/** An error text as an `err` trigger is compared with it: lower case, one space for each run of whitespace. */
export const errorText = (error: string) => collapse(error.length > MAX_COMMAND_CHARS ? error.slice(0, MAX_COMMAND_CHARS) : error).toLowerCase();

/** True when the error holds the text of an `err` trigger. Case and the kind of whitespace do not count. */
export const matchesError = (text: string, error: string) => errorText(error).includes(text);

/** The words of a command line that can be paths: each word of each simple command, cut at spaces, `=`, `:` and `,`. */
export function pathWords(commands: string[][]): string[] {
  return [...new Set(commands.flatMap((words) => words.flatMap((word) => word.split(/[\s=:,]+/))).filter(Boolean))];
}
