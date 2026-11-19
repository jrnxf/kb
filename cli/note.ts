// Note schema, frontmatter parsing and serialisation.

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
   * When the note loads outside the session start, each `<kind>: <text>`: `cmd` and `stop` before
   * a shell command, `err` after an error. trigger.ts reads them. A path is an anchor, not a trigger.
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

const SCOPE_RE = /^[a-z0-9._-]+(\/[a-z0-9._~-]+)*$/;

export function isValidScope(scope: string): boolean {
  return SCOPE_RE.test(scope) && !scope.split("/").some((part) => part === "." || part === "..");
}

/** Lowercase words joined by "-". The full form compares titles. */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

export function serializeNote(note: Note): string {
  // Key order is fixed so diffs stay small.
  const front: Record<string, unknown> = {
    id: note.id,
    title: note.title,
    scope: note.scope,
    kind: note.kind,
    created: note.created,
    last_verified: note.last_verified,
  };
  if (note.verified_at_commit) front.verified_at_commit = note.verified_at_commit;
  front.anchors = note.anchors;
  if (note.triggers?.length) front.triggers = note.triggers;
  front.confidence = note.confidence;
  if (note.promoted_to) front.promoted_to = note.promoted_to;
  if (note.supersedes?.length) front.supersedes = note.supersedes;
  if (note.trashed_at) front.trashed_at = note.trashed_at;
  return `---\n${Bun.YAML.stringify(front, null, 2).trimEnd()}\n---\n${note.body.trim()}\n`;
}
