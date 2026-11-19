import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextBudget } from "../cli/context.ts";
import { findStale } from "../cli/stale.ts";
import { kb, legacyUsage, logAt, putNote, sh, tempRepo, tempStore } from "./helpers.ts";

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
    // So does the last use that an older kb recorded, on any machine.
    legacyUsage(store, "old", { "old-global": { uses: 2, last_used: "2026-02-01T00:00:00Z" } });
    expect(findStale(store, join(repo, ".."), NOW).candidates.map((c) => `${c.id}:${c.reason}`)).toEqual(["old-global:decayed"]);
    // The config sets both windows.
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ decayDays: 365, expireDays: 30 }));
    expect(reasons(store, repo)).toEqual(["checked:expired"]);
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

  test("duplicate: two titles share most of their words, and the newer note is the candidate", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "first", scope: SCOPE, title: "Amounts are stored as integer cents", created: "2026-01-01T00:00:00Z", last_verified: FRESH });
    putNote(store, { id: "second", scope: SCOPE, title: "Store amounts as integer cents", created: "2026-02-01T00:00:00Z", last_verified: FRESH });
    putNote(store, { id: "third", scope: SCOPE, title: "Ledger rows are append-only", last_verified: FRESH });
    const found = findStale(store, repo, NOW).candidates;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "second", reason: "duplicate", detail: "the title is close to first" });
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
    expect(store.find("ledger")).toMatchObject({ verified_at_commit: newHead, body: expect.stringContaining("Body of ledger") });
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
  test("within budget it suggests nothing", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "a", scope: SCOPE });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b).toMatchObject({ scope: SCOPE, over: false, trim: [], index: { lines: 0, budget: 60, hidden: 0 }, context: { bodies: 1, dropped: 0, budget: contextBudget(8000) } });
    expect(b.notes[0]).toEqual({ id: "a", kind: "gotcha", scope: SCOPE, chars: expect.any(Number), shown: "body" });
  });

  test("bodies that drop to an index line are not a reason to make room", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 60, contextChars: 1500 } }));
    const body = "word ".repeat(80);
    for (const id of ["a", "b", "c", "d", "e"]) putNote(store, { id, scope: SCOPE, body });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b.context.dropped).toBeGreaterThan(0);
    expect(b.index.hidden).toBe(0);
    expect(b.index.lines).toBe(b.context.dropped);
    expect(b).toMatchObject({ over: false, trim: [] });
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).not.toContain("Trash or merge first");
    expect(text).toContain("every note reaches a session");
    expect(text).toContain("longest  ");
  });

  test("when notes reach no session it names as many as are hidden: the lowest ranked decisions and how-tos, never open work or a rule", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 2, contextChars: 1500 } }));
    const body = "word ".repeat(80);
    putNote(store, { id: "work", scope: SCOPE, kind: "open-work", body });
    putNote(store, { id: "trap", scope: SCOPE, kind: "gotcha", body });
    putNote(store, { id: "used", scope: SCOPE, kind: "how-to", body });
    for (const id of ["howto-1", "howto-2", "howto-3"]) putNote(store, { id, scope: SCOPE, kind: "how-to", body });
    // Activity ranks a note first in its kind. A count of reads plays no part.
    logAt(store, "2026-02-01T00:00:00Z", { ev: "show", note: "used", why: "task" });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b.over).toBe(true);
    expect(b.index.hidden).toBeGreaterThan(0);
    expect(b.index.lines).toBe(2);
    const ids = b.trim.map((d: any) => d.id);
    expect(ids).toHaveLength(b.index.hidden);
    for (const id of ids) expect(id).toMatch(/^howto-/);
    expect(b.trim[0]).toEqual({ id: "howto-3", reason: "low rank, 6 of 6" });
    expect(JSON.stringify(b)).not.toMatch(/"uses"|last_used|never used/);
    expect(b.ask).toEqual([]);
    expect(kb(store, ["budget"], { cwd: repo }).stdout).toMatch(/reach(es)? no session, because the index is full\.\nTrash or merge first: howto-/);
  });

  test("gotchas and conventions fill the rest of the hidden count as notes to ask about, never as notes to trim", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 1, contextChars: 1500 } }));
    const body = "word ".repeat(80);
    putNote(store, { id: "howto", scope: SCOPE, kind: "how-to", body });
    for (const id of ["rule-1", "rule-2", "rule-3"]) putNote(store, { id, scope: SCOPE, kind: "convention", body });
    putNote(store, { id: "trap", scope: SCOPE, kind: "gotcha", body });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b.over).toBe(true);
    expect(b.trim.map((d: any) => d.id)).toEqual(["howto"]);
    expect(b.ask).toHaveLength(b.index.hidden - 1);
    for (const d of b.ask) expect(["gotcha", "convention"]).toContain(d.kind);
    const text = kb(store, ["budget"], { cwd: repo }).stdout;
    expect(text).toContain("Trash or merge first: howto (low rank, 5 of 5)");
    expect(text).toContain("Then ask the user, because these are rules: rule-3 (convention, low rank, 4 of 5)");
  });

});

