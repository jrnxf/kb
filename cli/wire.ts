// What `kb serve` sends to the page. The page imports these types and one pure helper, so this file imports nothing.

export interface PageNote {
  id: string;
  title: string;
  scope: string;
  kind: string;
  confidence: string;
  trashed: boolean;
  last_verified: string;
  /** When the note went to the trash. */
  trashed_at?: string;
  /** When the trash deletes the note for good. */
  clears_at?: string;
  verified_at_commit?: string;
  promoted_to?: string;
  anchors: string[];
  /** When the note loads outside the session start: `cmd: ...`, `stop: ...` and `err: ...`. */
  triggers: string[];
  /** The markdown, for the edit form. */
  body: string;
  /** The body as HTML. Raw HTML in the markdown is escaped, so the page can insert it as is. */
  html: string;
}

export interface PageData {
  /** Changes whenever a note or the trash changes. */
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
  /** The repos with a checkout on disk: the page can start an audit for each. */
  auditable: string[];
  /** The last audit agent of each repo that has one. */
  runs: Record<string, AuditRunState>;
}

/** Where an audit agent stands: running, done with cards, done with nothing to change, or failed. */
export interface AuditRunState {
  scope: string;
  started: string;
  log: string;
  status: "running" | "proposed" | "nothing" | "failed";
  cards?: number;
  /** The last lines the agent wrote, when it ended with no proposal. */
  said?: string;
  /** What starting an audit costs, for the user to read. Only the answer to a start has it. */
  notice?: string;
}

export interface NoteEdit {
  title: string;
  kind: string;
  confidence: string;
  body: string;
}

// ---- the audit page ----

/** promote moves a rule into the instruction file of the audit's scope: the global file, or the repo's own file. */
export type AuditAction = "rewrite" | "trash" | "merge" | "keep" | "promote";

export interface AuditNote {
  id: string;
  title: string;
  kind: string;
  scope: string;
  body: string;
  /**
   * What the note takes at a session start now: a brief of open work, an index line, or nothing.
   * `trigger`: a global note that takes no line on purpose, because it loads at its trigger.
   * `hidden`: its index line did not fit, so no session sees it.
   */
  place: "brief" | "index" | "trigger" | "hidden";
  /**
   * The characters of its brief or of its index line, with the newline: what the note takes at a
   * session start now, or for a hidden note, what its line needs. 0 for a note that loads at its trigger.
   */
  chars: number;
}

export interface AuditCard {
  id: string;
  /** The agent's pick. */
  action: AuditAction;
  why: string;
  /** True when the agent checked the note against the code or a source. A keep then records the check. */
  checked?: boolean;
  reason?: string;
  group?: string;
  note: AuditNote;
  /** The agent's new text, for a rewrite or a merge. */
  proposed?: { title: string; body: string };
  /** The other notes on the card. A merge trashes them, a promote moves them, and a trash takes them with the note. */
  merge?: AuditNote[];
  /** For a promote: where the rule goes, and the lines above it in the file now. */
  promote?: AuditPromote;
}

export interface AuditPromote {
  /** The file as the config names it, such as ~/.claude/CLAUDE.md. */
  file: string;
  /** The file kb writes, with every link resolved. */
  path: string;
  /** True when the file the config names is a link to path. */
  link: boolean;
  /** True when the repo has no instruction file yet, so Apply creates it. */
  create?: boolean;
  /** The heading the rule goes under. A heading the file does not have yet is added. */
  section?: string;
  /** The lines of the file right above the new lines. */
  above: string[];
  /** The lines Apply adds: the agent's text, with a new heading when the section is new. */
  added: string[];
  /** The file holds the agent's text already, so Apply adds nothing and only marks the notes moved. */
  present?: boolean;
  /** The agent's text alone, for the edit box. */
  rule: string;
}

export interface AuditResult {
  at: string;
  rewritten: string[];
  merged: { kept: string; trashed: string[] }[];
  trashed: string[];
  /** Kept as is, with nobody's check recorded. */
  kept: string[];
  /** Kept as is after the user or the agent looked, so each records the check. */
  checked: string[];
  /** Notes the user sent back to the agent, with what is wrong. */
  requests: { id: string; request: string }[];
  /** Notes whose rule moved to an instruction file. An audit applied by an older kb has no list. */
  promoted?: string[];
}

export interface AuditData {
  token: string;
  scope: string;
  created: string;
  cards: AuditCard[];
  /**
   * The session index as it is now. hidden counts the notes that reach no session and that this
   * audit can give a line: their lines are over the character budget. room is the characters that
   * a session start has left. others counts the hidden notes of another scope: the global notes
   * behind the hidden notes of a repo, which wait for the repo's notes to fit.
   */
  index: { lines: number; hidden: number; room: number; others: number };
  /** Those notes in rank order, each with the characters its index line needs. */
  hidden: { id: string; chars: number }[];
  result?: AuditResult;
}

/** "ask" sends the note back to the agent with a request. A rewrite may carry the user's text. */
export interface AuditPick {
  id: string;
  action: AuditAction | "ask";
  /** For keep: the user picked it on the card, so the note records the check. */
  checked?: boolean;
  title?: string;
  body?: string;
  request?: string;
  /** For promote: the user's own text for the rule. */
  rule?: string;
}

/** The result as named groups of note ids, in a fixed order. The CLI and the page both print it this way. */
export function resultGroups(r: AuditResult, arrow = "<-"): [string, string[]][] {
  return [
    ["rewritten", r.rewritten],
    ["merged", r.merged.map((m) => `${m.kept} ${arrow} ${m.trashed.join(", ")}`)],
    ["moved to an instruction file", r.promoted ?? []],
    ["trashed", r.trashed],
    ["checked and kept", r.checked],
    ["kept, not checked", r.kept],
  ];
}
