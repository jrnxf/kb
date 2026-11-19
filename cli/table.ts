// The trigger table: what a hook needs to know, for each tool call, about every note that can load
// at a trigger. A hook runs before each shell command, so it must not read each note file. The
// table is one small file in the per-machine state. It is built again when a note file changes.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Kind } from "./note.ts";
import { type Store, writeAtomic } from "./store.ts";
import { readTriggers } from "./trigger.ts";

/** One note that has a trigger or an anchor. The title and the body stay in the note file, which is read when the note loads. */
export interface TableNote {
  id: string;
  scope: string;
  kind: Kind;
  /** The words of each `cmd` and each `stop` trigger. */
  cmd: string[][];
  stop: string[][];
  /** The text of each `err` trigger, in lower case. */
  err: string[];
  /** The paths of the anchors, as a repo-relative path is written. Only a repo note has them. */
  paths: string[];
}

export interface TriggerTable {
  /** What the note files looked like when the table was built. */
  sig: string;
  notes: TableNote[];
}

/** Changes when the format of the table changes, so a table of an older kb is built again. */
const FORMAT = 1;

const tablePath = (store: Store) => store.statePath("triggers.json");

/** An anchor's path in the form a repo-relative path has, or "" when it names no file: the root, or no path. */
export function anchorPath(anchor: string): string {
  const hash = anchor.indexOf("#");
  const path = posix.normalize(hash === -1 ? anchor : anchor.slice(0, hash)).replace(/\/+$/, "");
  return path === "." ? "" : path;
}

/**
 * The name, the time, the size and the inode of each note file, as one short text. A write by kb,
 * a pull from another machine and an edit by hand each change it. It costs one stat per note and
 * reads no file.
 */
function signature(store: Store): string {
  const parts: string[] = [String(FORMAT)];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) {
        try {
          const stat = statSync(full);
          parts.push(full, String(stat.mtimeMs), String(stat.size), String(stat.ino));
        } catch {
          // removed a moment ago
        }
      }
    }
  };
  walk(join(store.home, "notes"));
  return Bun.hash(parts.join("\0")).toString(36);
}

function build(store: Store, sig: string): TriggerTable {
  const notes: TableNote[] = [];
  for (const note of store.notes()) {
    // A note whose rule moved to an instruction file is no longer injected.
    if (note.promoted_to) continue;
    const triggers = readTriggers(note.triggers);
    const words = (kind: "cmd" | "stop") => triggers.filter((t) => t.kind === kind).map((t) => t.words);
    const entry: TableNote = {
      id: note.id,
      scope: note.scope,
      kind: note.kind,
      cmd: words("cmd"),
      stop: words("stop"),
      err: triggers.filter((t) => t.kind === "err").map((t) => t.words[0]!),
      // A path in a global note names a file of no one repo.
      paths: note.scope === "global" ? [] : [...new Set(note.anchors.map(anchorPath).filter(Boolean))],
    };
    if (entry.cmd.length + entry.stop.length + entry.err.length + entry.paths.length > 0) notes.push(entry);
  }
  return { sig, notes: notes.sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * The table for the store as it is now. It reads the saved table when no note file changed since,
 * and builds and saves it when one did. A table that cannot be saved is still returned.
 */
export function triggerTable(store: Store): TriggerTable {
  const sig = signature(store);
  try {
    const saved = JSON.parse(readFileSync(tablePath(store), "utf8")) as TriggerTable;
    if (saved.sig === sig && Array.isArray(saved.notes)) return saved;
  } catch {
    // no table yet, or a broken one
  }
  const table = build(store, sig);
  try {
    store.ensure(); // keeps .state/ out of git in a store made by an older version
    writeAtomic(tablePath(store), JSON.stringify(table));
  } catch {
    // the next call builds it again
  }
  return table;
}
