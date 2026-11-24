import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../cli/context.ts";
import { judgments, lastActivity } from "../cli/log.ts";
import { findStale } from "../cli/stale.ts";
import { Store } from "../cli/store.ts";
import { tidyTrash } from "../cli/write.ts";
import { syncNow } from "../cli/sync.ts";
import { daysAgo, kb, legacyUsage, logAt, machineConfig, plain, putNote, sh, tempDir } from "./helpers.ts";

/** Two machines: two clones of one bare remote. */
function twoMachines(): { a: Store; b: Store } {
  const base = tempDir("kb-sync-");
  const remote = join(base, "remote.git");
  sh(base, "git", "init", "-q", "--bare", "-b", "main", remote);
  const make = (name: string) => {
    const home = join(base, name);
    sh(base, "git", "clone", "-q", remote, home);
    const store = new Store(home);
    store.ensure();
    // Background sync is off, so each test controls the order of events.
    machineConfig(store, { sync: false });
    return store;
  };
  return { a: make("a"), b: make("b") };
}

describe("kb sync", () => {
  test("without a remote it does nothing", () => {
    const store = new Store(join(tempDir(), "store"));
    store.ensure();
    expect(syncNow(store).status).toBe("no-remote");
  });

  test("a write starts a background sync that reaches the remote with no kb sync call", async () => {
    const { a, b } = twoMachines();
    // Sync is a key of each machine, so each one turns it on.
    for (const store of [a, b]) machineConfig(store, { sync: true });
    const added = kb(a, ["add", "--json"], { stdin: JSON.stringify({ title: "Pushed in the background", kind: "gotcha", body: "x", scope: "global" }) });
    expect(added.json.status).toBe("created");
    const remoteLog = () => Bun.spawnSync(["git", "-C", join(a.home, "..", "remote.git"), "log", "--format=%s", "main"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    for (let i = 0; i < 100 && !remoteLog().includes("kb: add pushed-in-the-background"); i++) await Bun.sleep(100);
    expect(remoteLog()).toContain("kb: add pushed-in-the-background");
    expect(syncNow(b)).toMatchObject({ status: "ok" });
    expect(b.find("pushed-in-the-background")).toBeDefined();
  });

  test("a note added on one machine arrives on the other", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "from-a", title: "Written on machine A" });
    expect(syncNow(a)).toMatchObject({ status: "ok" });
    expect(syncNow(b)).toMatchObject({ status: "ok" });
    expect(b.find("from-a")?.title).toBe("Written on machine A");
    // Generated files are rebuilt on the machine that received the note.
    expect(readFileSync(join(b.home, "INDEX.md"), "utf8")).toContain("from-a");
  });

  test("the counters of an older kb go into the roll-ups once, and each machine reads the newest last use", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "shared" });
    syncNow(a);
    syncNow(b);
    // Both counter files are in both stores, as an older kb synced them.
    for (const store of [a, b]) {
      legacyUsage(store, "machine-a", { shared: { uses: 1, last_used: "2026-03-01T00:00:00Z" } });
      legacyUsage(store, "machine-b", { shared: { uses: 2, last_used: "2026-04-02T00:00:00Z" } });
      sh(store.home, "git", "add", "-A");
      sh(store.home, "git", "commit", "-q", "-m", "older kb");
    }
    expect(syncNow(a).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    expect(syncNow(a).status).toBe("ok");
    for (const store of [a, b]) {
      expect(lastActivity(store).get("shared")).toBe("2026-04-02T00:00:00Z");
      expect(existsSync(join(store.home, "usage"))).toBe(false);
      expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
    }
  });

  test("the event log stays on its machine, and its roll-up reaches the other one with a sync", () => {
    const { a, b } = twoMachines();
    // Old enough to expire where nobody opens it.
    putNote(a, { id: "shared", last_verified: daysAgo(120) });
    putNote(a, { id: "judged", last_verified: daysAgo(10) });
    syncNow(a);
    syncNow(b);
    const stale = (store: Store) => findStale(store, plain()).candidates.map((c) => `${c.id}:${c.reason}`);
    expect(stale(b)).toEqual(["shared:expired"]);

    // Machine A opens the note every week. Machine B never does.
    logAt(a, daysAgo(3), { ev: "show", note: "shared", why: "task" });
    logAt(a, daysAgo(2), { ev: "verdict", session: "s1", note: "judged", verdict: "wrong" });
    const opened = lastActivity(a).get("shared")!;
    expect(syncNow(a).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    // The log is in no commit. The roll-up of machine A is, and no other file of that kind.
    const tracked = sh(b.home, "git", "ls-files").split("\n");
    expect(tracked.filter((file) => file.startsWith(".state"))).toEqual([]);
    expect(tracked.filter((file) => file.startsWith("activity/"))).toEqual([`activity/${a.local().machine}.json`]);
    expect(sh(a.home, "git", "log", "-1", "--format=%s")).toBe("kb: sync");
    // So the note does not expire on machine B, and B sees the verdict of A.
    expect(lastActivity(b).get("shared")).toBe(opened);
    expect(judgments(b).get("judged")?.wrong).toBeDefined();
    expect(stale(b)).toEqual(["judged:judged-wrong"]);
    expect(stale(a)).toEqual(["judged:judged-wrong"]);

    // Machine B has activity of its own. Each machine writes its own file, so the two never conflict.
    logAt(b, daysAgo(1), { ev: "show", note: "judged", why: "task" });
    logAt(a, daysAgo(1), { ev: "fire", kind: "path", form: "title", note: "shared", tool: "Read", match: "a.ts" });
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(syncNow(b).status).toBe("ok");
    expect(syncNow(a, tomorrow).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    expect(a.local().machine).not.toBe(b.local().machine);
    for (const store of [a, b]) expect(sh(store.home, "git", "ls-files", "activity").split("\n").sort()).toEqual([`activity/${a.local().machine}.json`, `activity/${b.local().machine}.json`].sort());
    expect(lastActivity(a).get("judged")).toBe(lastActivity(b).get("judged")!);
    expect(lastActivity(b).get("shared")).toBe(lastActivity(a).get("shared")!);

    // A fresh clone has no log at all. It still knows what is active.
    const fresh = new Store(join(a.home, "..", "c"));
    sh(join(a.home, ".."), "git", "clone", "-q", join(a.home, "..", "remote.git"), fresh.home);
    expect(lastActivity(fresh).get("shared")).toBe(lastActivity(a).get("shared")!);
    expect(stale(fresh)).toEqual(["judged:judged-wrong"]);
  });

  test("a new note on one machine never takes the id of a note that another machine has activity for", () => {
    const { a, b } = twoMachines();
    const add = (store: Store, title: string) => kb(store, ["add", "--json"], { stdin: JSON.stringify({ title, kind: "gotcha", body: "x", scope: "global" }) }).json;
    expect(add(a, "The cache key").id).toBe("the-cache-key");
    // Machine A works with the note, then deletes it.
    expect(kb(a, ["show", "the-cache-key"]).code).toBe(0);
    expect(syncNow(a).status).toBe("ok");
    expect(kb(a, ["delete", "the-cache-key"]).code).toBe(0);
    expect(syncNow(a).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    // Machine B has no such note and no event for it. The roll-up of A says the id has a history.
    expect(b.notes()).toEqual([]);
    expect(existsSync(join(b.home, ".state", "log"))).toBe(false);
    expect(add(b, "The cache key")).toMatchObject({ status: "created", id: "the-cache-key-2" });
    // An id that no machine has a history for is free.
    expect(add(b, "Another fact").id).toBe("another-fact");
  });

  test("different notes changed on both machines merge", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "one" });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "two" });
    putNote(b, { id: "three" });
    expect(syncNow(a).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    expect(syncNow(a).status).toBe("ok");
    for (const store of [a, b]) expect(store.notes().map((n) => n.id).sort()).toEqual(["one", "three", "two"]);
  });

  test("a note that both machines changed keeps both copies, and the sync goes on", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: "original" });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", body: "edit from A", last_verified: "2026-02-01T00:00:00Z" });
    putNote(b, { id: "same", body: "edit from B", last_verified: "2026-03-01T00:00:00Z" });
    putNote(b, { id: "only-b" });
    expect(syncNow(a).status).toBe("ok");

    const result = syncNow(b);
    expect(result.status).toBe("ok");
    expect(result.merged).toEqual([{ id: "same", copy: "same-conflict", kept: "this machine" }]);
    expect(result.detail).toContain("kb kept the copy verified last (from this machine) and put the other in the trash as same-conflict");
    // B verified its copy last, so it stays. A's copy waits in the trash, and B's other note is pushed.
    expect(b.find("same")!.body).toBe("edit from B");
    expect(b.find("same-conflict")).toMatchObject({ trashed: true, body: "edit from A" });
    expect(sh(b.home, "git", "status", "--porcelain")).toBe("");
    expect(sh(b.home, "git", "rev-list", "--count", "origin/main..HEAD")).toBe("0");
    expect(sh(b.home, "git", "rev-list", "--count", "HEAD..origin/main")).toBe("0");

    // Each session start names it while the copy is in the trash.
    const notice = "kb sync merged a note. Two machines changed same: kb kept the copy verified last and put the other in the trash as same-conflict";
    expect(buildContext(b, plain()).text).toContain(notice);
    // The copy syncs, so machine A learns that its edit went to the trash.
    expect(syncNow(a).status).toBe("ok");
    expect(a.find("same")!.body).toBe("edit from B");
    expect(a.find("same-conflict")).toMatchObject({ trashed: true, body: "edit from A", conflict_of: "same" });
    expect(buildContext(a, plain()).text).toContain(notice);
    // The trash does not clear it until someone acts.
    expect(tidyTrash(a, "2030-01-01T00:00:00Z")).toEqual([]);
    expect(a.find("same-conflict")).toBeDefined();
    // A copy that comes back is a note, and no conflict copy.
    expect(kb(a, ["restore", "same-conflict"]).code).toBe(0);
    expect(a.find("same-conflict")).toMatchObject({ trashed: false, body: "edit from A" });
    expect(a.find("same-conflict")!.conflict_of).toBeUndefined();
    expect(kb(b, ["delete", "same-conflict"]).code).toBe(0);
    expect(buildContext(b, plain()).text).not.toContain("kb sync merged");
    expect(syncNow(b).status).toBe("ok");
    expect(syncNow(a).status).toBe("ok");
    expect(buildContext(a, plain()).text).not.toContain("kb sync merged");
  });

  test("a note that several local commits changed gets one decision and one copy", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: "original" });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", body: "edit from A", last_verified: "2026-02-01T00:00:00Z" });
    syncNow(a);
    for (const [body, verified] of [["first from B", "2026-01-02T00:00:00Z"], ["second from B", "2026-01-03T00:00:00Z"], ["third from B", "2026-03-01T00:00:00Z"]] as const) {
      putNote(b, { id: "same", body, last_verified: verified });
      expect(b.commit(`kb: edit ${body}`, { all: true })).toBe(true);
    }
    const result = syncNow(b);
    expect(result.merged).toEqual([{ id: "same", copy: "same-conflict", kept: "this machine" }]);
    expect(b.find("same")!.body).toBe("third from B");
    expect(b.notes({ trashed: true }).map((n) => n.id)).toEqual(["same-conflict"]);
    expect(b.find("same-conflict")!.body).toBe("edit from A");
  });

  test("the copy takes an id that no note has in any scope, in the trash or with a history", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", scope: "example/repo", body: "original" });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", scope: "example/repo", body: "edit from A" });
    putNote(b, { id: "same", scope: "example/repo", body: "edit from B" });
    // Another scope has a note with the id of the copy, and the id -conflict-2 has a history.
    putNote(b, { id: "same-conflict", scope: "global" });
    putNote(b, { id: "same-conflict-3", scope: "example/other" }, true);
    logAt(b, daysAgo(2), { ev: "show", note: "same-conflict-2", why: "task" });
    syncNow(a);
    expect(syncNow(b).merged).toEqual([{ id: "same", copy: "same-conflict-4", kept: "the remote" }]);
    expect(b.find("same-conflict-4")).toMatchObject({ scope: "example/repo", trashed: true, body: "edit from B" });
    expect(b.find("same-conflict")!.scope).toBe("global");
  });

  test("on a tie the remote copy stays", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: "original" });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", body: "edit from A" });
    putNote(b, { id: "same", body: "edit from B" });
    syncNow(a);
    expect(syncNow(b).merged).toEqual([{ id: "same", copy: "same-conflict", kept: "the remote" }]);
    expect(b.find("same")!.body).toBe("edit from A");
    expect(b.find("same-conflict")!.body).toBe("edit from B");
  });

  test("a conflict kb cannot merge names the file, fails, and the steps it gives fix it", () => {
    const { a, b } = twoMachines();
    writeFileSync(join(a.home, "kb.config.json"), JSON.stringify({ trashDays: 7 }));
    syncNow(a);
    syncNow(b);
    writeFileSync(join(a.home, "kb.config.json"), JSON.stringify({ trashDays: 9 }));
    writeFileSync(join(b.home, "kb.config.json"), JSON.stringify({ trashDays: 14 }));
    putNote(b, { id: "only-b" });
    syncNow(a);

    const result = kb(b, ["sync", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, status: "conflict", files: ["kb.config.json"] });
    expect(result.json.detail).toContain("two machines changed kb.config.json, and kb cannot merge it.");
    // The store is outside the home folder of the tests, so its path stays whole.
    expect(result.json.detail).toContain(`git -C ${b.home} rebase origin/main`);
    // Every git command of the steps names the store.
    for (const step of ["add <file>", "rebase --continue"]) expect(result.json.detail).toContain(`git -C ${b.home} ${step}`);
    expect(existsSync(join(b.home, ".git", "rebase-merge"))).toBe(false);
    expect(sh(b.home, "git", "status", "--porcelain")).toBe("");
    expect(b.find("only-b")).toBeDefined();
    const context = buildContext(b, plain()).text;
    expect(context).toContain("kb sync did not finish: two machines changed kb.config.json");
    expect(context).not.toContain("shows the detail");
    expect(kb(b, ["sync"]).code).toBe(1);

    // The steps of the message: rebase, keep what is right, continue, sync.
    Bun.spawnSync(["git", "-C", b.home, "rebase", "origin/main"], { stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(b.home, "kb.config.json"), JSON.stringify({ trashDays: 14 }));
    sh(b.home, "git", "add", "kb.config.json");
    sh(b.home, "env", "GIT_EDITOR=true", "git", "rebase", "--continue");
    expect(kb(b, ["sync", "--json"]).json).toMatchObject({ ok: true, status: "ok" });
    expect(buildContext(b, plain()).text).not.toContain("kb sync did not finish");
    syncNow(a);
    expect(readFileSync(join(a.home, "kb.config.json"), "utf8")).toBe(JSON.stringify({ trashDays: 14 }));
    expect(a.find("only-b")).toBeDefined();
  });

  test("a conflict that holds a file kb cannot merge writes no copy of a note", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: "original" });
    writeFileSync(join(a.home, "kb.config.json"), JSON.stringify({ trashDays: 7 }));
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", body: "edit from A" });
    writeFileSync(join(a.home, "kb.config.json"), JSON.stringify({ trashDays: 9 }));
    putNote(b, { id: "same", body: "edit from B" });
    writeFileSync(join(b.home, "kb.config.json"), JSON.stringify({ trashDays: 14 }));
    syncNow(a);
    expect(syncNow(b).status).toBe("conflict");
    expect(b.notes({ trashed: true })).toEqual([]);
    expect(sh(b.home, "git", "status", "--porcelain")).toBe("");
  });

  // Git follows a move only when the moved file stays 50% like the old one. A note that one side
  // rewrote and then trashed does not, so git reports modify/delete.
  const lines = (text: string) => Array.from({ length: 40 }, (_, i) => `${text} ${i * 7} that shares nothing with the other words.`).join("\n");

  test("a note that the remote rewrote and trashed, and this machine rewrote, goes to the trash with both copies", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: lines("The original line") });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", body: lines("Fresh text from A"), last_verified: "2026-02-01T00:00:00Z" });
    expect(kb(a, ["trash", "same"]).code).toBe(0);
    putNote(b, { id: "same", body: lines("Newer text from B"), last_verified: "2026-03-01T00:00:00Z" });
    syncNow(a);
    const result = syncNow(b);
    expect(result.status).toBe("ok");
    expect(result.merged).toEqual([{ id: "same", copy: "same-conflict", kept: "this machine" }]);
    expect(b.notes().map((n) => n.id)).not.toContain("same");
    expect(b.find("same")).toMatchObject({ trashed: true });
    expect(b.find("same")!.body).toContain("Newer text from B");
    expect(b.find("same-conflict")).toMatchObject({ trashed: true, conflict_of: "same" });
    expect(b.find("same-conflict")!.body).toContain("Fresh text from A");
    expect(sh(b.home, "git", "status", "--porcelain")).toBe("");
    expect(syncNow(a).status).toBe("ok");
    expect(a.find("same")!.body).toContain("Newer text from B");
  });

  test("the reverse: this machine rewrote and trashed a note that the remote rewrote", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: lines("The original line") });
    syncNow(a);
    syncNow(b);
    putNote(b, { id: "same", body: lines("Fresh text from B"), last_verified: "2026-02-01T00:00:00Z" });
    expect(kb(b, ["trash", "same"]).code).toBe(0);
    putNote(a, { id: "same", body: lines("Newer text from A"), last_verified: "2026-03-01T00:00:00Z" });
    syncNow(a);
    const result = syncNow(b);
    expect(result.status).toBe("ok");
    expect(result.merged).toEqual([{ id: "same", copy: "same-conflict", kept: "the remote" }]);
    expect(b.find("same")).toMatchObject({ trashed: true });
    expect(b.find("same")!.body).toContain("Newer text from A");
    expect(b.find("same-conflict")!.body).toContain("Fresh text from B");
  });

  test("a note that one machine trashed and the other changed goes to the trash with the change", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: "original" });
    syncNow(a);
    syncNow(b);
    expect(kb(a, ["trash", "same"]).code).toBe(0);
    putNote(b, { id: "same", body: "edit from B" });
    syncNow(a);
    // git follows the move, so the edit lands in the trashed note and nothing is lost.
    expect(syncNow(b).status).toBe("ok");
    expect(b.find("same")).toMatchObject({ trashed: true, body: "edit from B" });
    expect(b.notes().map((n) => n.id)).not.toContain("same");
  });
});
