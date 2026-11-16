// Changes to stored notes, shared by the CLI commands and `kb serve`.

import { KbError, validateNote } from "./note.ts";
import type { RepoInfo } from "./scope.ts";
import { clearStaleCache } from "./stale.ts";
import type { Store, StoredNote } from "./store.ts";
import { kickSync } from "./sync.ts";

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Regenerate the derived files, commit, and start a background sync. */
export function afterWrite(store: Store, message: string): void {
  store.writeIndex();
  clearStaleCache(store);
  if (store.commit(message)) kickSync(store);
}

export function requireNote(store: Store, id: string): StoredNote {
  const note = store.find(id);
  if (!note) throw new KbError(`no note with id "${id}"`);
  return note;
}

/**
 * Merge the given fields over an active note. `repo` is where the change was made:
 * a change of content inside the note's own repo also records that repo's HEAD.
 */
export function updateNote(store: Store, input: Record<string, unknown> & { id: string }, repo: Pick<RepoInfo, "scope" | "head">): { id: string; path: string } {
  const existing = store.notes().find((n) => n.id === input.id);
  if (!existing) throw new KbError(`no active note with id "${input.id}"`);
  const { path: _path, archived: _archived, ...stored } = existing;
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

/** Move notes between notes/ and archive/. Nothing is ever deleted. */
export function moveNotes(store: Store, ids: string[], toArchive: boolean): string[] {
  const moved: string[] = [];
  for (const id of ids) {
    const note = requireNote(store, id);
    if (note.archived === toArchive) throw new KbError(`${id} is already ${toArchive ? "archived" : "active"}`);
    store.move(note, toArchive);
    moved.push(id);
  }
  afterWrite(store, `kb: ${toArchive ? "archive" : "restore"} ${moved.join(" ")}`);
  return moved;
}
