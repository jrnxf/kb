import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextBudget } from "../cli/context.ts";
import { findNeighbors, neighborCheck } from "../cli/neighbors.ts";
import { findStale } from "../cli/stale.ts";
import { kb, logAt, otherMachine, plain, putNote, sh, tempRepo, tempStore } from "./helpers.ts";

const SCOPE = "github.com/acme/billing";
const NOW = new Date("2026-03-01T00:00:00Z");
const FRESH = "2026-02-20T00:00:00Z";

/** A repo with src/ledger.ts (function append) and src/rates.ts, one commit. */
function fixture() {
  const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/ledger.ts"), "export function append() {}\n");
  writeFileSync(join(repo, "src/rates.ts"), "export const RATE = 1;\n");
  commit(repo, "add src");
  return { repo, store: tempStore(), head: sh(repo, "git", "rev-parse", "--short", "HEAD") };
}

function commit(repo: string, message: string) {
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", message);
}

const reasons = (store: ReturnType<typeof tempStore>, repo: string) => findStale(store, repo, NOW).candidates.map((c) => `${c.id}:${c.reason}`);

describe("kb stale", () => {
  test("a note verified at HEAD with live anchors is not a candidate", () => {
    const { repo, store, head } = fixture();
    putNote(store, { id: "ok", scope: SCOPE, verified_at_commit: head, anchors: ["src/ledger.ts#append", "src"], last_verified: FRESH });
    expect(findStale(store, repo, NOW)).toMatchObject({ scope: SCOPE, head, notes: 0, candidates: [] });
  });

  test("anchor-changed: an anchored file changed since verified_at_commit", () => {
    const { repo, store, head } = fixture();
    putNote(store, { id: "file", scope: SCOPE, verified_at_commit: head, anchors: ["src/ledger.ts#append"], last_verified: FRESH });
    putNote(store, { id: "dir", scope: SCOPE, verified_at_commit: head, anchors: ["src"], last_verified: FRESH });
    putNote(store, { id: "other", scope: SCOPE, verified_at_commit: head, anchors: ["src/rates.ts"], last_verified: FRESH });
    writeFileSync(join(repo, "src/ledger.ts"), "export function append() { return 1; }\n");
    commit(repo, "change ledger");
    expect(reasons(store, repo)).toEqual(["dir:anchor-changed", "file:anchor-changed"]);
    expect(findStale(store, repo, NOW).candidates[1]!.detail).toBe(`changed since ${head}: src/ledger.ts`);
  });

  test("a gone symbol does not hide a change to another anchor, also on the same file", () => {
    const { repo, store, head } = fixture();
    mkdirSync(join(repo, "b"));
    writeFileSync(join(repo, "b/x.ts"), "x\n");
    commit(repo, "add b");
    const base = sh(repo, "git", "rev-parse", "--short", "HEAD");
    putNote(store, { id: "same-file", scope: SCOPE, verified_at_commit: base, anchors: ["src/ledger.ts#gone", "src/ledger.ts#append"], last_verified: FRESH });
    putNote(store, { id: "same-word", scope: SCOPE, verified_at_commit: base, anchors: ["src/rates.ts#b", "b"], last_verified: FRESH });
    writeFileSync(join(repo, "src/ledger.ts"), "export function append() { return 1; }\n");
    writeFileSync(join(repo, "b/x.ts"), "y\n");
    commit(repo, "change both");
    expect(reasons(store, repo)).toEqual(["same-file:anchor-changed", "same-file:anchor-missing", "same-word:anchor-changed", "same-word:anchor-missing"]);
    expect(head).not.toBe(base);
  });

  test("a symbol check reads only a regular file of a sane size, so a pipe never blocks it", () => {
    const { repo, store } = fixture();
    sh(repo, "mkfifo", "pipe");
    writeFileSync(join(repo, "huge.txt"), "x".repeat(2_000_001));
    putNote(store, { id: "pipe", scope: SCOPE, anchors: ["pipe#x"], last_verified: FRESH });
    putNote(store, { id: "huge", scope: SCOPE, anchors: ["huge.txt#nothing"], last_verified: FRESH });
    putNote(store, { id: "dir", scope: SCOPE, anchors: ["src#nothing"], last_verified: FRESH });
    expect(reasons(store, repo)).toEqual([]);
  });

  test("anchor-missing: the path is gone, or the symbol left the file", () => {
    const { repo, store, head } = fixture();
    putNote(store, { id: "path", scope: SCOPE, verified_at_commit: head, anchors: ["src/gone.ts"], last_verified: FRESH });
    putNote(store, { id: "symbol", scope: SCOPE, anchors: ["src/rates.ts#lookupRate"], last_verified: FRESH });
    putNote(store, { id: "escape", scope: SCOPE, anchors: ["../outside.ts"], last_verified: FRESH });
    const found = findStale(store, repo, NOW).candidates;
    expect(found.map((c) => `${c.id}:${c.reason}`)).toEqual(["escape:anchor-missing", "path:anchor-missing", "symbol:anchor-missing"]);
    expect(found[2]!.detail).toBe("lookupRate is no longer in src/rates.ts");
  });

  test("commit-unknown: verified_at_commit is not in the history of HEAD", () => {
    const { repo, store } = fixture();
    writeFileSync(join(repo, "src/rates.ts"), "export const RATE = 2;\n");
    commit(repo, "to be dropped");
    const dropped = sh(repo, "git", "rev-parse", "--short", "HEAD");
    sh(repo, "git", "reset", "-q", "--hard", "HEAD~1");
    putNote(store, { id: "rebased", scope: SCOPE, verified_at_commit: dropped, anchors: ["src/rates.ts"], last_verified: FRESH });
    putNote(store, { id: "never", scope: SCOPE, verified_at_commit: "0123abc", last_verified: FRESH });
    // No anchor-changed here: with an unknown commit there is nothing to compare with.
    expect(reasons(store, repo)).toEqual(["never:commit-unknown", "rebased:commit-unknown"]);
  });

  test("expired: no activity and no check for expireDays. decayed: active, but not verified for decayDays", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "unused", scope: SCOPE, last_verified: "2025-11-01T00:00:00Z" });
    putNote(store, { id: "used", scope: SCOPE, last_verified: "2025-08-01T00:00:00Z" });
    putNote(store, { id: "checked", scope: SCOPE, last_verified: "2026-01-01T00:00:00Z" });
    putNote(store, { id: "old-global", last_verified: "2025-08-01T00:00:00Z" });
    logAt(store, "2026-02-01T00:00:00Z", { ev: "show", note: "used", why: "task" });
    // A read that is a check, and a verdict that the note had no bearing, keep no note alive.
    logAt(store, "2026-02-01T00:00:00Z", { ev: "show", note: "unused", why: "check" });
    logAt(store, "2026-02-01T00:00:00Z", { ev: "verdict", note: "unused", verdict: "not-needed" });
    // A note gets one of the two: expired says more.
    expect(findStale(store, repo, NOW).candidates.map((c) => `${c.id}: ${c.detail}`)).toEqual(["unused: no use and no check for 120 days", "used: last verified 212 days ago"]);
    expect(reasons(store, repo)).toEqual(["unused:expired", "used:decayed"]);
    // Activity within expireDays keeps a note from expiring: here a Read of a file the note is anchored to.
    logAt(store, "2026-02-01T00:00:00Z", { ev: "fire", kind: "path", form: "title", note: "unused", tool: "Read", match: "src/ledger.ts" });
    expect(reasons(store, repo)).toEqual(["used:decayed"]);
    // So does activity on another machine.
    otherMachine(store, "old", { "old-global": { last: "2026-02-01T00:00:00Z" } });
    expect(findStale(store, join(repo, ".."), NOW).candidates.map((c) => `${c.id}:${c.reason}`)).toEqual(["old-global:decayed"]);
    // The config sets both windows.
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ decayDays: 365, expireDays: 30 }));
    expect(reasons(store, repo)).toEqual(["checked:expired"]);
  });

  test("a note that is active on another machine does not expire here", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "used-there", scope: SCOPE, last_verified: "2025-11-01T00:00:00Z" });
    putNote(store, { id: "used-nowhere", scope: SCOPE, last_verified: "2025-11-01T00:00:00Z" });
    expect(reasons(store, repo)).toEqual(["used-nowhere:expired", "used-there:expired"]);
    // This machine has no event for the note. The roll-up of the other machine says it was opened last week.
    otherMachine(store, "machine-b", { "used-there": { last: "2026-02-22T00:00:00Z" } });
    expect(reasons(store, repo)).toEqual(["used-nowhere:expired"]);
  });

  test("judged-wrong: a session said the note was wrong after its last check, on any machine", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "here", scope: SCOPE, last_verified: FRESH });
    putNote(store, { id: "there", scope: SCOPE, last_verified: FRESH });
    putNote(store, { id: "before", scope: SCOPE, last_verified: FRESH });
    putNote(store, { id: "corrected", scope: SCOPE, last_verified: FRESH });
    putNote(store, { id: "fine", scope: SCOPE, last_verified: FRESH });
    logAt(store, "2026-02-25T00:00:00Z", { ev: "verdict", session: "s1", note: "here", verdict: "wrong" });
    // Another session that the note helped does not take the verdict back.
    logAt(store, "2026-02-26T00:00:00Z", { ev: "verdict", session: "s2", note: "here", verdict: "helped" });
    // A verdict from before the last check is about an older text.
    logAt(store, "2026-02-10T00:00:00Z", { ev: "verdict", session: "s1", note: "before", verdict: "wrong" });
    // A session that corrects its own verdict judged the note once.
    logAt(store, "2026-02-25T00:00:00Z", { ev: "verdict", session: "s3", note: "corrected", verdict: "wrong" });
    logAt(store, "2026-02-25T00:01:00Z", { ev: "verdict", session: "s3", note: "corrected", verdict: "helped" });
    logAt(store, "2026-02-25T00:00:00Z", { ev: "verdict", session: "s1", note: "fine", verdict: "helped" });
    otherMachine(store, "machine-b", { there: { wrong: "2026-02-27T00:00:00Z" }, before: { wrong: "2026-02-19T00:00:00Z" } });
    const found = findStale(store, repo, NOW).candidates;
    expect(found.map((c) => `${c.id}:${c.reason}`)).toEqual(["here:judged-wrong", "there:judged-wrong"]);
    expect(found[0]!.detail).toBe("a session judged it wrong 4 days ago, after the last check");
    expect(found[1]!.detail).toBe("a session judged it wrong 2 days ago, after the last check");
    expect(kb(store, ["stale"], { cwd: repo }).stdout).toMatch(/^there \| judged-wrong \| a session judged it wrong \d+ days ago, after the last check$/m);

    // A new verification clears it: kb verify, or an update of the body.
    expect(kb(store, ["verify", "here"], { cwd: repo }).code).toBe(0);
    expect(kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ id: "there", body: "The text as it is true now." }) }).json.status).toBe("updated");
    expect(reasons(store, repo)).toEqual([]);
    // An update of another field is no verification.
    logAt(store, "2026-02-25T00:00:00Z", { ev: "verdict", session: "s4", note: "fine", verdict: "wrong" });
    expect(kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ id: "fine", confidence: "low" }) }).json.status).toBe("updated");
    expect(reasons(store, repo)).toEqual(["fine:judged-wrong"]);
  });

  test("not-needed: three sessions said so after the last check, on all machines together, and none said it helped", () => {
    const { repo, store } = fixture();
    const ids = ["three-here", "two-here", "split", "helped", "helped-there", "helped-before", "same-session", "before"];
    for (const [i, id] of ids.entries()) putNote(store, { id, title: `Fact ${i}`, scope: SCOPE, last_verified: FRESH });
    const notNeeded = (note: string, session: string, time = "2026-02-25T00:00:00Z") => logAt(store, time, { ev: "verdict", session, note, verdict: "not-needed" });
    for (const session of ["s1", "s2", "s3"]) for (const note of ["three-here", "helped", "helped-there", "helped-before"]) notNeeded(note, session);
    for (const session of ["s1", "s2"]) for (const note of ["two-here", "split"]) notNeeded(note, session);
    // One session that says it three times is one session.
    for (const time of ["2026-02-25T00:00:00Z", "2026-02-26T00:00:00Z", "2026-02-27T00:00:00Z"]) notNeeded("same-session", "s1", time);
    // Verdicts from before the last check do not count.
    for (const session of ["s1", "s2", "s3"]) notNeeded("before", session, "2026-02-10T00:00:00Z");
    logAt(store, "2026-02-26T00:00:00Z", { ev: "verdict", session: "s4", note: "helped", verdict: "helped" });
    logAt(store, "2026-02-10T00:00:00Z", { ev: "verdict", session: "s4", note: "helped-before", verdict: "helped" });
    otherMachine(store, "machine-b", { split: { not_needed: ["2026-02-27T00:00:00Z", "2026-02-01T00:00:00Z"] }, "helped-there": { helped: "2026-02-28T00:00:00Z" } });
    const found = findStale(store, repo, NOW).candidates;
    expect(found.map((c) => `${c.id}:${c.reason}`)).toEqual(["helped-before:not-needed", "split:not-needed", "three-here:not-needed"]);
    expect(found[1]!.detail).toBe("at least 3 sessions judged it not needed since the last check, and none said it helped");

    // A new verification clears it.
    expect(kb(store, ["verify", "split", "three-here"], { cwd: repo }).code).toBe(0);
    expect(kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ id: "helped-before", anchors: ["src/ledger.ts"] }) }).json.status).toBe("updated");
    expect(reasons(store, repo)).toEqual([]);
  });

  test("a note expires after expireDays whole days, and a wrong window falls back to the default", () => {
    const { repo, store } = fixture();
    const daysBefore = (days: number, hours = 0) => new Date(NOW.getTime() - (days * 24 + hours) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    putNote(store, { id: "edge", scope: SCOPE, last_verified: daysBefore(90, 23) });
    putNote(store, { id: "over", scope: SCOPE, last_verified: daysBefore(91) });
    expect(reasons(store, repo)).toEqual(["over:expired"]);
    for (const expireDays of [null, 0, -1, "abc"]) {
      writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ expireDays, decayDays: expireDays }));
      expect(store.config()).toMatchObject({ expireDays: 90, decayDays: 180 });
      expect(reasons(store, repo)).toEqual(["over:expired"]);
    }
  });

  // The audit had its own measure of the title words. It missed a twin that `kb add` holds, so the
  // two disagreed on what a twin is.
  describe("duplicate", () => {
    const first = { title: "Stripe signature check needs the raw body", body: "express.json() runs before the webhook route and breaks the signature check.\nMount express.raw() on the webhook route before the JSON parser." };
    const second = { title: "The Stripe webhook route must get the raw body", body: "The JSON parser breaks the signature check when it runs first. Use express.raw() for that route." };

    test("a note that says a stored fact in other words is a candidate, by the measure of kb add, and the newer note is the one", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "first", scope: SCOPE, ...first, created: "2026-01-01T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "second", scope: SCOPE, ...second, created: "2026-02-01T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "third", scope: SCOPE, title: "Ledger rows are append-only", body: "A correction is a new row.", last_verified: FRESH });
      const found = findStale(store, repo, NOW).candidates;
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id: "second", reason: "duplicate" });
      expect(found[0]!.detail).toStartWith("close to first: both have ");
      expect(found[0]!.detail).toContain("stripe");
      // The same pair, by the same line: kb add holds the second note for the first.
      const store2 = tempStore();
      putNote(store2, { id: "first", scope: SCOPE, ...first });
      expect(kb(store2, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ ...second, kind: "gotcha" }) }).json).toMatchObject({ status: "neighbors", neighbors: [{ id: "first" }] });
    });

    test("titles that share words are no candidates when the notes say different things", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "cents", scope: SCOPE, title: "Amounts are stored as integer cents", body: "A float lost one cent in a refund of 10 items.", last_verified: FRESH });
      putNote(store, { id: "rates", scope: SCOPE, title: "Rates are stored as integer basis points", body: "The tax table has four digits. Parse it with the decimal library.", last_verified: FRESH });
      expect(findStale(store, repo, NOW).candidates).toEqual([]);
    });

    // The audit of a repo got this pair, and proposed a merge that `kb audit propose` refuses across scopes.
    test("a repo note close to a global note is no candidate, in the repo or outside: a pair has one scope", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "in-repo", scope: SCOPE, ...second, created: "2026-01-01T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "everywhere", ...first, created: "2026-02-01T00:00:00Z", last_verified: FRESH });
      expect(findStale(store, repo, NOW).candidates).toEqual([]);
      expect(findStale(store, plain(), NOW).candidates).toEqual([]);
      // `kb add` is where this twin is caught: it holds a repo draft for the global note.
      const held = kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ ...second, title: "Give the Stripe webhook the raw body", kind: "gotcha" }) });
      expect(held.json.neighbors.map((n: any) => n.id).sort()).toEqual(["everywhere", "in-repo"]);
      // A second note in each scope makes a pair there, and only there.
      putNote(store, { id: "in-repo-2", scope: SCOPE, ...first, created: "2026-01-05T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "everywhere-2", ...second, created: "2026-02-05T00:00:00Z", last_verified: FRESH });
      const pairs = (dir: string) => findStale(store, dir, NOW).candidates.map((c) => `${c.id}:${c.detail.split(":")[0]}`);
      expect(pairs(repo)).toEqual(["in-repo-2:close to in-repo"]);
      expect(pairs(plain())).toEqual(["everywhere-2:close to everywhere"]);
    });

    // `kb add` left out a note that the new note supersedes, and `kb stale` then named the two as twins.
    test("a note and a note that it supersedes are no candidates, as in kb add", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "old", scope: SCOPE, ...first, created: "2026-01-01T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "new", scope: SCOPE, ...second, created: "2026-02-01T00:00:00Z", last_verified: FRESH, supersedes: ["old"] });
      expect(findStale(store, repo, NOW).candidates).toEqual([]);
      // A third note that says the same is still a twin of both.
      putNote(store, { id: "third", scope: SCOPE, title: "Give the Stripe webhook the raw body", body: second.body, created: "2026-03-01T00:00:00Z", last_verified: FRESH });
      expect(findStale(store, repo, NOW).candidates.map((c) => `${c.id}>${c.detail.split(":")[0]!.replace("close to ", "")}`).sort()).toEqual(["third>new", "third>old"]);
    });

    // The word weights were built again for each note. One build must give the numbers of `kb add`.
    test("each pair has the score that kb add gives the newer note against a store without it", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "a", scope: SCOPE, ...first, created: "2026-01-01T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "b", scope: SCOPE, ...second, created: "2026-01-02T00:00:00Z", last_verified: FRESH });
      for (let i = 0; i < 12; i++) putNote(store, { id: `other-${i}`, scope: i % 2 ? SCOPE : "global", last_verified: FRESH });
      const notes = store.notes();
      const b = notes.find((n) => n.id === "b")!;
      const alone = findNeighbors(notes.filter((n) => n.id !== "b"), b);
      expect(alone.map((n) => n.id)).toEqual(["a"]);
      // The same store with b in it: b does not count for its own weights.
      expect(neighborCheck(notes, SCOPE)(b)).toEqual(alone);
      // A copy of b under another id counts for the weights, and the score is then another one.
      expect(neighborCheck([...notes, { ...b, id: "b-copy" }], SCOPE)(b).find((n) => n.id === "a")!.score).not.toBe(alone[0]!.score);
      expect(findStale(store, repo, NOW).candidates.map((c) => `${c.id}>${c.detail.split(":")[0]}`)).toEqual(["b>close to a"]);
    });

    test("a note in another repo, in the trash or in an instruction file makes no candidate", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "here", scope: SCOPE, ...second, last_verified: FRESH });
      putNote(store, { id: "other-repo", scope: "github.com/acme/web", ...first, last_verified: FRESH });
      putNote(store, { id: "gone", scope: SCOPE, ...first, last_verified: FRESH }, true);
      putNote(store, { id: "moved", scope: SCOPE, ...first, last_verified: FRESH, promoted_to: "CLAUDE.md" });
      expect(findStale(store, repo, NOW).candidates).toEqual([]);
    });

    test("three notes that say one fact give one candidate per pair, and never the oldest note", () => {
      const { repo, store } = fixture();
      putNote(store, { id: "a", scope: SCOPE, ...first, created: "2026-01-01T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "b", scope: SCOPE, ...second, created: "2026-01-02T00:00:00Z", last_verified: FRESH });
      putNote(store, { id: "c", scope: SCOPE, title: "Give the Stripe webhook the raw body", body: second.body, created: "2026-01-03T00:00:00Z", last_verified: FRESH });
      const found = findStale(store, repo, NOW).candidates;
      expect(found.every((c) => c.reason === "duplicate")).toBe(true);
      expect(found.map((c) => `${c.id}>${c.detail.split(":")[0]!.replace("close to ", "")}`).sort()).toEqual(["b>a", "c>a", "c>b"]);
    });

    test("two notes of the same time go by id", () => {
      const { repo, store } = fixture();
      for (const [id, text] of [["zulu", first], ["alpha", second]] as const) putNote(store, { id, scope: SCOPE, ...text, last_verified: FRESH });
      expect(findStale(store, repo, NOW).candidates.map((c) => `${c.id}>${c.detail.split(":")[0]}`)).toEqual(["zulu>close to alpha"]);
    });
  });

  test("it checks one scope: the repo's notes in a repo, the global notes outside any repo", () => {
    const { repo, store } = fixture();
    const old = "2025-01-01T00:00:00Z";
    putNote(store, { id: "elsewhere", scope: "github.com/acme/web", last_verified: old });
    putNote(store, { id: "trashed", last_verified: old }, true);
    putNote(store, { id: "promoted", scope: SCOPE, promoted_to: "CLAUDE.md", last_verified: old });
    putNote(store, { id: "global", last_verified: old });
    putNote(store, { id: "mine", scope: SCOPE, last_verified: old });
    expect(reasons(store, repo)).toEqual(["mine:expired"]);
    const outside = kb(store, ["stale", "--json"]);
    expect(outside.json).toMatchObject({ scope: null, notes: 1 });
    expect(outside.json.candidates[0].id).toBe("global");
  });
});

describe("kb verify", () => {
  test("sets last_verified and the commit, and clears the candidate", () => {
    const { repo, store, head } = fixture();
    putNote(store, { id: "ledger", scope: SCOPE, verified_at_commit: head, anchors: ["src/ledger.ts"] });
    putNote(store, { id: "g" });
    writeFileSync(join(repo, "src/ledger.ts"), "export function append() { return 2; }\n");
    commit(repo, "change");
    // Both notes have also expired, because the fixture dates are old and nobody used them.
    expect(kb(store, ["stale", "--json"], { cwd: repo }).json.candidates.map((c: any) => `${c.id}:${c.reason}`)).toEqual(["ledger:anchor-changed", "ledger:expired"]);

    const result = kb(store, ["verify", "ledger", "g", "--json"], { cwd: repo });
    const newHead = sh(repo, "git", "rev-parse", "--short", "HEAD");
    expect(result.json).toEqual({ verified: ["ledger", "g"], commit: newHead });
    expect(store.find("ledger")).toMatchObject({ verified_at_commit: newHead, body: expect.stringMatching(/^k\d+a /) });
    expect(store.find("ledger")!.last_verified > "2026-01-01T00:00:00Z").toBe(true);
    expect(store.find("g")!.verified_at_commit).toBeUndefined();
    expect(kb(store, ["stale", "--json"], { cwd: repo }).json.candidates).toEqual([]);
  });

  test("refuses a repo note from outside its repo, and an unknown id", () => {
    const { store } = fixture();
    putNote(store, { id: "ledger", scope: SCOPE });
    const result = kb(store, ["verify", "ledger"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("inside that repo");
    expect(kb(store, ["verify", "nope"]).code).toBe(1);
    expect(store.find("ledger")!.last_verified).toBe("2026-01-01T00:00:00Z");
  });
});

describe("kb add, metadata only", () => {
  test("a change of confidence does not count as a verification", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "n", scope: SCOPE });
    const result = kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ id: "n", confidence: "high" }) });
    expect(result.json.status).toBe("updated");
    expect(store.find("n")).toMatchObject({ confidence: "high", last_verified: "2026-01-01T00:00:00Z" });
    expect(store.find("n")!.verified_at_commit).toBeUndefined();
  });
});

describe("kb budget", () => {
  /** Titles this long put a handful of notes over a small character budget. */
  const title = (id: string) => `${id}: a fact with a title that takes some room in the index of a session`;

  test("within budget it suggests nothing, and says what a session start gives of each note", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "work", scope: SCOPE, kind: "open-work", body: "State: half done.\nNext: write the pager." });
    putNote(store, { id: "a", scope: SCOPE });
    putNote(store, { id: "g-plain" });
    putNote(store, { id: "g-cmd", triggers: ["cmd: zorp --wipe"] });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b).toMatchObject({ scope: SCOPE, over: false, trim: [], ask: [], index: { lines: 2, triggerOnly: 1, hidden: 0 }, briefs: { count: 1, limit: 3, open: 1, budget: 1500 }, context: { budget: contextBudget(8000) } });
    // Rank order. A brief and an index line cost their characters, and a note that waits for its trigger costs none.
    expect(b.notes).toEqual([
      { id: "work", kind: "open-work", scope: SCOPE, chars: b.briefs.chars, shown: "brief" },
      { id: "a", kind: "gotcha", scope: SCOPE, chars: "- a [gotcha] Title of a\n".length, shown: "index" },
      { id: "g-cmd", kind: "gotcha", scope: "global", chars: 0, shown: "trigger" },
      { id: "g-plain", kind: "gotcha", scope: "global", chars: expect.any(Number), shown: "index" },
    ]);
    expect(b.briefs.chars).toBeGreaterThan(50);
    expect(b.context.chars).toBe(kb(store, ["context", "--json"], { cwd: repo }).json.chars);
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).toBe(
      [
        `scope    ${SCOPE}`,
        `context  ${b.context.chars} of ${b.context.budget} characters at a session start`,
        `briefs   1 of 1 open-work note here, at most 3: the title, the next step and a pointer. ${b.briefs.chars} of 1500 characters`,
        "index    2 lines, one per other note, in rank order",
        "trigger  1 global note with no line: it loads at its cmd, stop or err trigger",
        "hidden   0 notes",
        "every note reaches a session: as a brief, as an index line or at its trigger",
        "",
      ].join("\n"),
    );
    expect(text).not.toMatch(/bod(y|ies)/);
  });

  test("a note with no body at the session start, or with no line because of its trigger, is not a reason to make room", () => {
    const { repo, store } = fixture();
    const body = "word ".repeat(80);
    for (const id of ["a", "b", "c", "d", "e"]) putNote(store, { id, scope: SCOPE, body });
    for (const id of ["g-1", "g-2"]) putNote(store, { id, body, triggers: ["err: flux capacitor underflow"] });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b).toMatchObject({ over: false, trim: [], ask: [], index: { lines: 5, triggerOnly: 2, hidden: 0 } });
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).not.toContain("Trash or merge first");
    expect(text).toContain("every note reaches a session");
  });

  test("when notes reach no session it names the lowest ranked decisions and how-tos, as many as make room, never open work or a rule", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { contextChars: 700 } }));
    putNote(store, { id: "work", scope: SCOPE, kind: "open-work", body: "Next: write the pager." });
    putNote(store, { id: "trap", scope: SCOPE, kind: "gotcha", title: title("trap") });
    putNote(store, { id: "used", scope: SCOPE, kind: "how-to", title: title("used") });
    for (const id of ["howto-1", "howto-2", "howto-3"]) putNote(store, { id, scope: SCOPE, kind: "how-to", title: title(id) });
    // Activity ranks a note first in its kind. A count of reads plays no part.
    logAt(store, "2026-02-01T00:00:00Z", { ev: "show", note: "used", why: "task" });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b.over).toBe(true);
    expect(b.index.hidden).toBeGreaterThan(0);
    expect(b.index.hidden).toBeLessThan(4);
    expect(b.notes.filter((n: any) => n.shown === "hidden").map((n: any) => n.id)).toEqual(["howto-1", "howto-2", "howto-3"].slice(-b.index.hidden));
    const ids = b.trim.map((d: any) => d.id);
    expect(ids).toHaveLength(b.index.hidden);
    for (const id of ids) expect(id).toMatch(/^howto-/);
    expect(b.trim[0]).toEqual({ id: "howto-3", reason: "low rank, 6 of 6" });
    expect(JSON.stringify(b)).not.toMatch(/"uses"|last_used|never used/);
    expect(b.ask).toEqual([]);
    expect(kb(store, ["budget"], { cwd: repo }).stdout).toMatch(/reach(es)? no session, because the index is over its character budget\.\nTrash or merge first: howto-/);
  });

  test("gotchas and conventions fill the rest of the room as notes to ask about, never as notes to trim", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { contextChars: 500 } }));
    putNote(store, { id: "howto", scope: SCOPE, kind: "how-to", title: title("howto") });
    for (const id of ["rule-1", "rule-2", "rule-3", "rule-4"]) putNote(store, { id, scope: SCOPE, kind: "convention", title: title(id) });
    putNote(store, { id: "trap", scope: SCOPE, kind: "gotcha", title: title("trap") });
    // A global note that waits for its trigger takes no line, so taking it out frees none.
    putNote(store, { id: "g-cmd", kind: "decision", triggers: ["cmd: zorp --wipe"] });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b.over).toBe(true);
    expect(b.index.hidden).toBeGreaterThan(1);
    expect(b.trim.map((d: any) => d.id)).toEqual(["howto"]);
    expect(b.ask).toHaveLength(b.index.hidden - 1);
    for (const d of b.ask) expect(["gotcha", "convention"]).toContain(d.kind);
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).toContain("Trash or merge first: howto (low rank, 6 of 7)");
    expect(text).toContain("Then ask the user, because these are rules: rule-4 (convention, low rank, 5 of 7)");
  });

  const pad = (i: number) => String(i).padStart(3, "0");
  /** A time this many days before a fixed day, so that a later note ranks lower. */
  const day = (i: number) => new Date(Date.parse("2026-01-01T12:00:00Z") - i * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const hiddenIds = (b: any): string[] => b.notes.filter((n: any) => n.shown === "hidden").map((n: any) => n.id);

  test("when the global notes do not fit on their own, a repo names none of its notes: the global audit makes room", () => {
    const { repo, store } = fixture();
    for (let i = 0; i < 16; i++) putNote(store, { id: `r-${pad(i)}`, scope: SCOPE, kind: i < 8 ? "decision" : "how-to", title: title(`r-${pad(i)}`) });
    for (let i = 0; i < 200; i++) putNote(store, { id: `g-${pad(i)}`, kind: i % 2 ? "decision" : "gotcha", title: title(`g-${pad(i)}`), last_verified: day(i) });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    // Repo notes rank first, so every hidden note is a global one. Its audit is the global audit.
    expect(b).toMatchObject({ over: true, globalAudit: true, trim: [], ask: [], makeRoomFor: [], index: { hiddenRepo: 0 } });
    expect(b.index.hiddenGlobal).toBeGreaterThan(100);
    expect(b.index.hidden).toBe(b.index.hiddenGlobal);
    for (const id of hiddenIds(b)) expect(id).toStartWith("g-");
    expect(kb(store, ["context", "--json"], { cwd: repo }).json).toMatchObject({ hiddenBy: { repo: 0, global: b.index.hiddenGlobal }, globalAudit: true });
    const n = b.index.hiddenGlobal;
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).toEndWith(
      [
        `hidden   ${n} global notes`,
        `${n} global notes reach no session here, because the global notes do not fit the index. No note of this repo is hidden, and an audit of this repo covers its own notes only.`,
        "Run /kb:audit outside any repo: the global audit makes room. `kb budget` there lists the candidates.",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("r-0");
    // Outside any repo, the budget lists the global candidates: the lowest ranked decisions first.
    const g = kb(store, ["budget", "--json"]).json;
    expect(g).toMatchObject({ scope: null, over: true, globalAudit: false, index: { hiddenRepo: 0 } });
    expect(g.index.hiddenGlobal).toBe(g.index.hidden);
    expect(g.makeRoomFor).toEqual(hiddenIds(g));
    expect(g.trim.length).toBeGreaterThan(0);
    expect(g.trim[0].id).toBe("g-199");
    for (const d of [...g.trim, ...g.ask]) expect(d.id).toStartWith("g-");
    expect(kb(store, ["budget"]).stdout).toContain(`hidden   ${g.index.hidden} global notes\n${g.index.hidden} global notes reach no session, because the index is over its character budget.\nTrash or merge first: g-199 (`);
  });

  test("when the global notes fit on their own, the notes of the repo take their room, and the audit of the repo makes room", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { contextChars: 2000 } }));
    for (let i = 0; i < 16; i++) putNote(store, { id: `r-${pad(i)}`, scope: SCOPE, kind: i < 8 ? "gotcha" : i < 12 ? "decision" : "how-to", title: title(`r-${pad(i)}`), last_verified: day(i) });
    for (let i = 0; i < 10; i++) putNote(store, { id: `g-${pad(i)}`, title: title(`g-${pad(i)}`), last_verified: day(i) });
    expect(kb(store, ["budget", "--json"]).json).toMatchObject({ over: false, index: { hidden: 0 } });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b).toMatchObject({ over: true, globalAudit: false, index: { hiddenRepo: 0 } });
    expect(b.index.hiddenGlobal).toBeGreaterThan(0);
    expect(b.makeRoomFor).toEqual(hiddenIds(b));
    for (const id of b.makeRoomFor) expect(id).toStartWith("g-");
    // The candidates are notes of the repo, the lowest ranked how-to first.
    expect(b.trim[0]).toEqual({ id: "r-015", reason: "low rank, 16 of 26" });
    for (const d of [...b.trim, ...b.ask]) expect(d.id).toStartWith("r-");
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).toContain(`${b.index.hiddenGlobal} global note${b.index.hiddenGlobal === 1 ? " reaches" : "s reach"} no session, because the index is over its character budget.\nThe global notes fit outside a repo. Here the notes of this repo take their room, so room comes from the notes of this repo.\nTrash or merge first: r-015 (`);
    expect(text).not.toContain("outside any repo");
  });

  test("when notes of the repo are hidden, it counts them apart from the global notes, and names repo notes only", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { contextChars: 1500 } }));
    for (let i = 0; i < 30; i++) putNote(store, { id: `r-${pad(i)}`, scope: SCOPE, kind: i < 20 ? "gotcha" : "how-to", title: title(`r-${pad(i)}`), last_verified: day(i) });
    for (let i = 0; i < 4; i++) putNote(store, { id: `g-${pad(i)}`, kind: "decision" });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b).toMatchObject({ over: true, globalAudit: false, index: { hiddenGlobal: 4 } });
    expect(b.index.hiddenRepo).toBeGreaterThan(10);
    expect(b.index.hidden).toBe(b.index.hiddenRepo + 4);
    // Room is for the hidden notes of the repo. The global notes behind them are not the business of this audit.
    expect(b.makeRoomFor).toEqual(hiddenIds(b).filter((id) => id.startsWith("r-")));
    for (const d of [...b.trim, ...b.ask]) expect(d.id).toStartWith("r-");
    expect(b.trim.map((d: any) => d.id)).toEqual(Array.from({ length: 10 }, (_, i) => `r-${pad(29 - i)}`));
    expect(b.ask.length).toBe(b.index.hiddenRepo - 10);
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).toContain(`hidden   ${b.index.hiddenRepo} repo notes and 4 global notes\n${b.index.hiddenRepo} repo notes and 4 global notes reach no session, because the index is over its character budget.\nTrash or merge first: r-029 (`);
    expect(text).not.toContain("outside any repo");
  });

  test("room is counted in characters: the short lines that leave do not make room for as many long ones", () => {
    const store = tempStore();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { contextChars: 1500 } }));
    // Decisions that sessions open rank first, with short lines. The gotchas have long lines, and some do not fit.
    for (let i = 0; i < 10; i++) {
      putNote(store, { id: `d-${i}`, kind: "decision" });
      logAt(store, `2026-02-${String(10 + i).padStart(2, "0")}T00:00:00Z`, { ev: "show", note: `d-${i}`, why: "task" });
    }
    for (let i = 0; i < 20; i++) putNote(store, { id: `g-${pad(i)}`, title: title(`g-${pad(i)}`), last_verified: day(i) });
    const b = kb(store, ["budget", "--json"]).json;
    const row = (id: string) => b.notes.find((n: any) => n.id === id);
    const hidden = hiddenIds(b);
    expect(hidden.length).toBeGreaterThan(3);
    for (const id of hidden) expect(id).toStartWith("g-");
    expect(b.room).toBe(b.context.budget - b.context.chars);
    const need = hidden.reduce((sum, id) => sum + row(id).chars, 0) - b.room;
    // One short line for each hidden note is not enough room. The list goes on until the characters are.
    const short = row("d-0").chars;
    expect(short * hidden.length).toBeLessThan(need);
    expect(b.trim.map((d: any) => d.id)).toEqual(Array.from({ length: 10 }, (_, i) => `d-${i}`));
    expect(b.ask.length).toBeGreaterThan(0);
    expect(b.ask[0].id).toBe("g-019");
    const freed = [...b.trim, ...b.ask].map((d: any) => row(d.id).chars);
    const sum = (sizes: number[]) => sizes.reduce((a, c) => a + c, 0);
    expect(sum(freed)).toBeGreaterThanOrEqual(need);
    expect(sum(freed.slice(0, -1))).toBeLessThan(need);
  });
});
