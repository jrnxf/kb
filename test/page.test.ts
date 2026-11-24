import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageData, renderBody, safeHref, storeVersion } from "../cli/page.ts";
import { DIST } from "../cli/serve.ts";
import type { PageNote } from "../cli/wire.ts";
import { sourceHash } from "../web/source-hash.ts";
import { EMPTY_VIEW, clearsIn, day, fromHash, neighbour, scopeHref, scopeName, show, toHash } from "../web/src/lib/view.ts";
import { logAt, otherMachine, putNote, tempStore } from "./helpers.ts";

describe("the data behind the page", () => {
  test("shows raw HTML in a note as text, and renders the markdown", () => {
    const store = tempStore();
    putNote(store, { id: "xss", title: "A <b>bold</b> title", body: "Use `x`.\n\n<script>alert(1)</script> and <img src=x onerror=alert(1)>" });
    const [note] = pageData(store).notes;
    expect(note!.html).toContain("<code>x</code>");
    expect(note!.html).not.toContain("<script");
    expect(note!.html).not.toContain("<img");
    // React inserts the title as text, so it stays as written.
    expect(note!.title).toBe("A <b>bold</b> title");
  });

  test("shows a link that could run script as its text, in every spelling", () => {
    const links = [
      "[a](javascript:alert(1))",
      "[b](JaVaScRiPt:alert(1))",
      "[c](&#106;avascript:alert(1))",
      "[d](&#x6A;avascript&colon;alert(1))",
      "[e](<java\tscript:alert(1)>)",
      "[f](java&#x0A;script:alert(1))",
      "[g](data:text/html,<script>alert(1)</script>)",
      "[h](vbscript:msgbox(1))",
      "[i]( javascript:alert(1))",
      "[j](javascript&colon;alert(1))",
    ];
    for (const link of links) {
      const html = renderBody(link);
      expect(html).not.toContain("<a");
      expect(html).not.toContain("href");
      expect(html).toMatch(/<span>[a-j]<\/span>/);
    }
    expect(safeHref("&#0;javascript:alert(1)")).toBe(false);
    expect(safeHref("\u0001javascript:alert(1)")).toBe(false);
  });

  test("keeps a web, mail or page link", () => {
    expect(renderBody("[web](https://example.com/a?b=1&c=2 \"t\")")).toContain('<a href="https://example.com/a?b=1&amp;c=2" title="t">web</a>');
    expect(renderBody("[plain](http://example.com)")).toContain('<a href="http://example.com">plain</a>');
    expect(renderBody("[mail](mailto:user@example.com)")).toContain('<a href="mailto:user@example.com">mail</a>');
    expect(renderBody("[note](#note=a)")).toContain('<a href="#note=a">note</a>');
    expect(renderBody("[path](/docs/a.md)")).toContain('<a href="/docs/a.md">path</a>');
    expect(renderBody("[FAQ](Q&A.md)")).toContain('<a href="Q&amp;A.md">FAQ</a>');
    expect(renderBody("[file](docs/a.md?x=1)")).toContain('<a href="docs/a.md?x=1">file</a>');
  });

  test("loads only an image of this server or one held in the note, and shows any other as its alt text", () => {
    expect(renderBody("![a <b> & c](https://tracker.example.com/p.png)")).toBe("<p>a &lt;b&gt; &amp; c</p>\n");
    expect(renderBody("![x](//tracker.example.com/p.png)")).toBe("<p>x</p>\n");
    expect(renderBody("![](https://tracker.example.com/p.png)")).toBe("<p>[image: tracker.example.com]</p>\n");
    expect(renderBody("![](//tracker.example.com/p.png)")).toBe("<p>[image: tracker.example.com]</p>\n");
    expect(renderBody("![ ](https://tracker.example.com/p.png)")).toBe("<p>[image: tracker.example.com]</p>\n");
    expect(renderBody("![&#0;](https://tracker.example.com/p.png)")).toBe("<p>[image: tracker.example.com]</p>\n");
    expect(renderBody("![](http:p.png)")).toBe("<p>[image: blocked]</p>\n");
    expect(renderBody("![](javascript:alert(1))")).toBe("<p>[image: blocked]</p>\n");
    expect(renderBody("![x](javascript:alert(1))")).toBe("<p>x</p>\n");
    expect(renderBody("![x](data:image/svg+xml,%3Csvg%20onload=alert(1)%3E)")).toBe("<p>x</p>\n");
    expect(renderBody("![dot](data:image/png;base64,iVBORw0KGgo=)")).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot" />');
    expect(renderBody("![local](/assets/a.png)")).toContain('<img src="/assets/a.png" alt="local" />');
  });

  test("puts global first, then the scopes in order, then the trash with the most recently trashed first", () => {
    const store = tempStore();
    putNote(store, { id: "z", scope: "github.com/acme/zed" });
    putNote(store, { id: "before", scope: "github.com/acme/api", last_verified: "2026-03-01T00:00:00Z" }, true);
    putNote(store, { id: "older", scope: "github.com/acme/api", trashed_at: "2026-05-01T00:00:00Z" }, true);
    putNote(store, { id: "newer", scope: "github.com/acme/zed", trashed_at: "2026-06-01T00:00:00Z" }, true);
    putNote(store, { id: "a", scope: "github.com/acme/api" });
    putNote(store, { id: "g" });
    const data = pageData(store);
    expect(data.notes.map((n) => [n.id, n.trashed])).toEqual([["g", false], ["a", false], ["z", false], ["newer", true], ["older", true], ["before", true]]);
    // Each note in the trash says when the trash deletes it.
    expect(data.notes.find((n) => n.id === "newer")!.clears_at).toBe("2026-07-01T00:00:00Z");
    expect(data.trashDays).toBe(30);
    expect(data.kinds).toEqual(["open-work", "gotcha", "convention", "decision", "how-to"]);
  });

  test("the version changes when activity changes the order of the notes, so the page loads the new order", () => {
    const store = tempStore();
    const scope = "github.com/acme/api";
    putNote(store, { id: "a", scope });
    putNote(store, { id: "b", scope });
    const order = () => pageData(store).notes.map((n) => n.id);
    const first = storeVersion(store);
    expect(order()).toEqual(["a", "b"]);
    expect(pageData(store).version).toBe(first);
    // No note changed. A read of "b" on this machine puts it first.
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "b", why: "task" });
    expect(order()).toEqual(["b", "a"]);
    const second = storeVersion(store);
    expect(second).not.toBe(first);
    // A read that leaves the order as it is leaves the version too, so the page does not load again.
    logAt(store, "2026-03-02T00:00:00Z", { ev: "show", note: "b", why: "task" });
    expect(storeVersion(store)).toBe(second);
    // Activity that a sync brings from another machine counts in the same way.
    otherMachine(store, "machine-b", { a: { last: "2026-03-05T00:00:00Z" } });
    expect(order()).toEqual(["a", "b"]);
    expect(storeVersion(store)).not.toBe(second);
  });

  test("one request for the page reads the last activity once, and its version is the version of the store", () => {
    const store = tempStore();
    putNote(store, { id: "a", scope: "github.com/acme/api" });
    putNote(store, { id: "g" });
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "a", why: "task" });
    // Each read of the last activity reads the counters of an older kb once.
    let reads = 0;
    const usage = store.usage.bind(store);
    store.usage = () => (reads++, usage());
    const data = pageData(store);
    expect(reads).toBe(1);
    expect(data.version).toBe(storeVersion(store));
    expect(reads).toBe(2);
    // The version is of the order it gets: another order is another version.
    expect(data.notes.map((n) => n.id)).toEqual(["g", "a"]);
    expect(storeVersion(store, store.notes().sort((x, y) => x.id.localeCompare(y.id)))).not.toBe(data.version);
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
    last_verified: "2026-01-01T00:00:00Z", anchors: [], triggers: [], body: "body", html: "", ...fields,
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
