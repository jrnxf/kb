// What `kb serve` sends to the page. The page imports these types and one pure helper, so this file imports nothing.

export interface PageNote {
  id: string;
  title: string;
  scope: string;
  kind: string;
  confidence: string;
  trashed: boolean;
  indexed: boolean;
  last_verified: string;
  /** When the note went to the trash. */
  trashed_at?: string;
  /** When the trash deletes the note for good. */
  clears_at?: string;
  verified_at_commit?: string;
  promoted_to?: string;
  anchors: string[];
  /** The markdown, for the edit form. */
  body: string;
  /** The body as HTML. Raw HTML in the markdown is escaped, so the page can insert it as is. */
  html: string;
  uses: number;
  last_used?: string;
}

export interface PageData {
  /** Changes whenever a note, the trash or a usage counter changes. */
  version: string;
  /** Every request that changes the store must carry this. */
  token: string;
  kinds: string[];
  /** A note in the trash for longer than this is deleted for good. */
  trashDays: number;
  /** Live notes scope by scope (global first) in rank order, then the trash, most recently trashed first. */
  notes: PageNote[];
  /** The scopes with an audit that waits for the user's picks. */
  audits: string[];
}

export interface NoteEdit {
  title: string;
  kind: string;
  confidence: string;
  body: string;
}

// ---- the audit page ----

export type AuditAction = "verify" | "rewrite" | "trash" | "merge" | "demote" | "keep";

export interface AuditNote {
  id: string;
  title: string;
  kind: string;
  scope: string;
  body: string;
  uses: number;
  /** False after a demote: no session lists the note. */
  indexed: boolean;
  /** What the note takes in a session now: its body, an index line, or nothing. */
  place: "body" | "index" | "hidden";
}

export interface AuditCard {
  id: string;
  /** The agent's pick. */
  action: AuditAction;
  why: string;
  reason?: string;
  group?: string;
  note: AuditNote;
  /** The agent's new text, for a rewrite or a merge. */
  proposed?: { title: string; body: string };
  /** For a merge: the notes that go to the trash. */
  merge?: AuditNote[];
}

export interface AuditResult {
  at: string;
  verified: string[];
  rewritten: string[];
  merged: { kept: string; trashed: string[] }[];
  trashed: string[];
  demoted: string[];
  /** Demoted notes the user put back in the index. */
  indexed: string[];
  kept: string[];
  /** Notes the user sent back to the agent, with what is wrong. */
  requests: { id: string; request: string }[];
}

export interface AuditData {
  token: string;
  scope: string;
  created: string;
  cards: AuditCard[];
  /** The session index as it is now. hidden counts the notes that reach no session. */
  index: { lines: number; budget: number; hidden: number };
  /** The ids of the notes that reach no session. */
  hidden: string[];
  result?: AuditResult;
}

/** "ask" sends the note back to the agent with a request. A rewrite may carry the user's text. */
export interface AuditPick {
  id: string;
  action: AuditAction | "ask" | "index";
  title?: string;
  body?: string;
  request?: string;
}

/** The result as named groups of note ids, in a fixed order. The CLI and the page both print it this way. */
export function resultGroups(r: AuditResult, arrow = "<-"): [string, string[]][] {
  return [
    ["verified", r.verified],
    ["rewritten", r.rewritten],
    ["merged", r.merged.map((m) => `${m.kept} ${arrow} ${m.trashed.join(", ")}`)],
    ["trashed", r.trashed],
    ["demoted", r.demoted],
    ["put back in the index", r.indexed ?? []],
    ["kept", r.kept],
  ];
}
