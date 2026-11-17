// What `kb serve` sends to the page. The page imports these types, so this file imports nothing.

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
}

export interface NoteEdit {
  title: string;
  kind: string;
  confidence: string;
  body: string;
}
