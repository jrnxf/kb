// Sync between machines through the store's git remote. Never blocks a session.

import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rollUp } from "./log.ts";
import { clearStaleCache } from "./stale.ts";
import type { Store } from "./store.ts";

export interface SyncResult {
  status: "ok" | "no-remote" | "busy" | "conflict" | "error";
  detail: string;
}

const LOCK_STALE_MS = 120_000;

function run(store: Store, ...args: string[]): { ok: boolean; out: string; err: string } {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never wait for a password
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
    const fail = (status: "conflict" | "error", detail: string): SyncResult => {
      writeFileSync(store.syncErrorPath(), `${detail}\n`);
      return { status, detail };
    };

    const remote = run(store, "remote").out.split("\n")[0]!;
    const fetch = run(store, "fetch", "-q", remote);
    if (!fetch.ok) return fail("error", "the remote did not answer.");
    const branch = run(store, "branch", "--show-current").out;
    if (!branch) return fail("error", "the store is not on a branch.");

    const hasLocal = run(store, "rev-parse", "-q", "--verify", "HEAD").ok;
    const hasRemoteBranch = run(store, "rev-parse", "-q", "--verify", `${remote}/${branch}`).ok;
    if (hasRemoteBranch && hasLocal) {
      // A write that commits while the rebase runs would break it, so the two take turns.
      const rebase = store.withGitLock(() => {
        const result = run(store, "rebase", "-q", "--autostash", `${remote}/${branch}`);
        if (!result.ok) run(store, "rebase", "--abort");
        return result;
      }) ?? { ok: false };
      if (!rebase.ok) {
        return fail("conflict", "two machines changed the same note. Local notes are kept.");
      }
    } else if (hasRemoteBranch) {
      return fail("error", "the store has no commit yet but the remote has. Clone the remote to the store path.");
    }
    if (hasLocal) {
      const push = run(store, "push", "-q", "-u", remote, "HEAD");
      if (!push.ok) return fail("error", "the push was refused.");
    }

    store.clearSyncError();
    // Notes may have arrived from another machine, so rebuild the generated files.
    store.writeIndex();
    clearStaleCache(store);
    return { status: "ok", detail: "the store matches the remote" };
  } finally {
    touch(store.statePath("sync-last"));
    rmSync(lock, { recursive: true, force: true });
  }
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
