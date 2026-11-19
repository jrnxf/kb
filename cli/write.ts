// Changes to stored notes, shared by the CLI commands and `kb serve`.

import { existsSync } from "node:fs";
import { type WriteOp, logEvent, rollUp } from "./log.ts";
import { BODY_CHARS, KbError, type Note, serializeNote, validateNote } from "./note.ts";
import { type RepoInfo, commitAt } from "./scope.ts";
import { rejectSecrets } from "./secrets.ts";
import { clearStaleCache } from "./stale.ts";
import { type Store, type StoredNote, writeAtomic } from "./store.ts";
import { kickSync } from "./sync.ts";
import { requireTriggers } from "./trigger.ts";

/** A time as kb writes it: ISO 8601 in UTC, to the second. */
export const isoTime = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
export const nowIso = (date: Date = new Date()) => isoTime(date.getTime());

/**
 * Regenerate the derived files, commit, and start a background sync. The roll-up of the log, which
 * is due once per day, goes into the same commit.
 */
export function afterWrite(store: Store, message: string): void {
  store.writeIndex();
  clearStaleCache(store);
  rollUp(store);
  if (store.commit(message)) kickSync(store);
}

/**
 * Record a write of each note in the event log. The session comes from the command that runs.
 * `neighbors` are the close notes that `kb add` showed with the write. `from` is the unsaved
 * session that a recovery read.
 */
export function logWrites(store: Store, op: WriteOp, ids: string[], neighbors: string[] = [], from?: string): void {
  logEvent(store, ids.map((note) => ({ ev: "write" as const, note, op, ...(from ? { from } : {}), ...(neighbors.length > 0 ? { neighbors } : {}) })));
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

// A date, a time to the second or finer, and a zone. `Date.parse` alone takes "1" for the year 2001.
const FULL_ISO = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The time `kb add --as-of` takes, as kb writes a time. A time after `now` is `now`. */
export function asOfTime(value: string, now = Date.now()): string {
  const [, year, month, day] = FULL_ISO.exec(value) ?? [];
  // `Date.parse` moves a day that the month does not have into the next month.
  const real = day !== undefined && new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDate() === Number(day);
  const time = real ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) throw new KbError("--as-of needs a full ISO time with a zone, such as 2026-01-31T12:00:00Z");
  return isoTime(Math.min(time, now));
}

/**
 * Merge the given fields over an active note. `repo` is where the change was made:
 * a change of content inside the note's own repo also records that repo's HEAD.
 * With `asOf`, the content comes from an earlier time (a session recovered later): the note is
 * verified at that time and at the commit of that time, never now. The caller refuses an `asOf`
 * before the note's last check, so old content never goes under a newer check. `from` is the
 * unsaved session that a recovery read, for the log.
 */
export function updateNote(store: Store, input: Record<string, unknown> & { id: string }, repo: Pick<RepoInfo, "scope" | "head"> & { root?: string | null }, asOf?: string, from?: string): { id: string; path: string } {
  const existing = store.notes().find((n) => n.id === input.id);
  if (!existing) throw new KbError(`no active note with id "${input.id}"`);
  rejectSecrets({ title: input.title, body: input.body, anchors: input.anchors, triggers: input.triggers }, `the new text of ${existing.id}`);
  const { path: _path, trashed: _trashed, ...stored } = existing;
  // A write that names no triggers keeps them: `stored` has them.
  const merged: Record<string, unknown> = { ...stored, ...input, scope: existing.scope, created: existing.created };
  if ("triggers" in input) merged.triggers = requireTriggers(input.triggers);
  // Only a change of content says that somebody looked at the fact again. A trigger says when the
  // note loads, not what is true, so new triggers alone verify nothing.
  if (["title", "body", "anchors"].some((key) => key in input)) {
    merged.last_verified = asOf ?? nowIso();
    const commit = asOf === undefined ? repo.head : commitAt(repo.root ?? null, asOf);
    if (repo.scope === existing.scope && commit) merged.verified_at_commit = commit;
  }
  const note = validateNote(merged);
  const path = store.writeNote(note);
  afterWrite(store, `kb: update ${note.id}`);
  logWrites(store, "update", [note.id], [], from);
  return { id: note.id, path };
}

/**
 * What a writer should look at again in a note that was saved. Never a refusal: the note is
 * stored. A gotcha or a how-to with no trigger and no anchor is one index line at the session
 * start, a title among many, and nothing loads its body. Open work with the scope global is one
 * index line in every repo session: a session shows the next step only for the open work of its
 * own repo. `inRepo` says that the write came from inside a repo. Outside any repo, global is the
 * one scope there is, so open work is right there.
 */
export function noteWarnings(note: Pick<Note, "kind" | "scope" | "body" | "anchors" | "triggers">, inRepo: boolean): string[] {
  const warnings: string[] = [];
  if ((note.kind === "gotcha" || note.kind === "how-to") && note.anchors.length === 0 && !note.triggers?.length) {
    warnings.push(`a ${note.kind} with no trigger and no anchor is only an index line at the session start, and nothing loads its body. Give it "triggers" (cmd:, stop: or err:) or "anchors", or say in your report why it has none.`);
  }
  if (note.kind === "open-work" && note.scope === "global" && inRepo) {
    warnings.push(`open work belongs to a repo. With the scope global it is one index line in every repo session, and none shows its next step. Trash this note and save it in the repo of the work, with "scope": "repo".`);
  }
  const chars = note.body.trim().length;
  if (chars > BODY_CHARS) warnings.push(`the body has ${chars} characters. A trigger loads at most ${BODY_CHARS}, and cuts the rest. Keep the fact, why it matters, and how to apply it.`);
  return warnings;
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
  logWrites(store, toTrash ? "trash" : "restore", moved);
  return moved;
}

function removeNotes(store: Store, notes: StoredNote[], message: string): string[] {
  for (const note of notes) store.remove(note);
  const deleted = notes.map((n) => n.id);
  afterWrite(store, message);
  logWrites(store, "delete", deleted);
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

/** Remove every note in the trash for good, or only the notes of one scope. */
export function emptyTrash(store: Store, scope?: string): string[] {
  const notes = store.notes({ trashed: true }).filter((n) => scope === undefined || n.scope === scope);
  if (notes.length === 0) return [];
  return removeNotes(store, notes, scope === undefined ? `kb: empty the trash (${notes.length})` : `kb: empty the trash of ${scope} (${notes.length})`);
}

// ---- a project: every note of one repo scope ----

/** A project is the notes of one repo. "global" is not a project, so no project command can touch it. */
function requireProject(store: Store, scope: string): void {
  if (scope === "global") throw new KbError("\"global\" is not a project. Trash or delete its notes by id.");
  if (![...store.notes(), ...store.notes({ trashed: true })].some((n) => n.scope === scope)) {
    throw new KbError(`no notes have the scope "${scope}". Pass the exact repo id, as \`kb list\` shows it.`);
  }
}

/**
 * Move every active note of a project to the trash, in one commit. They share one trashed_at, so
 * `restoreProject` brings back this move and no note that went to the trash before it.
 * Every target is checked before the first file moves.
 */
export function trashProject(store: Store, scope: string): string[] {
  requireProject(store, scope);
  const notes = store.notes().filter((n) => n.scope === scope);
  if (notes.length === 0) throw new KbError(`${scope} has no active notes. Its notes are in the trash already.`);
  for (const note of notes) {
    if (existsSync(store.notePath(note, true))) throw new KbError(`cannot move ${note.id}: the trash has a note with that id`);
  }
  const at = nowIso();
  for (const note of notes) store.move(note, true, at);
  const ids = notes.map((n) => n.id).sort();
  afterWrite(store, `kb: trash the project ${scope} (${ids.length})`);
  logWrites(store, "trash", ids);
  return ids;
}

/** Bring back the notes of a project that went to the trash last, together. */
export function restoreProject(store: Store, scope: string): string[] {
  requireProject(store, scope);
  const trashed = store.notes({ trashed: true }).filter((n) => n.scope === scope);
  if (trashed.length === 0) throw new KbError(`${scope} has no notes in the trash`);
  const last = trashed.map((n) => n.trashed_at ?? "").sort().at(-1);
  const notes = trashed.filter((n) => (n.trashed_at ?? "") === last);
  for (const note of notes) {
    if (existsSync(store.notePath(note))) throw new KbError(`cannot restore ${note.id}: an active note has that id`);
  }
  for (const note of notes) store.move(note, false, nowIso());
  const ids = notes.map((n) => n.id).sort();
  afterWrite(store, `kb: restore the project ${scope} (${ids.length})`);
  logWrites(store, "restore", ids);
  return ids;
}

/** Remove every note of a project for good, active and in the trash. Only when the user wants the project gone now. */
export function deleteProject(store: Store, scope: string): string[] {
  requireProject(store, scope);
  const notes = [...store.notes(), ...store.notes({ trashed: true })].filter((n) => n.scope === scope);
  return removeNotes(store, notes, `kb: delete the project ${scope} (${notes.length})`).sort();
}

const DAY_MS = 86_400_000;

/** When the trash clears a note: `trashDays` after it went there. */
export function clearsAt(trashedAt: string, days: number): string {
  return isoTime(Date.parse(trashedAt) + days * DAY_MS);
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
