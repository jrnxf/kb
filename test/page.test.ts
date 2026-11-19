import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageData } from "../cli/page.ts";
import { DIST } from "../cli/serve.ts";
import type { PageNote } from "../cli/wire.ts";
import { sourceHash } from "../web/source-hash.ts";
import { EMPTY_VIEW, clearsIn, day, fromHash, neighbour, scopeHref, scopeName, show, toHash } from "../web/src/lib/view.ts";
import { putNote, tempStore } from "./helpers.ts";

describe("the data behind the page", () => {
  test("shows raw HTML in a note as text, and renders the markdown", () => {
    const store = tempStore();
    putNote(store, { id: "xss", title: "A <b>bold</b> title", body: "Use `x`.\n\n<script>alert(1)</script> and <img src=x onerror=alert(1)>" });
    const [note] = pageData(store, "t").notes;
    expect(note!.html).toContain("<code>x</code>");
    expect(note!.html).not.toContain("<script");
    expect(note!.html).not.toContain("<img");
    // React inserts the title as text, so it stays as written.
    expect(note!.title).toBe("A <b>bold</b> title");
  });

  test("puts global first, then the scopes in order, then the trash with the most recently trashed first", () => {
    const store = tempStore();
    putNote(store, { id: "z", scope: "github.com/acme/zed" });
    putNote(store, { id: "before", scope: "github.com/acme/api", last_verified: "2026-03-01T00:00:00Z" }, true);
    putNote(store, { id: "older", scope: "github.com/acme/api", trashed_at: "2026-05-01T00:00:00Z" }, true);
    putNote(store, { id: "newer", scope: "github.com/acme/zed", trashed_at: "2026-06-01T00:00:00Z" }, true);
    putNote(store, { id: "a", scope: "github.com/acme/api" });
    putNote(store, { id: "g" });
    const data = pageData(store, "the-token");
    expect(data.notes.map((n) => [n.id, n.trashed])).toEqual([["g", false], ["a", false], ["z", false], ["newer", true], ["older", true], ["before", true]]);
    // Each note in the trash says when the trash deletes it.
    expect(data.notes.find((n) => n.id === "newer")!.clears_at).toBe("2026-07-01T00:00:00Z");
    expect(data.trashDays).toBe(30);
    expect(data.token).toBe("the-token");
    expect(data.kinds).toEqual(["open-work", "gotcha", "convention", "decision", "how-to"]);
  });
});

test("the built page is up to date with its sources: run `bun run build` in web/ when this fails", () => {
  expect(readFileSync(join(DIST, ".source-hash"), "utf8").trim()).toBe(sourceHash());
});

test("git tracks every file the built page loads: `git add web/dist` when this fails", () => {
  const html = readFileSync(join(DIST, "index.html"), "utf8");
  const loaded = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => `web/dist/${m[1]}`);
  expect(loaded.length).toBeGreaterThan(0);
  const tracked = Bun.spawnSync(["git", "ls-files", "web/dist"], { cwd: join(DIST, "..", "..") }).stdout.toString().split("\n");
  expect(loaded.filter((file) => !tracked.includes(file))).toEqual([]);
});

describe("what the page shows", () => {
  const note = (id: string, fields: Partial<PageNote> = {}): PageNote => ({
    id, title: `Title of ${id}`, scope: "global", kind: "gotcha", confidence: "high", trashed: false,
    last_verified: "2026-01-01T00:00:00Z", anchors: [], body: "body", html: "", ...fields,
  });
  const notes = [
    note("a", { kind: "decision", body: "the cache key" }),
    note("b", { scope: "github.com/acme/web" }),
    note("c", { scope: "github.com/acme/web", kind: "decision" }),
    note("old", { trashed: true }),
  ];

  test("filters by scope, by kinds that add up, and by every word of the search", () => {
    expect(show(notes, EMPTY_VIEW).notes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(show(notes, { ...EMPTY_VIEW, scope: "github.com/acme/web" }).notes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(show(notes, { ...EMPTY_VIEW, kinds: ["decision"] }).notes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(show(notes, { ...EMPTY_VIEW, kinds: ["decision", "gotcha"] }).notes).toHaveLength(3);
    expect(show(notes, { ...EMPTY_VIEW, q: "KEY cache" }).notes.map((n) => n.id)).toEqual(["a"]);
  });

  test("counts each scope with the kinds applied, and each kind with the scope applied", () => {
    const shown = show(notes, { ...EMPTY_VIEW, scope: "github.com/acme/web", kinds: ["decision"] });
    expect(shown.byScope.get("*")).toBe(2);
    expect(shown.byScope.get("global")).toBe(1);
    expect(shown.byKind.get("gotcha")).toBe(1);
    expect(shown.trashCount).toBe(1);
  });

  test("the trash view shows only notes in the trash, and is off once the trash is empty", () => {
    expect(show(notes, { ...EMPTY_VIEW, trash: true }).notes.map((n) => n.id)).toEqual(["old"]);
    const live = notes.filter((n) => !n.trashed);
    expect(show(live, { ...EMPTY_VIEW, trash: true })).toMatchObject({ trash: false, notes: live });
  });

  test("a note in the trash says in how many days it is deleted", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(clearsIn("2026-12-17T12:00:00Z", now)).toBe("in 30 days");
    expect(clearsIn("2026-11-18T06:00:00Z", now)).toBe("in 1 day");
    expect(clearsIn("2026-11-17T11:00:00Z", now)).toBe("today");
  });

  test("the open note is the one asked for while it is in the list, else the first", () => {
    expect(show(notes, { ...EMPTY_VIEW, note: "c" }).current?.id).toBe("c");
    expect(show(notes, { ...EMPTY_VIEW, note: "c", kinds: ["gotcha"] }).current?.id).toBe("b");
  });

  test("a note that leaves the list hands over to the next one, or the one before at the end", () => {
    expect(neighbour(notes, "a")).toBe("b");
    expect(neighbour(notes, "old")).toBe("c");
    expect(neighbour([notes[0]!], "a")).toBeNull();
  });

  test("the address keeps the whole view", () => {
    const view = { scope: "github.com/acme/web", kinds: ["gotcha", "how-to"], trash: true, q: "a b&c", note: "x", pane: "rail" as const, read: true };
    expect(fromHash(toHash(view))).toEqual(view);
    expect(toHash(EMPTY_VIEW)).toBe("#");
    expect(fromHash("")).toEqual(EMPTY_VIEW);
  });

  test("a date is day and month, with the year only when it is another year", () => {
    const now = new Date(2026, 10, 16);
    expect(day(new Date(2026, 8, 7, 12).toISOString(), now)).toBe("7 Sep");
    expect(day(new Date(2025, 11, 31, 12).toISOString(), now)).toBe("31 Dec 2025");
  });

  test("a repo scope shows as owner/name on GitHub and links to the repo", () => {
    expect([scopeName("github.com/acme/web"), scopeHref("github.com/acme/web")]).toEqual(["acme/web", "https://github.com/acme/web"]);
    expect([scopeName("gitlab.com/acme/api"), scopeHref("gitlab.com/acme/api")]).toEqual(["gitlab.com/acme/api", "https://gitlab.com/acme/api"]);
    expect(scopeHref("local-project")).toBeUndefined();
    expect(scopeHref("global")).toBeUndefined();
  });
});
