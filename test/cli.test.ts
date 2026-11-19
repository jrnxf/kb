import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote } from "../cli/note.ts";
import { search } from "../cli/search.ts";
import { Store } from "../cli/store.ts";
import { daysAgo, kb, putNote, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

const add = (store: Store | string, note: object, cwd?: string) => kb(store, ["add", "--json"], { stdin: JSON.stringify(note), cwd });

describe("KB_HOME", () => {
  test("a relative KB_HOME is the folder under the directory kb runs in", () => {
    const dir = tempDir();
    expect(add("./kb", { title: "A note", kind: "gotcha", body: "b", scope: "global" }, dir).code).toBe(0);
    expect(existsSync(join(dir, "kb/notes/global/a-note.md"))).toBe(true);
  });
});

describe("kb instructions", () => {
  test("names the file at the end of the links, and says which link points there only when one does", () => {
    const store = tempStore();
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "# Rules\n");
    sh(dir, "ln", "-s", "AGENTS.md", "CLAUDE.md");
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ globalInstructions: join(dir, "CLAUDE.md") }));
    expect(kb(store, ["instructions"]).stdout).toContain(`AGENTS.md (${join(dir, "CLAUDE.md")} links here)`);
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ globalInstructions: join(dir, "AGENTS.md") }));
    expect(kb(store, ["instructions"]).stdout).not.toContain("links here");
  });
});

describe("kb add", () => {
  test("creates the store on first run and writes a valid note", () => {
    const home = join(tempDir(), "fresh");
    const result = add(home, { title: "Stripe needs the raw body", kind: "gotcha", body: "Mount express.raw() first.", scope: "global" });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "created", id: "stripe-needs-the-raw-body" });
    const note = parseNote(readFileSync(join(home, "notes/global/stripe-needs-the-raw-body.md"), "utf8"));
    expect(note).toMatchObject({ kind: "gotcha", confidence: "medium", anchors: [], body: "Mount express.raw() first." });
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

  // /kb:recover writes a note from an old conversation. It is verified when that session ended, not today.
  describe("--as-of", () => {
    const repoWithHistory = () => {
      const repo = tempRepo({ remote: "https://github.com/acme/billing.git" });
      const commit = (date: string) => {
        sh(repo, "env", `GIT_AUTHOR_DATE=${date}`, `GIT_COMMITTER_DATE=${date}`, "git", "commit", "-q", "--allow-empty", "-m", `at ${date}`);
        return sh(repo, "git", "rev-parse", "--short", "HEAD");
      };
      // tempRepo made one commit now. The dated ones come before it in time, as in a real history.
      sh(repo, "git", "checkout", "-q", "--orphan", "past");
      const february = commit("2020-02-01T10:00:00Z");
      const march = commit("2020-03-01T10:00:00Z");
      return { repo, february, march };
    };
    const asOf = (store: Store, time: string, note: object, cwd?: string) => kb(store, ["add", "--json", "--as-of", time], { stdin: JSON.stringify(note), cwd });
    const SCOPE = "github.com/acme/billing";

    test("a new note is created now, and verified at that time and at the commit of that time", () => {
      const store = tempStore();
      const { repo, february } = repoWithHistory();
      const result = asOf(store, "2020-02-15T12:00:00.500Z", { title: "Ledger rows are append-only", kind: "decision", body: "x" }, repo);
      expect(result.json.status).toBe("created");
      const note = store.find(result.json.id)!;
      expect(note).toMatchObject({ scope: SCOPE, last_verified: "2020-02-15T12:00:00Z", verified_at_commit: february });
      expect(note.created > "2026").toBe(true);
    });

    test("no commit is recorded when the repo has none that old, and for a global note", () => {
      const store = tempStore();
      const { repo } = repoWithHistory();
      const early = store.find(asOf(store, "2020-01-01T00:00:00Z", { title: "Before the first commit", kind: "gotcha", body: "x" }, repo).json.id)!;
      expect(early.last_verified).toBe("2020-01-01T00:00:00Z");
      expect(early.verified_at_commit).toBeUndefined();
      const global = store.find(asOf(store, "2020-02-15T12:00:00Z", { title: "A tool fact", kind: "gotcha", body: "x", scope: "global" }, repo).json.id)!;
      expect(global.last_verified).toBe("2020-02-15T12:00:00Z");
      expect(global.verified_at_commit).toBeUndefined();
    });

    test("an update moves an older note to that time, and leaves a note that was verified later", () => {
      const store = tempStore();
      const { repo, february, march } = repoWithHistory();
      putNote(store, { id: "older", scope: SCOPE, last_verified: "2020-01-10T00:00:00Z" });
      putNote(store, { id: "later", scope: SCOPE, last_verified: "2020-03-10T00:00:00Z", verified_at_commit: march });
      for (const id of ["older", "later"]) expect(asOf(store, "2020-02-15T12:00:00Z", { id, body: "from the old session" }, repo).json.status).toBe("updated");
      expect(store.find("older")).toMatchObject({ body: "from the old session", last_verified: "2020-02-15T12:00:00Z", verified_at_commit: february });
      // The old conversation knows less than the check that came after it.
      expect(store.find("later")).toMatchObject({ body: "from the old session", last_verified: "2020-03-10T00:00:00Z", verified_at_commit: march });
    });

    test("a time after now is now, and a value that is no time is refused", () => {
      const store = tempStore();
      const note = store.find(asOf(store, "2999-01-01T00:00:00Z", { title: "From the future", kind: "gotcha", body: "x", scope: "global" }).json.id)!;
      expect(note.last_verified).toBe(note.created);
      for (const bad of ["yesterday-ish", ""]) {
        const result = asOf(store, bad, { title: "Never written", kind: "gotcha", body: "x", scope: "global" });
        expect(result.code).toBe(1);
        expect(result.json.error).toContain("--as-of needs an ISO time");
      }
      expect(kb(store, ["add", "--as-of"], { stdin: "{}" })).toMatchObject({ code: 1, stderr: "--as-of needs a value\n" });
      expect(store.notes().map((n) => n.id)).toEqual([note.id]);
    });
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

describe("kb use, trash, show, list", () => {
  test("use sums counters across machines and never edits the note", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const before = readFileSync(store.find("a")!.path, "utf8");
    kb(store, ["use", "a"]);
    kb(store, ["use", "a", "ghost"]);
    Bun.write(join(store.home, "usage", "othermachine.json"), JSON.stringify({ a: { uses: 5, last_used: "2020-01-01T00:00:00Z" } }));
    const shown = kb(store, ["show", "a", "--no-use", "--json"]).json;
    expect(shown.uses).toBe(7);
    expect(shown.last_used > "2026").toBe(true);
    expect(readFileSync(store.find("a")!.path, "utf8")).toBe(before);
    expect(kb(store, ["use", "ghost"]).code).toBe(1);
  });

  test("show counts a use, since an agent reads a note when it needs it, and --no-use only looks", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    expect(kb(store, ["show", "a", "--json"]).json.uses).toBe(1);
    expect(kb(store, ["show", "a", "--json"]).json.uses).toBe(2);
    expect(kb(store, ["show", "a", "--no-use", "--json"]).json.uses).toBe(2);
    putNote(store, { id: "gone" }, true);
    kb(store, ["show", "gone"]);
    expect(store.usage().get("gone")).toBeUndefined();
  });

  test("trash moves the file and restore moves it back", () => {
    const store = tempStore();
    putNote(store, { id: "done", kind: "open-work", scope: "github.com/acme/web" });
    expect(kb(store, ["trash", "done"]).code).toBe(0);
    expect(existsSync(join(store.home, "trash/github.com/acme/web/done.md"))).toBe(true);
    expect(store.notes()).toHaveLength(0);
    const [listed] = kb(store, ["list", "--trash", "--json"]).json;
    expect(listed.id).toBe("done");
    expect(Date.parse(listed.clears_at) - Date.parse(listed.trashed_at)).toBe(30 * 86_400_000);
    expect(kb(store, ["restore", "done"]).code).toBe(0);
    expect(store.notes().map((n) => n.id)).toEqual(["done"]);
    expect(store.find("done")!.trashed_at).toBeUndefined();
    expect(kb(store, ["trash", "nope"]).code).toBe(1);
  });

  test("a note in the trash for more than trashDays is deleted before the next command", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    putNote(store, { id: "expired", trashed_at: daysAgo(31) }, true);
    putNote(store, { id: "recent", trashed_at: daysAgo(29) }, true);
    putNote(store, { id: "live" });
    kb(store, ["use", "expired"]);
    expect(kb(store, ["list", "--trash", "--json"]).json.map((n: { id: string }) => n.id)).toEqual(["recent"]);
    expect(store.find("expired")).toBeUndefined();
    expect(store.usage().has("expired")).toBe(false);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("kb: clear 1 from the trash after 30 days: expired");
    // trashDays in the config sets the time.
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ trashDays: 7 }));
    expect(kb(store, ["list", "--trash", "--json"]).json).toEqual([]);
    expect(store.find("live")).toBeDefined();
  });

  test("a wrong trashDays falls back to 30 days, so it never empties the trash or stops a command", () => {
    for (const trashDays of ["thirty", null, 0, -5]) {
      const store = tempStore();
      writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ trashDays }));
      putNote(store, { id: "recent", trashed_at: daysAgo(2) }, true);
      expect(kb(store, ["list", "--trash", "--json"]).json.map((n: { id: string }) => n.id)).toEqual(["recent"]);
    }
  });

  test("empty-trash deletes every note in the trash, and nothing else", () => {
    const store = tempStore();
    putNote(store, { id: "a", trashed_at: daysAgo(1) }, true);
    putNote(store, { id: "b", trashed_at: daysAgo(2) }, true);
    putNote(store, { id: "live" });
    expect(kb(store, ["empty-trash", "--json"]).json.deleted.sort()).toEqual(["a", "b"]);
    expect(store.notes({ trashed: true })).toEqual([]);
    expect(store.notes().map((n) => n.id)).toEqual(["live"]);
    expect(kb(store, ["empty-trash"]).stdout.trim()).toBe("the trash is empty");
  });

  test("delete removes active and trashed notes for good, and checks every id first", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    putNote(store, { id: "wrong" });
    putNote(store, { id: "old", trashed_at: daysAgo(1) }, true);
    putNote(store, { id: "keep" });
    kb(store, ["use", "wrong"]);
    // One unknown id stops the whole command, so nothing is half done.
    expect(kb(store, ["delete", "wrong", "ghost"]).code).toBe(1);
    expect(store.find("wrong")).toBeDefined();
    expect(kb(store, ["delete", "wrong", "old", "--json"]).json).toEqual({ deleted: ["wrong", "old"] });
    expect([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.id)).toEqual(["keep"]);
    expect(store.usage().has("wrong")).toBe(false);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("kb: delete wrong old");
    // Another machine still counts uses of "wrong", so a new note with that title must not inherit them.
    writeFileSync(join(store.home, "usage", "othermachine.json"), JSON.stringify({ wrong: { uses: 9 } }));
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Wrong", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("wrong-2");
  });

  test("trash --scope moves a whole project in one commit, and restore --scope brings back only that move", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    const web = "github.com/acme/web";
    putNote(store, { id: "a", scope: web });
    putNote(store, { id: "b", scope: web });
    putNote(store, { id: "done-before", scope: web, trashed_at: daysAgo(3) }, true);
    putNote(store, { id: "other", scope: "github.com/acme/api" });
    putNote(store, { id: "g" });
    expect(kb(store, ["trash", "--scope", web, "--json"]).json).toEqual({ scope: web, trashed: ["a", "b"] });
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe(`kb: trash the project ${web} (2)`);
    expect(store.notes().map((n) => n.id).sort()).toEqual(["g", "other"]);
    // A second trash has nothing to move.
    expect(kb(store, ["trash", "--scope", web]).code).toBe(1);
    // The note that was in the trash before stays there.
    expect(kb(store, ["restore", "--scope", web, "--json"]).json).toEqual({ scope: web, restored: ["a", "b"] });
    expect(store.find("done-before")!.trashed).toBe(true);
  });

  test("delete --scope removes a project for good, active and in the trash, and nothing else", () => {
    const store = tempStore();
    const web = "github.com/acme/web";
    putNote(store, { id: "a", scope: web });
    putNote(store, { id: "old", scope: web, trashed_at: daysAgo(1) }, true);
    putNote(store, { id: "other", scope: "github.com/acme/api" });
    kb(store, ["use", "a"]);
    expect(kb(store, ["delete", "--scope", web, "--json"]).json).toEqual({ scope: web, deleted: ["a", "old"] });
    expect([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.id)).toEqual(["other"]);
    expect(store.usage().has("a")).toBe(false);
  });

  test("empty-trash --scope clears only the trash of that project", () => {
    const store = tempStore();
    putNote(store, { id: "a", scope: "github.com/acme/web", trashed_at: daysAgo(1) }, true);
    putNote(store, { id: "b", scope: "github.com/acme/api", trashed_at: daysAgo(1) }, true);
    expect(kb(store, ["empty-trash", "--scope", "github.com/acme/web", "--json"]).json).toEqual({ deleted: ["a"] });
    expect(store.notes({ trashed: true }).map((n) => n.id)).toEqual(["b"]);
    expect(kb(store, ["empty-trash", "--scope", "github.com/acme/web"]).code).toBe(1);
  });

  test("a project command refuses global, an unknown scope and note ids, and changes nothing", () => {
    const store = tempStore();
    putNote(store, { id: "g" });
    putNote(store, { id: "a", scope: "github.com/acme/web" });
    for (const args of [["trash", "--scope", "global"], ["delete", "--scope", "global"], ["delete", "--scope", "github.com/acme/nope"], ["delete", "--scope", "repo"], ["trash", "a", "--scope", "github.com/acme/web"]]) {
      const r = kb(store, args);
      expect(r.code).toBe(1);
    }
    expect(kb(store, ["delete", "--scope", "global"]).stderr).toContain("not a project");
    expect(store.notes().map((n) => n.id).sort()).toEqual(["a", "g"]);
  });

  test("kb list --trash lists the most recently trashed note first", () => {
    const store = tempStore();
    putNote(store, { id: "oldest", trashed_at: daysAgo(20) }, true);
    putNote(store, { id: "older", trashed_at: daysAgo(10) }, true);
    putNote(store, { id: "fresh" });
    expect(kb(store, ["trash", "fresh"]).code).toBe(0);
    expect(kb(store, ["list", "--trash", "--json"]).json.map((n: { id: string }) => n.id)).toEqual(["fresh", "older", "oldest"]);
  });

  test("every command gives JSON with --json, also on an error", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    for (const args of [["context"], ["scope"], ["show", "a"], ["search", "body"], ["list"], ["use", "a"], ["trash", "a"], ["restore", "a"], ["empty-trash"], ["html"], ["sync"], ["stale"], ["verify", "a"], ["budget"], ["checkpointed", "s"], ["unsaved"], ["unsaved", "--forget", "s"], ["show", "zzz"], ["bogus"]]) {
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
    expect(kb(store, ["trash", "atlas-amounts"]).code).toBe(1);
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
      "  11: cents 1",
      "  12: cents 2",
      "  13: cents 3",
      "  ...",
      "api-cents | github.com/acme/api | Amounts are integer cents",
      "  11: No cents as floats.",
    ]);
  });


  test("finds a line in the title or the body, once, and honors scope and the trash", () => {
    const store = tempStore();
    putNote(store, { id: "raw-body", title: "Stripe needs the raw body", body: "Mount express.raw() first.\nThe JSON parser breaks the Signature." });
    putNote(store, { id: "other", scope: "github.com/acme/web", body: "Nothing here." });
    putNote(store, { id: "old", body: "signature rotation, trashed" }, true);

    const hits = search(store, "signature");
    expect(hits).toEqual([{ id: "raw-body", title: "Stripe needs the raw body", scope: "global", trashed: false, line: 12, text: "The JSON parser breaks the Signature." }]);
    expect(search(store, "signature", { trash: true }).map((h) => h.id)).toEqual(["raw-body", "old"]);
    expect(search(store, "nothing", { scope: "global" })).toEqual([]);
    // A title match counts once. The id line does not double it.
    expect(search(store, "raw").map((h) => h.line)).toEqual([3, 11]);
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
