// `kb stale`: notes that may no longer be true. Every check is deterministic. A candidate is a
// reason to look at a note, never a verdict.

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { NOT_NEEDED_SESSIONS, judgments, lastActivity } from "./log.ts";
import { normalizeTitle } from "./note.ts";
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
}

export interface StaleResult {
  scope: string | null;
  head: string | null;
  /** Number of distinct notes with a candidate. */
  notes: number;
  candidates: StaleCandidate[];
}

const STOP_WORDS = new Set(["a", "an", "the", "is", "are", "be", "to", "of", "in", "on", "at", "for", "and", "or", "with", "by", "it", "its", "this", "that", "not", "no", "do", "does", "use", "uses", "when", "from", "as"]);
const DUPLICATE_THRESHOLD = 0.6;

function titleWords(title: string): Set<string> {
  return new Set(normalizeTitle(title).split("-").filter((word) => word && !STOP_WORDS.has(word)));
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  if (shared < 2) return 0;
  return shared / (a.size + b.size - shared);
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

/** Anchor checks need the repo on disk, so they cover only notes of the repo at `repoPath`. */
function anchorCandidates(note: StoredNote, root: string, changedSince: (commit: string) => Set<string> | null, read: AnchorReader): { reason: StaleReason; detail: string }[] {
  const found: { reason: StaleReason; detail: string }[] = [];
  const commit = note.verified_at_commit;
  const changed = commit ? changedSince(commit) : null;
  if (commit && changed === null) {
    found.push({ reason: "commit-unknown", detail: `commit ${commit} is not in the history of HEAD (a rebase, or a shallow clone)` });
  }

  const missing = missingAnchors(note, root, read);
  // A path#symbol anchor counts as changed when its file changed. A missing anchor says more, so
  // it is not counted twice. Another anchor on the same file still counts.
  const gone = new Set(missing.map((m) => m.anchor));
  const moved = changed
    ? note.anchors
        .filter((anchor) => !gone.has(anchor))
        .map((anchor) => splitAnchor(anchor).path)
        .filter((path) => [...changed].some((file) => file === path || file.startsWith(`${path.replace(/\/+$/, "")}/`)))
    : [];
  if (missing.length > 0) found.push({ reason: "anchor-missing", detail: missing.map((m) => m.detail).join("; ") });
  if (moved.length > 0) found.push({ reason: "anchor-changed", detail: `changed since ${commit}: ${[...new Set(moved)].join(", ")}` });
  return found;
}

export function findStale(store: Store, repoPath: string, now: Date = new Date()): StaleResult {
  const repo = resolveRepo(repoPath, store);
  const result: StaleResult = { scope: repo.scope, head: repo.head, notes: 0, candidates: [] };
  if (!store.exists()) return result;

  // Promoted notes live in an instruction file now, so that file owns them. Like the audit, the
  // check covers one scope: the repo's notes in a repo, the global notes outside any repo.
  const notes = store.notes().filter((n) => !n.promoted_to && n.scope === (repo.scope ?? "global"));
  const add = (note: StoredNote, reason: StaleReason, detail: string) => result.candidates.push({ id: note.id, title: note.title, scope: note.scope, reason, detail });

  // One git call per distinct commit, not one per anchor.
  const diffs = new Map<string, Set<string> | null>();
  const changedSince = (commit: string): Set<string> | null => {
    if (!diffs.has(commit)) {
      const root = repo.root!;
      const known = git(root, "merge-base", "--is-ancestor", commit, "HEAD").ok;
      const diff = known ? git(root, "diff", "--name-only", commit, "HEAD") : null;
      diffs.set(commit, diff?.ok ? new Set(diff.out.split("\n").filter(Boolean)) : null);
    }
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
      for (const found of anchorCandidates(note, repo.root, changedSince, read)) add(note, found.reason, found.detail);
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

  // Possible duplicates: titles that share most of their words. The newer note is the candidate.
  const words = notes.map((note) => titleWords(note.title));
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (similarity(words[i]!, words[j]!) < DUPLICATE_THRESHOLD) continue;
      const [older, newer] = notes[i]!.created <= notes[j]!.created ? [notes[i]!, notes[j]!] : [notes[j]!, notes[i]!];
      add(newer, "duplicate", `the title is close to ${older.id}`);
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

export function saveStaleCount(store: Store, result: StaleResult, now: Date = new Date()): void {
  if (!store.exists()) return;
  store.ensure(); // keeps .state/ out of git in a store made by an older version
  const cache = readCache(store);
  cache[result.scope ?? "global"] = { head: result.head, day: today(now), notes: result.notes };
  writeAtomic(cachePath(store), JSON.stringify(cache));
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
