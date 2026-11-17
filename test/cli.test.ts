import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "../cli/note.ts";
import { search } from "../cli/search.ts";
import { Store } from "../cli/store.ts";
import { kb, plain, putNote, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

const add = (store: Store | string, note: object, cwd?: string) => kb(store, ["add", "--json"], { stdin: JSON.stringify(note), cwd });

describe("kb add", () => {
  test("creates the store on first run and writes a valid note", () => {
    const home = join(tempDir(), "fresh");
    const result = add(home, { title: "Stripe needs the raw body", kind: "gotcha", body: "Mount express.raw() first.", scope: "global" });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "created", id: "stripe-needs-the-raw-body" });
    const note = parseNote(readFileSync(join(home, "notes/global/stripe-needs-the-raw-body.md"), "utf8"));
    expect(note).toMatchObject({ kind: "gotcha", confidence: "medium", indexed: true, anchors: [], body: "Mount express.raw() first." });
    expect(readFileSync(join(home, "INDEX.md"), "utf8")).toContain("[stripe-needs-the-raw-body](notes/global/stripe-needs-the-raw-body.md) [gotcha]");
  });

  test("dedup: the same normalised title in the same scope writes nothing", () => {
    const store = tempStore();
    const first = add(store, { title: "Amounts are integer cents", kind: "convention", body: "one", scope: "global" });
    const twin = add(store, { title: "  amounts are INTEGER cents! ", kind: "gotcha", body: "two", scope: "global" });
    expect(twin.code).toBe(0);
    expect(twin.json).toMatchObject({ status: "exists", id: first.json.id });
    expect(store.notes()).toHaveLength(1);
    expect(store.notes()[0]!.body).toBe("one");
  });

  test("the same title in another scope is a new note with a unique id", () => {
    const store = tempStore();
    add(store, { title: "Run the tests", kind: "how-to", body: "a", scope: "global" });
    putNote(store, { id: "web-note", scope: "github.com/acme/web" });
    const other = add(store, { title: "Run the tests", kind: "how-to", body: "b", scope: "github.com/acme/web" });
    expect(other.json).toMatchObject({ status: "created", id: "run-the-tests-2" });
    expect(existsSync(join(store.home, "notes/github.com/acme/web/run-the-tests-2.md"))).toBe(true);
  });

  test("a long title gives a short id cut at a word, and titles with one prefix stay apart", () => {
    const store = tempStore();
    const base = "make test hits the live payment sandbox and creates charges";
    const first = add(store, { title: `${base} - use make test-fast`, kind: "gotcha", body: "a", scope: "global" });
    expect(first.json.id).toBe("make-test-hits-the-live-payment-sandbox-and");
    const second = add(store, { title: `${base} on CI too`, kind: "gotcha", body: "b", scope: "global" });
    expect(second.json).toMatchObject({ status: "created", id: "make-test-hits-the-live-payment-sandbox-and-2" });
    expect(add(store, { title: `Make test hits the live payment sandbox and creates charges: use make test-fast`, kind: "gotcha", body: "c", scope: "global" }).json.status).toBe("exists");
  });

  test("with an id it updates, keeps created, and refreshes last_verified", () => {
    const store = tempStore();
    putNote(store, { id: "old-note", title: "Old title", body: "old", kind: "decision" });
    const result = add(store, { id: "old-note", body: "new body", confidence: "high" });
    expect(result.json).toMatchObject({ status: "updated", id: "old-note" });
    const note = store.find("old-note")!;
    expect(note).toMatchObject({ title: "Old title", body: "new body", confidence: "high", kind: "decision", created: "2026-01-01T00:00:00Z" });
    expect(note.last_verified > "2026-01-01T00:00:00Z").toBe(true);
  });

  test("scope defaults to the repo and records HEAD", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "https://github.com/Acme/Billing.git" });
    const result = add(store, { title: "Ledger rows are append-only", kind: "decision", body: "x", anchors: ["src/ledger.ts#append"] }, repo);
    expect(result.json.status).toBe("created");
    const note = store.find(result.json.id)!;
    expect(note.scope).toBe("github.com/acme/billing");
    expect(note.verified_at_commit).toBe(sh(repo, "git", "rev-parse", "--short", "HEAD"));
    expect(note.anchors).toEqual(["src/ledger.ts#append"]);
  });

  test("rejects bad input with every problem named, and writes nothing", () => {
    const store = tempStore();
    const bad = add(store, { title: "T", kind: "idea", body: "", scope: "global", confidence: "sure" });
    expect(bad.code).toBe(1);
    expect(bad.json.error).toContain("kind:");
    expect(bad.json.error).toContain("confidence:");
    expect(bad.json.error).toContain("body:");
    expect(store.notes()).toHaveLength(0);
    expect(add(store, { id: "missing", body: "x" }).code).toBe(1);
    expect(kb(store, ["add"], { stdin: "not json" }).code).toBe(1);
    expect(add(store, { title: "T", kind: "gotcha", body: "x", scope: "../escape" }).code).toBe(1);
  });

  test("commits each write when the store is a git repo", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    add(store, { title: "First", kind: "gotcha", body: "x", scope: "global" });
    kb(store, ["use", "first"]);
    const log = sh(store.home, "git", "log", "--format=%s");
    expect(log.split("\n")).toEqual(["kb: use first", "kb: add first"]);
    // Generated and per-machine files stay out of git.
    const tracked = sh(store.home, "git", "ls-files");
    expect(tracked).toContain("notes/global/first.md");
    expect(tracked).toContain("usage/");
    expect(tracked).not.toContain("INDEX.md");
    expect(tracked).not.toContain("index.html");
    expect(tracked).not.toContain("local.json");
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
  });
});

describe("kb use, archive, show, list", () => {
  test("use sums counters across machines and never edits the note", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const before = readFileSync(store.find("a")!.path, "utf8");
    kb(store, ["use", "a"]);
    kb(store, ["use", "a", "ghost"]);
    Bun.write(join(store.home, "usage", "othermachine.json"), JSON.stringify({ a: { uses: 5, last_used: "2020-01-01T00:00:00Z" } }));
    const shown = kb(store, ["show", "a", "--json"]).json;
    expect(shown.uses).toBe(7);
    expect(shown.last_used > "2026").toBe(true);
    expect(readFileSync(store.find("a")!.path, "utf8")).toBe(before);
    expect(kb(store, ["use", "ghost"]).code).toBe(1);
  });

  test("archive moves the file and restore moves it back", () => {
    const store = tempStore();
    putNote(store, { id: "done", kind: "open-work", scope: "github.com/acme/web" });
    expect(kb(store, ["archive", "done"]).code).toBe(0);
    expect(existsSync(join(store.home, "archive/github.com/acme/web/done.md"))).toBe(true);
    expect(store.notes()).toHaveLength(0);
    expect(kb(store, ["list", "--archive", "--json"]).json[0].id).toBe("done");
    expect(kb(store, ["restore", "done"]).code).toBe(0);
    expect(store.notes().map((n) => n.id)).toEqual(["done"]);
    expect(kb(store, ["archive", "nope"]).code).toBe(1);
  });

  test("delete removes active and archived notes for good, and checks every id first", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    putNote(store, { id: "wrong" });
    putNote(store, { id: "old" }, true);
    putNote(store, { id: "keep" });
    kb(store, ["use", "wrong"]);
    // One unknown id stops the whole command, so nothing is half done.
    expect(kb(store, ["delete", "wrong", "ghost"]).code).toBe(1);
    expect(store.find("wrong")).toBeDefined();
    expect(kb(store, ["delete", "wrong", "old", "--json"]).json).toEqual({ deleted: ["wrong", "old"] });
    expect([...store.notes(), ...store.notes({ archived: true })].map((n) => n.id)).toEqual(["keep"]);
    expect(store.usage().has("wrong")).toBe(false);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("kb: delete wrong old");
  });

  test("kb list --archive lists the most recently archived note first", () => {
    const store = tempStore();
    putNote(store, { id: "older", archived_at: "2026-05-01T00:00:00Z" }, true);
    putNote(store, { id: "untimed", last_verified: "2026-02-01T00:00:00Z" }, true);
    putNote(store, { id: "fresh" });
    expect(kb(store, ["archive", "fresh"]).code).toBe(0);
    expect(kb(store, ["list", "--archive", "--json"]).json.map((n: { id: string }) => n.id)).toEqual(["fresh", "older", "untimed"]);
  });

  test("every command gives JSON with --json, also on an error", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    for (const args of [["context"], ["scope"], ["show", "a"], ["search", "body"], ["list"], ["use", "a"], ["archive", "a"], ["restore", "a"], ["html"], ["sync"], ["stale"], ["verify", "a"], ["budget"], ["promote", "a", "--to", "CLAUDE.md"], ["checkpointed", "s"], ["show", "zzz"], ["bogus"]]) {
      const result = kb(store, [...args, "--json"]);
      expect(result.json, args.join(" ")).toBeDefined();
    }
  });
});

// A note in a scope that no repo resolves to never loads in a session, and nothing says so.
describe("a scope that does not exist", () => {
  test("kb add refuses a scope without notes, and names the scopes that exist", () => {
    const store = tempStore();
    putNote(store, { id: "web-note", scope: "github.com/acme/web" });
    const typo = add(store, { title: "Never force push", kind: "gotcha", body: "x", scope: "glbal" });
    expect(typo.code).toBe(1);
    expect(typo.json.error).toContain('no notes have the scope "glbal". Scopes: global, github.com/acme/web.');
    expect(typo.json.error).toContain("--repo");
    expect(add(store, { title: "Never force push", kind: "gotcha", body: "x", scope: "web" }).code).toBe(1);
    expect(store.notes()).toHaveLength(1);
    // The first note of a repo is written from inside that repo.
    const repo = tempRepo({ remote: "git@github.com:acme/fresh.git" });
    const first = kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ title: "First", kind: "gotcha", body: "x", scope: "github.com/acme/fresh" }) });
    expect(first.json.status).toBe("created");
  });

  test("search and list take --scope repo, and refuse an unknown scope instead of an empty answer", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "web-cents", scope: "github.com/acme/web", title: "Amounts are integer cents" });
    putNote(store, { id: "global-cents", title: "Print cents with two digits" });

    const found = kb(store, ["search", "cents", "--scope", "repo"], { cwd: repo }).stdout;
    expect(found).toStartWith("web-cents | github.com/acme/web | Amounts are integer cents");
    expect(found).not.toContain("global-cents");
    expect(kb(store, ["list", "--scope", "repo", "--json"], { cwd: repo }).json.map((n: any) => n.id)).toEqual(["web-cents"]);
    for (const command of [["search", "cents"], ["list"]]) {
      const unknown = kb(store, [...command, "--scope", "web"]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('no notes have the scope "web". Scopes: global, github.com/acme/web.');
      expect(kb(store, [...command, "--scope", "repo"]).code).toBe(1); // not in a repo
    }
  });
});

describe("kb show", () => {
  test("a part of an id opens the note when one note has it, and lists the ids when several have it", () => {
    const store = tempStore();
    putNote(store, { id: "atlas-amounts-are-integer-cents", title: "Atlas amounts" });
    putNote(store, { id: "ferry-amounts-are-integer-cents", title: "Ferry amounts" });
    expect(kb(store, ["show", "atlas-amounts", "--json"]).json.id).toBe("atlas-amounts-are-integer-cents");
    const several = kb(store, ["show", "amounts"]);
    expect(several.code).toBe(1);
    expect(several.stderr).toContain("atlas-amounts-are-integer-cents, ferry-amounts-are-integer-cents");
    // A command that changes a note never guesses.
    expect(kb(store, ["archive", "atlas-amounts"]).code).toBe(1);
    expect(store.notes()).toHaveLength(2);
  });
});

describe("kb search", () => {
  // Several repos hold the same fact. The caller needs the note of this repo, and one line per note.
  test("prints one line per note with its scope, this repo first, then the body lines that matched", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { id: "api-cents", scope: "github.com/acme/api", title: "Amounts are integer cents", body: "No cents as floats." });
    putNote(store, { id: "global-cents", title: "Print cents with two digits", body: "cents 1\ncents 2\ncents 3\ncents 4\ncents 5" });
    putNote(store, { id: "web-cents", scope: "github.com/acme/web", title: "Amounts are integer cents", body: "Convert at the edge." });
    expect(kb(store, ["search", "cents"], { cwd: repo }).stdout.trimEnd().split("\n")).toEqual([
      "web-cents | github.com/acme/web | Amounts are integer cents",
      "global-cents | global | Print cents with two digits",
      "  12: cents 1",
      "  13: cents 2",
      "  14: cents 3",
      "  ...",
      "api-cents | github.com/acme/api | Amounts are integer cents",
      "  12: No cents as floats.",
    ]);
  });


  test("finds a line in the title or the body, once, and honors scope and archive", () => {
    const store = tempStore();
    putNote(store, { id: "raw-body", title: "Stripe needs the raw body", body: "Mount express.raw() first.\nThe JSON parser breaks the Signature." });
    putNote(store, { id: "other", scope: "github.com/acme/web", body: "Nothing here." });
    putNote(store, { id: "old", body: "signature rotation, archived" }, true);

    const hits = search(store, "signature");
    expect(hits).toEqual([{ id: "raw-body", title: "Stripe needs the raw body", scope: "global", archived: false, line: 13, text: "The JSON parser breaks the Signature." }]);
    expect(search(store, "signature", { archive: true }).map((h) => h.id)).toEqual(["raw-body", "old"]);
    expect(search(store, "nothing", { scope: "global" })).toEqual([]);
    // A title match counts once. The id line does not double it.
    expect(search(store, "raw").map((h) => h.line)).toEqual([3, 12]);
  });

  // The checkpoint skill searches with two or three key words before it writes. A phrase match
  // answered "no match" for words that are not adjacent, and the agent then saved a duplicate.
  test("key words match in any order and on different lines", () => {
    const store = tempStore();
    putNote(store, { id: "shared-db", title: "Never run the migration tool against the shared staging database", body: "Run it on a local copy only." });
    putNote(store, { id: "deploy", title: "The deploy CLI exits 0 when the upload was rejected", body: "Check the staging log." });
    putNote(store, { id: "unrelated", body: "Nothing about it." });

    expect([...new Set(search(store, "staging migration").map((h) => h.id))]).toEqual(["shared-db"]);
    expect([...new Set(search(store, "local MIGRATION").map((h) => h.id))]).toEqual(["shared-db"]);

    const cli = (...words: string[]) => kb(store, ["search", ...words]).stdout.trim();
    expect(cli("staging", "migration")).toStartWith("shared-db | ");
    // No note has every word: the closest notes are better than "no match".
    const closest = cli("staging", "migration", "rollback");
    expect(closest.split("\n")[0]).toBe("no note has every word. Closest:");
    expect(closest).toContain("shared-db | ");
    expect(closest).not.toContain("deploy | ");
    expect(cli("zebra", "quartz")).toBe("no match");
  });
});
