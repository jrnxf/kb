import { describe, expect, test } from "bun:test";
import { diffLines, wordDiff } from "../web/src/lib/diff.ts";

const show = (before: string, after: string) =>
  wordDiff(before, after).map(({ op, text }) => (op === "=" ? text : op === "-" ? `[-${text}-]` : `{+${text}+}`)).join("");

describe("the audit card's word diff", () => {
  test("marks only a changed punctuation mark, not the word next to it", () => {
    expect(show("wait in the audit; the agent reads them", "wait in the audit. The agent reads them")).toBe("wait in the audit[-; the-]{+. The+} agent reads them");
  });

  test("marks an added word and leaves the rest plain", () => {
    expect(show("reads them with `kb audit`.", "reads them with `kb audit status`.")).toBe("reads them with `kb audit{+ status+}`.");
  });

  test("gives back both texts exactly, whatever it marks", () => {
    const before = "One line.\nWhy: a; b; c.\nLast line stays.";
    const after = "One line, now longer.\nA new line.\nWhy: a. B. C.\nLast line stays.";
    const pieces = wordDiff(before, after);
    expect(pieces.filter((p) => p.op !== "+").map((p) => p.text).join("")).toBe(before);
    expect(pieces.filter((p) => p.op !== "-").map((p) => p.text).join("")).toBe(after);
  });

  test("marks a wholly new line as new, and keeps the lines around it apart", () => {
    const lines = diffLines(wordDiff("First.\nLast.", "First.\nAdded here.\nLast."));
    expect(lines.map((line) => [line.pieces.map((p) => p.text).join(""), line.whole ?? null])).toEqual([
      ["First.", null],
      ["Added here.", "+"],
      ["Last.", null],
    ]);
  });

  test("marks a wholly removed line as removed", () => {
    const lines = diffLines(wordDiff("First.\nGone now.\nLast.", "First.\nLast."));
    expect(lines.map((line) => line.whole ?? null)).toEqual([null, "-", null]);
  });

  test("keeps the blank lines both texts share around a new or removed paragraph", () => {
    const text = (before: string, after: string) => diffLines(wordDiff(before, after)).map((line) => line.pieces.map((p) => p.text).join(""));
    expect(text("a\n\nb", "a\n\nNEW\n\nb")).toEqual(["a", "", "NEW", "", "b"]);
    expect(text("a\n\nOLD\n\nb", "a\n\nb")).toEqual(["a", "", "OLD", "", "b"]);
  });
});
