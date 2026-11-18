// Instruction files: the files a harness loads whole into every session, such as CLAUDE.md. A rule the
// user states belongs there, not in kb. A global audit moves global rules into the global file.

import { accessSync, constants, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { KbError } from "./note.ts";
import type { Store } from "./store.ts";

export interface InstructionsFile {
  /** The path as the config gives it, such as ~/.claude/CLAUDE.md. */
  name: string;
  /** The file kb reads and writes: the config path with every link resolved. */
  path: string;
  /** True when the config path is a link to another file, as a dotfiles manager makes it. */
  link: boolean;
}

const tilde = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

/** The path with the home folder written as ~, for the page and the CLI. */
export const shortPath = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/**
 * The global instructions file. The configured path is often a link (a dotfiles manager links it
 * from a repo), so kb writes to the file at the end of the links, never over a link.
 */
export function globalInstructions(store: Store): InstructionsFile {
  const name = store.config().globalInstructions;
  let path: string;
  try {
    path = realpathSync(tilde(name));
  } catch {
    throw new KbError(`the global instructions file ${name} does not exist. Create it, or set globalInstructions in kb.config.json.`);
  }
  return { name, path, link: lstatSync(tilde(name)).isSymbolicLink() };
}

/** The file name a moved note records in promoted_to, such as CLAUDE.md. */
export const fileName = (file: InstructionsFile) => basename(file.name);

export function readInstructions(file: InstructionsFile): string {
  try {
    return readFileSync(file.path, "utf8");
  } catch {
    throw new KbError(`cannot read ${file.name} (${shortPath(file.path)})`);
  }
}

/** Stop before the first note changes when the write would fail. */
export function checkWritable(file: InstructionsFile): void {
  try {
    accessSync(file.path, constants.W_OK);
  } catch {
    throw new KbError(`cannot write ${file.name} (${shortPath(file.path)})`);
  }
}

/** Write in place, so the file keeps its mode and every link to it. */
export function writeInstructions(file: InstructionsFile, content: string): void {
  writeFileSync(file.path, content);
}

export interface Insertion {
  content: string;
  /** The lines above the new lines, at most `context` of them, for a diff. */
  above: string[];
  /** The new lines, a new heading with them when the section did not exist. */
  added: string[];
}

interface Heading {
  /** The line where the heading starts. A setext heading's text is on this line, its underline on the next. */
  at: number;
  /** The heading's last line: the same line for `## Style`, the underline for a setext heading. */
  last: number;
  level: number;
  text: string;
}

/** A heading's words, without the marks that only format them: `## **Style**` is the section Style. */
const words = (text: string) => text.replace(/[*_`]/g, "").trim().toLowerCase();

/** `---`, `***` or `___`, with spaces between the marks or not. */
const thematicBreak = (line: string) => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);

/** A line that cannot be the text of a setext heading: a list item, a quote, a break, or a blank line. */
const notSetextText = (line: string) => !line.trim() || /^\s*([-*+]|\d+[.)])\s/.test(line) || /^ {0,3}>/.test(line) || thematicBreak(line);

/**
 * The lines that are not markdown text: YAML front matter at the top of the file, and fenced code
 * blocks with their fence lines. A `#` line there is not a heading, and a rule there is not a rule.
 */
function code(lines: string[]): boolean[] {
  const out = lines.map(() => false);
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.findIndex((line, j) => j > 0 && (line === "---" || line === "..."));
    if (close !== -1) for (; i <= close; i++) out[i] = true;
  }
  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (fence) {
      out[i] = true;
      if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = undefined;
    } else if (mark && !(mark[1]![0] === "`" && mark[2]!.includes("`"))) {
      // A backtick line with another backtick after it is inline code, not a fence.
      out[i] = true;
      fence = mark[1];
    }
  }
  return out;
}

/** The headings of a markdown file: ATX (`## Style`) and setext (`Style` over `---`), outside code. */
function headings(lines: string[]): Heading[] {
  const skip = code(lines);
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip[i]) continue;
    const line = lines[i]!;
    // A closing run of # needs a space before it, so `## C#` is the section C#.
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      out.push({ at: i, last: i, level: atx[1]!.length, text: atx[2] ?? "" });
      continue;
    }
    const under = lines[i + 1];
    const before = i === 0 ? "" : lines[i - 1]!;
    if (under !== undefined && !skip[i + 1] && !notSetextText(line) && !before.trim() && /^ {0,3}(=+|-+)[ \t]*$/.test(under)) {
      out.push({ at: i, last: i + 1, level: under.trim()[0] === "=" ? 1 : 2, text: line.trim() });
      i++;
    }
  }
  return out;
}

/**
 * The lines of a file, each with its own line end, so an edit keeps the ends it does not touch.
 * The last line keeps the end the file had, or gets \n.
 */
function toLines(content: string): { lines: string[]; ends: string[] } {
  const body = content.replace(/(\r?\n)+$/, "");
  if (!body) return { lines: [], ends: [] };
  const last = content.slice(body.length).startsWith("\r\n") ? "\r\n" : "\n";
  const raw = body.split("\n");
  return {
    lines: raw.map((line) => line.replace(/\r$/, "")),
    ends: raw.map((line, i) => (i === raw.length - 1 ? last : line.endsWith("\r") ? "\r\n" : "\n")),
  };
}

/**
 * True when the file already holds the rule outside code: its lines, one after the other, with the
 * spaces at each end ignored. Apply then does not add it twice.
 */
export function hasRule(content: string, rule: string): boolean {
  const { lines } = toLines(content);
  const skip = code(lines);
  const want = rule.trim().split(/\r?\n/).map((line) => line.trim());
  return lines.some((_, i) => want.every((line, j) => !skip[i + j] && lines[i + j]?.trim() === line));
}

/**
 * Add a rule at the end of a section: after its last line that is not blank, before the next
 * heading of the same level or higher. A section that does not exist is added at the end of the
 * file as a level 2 heading. With no section, the rule goes at the end of the file. The new lines
 * take the line end of the line above them, so a file with CRLF gets CRLF.
 */
export function insertRule(content: string, rule: string, section?: string, context = 3): Insertion {
  const { lines, ends } = toLines(content);
  const added = rule.trim().split(/\r?\n/);
  section = section?.replace(/^#+\s*/, "").trim() || undefined;
  let at = lines.length;
  let block = added;
  if (section !== undefined) {
    const all = headings(lines);
    const start = all.findIndex((h) => words(h.text) === words(section!));
    if (start === -1) {
      block = [`## ${section}`, "", ...added];
      if (lines.length > 0) block = ["", ...block];
    } else {
      const head = all[start]!;
      at = all.slice(start + 1).find((h) => h.level <= head.level)?.at ?? lines.length;
      while (at > head.last + 1 && lines[at - 1]!.trim() === "") at--;
    }
  } else if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") {
    block = ["", ...added];
  }
  const eol = ends[at - 1] ?? ends[0] ?? "\n";
  const out = [...lines.slice(0, at).map((line, i) => line + ends[i]), ...block.map((line) => line + eol), ...lines.slice(at).map((line, i) => line + ends[at + i])];
  return { content: out.join(""), above: lines.slice(Math.max(0, at - context), at), added: block };
}
