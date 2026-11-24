import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashAnchors, hashAnchorsAt, hashChanged, hashText, symbolLines } from "../cli/anchors.ts";
import { buildContext } from "../cli/context.ts";
import { afterRead } from "../cli/fire.ts";
import { parseNote } from "../cli/note.ts";
import { changedSinceCheck, findStale } from "../cli/stale.ts";
import { kb, putNote, sh, tempRepo, tempStore } from "./helpers.ts";

const SCOPE = "github.com/acme/billing";

const LEDGER = [
  "import { rate } from './rates';",
  "",
  "export function append(row: Row) {",
  "  rows.push(row);",
  "  return rows.length;",
  "}",
  "",
  "export function appendAll(",
  "  all: Row[],",
  ") {",
  "  for (const row of all) append(row);",
  "}",
  "",
  "export const total = () => rows.length * rate;",
  "",
].join("\n");

describe("the lines of a symbol", () => {
  test("a definition gives its body, a call gives its line, and a longer name is another symbol", () => {
    expect(symbolLines(LEDGER, "append")).toEqual(["export function append(row: Row) {", "  rows.push(row);", "  return rows.length;", "}", "  for (const row of all) append(row);"]);
    // A head over several lines: the line that closes it and opens the body keeps the block open.
    expect(symbolLines(LEDGER, "appendAll")).toEqual(["export function appendAll(", "  all: Row[],", ") {", "  for (const row of all) append(row);", "}"]);
    expect(symbolLines(LEDGER, "total")).toEqual(["export const total = () => rows.length * rate;"]);
    expect(symbolLines(LEDGER, "nothing")).toBeNull();
  });

  test("a body by indent alone, a brace on its own line, and a symbol that is no word", () => {
    const python = "def pay(order):\n    charge(order)\n\n    return True\n\ndef refund(order):\n    pass\n";
    expect(symbolLines(python, "pay")).toEqual(["def pay(order):", "    charge(order)", "    return True"]);
    const allman = "void Pay()\n{\n    Charge();\n}\n\nvoid Refund()\n{\n}\n";
    expect(symbolLines(allman, "Pay")).toEqual(["void Pay()", "{", "    Charge();", "}"]);
    expect(symbolLines("a\nconst url = '/v1/pay';\nb\n", "/v1/pay")).toEqual(["const url = '/v1/pay';"]);
  });

  test("the hash of a symbol changes with its lines only, and not with the indent or an empty line", () => {
    const before = hashText(LEDGER, "append")!;
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText(LEDGER.replace("rows.length * rate", "rows.length * rate * 2"), "append")).toBe(before);
    expect(hashText(LEDGER.replace("  rows.push(row);", "\n      rows.push(row);\n"), "append")).toBe(before);
    expect(hashText(LEDGER.replace("rows.push(row)", "rows.unshift(row)"), "append")).not.toBe(before);
    // With no symbol the whole file counts.
    expect(hashText(LEDGER.replace("rows.length * rate", "rows.length * rate * 2"))).not.toBe(hashText(LEDGER));
    expect(hashText(LEDGER.replaceAll("\n", "\r\n"))).toBe(hashText(LEDGER));
    expect(hashText(LEDGER, "nothing")).toBeNull();
  });
});

/** A repo with src/ledger.ts and src/rates.ts in one commit, and a store. */
function fixture() {
  const repo = tempRepo({ remote: "git@github.com:acme/billing.git" });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/ledger.ts"), LEDGER);
  writeFileSync(join(repo, "src/rates.ts"), "export const rate = 1;\n");
  commit(repo, "add src");
  return { repo, store: tempStore(), head: sh(repo, "git", "rev-parse", "--short", "HEAD") };
}

function commit(repo: string, message: string) {
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-q", "-m", message);
}

const add = (store: ReturnType<typeof tempStore>, repo: string, note: object) => kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ kind: "decision", scope: "repo", body: "A fact about the ledger.", new: true, ...note }) });
const edit = (repo: string, from: string, to: string) => writeFileSync(join(repo, "src/ledger.ts"), readFileSync(join(repo, "src/ledger.ts"), "utf8").replace(from, to));

describe("a check of a note records the hashes of its anchors", () => {
  test("kb add hashes a file and a symbol, and no folder, no missing file and no hash from the caller", () => {
    const { repo, store } = fixture();
    const made = add(store, repo, { title: "Rows are appended", anchors: ["src/ledger.ts#append", "src/rates.ts", "src", "src/gone.ts"], anchor_hashes: { src: "made-up", "src/rates.ts": "made-up" } });
    expect(made.json.status).toBe("created");
    const note = store.find(made.json.id)!;
    expect(note.anchor_hashes).toEqual(hashAnchors(["src/ledger.ts#append", "src/rates.ts"], repo));
    expect(Object.keys(note.anchor_hashes!)).toEqual(["src/ledger.ts#append", "src/rates.ts"]);
    // The file of the note has them, and a second read gives the same note.
    expect(parseNote(readFileSync(note.path, "utf8")).anchor_hashes).toEqual(note.anchor_hashes);
    // The hashes at the commit are the hashes of the files, so a check at an earlier time compares the same way.
    expect(hashAnchorsAt(["src/ledger.ts#append", "src/rates.ts", "src", "../x"], repo, "HEAD")).toEqual(note.anchor_hashes!);
    // A file over the read limit has no hash from either source: a load could never compare it.
    writeFileSync(join(repo, "huge.txt"), "x".repeat(2_000_001));
    commit(repo, "add a huge file");
    expect(hashAnchors(["huge.txt"], repo)).toEqual({});
    expect(hashAnchorsAt(["huge.txt"], repo, "HEAD")).toEqual({});
  });

  test("a global note, and a note saved from outside its repo, get none", () => {
    const { repo, store } = fixture();
    expect(store.find(add(store, repo, { title: "A global fact", scope: "global", anchors: ["src/rates.ts"] }).json.id)!.anchor_hashes).toBeUndefined();
    const made = add(store, repo, { title: "Rates are fixed", anchors: ["src/rates.ts"] });
    const first = store.find(made.json.id)!.anchor_hashes;
    // An edit from another folder saw no file: the hash stays, and it goes with an anchor that leaves.
    writeFileSync(join(repo, "src/rates.ts"), "export const rate = 2;\n");
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ id: made.json.id, body: "Rates are fixed, by contract." }) }).json.status).toBe("updated");
    expect(store.find(made.json.id)!.anchor_hashes).toEqual(first);
    expect(kb(store, ["add", "--json"], { stdin: JSON.stringify({ id: made.json.id, anchors: ["src/ledger.ts"] }) }).json.status).toBe("updated");
    expect(store.find(made.json.id)!.anchor_hashes).toBeUndefined();
    // A new trigger is no check, also in the repo.
    const other = add(store, repo, { title: "The ledger is one file", anchors: ["src/ledger.ts"] });
    const before = store.find(other.json.id)!.anchor_hashes;
    edit(repo, "rows.push(row)", "rows.unshift(row)");
    kb(store, ["add", "--json"], { cwd: repo, stdin: JSON.stringify({ id: other.json.id, triggers: ["cmd: make ledger"] }) });
    expect(store.find(other.json.id)!.anchor_hashes).toEqual(before);
  });

  test("a hash in a note file that is no text, or of an anchor the note lacks, costs only itself", () => {
    const text = "---\nid: a\ntitle: A\nscope: global\nkind: gotcha\ncreated: 2026-01-01T00:00:00Z\nlast_verified: 2026-01-01T00:00:00Z\nanchors:\n  - x.ts\n  - y.ts\nanchor_hashes:\n  x.ts: abc\n  y.ts: 5\n  z.ts: def\nconfidence: high\n---\nBody.\n";
    expect(parseNote(text).anchor_hashes).toEqual({ "x.ts": "abc" });
    expect(parseNote(text.replace(/anchor_hashes:\n(  .*\n){3}/, "anchor_hashes: nope\n")).anchor_hashes).toBeUndefined();
  });
});

describe("a note with hashes is compared with the files as they are", () => {
  /** A note on the symbol append, and a note on the whole file. */
  function noted() {
    const made = fixture();
    const symbol = add(made.store, made.repo, { title: "Append returns the count", kind: "gotcha", anchors: ["src/ledger.ts#append"] }).json.id as string;
    const file = add(made.store, made.repo, { title: "The ledger is one file", anchors: ["src/ledger.ts"] }).json.id as string;
    return { ...made, symbol, file };
  }
  const changed = (store: ReturnType<typeof tempStore>, repo: string, id: string) => hashChanged(store.find(id)!, repo);

  test("a change outside the symbol marks the note on the file, and not the note on the symbol", () => {
    const { repo, store, symbol, file } = noted();
    expect([changed(store, repo, symbol), changed(store, repo, file)]).toEqual([[], []]);
    // No commit and no `kb stale`: the file on disk is what counts.
    edit(repo, "rows.length * rate", "rows.length * rate * 2");
    expect(changed(store, repo, symbol)).toEqual([]);
    expect(changed(store, repo, file)).toEqual(["src/ledger.ts"]);
    edit(repo, "rows.push(row)", "rows.unshift(row)");
    expect(changed(store, repo, symbol)).toEqual(["src/ledger.ts#append"]);
  });

  test("the load, kb show, the index and kb stale all say it at once, and kb verify ends it", () => {
    const { repo, store, symbol, file } = noted();
    edit(repo, "rows.push(row)", "rows.unshift(row)");
    const fired = afterRead(store, join(repo, "src/ledger.ts"), { session_id: "s1" })!;
    expect(fired.text).toContain("anchor on src/ledger.ts\nchanged since the last check: src/ledger.ts#append\n");
    expect(fired.text).toContain("The ledger is one file (changed since the last check: src/ledger.ts)");
    expect(kb(store, ["show", symbol], { cwd: repo }).stdout.split("\n")[1]).toStartWith("changed since the last check (");
    expect(changedSinceCheck(store.find(symbol)!, repo)).toEqual(["src/ledger.ts#append"]);
    expect(buildContext(store, repo).changed.sort()).toEqual([symbol, file].sort());
    const stale = findStale(store, repo).candidates.filter((c) => c.reason === "anchor-changed");
    expect(stale.map((c) => [c.id, c.detail, c.paths, c.commit])).toEqual([
      [symbol, "changed since the last check: src/ledger.ts#append", ["src/ledger.ts#append"], undefined],
      [file, "changed since the last check: src/ledger.ts", ["src/ledger.ts"], undefined],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    // The check takes the files as they are now, with the change that is not committed.
    expect(kb(store, ["verify", symbol, file], { cwd: repo }).code).toBe(0);
    expect(buildContext(store, repo).changed).toEqual([]);
    expect(findStale(store, repo).candidates.filter((c) => c.reason === "anchor-changed")).toEqual([]);
    // The change goes away again: the files are not what that check saw.
    sh(repo, "git", "checkout", "-q", "--", "src/ledger.ts");
    expect(buildContext(store, repo).changed.sort()).toEqual([symbol, file].sort());
  });

  test("it needs no commit: another clone, with no history of the check, compares the same way", () => {
    const { repo, store, symbol, file } = noted();
    // The check was on a branch that this clone never had.
    for (const id of [symbol, file]) {
      const { path: _path, trashed: _trashed, ...note } = store.find(id)!;
      store.writeNote({ ...note, verified_at_commit: "0123abc" });
    }
    expect(findStale(store, repo).candidates.filter((c) => c.reason !== "duplicate")).toEqual([]);
    edit(repo, "rows.length * rate", "rows.length * rate * 2");
    commit(repo, "double the total");
    expect(findStale(store, repo).candidates.filter((c) => c.reason !== "duplicate").map((c) => `${c.id}:${c.reason}`)).toEqual([`${file}:anchor-changed`]);
  });

  test("a note with a folder keeps the compare by commit for the folder, and a file that is gone has its own reason", () => {
    const { repo, store, head } = fixture();
    const id = add(store, repo, { title: "src is flat", anchors: ["src", "src/rates.ts"] }).json.id as string;
    writeFileSync(join(repo, "src/ledger.ts"), "export {};\n");
    commit(repo, "empty the ledger");
    const found = findStale(store, repo).candidates.find((c) => c.id === id)!;
    expect(found).toMatchObject({ reason: "anchor-changed", detail: `changed since ${head}: src`, paths: ["src"], commit: head, commitPaths: ["src"] });
    rmSync(join(repo, "src/rates.ts"));
    expect(hashChanged(store.find(id)!, repo)).toEqual([]);
    expect(findStale(store, repo).candidates.filter((c) => c.id === id).map((c) => c.reason)).toEqual(["anchor-changed", "anchor-missing"]);
  });

  test("a recovery with --as-of takes the hashes of the files at that time", () => {
    const { repo, store } = fixture();
    const then = sh(repo, "git", "log", "-1", "--format=%cI");
    // A commit time has whole seconds, so the next commit must come a second later.
    Bun.sleepSync(1100);
    edit(repo, "rows.push(row)", "rows.unshift(row)");
    commit(repo, "later");
    const made = kb(store, ["add", "--json", "--as-of", then], { cwd: repo, stdin: JSON.stringify({ title: "Append pushes", kind: "gotcha", scope: "repo", body: "Rows go to the end.", anchors: ["src/ledger.ts#append"] }) });
    expect(made.json.status).toBe("created");
    const note = store.find(made.json.id)!;
    // The note saw the old file, so it is marked as soon as it is saved.
    expect(note.anchor_hashes).toEqual({ "src/ledger.ts#append": hashText(LEDGER, "append")! });
    expect(hashChanged(note, repo)).toEqual(["src/ledger.ts#append"]);
  });
});
