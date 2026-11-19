// The neighbor check of `kb add`: the stored notes that are close to a new note in their words.
// A note that says a known fact in other words has another title, so the exact-title check passes
// it. The measure is plain text only: no server, no model, no dependency.

import type { Kind } from "./note.ts";
import { meaningWords, stem } from "./words.ts";

export interface Neighbor {
  id: string;
  scope: string;
  kind: Kind;
  title: string;
  /** The first line of the body. */
  first_line: string;
  /** Why it matched: the words both notes have, the heaviest first, as the new note writes them. Never a stop word. */
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
  supersedes?: string[];
}

/** A new note, or a stored note that `kb stale` compares with the others. */
export type Draft = Pick<NoteText, "title" | "body" | "scope" | "supersedes"> & { id?: string };

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

/** The end of the first line of a `neighbors` answer of `kb add`, in its text form. */
export const NOT_WRITTEN = "close to this one. Nothing was written.";

/**
 * True for the output of a `kb add` that answered `neighbors`. The command exits with 2 then, so a
 * harness can show the call as failed. The answer quotes stored notes, so it is no error text.
 */
export const isNeighborsAnswer = (output: string) => output.includes('"status": "neighbors"') || output.includes(NOT_WRITTEN);

// BM25 with its usual constants.
const K1 = 1.2;
const B = 0.75;

interface Doc {
  /** The text the rest is made from. A note that changed is read again. */
  source: string;
  /** Stem to count, over the title and the body. */
  tf: Map<string, number>;
  length: number;
  /** Stem to the first word of the text that has it, in the order of the text. */
  written: Map<string, string>;
}

// `kb stale` compares each note of a scope with the others, so the words of a stored note are read once.
const docs = new WeakMap<object, Doc>();

function toDoc(text: { title: string; body: string }): Doc {
  const source = `${text.title}\n${text.body}`;
  const known = docs.get(text);
  if (known?.source === source) return known;
  const tf = new Map<string, number>();
  const written = new Map<string, string>();
  const all = meaningWords(source);
  for (const word of all) {
    const s = stem(word);
    tf.set(s, (tf.get(s) ?? 0) + 1);
    if (!written.has(s)) written.set(s, word);
  }
  const doc = { source, tf, length: all.length, written };
  docs.set(text, doc);
  return doc;
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
function measure(size: number, total: number, df: (term: string) => number): { closeness: (a: Doc, b: Doc) => number; weight: (term: string) => number } {
  const average = total / Math.max(1, size) || 1;
  const weight = (term: string) => Math.log(1 + size / Math.max(df(term), 0.5)) ** 2;
  const saturate = (count: number, length: number) => (count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / average));
  const bm25 = (query: Doc, doc: Doc) => {
    let score = 0;
    for (const [term, count] of query.tf) {
      const found = doc.tf.get(term);
      if (found) score += weight(term) * saturate(found, doc.length) * saturate(count, average);
    }
    return score;
  };
  // A short note that repeats the shared words scores them higher than the query scores itself, so the share has a ceiling.
  const share = (query: Doc, doc: Doc) => Math.min(1, bm25(query, doc) / (bm25(query, query) || 1));
  const closeness = (a: Doc, b: Doc) => {
    let common = 0;
    for (const term of a.tf.keys()) if (b.tf.has(term)) common++;
    return common < 2 ? 0 : Math.max(share(a, b), share(b, a));
  };
  return { closeness, weight };
}

/**
 * The word counts of the stored notes, taken once: `kb stale` asks for each note of a scope. The
 * result gives the measure for one note. `out` are the stored notes that the note is not compared
 * with, such as the note itself. They give no weight either, so a stored note scores as it did
 * when `kb add` got it as a new note.
 */
function scorer(corpus: Doc[]): (out: Doc[]) => ReturnType<typeof measure> {
  const df = new Map<string, number>();
  for (const doc of corpus) for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const total = corpus.reduce((sum, doc) => sum + doc.length, 0);
  return (out) => {
    const others = (term: string) => (df.get(term) ?? 0) - out.filter((doc) => doc.tf.has(term)).length;
    return measure(corpus.length - out.length, total - out.reduce((sum, doc) => sum + doc.length, 0), others);
  };
}

/** The shared words that weigh most, as the new note writes them. Words of one weight keep the order of the new note, so its title comes first. */
function sharedWords(draft: Doc, doc: Doc, weight: (term: string) => number): string[] {
  const heavy = (term: string) => weight(term) * Math.min(draft.tf.get(term)!, doc.tf.get(term)!);
  return [...draft.written.keys()]
    .filter((term) => doc.tf.has(term))
    .map((term, place) => ({ term, place }))
    .sort((x, y) => heavy(y.term) - heavy(x.term) || x.place - y.place)
    .slice(0, MAX_SHARED)
    .map(({ term }) => draft.written.get(term)!);
}

/**
 * The check for the notes of one scope, with the word weights built once: `kb stale` asks it for
 * every note of the scope. It compares a note with the notes of its scope and the global notes.
 * For a global note, the notes of every repo too, because a repo can hold the fact already.
 * The same notes give the word weights. So the name of a repo, which each of its notes has, weighs
 * little among them. A note that moved to an instruction file is left out: that file owns the rule
 * now, and every session loads it.
 */
export function neighborCheck(notes: NoteText[], scope: string, threshold = NEIGHBOR_THRESHOLD): (draft: Draft) => Neighbor[] {
  const stored = notes
    .filter((note) => !note.promoted_to && (scope === "global" || note.scope === scope || note.scope === "global"))
    .map((note) => ({ note, doc: toDoc(note) }));
  const weigh = scorer(stored.map((s) => s.doc));
  // A note is no twin of itself, nor of a note that it replaces: the two are close by design.
  const replaces = (a: Draft | NoteText, b: Draft | NoteText) => b.id !== undefined && (a.supersedes ?? []).includes(b.id);
  return (draft) => {
    const mine = toDoc(draft);
    const apart = new Set(stored.filter(({ note }) => note.id === draft.id || replaces(draft, note) || replaces(note, draft)));
    const { closeness, weight } = weigh([...apart].map((s) => s.doc));
    return stored
      .filter((s) => !apart.has(s))
      .map(({ note, doc }) => ({ note, doc, score: closeness(mine, doc) }))
      .filter((found) => found.score >= threshold)
      .sort((x, y) => y.score - x.score || x.note.id.localeCompare(y.note.id))
      .map(({ note, doc, score }) => ({
        id: note.id,
        scope: note.scope,
        kind: note.kind,
        title: note.title,
        first_line: note.body.split("\n").find((line) => line.trim())?.trim() ?? "",
        shared: sharedWords(mine, doc, weight),
        score: Math.round(score * 100) / 100,
      }));
  };
}

/** The notes close to a new note, the closest first. See `neighborCheck`. */
export function findNeighbors(notes: NoteText[], draft: Draft, threshold = NEIGHBOR_THRESHOLD): Neighbor[] {
  return neighborCheck(notes, draft.scope, threshold)(draft);
}
