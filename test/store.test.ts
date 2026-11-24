import { describe, expect, test } from "bun:test";
import { rmSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tidyTrash } from "../cli/write.ts";
import { Store, withLock } from "../cli/store.ts";
import { syncNow } from "../cli/sync.ts";
import { kb, putNote, sh, tempDir, tempStore } from "./helpers.ts";

const note = (title: string, body = "x") => JSON.stringify({ title, kind: "gotcha", body, scope: "global", new: true });
const mode = (path: string) => statSync(path).mode & 0o777;

describe("a new store", () => {
  test("starts as a git repo with no remote, so a deleted note stays in the history", () => {
    const home = join(tempDir(), "store");
    expect(kb(home, ["add", "--json"], { stdin: note("Gradle caches break offline builds", "the body to keep") }).code).toBe(0);
    expect(sh(home, "git", "log", "--format=%s")).toBe("kb: add gradle-caches-break-offline-builds");
    expect(sh(home, "git", "remote")).toBe("");
    expect(kb(home, ["delete", "gradle-caches-break-offline-builds"]).code).toBe(0);
    expect(existsSync(join(home, "notes", "global", "gradle-caches-break-offline-builds.md"))).toBe(false);
    const old = sh(home, "git", "show", "HEAD~1:notes/global/gradle-caches-break-offline-builds.md");
    expect(old).toContain("the body to keep");
    // A sync with no remote commits on this machine and pushes nowhere.
    const sync = kb(home, ["sync", "--json"]);
    expect(sync.json.status).toBe("no-remote");
    expect(sync.json.detail).toContain("stay on this machine");
  });

  test("an empty folder counts as a new store", () => {
    const home = tempDir();
    expect(kb(home, ["add", "--json"], { stdin: note("Empty folders get a git repo") }).code).toBe(0);
    expect(existsSync(join(home, ".git"))).toBe(true);
  });

  test("a store of an older kb with no git keeps working, and gets no git", () => {
    const home = join(tempDir(), "store");
    mkdirSync(join(home, "notes"), { recursive: true });
    expect(kb(home, ["add", "--json"], { stdin: note("Old stores have no history") }).json.status).toBe("created");
    expect(existsSync(join(home, ".git"))).toBe(false);
    expect(kb(home, ["sync", "--json"]).json).toEqual({ status: "no-remote", detail: "the store has no git remote" });
    expect(kb(home, ["list", "--json"]).stdout).toContain("old-stores-have-no-history");
  });
});

describe("the permissions of the store", () => {
  test("only the user can read a new store, its notes and its .state folder", () => {
    const home = join(tempDir(), "store");
    kb(home, ["add", "--json"], { stdin: note("Private notes stay private") });
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, ".state"))).toBe(0o700);
    expect(mode(join(home, "notes", "global"))).toBe(0o700);
    expect(mode(join(home, "notes", "global", "private-notes-stay-private.md"))).toBe(0o600);
    for (const file of sh(join(home, ".state", "log"), "ls").split("\n")) expect(mode(join(home, ".state", "log", file))).toBe(0o600);
  });

  test("a write closes a store that an older kb left open to every user", () => {
    const home = join(tempDir(), "store");
    mkdirSync(join(home, "notes"), { recursive: true });
    mkdirSync(join(home, ".state"));
    chmodSync(home, 0o755);
    chmodSync(join(home, ".state"), 0o755);
    kb(home, ["add", "--json"], { stdin: note("Open stores get closed") });
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, ".state"))).toBe(0o700);
  });

  test("the first write closes the notes, the trash and the files of an older store too", () => {
    const home = join(tempDir(), "store");
    kb(home, ["add", "--json"], { stdin: note("Old files get closed") });
    const file = join(home, "notes", "global", "old-files-get-closed.md");
    rmSync(join(home, ".state", "private"));
    chmodSync(file, 0o644);
    chmodSync(join(home, "notes", "global"), 0o755);
    mkdirSync(join(home, "trash", "global"), { recursive: true, mode: 0o755 });
    chmodSync(join(home, "trash", "global"), 0o755);
    kb(home, ["add", "--json"], { stdin: note("A later write") });
    expect(mode(file)).toBe(0o600);
    expect(mode(join(home, "notes", "global"))).toBe(0o700);
    expect(mode(join(home, "trash", "global"))).toBe(0o700);
  });
});

describe("the lock", () => {
  test("a lock of a process that is gone is taken over, and a lock of a live process is not", () => {
    const lock = join(tempDir(), "lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "999999 dead");
    expect(withLock(lock, () => "ran", { waitMs: 0 })).toBe("ran");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${process.pid} live`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    utimesSync(join(lock, "owner"), old, old);
    // The holder lives, and the lock is not past the stale time: a slow holder keeps it.
    expect(withLock(lock, () => "ran", { waitMs: 50, staleMs: 600_000 })).toBeUndefined();
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(`${process.pid} live`);
  });

  test("a holder that was taken over does not remove the new holder's lock", () => {
    const lock = join(tempDir(), "lock");
    withLock(lock, () => {
      rmSync(lock, { recursive: true });
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), "999999 other");
    });
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("999999 other");
  });

  test("a commit that cannot make its lock folder warns and does not throw", () => {
    const store = tempStore();
    putNote(store, { id: "first" });
    store.track(join(store.home, "notes", "global", "first.md"));
    chmodSync(store.statePath("."), 0o500);
    try {
      expect(store.commit("kb: no lock")).toBe(false);
    } finally {
      chmodSync(store.statePath("."), 0o700);
    }
    expect(store.commit("kb: with lock")).toBe(true);
  });

  test("a commit that finds the lock taken keeps its paths for the next commit", () => {
    const store = tempStore();
    store.gitLockWaitMs = 50;
    const note = putNote(store, { id: "kept-path" });
    store.track(store.notePath(note));
    mkdirSync(store.statePath("git-lock"));
    writeFileSync(join(store.statePath("git-lock"), "owner"), `${process.pid} live`);
    expect(store.commit("kb: first try")).toBe(false);
    rmSync(store.statePath("git-lock"), { recursive: true });
    expect(store.commit("kb: second try")).toBe(true);
    expect(sh(store.home, "git", "show", "--name-only", "--format=", "HEAD")).toContain("kept-path.md");
  });

  test("a sync that finds the git lock taken says busy and writes no sync error", () => {
    const store = tempStore();
    const remote = join(tempDir(), "remote.git");
    sh(tempDir(), "git", "init", "-q", "--bare", "-b", "main", remote);
    sh(store.home, "git", "checkout", "-q", "-b", "main");
    sh(store.home, "git", "remote", "add", "origin", remote);
    putNote(store, { id: "first" });
    expect(syncNow(store).status).toBe("ok");
    store.gitLockWaitMs = 50;
    mkdirSync(store.statePath("git-lock"));
    writeFileSync(join(store.statePath("git-lock"), "owner"), `${process.pid} live`);
    expect(syncNow(store).status).toBe("busy");
    expect(store.syncError()).toBeNull();
  });

  test("the trash stamp of a note moved there by hand is committed", () => {
    const store = tempStore();
    const note = putNote(store, { id: "by-hand" }, true);
    sh(store.home, "git", "add", "-A");
    sh(store.home, "git", "commit", "-q", "-m", "hand move");
    expect(tidyTrash(store)).toEqual([]);
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
    expect(sh(store.home, "git", "show", "--name-only", "--format=%s", "HEAD")).toContain(`trash/global/${note.id}.md`);
  });
});

describe("a commit", () => {
  test("parallel writes each get their own commit, with the right message", async () => {
    const home = join(tempDir(), "store");
    kb(home, ["add", "--json"], { stdin: note("The first note of the store") });
    const words = ["apple", "brick", "cedar", "delta", "ember", "falcon", "granite", "harbor", "indigo", "juniper", "kettle", "lantern"];
    const runs = words.map(
      (word) =>
        Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli", "main.ts"), "add", "--json"], {
          env: { ...process.env, KB_HOME: home },
          stdin: Buffer.from(note(`${word} ${word}s break the ${word} build`, `body ${word}`)),
          stdout: "pipe",
          stderr: "pipe",
        }).exited,
    );
    expect(await Promise.all(runs)).toEqual(words.map(() => 0));
    const commits = sh(home, "git", "log", "--format=%H %s", "-n", String(words.length)).split("\n");
    expect(commits).toHaveLength(words.length);
    for (const line of commits) {
      const [hash, , , id] = line.split(" ");
      expect(sh(home, "git", "show", "--name-only", "--format=", hash!)).toBe(`notes/global/${id}.md`);
    }
    expect(sh(home, "git", "status", "--porcelain")).toBe("");
  });

  test("takes only what the write changed, and a sync takes the rest", () => {
    const home = join(tempDir(), "store");
    kb(home, ["add", "--json"], { stdin: note("The first note of the store") });
    writeFileSync(join(home, "notes", "global", "hand-made.md"), "not a note yet\n");
    kb(home, ["add", "--json"], { stdin: note("A second note of the store") });
    expect(sh(home, "git", "show", "--name-only", "--format=", "HEAD")).toBe("notes/global/a-second-note-of-the-store.md");
    expect(sh(home, "git", "status", "--porcelain")).toBe("?? notes/global/hand-made.md");
    kb(home, ["sync"]);
    expect(sh(home, "git", "log", "-1", "--format=%s")).toBe("kb: sync");
    expect(sh(home, "git", "status", "--porcelain")).toBe("");
  });

  test("a move takes the old path and the new one", () => {
    const home = join(tempDir(), "store");
    const id = kb(home, ["add", "--json"], { stdin: note("Notes move to the trash") }).json.id;
    expect(kb(home, ["trash", id]).code).toBe(0);
    expect(sh(home, "git", "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").sort()).toEqual([`A\ttrash/global/${id}.md`, `D\tnotes/global/${id}.md`]);
    expect(sh(home, "git", "status", "--porcelain")).toBe("");
  });
});

describe("the files of an older kb in the store's top folder", () => {
  test("move into .state/ on the next write, and the sync error still shows", () => {
    const store = new Store(join(tempDir(), "store"));
    mkdirSync(join(store.home, "notes"), { recursive: true });
    writeFileSync(join(store.home, ".sync-error"), "the push was refused.\n");
    writeFileSync(join(store.home, ".sync-last"), "");
    writeFileSync(join(store.home, "index.html"), "<title>kb</title>\n");
    store.ensure();
    for (const name of [".sync-error", ".sync-last", "index.html"]) expect(existsSync(join(store.home, name))).toBe(false);
    expect(existsSync(store.statePath("sync-last"))).toBe(true);
    expect(store.syncError()).toBe("the push was refused.");
    putNote(store, { id: "a" });
    expect(syncNow(store).status).toBe("no-remote");
  });
});
