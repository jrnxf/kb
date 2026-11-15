import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../cli/context.ts";
import { Store } from "../cli/store.ts";
import { syncNow } from "../cli/sync.ts";
import { kb, plain, putNote, sh, tempDir } from "./helpers.ts";

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
    expect(readFileSync(join(b.home, "index.html"), "utf8")).toContain("Written on machine A");
  });

  test("usage on two machines never conflicts and the counters add up", () => {
    const { a, b } = twoMachines();
    putNote(a, { id: "shared" });
    syncNow(a);
    syncNow(b);
    expect(a.machine()).not.toBe(b.machine());
    a.bumpUsage(["shared"], "2026-03-01T00:00:00Z");
    b.bumpUsage(["shared"], "2026-04-01T00:00:00Z");
    b.bumpUsage(["shared"], "2026-04-02T00:00:00Z");
    expect(syncNow(a).status).toBe("ok");
    expect(syncNow(b).status).toBe("ok");
    expect(syncNow(a).status).toBe("ok");
    for (const store of [a, b]) expect(store.usage().get("shared")).toEqual({ uses: 3, last_used: "2026-04-02T00:00:00Z" });
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
