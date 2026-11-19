// Notes by path: when a session reads a file, the repo notes whose anchors name that file or a
// folder above it. A note then reaches the agent when it works on that file, also when the note
// has no place in the session's index.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { KINDS } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import type { Store, StoredNote } from "./store.ts";

/** At most this many notes are named for one Read, so a busy folder cannot flood the session. */
export const NOTES_PER_FILE = 5;

/** A title longer than this is cut. With NOTES_PER_FILE lines the notice stays far under the 10,000 character limit of a hook. */
const TITLE_CHARS = 200;
const PATH_CHARS = 300;

/** A record of what a session got is kept this long after its last change. A session older than this is over. */
const SEEN_DAYS = 7;

/** A session id or an agent id that is safe as a file name. A note id is a slug, so it is safe too. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

/** Who read the file: the session, and the subagent when a subagent read it. A subagent has its own context. */
export interface Reader {
  session_id?: unknown;
  agent_id?: unknown;
}

/** An anchor's path in the form a repo-relative path has, or "" when it names no file: the root, or no path. */
function anchorPath(anchor: string): string {
  const hash = anchor.indexOf("#");
  const path = posix.normalize(hash === -1 ? anchor : anchor.slice(0, hash)).replace(/\/+$/, "");
  return path === "." ? "" : path;
}

/** True when the anchor names the file, or a folder that holds it. The repo root names every file, so it counts as no anchor. */
function covers(anchor: string, file: string): boolean {
  const path = anchorPath(anchor);
  return path !== "" && (file === path || file.startsWith(`${path}/`));
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The notes of the file's repo whose anchors cover the file, in kind order. null when the file is
 * in no repo, or there is no store. It never writes: it runs on every Read.
 */
export function notesForFile(store: Store, file: string): { scope: string; path: string; notes: StoredNote[] } | null {
  if (!isAbsolute(file) || !store.exists()) return null;
  // Only the folder is resolved. A file that is a link keeps the path the agent read, so the
  // notes on that place in the repo still apply.
  const folder = real(dirname(file));
  const repo = resolveRepo(folder, store, { record: false });
  if (!repo.scope || !repo.root) return null;
  const path = relative(real(repo.root), join(folder, basename(file))).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) return null;
  const notes = store
    .notes()
    .filter((n) => n.scope === repo.scope && !n.promoted_to && n.anchors.some((a) => covers(a, path)))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
  return { scope: repo.scope, path, notes };
}

const seenRoot = (store: Store) => store.statePath("by-path");

/** The folder that records what this reader got, one empty file per note id. null: no usable id, so nothing is recorded. */
function seenDir(store: Store, reader: Reader): string | null {
  const { session_id: session, agent_id: agent } = reader;
  if (typeof session !== "string" || !SAFE.test(session)) return null;
  if (agent === undefined || agent === null) return join(seenRoot(store), session);
  // "." is not in SAFE, so a subagent's folder can never be the folder of another session.
  return typeof agent === "string" && SAFE.test(agent) ? join(seenRoot(store), `${session}.${agent}`) : null;
}

/** Remove the records of sessions that ended long ago. */
function prune(store: Store, keep: string, now: number): void {
  for (const name of readdirSync(seenRoot(store))) {
    const old = join(seenRoot(store), name);
    if (old === keep) continue;
    try {
      if (now - statSync(old).mtimeMs > SEEN_DAYS * 86_400_000) rmSync(old, { recursive: true, force: true });
    } catch {
      // another session removed it first
    }
  }
}

/** Forget what the main agent of a session got. After a compaction or a /clear its context lost the notes, so they may come again. */
export function forgetSeen(store: Store, session: unknown): void {
  const dir = seenDir(store, { session_id: session });
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** One line: a newline in a title must not start a list line of its own. */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** What a Read gives the agent: the text, and the notes it names, for the event log. */
export interface PathNotice {
  text: string;
  scope: string;
  /** The repo-relative path of the file. */
  path: string;
  /** The ids of the notes the text names. */
  notes: string[];
}

/**
 * What the agent reads after it reads a file: the notes on the file that this reader has not got
 * yet, at most NOTES_PER_FILE. null when there is nothing new. Each named note is recorded before
 * it is returned, with a create that fails when the file exists, so of two Reads at the same time
 * only one names a note.
 */
export function byPathNotice(store: Store, file: string, reader: Reader, now = Date.now()): PathNotice | null {
  const found = notesForFile(store, file);
  if (!found || found.notes.length === 0) return null;
  const dir = seenDir(store, reader);
  let ready = false;
  /** True when this Read is the first to name the note. */
  const claim = (id: string): boolean => {
    if (!dir) return true;
    if (!ready) {
      ready = true;
      store.ensure(); // keeps .state/ out of git in a store made by an older version
      mkdirSync(seenRoot(store), { recursive: true });
      try {
        mkdirSync(dir); // fails when the folder exists, so the prune runs once per session
        prune(store, dir, now);
      } catch {
        // the session has a record already
      }
    }
    try {
      writeFileSync(join(dir, id), "", { flag: "wx" });
      return true;
    } catch (error) {
      // Another Read named it. Any other failure: name it, and it may come again.
      return (error as NodeJS.ErrnoException).code !== "EEXIST";
    }
  };
  const named: StoredNote[] = [];
  let more = 0;
  for (const note of found.notes) {
    if (dir && existsSync(join(dir, note.id))) continue;
    if (named.length === NOTES_PER_FILE) more++;
    else if (claim(note.id)) named.push(note);
  }
  if (named.length === 0) return null;
  const lines = [
    `kb has notes on ${oneLine(found.path, PATH_CHARS)}. Before you change this file, read the notes that apply with \`kb show <id>\`:`,
    ...named.map((n) => `- ${n.id} [${n.kind}] ${oneLine(n.title, TITLE_CHARS)}`),
  ];
  if (more > 0) lines.push(`${more} more. \`kb search\` finds them.`);
  return { text: lines.join("\n"), scope: found.scope, path: found.path, notes: named.map((n) => n.id) };
}
