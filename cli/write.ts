// Changes to stored notes, shared by the CLI commands and `kb serve`.

import { KbError, serializeNote, validateNote } from "./note.ts";
import type { RepoInfo } from "./scope.ts";
import { clearStaleCache } from "./stale.ts";
import { type Store, type StoredNote, writeAtomic } from "./store.ts";
import { kickSync } from "./sync.ts";

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Regenerate the derived files, commit, and start a background sync. */
export function afterWrite(store: Store, message: string): void {
  store.writeIndex();
  clearStaleCache(store);
  if (store.commit(message)) kickSync(store);
}

/** Ids that contain the given text. For a caller who remembers a part of an id. */
export function closeIds(store: Store, part: string): string[] {
  const text = part.toLowerCase();
  if (!text) return [];
  return [...store.notes(), ...store.notes({ trashed: true })].filter((n) => n.id.includes(text)).map((n) => n.id).sort();
}

export function requireNote(store: Store, id: string): StoredNote {
  const note = store.find(id);
  if (note) return note;
  const close = closeIds(store, id);
  const more = close.length > 8 ? `, and ${close.length - 8} more` : "";
  throw new KbError(`no note with id "${id}"${close.length > 0 ? `. Ids with that text: ${close.slice(0, 8).join(", ")}${more}` : ""}`);
}

/**
 * Merge the given fields over an active note. `repo` is where the change was made:
 * a change of content inside the note's own repo also records that repo's HEAD.
 */
export function updateNote(store: Store, input: Record<string, unknown> & { id: string }, repo: Pick<RepoInfo, "scope" | "head">): { id: string; path: string } {
  const existing = store.notes().find((n) => n.id === input.id);
  if (!existing) throw new KbError(`no active note with id "${input.id}"`);
  const { path: _path, trashed: _trashed, ...stored } = existing;
  const merged: Record<string, unknown> = { ...stored, ...input, scope: existing.scope, created: existing.created };
  // Only a change of content says that somebody looked at the fact again.
  if (["title", "body", "anchors"].some((key) => key in input)) {
    merged.last_verified = nowIso();
    if (repo.scope === existing.scope && repo.head) merged.verified_at_commit = repo.head;
  }
  const note = validateNote(merged);
  const path = store.writeNote(note);
  afterWrite(store, `kb: update ${note.id}`);
  return { id: note.id, path };
}

/**
 * Move notes between notes/ and trash/. The trash is the normal way to retire a note: it can
 * come back until the trash clears it, `trashDays` after it went there.
 */
export function moveNotes(store: Store, ids: string[], toTrash: boolean): string[] {
  const moved: string[] = [];
  for (const id of ids) {
    const note = requireNote(store, id);
    if (note.trashed === toTrash) throw new KbError(`${id} is already ${toTrash ? "in the trash" : "active"}`);
    store.move(note, toTrash, nowIso());
    moved.push(id);
  }
  afterWrite(store, `kb: ${toTrash ? "trash" : "restore"} ${moved.join(" ")}`);
  return moved;
}

function removeNotes(store: Store, notes: StoredNote[], message: string): string[] {
  for (const note of notes) store.remove(note);
  const deleted = notes.map((n) => n.id);
  store.dropUsage(deleted);
  afterWrite(store, message);
  return deleted;
}

/**
 * Remove notes for good, active or in the trash. For a note the user wants gone now, not for
 * finished work, which goes to the trash. Every id is checked before the first file goes.
 */
export function deleteNotes(store: Store, ids: string[]): string[] {
  const notes = [...new Set(ids)].map((id) => requireNote(store, id));
  return removeNotes(store, notes, `kb: delete ${notes.map((n) => n.id).join(" ")}`);
}

/** Remove every note in the trash for good. */
export function emptyTrash(store: Store): string[] {
  const notes = store.notes({ trashed: true });
  if (notes.length === 0) return [];
  return removeNotes(store, notes, `kb: empty the trash (${notes.length})`);
}

const DAY_MS = 86_400_000;

/** When the trash clears a note: `trashDays` after it went there. */
export function clearsAt(trashedAt: string, days: number): string {
  return new Date(Date.parse(trashedAt) + days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Housekeeping before a command: give a note in the trash with no time one (a file moved there
 * by hand), and delete the notes whose time in the trash is up. One commit, and only when
 * something changed. Returns the ids deleted.
 */
export function tidyTrash(store: Store, now = nowIso()): string[] {
  const days = store.config().trashDays;
  const expired: StoredNote[] = [];
  let stamped = 0;
  for (const note of store.notes({ trashed: true })) {
    if (!note.trashed_at) {
      const { path, trashed: _trashed, ...rest } = note;
      writeAtomic(path, serializeNote({ ...rest, trashed_at: now }));
      stamped++;
    } else if (clearsAt(note.trashed_at, days) <= now) expired.push(note);
  }
  if (expired.length > 0) return removeNotes(store, expired, `kb: clear ${expired.length} from the trash after ${days} days: ${expired.map((n) => n.id).join(" ")}`);
  if (stamped > 0) afterWrite(store, "kb: record when trashed notes went to the trash");
  return [];
}
