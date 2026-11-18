// Notes by path: when a session reads a file, the repo notes whose anchors name that file or a
// folder above it. A note then reaches the agent when it works on that file, also when the note
// has no place in the session's index.

import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { KINDS } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import { type Store, type StoredNote, writeAtomic } from "./store.ts";

/** At most this many notes are named for one file, so a busy folder cannot flood the session. */
export const NOTES_PER_FILE = 5;

/** A record of what a session got is kept this long. A session older than this is over. */
const SEEN_DAYS = 7;

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** True when the anchor names the file, or a folder that holds it. The repo root itself names every file, so it counts as no anchor. */
function covers(anchor: string, file: string): boolean {
  const hash = anchor.indexOf("#");
  const path = (hash === -1 ? anchor : anchor.slice(0, hash)).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || path === ".") return false;
  return file === path || file.startsWith(`${path}/`);
}

/**
 * The notes of the file's repo whose anchors cover the file, in kind order. null when the file is
 * in no repo, or outside the store's reach.
 */
export function notesForFile(store: Store, file: string): { scope: string; path: string; notes: StoredNote[] } | null {
  if (!isAbsolute(file) || !store.exists()) return null;
  const full = real(file);
  const repo = resolveRepo(dirname(full), store);
  if (!repo.scope || !repo.root) return null;
  const path = relative(real(repo.root), full).split(sep).join("/");
  if (!path || path.startsWith("..")) return null;
  const notes = store
    .notes()
    .filter((n) => n.scope === repo.scope && !n.promoted_to && n.anchors.some((a) => covers(a, path)))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
  return { scope: repo.scope, path, notes };
}

const seenDir = (store: Store) => store.statePath("by-path");
const seenFile = (store: Store, session: string) => (/^[A-Za-z0-9_-]{1,128}$/.test(session) ? join(seenDir(store), `${session}.json`) : null);

function readSeen(path: string): string[] {
  try {
    const ids = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The ids of these that the session has not got yet. Without a usable session id, every id is new. */
export function unseen(store: Store, session: unknown, ids: string[]): string[] {
  const path = typeof session === "string" ? seenFile(store, session) : null;
  if (!path) return ids;
  const seen = readSeen(path);
  return ids.filter((id) => !seen.includes(id));
}

/** Record that the session got these ids, and remove the records of sessions that ended long ago. */
export function markSeen(store: Store, session: unknown, ids: string[], now = Date.now()): void {
  const path = typeof session === "string" ? seenFile(store, session) : null;
  if (!path || ids.length === 0) return;
  store.ensure(); // keeps .state/ out of git in a store made by an older version
  mkdirSync(seenDir(store), { recursive: true });
  writeAtomic(path, JSON.stringify([...new Set([...readSeen(path), ...ids])]));
  for (const name of readdirSync(seenDir(store))) {
    const old = join(seenDir(store), name);
    try {
      if (now - statSync(old).mtimeMs > SEEN_DAYS * 86_400_000) rmSync(old, { force: true });
    } catch {
      // another session removed it first
    }
  }
}

/** Forget what a session got. After a compaction the summary has lost the notes, so they may come again. */
export function forgetSeen(store: Store, session: unknown): void {
  const path = typeof session === "string" ? seenFile(store, session) : null;
  if (path) rmSync(path, { force: true });
}

/**
 * What the agent reads after it reads a file, and the ids it names: the notes on the file that the
 * session has not got yet, at most NOTES_PER_FILE. null when there is nothing new. The ids count as
 * got only when the caller marks them, after the text reached the agent.
 */
export function byPathNotice(store: Store, file: string, session: unknown): { text: string; ids: string[] } | null {
  const found = notesForFile(store, file);
  if (!found) return null;
  const fresh = new Set(unseen(store, session, found.notes.map((n) => n.id)));
  const notes = found.notes.filter((n) => fresh.has(n.id));
  if (notes.length === 0) return null;
  const shown = notes.slice(0, NOTES_PER_FILE);
  const lines = [`kb has notes on ${found.path}. Before you change this file, read the notes that apply with \`kb show <id>\`:`, ...shown.map((n) => `- ${n.id} [${n.kind}] ${n.title}`)];
  if (notes.length > shown.length) lines.push(`${notes.length - shown.length} more. \`kb search\` finds them.`);
  return { text: lines.join("\n"), ids: shown.map((n) => n.id) };
}
