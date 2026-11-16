// `kb search`: every word of the query, in any order, anywhere in the title or the body of a note.

import { readFileSync } from "node:fs";
import type { Store, StoredNote } from "./store.ts";

export interface Hit {
  id: string;
  title: string;
  scope: string;
  archived: boolean;
  line: number;
  text: string;
}

export interface SearchOptions {
  scope?: string;
  archive?: boolean;
}

export interface SearchResult {
  hits: Hit[];
  /** False when no note has every word. The hits are then the notes with the most words. */
  complete: boolean;
}

/**
 * Case-insensitive search for the words of the query. A note matches when each word is in its
 * title or body. When no note has every word of a query with several words, the notes with the
 * most words match instead, if they have at least two. One hit per line that has a word.
 */
export function searchNotes(store: Store, query: string, options: SearchOptions = {}): SearchResult {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  const notes = [...store.notes(), ...(options.archive ? store.notes({ archived: true }) : [])].filter(
    (n) => !options.scope || n.scope === options.scope,
  );
  if (words.length === 0) return { hits: [], complete: true };

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
      const here = words.filter((word) => lower.includes(word));
      if (here.length === 0) return;
      for (const word of here) matched.add(word);
      hits.push({ id: note.id, title: note.title, scope: note.scope, archived: note.archived, line: i + 1, text: text.trim() });
    });
    if (matched.size > 0) found.push({ note, matched: matched.size, hits });
  }

  const best = Math.max(0, ...found.map((f) => f.matched));
  const complete = best === words.length;
  if (!complete && best < 2) return { hits: [], complete: true };
  const hits = found
    .filter((f) => f.matched === best)
    .flatMap((f) => f.hits)
    .sort((a, b) => a.id.localeCompare(b.id) || a.line - b.line);
  return { hits, complete };
}

export const search = (store: Store, query: string, options: SearchOptions = {}): Hit[] => searchNotes(store, query, options).hits;
