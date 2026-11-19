// Notes at their trigger: what a tool call loads. A session start gives notes before the task is
// known. Here a note comes at the moment it applies: before a shell command that a `cmd` or a
// `stop` trigger names, after an error that an `err` trigger names, and when the agent works on a
// file that an anchor names. Each reader gets each note once. The caller is a hook: this file knows
// no harness, only a command, a file, an error text and who asks.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type Reader, covers, fileInRepo, pathInRepo, realFile, seenBy } from "./by-path.ts";
import { KINDS, type Note, parseNote } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import type { Store } from "./store.ts";
import { type TableNote, triggerTable } from "./table.ts";
import { errorText, matchesCommand, mayMatchCommand, pathWords, simpleCommands } from "./trigger.ts";

/** At most this many notes load for one command, one change of a file or one error. */
export const NOTES_PER_CALL = 3;
/** At most this many notes are given for one Read, so a busy folder cannot flood the session. */
export const NOTES_PER_FILE = 5;
/** A body longer than this is cut, with a pointer to the rest. */
export const BODY_CHARS = 600;

/** A title longer than this is cut. With the caps above, the text stays far under the 10,000 character limit of a hook. */
const TITLE_CHARS = 200;
const PATH_CHARS = 300;
/** The words of one command that are looked at as paths. */
const MAX_PATH_WORDS = 40;

export type FireKind = "cmd" | "stop" | "err" | "path";

/** One note that loaded, as the event log records it. */
export interface Fire {
  note: string;
  kind: FireKind;
  /** The agent got the body, or one line with the title. */
  form: "body" | "title";
  /** What matched: the words of the trigger, the text of the error trigger, or the repo-relative path. */
  match: string;
}

export interface Fired {
  /** What the agent reads. */
  text: string;
  /**
   * True when a `stop` note is in the text and this is recorded: the caller refuses the tool call
   * this one time. The record makes the same call pass the next time.
   */
  stop: boolean;
  /** The repo the tool call belongs to, or "global". */
  scope: string;
  fires: Fire[];
}

interface Hit {
  note: TableNote;
  kind: FireKind;
  match: string;
}

/** One line: a newline in a title must not start a line of its own. */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** The body, whole or cut at BODY_CHARS at the end of a word, with where the rest is. */
function cutBody(note: Note): string {
  const body = note.body.trim();
  if (body.length <= BODY_CHARS) return body;
  const cut = body.slice(0, BODY_CHARS);
  const space = cut.search(/\s\S*$/);
  return `${(space > BODY_CHARS - 80 ? cut.slice(0, space) : cut).trimEnd()}...\n\`kb show ${note.id}\` prints the rest.`;
}

/** A stop comes first, then a command, an error and a path. In each group the kinds are in the order of a session start. */
const ORDER: FireKind[] = ["stop", "cmd", "err", "path"];
const byOrder = (a: Hit, b: Hit) =>
  ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || KINDS.indexOf(a.note.kind) - KINDS.indexOf(b.note.kind) || a.note.id.localeCompare(b.note.id);

/** The note as the store holds it now, or null when it is gone since the table was built. */
function load(store: Store, entry: TableNote): Note | null {
  try {
    return parseNote(readFileSync(store.notePath(entry), "utf8"));
  } catch {
    return null;
  }
}

/** The fixed text around the notes of one kind of tool call. */
interface Shape {
  /** The first line above the notes that come whole, for this many notes in all. */
  lead: (count: number) => string;
  /** The line above the notes that come as a title, after the notes that come whole. */
  titles: string;
  /** The same line when every note comes as a title. */
  onlyTitles: string;
  /** Say how many more notes matched and did not fit. */
  countRest?: boolean;
}

/** A note that stops the call says so first, and says how the call passes. */
const STOP_LEAD = "kb stopped this command once, because a note says that one run can do damage. Read the note. If the command still applies, run it again: it passes the second time.";

/**
 * Give the reader the hits it has not got yet, at most `cap`, and record each. null when there is
 * nothing new. A `stop` note refuses the call only when its record was written: with no record the
 * same call would be refused each time.
 */
function give(store: Store, hits: Hit[], reader: Reader, scope: string, cap: number, shape: Shape, now: number): Fired | null {
  if (hits.length === 0) return null;
  const seen = seenBy(store, reader, now);
  const blocks: string[] = [];
  const lines: string[] = [];
  const fires: Fire[] = [];
  const taken = new Set<string>();
  let stop = false;
  let rest = 0;
  for (const hit of [...hits].sort(byOrder)) {
    const { id } = hit.note;
    if (taken.has(id) || seen.has(id)) continue;
    taken.add(id);
    if (fires.length === cap) {
      rest++;
      continue;
    }
    const note = load(store, hit.note);
    if (!note) continue;
    const claim = seen.claim(id);
    if (claim === "seen") continue;
    // A stop that left no record loads as a plain command note.
    const kind = hit.kind === "stop" && claim !== "first" ? "cmd" : hit.kind;
    if (kind === "stop") stop = true;
    const head = `${note.id} [${note.kind}] ${oneLine(note.title, TITLE_CHARS)}`;
    // A gotcha is short and is lost when the agent does not open it, so it comes whole.
    const form = kind !== "path" || note.kind === "gotcha" ? "body" : "title";
    if (form === "title") lines.push(`- ${head}`);
    else blocks.push(`### ${head}\n${kind === "path" ? `anchor on ${oneLine(hit.match, PATH_CHARS)}` : `trigger ${kind}: ${hit.match}`}\n${cutBody(note)}`);
    fires.push({ note: id, kind, form, match: hit.match });
  }
  if (fires.length === 0) return null;
  const parts = blocks.length === 0 ? [] : [stop ? STOP_LEAD : shape.lead(fires.length), ...blocks];
  if (lines.length > 0) parts.push(`${blocks.length === 0 ? shape.onlyTitles : shape.titles}\n${lines.join("\n")}`);
  let text = parts.join("\n\n");
  if (shape.countRest && rest > 0) text += `\n${rest} more. \`kb search\` finds them.`;
  return { text, stop, scope, fires };
}

/** The repo of a folder, or nulls. It runs git, so it is called only when a note of a repo may apply. */
const repoOf = (store: Store, dir: string) => resolveRepo(dir, store, { record: false });

/** The folder a command line runs in: the one it starts with a `cd` to, or the folder of the session. */
function startFolder(commands: string[][], cwd: string): string {
  const first = commands[0];
  if (first?.length !== 2 || first[0] !== "cd") return cwd;
  const to = first[1]!;
  return to.startsWith("~/") ? join(homedir(), to.slice(2)) : resolve(cwd, to);
}

/**
 * Before a shell command: the notes whose `cmd` or `stop` trigger names a command in it, of the
 * repo and of the global scope, and the repo notes whose anchor is a path in it. Most commands
 * match nothing, and for them this reads one small file and runs no git.
 */
export function beforeCommand(store: Store, command: string, cwd: string, reader: Reader, now = Date.now()): Fired | null {
  if (!store.exists() || !command) return null;
  const { notes } = triggerTable(store);
  const seen = seenBy(store, reader, now);
  // First a test on the text alone. Only a command that passes it is read word by word.
  const named: { note: TableNote; kind: "cmd" | "stop"; words: string[] }[] = [];
  const onPath: TableNote[] = [];
  for (const note of notes) {
    const stop = note.stop.filter((words) => mayMatchCommand(words, command));
    const cmd = note.cmd.filter((words) => mayMatchCommand(words, command));
    const path = note.paths.some((path) => command.includes(path));
    if ((stop.length === 0 && cmd.length === 0 && !path) || seen.has(note.id)) continue;
    for (const words of stop) named.push({ note, kind: "stop", words });
    for (const words of cmd) named.push({ note, kind: "cmd", words });
    if (path) onPath.push(note);
  }
  if (named.length === 0 && onPath.length === 0) return null;

  const commands = simpleCommands(command);
  let hits: Hit[] = named.filter((each) => matchesCommand(each.words, commands)).map(({ note, kind, words }) => ({ note, kind, match: words.join(" ") }));
  if (hits.length === 0 && onPath.length === 0) return null;
  // A note may load now, so the repo is worth its git calls: it picks the notes, and the log names it.
  const folder = startFolder(commands, cwd);
  const repo = repoOf(store, folder);
  hits = hits.filter((hit) => hit.note.scope === "global" || hit.note.scope === repo.scope);
  const mine = onPath.filter((note) => note.scope === repo.scope);
  if (repo.root && mine.length > 0) {
    const words = pathWords(commands).filter((word) => mine.some((note) => note.paths.some((path) => word.includes(path)))).slice(0, MAX_PATH_WORDS);
    for (const word of words) {
      const path = pathInRepo(repo.root, word.startsWith("~/") ? join(homedir(), word.slice(2)) : resolve(folder, word));
      if (path === null) continue;
      for (const note of mine) if (note.paths.some((anchor) => covers(anchor, path))) hits.push({ note, kind: "path", match: path });
    }
  }
  const shape: Shape = {
    lead: (count) => (count === 1 ? "kb has a note for this command." : "kb has notes for this command."),
    titles: "Other notes are on files that the command names. Read the ones that apply with `kb show <id>`:",
    onlyTitles: "kb has notes on files that this command names. Read the ones that apply with `kb show <id>`:",
  };
  return give(store, hits, reader, repo.scope ?? "global", NOTES_PER_CALL, shape, now);
}

/** The repo notes whose anchor names the file or a folder above it. */
function onFile(store: Store, file: string, reader: Reader, now: number): { hits: Hit[]; scope: string; path: string } | null {
  if (!store.exists() || !isAbsolute(file)) return null;
  const { notes } = triggerTable(store);
  const seen = seenBy(store, reader, now);
  // First a test on the text alone, so a file that no anchor can name costs no git call.
  const full = realFile(file);
  const may = notes.filter((note) => note.paths.some((path) => full.endsWith(`/${path}`) || full.includes(`/${path}/`)) && !seen.has(note.id));
  if (may.length === 0) return null;
  const found = fileInRepo(store, file);
  if (!found) return null;
  const hits = may.filter((note) => note.scope === found.scope && note.paths.some((anchor) => covers(anchor, found.path))).map((note): Hit => ({ note, kind: "path", match: found.path }));
  return { hits, ...found };
}

/** The text around the notes on one file. `ask` says what to do with the notes that come as a title. */
function fileShape(path: string, ask: string): Shape {
  const lead = `kb has notes on ${oneLine(path, PATH_CHARS)}.`;
  return { lead: () => lead, titles: ask, onlyTitles: `${lead} ${ask}`, countRest: true };
}

/** Before a change of a file: the notes on it. A gotcha comes whole, another kind as its title. */
export function beforeEdit(store: Store, file: string, reader: Reader, now = Date.now()): Fired | null {
  const found = onFile(store, file, reader, now);
  return found && give(store, found.hits, reader, found.scope, NOTES_PER_CALL, fileShape(found.path, "Read the notes that apply with `kb show <id>`:"), now);
}

/** After a read of a file: the notes on it, so the agent has them when it works on the file. */
export function afterRead(store: Store, file: string, reader: Reader, now = Date.now()): Fired | null {
  const found = onFile(store, file, reader, now);
  return found && give(store, found.hits, reader, found.scope, NOTES_PER_FILE, fileShape(found.path, "Before you change this file, read the notes that apply with `kb show <id>`:"), now);
}

/** After a tool call that failed: the notes whose `err` trigger is in the error text, of the repo and of the global scope. */
export function afterFailure(store: Store, error: string, cwd: string, reader: Reader, now = Date.now()): Fired | null {
  if (!store.exists() || !error) return null;
  const { notes } = triggerTable(store);
  const seen = seenBy(store, reader, now);
  const said = errorText(error);
  let hits: Hit[] = [];
  for (const note of notes) {
    if (note.err.length === 0 || seen.has(note.id)) continue;
    const text = note.err.find((each) => said.includes(each));
    if (text !== undefined) hits.push({ note, kind: "err", match: text });
  }
  if (hits.length === 0) return null;
  const scope = repoOf(store, cwd).scope ?? "global";
  hits = hits.filter((hit) => hit.note.scope === "global" || hit.note.scope === scope);
  // Every note of an error comes whole, so the lines for titles are never used.
  const shape: Shape = { lead: (count) => (count === 1 ? "kb has a note for this error." : "kb has notes for this error."), titles: "", onlyTitles: "" };
  return give(store, hits, reader, scope, NOTES_PER_CALL, shape, now);
}
