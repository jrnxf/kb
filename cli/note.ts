// Note schema, frontmatter parsing and serialisation.

import { createHash } from "node:crypto";

export const KINDS = ["open-work", "gotcha", "convention", "decision", "how-to"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Kind = (typeof KINDS)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export interface Note {
  id: string;
  title: string;
  scope: string;
  kind: Kind;
  created: string;
  last_verified: string;
  verified_at_commit?: string;
  anchors: string[];
  /**
   * When the note loads outside the session start, each `<kind>: <text>`: `cmd` and `stop` at a
   * shell command (only `stop` comes before the run), `err` after an error. trigger.ts reads them.
   * A path is an anchor, not a trigger.
   */
  triggers?: string[];
  confidence: Confidence;
  promoted_to?: string;
  supersedes?: string[];
  /** When the note moved to trash/. A note in the trash for longer than `trashDays` is deleted. */
  trashed_at?: string;
  body: string;
}

export class KbError extends Error {}

/** A body up to this length loads whole at a trigger. A longer one is cut there, and `kb add` warns about it. */
export const BODY_CHARS = 700;

/** The day of a time in the local zone of this machine, as a session reads it: 2026-03-02. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SCOPE_RE = /^[a-z0-9._-]+(\/[a-z0-9._~-]+)*$/;

export function isValidScope(scope: string): boolean {
  return SCOPE_RE.test(scope) && !scope.split("/").some((part) => part === "." || part === "..");
}

/**
 * Lowercase ASCII words joined by "-". The full form compares titles. An accent is folded into
 * its letter (Ü gives u), and a letter with no ASCII form, such as 日本語, is left out.
 */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The key that compares two titles. Most titles have ASCII words, and those decide. A title
 * with none, such as one only in Japanese, compares in full, with case and spaces folded.
 */
export function titleKey(text: string): string {
  return normalizeTitle(text) || text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

const MAX_SLUG = 48;

/** A short id from a title: cut at a word boundary, because the id sits next to the title in every index line. */
export function slugify(text: string): string {
  const full = normalizeTitle(text);
  if (full.length <= MAX_SLUG) return full;
  const cut = full.slice(0, MAX_SLUG + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary >= 20 ? cut.slice(0, boundary) : full.slice(0, MAX_SLUG)).replace(/-+$/, "");
}

/**
 * The id of a new note with this title: its slug. A title with no ASCII letter or digit gets
 * "note-" and a hash of its words, so the same title always gives the same id. Empty only for
 * an empty title.
 */
export function titleId(title: string): string {
  const slug = slugify(title);
  if (slug) return slug;
  const key = titleKey(title);
  return key ? `note-${createHash("sha256").update(key).digest("hex").slice(0, 8)}` : "";
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function toIso(value: unknown, field: string): string {
  // YAML may hand back a Date for an unquoted timestamp.
  const date = value instanceof Date ? value : new Date(String(value));
  if (value == null || Number.isNaN(date.getTime())) throw new KbError(`${field}: not a timestamp`);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Validate an untrusted object and return a Note. Throws KbError with every problem found. */
export function validateNote(raw: Record<string, unknown>): Note {
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

  need(isString(raw.id) && normalizeTitle(raw.id) === raw.id, "id: must be a lowercase slug");
  need(isString(raw.title), "title: required");
  need(isString(raw.scope) && isValidScope(raw.scope), "scope: must be \"global\" or a repo id");
  need(KINDS.includes(raw.kind as Kind), `kind: must be one of ${KINDS.join(", ")}`);
  need(CONFIDENCES.includes(raw.confidence as Confidence), `confidence: must be one of ${CONFIDENCES.join(", ")}`);
  need(raw.anchors === undefined || (Array.isArray(raw.anchors) && raw.anchors.every(isString)), "anchors: must be a list of paths");
  // Only the shape is checked here. A write checks each trigger with requireTriggers. A read takes
  // the list through storedTriggers first, so a trigger that a hand or a later kb wrote hides no note.
  need(raw.triggers === undefined || isStringArray(raw.triggers), "triggers: must be a list of texts");
  need(raw.supersedes === undefined || isStringArray(raw.supersedes), "supersedes: must be a list of ids");
  need(raw.promoted_to === undefined || isString(raw.promoted_to), "promoted_to: must be a file name");
  need(raw.verified_at_commit === undefined || isString(raw.verified_at_commit), "verified_at_commit: must be a commit");
  need(typeof raw.body === "string" && raw.body.trim().length > 0, "body: required");

  let created = "";
  let lastVerified = "";
  let trashedAt: string | undefined;
  try {
    created = toIso(raw.created, "created");
    lastVerified = toIso(raw.last_verified, "last_verified");
    if (raw.trashed_at !== undefined) trashedAt = toIso(raw.trashed_at, "trashed_at");
  } catch (error) {
    problems.push((error as Error).message);
  }

  if (problems.length > 0) throw new KbError(`invalid note: ${problems.join("; ")}`);

  const note: Note = {
    id: raw.id as string,
    title: (raw.title as string).trim(),
    scope: raw.scope as string,
    kind: raw.kind as Kind,
    created,
    last_verified: lastVerified,
    anchors: (raw.anchors as string[] | undefined) ?? [],
    confidence: raw.confidence as Confidence,
    body: (raw.body as string).trim(),
  };
  if (raw.triggers !== undefined && (raw.triggers as string[]).length > 0) note.triggers = raw.triggers as string[];
  if (raw.verified_at_commit !== undefined) note.verified_at_commit = raw.verified_at_commit as string;
  if (raw.promoted_to !== undefined) note.promoted_to = raw.promoted_to as string;
  if (raw.supersedes !== undefined && (raw.supersedes as string[]).length > 0) note.supersedes = raw.supersedes as string[];
  if (trashedAt) note.trashed_at = trashedAt;
  return note;
}

/**
 * The triggers of a note file, as a hand may have written them. YAML reads `- cmd: zorp --wipe`
 * with no quotes as a map with one key: that is the same trigger. An item of any other shape is
 * left out. A broken trigger must cost only itself, never the note: a note that fails here is in
 * no list, no search and no session, with no message.
 */
function storedTriggers(value: unknown): string[] {
  const texts: string[] = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (isString(item)) texts.push(item);
    else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item);
      const text = entries[0]?.[1];
      if (entries.length === 1 && (isString(text) || typeof text === "number" || typeof text === "boolean")) texts.push(`${entries[0]![0]}: ${text}`);
    }
  }
  return texts;
}

export function parseNote(text: string): Note {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new KbError("invalid note: no frontmatter");
  const front = Bun.YAML.parse(match[1]!) as Record<string, unknown> | null;
  if (front === null || typeof front !== "object" || Array.isArray(front)) throw new KbError("invalid note: frontmatter is not a map");
  return validateNote({ ...front, ...("triggers" in front ? { triggers: storedTriggers(front.triggers) } : {}), body: match[2] });
}

/** Most recently trashed first. A note with no trashed_at goes by its last verification. */
export function byTrashedAt(a: Pick<Note, "trashed_at" | "last_verified">, b: Pick<Note, "trashed_at" | "last_verified">): number {
  return (b.trashed_at ?? b.last_verified).localeCompare(a.trashed_at ?? a.last_verified);
}

/** Words that a YAML reader takes as a boolean or null, in YAML 1.1 or 1.2. */
const RESERVED = /^(?:null|~|true|false|yes|no|on|off|y|n)$/i;
/** A number in YAML 1.1 or 1.2: decimal, float, hex, octal, binary, sexagesimal, inf, nan. */
const NUMBER = /^[-+]?(?:[\d_]+(?:\.[\d_]*)?(?:e[-+]?\d+)?|\.\d[\d_]*(?:e[-+]?\d+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?::[0-5]?\d)+(?:\.\d*)?|\.inf|\.nan)$/i;
/** A date with no time, which a YAML 1.1 reader turns into a timestamp. */
const DATE = /^\d{4}-\d\d?-\d\d?(?:[Tt ]|$)/;

/**
 * A string as a YAML scalar. A plain one when no reader can take it for anything else, else
 * double quotes with JSON escapes, which YAML reads the same. The rules are kb's own, so the
 * file does not change with the version of Bun. `time` lets a timestamp stay plain.
 */
function scalar(text: string, time = false): string {
  if (time && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text)) return text;
  const plain =
    text.length > 0 &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
    !/\s$/.test(text) &&
    // Only a plain space: any other space, a control character or a line break needs an escape.
    !/[\p{Cc}\p{Zl}\p{Zp}\p{Zs}\ufeff]/u.test(text.replaceAll(" ", "")) &&
    !/[,[\]{}'"`]|: |\s#|:$|^(?:---|\.\.\.)/.test(text) &&
    !RESERVED.test(text) &&
    !NUMBER.test(text) &&
    !DATE.test(text) &&
    text !== "<<";
  return plain ? text : JSON.stringify(text).replace(/[\u0085\u2028\u2029\ufeff\u00a0]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** One key of the front matter: a scalar on its line, or a list with one item per line. */
function frontLine(key: string, value: string | string[], time = false): string {
  if (!Array.isArray(value)) return `${key}: ${scalar(value, time)}`;
  if (value.length === 0) return `${key}: []`;
  return [`${key}:`, ...value.map((item) => `  - ${scalar(item)}`)].join("\n");
}

export function serializeNote(note: Note): string {
  // Key order is fixed so diffs stay small.
  const lines = [
    frontLine("id", note.id),
    frontLine("title", note.title),
    frontLine("scope", note.scope),
    frontLine("kind", note.kind),
    frontLine("created", note.created, true),
    frontLine("last_verified", note.last_verified, true),
  ];
  if (note.verified_at_commit) lines.push(frontLine("verified_at_commit", note.verified_at_commit));
  lines.push(frontLine("anchors", note.anchors));
  if (note.triggers?.length) lines.push(frontLine("triggers", note.triggers));
  lines.push(frontLine("confidence", note.confidence));
  if (note.promoted_to) lines.push(frontLine("promoted_to", note.promoted_to));
  if (note.supersedes?.length) lines.push(frontLine("supersedes", note.supersedes));
  if (note.trashed_at) lines.push(frontLine("trashed_at", note.trashed_at, true));
  return `---\n${lines.join("\n")}\n---\n${note.body.trim()}\n`;
}
