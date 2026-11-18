import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextBudget } from "../cli/context.ts";
import { findStale } from "../cli/stale.ts";
import { kb, putNote, sh, tempRepo, tempStore } from "./helpers.ts";

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

  test("decayed: last_verified is older than the decay window", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "old-global", last_verified: "2025-08-01T00:00:00Z" });
    putNote(store, { id: "old-repo", scope: SCOPE, last_verified: "2025-08-01T00:00:00Z" });
    putNote(store, { id: "new", last_verified: FRESH });
    expect(reasons(store, repo)).toEqual(["old-global:decayed", "old-repo:decayed"]);
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ decayDays: 365 }));
    expect(reasons(store, repo)).toEqual([]);
  });

  test("duplicate: two titles share most of their words, and the newer note is the candidate", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "first", title: "Amounts are stored as integer cents", created: "2026-01-01T00:00:00Z", last_verified: FRESH });
    putNote(store, { id: "second", scope: SCOPE, title: "Store amounts as integer cents", created: "2026-02-01T00:00:00Z", last_verified: FRESH });
    putNote(store, { id: "third", title: "Ledger rows are append-only", last_verified: FRESH });
    const found = findStale(store, repo, NOW).candidates;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "second", reason: "duplicate", detail: "the title is close to first" });
  });

  test("it leaves out other repos, trashed notes and promoted notes, and works outside a repo", () => {
    const { repo, store } = fixture();
    const old = "2025-01-01T00:00:00Z";
    putNote(store, { id: "elsewhere", scope: "github.com/acme/web", last_verified: old });
    putNote(store, { id: "trashed", last_verified: old }, true);
    putNote(store, { id: "promoted", scope: SCOPE, promoted_to: "CLAUDE.md", last_verified: old });
    putNote(store, { id: "global", last_verified: old });
    expect(reasons(store, repo)).toEqual(["global:decayed"]);
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
    // Both notes are also past the decay window, because the fixture dates are old.
    expect(kb(store, ["stale", "--json"], { cwd: repo }).json.candidates.map((c: any) => `${c.id}:${c.reason}`)).toEqual(["g:decayed", "ledger:anchor-changed", "ledger:decayed"]);

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
  test("a demotion does not count as a verification", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "n", scope: SCOPE });
    const result = kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ id: "n", indexed: false }) });
    expect(result.json.status).toBe("updated");
    expect(store.find("n")).toMatchObject({ indexed: false, last_verified: "2026-01-01T00:00:00Z" });
    expect(store.find("n")!.verified_at_commit).toBeUndefined();
  });
});

describe("kb budget", () => {
  test("within budget it suggests nothing", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "a", scope: SCOPE });
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b).toMatchObject({ scope: SCOPE, over: false, trim: [], index: { lines: 0, budget: 60, hidden: 0 }, context: { bodies: 1, dropped: 0, budget: contextBudget(8000) } });
    expect(b.notes[0]).toMatchObject({ id: "a", shown: "body", uses: 0 });
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
    expect(text).not.toContain("Trash, merge or shorten first");
    expect(text).toContain("every note reaches a session");
    expect(text).toContain("longest  ");
  });

  test("when notes reach no session it names as many as are hidden: least used, lowest rank, never open work or a rule", () => {
    const { repo, store } = fixture();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { indexLines: 2, contextChars: 1500 } }));
    const body = "word ".repeat(80);
    putNote(store, { id: "work", scope: SCOPE, kind: "open-work", body });
    putNote(store, { id: "trap", scope: SCOPE, kind: "gotcha", body });
    putNote(store, { id: "used", scope: SCOPE, kind: "how-to", body });
    for (const id of ["howto-1", "howto-2", "howto-3"]) putNote(store, { id, scope: SCOPE, kind: "how-to", body });
    kb(store, ["use", "used"]);
    const b = kb(store, ["budget", "--json"], { cwd: repo }).json;
    expect(b.over).toBe(true);
    expect(b.index.hidden).toBeGreaterThan(0);
    expect(b.index.lines).toBe(2);
    const ids = b.trim.map((d: any) => d.id);
    expect(ids).toHaveLength(b.index.hidden);
    for (const id of ids) expect(id).toMatch(/^howto-/);
    expect(b.trim[0].reason).toBe("never used");
    expect(b.ask).toEqual([]);
    expect(kb(store, ["budget"], { cwd: repo }).stdout).toMatch(/reach(es)? no session, because the index is full\.\nTrash, merge or shorten first: howto-/);
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
    expect(text).toContain("Trash, merge or shorten first: howto (never used)");
    expect(text).toMatch(/Then ask the user, because these are rules: (rule-\d|trap) \((convention|gotcha), never used\)/);
  });

  test("a demoted note stays visible in kb budget and kb list", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "kept", scope: SCOPE });
    putNote(store, { id: "gone", scope: SCOPE, indexed: false });
    putNote(store, { id: "elsewhere", scope: "github.com/acme/other", indexed: false });
    expect(kb(store, ["budget", "--json"], { cwd: repo }).json.demoted).toEqual(["gone"]);
    expect(kb(store, ["budget"], { cwd: repo }).stdout).toContain("demoted  1 note, in no session: gone");
    expect(kb(store, ["list", "--scope", "repo"], { cwd: repo }).stdout).toMatch(/Title of gone \(demoted\)/);
  });
});

describe("kb promote", () => {
  test("--dry-run writes nothing, then the real run appends once and hides the note from context", () => {
    const { repo, store } = fixture();
    writeFileSync(join(repo, "CLAUDE.md"), "# Billing\n\nExisting text.");
    putNote(store, { id: "cents", scope: SCOPE, title: "Amounts are integer cents", body: "Never use floats for money." });

    const dry = kb(store, ["promote", "cents", "--to", "CLAUDE.md", "--dry-run", "--json"], { cwd: repo });
    expect(dry.json).toMatchObject({ id: "cents", written: false, addition: "\n\n<!-- kb: cents -->\n## Amounts are integer cents\n\nNever use floats for money.\n" });
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# Billing\n\nExisting text.");
    expect(store.find("cents")!.promoted_to).toBeUndefined();

    const real = kb(store, ["promote", "cents", "--to", "CLAUDE.md", "--json"], { cwd: repo });
    expect(real.json.written).toBe(true);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# Billing\n\nExisting text.\n\n<!-- kb: cents -->\n## Amounts are integer cents\n\nNever use floats for money.\n");
    expect(store.find("cents")!.promoted_to).toBe("CLAUDE.md");
    expect(kb(store, ["context"], { cwd: repo }).stdout).not.toContain("cents");
    expect(kb(store, ["promote", "cents", "--to", "CLAUDE.md"], { cwd: repo }).code).toBe(1);
  });

  test("creates AGENTS.md when it is missing", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "cents", scope: SCOPE, title: "Amounts are integer cents", body: "Never use floats." });
    expect(kb(store, ["promote", "cents", "--to", "AGENTS.md"], { cwd: repo }).code).toBe(0);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("<!-- kb: cents -->\n## Amounts are integer cents\n\nNever use floats.\n");
  });

  test("refuses another file name, a note of another scope, and a run outside the repo", () => {
    const { repo, store } = fixture();
    putNote(store, { id: "cents", scope: SCOPE });
    putNote(store, { id: "g" });
    expect(kb(store, ["promote", "cents", "--to", "README.md"], { cwd: repo }).code).toBe(1);
    expect(kb(store, ["promote", "cents", "--to", "../CLAUDE.md"], { cwd: repo }).code).toBe(1);
    expect(kb(store, ["promote", "g", "--to", "CLAUDE.md"], { cwd: repo }).code).toBe(1);
    expect(kb(store, ["promote", "cents", "--to", "CLAUDE.md"]).code).toBe(1);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    rmSync(join(repo, "src"), { recursive: true });
  });
});
