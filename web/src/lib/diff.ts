// A word diff for the audit card: it marks only the words the proposal changes, so a one-character
// fix does not hide inside two whole copies of the note.

export type Op = "=" | "-" | "+";
export type Piece = { op: Op; text: string };
/** One line of the merged text. `whole` is set when every word on the line is removed, or every word is new. */
export type Line = { pieces: Piece[]; whole?: "-" | "+" };

/** Above this many token pairs, the card shows the whole text as replaced instead of running the table. */
const MAX_CELLS = 4_000_000;

/** Words, runs of spaces, line breaks, and each punctuation mark on its own, so `;` to `.` marks only the mark. */
function tokens(text: string): string[] {
  return text.match(/\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

const isWord = (token: string) => /[\p{L}\p{N}_]/u.test(token);

/** The longest common subsequence of two token lists, as a list of ops. */
function lcs(a: string[], b: string[]): Piece[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
  const out: Piece[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) out.push({ op: "=", text: a[i++]! }), j++;
    else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < n) out.push({ op: "-", text: a[i++]! });
  while (j < m) out.push({ op: "+", text: b[j++]! });
  return out;
}

/**
 * Diffs two texts by word. A shared run with no word in it (a space, a comma) that sits between two
 * changes joins the change, so a reworded phrase reads as one removed run and one new run, not a comb.
 */
export function wordDiff(before: string, after: string): Piece[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const raw = [
    ...a.slice(0, start).map((text) => ({ op: "=" as const, text })),
    ...lcs(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map((text) => ({ op: "=" as const, text })),
  ];

  // Group into runs: a shared run, or a change made of its removed and its new tokens.
  type Run = { same: string } | { del: string; ins: string };
  const runs: Run[] = [];
  for (const { op, text } of raw) {
    const last = runs.at(-1);
    if (op === "=") {
      if (last && "same" in last) last.same += text;
      else runs.push({ same: text });
    } else {
      const change = last && "del" in last ? last : (runs.push({ del: "", ins: "" }), runs.at(-1) as { del: string; ins: string });
      if (op === "-") change.del += text;
      else change.ins += text;
    }
  }
  // Fold a wordless shared run between two changes into the change around it.
  for (let k = 1; k < runs.length - 1; k++) {
    const run = runs[k]!;
    const prev = runs[k - 1]!;
    const next = runs[k + 1]!;
    if ("same" in run && !run.same.includes("\n") && !tokens(run.same).some(isWord) && "del" in prev && "del" in next) {
      prev.del += run.same + next.del;
      prev.ins += run.same + next.ins;
      runs.splice(k, 2);
      k--;
    }
  }
  const out: Piece[] = [];
  for (const run of runs) {
    if ("same" in run) out.push({ op: "=", text: run.same });
    else {
      if (run.del) out.push({ op: "-", text: run.del });
      if (run.ins) out.push({ op: "+", text: run.ins });
    }
  }
  return out;
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
