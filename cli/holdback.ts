// HOLDBACK: the arm of session starts that keeps the old policy, so the next audit can compare it
// with the briefs. This file is that policy as it was: its limits, its selection and its text. A
// start of the arm gives what kb gave before the briefs, note for note. To end the experiment,
// delete this file and each line that a "HOLDBACK" comment marks: `grep -rn HOLDBACK cli hooks test`
// lists them. The README has one bullet on it.

import { createHash } from "node:crypto";
import { type Note, localDate } from "./note.ts";

/** The old limit of the index: at most this many notes got a line. */
export const OLD_INDEX_LINES = 60;

/** The old limit of the global notes in a repo session, bodies and index lines together. The rest stayed out. */
export const OLD_GLOBAL_NOTES = 20;

/**
 * True for the share of sessions that keep the old policy. The arm comes from a hash of the
 * session id, so a resume, a compaction and a /clear of one session stay in one arm, on every
 * machine. A start with no session id gets the new policy.
 */
export function inHoldback(session: string | undefined, share: number): boolean {
  if (!session || !(share > 0)) return false;
  return createHash("sha256").update(session).digest().readUInt32BE(0) / 2 ** 32 < share;
}

/** A whole note: the id, the kind and the title, one line of facts about the note, and the body. */
function bodyBlock(note: Note): string {
  const meta = [`verified ${localDate(note.last_verified)}${note.verified_at_commit ? ` at ${note.verified_at_commit}` : ""}`, `confidence ${note.confidence}`];
  if (note.anchors.length > 0) meta.push(`anchors: ${note.anchors.join(", ")}`);
  return `### ${note.id} [${note.kind}] ${note.title}\n${meta.join(" | ")}\n${note.body}\n`;
}

/** The last line of the old text: how many notes have no body, and how many global notes stay out. */
function oldPointer(dropped: number, capped: number): string {
  const fit = dropped > 0 ? `${dropped} ${dropped === 1 ? "note is" : "notes are"} in the index only, because the bodies did not fit. ` : "";
  const out = capped > 0 ? `${capped} global ${capped === 1 ? "note" : "notes"} of lower rank ${capped === 1 ? "is" : "are"} left out here. ` : "";
  return `${fit}${out}\`kb show <id>\` prints one note. \`kb search <words>\` searches every note.`;
}

/** The parts of the text that both policies print the same way. The caller builds them. */
export interface StartParts<T> {
  /** The lines before the notes: the fixed text, and what is gone from the notes shown. */
  head(shown: T[]): string[];
  /** The index section of these notes, with a last line that counts the `hidden` ones. */
  index(listed: T[], hidden: number): string[];
}

export interface OldStart<T> {
  text: string;
  /** The notes with a whole body: the top of the ranking. */
  bodies: T[];
  /** The notes with an index line: the next ones, up to the old limit. */
  listed: T[];
  /** The notes in no session: over the old index limit, then over the old global limit. */
  hidden: T[];
  /** Characters of the index section and of the bodies section. */
  sizes: { index: number; bodies: number };
}

/**
 * The old session start. `ranked` is every note of the session in rank order. In a repo, global
 * notes take at most `OLD_GLOBAL_NOTES` places. The index is cut to fit first. Then whole bodies
 * fill the room in rank order: the first one that does not fit ends the list, so a note is never
 * cut in half and a low-ranked short note never jumps ahead of a higher one. A note with a body
 * has no index line.
 */
export function oldStart<T extends Note>(ranked: T[], inRepo: boolean, parts: StartParts<T>, charBudget: number): OldStart<T> {
  const globals = ranked.filter((n) => n.scope === "global");
  const capped = new Set(inRepo ? globals.slice(OLD_GLOBAL_NOTES) : []);
  const notes = ranked.filter((n) => !capped.has(n));
  const listedFor = (bodyCount: number, lines: number) => notes.slice(bodyCount, bodyCount + lines);

  const size = (lines: string[], from: number, to: number) => lines.slice(from, to).reduce((sum, line) => sum + line.length + 1, 0);
  const render = (listed: T[], bodies: T[], sizes?: OldStart<T>["sizes"]): string => {
    const lines = parts.head([...bodies, ...listed]);
    const indexFrom = lines.length;
    lines.push(...parts.index(listed, notes.length - bodies.length - listed.length));
    const bodiesFrom = lines.length;
    if (bodies.length > 0) {
      lines.push("", `## Notes (${bodies.length} of ${notes.length}, by rank)`);
      for (const note of bodies) lines.push(bodyBlock(note));
    } else {
      lines.push("");
    }
    if (sizes) Object.assign(sizes, { index: size(lines, indexFrom, bodiesFrom), bodies: bodies.length > 0 ? size(lines, bodiesFrom, lines.length) : 0 });
    if (notes.length > 0) lines.push(oldPointer(listed.length, capped.size));
    return `${lines.join("\n")}\n`;
  };

  // The index comes first. If it alone is over the character budget, it is cut from the bottom.
  let indexCount = Math.min(notes.length, OLD_INDEX_LINES);
  while (indexCount > 1 && render(listedFor(0, indexCount), []).length > charBudget) indexCount--;

  const bodies: T[] = [];
  for (const note of notes) {
    if (render(listedFor(bodies.length + 1, indexCount), [...bodies, note]).length > charBudget) break;
    bodies.push(note);
  }

  const listed = listedFor(bodies.length, indexCount);
  const sizes = { index: 0, bodies: 0 };
  const text = render(listed, bodies, sizes);
  return { text, bodies, listed, hidden: [...notes.slice(bodies.length + listed.length), ...capped], sizes };
}
