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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n" };

/** Text with its HTML entities decoded, as the browser reads an attribute. */
function decode(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (whole, hex: string, dec: string, name: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** True when the part of a URL before its first /, ? or # holds no scheme. The URL is already decoded, so a & there is only a character. */
const relative = (url: string) => !url.split(/[/?#]/, 1)[0]!.includes(":");

/** A URL as the browser reads it: entities decoded, and no space or control character to hide a scheme. */
const bare = (value: string) => decode(value).replace(/[\u0000-\u0020\u007f-\u009f]/g, "");

/**
 * True when a link in a note is safe to follow: http, https and mailto, or a link on this page
 * (a path, a query or a fragment). Every other scheme, such as javascript: or data:, could run
 * script in the page, and the page can change every note.
 */
export function safeHref(value: string): boolean {
  const url = bare(value);
  return /^(?:https?|mailto):/i.test(url) || relative(url);
}

/**
 * True when an image in a note may load: one from this server, or a picture held in the note itself.
 * A remote image would tell its server when a note is read, and from where.
 */
export function safeSrc(value: string): boolean {
  const url = bare(value);
  return /^data:image\/(?:png|gif|jpeg|webp)[;,]/i.test(url) || (!url.startsWith("//") && relative(url));
}

/** The host an image would have loaded from, or a plain word when the address has none. */
function imageHost(src: string): string {
  try {
    return new URL(bare(src), "http://localhost").host || "blocked";
  } catch {
    return "blocked";
  }
}

/**
 * The body as HTML. Raw HTML in a note is shown as text, never run. A link that could run script
 * shows as its text, and an image that could call out shows as its alt text, or as the name of its host when it has none.
 */
export function renderBody(markdown: string): string {
  let html: string;
  try {
    html = Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true });
  } catch {
    return `<pre>${esc(markdown)}</pre>`;
  }
  return new HTMLRewriter()
    .on("a", {
      element(link) {
        if (safeHref(link.getAttribute("href") ?? "")) return;
        link.tagName = "span";
        link.removeAttribute("href");
      },
    })
    .on("img", {
      element(image) {
        const src = image.getAttribute("src") ?? "";
        // replace() escapes the text it is given.
        if (safeSrc(src)) return;
        const alt = decode(image.getAttribute("alt") ?? "");
        // An alt of only spaces, control characters or U+FFFD says nothing, so the marker shows.
        image.replace(/[^\s\p{C}\ufffd]/u.test(alt) ? alt : `[image: ${imageHost(src)}]`);
      },
    })
    .transform(html);
}

/** The live notes as the page lists them: scope by scope, each scope in rank order. */
function ranked(store: Store, active: StoredNote[]): StoredNote[] {
  const lastActive = lastActivity(store);
  const scopes = [...new Set(active.map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
  return scopes.flatMap((scope) => rank(active.filter((n) => n.scope === scope), lastActive));
}

/**
 * Changes whenever a note, the trash or the order of the notes changes. The page refreshes when it
 * differs. `active` is the live notes in the order of the page: a caller that has them passes them,
 * so one request ranks the notes once.
 */
export function storeVersion(store: Store, active: StoredNote[] = ranked(store, store.notes())): string {
  const strip = ({ path: _path, ...note }: StoredNote) => note;
  // An audit agent that ends changes the page too: its repo gets an audit to open.
  const audits = auditableScopes(store).map((scope) => runState(store, scope)?.status);
  // The order depends on the last activity, which is not in a note: a read changes the order and no note.
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
  const active = ranked(store, store.notes());
  const trashed = store.notes({ trashed: true });
  const days = store.config().trashDays;
  // Live notes scope by scope in rank order, then the trash, most recently trashed first.
  const ordered = [...active, ...trashed.sort(byTrashedAt)];
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
    triggers: note.triggers ?? [],
    body: note.body,
    html: renderBody(note.body),
  }));
  return { version: storeVersion(store, active), token, kinds: [...KINDS], trashDays: days, notes, audits: openAudits(store), auditable: auditableScopes(store), runs: runs(store) };
}
