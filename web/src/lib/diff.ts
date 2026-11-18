// A word diff for the audit card: it marks only the words the proposal changes, so a one-character
// fix does not hide inside two whole copies of the note.

import { diffWordsWithSpace } from "diff";

export type Op = "=" | "-" | "+";
export type Piece = { op: Op; text: string };
/** One line of the merged text. `whole` is set when every word on the line is removed, or every word is new. */
export type Line = { pieces: Piece[]; whole?: "-" | "+" };

/**
 * Diffs two texts by word with jsdiff. A shared run of spaces between two changes joins them, so a
 * reworded phrase reads as one removed run and one new run, not a comb of single words.
 */
export function wordDiff(before: string, after: string): Piece[] {
  const runs: { same?: string; del: string; ins: string }[] = [];
  for (const change of diffWordsWithSpace(before, after)) {
    const last = runs.at(-1);
    if (!change.added && !change.removed) runs.push({ same: change.value, del: "", ins: "" });
    else {
      const run = last && last.same === undefined ? last : (runs.push({ del: "", ins: "" }), runs.at(-1)!);
      if (change.removed) run.del += change.value;
      else run.ins += change.value;
    }
  }
  for (let k = 1; k < runs.length - 1; k++) {
    const [prev, run, next] = [runs[k - 1]!, runs[k]!, runs[k + 1]!];
    if (run.same !== undefined && /^[^\S\n]+$/.test(run.same) && prev.same === undefined && next.same === undefined) {
      prev.del += run.same + next.del;
      prev.ins += run.same + next.ins;
      runs.splice(k--, 2);
    }
  }
  return runs.flatMap((run): Piece[] =>
    run.same !== undefined ? [{ op: "=", text: run.same }] : [...(run.del ? [{ op: "-" as const, text: run.del }] : []), ...(run.ins ? [{ op: "+" as const, text: run.ins }] : [])],
  );
}

/** Splits a diff at its line breaks, and marks lines that are wholly removed or wholly new. */
export function diffLines(pieces: Piece[]): Line[] {
  // Each line remembers the op of the break before it and the break after it.
  const lines: (Line & { from: Op; to: Op })[] = [{ pieces: [], from: "=", to: "=" }];
  for (const { op, text } of pieces) {
    text.split("\n").forEach((part, index) => {
      if (index > 0) {
        lines.at(-1)!.to = op;
        lines.push({ pieces: [], from: op, to: "=" });
      }
      if (part) lines.at(-1)!.pieces.push({ op, text: part });
    });
  }
  for (const line of lines) {
    const ops = new Set(line.pieces.filter((piece) => piece.text.trim()).map((piece) => piece.op));
    if (ops.size === 1 && !ops.has("=")) line.whole = ops.has("-") ? "-" : "+";
  }
  // An empty line is real when one side has both of its breaks. Between a removed break and a new one,
  // it is only where the two texts meet, so it goes.
  const real = (line: { from: Op; to: Op }) => (line.from !== "+" && line.to !== "+") || (line.from !== "-" && line.to !== "-");
  return lines.filter((line) => line.pieces.length || real(line)).map(({ pieces, whole }) => (whole ? { pieces, whole } : { pieces }));
}
