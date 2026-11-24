// `kb stale`: notes that may no longer be true. Every check is deterministic. A candidate is a
// reason to look at a note, never a verdict.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { covers } from "./by-path.ts";
import { NOT_NEEDED_SESSIONS, judgments, lastActivity } from "./log.ts";
import { neighborCheck } from "./neighbors.ts";
import { resolveRepo } from "./scope.ts";
import { git, type Store, type StoredNote, writeAtomic } from "./store.ts";

export const STALE_REASONS = ["anchor-changed", "anchor-missing", "commit-unknown", "judged-wrong", "expired", "decayed", "not-needed", "duplicate"] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

export interface StaleCandidate {
  id: string;
  title: string;
  scope: string;
  reason: StaleReason;
  detail: string;
  /** For anchor-changed only: the commit of the last check, and the anchored paths that changed after it. */
  commit?: string;
  paths?: string[];
}

export interface StaleResult {
  scope: string | null;
  head: string | null;
  /** Number of distinct notes with a candidate. */
  notes: number;
  candidates: StaleCandidate[];
}

/** An anchor's path, and its symbol after "#" or "". */
function splitAnchor(anchor: string): { path: string; symbol: string } {
  const hash = anchor.indexOf("#");
  return hash === -1 ? { path: anchor, symbol: "" } : { path: anchor.slice(0, hash), symbol: anchor.slice(hash + 1) };
}

/** A file over this size gets no symbol check: reading it would slow a session start. */
const SYMBOL_CHECK_MAX_BYTES = 2_000_000;

/** Reads the text of anchored files, each file once. null: not a regular file, too large, or unreadable. */
export type AnchorReader = (full: string) => string | null;

export function anchorReader(): AnchorReader {
  const texts = new Map<string, string | null>();
  return (full) => {
    if (!texts.has(full)) {
      let text: string | null = null;
      try {
        // A pipe or a device blocks a read, so only a regular file is read.
        const stat = statSync(full);
        if (stat.isFile() && stat.size <= SYMBOL_CHECK_MAX_BYTES) text = readFileSync(full, "utf8");
      } catch {
        // unreadable: the symbol check does not apply
      }
      texts.set(full, text);
    }
    return texts.get(full)!;
  };
}

/**
 * The anchors of a note that no longer hold in the checkout at root, with what is gone: the path,
 * or the symbol in the file. It reads files only and runs no git, so a session start can afford it.
 */
export function missingAnchors(note: Pick<StoredNote, "anchors">, root: string, read: AnchorReader = anchorReader()): { anchor: string; detail: string }[] {
  const missing: { anchor: string; detail: string }[] = [];
  for (const anchor of note.anchors) {
    const { path, symbol } = splitAnchor(anchor);
    const full = resolve(root, path);
    if ((full !== root && !full.startsWith(root + sep)) || !existsSync(full)) {
      missing.push({ anchor, detail: `${path} does not exist` });
      continue;
    }
    if (!symbol) continue;
    const text = read(full);
    if (text !== null && !text.includes(symbol)) missing.push({ anchor, detail: `${symbol} is no longer in ${path}` });
  }
  return missing;
}

/**
 * The files that differ between a commit and HEAD. null when the clone does not have the commit.
 * The compare is by content, so the commit need not be in the history of HEAD: a note checked on a
 * branch that was squash-merged, or rebased, is compared with the files it was checked against.
 */
function filesChangedSince(root: string, commit: string): Set<string> | null {
  const known = git(root, "cat-file", "-e", `${commit}^{commit}`).ok;
  const diff = known ? git(root, "diff", "--name-only", commit, "HEAD") : null;
  return diff?.ok ? new Set(diff.out.split("\n").filter(Boolean)) : null;
}

/**
 * The anchored paths of a note that are in `changed`, each once. A path#symbol anchor counts as
 * changed when its file changed. An anchor in `gone` is missing, which says more, so it is not
 * counted twice. Another anchor on the same file still counts.
 */
function movedAnchors(note: Pick<StoredNote, "anchors">, changed: Set<string>, gone: Set<string> = new Set()): string[] {
  const moved = note.anchors
    .filter((anchor) => !gone.has(anchor))
    .map((anchor) => splitAnchor(anchor).path)
    .filter((path) => [...changed].some((file) => file === path || file.startsWith(`${path.replace(/\/+$/, "")}/`)));
  return [...new Set(moved)];
}

/**
 * The anchored paths of one note that changed after its last check, in the checkout at `root`. It
 * runs git, so it is for a command (`kb show`), not for a hook. Empty when nothing changed, and
 * when the note has no commit or the clone does not have its commit.
 */
export function changedSinceCheck(note: Pick<StoredNote, "anchors" | "verified_at_commit">, root: string): string[] {
  if (!note.verified_at_commit || note.anchors.length === 0) return [];
  const changed = filesChangedSince(root, note.verified_at_commit);
  return changed ? movedAnchors(note, changed, new Set(missingAnchors(note, root).map((m) => m.anchor))) : [];
}

type Found = Pick<StaleCandidate, "reason" | "detail" | "commit" | "paths">;

/** Anchor checks need the repo on disk, so they cover only notes of the repo at `repoPath`. */
function anchorCandidates(note: StoredNote, root: string, changedSince: (commit: string) => Set<string> | null, read: AnchorReader): Found[] {
  const found: Found[] = [];
  const commit = note.verified_at_commit;
  const changed = commit ? changedSince(commit) : null;
  if (commit && changed === null) {
    found.push({ reason: "commit-unknown", detail: `commit ${commit} is not in this clone (a shallow clone, or a commit of a branch that was never fetched or is deleted)` });
  }

  const missing = missingAnchors(note, root, read);
  const moved = changed ? movedAnchors(note, changed, new Set(missing.map((m) => m.anchor))) : [];
  if (missing.length > 0) found.push({ reason: "anchor-missing", detail: missing.map((m) => m.detail).join("; ") });
  if (commit && moved.length > 0) found.push({ reason: "anchor-changed", detail: `changed since ${commit}: ${moved.join(", ")}`, commit, paths: moved });
  return found;
}

export function findStale(store: Store, repoPath: string, now: Date = new Date()): StaleResult {
  const repo = resolveRepo(repoPath, store);
  const result: StaleResult = { scope: repo.scope, head: repo.head, notes: 0, candidates: [] };
  if (!store.exists()) return result;

  // Promoted notes live in an instruction file now, so that file owns them. Like the audit, the
  // check covers one scope: the repo's notes in a repo, the global notes outside any repo.
  const scope = repo.scope ?? "global";
  const all = store.notes();
  const notes = all.filter((n) => !n.promoted_to && n.scope === scope);
  const add = (note: StoredNote, reason: StaleReason, detail: string, more: Pick<StaleCandidate, "commit" | "paths"> = {}) => result.candidates.push({ id: note.id, title: note.title, scope: note.scope, reason, detail, ...more });

  // One git call per distinct commit, not one per anchor.
  const diffs = new Map<string, Set<string> | null>();
  const changedSince = (commit: string): Set<string> | null => {
    if (!diffs.has(commit)) diffs.set(commit, filesChangedSince(repo.root!, commit));
    return diffs.get(commit)!;
  };

  const { decayDays, expireDays } = store.config();
  const read = anchorReader();
  const active = lastActivity(store);
  const judged = judgments(store);
  const days = (iso: string) => Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  const ago = (n: number) => (n <= 0 ? "today" : `${n} ${n === 1 ? "day" : "days"} ago`);
  for (const note of notes) {
    if (repo.root && repo.head && note.scope === repo.scope) {
      for (const { reason, detail, ...more } of anchorCandidates(note, repo.root, changedSince, read)) add(note, reason, detail, more);
    }
    // Expired: the note had no activity and nobody checked it for expireDays. It says more than
    // decayed, so a note gets one of the two.
    const lastActive = active.get(note.id);
    const seen = lastActive && lastActive > note.last_verified ? lastActive : note.last_verified;
    if (days(seen) > expireDays) add(note, "expired", `no use and no check for ${days(seen)} days`);
    else if (days(note.last_verified) > decayDays) add(note, "decayed", `last verified ${days(note.last_verified)} days ago`);
    // What sessions said of the note, on any machine. A verdict from before the last check is
    // about an older text, so a verification clears both reasons.
    const verdicts = judged.get(note.id);
    if (!verdicts) continue;
    const since = (t: string | undefined): t is string => t !== undefined && t > note.last_verified;
    if (since(verdicts.wrong)) add(note, "judged-wrong", `a session judged it wrong ${ago(days(verdicts.wrong))}, after the last check`);
    const notNeeded = verdicts.notNeeded.filter(since).length;
    if (notNeeded >= NOT_NEEDED_SESSIONS && !since(verdicts.helped)) add(note, "not-needed", `at least ${notNeeded} sessions judged it not needed since the last check, and none said it helped`);
  }

  // Possible duplicates, by the measure of `kb add`: two notes of the scope that are close in
  // their words. The newer one is the candidate. A pair has one scope, because a merge has one:
  // `kb add` catches a repo note that is close to a global note, when the note is written. In a
  // repo the global notes still give word weights, as they do for `kb add`. The check is built
  // once, and each note of the scope asks it.
  const near = neighborCheck(all.filter((n) => n.scope === scope || n.scope === "global"), scope);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const paired = new Set<string>();
  for (const note of notes) {
    for (const close of near(note)) {
      const other = byId.get(close.id);
      const pair = [note.id, close.id].sort().join("\n");
      if (!other || paired.has(pair)) continue;
      paired.add(pair);
      // Two notes of one time go by id, so the answer does not depend on the order of the store.
      const otherFirst = other.created < note.created || (other.created === note.created && other.id < note.id);
      const [older, newer] = otherFirst ? [other, note] : [note, other];
      add(newer, "duplicate", `close to ${older.id}: both have ${close.shared.join(", ")}`);
    }
  }

  result.candidates.sort((a, b) => a.id.localeCompare(b.id) || STALE_REASONS.indexOf(a.reason) - STALE_REASONS.indexOf(b.reason));
  result.notes = new Set(result.candidates.map((c) => c.id)).size;
  return result;
}

// ---- the count cache, so a session start never pays for the checks ----

interface CacheEntry {
  head: string | null;
  day: string;
  notes: number;
}

const cachePath = (store: Store) => store.statePath("stale.json");
const today = (now: Date) => now.toISOString().slice(0, 10);

function readCache(store: Store): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(cachePath(store), "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

/** Save what `kb stale` found for the hooks: the count for a session start, and the notes on changed files for each load of a note. */
export function saveStaleCount(store: Store, result: StaleResult, now: Date = new Date()): void {
  if (!store.exists()) return;
  store.ensure(); // keeps .state/ out of git in a store made by an older version
  const cache = readCache(store);
  cache[result.scope ?? "global"] = { head: result.head, day: today(now), notes: result.notes };
  writeAtomic(cachePath(store), JSON.stringify(cache));
  saveChanged(store, result);
}

/** The cached count for a scope. `fresh` is false when HEAD or the day changed since it was computed. */
export function cachedStaleCount(store: Store, scope: string | null, head: string | null, now: Date = new Date()): { notes: number; fresh: boolean } | null {
  const entry = readCache(store)[scope ?? "global"];
  if (!entry) return null;
  return { notes: entry.notes, fresh: entry.head === head && entry.day === today(now) };
}

/** Every write to the store can change the answer. */
export function clearStaleCache(store: Store): void {
  rmSync(cachePath(store), { force: true });
}

// ---- the notes on changed files, so a hook can say it when a note loads ----

/** The commit of the last check of a note, and its anchored paths that changed after it. */
interface Changed {
  commit: string;
  paths: string[];
}

/** The line that marks a note on a changed file, at a load and in `kb show`. */
export const CHANGED_MARK = "changed since the last check";

/** What to do with a note on a changed file. The session that uses the note has the code open, so it does the check. */
export const changedAsk = (note = "such a note", id = "<id>") =>
  `Read the code before you act on ${note}. If the note still holds, run \`kb verify ${id}\`. If it does not, update it with \`kb add\`. If you cannot fix it now, run \`kb verdict wrong ${id}\`.`;
export const CHANGED_ASK = changedAsk();

/**
 * A file apart from the count. A write to the store clears the count. This file stays, because
 * each record holds for one commit of one note: a check of the note gives the note a new commit,
 * and the record then says nothing.
 */
const changedPath = (store: Store) => store.statePath("changed.json");

function readChanged(store: Store): Record<string, Record<string, Changed>> {
  try {
    return JSON.parse(readFileSync(changedPath(store), "utf8")) as Record<string, Record<string, Changed>>;
  } catch {
    return {};
  }
}

/** The anchor checks need a checkout, so only a `kb stale` in a repo replaces the record of its scope. */
function saveChanged(store: Store, result: StaleResult): void {
  if (!result.scope || !result.head) return;
  const all = readChanged(store);
  const mine: Record<string, Changed> = {};
  for (const c of result.candidates) if (c.reason === "anchor-changed" && c.commit && c.paths) mine[c.id] = { commit: c.commit, paths: c.paths };
  if (Object.keys(mine).length === 0 && !all[result.scope]) return;
  all[result.scope] = mine;
  writeAtomic(changedPath(store), JSON.stringify(all));
}

/**
 * For the notes of one repo: the anchored paths of a note that changed after its last check, as
 * the last `kb stale` found them. It reads one small file and runs no git, so a hook can afford
 * it. A session start runs `kb stale` in the background when HEAD moved, so the answer can lack
 * the changes of the newest commits for a moment. It never names a change that a check covered.
 */
export function changedNotes(store: Store, scope: string): (note: Pick<StoredNote, "id" | "scope" | "anchors" | "verified_at_commit">) => string[] {
  let records: Record<string, Changed> | undefined;
  return (note) => {
    if (note.scope !== scope || !note.verified_at_commit || note.anchors.length === 0) return [];
    records ??= readChanged(store)[scope] ?? {};
    const record = records[note.id];
    if (!record || record.commit !== note.verified_at_commit || !Array.isArray(record.paths)) return [];
    // An anchor that left the note since then is no reason.
    const anchored = note.anchors.map((anchor) => splitAnchor(anchor).path.replace(/\/+$/, ""));
    return record.paths.filter((path) => typeof path === "string" && anchored.some((anchor) => covers(anchor, path.replace(/\/+$/, ""))));
  };
}
