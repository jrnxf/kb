// HOLDBACK: the arm of session starts that keeps the old policy, so the next audit can compare it
// with the briefs. In this arm a session start fills its room with whole bodies in rank order, as
// every start did before. To end the experiment, delete this file and each line that a "HOLDBACK"
// comment marks: `grep -rn HOLDBACK cli hooks test` lists them. The README has one bullet on it.

import { createHash } from "node:crypto";
import { type Note, localDate } from "./note.ts";

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
export function bodyBlock(note: Note): string {
  const meta = [`verified ${localDate(note.last_verified)}${note.verified_at_commit ? ` at ${note.verified_at_commit}` : ""}`, `confidence ${note.confidence}`];
  if (note.anchors.length > 0) meta.push(`anchors: ${note.anchors.join(", ")}`);
  return `### ${note.id} [${note.kind}] ${note.title}\n${meta.join(" | ")}\n${note.body}\n`;
}

/**
 * Whole bodies in rank order. The first one that does not fit ends the list, so a note is never
 * cut in half and a low-ranked short note never jumps ahead of a higher one.
 */
export function fillBodies<T>(ranked: T[], fits: (bodies: T[]) => boolean): T[] {
  const bodies: T[] = [];
  for (const note of ranked) {
    if (!fits([...bodies, note])) break;
    bodies.push(note);
  }
  return bodies;
}
