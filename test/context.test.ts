import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORMAT_LINE, SAVE_RULE, budgetOf, buildContext, contextBudget, indexLine } from "../cli/context.ts";
import { rememberRepo } from "../cli/repos.ts";
import { slugify } from "../cli/note.ts";
import { HARD_CONTEXT_CAP, type StoredNote } from "../cli/store.ts";
import { legacyUsage, logAt, plain, putNote, tempRepo, tempStore } from "./helpers.ts";

const REMOTE = "git@github.com:acme/billing.git";
const SCOPE = "github.com/acme/billing";

function setConfig(home: string, budgets: { indexLines?: number; contextChars?: number; globalIndexLines?: number }) {
  writeFileSync(join(home, "kb.config.json"), JSON.stringify({ budgets }));
}

describe("kb context ranking", () => {
  test("orders repo notes before global ones, then by kind, then last activity, then last_verified", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "howto", kind: "how-to", scope: SCOPE });
    putNote(store, { id: "decision", kind: "decision", scope: SCOPE });
    putNote(store, { id: "convention", kind: "convention", scope: SCOPE });
    putNote(store, { id: "gotcha-global", kind: "gotcha" });
    putNote(store, { id: "gotcha-old", kind: "gotcha", scope: SCOPE, last_verified: "2026-02-01T00:00:00Z" });
    putNote(store, { id: "gotcha-new", kind: "gotcha", scope: SCOPE, last_verified: "2026-03-01T00:00:00Z" });
    putNote(store, { id: "gotcha-used", kind: "gotcha", scope: SCOPE });
    putNote(store, { id: "open", kind: "open-work", scope: SCOPE });
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", note: "gotcha-used", why: "task" });

    const result = buildContext(store, repo);
    expect(result.scope).toBe(SCOPE);
    expect(result.bodies).toEqual(["open", "gotcha-used", "gotcha-new", "gotcha-old", "convention", "decision", "howto", "gotcha-global"]);
    expect(result.dropped).toEqual([]);
  });

  test("among repo notes of one kind the newest activity goes first: a show for a task, a fire, a verdict helped, or an older last_used", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    for (const id of ["a-quiet", "b-checked", "c-shown", "d-fired", "e-helped", "f-legacy", "g-not-needed"]) putNote(store, { id, scope: SCOPE });
    logAt(store, "2026-05-01T00:00:00Z", { ev: "show", note: "c-shown", why: "task" });
    logAt(store, "2026-05-02T00:00:00Z", { ev: "fire", kind: "path", form: "title", note: "d-fired", tool: "Read", match: "src/a.ts" });
    logAt(store, "2026-05-03T00:00:00Z", { ev: "verdict", note: "e-helped", verdict: "helped" });
    legacyUsage(store, "old", { "f-legacy": { uses: 1, last_used: "2026-05-04T00:00:00Z" } });
    // A check and a verdict that the note had no bearing are no activity.
    logAt(store, "2026-06-01T00:00:00Z", { ev: "show", note: "b-checked", why: "check" });
    logAt(store, "2026-06-01T00:00:00Z", { ev: "verdict", note: "g-not-needed", verdict: "not-needed" });
    expect(buildContext(store, repo).bodies).toEqual(["f-legacy", "e-helped", "d-fired", "c-shown", "a-quiet", "b-checked", "g-not-needed"]);
  });

  test("in a repo, global notes take at most globalIndexLines places: open work first, then by kind, then last verified", () => {
    const store = tempStore();
    setConfig(store.home, { globalIndexLines: 3 });
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "repo-note", kind: "how-to", scope: SCOPE });
    putNote(store, { id: "g-howto", kind: "how-to", last_verified: "2026-04-01T00:00:00Z" });
    putNote(store, { id: "g-rule-old", kind: "convention", last_verified: "2026-02-01T00:00:00Z" });
    putNote(store, { id: "g-rule-new", kind: "convention", last_verified: "2026-03-01T00:00:00Z" });
    putNote(store, { id: "g-trap", kind: "gotcha" });
    putNote(store, { id: "g-open", kind: "open-work" });
    // No count of reads lifts a global note: not the log, and not the counters of an older kb.
    for (const day of ["01", "02", "03"]) logAt(store, `2026-05-${day}T00:00:00Z`, { ev: "show", note: "g-howto", why: "task" });
    legacyUsage(store, "old", { "g-howto": { uses: 50, last_used: "2026-05-01T00:00:00Z" }, "g-rule-old": { uses: 9, last_used: "2026-05-01T00:00:00Z" } });
    const result = buildContext(store, repo);
    expect(result.bodies).toEqual(["repo-note", "g-open", "g-trap", "g-rule-new"]);
    expect(result.capped).toEqual(["g-rule-old", "g-howto"]);
    expect(result.text).toContain("2 global notes of lower rank are left out here. `kb show <id>` prints one note. `kb search <words>` searches every note.");
    // Left out on purpose is not over the budget, so no session hears that notes are hidden.
    expect(result.hiddenIndexLines).toBe(0);
    // Outside any repo, the global notes are the session's own, and none is left out.
    expect(buildContext(store, plain()).capped).toEqual([]);
  });

  test("a globalIndexLines that is not a number falls back to the default, so no global note is lost", () => {
    const store = tempStore();
    writeFileSync(join(store.home, "kb.config.json"), JSON.stringify({ budgets: { globalIndexLines: null } }));
    expect(store.config().budgets.globalIndexLines).toBe(20);
    setConfig(store.home, { globalIndexLines: 0 });
    expect(store.config().budgets.globalIndexLines).toBe(0);
  });

  test("prints the index, then bodies, then the pointer", () => {
    const store = tempStore();
    setConfig(store.home, { contextChars: 700 });
    const repo = tempRepo({ remote: REMOTE });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "export function run() {}\n");
    putNote(store, { id: "one", scope: SCOPE, title: "First fact", body: "The body of one.", anchors: ["src/a.ts#run"], verified_at_commit: "abc1234" });
    putNote(store, { id: "two", kind: "convention", title: "A global fact", body: "w".repeat(600) });
    putNote(store, { id: "three", kind: "how-to", scope: SCOPE, title: "A repo fact", body: "w".repeat(600) });
    const { text, bodies } = buildContext(store, repo);
    expect(bodies).toEqual(["one"]);
    expect(text).toContain(`# kb: saved knowledge for ${SCOPE}`);
    expect(text).toContain("### global (1)\n- two [convention] A global fact");
    expect(text).toContain(`### ${SCOPE} (1)\n- three [how-to] A repo fact`);
    // The repo's own notes come first, so global notes never crowd them out.
    expect(text.indexOf(`### ${SCOPE} (1)`)).toBeLessThan(text.indexOf("### global (1)"));
    expect(text).toContain("### one [gotcha] First fact\nverified 2026-01-01 at abc1234 | confidence medium | anchors: src/a.ts#run\nThe body of one.");
    expect(text.indexOf("## Index")).toBeLessThan(text.indexOf("## Notes"));
    expect(text.trimEnd().endsWith("`kb search <words>` searches every note.")).toBe(true);
    // The write path comes before the notes, so the budget can never cut it.
    expect(text.indexOf(SAVE_RULE)).toBeLessThan(text.indexOf("## Index"));
  });

  test("the fixed text is three lines: the scope, how to read the notes, and the write path", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "one", scope: SCOPE });
    expect(buildContext(store, repo).text).toStartWith(`# kb: saved knowledge for ${SCOPE}\n${FORMAT_LINE}\n${SAVE_RULE}\n\n## Notes`);
    // Every session pays for these lines, so they stay short. The write path keeps its three parts.
    expect(FORMAT_LINE).toContain("once");
    expect(FORMAT_LINE).toContain('"..."');
    expect(FORMAT_LINE.length).toBeLessThanOrEqual(100);
    for (const part of ["/kb:note", "`kb add`", "`kb search`"]) expect(SAVE_RULE).toContain(part);
    expect(FORMAT_LINE.length + SAVE_RULE.length).toBeLessThanOrEqual(400);
  });

  test("a note is printed once: its body, or an index line when the body did not fit", () => {
    const store = tempStore();
    setConfig(store.home, { contextChars: 2000 });
    const ids = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) => putNote(store, { id, body: "x".repeat(200), last_verified: `2026-01-${String(28 - i).padStart(2, "0")}T00:00:00Z` }));
    const result = buildContext(store, plain());
    expect(result.dropped.length).toBeGreaterThan(0);
    for (const id of ids) {
      const line = result.text.includes(`\n- ${id} [gotcha]`);
      const body = result.text.includes(`\n### ${id} [gotcha]`);
      expect(body).toBe(result.bodies.includes(id));
      expect(line).toBe(!body);
    }
    expect(result.text).toContain(`### global (${result.dropped.length})`);
  });

  test("when every body fits, there is no index", () => {
    const store = tempStore();
    putNote(store, { id: "one" });
    putNote(store, { id: "two" });
    const { text } = buildContext(store, plain());
    expect(text).not.toContain("## Index");
    expect(text).toContain("## Notes (2 of 2, by rank)");
  });

  test("an index line keeps the words of the title that the id cut", () => {
    const line = (id: string, title: string) => indexLine({ id, title, kind: "gotcha" } as StoredNote);
    // The gotcha is in the last word. The id alone would lose it.
    const title = "The deploy CLI exits 0 when the upload was rejected";
    expect(slugify(title)).toBe("the-deploy-cli-exits-0-when-the-upload-was");
    expect(line(slugify(title), title)).toBe("- the-deploy-cli-exits-0-when-the-upload-was [gotcha] ...rejected");
    const long = "Never run the migration tool against the shared staging database (it is shared)";
    expect(line(slugify(long), long)).toBe("- never-run-the-migration-tool-against-the-shared [gotcha] ...staging database (it is shared)");
    // An id that is the whole title stands alone: the title would say it twice.
    expect(line("amounts-are-integer-cents", "Amounts are integer cents!")).toBe("- amounts-are-integer-cents [gotcha]");
    // An id that does not come from the title gets the whole title.
    expect(line("two", "A global fact")).toBe("- two [gotcha] A global fact");
    expect(line("amounts-are-integer-cents-2", "Amounts are integer cents")).toBe("- amounts-are-integer-cents-2 [gotcha] Amounts are integer cents");
  });
});

describe("kb context visibility", () => {
  test("shows global and the current repo, never another repo", () => {
    const store = tempStore();
    putNote(store, { id: "billing-note", scope: SCOPE });
    putNote(store, { id: "global-note" });
    const other = buildContext(store, tempRepo({ remote: "https://github.com/acme/web.git" }));
    expect(other.text).not.toContain("billing-note");
    expect(other.text).toContain("global-note");
    const outside = buildContext(store, plain());
    expect(outside.scope).toBeNull();
    expect(outside.bodies).toEqual(["global-note"]);
  });

  test("excludes promoted and trashed notes", () => {
    const store = tempStore();
    putNote(store, { id: "promoted", promoted_to: "CLAUDE.md" });
    putNote(store, { id: "gone" }, true);
    putNote(store, { id: "kept" });
    const result = buildContext(store, plain());
    expect(result.bodies).toEqual(["kept"]);
  });

  test("a repo note whose file or symbol is gone says so, and a sound note or a global note does not", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/ledger.ts"), "export function append() {}\n");
    putNote(store, { id: "sound", scope: SCOPE, anchors: ["src/ledger.ts#append", "src"] });
    putNote(store, { id: "renamed", scope: SCOPE, anchors: ["src/ledger.ts#post"] });
    putNote(store, { id: "deleted", scope: SCOPE, anchors: ["src/rates.ts", "src/ledger.ts"] });
    putNote(store, { id: "outside", scope: SCOPE, anchors: ["../elsewhere.ts"] });
    putNote(store, { id: "global-anchored", anchors: ["src/nothing.ts"] });
    const { text, gone } = buildContext(store, repo);
    expect(gone).toEqual([
      { id: "deleted", detail: "src/rates.ts does not exist" },
      { id: "outside", detail: "../elsewhere.ts does not exist" },
      { id: "renamed", detail: "post is no longer in src/ledger.ts" },
    ]);
    expect(text).toContain("## Anchors gone\nThese notes name a file or a symbol that is not in the checkout now.");
    expect(text).toContain("- renamed: post is no longer in src/ledger.ts\n");
    // Outside the repo nothing is checked: a global note's anchors name no checkout.
    expect(buildContext(store, plain()).gone).toEqual([]);
  });

  test("a checkout that lacks many anchored files lists five notes, so the index keeps its room", () => {
    const store = tempStore();
    const repo = tempRepo({ remote: REMOTE });
    for (let i = 0; i < 40; i++) putNote(store, { id: `gone-${String(i).padStart(2, "0")}`, scope: SCOPE, anchors: [`src/file-${i}.ts`] });
    const result = buildContext(store, repo);
    expect(result.gone).toHaveLength(result.bodies.length + result.index.length);
    const section = result.text.slice(result.text.indexOf("## Anchors gone"), result.text.indexOf("## Index"));
    expect(section.match(/^- gone-/gm)).toHaveLength(5);
    expect(section).toContain(`${result.gone.length - 5} more. \`kb stale\` lists them.`);
    // The kb budget of the scope sees the same session as the session start.
    rememberRepo(store, SCOPE, repo);
    expect(budgetOf(store, SCOPE).context.chars).toBe(result.chars);
  });

  test("prints nothing when no note is visible", () => {
    const store = tempStore();
    putNote(store, { id: "elsewhere", scope: "github.com/acme/other" });
    expect(buildContext(store, plain()).text).toBe("");
  });
});

describe("kb context budgets", () => {
  test("character budget drops whole notes from the bottom and never cuts one", () => {
    const store = tempStore();
    setConfig(store.home, { contextChars: 2000 });
    const ids = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, "0")}`);
    // Later ids rank lower: older last_verified.
    ids.forEach((id, i) => putNote(store, { id, body: `START-${id} ${"x".repeat(200)} END-${id}`, last_verified: `2026-01-${String(28 - i).padStart(2, "0")}T00:00:00Z` }));

    const result = buildContext(store, plain());
    expect(result.chars).toBeLessThanOrEqual(contextBudget(2000));
    expect(result.text.length).toBe(result.chars);
    expect(result.bodies.length).toBeGreaterThan(0);
    expect(result.bodies.length).toBeLessThan(ids.length);
    // The printed bodies are exactly the top of the ranking.
    expect(result.bodies).toEqual(ids.slice(0, result.bodies.length));
    expect(result.dropped).toEqual(ids.slice(result.bodies.length));
    for (const id of ids) {
      const hasStart = result.text.includes(`START-${id}`);
      expect(result.text.includes(`END-${id}`)).toBe(hasStart);
      expect(hasStart).toBe(result.bodies.includes(id));
    }
    // Every note without a body has its index line.
    expect(result.index).toEqual(result.dropped);
    expect(result.text).toContain(`${result.dropped.length} notes are in the index only`);
  });

  test("a short low-ranked note does not jump ahead of a long one that did not fit", () => {
    const store = tempStore();
    setConfig(store.home, { contextChars: 900 });
    putNote(store, { id: "a-top", kind: "open-work", body: "short" });
    putNote(store, { id: "b-long", kind: "gotcha", body: "y".repeat(700) });
    putNote(store, { id: "c-short", kind: "how-to", body: "tiny" });
    const result = buildContext(store, plain());
    expect(result.bodies).toEqual(["a-top"]);
    expect(result.dropped).toEqual(["b-long", "c-short"]);
  });

  test("index budget keeps the top-ranked lines and reports the others", () => {
    const store = tempStore();
    setConfig(store.home, { indexLines: 5, contextChars: 900 });
    const ids = Array.from({ length: 12 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) => putNote(store, { id, body: "x".repeat(150), last_verified: `2026-01-${String(20 - i).padStart(2, "0")}T00:00:00Z` }));
    const result = buildContext(store, plain());
    const shown = result.bodies.length;
    expect(shown).toBeGreaterThan(0);
    // The five lines go to the notes that rank next after the bodies.
    expect(result.index).toEqual(ids.slice(shown, shown + 5));
    expect(result.hiddenIndexLines).toBe(12 - shown - 5);
    expect(result.text).toContain(`${12 - shown - 5} more index lines are over the index budget.`);
    expect(result.text.match(/^- n\d\d \[/gm)?.length).toBe(5);
    expect(result.chars).toBeLessThanOrEqual(contextBudget(900));
  });

  test("a note with a body does not count against the index budget", () => {
    const store = tempStore();
    setConfig(store.home, { indexLines: 5 });
    for (let i = 0; i < 9; i++) putNote(store, { id: `n${i}` });
    const result = buildContext(store, plain());
    expect(result.bodies.length).toBe(9);
    expect(result.hiddenIndexLines).toBe(0);
    expect(result.text).not.toContain("over the index budget");
  });

  test("a configured budget above the SessionStart cap is clamped", () => {
    const store = tempStore();
    setConfig(store.home, { contextChars: 50_000, indexLines: 500 });
    for (let i = 0; i < 80; i++) putNote(store, { id: `big-${i}`, body: "z".repeat(400) });
    const result = buildContext(store, plain());
    expect(result.chars).toBeLessThanOrEqual(HARD_CONTEXT_CAP);
    expect(result.chars).toBeGreaterThan(HARD_CONTEXT_CAP - 600);
  });
});
