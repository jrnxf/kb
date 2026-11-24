// Sync between machines through the store's git remote. Never blocks a session.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rollUp } from "./log.ts";
import { type Note, parseNote, serializeNote } from "./note.ts";
import { clearStaleCache } from "./stale.ts";
import { type Store, tilde, writeAtomic } from "./store.ts";

export interface SyncResult {
  status: "ok" | "no-remote" | "busy" | "conflict" | "error";
  detail: string;
  /** The notes that two machines changed, which this sync merged. */
  merged?: MergedNote[];
  /** The files that two machines changed, which kb could not merge. */
  files?: string[];
}

/** A note that two machines changed. kb kept the copy verified last and put the other in the trash. */
export interface MergedNote {
  id: string;
  /** The id of the other copy, in the trash. */
  copy: string;
  /** Where the copy that kb kept came from. */
  kept: "this machine" | "the remote";
}

/** A sync that did not finish is a failure for a script: `kb sync` exits with 1. */
export const syncFailed = (result: SyncResult) => result.status === "conflict" || result.status === "error";

const LOCK_STALE_MS = 120_000;

function run(store: Store, ...args: string[]): { ok: boolean; out: string; err: string } {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never wait for a password
    GIT_EDITOR: "true", // a rebase that continues keeps the message of its commit
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
  try {
    const r = Bun.spawnSync(["git", "-C", store.home, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env, timeout: 30_000 });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (error) {
    return { ok: false, out: "", err: String(error) };
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function touch(path: string): void {
  try {
    writeFileSync(path, "", { flag: "a" });
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // a missing stamp only means one extra sync
  }
}

/**
 * Commit, rebase on the remote copy, push. On a conflict, keep local state and record one line.
 * The commit takes the roll-up of this machine's log, which is due once per day.
 */
export function syncNow(store: Store, now: Date = new Date()): SyncResult {
  if (!store.hasRemote()) {
    // A store with git and no remote keeps its history on this machine: commit, and push nowhere.
    if (store.isGitRepo()) {
      store.ensure();
      rollUp(store, now);
      store.commit("kb: sync", { all: true });
    }
    return { status: "no-remote", detail: store.isGitRepo() ? "the store has no git remote, so its commits stay on this machine" : "the store has no git remote" };
  }
  // A fresh clone of an empty remote has no layout yet. Sync is a write, so create it.
  store.ensure();

  const lock = store.statePath("sync-lock");
  if (Date.now() - mtime(lock) > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
  try {
    mkdirSync(lock);
  } catch {
    return { status: "busy", detail: "another sync is in progress" };
  }

  try {
    rollUp(store, now);
    store.commit("kb: sync", { all: true });
    const merged: MergedNote[] = [];
    const fail = (status: "conflict" | "error", detail: string): SyncResult => {
      writeFileSync(store.syncErrorPath(), `${detail}\n`);
      return { status, detail };
    };

    const remote = run(store, "remote").out.split("\n")[0]!;
    const fetch = run(store, "fetch", "-q", remote);
    if (!fetch.ok) return fail("error", `the remote ${remote} did not answer. Check the network, then run \`kb sync\`.`);
    const branch = run(store, "branch", "--show-current").out;
    if (!branch) return fail("error", `the store is not on a branch. Run \`git -C ${short(store)} switch main\`, then \`kb sync\`.`);

    const hasLocal = run(store, "rev-parse", "-q", "--verify", "HEAD").ok;
    const hasRemoteBranch = run(store, "rev-parse", "-q", "--verify", `${remote}/${branch}`).ok;
    if (hasRemoteBranch && hasLocal) {
      // A write that commits while the rebase runs would break it, so the two take turns.
      const rebase = store.withGitLock(() => rebaseOnto(store, `${remote}/${branch}`, now));
      if (!rebase) return fail("error", "another kb process held the store's git for too long. Run `kb sync` again.");
      if ("files" in rebase) {
        const result = fail("conflict", conflictDetail(store, remote, branch, rebase.files));
        return { ...result, files: rebase.files };
      }
      merged.push(...rebase.merged);
    } else if (hasRemoteBranch) {
      return fail("error", `the store has no commit yet but the remote has. Move ${short(store)} away, clone the remote to it, then run \`kb sync\`.`);
    }
    if (hasLocal) {
      const push = run(store, "push", "-q", "-u", remote, "HEAD");
      if (!push.ok) return fail("error", `the push was refused. Run \`git -C ${short(store)} push\` to see why, then \`kb sync\`.`);
    }

    store.clearSyncError();
    // Notes may have arrived from another machine, so rebuild the generated files.
    store.writeIndex();
    clearStaleCache(store);
    if (merged.length > 0) {
      recordMerged(store, merged);
      return { status: "ok", detail: `the store matches the remote. ${merged.map(mergedLine).join(" ")}`, merged };
    }
    return { status: "ok", detail: "the store matches the remote" };
  } finally {
    touch(store.statePath("sync-last"));
    rmSync(lock, { recursive: true, force: true });
  }
}

/** The store's folder as the user types it, with ~ for the home folder. */
function short(store: Store): string {
  const home = tilde("~");
  return store.home.startsWith(`${home}/`) ? `~${store.home.slice(home.length)}` : store.home;
}

function conflictDetail(store: Store, remote: string, branch: string, files: string[]): string {
  const what = files.length > 0 ? `two machines changed ${files.join(", ")}, and kb cannot merge ${files.length === 1 ? "it" : "them"}.` : `the rebase on ${remote}/${branch} stopped, and git named no file.`;
  return [
    `${what} This store keeps its own copy and does not sync.`,
    `To fix it: run \`git -C ${short(store)} rebase ${remote}/${branch}\`, edit each file that git names to keep what is right, \`git add\` it, run \`git rebase --continue\`, then \`kb sync\`.`,
    `To take the remote copy and drop this store's changes: \`git -C ${short(store)} reset --hard ${remote}/${branch}\`.`,
  ].join(" ");
}

const mergedLine = (m: MergedNote) =>
  `Two machines changed ${m.id}: kb kept the copy verified last (from ${m.kept}) and put the other in the trash as ${m.copy}. Compare them with \`kb show ${m.id}\` and \`kb show ${m.copy}\`, then bring what the copy adds into ${m.id} and \`kb delete ${m.copy}\`.`;

const MERGED_FILE = "sync-merged.json";

/** Remember the merged notes, so a session start names each one while its copy is in the trash. */
function recordMerged(store: Store, merged: MergedNote[]): void {
  // A note whose copy left the trash is done.
  const trashed = new Set(store.notes({ trashed: true }).map((n) => n.id));
  const open = readMerged(store).filter((m) => trashed.has(m.copy));
  writeAtomic(store.statePath(MERGED_FILE), `${JSON.stringify([...open, ...merged], null, 2)}\n`);
}

function readMerged(store: Store): MergedNote[] {
  try {
    const list = JSON.parse(readFileSync(store.statePath(MERGED_FILE), "utf8"));
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === "string" && typeof m.copy === "string") : [];
  } catch {
    return [];
  }
}

/** A line for each merged note whose other copy is still in the trash: the session start shows them. */
export function mergedNotices(store: Store): string[] {
  const merged = readMerged(store);
  if (merged.length === 0) return [];
  const trashed = new Set(store.notes({ trashed: true }).map((n) => n.id));
  return merged.filter((m) => trashed.has(m.copy)).map((m) => `kb sync merged a note. ${mergedLine(m)}`);
}

/**
 * Rebase on the remote copy. When two machines changed the same note, both copies are kept: the one
 * verified last stays, and the other goes to the trash under a new id, so nothing is lost and the
 * sync goes on. A conflict in any other file, or a note that one machine removed, stops the rebase:
 * the store is as it was, and `files` names what conflicts.
 */
function rebaseOnto(store: Store, upstream: string, now: Date): { merged: MergedNote[] } | { files: string[] } {
  const merged: MergedNote[] = [];
  let step = run(store, "rebase", "-q", "--autostash", upstream);
  for (let round = 0; !step.ok && round < 1000; round++) {
    const files = run(store, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
    const done = files.length === 0 ? null : files.map((file) => mergeNote(store, file, now));
    if (!done || done.some((m) => m === null)) {
      run(store, "rebase", "--abort");
      return { files };
    }
    merged.push(...(done as MergedNote[]));
    step = run(store, "rebase", "--continue");
  }
  if (!step.ok) {
    run(store, "rebase", "--abort");
    return { files: [] };
  }
  return { merged };
}

/** A copy of a note in the conflict: stage 2 is the remote side of a rebase, stage 3 this machine's. */
function stage(store: Store, n: 2 | 3, file: string): Note | null {
  const shown = run(store, "show", `:${n}:${file}`);
  if (!shown.ok) return null;
  try {
    return parseNote(`${shown.out}\n`);
  } catch {
    return null;
  }
}

/** Merge one note that both sides changed. Null for any other file. */
function mergeNote(store: Store, file: string, now: Date): MergedNote | null {
  if (!/^(notes|trash)\/.+\.md$/.test(file)) return null;
  const remote = stage(store, 2, file);
  const local = stage(store, 3, file);
  if (!remote || !local || remote.id !== local.id) return null;
  // The copy verified last wins. On a tie the remote copy stays, as every other machine has it.
  const localWins = local.last_verified > remote.last_verified;
  const [kept, other] = localWins ? [local, remote] : [remote, local];
  let copy = `${kept.id}-conflict`;
  for (let n = 2; existsSync(store.notePath({ scope: other.scope, id: copy }, true)) || existsSync(store.notePath({ scope: other.scope, id: copy })); n++) copy = `${kept.id}-conflict-${n}`;
  const copyPath = store.notePath({ scope: other.scope, id: copy }, true);
  writeAtomic(join(store.home, file), serializeNote(kept));
  writeAtomic(copyPath, serializeNote({ ...other, id: copy, trashed_at: now.toISOString().replace(/\.\d{3}Z$/, "Z") }));
  if (!run(store, "add", "--", file, copyPath).ok) return null;
  return { id: kept.id, copy, kept: localWins ? "this machine" : "the remote" };
}

/**
 * Start a sync in a detached process and return at once.
 * With throttleMs, skip it when the last sync is more recent than that.
 */
export function kickSync(store: Store, throttleMs = 0): boolean {
  try {
    if (!store.exists() || !store.config().sync || !store.hasRemote()) return false;
    const stamp = store.statePath("sync-last");
    if (throttleMs > 0 && Date.now() - mtime(stamp) < throttleMs) return false;
    touch(stamp);
    return detached(store, ["sync", "--quiet"]);
  } catch {
    return false;
  }
}

/** Run a kb command in a detached process and return at once. */
export function detached(store: Store, args: string[]): boolean {
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, KB_HOME: store.home },
      detached: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
