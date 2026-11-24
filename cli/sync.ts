// Sync between machines through the store's git remote. Never blocks a session.

import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { idsWithHistory, rollUp } from "./log.ts";
import { type Note, parseNote, serializeNote } from "./note.ts";
import { clearStaleCache } from "./stale.ts";
import { type Store, userHome, withLock, writeAtomic } from "./store.ts";

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

/** A sync can run several git calls of 30 seconds each, so a live holder keeps its lock a long time. */
const LOCK_STALE_MS = 600_000;

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

  try {
    const result = withLock(store.statePath("sync-lock"), () => syncLocked(store, now), { waitMs: 0, staleMs: LOCK_STALE_MS });
    return result ?? { status: "busy", detail: "another sync is in progress" };
  } catch (error) {
    return { status: "error", detail: `kb cannot lock the store: ${(error as Error).message}` };
  }
}

function syncLocked(store: Store, now: Date): SyncResult {
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
      // A write that holds the lock for a long time is not a conflict: nothing is wrong, and the next sync tries again.
      if (!rebase) return { status: "busy", detail: "a write holds the store's git lock" };
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
      const lines = merged.map((m) => mergedLine(m.id, m.copy, m.kept));
      return { status: "ok", detail: `the store matches the remote. ${lines.join(" ")}`, merged };
    }
    return { status: "ok", detail: "the store matches the remote" };
  } finally {
    touch(store.statePath("sync-last"));
  }
}

/** The store's folder as the user types it, with ~ for the home folder. */
function short(store: Store): string {
  const home = userHome();
  return store.home.startsWith(`${home}/`) ? `~${store.home.slice(home.length)}` : store.home;
}

function conflictDetail(store: Store, remote: string, branch: string, files: string[]): string {
  const what = files.length > 0 ? `two machines changed ${files.join(", ")}, and kb cannot merge ${files.length === 1 ? "it" : "them"}.` : `the rebase on ${remote}/${branch} stopped, and git named no file.`;
  return [
    `${what} This store keeps its own copy and does not sync.`,
    `To fix it: run \`git -C ${short(store)} rebase ${remote}/${branch}\`, edit each file that git names to keep what is right, run \`git -C ${short(store)} add <file>\` for it, run \`git -C ${short(store)} rebase --continue\`, then \`kb sync\`.`,
    `To take the remote copy and drop this store's changes: \`git -C ${short(store)} reset --hard ${remote}/${branch}\`.`,
  ].join(" ");
}

/** The line for a note that a sync merged. It names the copy in the trash, which stays there until someone acts. */
const mergedLine = (id: string, copy: string, kept?: MergedNote["kept"]) =>
  `Two machines changed ${id}: kb kept the copy verified last${kept ? ` (from ${kept})` : ""} and put the other in the trash as ${copy}. Compare them with \`kb show ${id}\` and \`kb show ${copy}\`, then bring what the copy adds into ${id} and \`kb delete ${copy}\`.`;

/**
 * A line for each conflict copy in the trash: the session start shows them. The copy is a note
 * that syncs, so both machines see it. Only the files whose name ends in -conflict are read.
 */
export function mergedNotices(store: Store): string[] {
  const lines: string[] = [];
  for (const path of store.walk(join(store.home, "trash"))) {
    if (!CONFLICT_FILE.test(path)) continue;
    try {
      const note = parseNote(readFileSync(path, "utf8"));
      if (note.conflict_of) lines.push(`kb sync merged a note. ${mergedLine(note.conflict_of, note.id)}`);
    } catch {
      // a file that does not parse is no notice
    }
  }
  return lines.sort();
}

/** The name of a conflict copy: `<id>-conflict`, or `<id>-conflict-2` when that id is taken. */
const CONFLICT_FILE = /-conflict(-\d+)?\.md$/;

/** What kb does with one file of the conflict. */
interface Plan {
  /** The path, from the store, that a merged note takes: the file itself, or the other side of a move. */
  keptPath: string;
  kept: Note;
  /** The note that lost: it goes to the trash as a copy. Null when only one side changed the note. */
  other: Note | null;
  /** A path to remove, when the note moved. */
  remove?: string;
  localWins: boolean;
}

/**
 * Rebase on the remote copy. When two machines changed the same note, both copies are kept: the one
 * verified last stays, and the other goes to the trash under a new id, so nothing is lost and the
 * sync goes on. A conflict in any other file stops the rebase: the store is as it was, and `files`
 * names what conflicts. Several local commits that changed one note conflict once for each, so on
 * the first conflict they replay as one commit, and the note gets one decision and one copy.
 */
function rebaseOnto(store: Store, upstream: string, now: Date): { merged: MergedNote[] } | { files: string[] } {
  const before = run(store, "rev-parse", "HEAD").out;
  let squashed = false;
  const undo = () => {
    run(store, "rebase", "--abort");
    // The squash is the one change to undo: it left the tree as it was.
    if (squashed) run(store, "reset", "-q", "--soft", before);
  };
  for (;;) {
    const step = run(store, "rebase", "-q", "--autostash", upstream);
    if (step.ok) return { merged: [] };
    const files = run(store, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
    if (files.length === 0) {
      undo();
      return { files };
    }
    if (!squashed && Number(run(store, "rev-list", "--count", `${upstream}..${before}`).out) > 1) {
      run(store, "rebase", "--abort");
      if (!squash(store, upstream)) return { files };
      squashed = true;
      continue;
    }
    // Plan every file first, so a file that kb cannot merge leaves no copy behind.
    const taken = takenIds(store);
    const plans = files.map((file) => planFile(store, file, now, taken));
    if (plans.some((plan) => plan === null)) {
      undo();
      return { files };
    }
    const merged: MergedNote[] = [];
    for (const [i, plan] of (plans as Plan[]).entries()) {
      const copy = apply(store, plan, files[i]!, now, taken);
      if (copy === null) {
        undo();
        return { files };
      }
      if (copy) merged.push({ id: plan.kept.id, copy, kept: plan.localWins ? "this machine" : "the remote" });
    }
    if (!run(store, "rebase", "--continue").ok) {
      undo();
      return { files: [] };
    }
    return { merged };
  }
}

/** Put the local commits that the remote lacks into one commit. False when git refuses. */
function squash(store: Store, upstream: string): boolean {
  const base = run(store, "merge-base", "HEAD", upstream).out;
  if (!base || !run(store, "reset", "-q", "--soft", base).ok) return false;
  // A machine with no git identity still keeps its history.
  const who = run(store, "config", "user.email").out ? [] : ["-c", "user.name=kb", "-c", "user.email=kb@localhost"];
  return run(store, ...who, "commit", "-q", "-m", "kb: sync").ok;
}

/** Every id that a copy must not take: a note in any scope, active or in the trash, and any id with a history. */
function takenIds(store: Store): Set<string> {
  return new Set([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.id).concat([...idsWithHistory(store)]));
}

/** A copy of a note in the conflict: stage 1 is the base, 2 the remote side of a rebase, 3 this machine's. Null when the stage is missing or no note. */
function stage(store: Store, n: 1 | 2 | 3, file: string): Note | null {
  const shown = run(store, "show", `:${n}:${file}`);
  if (!shown.ok) return null;
  try {
    return parseNote(`${shown.out}\n`);
  } catch {
    return null;
  }
}

const withoutTime = (note: Note): Note => {
  const { trashed_at: _at, ...rest } = note;
  return rest;
};

/** The path of a note's other place: notes/ for trash/, and trash/ for notes/. */
const counterpart = (file: string) => (file.startsWith("notes/") ? `trash/${file.slice(6)}` : `notes/${file.slice(6)}`);

/**
 * Decide one note that both sides changed. Null for any file that is no note, so the caller can
 * stop before it writes anything. Git reports a note that one side moved to or from the trash as
 * modify/delete when the moved file is too unlike the old one (it was rewritten there). Then the
 * counterpart is in the index, and the note goes where the move put it, with the change.
 */
function planFile(store: Store, file: string, now: Date, taken: Set<string>): Plan | null {
  if (!/^(notes|trash)\/.+\.md$/.test(file)) return null;
  const remote = stage(store, 2, file);
  const local = stage(store, 3, file);
  // The copy verified last wins. On a tie the remote copy stays, as every other machine has it.
  const decide = (r: Note, l: Note): Pick<Plan, "kept" | "other" | "localWins"> => {
    const localWins = l.last_verified > r.last_verified;
    return { kept: localWins ? l : r, other: localWins ? r : l, localWins };
  };
  if (remote && local) return remote.id === local.id ? { keptPath: file, ...decide(remote, local) } : null;
  const present = remote ?? local;
  if (!present) return null;
  // One side removed the file. Where did the note go?
  const moved = counterpart(file);
  const movedNote = run(store, "cat-file", "-e", `:${moved}`).ok ? readNote(join(store.home, moved)) : null;
  if (!movedNote) return { keptPath: file, kept: present, other: null, localWins: remote === null };
  if (movedNote.id !== present.id) return null;
  const base = stage(store, 1, file);
  const at = movedNote.trashed_at ?? now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const place = (note: Note): Note => (moved.startsWith("trash/") ? { ...note, trashed_at: at } : withoutTime(note));
  // Only the move: the note takes the change.
  if (base && JSON.stringify(withoutTime(base)) === JSON.stringify(withoutTime(movedNote))) return { keptPath: moved, kept: place(present), other: null, remove: file, localWins: remote === null };
  // Both changed it: the mover is the remote side when the remote removed the file.
  const [r, l] = remote === null ? [movedNote, present] : [present, movedNote];
  const winner = decide(r, l);
  return { keptPath: moved, kept: place(winner.kept), other: winner.other, remove: file, localWins: winner.localWins };
}

function readNote(path: string): Note | null {
  try {
    return parseNote(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write what the plan says, and stage it. Returns the id of the copy in the trash, "" when the
 * plan made none, or null when git refuses.
 */
function apply(store: Store, plan: Plan, file: string, now: Date, taken: Set<string>): string | null {
  const keptPath = join(store.home, plan.keptPath);
  writeAtomic(keptPath, serializeNote(plan.kept));
  store.track(keptPath);
  const staged = [plan.keptPath];
  let copy = "";
  if (plan.other) {
    copy = `${plan.kept.id}-conflict`;
    for (let n = 2; taken.has(copy); n++) copy = `${plan.kept.id}-conflict-${n}`;
    taken.add(copy);
    const copyPath = store.notePath({ scope: plan.other.scope, id: copy }, true);
    writeAtomic(copyPath, serializeNote({ ...withoutTime(plan.other), id: copy, conflict_of: plan.kept.id, trashed_at: now.toISOString().replace(/\.\d{3}Z$/, "Z") }));
    // The rebase commits both files. Tracking them keeps a later commit from missing them.
    store.track(copyPath);
    staged.push(relative(store.home, copyPath));
  }
  if (plan.remove) {
    store.track(join(store.home, plan.remove));
    if (!run(store, "rm", "-q", "--cached", "--", plan.remove).ok) return null;
    rmSync(join(store.home, plan.remove), { force: true });
  }
  return run(store, "add", "--", ...staged).ok ? copy : null;
}

/** Set to stop kickSync, so a writer that nobody watches (the audit agent) never pushes the store. */
export const NO_SYNC_ENV = "KB_NO_SYNC";

/**
 * Start a sync in a detached process and return at once.
 * With throttleMs, skip it when the last sync is more recent than that.
 */
export function kickSync(store: Store, throttleMs = 0): boolean {
  try {
    if (process.env[NO_SYNC_ENV]) return false;
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
