import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../cli/context.ts";
import { judgments, lastActivity } from "../cli/log.ts";
import { findStale } from "../cli/stale.ts";
import { Store } from "../cli/store.ts";
import { syncNow } from "../cli/sync.ts";
import { daysAgo, kb, legacyUsage, logAt, plain, putNote, sh, tempDir } from "./helpers.ts";

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
    writeFileSync(join(home, "kb.config.json"), JSON.stringify({ sync: false }));
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
    // The config is tracked, so both machines get the same one.
    for (const store of [a, b]) writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ sync: true }));
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

  test("the counters of an older kb still sync, and each machine reads the newest last use", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "shared" });
    syncNow(a);
    syncNow(b);
    legacyUsage(a, "machine-a", { shared: { uses: 1, last_used: "2026-03-01T00:00:00Z" } });
    legacyUsage(b, "machine-b", { shared: { uses: 2, last_used: "2026-04-02T00:00:00Z" } });
    expect(syncNow(a).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    expect(syncNow(a).status).toBe("ok");
    for (const store of [a, b]) expect(lastActivity(store).get("shared")).toBe("2026-04-02T00:00:00Z");
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

  test("a conflict keeps local notes, reports one line, and clears after a fix", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "same", body: "original" });
    syncNow(a);
    syncNow(b);
    putNote(a, { id: "same", body: "edit from A" });
    putNote(b, { id: "same", body: "edit from B" });
    expect(syncNow(a).status).toBe("ok");

    const result = syncNow(b);
    expect(result.status).toBe("conflict");
    expect(b.find("same")?.body).toBe("edit from B");
    expect(existsSync(join(b.home, ".git", "rebase-merge"))).toBe(false);
    expect(sh(b.home, "git", "status", "--porcelain")).toBe("");
    const context = buildContext(b, plain()).text;
    expect(context).toContain("kb sync did not finish: two machines changed the same note.");
    expect(context.match(/kb sync did not finish/g)).toHaveLength(1);

    // The user takes the remote copy. The next sync is clean and the line is gone.
    sh(b.home, "git", "reset", "-q", "--hard", "origin/main");
    expect(syncNow(b).status).toBe("ok");
    expect(buildContext(b, plain()).text).not.toContain("kb sync did not finish");
    expect(b.find("same")?.body).toBe("edit from A");
  });
});
