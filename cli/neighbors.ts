// The neighbor check of `kb add`: the stored notes that are close to a new note in their words.
// A note that says a known fact in other words has another title, so the exact-title check passes
// it. The measure is plain text only: no server, no model, no dependency.

import type { Kind } from "./note.ts";
import { stem, stems, words } from "./words.ts";

export interface Neighbor {
  id: string;
  scope: string;
  kind: Kind;
  title: string;
  /** The first line of the body. */
  first_line: string;
  /** Why it matched: the words both notes have, the heaviest first, as the stored note writes them. */
  shared: string[];
  /** 0 to 1. See `closeness`. */
  score: number;
}

/** What the check reads of a note. */
export interface NoteText {
  id: string;
  scope: string;
  kind: Kind;
  title: string;
  body: string;
  promoted_to?: string;
}

/**
 * A note at or over this score is a neighbor. Tuned on the seeded store of scripts/seed.ts with
 * test/fixtures/neighbors.json: a known fact that a person wrote again in other words scores 0.46
 * or more, and a new fact 0.25 or less. An agent writes longer than that, in words further from the
 * stored note: the twin that a headless checkpoint wrote scores 0.37, and its new facts 0.22 or
 * less. The line also names a note that is related and not the same, for 4 of the 134 seeded notes
 * that have no twin. That costs the writer one read. A miss costs a twin.
 */
export const NEIGHBOR_THRESHOLD = 0.32;
export const MAX_NEIGHBORS = 3;
const MAX_SHARED = 5;

// BM25 with its usual constants.
const K1 = 1.2;
const B = 0.75;

interface Doc {
  /** Stem to count, over the title and the body. */
  tf: Map<string, number>;
  length: number;
}

function toDoc(title: string, body: string): Doc {
  const tf = new Map<string, number>();
  const all = stems(`${title}\n${body}`);
  for (const s of all) tf.set(s, (tf.get(s) ?? 0) + 1);
  return { tf, length: all.length };
}

/**
 * How close two notes are, 0 to 1. One direction is the BM25 score of note a as the query against
 * note b, divided by the score of a against itself: the share of what a says that b says too. The
 * result is the larger of the two directions, because twins differ in length: a new note is often
 * long, and the short stored note is inside it. Two notes need two words in common.
 *
 * The weight of a word is the square of ln(1 + N / df). The square is the weight of tf-idf: a rare
 * word that two notes share says more than several common ones, such as "version" and "needs".
 * The BM25 idf gives a word that every note has no weight, so in a store of one or two notes the
 * shared words of a twin count for nothing. This one stays level from 1 note to 150. The title has
 * no extra weight: a short title would then make a short note look like a part of every long one.
 */
function scorer(corpus: Doc[]): { closeness: (a: Doc, b: Doc) => number; weight: (term: string) => number } {
  const df = new Map<string, number>();
  for (const doc of corpus) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const average = corpus.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, corpus.length) || 1;
  const weight = (term: string) => Math.log(1 + corpus.length / Math.max(df.get(term) ?? 0, 0.5)) ** 2;
  const saturate = (count: number, length: number) => (count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / average));
  const bm25 = (query: Doc, doc: Doc) => {
    let score = 0;
    for (const [term, count] of query.tf) {
      const found = doc.tf.get(term);
      if (found) score += weight(term) * saturate(found, doc.length) * saturate(count, average);
    }
    return score;
  };
  const share = (query: Doc, doc: Doc) => bm25(query, doc) / (bm25(query, query) || 1);
  const closeness = (a: Doc, b: Doc) => {
    let common = 0;
    for (const term of a.tf.keys()) if (b.tf.has(term)) common++;
    return common < 2 ? 0 : Math.max(share(a, b), share(b, a));
  };
  return { closeness, weight };
}

/** The shared words that weigh most, as the note writes them. Words of one weight keep the order of the note, so the title comes first. */
function sharedWords(draft: Doc, doc: Doc, note: NoteText, weight: (term: string) => number): string[] {
  const written = new Map<string, string>();
  for (const word of words(`${note.title}\n${note.body}`)) if (!written.has(stem(word))) written.set(stem(word), word);
  const heavy = (term: string) => weight(term) * Math.min(draft.tf.get(term)!, doc.tf.get(term)!);
  return [...written.keys()]
    .filter((term) => draft.tf.has(term) && doc.tf.has(term))
    .map((term, place) => ({ term, place }))
    .sort((x, y) => heavy(y.term) - heavy(x.term) || x.place - y.place)
    .slice(0, MAX_SHARED)
    .map(({ term }) => written.get(term)!);
}

/**
 * The notes close to a new note, the closest first: the notes of its scope and the global notes.
 * For a global note, the notes of every repo too, because a repo can hold the fact already.
 * The same notes give the word weights. So the name of a repo, which each of its notes has, weighs
 * little among them. A note that moved to an instruction file is left out: that file owns the rule
 * now, and every session loads it.
 */
export function findNeighbors(notes: NoteText[], draft: { title: string; body: string; scope: string }, threshold = NEIGHBOR_THRESHOLD): Neighbor[] {
  const stored = notes
    .filter((note) => !note.promoted_to && (draft.scope === "global" || note.scope === draft.scope || note.scope === "global"))
    .map((note) => ({ note, doc: toDoc(note.title, note.body) }));
  const { closeness, weight } = scorer(stored.map((s) => s.doc));
  const mine = toDoc(draft.title, draft.body);
  return stored
    .map(({ note, doc }) => ({ note, doc, score: closeness(mine, doc) }))
    .filter((found) => found.score >= threshold)
    .sort((x, y) => y.score - x.score || x.note.id.localeCompare(y.note.id))
    .map(({ note, doc, score }) => ({
      id: note.id,
      scope: note.scope,
      kind: note.kind,
      title: note.title,
      first_line: note.body.split("\n").find((line) => line.trim())?.trim() ?? "",
      shared: sharedWords(mine, doc, note, weight),
      score: Math.round(score * 100) / 100,
    }));
}
