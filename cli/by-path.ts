// Notes by path, and what each reader got. A repo note whose anchor names a file, or a folder above
// it, loads when a session works on that file. This file finds the repo path of a file, and keeps
// the record that gives each note to each reader once. fire.ts decides what loads.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveRepo } from "./scope.ts";
import type { Store } from "./store.ts";

/** A record of what a session got is kept this long after its last change. A session older than this is over. */
const SEEN_DAYS = 7;

/** A session id or an agent id that is safe as a file name. A note id is a slug, so it is safe too. */
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

/** Who made the tool call: the session, and the subagent when a subagent made it. A subagent has its own context. */
export interface Reader {
  session_id?: unknown;
  agent_id?: unknown;
}

/** True when the anchor path names the file, or a folder that holds it. */
export function covers(anchor: string, file: string): boolean {
  return anchor !== "" && (file === anchor || file.startsWith(`${anchor}/`));
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * The path of a file in the checkout at `root`, as an anchor writes a path. null when the file is
 * outside it. Only the folder is resolved. A file that is a link keeps the path the agent gave, so
 * the notes on that place in the repo still apply.
 */
export function pathInRepo(root: string, file: string): string | null {
  const path = relative(real(root), realFile(file)).split(sep).join("/");
  return !path || path === ".." || path.startsWith("../") || isAbsolute(path) ? null : path;
}

/** The file with its folder resolved, so a path through a linked folder is the path in the repo. */
export const realFile = (file: string) => join(real(dirname(file)), basename(file));

/**
 * The repo of a file and its path in that repo. null when the file is in no repo. It runs git, so
 * a hook calls it only for a file that a note may be on. It never writes.
 */
export function fileInRepo(store: Store, file: string): { scope: string; path: string } | null {
  if (!isAbsolute(file)) return null;
  const repo = resolveRepo(real(dirname(file)), store, { record: false });
  if (!repo.scope || !repo.root) return null;
  const path = pathInRepo(repo.root, file);
  return path === null ? null : { scope: repo.scope, path };
}

const seenRoot = (store: Store) => store.statePath("by-path");

/** The folder that records what this reader got, one empty file per note id. null: no usable id, so nothing is recorded. */
function seenDir(store: Store, reader: Reader): string | null {
  const { session_id: session, agent_id: agent } = reader;
  if (typeof session !== "string" || !SAFE.test(session)) return null;
  if (agent === undefined || agent === null) return join(seenRoot(store), session);
  // "." is not in SAFE, so a subagent's folder can never be the folder of another session.
  return typeof agent === "string" && SAFE.test(agent) ? join(seenRoot(store), `${session}.${agent}`) : null;
}

/** Remove the records of sessions that ended long ago. */
function prune(store: Store, keep: string, now: number): void {
  for (const name of readdirSync(seenRoot(store))) {
    const old = join(seenRoot(store), name);
    if (old === keep) continue;
    try {
      if (now - statSync(old).mtimeMs > SEEN_DAYS * 86_400_000) rmSync(old, { recursive: true, force: true });
    } catch {
      // another session removed it first
    }
  }
}

/** Forget what the main agent of a session got. After a compaction or a /clear its context lost the notes, so they may come again. */
export function forgetSeen(store: Store, session: unknown): void {
  const dir = seenDir(store, { session_id: session });
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** "first": this call is the first to name the note, and that is recorded. "unrecorded": nothing could be recorded, so the note may come again. */
export type Claim = "first" | "seen" | "unrecorded";

/**
 * The record of what one reader got. `claim` records a note with a create that fails when the file
 * exists, so of two tool calls at the same time only one gives the note.
 */
export function seenBy(store: Store, reader: Reader, now = Date.now()): { has(id: string): boolean; claim(id: string): Claim } {
  const dir = seenDir(store, reader);
  let ready = false;
  return {
    has: (id) => dir !== null && existsSync(join(dir, id)),
    claim(id) {
      if (!dir) return "unrecorded";
      if (!ready) {
        ready = true;
        store.ensure(); // keeps .state/ out of git in a store made by an older version
        mkdirSync(seenRoot(store), { recursive: true });
        try {
          mkdirSync(dir); // fails when the folder exists, so the prune runs once per session
          prune(store, dir, now);
        } catch {
          // the session has a record already
        }
      }
      try {
        writeFileSync(join(dir, id), "", { flag: "wx" });
        return "first";
      } catch (error) {
        // Another call named it. Any other failure: name it, and it may come again.
        return (error as NodeJS.ErrnoException).code === "EEXIST" ? "seen" : "unrecorded";
      }
    },
  };
}
