import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEIGHBOR_THRESHOLD, findNeighbors } from "../cli/neighbors.ts";
import { Store } from "../cli/store.ts";
import { STOP_WORDS } from "../cli/words.ts";
import { ROOT, sh, tempDir } from "./helpers.ts";

describe("findNeighbors", () => {
  const note = (id: string, title: string, body: string, scope = "global") => ({ id, scope, kind: "gotcha" as const, title, body });
  const shared = note("shared-db", "Never run the migration tool against the shared staging database", "The staging database is shared by four teams. `migrate up` there dropped a column in use.\nRun migrations on a local copy only.");
  const deploy = note("deploy", "The deploy CLI exits 0 when the upload was rejected", "Only the status live in the JSON output means deployed.");
  const draft = { title: "Staging DB is used by other teams: do not migrate it", body: "Running migrate up on staging removed a column that another team needed.", scope: "global" };

  test("finds the note that says the same fact in other words, in a store of one note and of many", () => {
    expect(findNeighbors([shared], draft).map((n) => n.id)).toEqual(["shared-db"]);
    const many = [shared, deploy, ...Array.from({ length: 40 }, (_, i) => note(`n${i}`, `Note ${i} on topic ${i}`, `A fact number ${i} about thing ${i}.`))];
    const found = findNeighbors(many, draft);
    expect(found.map((n) => n.id)).toEqual(["shared-db"]);
    expect(found[0]!.score).toBeGreaterThanOrEqual(NEIGHBOR_THRESHOLD);
    expect(found[0]!.shared).toEqual(expect.arrayContaining(["staging", "migrate", "teams"]));
  });

  test("two notes that share one word, or a few common ones, are no neighbors", () => {
    expect(findNeighbors([shared, deploy], { title: "The staging deploy needs a VPN", body: "Connect first, or the upload times out.", scope: "global" })).toEqual([]);
    expect(findNeighbors([shared, deploy], { title: "Fonts are self-hosted, not loaded from a CDN", body: "A third-party host added 300 ms to the first paint.", scope: "global" })).toEqual([]);
  });

  test("a note that says the opposite is a neighbor too, so the writer sees the contradiction", () => {
    const rule = note("rebase", "Rebase of a published branch drops review comments", "Merge the default branch into a published PR head. Never rebase it: the review tool loses the comment anchors.");
    const opposite = { title: "Always rebase a PR branch on main before the merge", body: "The history stays linear. Review comments are lost, and that is fine.", scope: "global" };
    expect(findNeighbors([rule, shared, deploy], opposite).map((n) => n.id)).toEqual(["rebase"]);
  });

  test("shared names the words as the new note writes them, and never a stop word", () => {
    const stored = note("guard", "Wrap the retries with a guard", "Use it with every call. The withs nest, and each retry of the deploy is not safe.");
    const found = findNeighbors([stored], { title: "Retrying a deploy needs the guard", body: "The withs nest. Do not retry with no guard.", scope: "global" });
    expect(found.map((n) => n.id)).toEqual(["guard"]);
    // "retries" and "retry" are in the stored note. The new note writes "retrying" first.
    expect(found[0]!.shared).toEqual(expect.arrayContaining(["retrying", "guard", "withs"]));
    expect(found[0]!.shared.filter((word) => STOP_WORDS.has(word))).toEqual([]);
  });

  test("the score is 1 at most, also for a short note that repeats the shared words", () => {
    const repeats = note("repeats", "alpha alpha alpha beta beta beta", "");
    expect(findNeighbors([repeats], { title: "alpha beta", body: "", scope: "global" }).map((n) => n.score)).toEqual([1]);
  });

  test("the closest note comes first", () => {
    const older = note("older", "The staging database is shared, never run migrations against it", "Staging is shared by several teams.");
    const found = findNeighbors([deploy, older, shared], { ...draft, title: "Staging database is shared", body: "Do not run migrations there." });
    expect(found.map((n) => n.id).sort()).toEqual(["older", "shared-db"]);
    expect(found[0]!.score).toBeGreaterThanOrEqual(found[1]!.score);
    // The whole of a short note is in the longer one, so the note is as close as it can be.
    expect(found[0]!.score).toBeGreaterThan(0.8);
  });
});

// The numbers that set NEIGHBOR_THRESHOLD: the seeded store, 10 of its notes said again by hand in
// other words, and 10 new facts. A change of the measure or of the seed must keep them.
describe("the neighbor check on the seeded store", () => {
  const dir = join(tempDir(), "seed");
  sh(ROOT, process.execPath, join(ROOT, "scripts", "seed.ts"), dir);
  const notes = new Store(join(dir, "store")).notes();
  const fixture = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "neighbors.json"), "utf8")) as {
    rewrites: { original: string; repo: string | null; title: string; body: string }[];
    unrelated: { repo: string | null; title: string; body: string }[];
    session: { original: string | null; repo: string | null; title: string; body: string }[];
  };
  const scopeOf = (repo: string | null) => (repo === null ? "global" : notes.find((n) => n.scope.split("/").at(-1) === repo)!.scope);
  // What `kb add` holds the write for: a close note of the scope, or a global one.
  const holds = (draft: { repo: string | null; title: string; body: string }) => {
    const scope = scopeOf(draft.repo);
    return findNeighbors(notes, { ...draft, scope }).filter((n) => n.scope === scope || n.scope === "global");
  };

  test("each of 10 notes said again in other words finds its original first", () => {
    expect(fixture.rewrites).toHaveLength(10);
    const found = fixture.rewrites.filter((r) => holds(r)[0]?.id === r.original);
    expect(found.length).toBe(10);
    expect(Math.min(...fixture.rewrites.map((r) => holds(r)[0]!.score))).toBeGreaterThanOrEqual(0.45);
  });

  // An agent writes a longer note than a person, in words further from the stored note. The mean
  // of both directions let this twin through. A plain idf with a heavier title named a short
  // convention as the neighbor of the new fact, for its common words "version", "needs" and "PR".
  test("the twin that a headless checkpoint wrote finds its original, and the new fact of those sessions has no neighbor", () => {
    expect(fixture.session.map((s) => s.original)).toEqual(["preview-links-expire-after-seven-days", null, null]);
    for (const note of fixture.session) expect(holds(note).map((n) => n.id)).toEqual(note.original ? [note.original] : []);
  });

  test("few seeded notes with no twin have a neighbor among the others", () => {
    const twins = new Set(["never-run-the-migration-tool-against-the-shared", "the-staging-database-is-shared-never-run"]);
    const single = notes.filter((n) => !twins.has(n.id) && !/-keeps-(all-)?[a-z]+-state-in-/.test(n.id));
    expect(single).toHaveLength(134);
    const held = single.filter((note) => findNeighbors(notes.filter((n) => n.id !== note.id), note).some((n) => n.scope === note.scope || n.scope === "global"));
    expect(held.length).toBeLessThanOrEqual(6);
  });

  test("none of 10 new facts gets a neighbor", () => {
    expect(fixture.unrelated).toHaveLength(10);
    expect(fixture.unrelated.filter((u) => holds(u).length > 0)).toEqual([]);
  });

  test("the seed's own twins find each other: the two staging notes, and the two state-table notes of each repo", () => {
    const twinOf = (id: string) => {
      const note = notes.find((n) => n.id === id)!;
      return findNeighbors(notes.filter((n) => n.id !== id), note)[0]?.id;
    };
    expect(twinOf("the-staging-database-is-shared-never-run")).toBe("never-run-the-migration-tool-against-the-shared");
    expect(twinOf("ferry-keeps-all-queue-state-in-a-single-table")).toBe("ferry-keeps-queue-state-in-one-table");
  });
});
