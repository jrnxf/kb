import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAVE_RULE, buildContext, contextBudget, indexLine } from "../cli/context.ts";
import { slugify } from "../cli/note.ts";
import { HARD_CONTEXT_CAP, type StoredNote } from "../cli/store.ts";
import { plain, putNote, tempRepo, tempStore } from "./helpers.ts";

const REMOTE = "git@github.com:acme/billing.git";
const SCOPE = "github.com/acme/billing";

function setConfig(home: string, budgets: { indexLines?: number; contextChars?: number }) {
  writeFileSync(join(home, "kb.config.json"), JSON.stringify({ budgets }));
}

describe("kb context ranking", () => {
  test("orders by kind, then repo before global, then last_used, then last_verified", () => {
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
    store.bumpUsage(["gotcha-used"], "2026-05-01T00:00:00Z");

    const result = buildContext(store, repo);
    expect(result.scope).toBe(SCOPE);
    expect(result.bodies).toEqual(["open", "gotcha-used", "gotcha-new", "gotcha-old", "gotcha-global", "convention", "decision", "howto"]);
    expect(result.dropped).toEqual([]);
  });

  test("prints the index, then bodies, then the pointer", () => {
    const store = tempStore();
    setConfig(store.home, { contextChars: 700 });
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "one", scope: SCOPE, title: "First fact", body: "The body of one.", anchors: ["src/a.ts#run"], verified_at_commit: "abc1234" });
    putNote(store, { id: "two", kind: "convention", title: "A global fact", body: "w".repeat(600) });
    putNote(store, { id: "three", kind: "how-to", scope: SCOPE, title: "A repo fact" });
    const { text, bodies } = buildContext(store, repo);
    expect(bodies).toEqual(["one"]);
    expect(text).toContain(`# kb: saved knowledge for ${SCOPE}`);
    expect(text).toContain("### global (1)\n- two [convention] A global fact");
    expect(text).toContain(`### ${SCOPE} (1)\n- three [how-to] A repo fact`);
    expect(text).toContain("### one [gotcha] First fact\nverified 2026-01-01 at abc1234 | confidence medium | anchors: src/a.ts#run\nThe body of one.");
    expect(text.indexOf("## Index")).toBeLessThan(text.indexOf("## Notes"));
    expect(text.trimEnd().endsWith("`kb search <words>` searches every note.")).toBe(true);
    // The write path comes before the notes, so the budget can never cut it.
    expect(text.indexOf(SAVE_RULE)).toBeLessThan(text.indexOf("## Index"));
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
