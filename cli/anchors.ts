// Anchors: the code a note depends on, and a hash of that code as a check of the note saw it.
// An anchor is a repo-relative path, or `path#symbol`. A hash lets kb tell at any later moment, on
// any machine and with no git, that the code is not what the check saw.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { git } from "./store.ts";

/** An anchor's path, and its symbol after "#" or "". */
export function splitAnchor(anchor: string): { path: string; symbol: string } {
  const hash = anchor.indexOf("#");
  return hash === -1 ? { path: anchor, symbol: "" } : { path: anchor.slice(0, hash), symbol: anchor.slice(hash + 1) };
}

/** The file of an anchor path in the checkout at root. null when the path leaves the checkout or is not there. */
export function anchorFile(root: string, path: string): string | null {
  const full = resolve(root, path);
  return (full !== root && !full.startsWith(root + sep)) || !existsSync(full) ? null : full;
}

/** A file over this size is not read: reading it would slow a session start. */
const READ_MAX_BYTES = 2_000_000;

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
        if (stat.isFile() && stat.size <= READ_MAX_BYTES) text = readFileSync(full, "utf8");
      } catch {
        // unreadable: no check applies
      }
      texts.set(full, text);
    }
    return texts.get(full)!;
  };
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const CLOSER = /^[)\]}]/;
/** A line that goes on below: it ends with an open bracket, a colon, a comma or an arrow. */
const GOES_ON = /(?:[([{:,]|=>)$/;

/**
 * The lines of a text that belong to a symbol: each line that names it, with the block under that
 * line. kb parses no language, so a block is what the indent shows: the lines below that are
 * indented more, and at the same indent a line that opens the body ("{") or closes it ("}", ")").
 * A line that closes and opens again ("} else {", ") {") keeps the block open. So the line of a
 * definition gives its whole body, and the line of a call gives the call. null when no line names
 * the symbol.
 */
export function symbolLines(text: string, symbol: string): string[] | null {
  const lines = text.split("\n");
  // A name is matched as a whole word, so `append` does not take the block of `appendRow`. A
  // symbol that is no word in the file ("a.b", a part of a string) is matched as text.
  const word = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  let named = lines.flatMap((line, at) => (word.test(line) ? [at] : []));
  if (named.length === 0) named = lines.flatMap((line, at) => (line.includes(symbol) ? [at] : []));
  if (named.length === 0) return null;
  const taken = new Set<number>();
  for (const at of named) {
    taken.add(at);
    const base = indentOf(lines[at]!);
    for (let next = at + 1; next < lines.length; next++) {
      const line = lines[next]!;
      const code = line.trim();
      if (!code) continue;
      const indent = indentOf(line);
      if (indent > base) taken.add(next);
      else if (indent === base && code.startsWith("{")) taken.add(next);
      else if (indent === base && CLOSER.test(code)) {
        taken.add(next);
        if (!GOES_ON.test(code)) break;
      } else break;
    }
  }
  return [...taken].sort((a, b) => a - b).map((at) => lines[at]!);
}

/**
 * The hash of the text of an anchor: the whole file, or the lines of the symbol. Each line is
 * trimmed and an empty line is left out, so a new indent or a blank line changes nothing. null
 * when the symbol is not in the text.
 */
export function hashText(text: string, symbol = ""): string | null {
  const lines = symbol ? symbolLines(text, symbol) : text.split("\n");
  if (!lines) return null;
  const content = lines.map((line) => line.trim()).filter(Boolean).join("\n");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export type AnchorHashes = Record<string, string>;

/** The hash of each anchor that `text` gives a text for. An anchor with no text has no hash: a folder, a file that is gone or too large. */
function hashEach(anchors: string[], text: (path: string) => string | null): AnchorHashes {
  const hashes: AnchorHashes = {};
  for (const anchor of anchors) {
    const { path, symbol } = splitAnchor(anchor);
    const content = text(path);
    const hash = content === null ? null : hashText(content, symbol);
    if (hash !== null) hashes[anchor] = hash;
  }
  return hashes;
}

/** The hashes of the anchors as the files in the checkout are now. This is what a check of the note saw, also with changes that are not committed. */
export function hashAnchors(anchors: string[], root: string, read: AnchorReader = anchorReader()): AnchorHashes {
  return hashEach(anchors, (path) => {
    const full = anchorFile(root, path);
    return full === null ? null : read(full);
  });
}

/** The hashes of the anchors as the files were at a commit, for a check that is recorded at that commit and not now. */
export function hashAnchorsAt(anchors: string[], root: string, commit: string): AnchorHashes {
  const texts = new Map<string, string | null>();
  return hashEach(anchors, (path) => {
    if (!texts.has(path)) {
      // A path that leaves the repo, or names a folder, gives no blob.
      const clean = path.replace(/^(\.\/)+/, "");
      const shown = clean && !clean.split("/").includes("..") ? git(root, "cat-file", "blob", `${commit}:${clean}`) : null;
      texts.set(path, shown?.ok ? shown.out : null);
    }
    return texts.get(path)!;
  });
}

/** The anchors of a note that have a hash, and whose text is not what the last check saw. An anchor that is gone is not one: it has its own reason. */
export function hashChanged(note: { anchors: string[]; anchor_hashes?: AnchorHashes }, root: string, read: AnchorReader = anchorReader()): string[] {
  const hashes = note.anchor_hashes;
  if (!hashes) return [];
  const now = hashAnchors(note.anchors.filter((anchor) => hashes[anchor] !== undefined), root, read);
  return Object.keys(now).filter((anchor) => now[anchor] !== hashes[anchor]);
}
