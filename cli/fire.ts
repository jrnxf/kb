// Notes at their trigger: what a tool call loads. A session start gives notes before the task is
// known. Here a note comes at the moment it applies: at a shell command that a `cmd` or a
// `stop` trigger names (only `stop` comes before the run), after an error that an `err` trigger
// names, and when the agent works on a file that an anchor names. Each reader gets each note once.
// The caller is a hook: this file knows no harness, only a command, a file, an error text and who
// asks.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type Reader, type Seen, covers, fileInRepo, isFolder, pathInRepo, realFile, seenBy } from "./by-path.ts";
import { isNeighborsAnswer } from "./neighbors.ts";
import { BODY_CHARS, KINDS, type Note, parseNote } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import { CHANGED_ASK, CHANGED_MARK, changedNotes } from "./stale.ts";
import { type Store, tilde } from "./store.ts";
import { type TableNote, triggerTable } from "./table.ts";
import { commandAt, errorText, matchesCommand, mayMatchCommand, pathWords, simpleCommands } from "./trigger.ts";

/** At most this many notes load for one command, one change of a file or one error. */
export const NOTES_PER_CALL = 3;
/** At most this many notes are given for one Read, so a busy folder cannot flood the session. */
export const NOTES_PER_FILE = 5;
/**
 * An agent can send several tool calls in one message, and all of them run before it reads the
 * first refusal. So a `stop` note refuses every call that matches it for this long after its first
 * refusal. A call after that passes: by then the agent has read the note. kb cannot tell a call of
 * the same message from a fast second try, so the reason of each refusal names the wait.
 */
export const STOP_WINDOW_MS = 3000;

/** At most this many changed paths are named for one note. */
const CHANGED_PATHS = 3;
/** Under the notes of a call, when one has the mark. It comes with the note, so the session that uses the note checks it. */
const CHANGED_NOTE = `A note with "${CHANGED_MARK}" is on a file that changed after the note was last checked. ${CHANGED_ASK}`;

/** A title longer than this is cut. With the caps above, the text stays far under the 10,000 character limit of a hook. */
const TITLE_CHARS = 200;
const PATH_CHARS = 300;
/** The words of one command that are looked at as paths. */
const MAX_PATH_WORDS = 40;
/** The `cd` targets of one command line that are looked at. Each folder costs git calls. */
const MAX_CD_FOLDERS = 4;

export type FireKind = "cmd" | "stop" | "err" | "path";
/** The agent got the body, or one line with the title. */
type Form = "body" | "title";

/** One note that loaded, as the event log records it. */
export interface Fire {
  note: string;
  kind: FireKind;
  form: Form;
  /** What matched: the words of the trigger, the text of the error trigger, or the repo-relative path. */
  match: string;
  /** True when the note came with the mark that an anchored file changed after its last check. */
  changed?: true;
}

export interface Fired {
  /** What the agent reads. */
  text: string;
  /**
   * True when a `stop` note refuses the call: the caller refuses the tool call, with the text as
   * the reason. The record of the refusal makes the same call pass after STOP_WINDOW_MS.
   */
  stop: boolean;
  /** The repo the tool call belongs to, or "global". */
  scope: string;
  /** The notes in the text. A refusal inside the window gives no note again, so it can have none. */
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

/** The note as the store holds it now, or null when its file is gone since the table was built. */
function load(store: Store, entry: TableNote): Note | null {
  try {
    return parseNote(readFileSync(join(store.home, entry.file), "utf8"));
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

const STOP_SECONDS = STOP_WINDOW_MS / 1000;
/** A note that stops the call says so first, and says how the call passes. */
const STOP_LEAD = `kb stopped this command once, because a note says that one run can do damage. Read the note. If the command still applies, run it again in ${STOP_SECONDS} seconds: it passes then.`;
/** Above the stop notes of the call that did not fit whole. */
const STOP_TITLES = "These notes stop this command too. Read them with `kb show <id>`:";
/** The reason of a refusal inside the window. The reader has each note from the first refusal, so only the ids come. */
const stopAgain = (ids: string[]) =>
  `kb stopped this command too. It came less than ${STOP_SECONDS} seconds after a refusal, and you have the reason from that refusal: ${ids.join(", ")}. If the command still applies, wait ${STOP_SECONDS} seconds, then run it again: it passes then.`;

/**
 * The records of one reader. The record with the id of a note says that the reader has its body.
 * A title is one line, and the reader may never open the note. So a title has a record of its own:
 * the title comes once, and the body can still load once at a `cmd` or an `err` trigger. A note
 * id is a slug, so no id ends like these names.
 */
const titleRecord = (id: string) => `${id}.title`;
/**
 * The record that a note stopped a command for this reader. It is apart from the records of the
 * note itself: a session that has the note from a Read or an error is still stopped once.
 */
const stopRecord = (id: string) => `${id}.stop`;

/** A gotcha is short and is lost when the agent does not open it, so it comes whole also on a path. */
const formOf = (kind: FireKind, note: Pick<TableNote, "kind">): Form => (kind !== "path" || note.kind === "gotcha" ? "body" : "title");

/** True when the reader has the note in this form, or whole. */
const has = (seen: Seen, id: string, form: Form) => seen.has(id) || (form === "title" && seen.has(titleRecord(id)));

/** True when the stop of a note can still refuse a call: it refused none yet, or its first refusal is inside the window. */
function stopOpen(seen: Seen, id: string, now: number): boolean {
  const first = seen.at(stopRecord(id));
  return first === null || now - first < STOP_WINDOW_MS;
}

/**
 * Whether a stop note refuses this call. "first": it does, and this call made the record of it.
 * "again": a call before this one made the record, less than the window ago. null: the window is
 * over. null also when nothing can be recorded: with no record the same call would be refused
 * each time.
 */
function refuse(seen: Seen, id: string, now: number): "first" | "again" | null {
  const first = seen.at(stopRecord(id));
  if (first !== null) return now - first < STOP_WINDOW_MS ? "again" : null;
  const claim = seen.claim(stopRecord(id));
  // "seen": another call of the same message made the record this moment.
  return claim === "first" ? "first" : claim === "seen" ? "again" : null;
}

/**
 * Give the reader the hits it has not got yet, at most `cap`, and record each. null when there is
 * nothing new and nothing refuses the call. A refusal claims every stop note of the call, so a run
 * after the window passes: the first `cap` of them come whole, and the others as a title.
 */
function give(store: Store, hits: Hit[], reader: Reader, scope: string, cap: number, shape: Shape, now: number): Fired | null {
  if (hits.length === 0) return null;
  const seen = seenBy(store, reader, now);
  const blocks: string[] = [];
  const stopLines: string[] = [];
  const lines: string[] = [];
  const fires: Fire[] = [];
  /** The stop notes that refused a call a moment ago, and refuse this one too. */
  const again: string[] = [];
  const taken = new Set<string>();
  let given = 0;
  let rest = 0;
  // The anchored paths of a note that changed after its last check. One small file per repo, read at the first note of that repo.
  const checks = new Map<string, ReturnType<typeof changedNotes>>();
  const changedOf = (note: Note): string[] => {
    if (note.scope === "global") return [];
    if (!checks.has(note.scope)) checks.set(note.scope, changedNotes(store, note.scope));
    return checks.get(note.scope)!(note);
  };
  for (const hit of [...hits].sort(byOrder)) {
    const { id } = hit.note;
    if (taken.has(id)) continue;
    taken.add(id);
    const note = load(store, hit.note);
    if (!note) continue;
    const refusal = hit.kind === "stop" ? refuse(seen, id, now) : null;
    if (refusal === "again") {
      again.push(id);
      continue;
    }
    const stops = refusal === "first";
    // A stop that refuses nothing loads as a plain command note.
    const kind = hit.kind === "stop" && !stops ? "cmd" : hit.kind;
    let form = formOf(kind, note);
    if (stops) {
      // The note is the reason for the refusal, so it comes also when the reader has it.
      if (given === cap) form = "title";
      else given++;
      seen.claim(form === "body" ? id : titleRecord(id));
    } else {
      if (has(seen, id, form)) continue;
      if (given === cap) {
        rest++;
        continue;
      }
      if (seen.claim(form === "body" ? id : titleRecord(id)) === "seen") continue;
      given++;
    }
    const head = `${note.id} [${note.kind}] ${oneLine(note.title, TITLE_CHARS)}`;
    const changed = changedOf(note);
    const more = changed.length > CHANGED_PATHS ? `, and ${changed.length - CHANGED_PATHS} more` : "";
    const mark = changed.length > 0 ? `${CHANGED_MARK}: ${oneLine(changed.slice(0, CHANGED_PATHS).join(", "), PATH_CHARS)}${more}` : "";
    if (form === "title") (stops ? stopLines : lines).push(`- ${head}${mark ? ` (${mark})` : ""}`);
    else blocks.push(`### ${head}\n${kind === "path" ? `anchor on ${oneLine(hit.match, PATH_CHARS)}` : `trigger ${kind}: ${hit.match}`}\n${mark ? `${mark}\n` : ""}${cutBody(note)}`);
    fires.push({ note: id, kind, form, match: hit.match, ...(mark ? { changed: true as const } : {}) });
  }
  if (fires.length === 0 && again.length === 0) return null;
  const first = fires.some((fire) => fire.kind === "stop");
  const parts = again.length > 0 ? [stopAgain(again)] : [];
  if (blocks.length > 0) parts.push(first ? STOP_LEAD : shape.lead(fires.length), ...blocks);
  if (stopLines.length > 0) parts.push(`${STOP_TITLES}\n${stopLines.join("\n")}`);
  if (lines.length > 0) parts.push(`${blocks.length === 0 ? shape.onlyTitles : shape.titles}\n${lines.join("\n")}`);
  let text = parts.join("\n\n");
  if (shape.countRest && rest > 0) text += `\n${rest} more. \`kb search\` finds them.`;
  if (fires.some((fire) => fire.changed)) text += `\n\n${CHANGED_NOTE}`;
  return { text, stop: first || again.length > 0, scope, fires };
}

/** The repo of a folder, or nulls. It runs git, so it is called only when a note of a repo may apply. */
const repoOf = (store: Store, dir: string) => resolveRepo(dir, store, { record: false });

/**
 * The folders a command line can run in: the folder of the tool call, then each folder that a `cd`
 * in the line goes to. kb runs no shell, so it cannot say which command runs where: a `cd` in a
 * subshell, or a `cd` back, holds for a part of the line only. So the notes of each of these
 * folders apply. A `cd` to a variable, or to a folder that is not there, changes nothing.
 */
function folders(commands: string[][], cwd: string): string[] {
  const all = [cwd];
  let last = cwd;
  for (const words of commands) {
    const at = commandAt(words);
    if (words[at] !== "cd") continue;
    // `cd -P dir` and `cd -- dir`. `cd -` and a bare `cd` name no folder.
    const to = words.slice(at + 1).find((word) => !word.startsWith("-"));
    if (to === undefined) continue;
    // A relative target starts at the last `cd`, or at the folder of the call when a subshell held that `cd`.
    const dir = [last, cwd].map((from) => resolve(from, tilde(to))).find(isFolder);
    if (dir === undefined) continue;
    last = dir;
    if (!all.includes(dir)) all.push(dir);
    if (all.length > MAX_CD_FOLDERS) break;
  }
  return all;
}

/**
 * Before a shell command: the notes whose `cmd` or `stop` trigger names a command in it, of the
 * global scope and of each repo the line can run in, and the repo notes whose anchor is a path in
 * it. Most commands match nothing, and for them this reads one small file and runs no git.
 */
export function beforeCommand(store: Store, command: string, cwd: string, reader: Reader, now = Date.now()): Fired | null {
  if (!store.exists() || !command) return null;
  const { notes } = triggerTable(store);
  const seen = seenBy(store, reader, now);
  const named: { note: TableNote; kind: "cmd" | "stop"; words: string[] }[] = [];
  const onPath: TableNote[] = [];
  for (const note of notes) {
    // First a test on the text alone: it reads no file, and most notes fail it for most commands.
    const stop = note.stop.filter((words) => mayMatchCommand(words, command));
    const cmd = note.cmd.filter((words) => mayMatchCommand(words, command));
    const path = note.paths.some((path) => command.includes(path));
    if (stop.length === 0 && cmd.length === 0 && !path) continue;
    // Then the records of the reader. A note that it has whole loads no more. Its stop can still refuse the command.
    const whole = seen.has(note.id);
    if (stop.length > 0 && (!whole || stopOpen(seen, note.id, now))) for (const words of stop) named.push({ note, kind: "stop", words });
    if (whole) continue;
    for (const words of cmd) named.push({ note, kind: "cmd", words });
    if (path && !has(seen, note.id, formOf("path", note))) onPath.push(note);
  }
  if (named.length === 0 && onPath.length === 0) return null;

  // Only a command that passes the test is read word by word.
  const commands = simpleCommands(command);
  let hits: Hit[] = named.filter((each) => matchesCommand(each.words, commands)).map(({ note, kind, words }) => ({ note, kind, match: words.join(" ") }));
  if (hits.length === 0 && onPath.length === 0) return null;
  // A note may load now, so the repos are worth their git calls: they pick the notes, and the log names one.
  const repos = folders(commands, cwd).map((dir) => ({ dir, ...repoOf(store, dir) }));
  hits = hits.filter((hit) => hit.note.scope === "global" || repos.some((repo) => repo.scope === hit.note.scope));
  const words = pathWords(commands).filter((word) => onPath.some((note) => note.paths.some((path) => word.includes(path)))).slice(0, MAX_PATH_WORDS);
  for (const repo of repos) {
    const mine = onPath.filter((note) => note.scope === repo.scope);
    if (!repo.root || mine.length === 0) continue;
    for (const word of words) {
      const path = pathInRepo(repo.root, resolve(repo.dir, tilde(word)));
      if (path === null) continue;
      for (const note of mine) if (note.paths.some((anchor) => covers(anchor, path))) hits.push({ note, kind: "path", match: path });
    }
  }
  const shape: Shape = {
    lead: (count) => (count === 1 ? "kb has a note for this command." : "kb has notes for this command."),
    titles: "Other notes are on files that the command names. Read the ones that apply with `kb show <id>`:",
    onlyTitles: "kb has notes on files that this command names. Read the ones that apply with `kb show <id>`:",
  };
  // The log names the repo of the session, or else the first repo that the line goes to.
  const scope = repos.find((repo) => repo.scope)?.scope ?? "global";
  return give(store, hits, reader, scope, NOTES_PER_CALL, shape, now);
}

/** The repo notes whose anchor names the file or a folder above it. */
function onFile(store: Store, file: string, reader: Reader, now: number): { hits: Hit[]; scope: string; path: string } | null {
  if (!store.exists() || !isAbsolute(file)) return null;
  const { notes } = triggerTable(store);
  const seen = seenBy(store, reader, now);
  // First a test on the text alone, so a file that no anchor can name costs no git call.
  const full = realFile(file);
  const may = notes.filter((note) => note.paths.some((path) => full.endsWith(`/${path}`) || full.includes(`/${path}/`)) && !has(seen, note.id, formOf("path", note)));
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
  // A `neighbors` answer of `kb add` is a failed call for the harness. It quotes the titles of
  // stored notes, and the error words of a title must not load its note as if the error had come.
  if (!store.exists() || !error || isNeighborsAnswer(error)) return null;
  const { notes } = triggerTable(store);
  const seen = seenBy(store, reader, now);
  const said = errorText(error);
  let hits: Hit[] = [];
  for (const note of notes) {
    // The test on the text comes first: it reads no file.
    const text = note.err.find((each) => said.includes(each));
    if (text !== undefined && !seen.has(note.id)) hits.push({ note, kind: "err", match: text });
  }
  if (hits.length === 0) return null;
  const scope = repoOf(store, cwd).scope ?? "global";
  hits = hits.filter((hit) => hit.note.scope === "global" || hit.note.scope === scope);
  // Every note of an error comes whole, so the lines for titles are never used.
  const shape: Shape = { lead: (count) => (count === 1 ? "kb has a note for this error." : "kb has notes for this error."), titles: "", onlyTitles: "" };
  return give(store, hits, reader, scope, NOTES_PER_CALL, shape, now);
}
