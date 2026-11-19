// The data behind the page that `kb serve` shows. The page itself is a React app in web/.

import { openAudits } from "./audit.ts";
import { runState } from "./audit-run.ts";
import { auditableScopes } from "./repos.ts";
import { rank } from "./context.ts";
import { lastActivity } from "./log.ts";
import { KINDS, byTrashedAt } from "./note.ts";
import type { Store, StoredNote } from "./store.ts";
import type { PageData, PageNote } from "./wire.ts";
import { clearsAt } from "./write.ts";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The body as HTML. Raw HTML in a note is shown as text, never run. */
export function renderBody(markdown: string): string {
  try {
    return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true });
  } catch {
    return `<pre>${esc(markdown)}</pre>`;
  }
}

/** The live notes as the page lists them: scope by scope, each scope in rank order. */
function ranked(store: Store, active: StoredNote[]): StoredNote[] {
  const lastActive = lastActivity(store);
  const scopes = [...new Set(active.map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
  return scopes.flatMap((scope) => rank(active.filter((n) => n.scope === scope), lastActive));
}

/** Changes whenever a note, the trash or the order of the notes changes. The page refreshes when it differs. */
export function storeVersion(store: Store): string {
  const strip = ({ path: _path, ...note }: StoredNote) => note;
  // An audit agent that ends changes the page too: its repo gets an audit to open.
  const audits = auditableScopes(store).map((scope) => runState(store, scope)?.status);
  // The order depends on the last activity, which is not in a note: a read changes the order and no note.
  const active = ranked(store, store.notes());
  return Bun.hash(JSON.stringify([active.map(strip), store.notes({ trashed: true }).map(strip), openAudits(store), audits])).toString(36);
}

/** The last audit agent of each repo the page can audit. */
function runs(store: Store) {
  return Object.fromEntries(auditableScopes(store).flatMap((scope) => {
    const state = runState(store, scope);
    return state ? [[scope, state]] : [];
  }));
}

export function pageData(store: Store, token: string): PageData {
  const active = store.notes();
  const trashed = store.notes({ trashed: true });
  const days = store.config().trashDays;
  // Live notes scope by scope in rank order, then the trash, most recently trashed first.
  const ordered = [...ranked(store, active), ...trashed.sort(byTrashedAt)];
  const notes = ordered.map((note): PageNote => ({
    id: note.id,
    title: note.title,
    scope: note.scope,
    kind: note.kind,
    confidence: note.confidence,
    trashed: note.trashed,
    last_verified: note.last_verified,
    trashed_at: note.trashed_at,
    clears_at: note.trashed_at ? clearsAt(note.trashed_at, days) : undefined,
    verified_at_commit: note.verified_at_commit,
    promoted_to: note.promoted_to,
    anchors: note.anchors,
    body: note.body,
    html: renderBody(note.body),
  }));
  return { version: storeVersion(store), token, kinds: [...KINDS], trashDays: days, notes, audits: openAudits(store), auditable: auditableScopes(store), runs: runs(store) };
}
