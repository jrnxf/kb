import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastActivity } from "../cli/log.ts";
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
    expect(Object.keys(kb(store, ["list", "--json"]).json[0])).toEqual(["id", "kind", "scope", "title", "last_verified", "confidence", "promoted_to"]);
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
    expect(kb(store, ["verdict", "helped", "a", "--json"], { env }).json).toEqual({ verdict: "helped", notes: ["a"], unknown: [] });
    expect(kb(store, ["verdict", "not-needed", "b", "ghost", "b"], { env }).stdout).toBe("not-needed: b\nunknown ghost\n");
    // A session may judge a note it trashed a moment ago.
    expect(kb(store, ["verdict", "wrong", "trashed"], { env }).code).toBe(0);
    expect(kb(store, ["use", "a", "b", "--json"], { env }).json).toEqual({ verdict: "helped", notes: ["a", "b"], unknown: [] });
    expect(logged(store)).toEqual([
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
    expect(logged(store)).toHaveLength(5);
    // The help names verdict, not use.
    const help = kb(store, ["help"]).stdout;
    expect(help).toContain("kb verdict <helped|not-needed|wrong> <id>...");
    expect(help).not.toMatch(/kb use|--no-use|\buses\b/);
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
    // An id with no history is free again.
    expect(kb(store, ["delete", "keep"]).code).toBe(0);
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ title: "Keep", kind: "gotcha", body: "x", scope: "global" }) }).json.id).toBe("keep");
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
    for (const args of [["context"], ["scope"], ["show", "a"], ["search", "body"], ["list"], ["verdict", "helped", "a"], ["use", "a"], ["log"], ["log", "--session", "s"], ["trash", "a"], ["restore", "a"], ["empty-trash"], ["html"], ["sync"], ["stale"], ["verify", "a"], ["budget"], ["checkpointed", "s"], ["show", "zzz"], ["bogus"]]) {
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
