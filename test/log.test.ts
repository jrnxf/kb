import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { idsWithHistory, judgments, lastActivity, logEvent, readLog, rollUp, sessionOf, setActor, summarize } from "../cli/log.ts";
import { Store } from "../cli/store.ts";
import { ROOT, kb, legacyUsage, logAt, logged, otherMachine, putNote, sh, tempDir, tempStore } from "./helpers.ts";

const logDir = (store: Store) => join(store.home, ".state", "log");
const lines = (store: Store, month: string) => readFileSync(join(logDir(store), `${month}.jsonl`), "utf8").split("\n").filter(Boolean);

describe("the event log", () => {
  test("an event is one JSON line with its time, in the file of its month", () => {
    const store = tempStore();
    expect(logAt(store, "2026-01-31T23:59:59.500Z", { ev: "show", session: "s1", scope: "global", note: "a", why: "task" })).toBe(true);
    expect(logAt(store, "2026-02-01T00:00:00Z", { ev: "checkpoint", session: "s1" })).toBe(true);
    expect(readdirSync(logDir(store)).sort()).toEqual(["2026-01.jsonl", "2026-02.jsonl"]);
    // The time comes first, then the name, then who. A field that is not known is left out.
    expect(lines(store, "2026-01")).toEqual(['{"t":"2026-01-31T23:59:59Z","ev":"show","session":"s1","scope":"global","note":"a","why":"task"}']);
    expect(lines(store, "2026-02")).toEqual(['{"t":"2026-02-01T00:00:00Z","ev":"checkpoint","session":"s1"}']);
    expect(readLog(store).map((e) => e.t)).toEqual(["2026-01-31T23:59:59Z", "2026-02-01T00:00:00Z"]);
  });

  test("several events go in one append, and an empty list writes nothing", () => {
    const store = tempStore();
    expect(logEvent(store, [])).toBe(false);
    expect(existsSync(logDir(store))).toBe(false);
    expect(logEvent(store, [{ ev: "write", note: "a", op: "trash" }, { ev: "write", note: "b", op: "trash" }])).toBe(true);
    expect(logged(store)).toEqual([{ ev: "write", note: "a", op: "trash" }, { ev: "write", note: "b", op: "trash" }]);
  });

  test("it never throws and never creates a store: no store, a log folder that is a file, a session that cannot be found", () => {
    const missing = new Store(join(tempDir(), "missing"));
    expect(logEvent(missing, { ev: "checkpoint" })).toBe(false);
    expect(existsSync(missing.home)).toBe(false);
    expect(readLog(missing)).toEqual([]);
    expect(lastActivity(missing).size).toBe(0);

    const blocked = tempStore();
    mkdirSync(join(blocked.home, ".state"));
    writeFileSync(logDir(blocked), "a file where the folder should be");
    expect(logEvent(blocked, { ev: "checkpoint" })).toBe(false);
    expect(readLog(blocked)).toEqual([]);
    expect(lastActivity(blocked).size).toBe(0);

    // The session of the command comes from a function. If it throws, the event has no session.
    const store = tempStore();
    setActor(() => {
      throw new Error("no git here");
    });
    try {
      expect(logEvent(store, { ev: "show", note: "a", why: "task" })).toBe(true);
    } finally {
      setActor(() => ({}));
    }
    expect(logged(store)).toEqual([{ ev: "show", note: "a", why: "task" }]);
  });

  test("an event names the session of the command, unless it names its own", () => {
    const store = tempStore();
    setActor(() => ({ session: "from-command", scope: "github.com/acme/billing" }));
    try {
      logEvent(store, { ev: "show", note: "a", why: "task" });
      logEvent(store, { ev: "checkpoint", session: "named" });
    } finally {
      setActor(() => ({}));
    }
    expect(logged(store)).toEqual([
      { ev: "show", session: "from-command", scope: "github.com/acme/billing", note: "a", why: "task" },
      { ev: "checkpoint", session: "named", scope: "github.com/acme/billing" },
    ]);
  });

  test("the session id is the --session flag, else KB_SESSION, else the id of the harness, and an id that is not a short text is no id", () => {
    const harness = { CLAUDE_CODE_SESSION_ID: "harness" };
    expect(sessionOf("flag", { KB_SESSION: "env", ...harness })).toBe("flag");
    expect(sessionOf(undefined, { KB_SESSION: "env", ...harness })).toBe("env");
    expect(sessionOf(undefined, harness)).toBe("harness");
    expect(sessionOf(undefined, {})).toBeUndefined();
    // A flag with no value parses as true.
    expect(sessionOf(true, { KB_SESSION: "env" })).toBe("env");
    expect(sessionOf("", { KB_SESSION: "x".repeat(201) })).toBeUndefined();
  });

  test("the first event of a store made by an older version keeps .state out of git", () => {
    const store = tempStore();
    writeFileSync(join(store.home, ".gitignore"), "INDEX.md\nlocal.json\n");
    sh(store.home, "git", "init", "-q", "-b", "main");
    logEvent(store, { ev: "show", note: "a", why: "task" });
    expect(readFileSync(join(store.home, ".gitignore"), "utf8").split("\n")).toContain(".state/");
    expect(sh(store.home, "git", "status", "--porcelain", "--ignored")).toContain("!! .state/");
  });

  test("sessions that append at the same time each add whole lines, and none is lost", async () => {
    const store = tempStore();
    const WRITERS = 8;
    const EVENTS = 150;
    // Each writer adds long lines, as a session start does, and short ones.
    const script = `
      import { logEvent } from ${JSON.stringify(join(ROOT, "cli", "log.ts"))};
      import { Store } from ${JSON.stringify(join(ROOT, "cli", "store.ts"))};
      const store = new Store(process.env.KB_HOME);
      const ids = Array.from({ length: 200 }, (_, i) => "a-note-with-a-long-id-like-a-real-one-" + i);
      const chars = { fixed: 1, index: 2, bodies: 3, total: 6 };
      for (let n = 0; n < ${EVENTS}; n++) {
        const ok = n % 3 === 0
          ? logEvent(store, { ev: "start", session: process.env.WRITER, source: String(n), bodies: ids.slice(0, 5), index: ids.slice(5, 60), hidden: ids.slice(60), chars })
          : logEvent(store, { ev: "search", session: process.env.WRITER, query: "q", hits: n, why: "task" });
        if (!ok) process.exit(1);
      }`;
    const writers = Array.from({ length: WRITERS }, (_, w) => Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, KB_HOME: store.home, WRITER: `w${w}` }, stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(writers.map((p) => p.exited))).toEqual(Array(WRITERS).fill(0));

    const raw = readdirSync(logDir(store)).flatMap((name) => readFileSync(join(logDir(store), name), "utf8").split("\n").filter(Boolean));
    expect(raw).toHaveLength(WRITERS * EVENTS);
    // Every line is a whole event: none was cut by the line of another writer.
    const events = raw.map((line) => JSON.parse(line));
    for (let w = 0; w < WRITERS; w++) {
      const own = events.filter((e) => e.session === `w${w}`);
      // Each writer's events are all there, in the order it wrote them.
      expect(own.map((e) => (e.ev === "start" ? Number(e.source) : e.hits))).toEqual(Array.from({ length: EVENTS }, (_, n) => n));
      expect(own.filter((e) => e.ev === "start").every((e) => e.hidden.length === 140)).toBe(true);
    }
    expect(readLog(store)).toHaveLength(WRITERS * EVENTS);
  });

  test("a reader skips a line that does not parse, and keeps every other line", () => {
    const store = tempStore();
    logAt(store, "2026-03-01T10:00:00Z", { ev: "show", session: "s1", note: "a", why: "task" });
    const file = join(logDir(store), "2026-03.jsonl");
    appendFileSync(file, 'not json at all\n{"t":"2026-03-01T10:01:00Z","ev":"show","note":"cut by a cra\n\n[1,2]\nnull\n"text"\n{"ev":"show","note":"no time"}\n{"t":5,"ev":"show"}\n');
    logAt(store, "2026-03-01T10:02:00Z", { ev: "verdict", session: "s1", note: "a", verdict: "helped" });
    // An event of a later kb, and a start with a field of the wrong shape, are kept and do no harm.
    appendFileSync(file, '{"t":"2026-03-01T10:03:00Z","ev":"fire","kind":"prompt","form":"brief","note":"b","session":"s1"}\n{"t":"2026-03-01T10:04:00Z","ev":"start","bodies":"a","index":[1,"b"],"session":"s1"}\n{"t":"2026-03-01T10:05:00Z","ev":"tomorrow","note":"z"}\n');
    const events = readLog(store);
    expect(events.map((e): string => e.ev)).toEqual(["show", "verdict", "fire", "start", "tomorrow"]);
    const summary = summarize(events);
    expect(summary).toMatchObject({ events: 5, sessions: 1, starts: 1, from: "2026-03-01T10:00:00Z", to: "2026-03-01T10:05:00Z" });
    expect(summary.notes).toEqual([
      { id: "a", body: 0, index: 0, hidden: 0, opened: { task: 1, check: 0 }, fired: 0, verdicts: { helped: 1, "not-needed": 0, wrong: 0 } },
      { id: "b", body: 0, index: 1, hidden: 0, opened: { task: 0, check: 0 }, fired: 1, verdicts: { helped: 0, "not-needed": 0, wrong: 0 } },
    ]);
    expect(lastActivity(store)).toEqual(new Map([["a", "2026-03-01T10:02:00Z"], ["b", "2026-03-01T10:03:00Z"]]));
  });

  test("readLog takes a session and a start time, and gives time order across the files", () => {
    const store = tempStore();
    logAt(store, "2026-05-02T00:00:00Z", { ev: "show", session: "s2", note: "late", why: "task" });
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", session: "s1", note: "early", why: "task" });
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", session: "s1", note: "mid", why: "task" });
    const notes = (filter?: Parameters<typeof readLog>[1]) => readLog(store, filter).map((e) => (e as { note?: string }).note);
    expect(notes()).toEqual(["early", "mid", "late"]);
    expect(notes({ session: "s1" })).toEqual(["early", "mid"]);
    expect(notes({ since: new Date("2026-05-01T00:00:00Z") })).toEqual(["mid", "late"]);
    expect(notes({ since: new Date("2026-05-01T00:00:01Z"), session: "s1" })).toEqual([]);
  });

  test("readLog of a session takes the exact id, also an id with a quote, and skips a line it cannot parse", () => {
    const store = tempStore();
    const odd = 'a "quoted" id\\with a backslash';
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", session: "s1", note: "one", why: "task" });
    // "s1" is a part of these lines, and none of them belongs to the session s1.
    logAt(store, "2026-05-01T00:01:00Z", { ev: "show", session: "s10", note: "ten", why: "task" });
    logAt(store, "2026-05-01T00:02:00Z", { ev: "search", session: "other", query: "s1", hits: 0, why: "task" });
    logAt(store, "2026-05-01T00:03:00Z", { ev: "show", session: odd, note: "odd", why: "task" });
    appendFileSync(join(logDir(store), "2026-05.jsonl"), '{"t":"2026-05-01T00:04:00Z","ev":"show","session":"s1","note":"cut by a cra\n{"t":"2026-05-01T00:05:00Z","ev":"show", "session": "s1", "note": "by hand"}\n');
    const notes = (session: string) => readLog(store, { session }).map((e) => (e as { note?: string }).note);
    expect(notes("s1")).toEqual(["one", "by hand"]);
    expect(notes("s10")).toEqual(["ten"]);
    expect(notes(odd)).toEqual(["odd"]);
    expect(notes("s")).toEqual([]);
  });
});

describe("the summary of the log", () => {
  test("counts each start by form, opens by why, fires, and one verdict per session and note", () => {
    const store = tempStore();
    const chars = { fixed: 1, index: 1, bodies: 1, total: 3 };
    logAt(store, "2026-03-01T10:00:00Z", { ev: "start", session: "s1", source: "startup", bodies: ["a"], index: ["b"], hidden: ["c"], chars });
    logAt(store, "2026-03-01T11:00:00Z", { ev: "start", session: "s1", source: "compact", bodies: ["a", "b"], index: [], hidden: ["c"], chars });
    logAt(store, "2026-03-01T11:01:00Z", { ev: "verdict", session: "s1", note: "a", verdict: "wrong" });
    logAt(store, "2026-03-01T11:02:00Z", { ev: "verdict", session: "s1", note: "a", verdict: "helped" });
    logAt(store, "2026-03-01T11:03:00Z", { ev: "verdict", session: "s2", note: "a", verdict: "helped" });
    // A subagent judges for itself.
    logAt(store, "2026-03-01T11:04:00Z", { ev: "verdict", session: "s2", agent: "sub", note: "a", verdict: "not-needed" });
    // A verdict with no session cannot be matched to one. The same verdict on the same note on the
    // same day counts once, so a command that runs twice does not count twice. Another day counts again.
    logAt(store, "2026-03-01T11:05:00Z", { ev: "verdict", note: "a", verdict: "wrong" });
    logAt(store, "2026-03-01T11:06:00Z", { ev: "verdict", note: "a", verdict: "wrong" });
    logAt(store, "2026-03-02T11:06:00Z", { ev: "verdict", note: "a", verdict: "wrong" });
    logAt(store, "2026-03-02T11:07:00Z", { ev: "search", session: "s2", query: "q", hits: 3, why: "task" });
    logAt(store, "2026-03-02T11:08:00Z", { ev: "write", session: "s2", note: "new", op: "add" });
    const summary = summarize(readLog(store));
    expect(summary).toMatchObject({ events: 11, sessions: 2, starts: 2, searches: { task: 1, check: 0 }, checkpoints: 0, unsaved: 0 });
    expect(summary.notes.map((n) => n.id)).toEqual(["a", "b", "c", "new"]);
    expect(summary.notes[0]).toMatchObject({ body: 2, index: 0, hidden: 0, verdicts: { helped: 2, "not-needed": 1, wrong: 2 } });
    expect(summary.notes[1]).toMatchObject({ body: 1, index: 1 });
    expect(summary.notes[2]).toMatchObject({ hidden: 2 });
    expect(summarize([])).toMatchObject({ from: null, to: null, events: 0, notes: [] });
  });

  test("takes a line of any shape: an empty id, a missing note, a number where a text belongs", () => {
    const store = tempStore();
    logAt(store, "2026-03-01T10:00:00Z", { ev: "show", session: "s1", note: "a", why: "task" });
    appendFileSync(
      join(logDir(store), "2026-03.jsonl"),
      [
        { t: "2026-03-01T10:01:00Z", ev: "start", session: "s1", bodies: ["", "a"], index: [""], hidden: ["", 7, null, "b"] },
        { t: "2026-03-01T10:02:00Z", ev: "start", session: 5, bodies: null, index: {}, hidden: "c" },
        { t: "2026-03-01T10:03:00Z", ev: "show", why: "task" },
        { t: "2026-03-01T10:04:00Z", ev: "show", note: "", why: "task" },
        { t: "2026-03-01T10:05:00Z", ev: "show", note: 5, why: 5 },
        { t: "2026-03-01T10:06:00Z", ev: "fire" },
        { t: "2026-03-01T10:07:00Z", ev: "fire", note: ["a"] },
        { t: "2026-03-01T10:08:00Z", ev: "verdict", verdict: "helped" },
        { t: "2026-03-01T10:09:00Z", ev: "verdict", note: 5, verdict: "helped" },
        { t: "2026-03-01T10:10:00Z", ev: "verdict", note: "a", verdict: 5, session: { id: 1 } },
        { t: "2026-03-01T10:11:00Z", ev: "write", op: "add" },
        { t: "2026-03-01T10:12:00Z", ev: "search", query: 5, hits: "many", why: null },
      ].map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    const summary = summarize(readLog(store));
    expect(summary).toMatchObject({ events: 13, sessions: 1, starts: 2, searches: { task: 0, check: 0 } });
    expect(summary.notes).toEqual([
      { id: "a", body: 1, index: 0, hidden: 0, opened: { task: 1, check: 0 }, fired: 0, verdicts: { helped: 0, "not-needed": 0, wrong: 0 } },
      { id: "b", body: 0, index: 0, hidden: 1, opened: { task: 0, check: 0 }, fired: 0, verdicts: { helped: 0, "not-needed": 0, wrong: 0 } },
    ]);
    expect(lastActivity(store)).toEqual(new Map([["a", "2026-03-01T10:00:00Z"]]));
    expect(judgments(store).size).toBe(0);
    // The commands that read the log print every line, and none fails.
    expect(kb(store, ["log", "--json"]).json).toMatchObject({ events: 13, starts: 2 });
    const session = kb(store, ["log", "--session", "s1"]);
    expect(session.code).toBe(0);
    expect(session.stdout).toMatch(/^session s1 \| scope unknown \| .* \| 2 events$/m);
  });
});

describe("last activity", () => {
  test("is the newest of a show for a task, a fire, a verdict helped and the last_used of an older kb", () => {
    const store = tempStore();
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "shown", why: "task" });
    logAt(store, "2026-03-05T00:00:00Z", { ev: "show", note: "shown", why: "task" });
    logAt(store, "2026-03-02T00:00:00Z", { ev: "show", note: "shown", why: "task" });
    logAt(store, "2026-03-03T00:00:00Z", { ev: "fire", kind: "path", form: "title", note: "fired", tool: "Read", match: "a.ts" });
    logAt(store, "2026-03-04T00:00:00Z", { ev: "verdict", note: "helped", verdict: "helped" });
    legacyUsage(store, "machine-a", { old: { uses: 3, last_used: "2026-01-01T00:00:00Z" }, shown: { uses: 1, last_used: "2026-02-01T00:00:00Z" }, both: { uses: 1, last_used: "2026-04-01T00:00:00Z" } });
    legacyUsage(store, "machine-b", { old: { uses: 1, last_used: "2026-01-09T00:00:00Z" }, never: { uses: 0 } });
    logAt(store, "2026-03-06T00:00:00Z", { ev: "show", note: "both", why: "task" });
    // None of these is activity: a check, a look into the trash, the two other verdicts, a write, a start.
    logAt(store, "2026-06-01T00:00:00Z", { ev: "show", note: "checked", why: "check" });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "show", note: "in-the-trash", why: "task", trashed: true });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "verdict", note: "judged", verdict: "not-needed" });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "verdict", note: "judged", verdict: "wrong" });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "write", note: "written", op: "update" });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "start", source: "startup", bodies: ["loaded"], index: ["loaded-2"], hidden: [], chars: { fixed: 0, index: 0, bodies: 0, total: 0 } });
    expect([...lastActivity(store)].sort()).toEqual([
      ["both", "2026-04-01T00:00:00Z"],
      ["fired", "2026-03-03T00:00:00Z"],
      ["helped", "2026-03-04T00:00:00Z"],
      ["old", "2026-01-09T00:00:00Z"],
      ["shown", "2026-03-05T00:00:00Z"],
    ]);
  });

  test("reads only the new lines of the log each time, and gives the same answer as a full read", () => {
    const store = tempStore();
    const cache = join(logDir(store), "activity.json");
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "a", why: "task" });
    expect(lastActivity(store).get("a")).toBe("2026-03-01T00:00:00Z");
    const file = join(logDir(store), "2026-03.jsonl");
    expect(JSON.parse(readFileSync(cache, "utf8"))).toEqual({ read: { "2026-03.jsonl": readFileSync(file).length }, last: [["a", "2026-03-01T00:00:00Z"]] });

    logAt(store, "2026-03-02T00:00:00Z", { ev: "show", note: "b", why: "task" });
    logAt(store, "2026-04-01T00:00:00Z", { ev: "show", note: "a", why: "task" });
    expect([...lastActivity(store)].sort()).toEqual([["a", "2026-04-01T00:00:00Z"], ["b", "2026-03-02T00:00:00Z"]]);

    // A line that another session writes right now has no end yet: it counts when it is whole.
    appendFileSync(file, '{"t":"2026-03-09T00:00:00Z","ev":"show","note":"c","why":"ta');
    expect(lastActivity(store).has("c")).toBe(false);
    appendFileSync(file, 'sk"}\n');
    expect(lastActivity(store).get("c")).toBe("2026-03-09T00:00:00Z");

    // A cache that is broken, or a log that somebody cut by hand, gives a full read.
    writeFileSync(cache, "{broken");
    expect([...lastActivity(store).keys()].sort()).toEqual(["a", "b", "c"]);
    writeFileSync(file, '{"t":"2026-03-01T00:00:00Z","ev":"show","note":"b","why":"task"}\n');
    expect([...lastActivity(store)].sort()).toEqual([["a", "2026-04-01T00:00:00Z"], ["b", "2026-03-01T00:00:00Z"]]);
    rmSync(join(logDir(store), "2026-04.jsonl"));
    expect([...lastActivity(store)]).toEqual([["b", "2026-03-01T00:00:00Z"]]);
    rmSync(cache);
    expect([...lastActivity(store)]).toEqual([["b", "2026-03-01T00:00:00Z"]]);
  });

  test("stays fast with a log of many sessions", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const ids = Array.from({ length: 150 }, (_, i) => `a-note-with-a-long-id-like-a-real-one-${i}`);
    const chars = { fixed: 1, index: 2, bodies: 3, total: 6 };
    // About 2,700 session starts, each with the ids of a large store, and some reads.
    const batch = Array.from({ length: 100 }, (_, i) => (i % 10 === 9 ? { ev: "show" as const, note: ids[i]!, why: "task" as const } : { ev: "start" as const, source: "startup", bodies: ids.slice(0, 5), index: ids.slice(5, 65), hidden: ids.slice(65), chars }));
    for (let i = 0; i < 30; i++) logEvent(store, batch, new Date(`2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`));
    lastActivity(store); // the first read builds the cache
    logAt(store, "2026-03-31T00:00:00Z", { ev: "show", note: "a", why: "task" });
    const started = performance.now();
    expect(lastActivity(store).get("a")).toBe("2026-03-31T00:00:00Z");
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("the roll-up of the log", () => {
  const rolled = (store: Store) => join(store.home, "activity", `${store.local().machine}.json`);
  const day = (date: string) => new Date(`${date}T12:00:00Z`);

  test("is one file per machine: the last activity of each note, and the verdicts that count", () => {
    const store = tempStore();
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "shown", why: "task" });
    logAt(store, "2026-03-02T00:00:00Z", { ev: "fire", kind: "path", form: "title", note: "shown", tool: "Read", match: "a.ts" });
    logAt(store, "2026-03-03T00:00:00Z", { ev: "verdict", session: "s1", note: "judged", verdict: "wrong" });
    logAt(store, "2026-03-04T00:00:00Z", { ev: "verdict", session: "s2", note: "judged", verdict: "helped" });
    // A session that corrects its verdict judged the note once: the last verdict counts.
    logAt(store, "2026-03-05T00:00:00Z", { ev: "verdict", session: "s3", note: "corrected", verdict: "wrong" });
    logAt(store, "2026-03-05T00:01:00Z", { ev: "verdict", session: "s3", note: "corrected", verdict: "not-needed" });
    // Only the newest three "not-needed" are kept: the rule needs no more.
    for (const [i, session] of ["s4", "s5", "s6", "s7"].entries()) logAt(store, `2026-03-0${6 + i}T00:00:00Z`, { ev: "verdict", session, note: "idle", verdict: "not-needed" });
    // None of these is in the roll-up: a check, a search, a write, a start.
    logAt(store, "2026-03-10T00:00:00Z", { ev: "show", note: "checked", why: "check" });
    logAt(store, "2026-03-10T00:00:00Z", { ev: "write", note: "written", op: "add" });

    expect(rollUp(store, day("2026-03-11"))).toBe(true);
    expect(readdirSync(join(store.home, "activity"))).toEqual([`${store.local().machine}.json`]);
    expect(store.local().machine).toMatch(/^[0-9a-f]{8}$/);
    // One line per note, in id order.
    expect(readFileSync(rolled(store), "utf8")).toBe(
      [
        "{",
        '"v": 1,',
        '"notes": {',
        '"corrected": {"not_needed":["2026-03-05T00:01:00Z"]},',
        '"idle": {"not_needed":["2026-03-09T00:00:00Z","2026-03-08T00:00:00Z","2026-03-07T00:00:00Z"]},',
        '"judged": {"last":"2026-03-04T00:00:00Z","helped":"2026-03-04T00:00:00Z","wrong":"2026-03-03T00:00:00Z"},',
        '"shown": {"last":"2026-03-02T00:00:00Z"}',
        "}",
        "}",
        "",
      ].join("\n"),
    );
    expect(JSON.parse(readFileSync(rolled(store), "utf8")).v).toBe(1);
  });

  test("is written at most once per day, and only when it changed", () => {
    const store = tempStore();
    // A store with no log gets no file and no machine id.
    expect(rollUp(store, day("2026-03-01"))).toBe(false);
    expect(existsSync(join(store.home, "activity"))).toBe(false);
    expect(existsSync(join(store.home, "local.json"))).toBe(false);
    // A log with no activity gives no file either.
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "a", why: "check" });
    expect(rollUp(store, day("2026-03-01"))).toBe(false);
    expect(existsSync(join(store.home, "activity"))).toBe(false);

    logAt(store, "2026-03-01T13:00:00Z", { ev: "show", note: "a", why: "task" });
    // The check of this day is done, so the new activity waits for the next day.
    expect(rollUp(store, day("2026-03-01"))).toBe(false);
    expect(existsSync(join(store.home, "activity"))).toBe(false);
    expect(rollUp(store, day("2026-03-02"))).toBe(true);
    const first = readFileSync(rolled(store), "utf8");
    expect(first).toContain('"a": {"last":"2026-03-01T13:00:00Z"}');
    // A day with nothing new leaves the file as it is, so the store has nothing to commit.
    logAt(store, "2026-03-02T13:00:00Z", { ev: "show", note: "a", why: "check" });
    expect(rollUp(store, day("2026-03-03"))).toBe(false);
    expect(readFileSync(rolled(store), "utf8")).toBe(first);
    logAt(store, "2026-03-03T13:00:00Z", { ev: "show", note: "a", why: "task" });
    expect(rollUp(store, day("2026-03-04"))).toBe(true);
    expect(readFileSync(rolled(store), "utf8")).toContain('"a": {"last":"2026-03-03T13:00:00Z"}');
    // git ignores the mark of the day and the log, and tracks the roll-up.
    sh(store.home, "git", "init", "-q", "-b", "main");
    expect(sh(store.home, "git", "status", "--porcelain", "-uall")).toContain(`?? activity/${store.local().machine}.json`);
    expect(sh(store.home, "git", "status", "--porcelain", "-uall")).not.toContain(".state");
  });

  test("the log keeps 12 months: an older monthly file is removed, and its last activity stays in the roll-up", () => {
    const store = tempStore();
    logAt(store, "2025-02-10T00:00:00Z", { ev: "show", note: "old", why: "task" });
    logAt(store, "2025-02-11T00:00:00Z", { ev: "verdict", session: "s1", note: "old", verdict: "wrong" });
    logAt(store, "2025-03-10T00:00:00Z", { ev: "show", note: "edge", why: "task" });
    logAt(store, "2026-03-10T00:00:00Z", { ev: "show", note: "new", why: "task" });
    const months = () => readdirSync(logDir(store)).filter((name) => name.endsWith(".jsonl")).sort();
    // In February 2026 every file is 12 months old or less.
    rollUp(store, day("2026-02-28"));
    expect(months()).toEqual(["2025-02.jsonl", "2025-03.jsonl", "2026-03.jsonl"]);
    expect(lastActivity(store).get("old")).toBe("2025-02-10T00:00:00Z");
    // In March 2026 the file of February 2025 is older than 12 months. The file of March 2025 is not.
    rollUp(store, day("2026-03-15"));
    expect(months()).toEqual(["2025-03.jsonl", "2026-03.jsonl"]);
    expect(readLog(store).map((e) => e.t.slice(0, 7))).toEqual(["2025-03", "2026-03"]);
    // The last activity stays, so the id is never free. The verdict went with its month.
    expect([...lastActivity(store)].sort()).toEqual([["edge", "2025-03-10T00:00:00Z"], ["new", "2026-03-10T00:00:00Z"], ["old", "2025-02-10T00:00:00Z"]]);
    rollUp(store, day("2026-03-16"));
    expect(readFileSync(rolled(store), "utf8")).toContain('"old": {"last":"2025-02-10T00:00:00Z"}');
    expect(idsWithHistory(store).has("old")).toBe(true);
    // A read never removes a file: only the daily roll-up does.
    logAt(store, "2024-01-01T00:00:00Z", { ev: "show", note: "ancient", why: "task" });
    lastActivity(store);
    readLog(store);
    expect(months()).toContain("2024-01.jsonl");
  });

  test("last activity is the newest over the roll-ups of all machines, this log and the counters of an older kb", () => {
    const store = tempStore();
    logAt(store, "2026-03-05T00:00:00Z", { ev: "show", note: "here-newer", why: "task" });
    logAt(store, "2026-03-01T00:00:00Z", { ev: "show", note: "there-newer", why: "task" });
    otherMachine(store, "machine-b", {
      "here-newer": { last: "2026-03-02T00:00:00Z" },
      "there-newer": { last: "2026-03-09T00:00:00Z" },
      "only-there": { last: "2026-02-01T00:00:00Z" },
      // A verdict that is not "helped" is no activity, but the id has a history.
      "judged-there": { wrong: "2026-02-01T00:00:00Z" },
    });
    otherMachine(store, "machine-c", { "only-there": { last: "2026-02-03T00:00:00Z" }, "there-newer": { last: "2026-03-08T00:00:00Z" } });
    legacyUsage(store, "machine-b", { legacy: { uses: 2, last_used: "2026-01-01T00:00:00Z" }, counted: { uses: 1 } });
    expect([...lastActivity(store)].sort()).toEqual([
      ["here-newer", "2026-03-05T00:00:00Z"],
      ["legacy", "2026-01-01T00:00:00Z"],
      ["only-there", "2026-02-03T00:00:00Z"],
      ["there-newer", "2026-03-09T00:00:00Z"],
    ]);
    expect([...idsWithHistory(store)].sort()).toEqual(["counted", "here-newer", "judged-there", "legacy", "only-there", "there-newer"]);
    // A fresh clone has no log at all: the roll-ups still say what was active.
    rmSync(logDir(store), { recursive: true });
    expect(lastActivity(store).get("there-newer")).toBe("2026-03-09T00:00:00Z");
    expect(lastActivity(store).has("here-newer")).toBe(true);
  });

  test("the verdicts on a note come from this log and from the roll-ups of the other machines", () => {
    const store = tempStore();
    logAt(store, "2026-03-01T00:00:00Z", { ev: "verdict", session: "s1", note: "a", verdict: "not-needed" });
    logAt(store, "2026-03-02T00:00:00Z", { ev: "verdict", session: "s2", note: "a", verdict: "helped" });
    logAt(store, "2026-03-03T00:00:00Z", { ev: "verdict", session: "s3", note: "b", verdict: "wrong" });
    rollUp(store, day("2026-03-04"));
    // A verdict after the roll-up of the day is in the log only. The roll-up of this machine is
    // not read here, so no verdict counts twice.
    logAt(store, "2026-03-04T13:00:00Z", { ev: "verdict", session: "s4", note: "a", verdict: "not-needed" });
    otherMachine(store, "machine-b", { a: { not_needed: ["2026-03-06T00:00:00Z", "2026-03-05T00:00:00Z"], wrong: "2026-02-01T00:00:00Z" }, b: { wrong: "2026-03-09T00:00:00Z", helped: "2026-03-08T00:00:00Z" } });
    expect([...judgments(store)].sort()).toEqual([
      ["a", { helped: "2026-03-02T00:00:00Z", wrong: "2026-02-01T00:00:00Z", notNeeded: ["2026-03-06T00:00:00Z", "2026-03-05T00:00:00Z", "2026-03-04T13:00:00Z", "2026-03-01T00:00:00Z"] }],
      ["b", { helped: "2026-03-08T00:00:00Z", wrong: "2026-03-09T00:00:00Z", notNeeded: [] }],
    ]);
  });

  test("a roll-up file of any shape is read without a fault", () => {
    const store = tempStore();
    mkdirSync(join(store.home, "activity"));
    const write = (name: string, text: string) => writeFileSync(join(store.home, "activity", name), text);
    write("broken.json", "{not json");
    write("list.json", "[1, 2]");
    write("null.json", "null");
    write("no-notes.json", '{"v": 9}');
    write("odd.json", JSON.stringify({ v: 9, notes: { a: { last: 5, wrong: "", not_needed: "x" }, b: null, c: "text", "": { last: "2026-01-01T00:00:00Z" }, d: { last: "2026-01-02T00:00:00Z", not_needed: [1, "", "2026-01-03T00:00:00Z"], later: true } } }));
    write("not-a-roll-up.txt", "x");
    expect([...lastActivity(store)]).toEqual([["d", "2026-01-02T00:00:00Z"]]);
    expect([...judgments(store)]).toEqual([["d", { notNeeded: ["2026-01-03T00:00:00Z"] }]]);
    expect([...idsWithHistory(store)]).toEqual(["d"]);
  });
});
