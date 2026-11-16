import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../cli/context.ts";
import { HARD_CONTEXT_CAP } from "../cli/store.ts";
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
    const repo = tempRepo({ remote: REMOTE });
    putNote(store, { id: "one", scope: SCOPE, title: "First fact", body: "The body of one.", anchors: ["src/a.ts#run"], verified_at_commit: "abc1234" });
    putNote(store, { id: "two", title: "A global fact" });
    const { text } = buildContext(store, repo);
    expect(text).toContain(`# kb: saved knowledge for ${SCOPE}`);
    expect(text).toContain("### global (1)\n- two [gotcha] A global fact");
    // An id that is the slug of its title stands alone: the title would say it twice.
    putNote(store, { id: "amounts-are-integer-cents", title: "Amounts are integer cents!" });
    putNote(store, { id: "a-long-title-that-was-cut", title: "A long title that was cut at a word boundary" });
    const again = buildContext(store, repo).text;
    expect(again).toContain("- amounts-are-integer-cents [gotcha]\n");
    expect(again).toContain("- a-long-title-that-was-cut [gotcha]\n");
    expect(again).toContain("- two [gotcha] A global fact\n");
    expect(text).toContain(`### ${SCOPE} (1)\n- one [gotcha] First fact`);
    expect(text).toContain("### one [gotcha] First fact\nverified 2026-01-01 at abc1234 | confidence medium | anchors: src/a.ts#run\nThe body of one.");
    expect(text.indexOf("## Index")).toBeLessThan(text.indexOf("## Notes"));
    expect(text.trimEnd().endsWith("`kb search <query>` searches every note.")).toBe(true);
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
    expect(outside.index).toEqual(["global-note"]);
  });

  test("excludes promoted, unindexed and archived notes", () => {
    const store = tempStore();
    putNote(store, { id: "promoted", promoted_to: "CLAUDE.md" });
    putNote(store, { id: "hidden", indexed: false });
    putNote(store, { id: "gone" }, true);
    putNote(store, { id: "kept" });
    const result = buildContext(store, plain());
    expect(result.index).toEqual(["kept"]);
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
    expect(result.chars).toBeLessThanOrEqual(2000);
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
    // Every note still has its index line.
    expect(result.index).toEqual(ids);
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
    setConfig(store.home, { indexLines: 5 });
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`);
    ids.forEach((id, i) => putNote(store, { id, last_verified: `2026-01-${String(20 - i).padStart(2, "0")}T00:00:00Z` }));
    const result = buildContext(store, plain());
    expect(result.index).toEqual(ids.slice(0, 5));
    expect(result.hiddenIndexLines).toBe(4);
    expect(result.text).toContain("4 more index lines are over the index budget.");
    expect(result.text.match(/^- n\d \[/gm)?.length).toBe(5);
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
