import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeCommand } from "../cli/fire.ts";
import { lastActivity, logEvent } from "../cli/log.ts";
import { parseNote } from "../cli/note.ts";
import { search } from "../cli/search.ts";
import { Store } from "../cli/store.ts";
import { ROOT, daysAgo, kb, legacyUsage, logAt, logged, otherMachine, putNote, sh, tempDir, tempRepo, tempStore } from "./helpers.ts";

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

  test("the same title in another scope is a new note with a unique id, after the global note came back as a neighbor", () => {
    const store = tempStore();
    add(store, { title: "Run the tests", kind: "how-to", body: "a", scope: "global" });
    putNote(store, { id: "web-note", scope: "github.com/acme/web" });
    const note = { title: "Run the tests", kind: "how-to", body: "b", scope: "github.com/acme/web" };
    expect(add(store, note).json).toMatchObject({ status: "neighbors", neighbors: [{ id: "run-the-tests", scope: "global" }] });
    const other = add(store, { ...note, new: true });
    expect(other.json).toMatchObject({ status: "created", id: "run-the-tests-2" });
    expect(existsSync(join(store.home, "notes/github.com/acme/web/run-the-tests-2.md"))).toBe(true);
  });

  test("a long title gives a short id cut at a word, and titles with one prefix stay apart", () => {
    const store = tempStore();
    const base = "make test hits the live payment sandbox and creates charges";
    const first = add(store, { title: `${base} - use make test-fast`, kind: "gotcha", body: "a", scope: "global" });
    expect(first.json.id).toBe("make-test-hits-the-live-payment-sandbox-and");
    const second = add(store, { title: `${base} on CI too`, kind: "gotcha", body: "b", scope: "global", new: true });
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

    test("an update moves an older note to that time", () => {
      const store = tempStore();
      const { repo, february } = repoWithHistory();
      putNote(store, { id: "older", scope: SCOPE, last_verified: "2020-01-10T00:00:00Z" });
      putNote(store, { id: "same", scope: SCOPE, last_verified: "2020-02-15T12:00:00Z" });
      for (const id of ["older", "same"]) {
        expect(asOf(store, "2020-02-15T12:00:00.900Z", { id, body: "from the old session" }, repo).json.status).toBe("updated");
        expect(store.find(id)).toMatchObject({ body: "from the old session", last_verified: "2020-02-15T12:00:00Z", verified_at_commit: february });
      }
    });

    // The old conversation knows less than the check that came after it. Its text must not stand under the newer date.
    test("an update of a note that was verified after that time changes nothing", () => {
      const store = tempStore();
      const { repo, march } = repoWithHistory();
      const before = putNote(store, { id: "later", scope: SCOPE, last_verified: "2020-03-10T00:00:00Z", verified_at_commit: march, anchors: ["src/new.ts"], confidence: "high" });
      const file = readFileSync(store.find("later")!.path, "utf8");
      const result = asOf(store, "2020-02-15T12:00:00Z", { id: "later", title: "An old title", body: "from the old session", anchors: ["src/old.ts"], confidence: "low" }, repo);
      expect(result.code).toBe(0);
      expect(result.json).toEqual({ status: "newer", id: "later", last_verified: "2020-03-10T00:00:00Z" });
      expect(readFileSync(store.find("later")!.path, "utf8")).toBe(file);
      expect(store.find("later")).toMatchObject({ title: before.title, body: before.body, anchors: ["src/new.ts"], confidence: "high" });
      const text = kb(store, ["add", "--as-of", "2020-02-15T12:00:00Z"], { stdin: JSON.stringify({ id: "later", confidence: "low" }), cwd: repo });
      expect(text.stdout).toBe("newer later: the note was checked at 2020-03-10T00:00:00Z, after the time of --as-of. Nothing changed.\n");
      // With no --as-of, the same update is a check of today.
      expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ id: "later", body: "checked today" }), cwd: repo }).json.status).toBe("updated");
    });

    test("a time after now is now, and a value that is no full ISO time is refused", () => {
      const store = tempStore();
      const note = store.find(asOf(store, "2999-01-01T00:00:00Z", { title: "From the future", kind: "gotcha", body: "x", scope: "global" }).json.id)!;
      // One clock read gives both times, so they are equal also across the turn of a second.
      expect(note.last_verified).toBe(note.created);
      // `Date.parse` takes each of these but the first two: "1" is the year 2001.
      for (const bad of ["yesterday-ish", "", "1", "2026", "2026-01-31", "2026-01-31T12:00:00", "2026-01-31 12:00:00Z", "2026-02-31T12:00:00Z", "Jan 31 2026 12:00:00 GMT"]) {
        const result = asOf(store, bad, { title: "Never written", kind: "gotcha", body: "x", scope: "global" });
        expect(result.code).toBe(1);
        expect(result.json.error).toBe("--as-of needs a full ISO time with a zone, such as 2026-01-31T12:00:00Z");
      }
      // The forms that kb and a session mark write.
      for (const [good, stored] of [["2020-01-31T12:00:00Z", "2020-01-31T12:00:00Z"], ["2020-01-31T12:00:00.123Z", "2020-01-31T12:00:00Z"], ["2020-01-31T12:00:00+01:00", "2020-01-31T11:00:00Z"]] as const) {
        const made = asOf(store, good, { title: `At ${good}`, kind: "gotcha", body: "x", scope: "global" });
        expect(store.find(made.json.id)!.last_verified).toBe(stored);
        kb(store, ["delete", made.json.id]);
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
    kb(store, ["trash", "first"]);
    const log = sh(store.home, "git", "log", "--format=%s");
    expect(log.split("\n")).toEqual(["kb: trash first", "kb: add first"]);
    // Generated and per-machine files stay out of git, and so does the event log.
    const tracked = sh(store.home, "git", "ls-files");
    expect(tracked).toContain("trash/global/first.md");
    expect(tracked).not.toContain("usage/");
    expect(tracked).not.toContain(".state");
    expect(tracked).not.toContain("INDEX.md");
    expect(tracked).not.toContain("index.html");
    expect(tracked).not.toContain("local.json");
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
  });
});

// A known fact in other words has another title, so the exact-title check passes it. A search
// for "webhook retry" missed a note about "retries", and a recovery then added its twin.
describe("kb add: close notes", () => {
  const stored = { id: "raw-body", title: "Stripe signature check needs the raw body", body: "express.json() runs before the webhook route and breaks the signature check.\nMount express.raw() on the webhook route before the JSON parser." };
  const twin = { title: "The Stripe webhook route must get the raw body", kind: "gotcha", body: "The JSON parser breaks the signature check when it runs first. Use express.raw() for that route." };

  test("a note close to a stored one is not written: the answer names the neighbor and why it matched", () => {
    const store = tempStore();
    putNote(store, stored);
    putNote(store, { id: "ports", title: "The dev server needs port 4100 free", body: "It fails with a misleading error when the port is taken." });
    const held = add(store, { ...twin, scope: "global" });
    expect(held.code).toBe(0);
    expect(held.json.status).toBe("neighbors");
    expect(held.json.neighbors).toEqual([
      { id: "raw-body", scope: "global", kind: "gotcha", title: stored.title, first_line: "express.json() runs before the webhook route and breaks the signature check.", shared: ["route", "raw", "stripe", "webhook", "body"], score: expect.any(Number) },
    ]);
    expect(held.json.hint).toContain('"new": true');
    expect(store.notes()).toHaveLength(2);
    // The text form says the same, for a caller that passes no --json.
    const text = kb(store, ["add"], { stdin: JSON.stringify({ ...twin, scope: "global" }) }).stdout;
    expect(text).toStartWith("neighbors: 1 note is close to this one. Nothing was written.\nraw-body | global | gotcha | Stripe signature check needs the raw body\n");
    // An update keeps the scope of the note, so the hint says to leave the scope of the draft out.
    expect(text).toContain('To update the note that holds the same fact, pass its "id" and remove "scope". Pass "new": true when this is a different fact.');
  });

  test("with \"new\": true the note is written, the result still lists the neighbors, and the flag is not stored", () => {
    const store = tempStore();
    putNote(store, stored);
    const made = add(store, { ...twin, scope: "global", new: true });
    expect(made.json).toMatchObject({ status: "created", id: "the-stripe-webhook-route-must-get-the-raw-body", neighbors: [{ id: "raw-body" }] });
    expect(readFileSync(made.json.path, "utf8")).not.toContain("new");
    expect(store.notes()).toHaveLength(2);
  });

  test("an update by id skips the check, and so the writer can put the new fact into the neighbor", () => {
    const store = tempStore();
    putNote(store, stored);
    putNote(store, { id: "other", title: "Stripe needs the raw body for the signature check", body: "A close note that the update must not find." });
    const updated = add(store, { id: "raw-body", title: twin.title, body: twin.body });
    expect(updated.json).toMatchObject({ status: "updated", id: "raw-body" });
    expect(updated.json.neighbors).toBeUndefined();
  });

  test("a note with no close note is written as before, and an exact title still answers exists", () => {
    const store = tempStore();
    putNote(store, stored);
    const made = add(store, { title: "The deploy CLI exits 0 when the upload was rejected", kind: "gotcha", body: "Check the status in the JSON output.", scope: "global" });
    expect(made.json).toMatchObject({ status: "created", id: "the-deploy-cli-exits-0-when-the-upload-was", path: expect.any(String) });
    expect(made.json.neighbors).toBeUndefined();
    expect(add(store, { ...twin, title: stored.title.toUpperCase(), scope: "global" }).json).toMatchObject({ status: "exists", id: "raw-body" });
  });

  test("a repo note has the notes of its repo and the global notes as neighbors, never the notes of another repo", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, { ...stored, id: "api-raw-body", scope: "github.com/acme/api" });
    expect(add(store, twin, repo).json.status).toBe("created");
    // Now the repo holds the fact, and a global note holds it too.
    putNote(store, { ...stored, id: "global-raw-body" });
    const held = add(store, { ...twin, title: "Give the Stripe webhook the raw body" }, repo);
    expect(held.json.status).toBe("neighbors");
    expect(held.json.neighbors.map((n: any) => n.scope).sort()).toEqual(["github.com/acme/web", "global"]);
  });

  test("a global note is written when only a repo note is close, and the result names that note", () => {
    const store = tempStore();
    putNote(store, { ...stored, scope: "github.com/acme/api" });
    const made = add(store, { ...twin, scope: "global" });
    expect(made.json).toMatchObject({ status: "created", neighbors: [{ id: "raw-body", scope: "github.com/acme/api" }] });
    expect(kb(store, ["add"], { stdin: JSON.stringify({ ...twin, title: "Stripe webhooks need the raw body", scope: "global", new: true }) }).stdout).toContain("close notes, not changed:\n");
  });

  // The draft says with "supersedes" that it replaces the note. The check held it for that same note.
  test("a note that the new note supersedes is no neighbor", () => {
    const store = tempStore();
    putNote(store, stored);
    expect(add(store, { ...twin, scope: "global" }).json.status).toBe("neighbors");
    const made = add(store, { ...twin, scope: "global", supersedes: ["raw-body"] });
    expect(made.json).toMatchObject({ status: "created", id: "the-stripe-webhook-route-must-get-the-raw-body" });
    expect(made.json.neighbors).toBeUndefined();
    expect(store.find(made.json.id)).toMatchObject({ supersedes: ["raw-body"] });
    // Another close note still holds the write.
    putNote(store, { ...stored, id: "second-raw-body", title: "Stripe needs the raw body for its signature check" });
    const held = add(store, { ...twin, title: "Give the Stripe webhook the raw body", scope: "global", supersedes: ["raw-body", made.json.id] });
    expect(held.json).toMatchObject({ status: "neighbors", neighbors: [{ id: "second-raw-body" }] });
  });

  // An agent in a repo wrote a draft with "scope": "repo", got a global neighbor, and passed its id.
  // The old error said to trash the note. The agent then trashed the global note.
  test("an update by id with the scope of the draft says which scope the note has, and never to trash it", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/web.git" });
    putNote(store, stored);
    const held = add(store, { ...twin, scope: "repo" }, repo);
    expect(held.json).toMatchObject({ status: "neighbors", neighbors: [{ id: "raw-body", scope: "global" }] });
    expect(held.json.hint).toContain('pass its "id" and remove "scope"');
    const refused = add(store, { ...twin, scope: "repo", id: "raw-body" }, repo);
    expect(refused.code).toBe(1);
    expect(refused.json.error).toBe('the note raw-body has the scope "global", and an update keeps it. Remove "scope" from the input to update the note.');
    expect(refused.json.error).not.toMatch(/trash/i);
    expect(store.find("raw-body")).toMatchObject({ title: stored.title, scope: "global" });
    // What the hint says works: the id, and no scope.
    const { scope: _scope, ...noScope } = { ...twin, scope: "repo", id: "raw-body" };
    expect(add(store, noScope, repo).json).toMatchObject({ status: "updated", id: "raw-body" });
    expect(store.find("raw-body")).toMatchObject({ title: twin.title, scope: "global" });
    // The scope of the note itself is no error.
    expect(add(store, { id: "raw-body", scope: "global", body: "The same scope." }, repo).json.status).toBe("updated");
  });

  test("a note in the trash, and a rule that moved to an instruction file, are no neighbors", () => {
    const store = tempStore();
    putNote(store, stored, true);
    putNote(store, { ...stored, id: "moved", promoted_to: "CLAUDE.md" });
    expect(add(store, { ...twin, scope: "global" }).json.status).toBe("created");
  });

  test("a note that is not valid is refused before the neighbors are named", () => {
    const store = tempStore();
    putNote(store, stored);
    const bad = add(store, { ...twin, kind: "idea", scope: "global" });
    expect(bad.code).toBe(1);
    expect(bad.json.error).toContain("kind: must be one of");
  });
});

describe("kb help", () => {
  // A shell policy can refuse a command with the JSON in a heredoc. The help sent every reader there.
  test("it names --file as the first way to pass the JSON, says why, and names no product", () => {
    const help = kb(tempStore(), ["help"]).stdout;
    expect(help).toContain("kb add --file <path>");
    expect(help).toContain("kb audit propose --file <path>");
    expect(help.indexOf("--file <path>")).toBeLessThan(help.indexOf("stdin"));
    expect(help).toContain("Write the JSON to a file and pass --file <path>. A shell policy can refuse a command that\n  holds the JSON in a heredoc.");
    expect(help).toContain('leave "scope" out');
    // The CLI knows nothing about the harness that runs it, so the reason names no product.
    const why = help.slice(help.indexOf("Write the JSON to a file"), help.indexOf("A file always passes."));
    expect(why).not.toMatch(/claude|session|permission/i);
  });
});

describe("--file", () => {
  const note = { title: "Stripe needs the raw body", kind: "gotcha", body: "A body with a brace { and a quote ' and a $HOME.", scope: "global" };

  test("kb add reads the JSON from the file, and stdin still works", () => {
    const store = tempStore();
    const dir = tempDir();
    writeFileSync(join(dir, "note.json"), JSON.stringify(note));
    const made = kb(store, ["add", "--json", "--file", join(dir, "note.json")]);
    expect(made.json).toMatchObject({ status: "created", id: "stripe-needs-the-raw-body" });
    expect(store.notes()[0]!.body).toBe(note.body);
    // A path is relative to the directory of the command.
    writeFileSync(join(dir, "update.json"), JSON.stringify({ id: made.json.id, body: "new" }));
    expect(kb(store, ["add", "--json", "--file=update.json"], { cwd: dir }).json.status).toBe("updated");
    expect(add(store, { id: made.json.id, body: "from stdin" }).json.status).toBe("updated");
  });

  test("a file that is missing, a directory or not JSON is one clear error, and nothing is written", () => {
    const store = tempStore();
    const dir = tempDir();
    const missing = kb(store, ["add", "--file", join(dir, "none.json")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.trim()).toBe(`cannot read --file ${join(dir, "none.json")}: no such file`);
    expect(kb(store, ["add", "--json", "--file", dir]).json).toEqual({ error: `cannot read --file ${dir}: it is a directory` });
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(kb(store, ["add", "--file", join(dir, "bad.json")]).stderr.trim()).toBe("kb add reads one JSON object, from --file <path> or on stdin");
    expect(kb(store, ["add", "--file"]).stderr.trim()).toBe("--file needs a value");
    expect(kb(store, ["audit", "propose", "--file", join(dir, "none.json")]).stderr.trim()).toBe(`cannot read --file ${join(dir, "none.json")}: no such file`);
    expect(store.notes()).toHaveLength(0);
  });
});

describe("kb add with triggers", () => {
  // The notes of one test share this body. "new" says that each is its own fact, so no neighbor holds the write.
  const gotcha = { title: "zorp --wipe removes the cache of every project", kind: "gotcha", scope: "global", body: "Pass --project.", new: true };

  test("stores them with single spaces, each once, after the anchors, and show and list give them", () => {
    const store = tempStore();
    const result = add(store, { ...gotcha, triggers: ["cmd:  zorp   --wipe", "cmd: zorp --wipe", "STOP: zorp nuke", "err: Flux capacitor underflow"] });
    expect(result.json).toEqual({ status: "created", id: "zorp-wipe-removes-the-cache-of-every-project", path: result.json.path });
    const triggers = ["cmd: zorp --wipe", "stop: zorp nuke", "err: Flux capacitor underflow"];
    expect(readFileSync(result.json.path, "utf8")).toContain('anchors: []\ntriggers:\n  - "cmd: zorp --wipe"\n  - "stop: zorp nuke"\n  - "err: Flux capacitor underflow"\nconfidence: medium\n');
    expect(store.find(result.json.id)!.triggers).toEqual(triggers);
    expect(kb(store, ["show", result.json.id, "--json"]).json.triggers).toEqual(triggers);
    expect(kb(store, ["show", result.json.id]).stdout).toContain('  - "cmd: zorp --wipe"');
    expect(kb(store, ["list", "--json"]).json[0].triggers).toEqual(triggers);
    // A note with no trigger has no such key in its file, so an old note does not change, and list gives an empty list.
    const bare = add(store, { ...gotcha, title: "No trigger here", anchors: [] });
    expect(readFileSync(bare.json.path, "utf8")).not.toContain("triggers");
    expect(kb(store, ["list", "--json"]).json.find((n: { id: string }) => n.id === "no-trigger-here").triggers).toEqual([]);
  });

  test("refuses a trigger that is wrong, names each one, and writes nothing", () => {
    const store = tempStore();
    const bad = add(store, { ...gotcha, triggers: ["cmd: git", "err: short", "when: x"] });
    expect(bad.code).toBe(1);
    expect(bad.json.error).toBe('invalid note: triggers: "cmd: git" matches too many commands. Add a second word, such as a subcommand or a flag; "err: short" needs at least 8 characters of the error text; "when: x" must start with cmd:, stop:, err:');
    expect(add(store, { ...gotcha, triggers: "cmd: zorp --wipe" }).json.error).toContain("triggers: must be a list");
    expect(store.notes()).toHaveLength(0);
    // The same check on an update, and the note stays as it was.
    putNote(store, { id: "a", triggers: ["cmd: zorp --wipe"] });
    expect(add(store, { id: "a", triggers: ["cmd: ls"] }).json.error).toContain("matches too many commands");
    expect(store.find("a")!.triggers).toEqual(["cmd: zorp --wipe"]);
    // A trigger syncs to git with the note, so it holds no secret.
    expect(add(store, { id: "a", triggers: [`cmd: curl -H ${"ghp_"}${"a1B2".repeat(9)}`] }).json.error).toContain("triggers, item 1");
  });

  test("a trigger that a hand wrote with no quotes is the same trigger, and a broken one costs only itself, never the note", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    // YAML reads `- cmd: zorp --wipe` as a map with one key. The other items are of no use to any kb.
    const file = join(store.home, "notes", "global", "by-hand.md");
    const front = (triggers: string) => `---\nid: by-hand\ntitle: zorp --wipe removes the cache\nscope: global\nkind: gotcha\ncreated: 2026-01-01T00:00:00Z\nlast_verified: 2026-01-01T00:00:00Z\nanchors: []\n${triggers}confidence: high\n---\nPass --project.\n`;
    mkdirSync(join(store.home, "notes", "global"), { recursive: true });
    writeFileSync(file, front("triggers:\n  - cmd: zorp --wipe\n  - \"stop: zorp nuke\"\n  - err: 12345678\n  - 7\n  - [cmd, zorp]\n  - cmd: zorp\n    stop: zorp\n  -\n  - when: a later kb knows\n"));
    const triggers = ["cmd: zorp --wipe", "stop: zorp nuke", "err: 12345678", "when: a later kb knows"];
    expect(kb(store, ["list", "--json"]).json).toMatchObject([{ id: "by-hand", triggers }]);
    expect(kb(store, ["show", "by-hand", "--json"]).json.triggers).toEqual(triggers);
    expect(kb(store, ["search", "cache", "--json"]).json.map((n: { id: string }) => n.id)).toEqual(["by-hand"]);
    expect(kb(store, ["context"], { cwd: repo }).stdout).toContain("by-hand");
    // The trigger loads the note, as the quoted form does.
    expect(beforeCommand(store, "zorp --wipe", repo, { session_id: "s1" })?.fires).toMatchObject([{ note: "by-hand", kind: "cmd" }]);
    // A write keeps what it read, in the quoted form.
    expect(add(store, { id: "by-hand", confidence: "medium" }).json.status).toBe("updated");
    expect(readFileSync(file, "utf8")).toContain('triggers:\n  - "cmd: zorp --wipe"\n  - "stop: zorp nuke"\n  - "err: 12345678"\n  - "when: a later kb knows"\nconfidence: medium\n');
    // One trigger alone, with no list, and a key with nothing after it.
    writeFileSync(file, front("triggers:\n  cmd: zorp --wipe\n"));
    expect(store.find("by-hand")!.triggers).toEqual(["cmd: zorp --wipe"]);
    writeFileSync(file, front("triggers:\n"));
    expect(store.find("by-hand")).toMatchObject({ id: "by-hand" });
    expect(store.find("by-hand")!.triggers).toBeUndefined();
    // A write is still strict: the map form and a trigger of no known kind are refused, with the reason.
    expect(add(store, { id: "by-hand", triggers: [{ cmd: "zorp --wipe" }] }).json.error).toBe('invalid note: triggers: a trigger is a text such as "cmd: pkill -f"');
    expect(add(store, { id: "by-hand", triggers: ["when: a later kb knows"] }).json.error).toContain("must start with cmd:, stop:, err:");
    expect(add(store, { ...gotcha, title: "A new note", triggers: [{ cmd: "zorp --wipe" }] }).json.error).toContain("a trigger is a text");
  });

  test("an update of triggers alone is no verification, and an update of other fields keeps them", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    putNote(store, { id: "a", scope: "github.com/acme/billing", triggers: ["cmd: zorp --wipe"], verified_at_commit: "abc1234" });
    expect(add(store, { id: "a", triggers: ["stop: zorp --wipe", "err: flux capacitor underflow"] }, repo).json.status).toBe("updated");
    // A trigger says when the note loads, not that somebody checked the fact.
    expect(store.find("a")).toMatchObject({ triggers: ["stop: zorp --wipe", "err: flux capacitor underflow"], last_verified: "2026-01-01T00:00:00Z", verified_at_commit: "abc1234" });
    add(store, { id: "a", body: "a new body" }, repo);
    const note = store.find("a")!;
    expect(note).toMatchObject({ body: "a new body", triggers: ["stop: zorp --wipe", "err: flux capacitor underflow"] });
    expect(note.last_verified > "2026-01-01T00:00:00Z").toBe(true);
    // An empty list takes the triggers off.
    add(store, { id: "a", triggers: [] }, repo);
    expect(store.find("a")!.triggers).toBeUndefined();
    expect(readFileSync(store.find("a")!.path, "utf8")).not.toContain("triggers");
  });

  test("every other write keeps the triggers: verify, trash and restore, and the trash that gets its time", () => {
    const store = tempStore();
    const triggers = ["cmd: zorp --wipe", "err: flux capacitor underflow"];
    putNote(store, { id: "a", triggers });
    putNote(store, { id: "by-hand", triggers }, true);
    kb(store, ["verify", "a"]);
    expect(store.find("a")!.triggers).toEqual(triggers);
    kb(store, ["trash", "a"]);
    expect(store.find("a")).toMatchObject({ trashed: true, triggers });
    kb(store, ["restore", "a"]);
    expect(store.find("a")).toMatchObject({ trashed: false, triggers });
    // A note that a hand moved to the trash gets its time there from the next command.
    expect(store.find("by-hand")!.trashed_at).toBeDefined();
    expect(store.find("by-hand")!.triggers).toEqual(triggers);
  });

  test("a saved gotcha or how-to with no trigger and no anchor, and a long body, come with warnings, never a refusal", () => {
    const store = tempStore();
    const none = "with no trigger and no anchor loads only at the session start";
    const bare = add(store, gotcha);
    expect(bare.json.status).toBe("created");
    expect(bare.json.warnings).toEqual([`a gotcha ${none}. Give it "triggers" (cmd:, stop: or err:) or "anchors", or say in your report why it has none.`]);
    expect(add(store, { ...gotcha, title: "A how-to", kind: "how-to" }).json.warnings[0]).toStartWith(`a how-to ${none}`);
    // A trigger or an anchor is enough, and the other kinds load by their place in the session start.
    expect(add(store, { ...gotcha, title: "With a trigger", triggers: ["err: flux capacitor underflow"] }).json.warnings).toBeUndefined();
    expect(add(store, { ...gotcha, title: "With an anchor", anchors: ["src/pay.ts"] }).json.warnings).toBeUndefined();
    for (const kind of ["decision", "convention", "open-work"]) expect(add(store, { ...gotcha, title: `A ${kind}`, kind }).json.warnings).toBeUndefined();
    // A body of 700 characters is fine: a trigger loads it whole. One more is worth a second look.
    expect(add(store, { ...gotcha, title: "At the aim", kind: "decision", body: "x".repeat(700) }).json.warnings).toBeUndefined();
    const long = add(store, { ...gotcha, title: "Over the aim", body: "x".repeat(701) });
    expect(long.json.status).toBe("created");
    expect(long.json.warnings).toEqual([expect.stringContaining(none), "the body has 701 characters. A trigger loads at most 700, and cuts the rest. Keep the fact, why it matters, and how to apply it."]);
    // An update answers for the note as it is stored now, and the text form prints each warning on a line.
    expect(add(store, { id: bare.json.id, confidence: "high" }).json.warnings).toHaveLength(1);
    expect(add(store, { id: bare.json.id, triggers: ["cmd: zorp --wipe"] }).json).toEqual({ status: "updated", id: bare.json.id, path: bare.json.path });
    const text = kb(store, ["add"], { stdin: JSON.stringify({ ...gotcha, title: "In text" }) });
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(`created in-text\nwarning: a gotcha ${none}. Give it "triggers" (cmd:, stop: or err:) or "anchors", or say in your report why it has none.\n`);
  });
});

describe("a read is not a write", () => {
  test("show, search, verdict and log leave the store as it was: no commit, no changed file, no usage file", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    add(store, { title: "First", kind: "gotcha", body: "the body", scope: "global" });
    const head = sh(store.home, "git", "rev-parse", "HEAD");
    const note = readFileSync(store.find("first")!.path, "utf8");
    for (const args of [["show", "first"], ["show", "first", "--check"], ["search", "body"], ["verdict", "helped", "first"], ["use", "first"], ["list"], ["log"], ["log", "--session", "s1"]]) {
      expect(kb(store, args, { env: { KB_SESSION: "s1" } }).code).toBe(0);
    }
    expect(sh(store.home, "git", "rev-parse", "HEAD")).toBe(head);
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
    expect(readFileSync(store.find("first")!.path, "utf8")).toBe(note);
    expect(existsSync(join(store.home, "usage"))).toBe(false);
    // The reads are in the log of this machine, which git ignores.
    expect(logged(store).map((e) => e.ev)).toEqual(["write", "show", "show", "search", "verdict", "verdict"]);
  });

  test("a read writes no roll-up. The next write takes it into its own commit, at most once per day", () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    add(store, { title: "First", kind: "gotcha", body: "the body", scope: "global" });
    add(store, { title: "Second", kind: "gotcha", body: "the body", scope: "global" });
    const commits = () => sh(store.home, "git", "log", "--format=%s").split("\n");
    const files = () => sh(store.home, "git", "show", "--name-only", "--format=", "HEAD").split("\n");
    expect(commits()).toHaveLength(2);
    // Activity, and then reads of every kind: nothing in the store changes.
    for (const args of [["show", "first"], ["verdict", "helped", "first"], ["search", "body"], ["list"], ["log"], ["stale"], ["budget"], ["context"]]) expect(kb(store, args).code).toBe(0);
    expect(commits()).toHaveLength(2);
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
    expect(existsSync(join(store.home, "activity"))).toBe(false);
    // The daily check of this day ran with the second add, before there was activity. On the next
    // day, the first write takes the roll-up into its commit.
    writeFileSync(join(store.home, ".state", "log", "rolled-up"), "2000-01-01\n");
    expect(add(store, { id: "second", body: "a new body" }).json.status).toBe("updated");
    expect(commits()).toHaveLength(3);
    expect(commits()[0]).toBe("kb: update second");
    const machine = store.local().machine;
    expect(files().sort()).toEqual([`activity/${machine}.json`, "notes/global/second.md"]);
    const rolled = JSON.parse(readFileSync(join(store.home, "activity", `${machine}.json`), "utf8"));
    expect(Object.keys(rolled.notes)).toEqual(["first"]);
    expect(rolled.notes.first.last).toBe(rolled.notes.first.helped);
    // A second write on the same day leaves the roll-up alone.
    kb(store, ["show", "second"]);
    expect(add(store, { id: "first", body: "a new body" }).json.status).toBe("updated");
    expect(files()).toEqual(["notes/global/first.md"]);
    expect(sh(store.home, "git", "status", "--porcelain")).toBe("");
  });

  test("show and list print no use count, also when an older kb left counters", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    legacyUsage(store, "old", { a: { uses: 5, last_used: "2026-01-01T00:00:00Z" } });
    const shown = kb(store, ["show", "a", "--json"]).json;
    expect(shown).toMatchObject({ id: "a", title: "Title of a" });
    expect(Object.keys(shown)).not.toContain("uses");
    expect(kb(store, ["show", "a"]).stdout).toStartWith("# notes/global/a.md\n---\n");
    expect(Object.keys(kb(store, ["list", "--json"]).json[0])).toEqual(["id", "kind", "scope", "title", "last_verified", "confidence", "triggers", "promoted_to"]);
    expect(kb(store, ["list"]).stdout.split("\n")[0]).toMatch(/^id +kind +scope +verified +title$/);
  });
});

describe("the event log from the CLI", () => {
  test("show and search log why: a task by default, a check with --check or the older --no-use", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
    putNote(store, { id: "ledger-rows", scope: "github.com/acme/billing", body: "Rows are append-only." });
    putNote(store, { id: "old" }, true);
    const env = { KB_SESSION: "s1" };
    kb(store, ["show", "ledger"], { cwd: repo, env });
    kb(store, ["show", "ledger-rows", "--check"], { cwd: repo, env });
    kb(store, ["show", "ledger-rows", "--no-use"], { cwd: repo, env });
    // The --session flag wins over the environment, and a session outside any repo has the scope "global".
    kb(store, ["show", "old", "--session", "s2"], { env });
    kb(store, ["search", "append-only", "rows"], { cwd: repo, env });
    kb(store, ["search", "nothing", "here", "--check"], { cwd: repo });
    expect(kb(store, ["show", "nope"], { env }).code).toBe(1);
    const scope = "github.com/acme/billing";
    expect(logged(store)).toEqual([
      { ev: "show", session: "s1", scope, note: "ledger-rows", why: "task" },
      { ev: "show", session: "s1", scope, note: "ledger-rows", why: "check" },
      { ev: "show", session: "s1", scope, note: "ledger-rows", why: "check" },
      // A show of a note in the trash says so.
      { ev: "show", session: "s2", scope: "global", note: "old", why: "task", trashed: true },
      { ev: "search", session: "s1", scope, query: "append-only rows", hits: 1, complete: true, why: "task" },
      { ev: "search", scope, query: "nothing here", hits: 0, complete: true, why: "check" },
    ]);
  });

  test("a show of a note in the trash is logged, and it is never activity of the note", () => {
    const store = tempStore();
    putNote(store, { id: "live" });
    putNote(store, { id: "gone" }, true);
    const env = { KB_SESSION: "s1" };
    expect(kb(store, ["show", "gone"], { env }).code).toBe(0);
    expect(kb(store, ["show", "live"], { env }).code).toBe(0);
    expect(logged(store).map((e) => [e.note, e.trashed])).toEqual([["gone", true], ["live", undefined]]);
    expect([...lastActivity(store).keys()]).toEqual(["live"]);
    expect(kb(store, ["log", "--json"]).json.notes.find((n: any) => n.id === "gone")).toMatchObject({ state: "trash", last_activity: null });
    expect(kb(store, ["log", "--session", "s1"]).stdout).toMatch(/  show +gone \(task, in the trash\)\n.*  show +live \(task\)$/m);
    // After a restore the note is live, and a show counts again.
    kb(store, ["restore", "gone"], { env });
    kb(store, ["show", "gone"], { env });
    expect(lastActivity(store).has("gone")).toBe(true);
  });

  test("a search with no note that has every word logs no hit, and the count of the closest notes apart", () => {
    const store = tempStore();
    putNote(store, { id: "one", body: "alpha beta" });
    putNote(store, { id: "two", body: "alpha beta delta" });
    putNote(store, { id: "three", body: "alpha" });
    const env = { KB_SESSION: "s1" };
    expect(kb(store, ["search", "alpha", "beta", "gamma"], { env }).stdout).toStartWith("no note has every word. Closest:\none |");
    kb(store, ["search", "alpha", "beta"], { env });
    kb(store, ["search", "gamma", "omega"], { env });
    expect(logged(store)).toEqual([
      { ev: "search", session: "s1", scope: "global", query: "alpha beta gamma", hits: 0, complete: false, closest: 2, why: "task" },
      { ev: "search", session: "s1", scope: "global", query: "alpha beta", hits: 2, complete: true, why: "task" },
      { ev: "search", session: "s1", scope: "global", query: "gamma omega", hits: 0, complete: true, why: "task" },
    ]);
    const text = kb(store, ["log", "--session", "s1"]).stdout;
    expect(text).toMatch(/  search +"alpha beta gamma": no note has every word, 2 closest notes \(task\)$/m);
    expect(text).toMatch(/  search +"alpha beta": 2 notes \(task\)$/m);
    expect(text).toMatch(/  search +"gamma omega": 0 notes \(task\)$/m);
  });

  test("the session is the --session flag, else KB_SESSION, else the id that Claude Code sets for the command", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const harness = { CLAUDE_CODE_SESSION_ID: "from-harness" };
    kb(store, ["show", "a"], { env: harness });
    kb(store, ["show", "a"], { env: { ...harness, KB_SESSION: "own" } });
    kb(store, ["show", "a", "--session", "flag"], { env: { ...harness, KB_SESSION: "own" } });
    kb(store, ["show", "a"]);
    // The launcher that skills call passes the environment on as it is.
    Bun.spawnSync([join(ROOT, "bin", "kb"), "show", "a"], { cwd: tempDir(), env: { ...process.env, KB_HOME: store.home, ...harness }, stdout: "pipe", stderr: "pipe" });
    expect(logged(store).map((e) => e.session)).toEqual(["from-harness", "own", "flag", undefined, "from-harness"]);
  });

  test("verdict records what a note did for the session, and use is the older name of verdict helped", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    putNote(store, { id: "b" });
    putNote(store, { id: "trashed" }, true);
    const env = { KB_SESSION: "s1" };
    logEvent(store, { ev: "fire", session: "s1", kind: "path", form: "title", note: "b", tool: "Read", match: "src/a.ts" });
    expect(kb(store, ["verdict", "helped", "a", "--json"], { env }).json).toEqual({ verdict: "helped", notes: ["a"], unknown: [] });
    expect(kb(store, ["verdict", "not-needed", "b", "ghost", "b"], { env }).stdout).toBe("not-needed: b\nunknown ghost\n");
    // A session may judge a note it trashed a moment ago.
    expect(kb(store, ["verdict", "wrong", "trashed"], { env }).code).toBe(0);
    expect(kb(store, ["use", "a", "b", "--json"], { env }).json).toEqual({ verdict: "helped", notes: ["a", "b"], unknown: [] });
    expect(logged(store).slice(1)).toEqual([
      { ev: "verdict", session: "s1", scope: "global", note: "a", verdict: "helped" },
      { ev: "verdict", session: "s1", scope: "global", note: "b", verdict: "not-needed" },
      { ev: "verdict", session: "s1", scope: "global", note: "trashed", verdict: "wrong" },
      { ev: "verdict", session: "s1", scope: "global", note: "a", verdict: "helped" },
      { ev: "verdict", session: "s1", scope: "global", note: "b", verdict: "helped" },
    ]);
    for (const args of [["verdict"], ["verdict", "helped"], ["verdict", "useful", "a"], ["verdict", "helped", "ghost"], ["use"], ["use", "ghost"]]) {
      const bad = kb(store, args, { env });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(/usage: kb verdict <helped\|not-needed\|wrong> <id>\.\.\.|no note with id: ghost/);
    }
    expect(logged(store)).toHaveLength(6);
    // The help names verdict, not use.
    const help = kb(store, ["help"]).stdout;
    expect(help).toContain("kb verdict <helped|not-needed|wrong> <id>...");
    expect(help).not.toMatch(/kb use|--no-use|\buses\b/);
  });

  test("not-needed is only for a note that a trigger loaded in the session: a note from the session start is refused, and nothing is logged", () => {
    const store = tempStore();
    for (const id of ["fired", "body", "opened"]) putNote(store, { id });
    const fire = (session: string, note: string) => logEvent(store, { ev: "fire", session, kind: "path", form: "title", note, tool: "Read", match: "src/a.ts" });
    logEvent(store, { ev: "start", session: "s1", source: "startup", bodies: ["body"], index: [], hidden: [], chars: { fixed: 1, index: 0, bodies: 1, total: 2 } });
    fire("s1", "fired");
    logEvent(store, { ev: "show", session: "s1", note: "opened", why: "task" });
    // A fire in another session is not a fire in this one.
    fire("s2", "body");
    const before = logged(store);

    // One note with no fire refuses the whole command, so the session reads the message.
    const refused = kb(store, ["verdict", "not-needed", "fired", "body", "opened", "--session", "s1"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not-needed is only for a note that a trigger loaded in the session");
    expect(refused.stderr).toContain("Session s1 has no fire of: body, opened. A note from the session start gets helped, wrong or no verdict. Nothing was recorded.");
    // The session of the harness is a session too.
    expect(kb(store, ["verdict", "not-needed", "body", "--json"], { env: { CLAUDE_CODE_SESSION_ID: "s1" } }).json.error).toContain("Session s1 has no fire of: body.");
    expect(logged(store)).toEqual(before);

    expect(kb(store, ["verdict", "not-needed", "fired", "--session", "s1", "--json"]).json).toEqual({ verdict: "not-needed", notes: ["fired"], unknown: [] });
    expect(kb(store, ["verdict", "not-needed", "body", "--session", "s2"]).code).toBe(0);
    // A note from the session start takes the other verdicts.
    expect(kb(store, ["verdict", "helped", "body", "--session", "s1"]).code).toBe(0);
    expect(kb(store, ["verdict", "wrong", "opened", "--session", "s1"]).code).toBe(0);
    // With no session there is nothing to check, so the verdict is taken as before.
    expect(kb(store, ["verdict", "not-needed", "opened"]).code).toBe(0);
    expect(logged(store).slice(before.length).map((e) => `${e.session ?? "-"} ${e.verdict} ${e.note}`)).toEqual(["s1 not-needed fired", "s2 not-needed body", "s1 helped body", "s1 wrong opened", "- not-needed opened"]);
  });

  test("a verdict clears the stale count that a session start reads, and a show leaves it", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const cache = join(store.home, ".state", "stale.json");
    expect(kb(store, ["stale", "--json"]).json.notes).toBe(1);
    expect(existsSync(cache)).toBe(true);
    kb(store, ["show", "a"]);
    expect(existsSync(cache)).toBe(true);
    // The note is now judged wrong, so the count of the cache is old.
    expect(kb(store, ["verdict", "wrong", "a"]).code).toBe(0);
    expect(existsSync(cache)).toBe(false);
    expect(kb(store, ["stale", "--json"]).json.candidates.map((c: any) => c.reason)).toContain("judged-wrong");
  });

  test("each write is one event per note, with the session that wrote it", () => {
    const store = tempStore();
    const env = { KB_SESSION: "s1" };
    const added = kb(store, ["add", "--json"], { env, stdin: JSON.stringify({ title: "A new fact", kind: "gotcha", body: "x", scope: "global" }) }).json;
    expect(added.status).toBe("created");
    // A title that exists adds nothing, so it logs nothing.
    kb(store, ["add", "--json"], { env, stdin: JSON.stringify({ title: "A new fact", kind: "gotcha", body: "y", scope: "global" }) });
    kb(store, ["add", "--json"], { env, stdin: JSON.stringify({ id: "a-new-fact", body: "z" }) });
    kb(store, ["verify", "a-new-fact"], { env });
    putNote(store, { id: "other" });
    kb(store, ["trash", "a-new-fact", "other"], { env });
    kb(store, ["restore", "other"], { env });
    kb(store, ["delete", "a-new-fact", "other"]);
    kb(store, ["checkpointed", "s1"], { env: { KB_SESSION: "another" } });
    const write = (op: string, note: string, session: string | undefined = "s1") => ({ ev: "write", ...(session ? { session } : {}), scope: "global", note, op });
    expect(logged(store)).toEqual([
      write("add", "a-new-fact"),
      write("update", "a-new-fact"),
      write("verify", "a-new-fact"),
      write("trash", "a-new-fact"),
      write("trash", "other"),
      write("restore", "other"),
      write("delete", "a-new-fact", ""),
      write("delete", "other", ""),
      { ev: "checkpoint", session: "s1", scope: "global" },
    ]);
  });

  test("an add that kb holds for a close note logs the notes it showed, and so does the write that follows", () => {
    const store = tempStore();
    const env = { KB_SESSION: "s1" };
    putNote(store, { id: "raw-body", title: "Stripe signature check needs the raw body", body: "express.json() runs before the webhook route and breaks the signature check." });
    const twin = { title: "The Stripe webhook route must get the raw body", kind: "gotcha", scope: "global", body: "The JSON parser breaks the signature check when it runs first." };
    expect(kb(store, ["add", "--json"], { env, stdin: JSON.stringify(twin) }).json.status).toBe("neighbors");
    expect(kb(store, ["add", "--json"], { env, stdin: JSON.stringify({ ...twin, new: true }) }).json.status).toBe("created");
    expect(logged(store)).toEqual([
      { ev: "neighbors", session: "s1", scope: "global", title: twin.title, neighbors: ["raw-body"] },
      { ev: "write", session: "s1", scope: "global", note: "the-stripe-webhook-route-must-get-the-raw-body", op: "add", neighbors: ["raw-body"] },
    ]);
    const lines = kb(store, ["log", "--session", "s1"]).stdout;
    expect(lines).toContain(`neighbors   ${JSON.stringify(twin.title)}: not written, close to raw-body`);
    expect(lines).toContain("add the-stripe-webhook-route-must-get-the-raw-body (close to raw-body)");
  });

  test("a note the trash clears is deleted for nobody: the event names no session", () => {
    const store = tempStore();
    putNote(store, { id: "expired", trashed_at: daysAgo(31) }, true);
    putNote(store, { id: "live" });
    kb(store, ["show", "live"], { env: { KB_SESSION: "s1" } });
    expect(logged(store)).toEqual([
      { ev: "write", note: "expired", op: "delete" },
      { ev: "show", session: "s1", scope: "global", note: "live", why: "task" },
    ]);
  });
});

describe("kb log", () => {
  const SCOPE = "github.com/acme/billing";
  /** Two sessions: s1 got "a" whole and "b" as a line, opened "b" and judged both. s2 only started. */
  function fixture() {
    const store = tempStore();
    putNote(store, { id: "a", scope: SCOPE });
    putNote(store, { id: "b", scope: SCOPE, kind: "decision", title: "The title of b" });
    putNote(store, { id: "c" });
    putNote(store, { id: "quiet" });
    putNote(store, { id: "in-trash" }, true);
    const s1 = { session: "s1", scope: SCOPE };
    const chars = { fixed: 700, index: 40, bodies: 260, total: 1000 };
    logAt(store, "2026-06-01T10:00:00Z", { ev: "start", ...s1, source: "startup", bodies: ["a"], index: ["b"], hidden: ["c", "deleted-since"], chars });
    logAt(store, "2026-06-01T10:01:00Z", { ev: "fire", ...s1, agent: "agent-7", kind: "path", form: "title", note: "c", tool: "Read", match: "src/ledger.ts" });
    logAt(store, "2026-06-01T10:02:00Z", { ev: "show", ...s1, note: "b", why: "task" });
    logAt(store, "2026-06-01T10:03:00Z", { ev: "show", ...s1, note: "b", why: "check" });
    logAt(store, "2026-06-01T10:04:00Z", { ev: "search", ...s1, query: "ledger rows", hits: 2, why: "check" });
    logAt(store, "2026-06-01T10:05:00Z", { ev: "write", ...s1, note: "in-trash", op: "trash" });
    logAt(store, "2026-06-01T10:06:00Z", { ev: "verdict", ...s1, note: "a", verdict: "not-needed" });
    // A second verdict in the same session replaces the first.
    logAt(store, "2026-06-01T10:07:00Z", { ev: "verdict", ...s1, note: "a", verdict: "helped" });
    logAt(store, "2026-06-01T10:08:00Z", { ev: "checkpoint", ...s1 });
    logAt(store, "2026-07-01T09:00:00Z", { ev: "start", session: "s2", scope: SCOPE, source: "clear", bodies: ["a", "b"], index: [], hidden: ["c"], chars });
    logAt(store, "2026-07-01T09:30:00Z", { ev: "unsaved", session: "s2", reason: "clear" });
    return store;
  }
  const zero = { body: 0, index: 0, hidden: 0, opened: { task: 0, check: 0 }, fired: 0, verdicts: { helped: 0, "not-needed": 0, wrong: 0 } };

  test("--json has one row per note: how often it was a body, a line, hidden, opened, fired, and its verdicts", () => {
    const store = fixture();
    const json = kb(store, ["log", "--json"]).json;
    expect(json).toEqual({
      since: null,
      from: "2026-06-01T10:00:00Z",
      to: "2026-07-01T09:30:00Z",
      events: 11,
      sessions: 2,
      starts: 2,
      searches: { task: 0, check: 1 },
      checkpoints: 1,
      unsaved: 1,
      notes: [
        { id: "a", scope: SCOPE, kind: "gotcha", state: "active", ...zero, body: 2, verdicts: { helped: 1, "not-needed": 0, wrong: 0 }, last_activity: "2026-06-01T10:07:00Z" },
        { id: "b", scope: SCOPE, kind: "decision", state: "active", ...zero, body: 1, index: 1, opened: { task: 1, check: 1 }, last_activity: "2026-06-01T10:02:00Z" },
        { id: "c", scope: "global", kind: "gotcha", state: "active", ...zero, hidden: 2, fired: 1, last_activity: "2026-06-01T10:01:00Z" },
        // A note that is gone still has its history, and a note in the trash says so.
        { id: "deleted-since", scope: null, kind: null, state: "gone", ...zero, hidden: 1, last_activity: null },
        { id: "in-trash", scope: "global", kind: "gotcha", state: "trash", ...zero, last_activity: null },
        // An active note that no session got is a row of zeros, not a gap.
        { id: "quiet", scope: "global", kind: "gotcha", state: "active", ...zero, last_activity: null },
      ],
    });
    const text = kb(store, ["log"]).stdout;
    expect(text).toContain("2 sessions, 2 starts, 1 checkpoint, 1 unsaved | searches: 0 for a task, 1 as a check");
    expect(text).toMatch(/^id +body +index +hidden +opened +checked +fired +helped +not-needed +wrong$/m);
    expect(text).toMatch(/^b +1 +1 +0 +1 +1 +0 +0 +0 +0$/m);
    expect(text).not.toMatch(/^quiet/m);
    expect(text).toContain("1 active note has no event.");
  });

  test("--since takes the events of the last days only", () => {
    const store = fixture();
    const days = (iso: string) => String(Math.ceil((Date.now() - Date.parse(iso)) / 86_400_000));
    const json = kb(store, ["log", "--since", days("2026-06-15T00:00:00Z"), "--json"]).json;
    expect(json).toMatchObject({ from: "2026-07-01T09:00:00Z", events: 2, sessions: 1, starts: 1, checkpoints: 0, unsaved: 1 });
    expect(json.since > "2026-06-01" && json.since < "2026-07-01").toBe(true);
    expect(json.notes.find((n: any) => n.id === "a")).toMatchObject({ body: 1, verdicts: { helped: 0 } });
    for (const bad of ["0", "-3", "soon"]) expect(kb(store, ["log", "--since", bad]).code).toBe(1);
  });

  test("--session gives one session in time order, and the notes it got and has not judged", () => {
    const store = fixture();
    const json = kb(store, ["log", "--session", "s1", "--json"]).json;
    expect(json).toMatchObject({ session: "s1", scope: SCOPE, from: "2026-06-01T10:00:00Z", to: "2026-06-01T10:08:00Z", events: 9, sessions: 1, starts: 1 });
    expect(json.timeline.map((e: any) => e.ev)).toEqual(["start", "fire", "show", "show", "search", "write", "verdict", "verdict", "checkpoint"]);
    expect(json.timeline[1]).toEqual({ t: "2026-06-01T10:01:00Z", ev: "fire", session: "s1", agent: "agent-7", scope: SCOPE, kind: "path", form: "title", note: "c", tool: "Read", match: "src/ledger.ts" });
    expect(json.notes.map((n: any) => n.id)).toEqual(["a", "b", "c", "deleted-since", "in-trash"]);
    // "a" has a verdict. "b" was opened for a task and "c" came from a hook: both wait for one.
    expect(json.unjudged).toEqual(["b", "c"]);
    const text = kb(store, ["log", "--session", "s1"]).stdout;
    expect(text).toMatch(/^session s1 \| github\.com\/acme\/billing \| .* \| 9 events$/m);
    expect(text).toMatch(/  start +startup: 1 body, 1 index line, 2 hidden, 1000 characters$/m);
    expect(text).toMatch(/  fire +c \(Read of src\/ledger\.ts\)  \[agent agent-7\]$/m);
    expect(text).toMatch(/  search +"ledger rows": 2 notes \(check\)$/m);
    expect(text).toMatch(/  verdict +helped a$/m);
    expect(text).toContain("no verdict yet:\n- b | opened | The title of b\n- c | fired | Title of c\n");
    // A session with no event, and a store with no log.
    expect(kb(store, ["log", "--session", "nobody", "--json"]).json).toMatchObject({ session: "nobody", scope: null, events: 0, notes: [], unjudged: [], timeline: [] });
    expect(kb(tempStore(), ["log", "--json"]).json).toMatchObject({ from: null, events: 0, notes: [] });
    expect(kb(join(tempDir(), "missing"), ["log"]).stdout).toBe("log  no events | 0 sessions, 0 starts, 0 checkpoints, 0 unsaved | searches: 0 for a task, 0 as a check\n");
  });
});

describe("kb trash, delete, list", () => {

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
    expect(kb(store, ["list", "--trash", "--json"]).json.map((n: { id: string }) => n.id)).toEqual(["recent"]);
    expect(store.find("expired")).toBeUndefined();
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
    kb(store, ["verdict", "helped", "wrong"]);
    // One unknown id stops the whole command, so nothing is half done.
    expect(kb(store, ["delete", "wrong", "ghost"]).code).toBe(1);
    expect(store.find("wrong")).toBeDefined();
    expect(kb(store, ["delete", "wrong", "old", "--json"]).json).toEqual({ deleted: ["wrong", "old"] });
    expect([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.id)).toEqual(["keep"]);
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("kb: delete wrong old");
    // The log of this machine has activity of "wrong", so a new note with that title must not inherit it.
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Wrong", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("wrong-2");
    // Nor the counters that an older kb recorded for "old", on any machine.
    legacyUsage(store, "othermachine", { old: { uses: 9 } });
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Old", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("old-2");
    // Nor the activity or a verdict that another machine rolled up, also for a note that never was here.
    otherMachine(store, "machine-b", { elsewhere: { last: "2026-01-01T00:00:00Z" }, "judged-elsewhere": { wrong: "2026-01-01T00:00:00Z" } });
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Elsewhere", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("elsewhere-2");
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Judged elsewhere", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("judged-elsewhere-2");
    // The delete is an event in the log of this machine, so the id of a deleted note stays taken here.
    expect(kb(store, ["delete", "keep"]).code).toBe(0);
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Keep", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("keep-2");
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
    expect(kb(store, ["delete", "--scope", web, "--json"]).json).toEqual({ scope: web, deleted: ["a", "old"] });
    expect([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.id)).toEqual(["other"]);
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
    for (const args of [["context"], ["scope"], ["show", "a"], ["search", "body"], ["list"], ["verdict", "helped", "a"], ["use", "a"], ["log"], ["log", "--session", "s"], ["trash", "a"], ["restore", "a"], ["empty-trash"], ["html"], ["sync"], ["stale"], ["verify", "a"], ["budget"], ["checkpointed", "s"], ["unsaved"], ["unsaved", "--forget", "s"], ["show", "zzz"], ["bogus"]]) {
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

  // A search for "webhook retry" answered "no match" for a note about "retries", and a twin followed.
  test("a word finds its other forms: the plural, the past and the -ing form", () => {
    const store = tempStore();
    putNote(store, { id: "retries", title: "The provider retries a webhook for 3 days", body: "Each retry has the same event id." });
    putNote(store, { id: "migrations", title: "Run migrations on a local copy", body: "Never on the shared database." });
    putNote(store, { id: "cache", title: "Cached pages keep the old header", body: "Purge after a deploy." });
    const ids = (query: string) => [...new Set(search(store, query).map((h) => h.id))];
    expect(ids("webhook retry")).toEqual(["retries"]);
    expect(ids("retrying webhooks")).toEqual(["retries"]);
    expect(ids("migration")).toEqual(["migrations"]);
    expect(ids("migrations")).toEqual(["migrations"]);
    expect(ids("copies migration")).toEqual(["migrations"]);
    expect(ids("caching page")).toEqual(["cache"]);
    expect(ids("deployed purging")).toEqual(["cache"]);
    // The text of a word still matches inside a longer word, and a query that is no plain word matches as text.
    expect(ids("migr")).toEqual(["migrations"]);
    putNote(store, { id: "raw", title: "Mount express.raw() first", body: "Before the JSON parser." });
    expect(ids("express.raw()")).toEqual(["raw"]);
    // The line that holds the other form is the hit, in the same output format.
    expect(kb(store, ["search", "retry", "days"]).stdout.trimEnd().split("\n")).toEqual(["retries | global | The provider retries a webhook for 3 days", "  11: Each retry has the same event id."]);
    // The closest-match answer counts a form as the word.
    expect(kb(store, ["search", "webhook", "retry", "zebra"]).stdout).toStartWith("no note has every word. Closest:\nretries | ");
  });
});
