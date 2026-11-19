// `kb search`: every word of the query, in any order, anywhere in the title or the body of a note.
// A word also finds its other forms: "retry" finds "retries", and "migrations" finds "migration".
// A form never widens a query to another word: "note" does not find "not".

import { readFileSync } from "node:fs";
import type { Store, StoredNote } from "./store.ts";
import { STOP_WORDS, meaningWords, stem } from "./words.ts";

export interface Hit {
  id: string;
  title: string;
  scope: string;
  trashed: boolean;
  line: number;
  text: string;
}

export interface SearchOptions {
  scope?: string;
  trash?: boolean;
  /** The scope of the directory of the caller. Its notes come first, then global, then the rest. */
  first?: string;
}

export interface SearchResult {
  hits: Hit[];
  /** False when no note has every word. The hits are then the notes with the most words. */
  complete: boolean;
}

/** A stem under this length is too short to stand for a word: it would match by chance. */
const MIN_STEM = 3;

/**
 * The stem that a query word matches by. Only a plain word has one: a query such as
 * "express.raw()" matches as text only. A stop word has none, so it never matches by its form.
 */
export function queryStem(word: string): string | undefined {
  if (!/^[a-z0-9]+$/.test(word) || STOP_WORDS.has(word)) return undefined;
  const found = stem(word);
  return found.length >= MIN_STEM ? found : undefined;
}

/**
 * Case-insensitive search for the words of the query. A note matches when each word is in its
 * title or body. A word is in a line when the line holds its text, or a word with the same stem.
 * The stop words of a line have no stem.
 * When no note has every word of a query with several words, the notes with the
 * most words match instead, if they have at least two. One hit per line that has a word.
 */
export function searchNotes(store: Store, query: string, options: SearchOptions = {}): SearchResult {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const notes = [...store.notes(), ...(options.trash ? store.notes({ trashed: true }) : [])].filter(
    (n) => !options.scope || n.scope === options.scope,
  );
  if (words.length === 0) return { hits: [], complete: true };
  const stemOf = new Map(words.flatMap((word) => {
    const found = queryStem(word);
    return found === undefined ? [] : [[word, found] as const];
  }));

  const found: { note: StoredNote; matched: number; hits: Hit[] }[] = [];
  for (const note of notes) {
    const lines = readFileSync(note.path, "utf8").split("\n");
    // In the frontmatter only the title line counts, so an id or scope never makes a hit.
    const bodyStart = lines.indexOf("---", 1) + 1;
    const matched = new Set<string>();
    const hits: Hit[] = [];
    lines.forEach((text, i) => {
      if (i < bodyStart && !text.startsWith("title:")) return;
      const lower = text.toLowerCase();
      let stems: Set<string> | undefined;
      const sameStem = (word: string) => stemOf.has(word) && (stems ??= new Set(meaningWords(lower).map(stem))).has(stemOf.get(word)!);
      const here = words.filter((word) => lower.includes(word) || sameStem(word));
      if (here.length === 0) return;
      for (const word of here) matched.add(word);
      hits.push({ id: note.id, title: note.title, scope: note.scope, trashed: note.trashed, line: i + 1, text: text.trim() });
    });
    if (matched.size > 0) found.push({ note, matched: matched.size, hits });
  }

  // A store has the same fact for several repos. The caller wants the one for this repo.
  const near = (h: Hit) => (h.trashed ? 3 : h.scope === options.first ? 0 : h.scope === "global" ? 1 : 2);
  const best = Math.max(0, ...found.map((f) => f.matched));
  const complete = best === words.length;
  if (!complete && best < 2) return { hits: [], complete: true };
  const hits = found
    .filter((f) => f.matched === best)
    .flatMap((f) => f.hits)
    .sort((a, b) => near(a) - near(b) || a.id.localeCompare(b.id) || a.line - b.line);
  return { hits, complete };
}

export const search = (store: Store, query: string, options: SearchOptions = {}): Hit[] => searchNotes(store, query, options).hits;
