// The data behind the page that `kb serve` shows. The page itself is a React app in web/.

import { rank } from "./context.ts";
import { KINDS } from "./note.ts";
import type { Store, StoredNote } from "./store.ts";
import type { PageData, PageNote } from "./wire.ts";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The body as HTML. Raw HTML in a note is shown as text, never run. */
export function renderBody(markdown: string): string {
  try {
    return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true });
  } catch {
    return `<pre>${esc(markdown)}</pre>`;
  }
}

/** Changes whenever a note, the archive or a usage counter changes. The page refreshes when it differs. */
export function storeVersion(store: Store): string {
  const strip = ({ path: _path, ...note }: StoredNote) => note;
  return Bun.hash(JSON.stringify([store.notes().map(strip), store.notes({ archived: true }).map(strip), [...store.usage()]])).toString(36);
}

export function pageData(store: Store, token: string): PageData {
  const usage = store.usage();
  const active = store.notes();
  const archived = store.notes({ archived: true });
  const scopes = [...new Set([...active, ...archived].map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
  const ordered = scopes.flatMap((scope) => [...rank(active.filter((n) => n.scope === scope), usage), ...rank(archived.filter((n) => n.scope === scope), usage)]);
  const notes = ordered.map((note): PageNote => {
    const used = usage.get(note.id);
    return {
      id: note.id,
      title: note.title,
      scope: note.scope,
      kind: note.kind,
      confidence: note.confidence,
      archived: note.archived,
      indexed: note.indexed,
      last_verified: note.last_verified,
      verified_at_commit: note.verified_at_commit,
      promoted_to: note.promoted_to,
      anchors: note.anchors,
      body: note.body,
      html: renderBody(note.body),
      uses: used?.uses ?? 0,
      last_used: used?.last_used,
    };
  });
  return { version: storeVersion(store), token, kinds: [...KINDS], notes };
}
