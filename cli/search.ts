// `kb search`: ripgrep over the notes, with a built-in scan when rg is missing.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  /** Tests set this to exercise the fallback. */
  forceScan?: boolean;
}

/** Case-insensitive fixed-string search. Returns one hit per matching line. */
export function search(store: Store, query: string, options: SearchOptions = {}): Hit[] {
  const notes = [...store.notes(), ...(options.archive ? store.notes({ archived: true }) : [])].filter(
    (n) => !options.scope || n.scope === options.scope,
  );
  if (notes.length === 0 || !query) return [];
  const byPath = new Map(notes.map((n) => [resolve(n.path), n]));
  const hit = (n: StoredNote, line: number, text: string): Hit => ({ id: n.id, title: n.title, scope: n.scope, archived: n.archived, line, text: text.trim() });
  // In the frontmatter only the title line counts, so an id or scope never doubles a hit.
  const bodyStart = new Map<string, number>();
  const counts = (n: StoredNote, line: number, text: string): boolean => {
    let start = bodyStart.get(n.path);
    if (start === undefined) {
      start = readFileSync(n.path, "utf8").split("\n").indexOf("---", 1) + 2;
      bodyStart.set(n.path, start);
    }
    return line >= start || text.startsWith("title:");
  };

  const rg = options.forceScan ? null : Bun.which("rg");
  if (rg) {
    const dirs = [join(store.home, "notes"), ...(options.archive ? [join(store.home, "archive")] : [])];
    const result = Bun.spawnSync([rg, "--line-number", "--no-heading", "--with-filename", "--color", "never", "-i", "-F", "-g", "*.md", "-e", query, ...dirs], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    // Exit 1 means no match. Anything above that is a failure, so use the scan.
    if (result.exitCode !== null && result.exitCode <= 1) {
      const hits: Hit[] = [];
      for (const row of result.stdout.toString().split("\n")) {
        const match = /^(.*?\.md):(\d+):(.*)$/.exec(row);
        const note = match && byPath.get(resolve(match[1]!));
        if (match && note && counts(note, Number(match[2]), match[3]!)) hits.push(hit(note, Number(match[2]), match[3]!));
      }
      return hits.sort((a, b) => a.id.localeCompare(b.id) || a.line - b.line);
    }
  }

  const needle = query.toLowerCase();
  const hits: Hit[] = [];
  for (const note of notes) {
    const lines = readFileSync(note.path, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (text.toLowerCase().includes(needle) && counts(note, i + 1, text)) hits.push(hit(note, i + 1, text));
    });
  }
  return hits.sort((a, b) => a.id.localeCompare(b.id) || a.line - b.line);
}
