// What the page shows, worked out from the notes and the view. No React here, so tests can run it.

import type { PageNote } from "../../../cli/wire.ts";

export interface View {
  /** null is every scope. */
  scope: string | null;
  /** Kinds add up: none picked shows every kind, and each picked kind adds its notes. */
  kinds: string[];
  /** The list shows the trash. */
  trash: boolean;
  q: string;
  /** The open note. When it is not in the list, the first note of the list is open. */
  note: string | null;
  pane: "rail" | "list";
  /** On a phone: the note is open in its drawer. */
  read: boolean;
}

export const EMPTY_VIEW: View = { scope: null, kinds: [], trash: false, q: "", note: null, pane: "list", read: false };

export interface Shown {
  /** The notes in the list. */
  notes: PageNote[];
  current: PageNote | undefined;
  /** Notes per scope, with the search, the kinds and the trash applied. "*" is every scope. */
  byScope: Map<string, number>;
  /** Notes per kind, with the search, the scope and the trash applied. */
  byKind: Map<string, number>;
  trashCount: number;
  /** The list shows the trash. False once the trash is empty. */
  trash: boolean;
}

const haystacks = new WeakMap<PageNote, string>();
function haystack(note: PageNote): string {
  let text = haystacks.get(note);
  if (text === undefined) haystacks.set(note, (text = `${note.id} ${note.title} ${note.kind} ${note.scope} ${note.body}`.toLowerCase()));
  return text;
}

export function scopesOf(notes: PageNote[]): string[] {
  return [...new Set(notes.map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
}

export function show(notes: PageNote[], view: View): Shown {
  const trashCount = notes.filter((n) => n.trashed).length;
  // The trash view is gone once the trash is empty.
  const trash = view.trash && trashCount > 0;
  const words = view.q.toLowerCase().split(/\s+/).filter(Boolean);
  const byScope = new Map<string, number>(), byKind = new Map<string, number>();
  const shown: PageNote[] = [];
  let all = 0;
  for (const note of notes) {
    const base = note.trashed === trash && words.every((w) => haystack(note).includes(w));
    if (!base) continue;
    const inScope = !view.scope || note.scope === view.scope;
    const inKind = view.kinds.length === 0 || view.kinds.includes(note.kind);
    if (inKind) { all++; byScope.set(note.scope, (byScope.get(note.scope) ?? 0) + 1); }
    if (inScope) byKind.set(note.kind, (byKind.get(note.kind) ?? 0) + 1);
    if (inScope && inKind) shown.push(note);
  }
  byScope.set("*", all);
  const current = shown.find((n) => n.id === view.note) ?? shown[0];
  return { notes: shown, current, byScope, byKind, trashCount, trash };
}

/** The note to land on when `id` leaves the list: the next one, or the one before when it was the last. */
export function neighbour(list: PageNote[], id: string): string | null {
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) return null;
  return (list[i + 1] ?? list[i - 1])?.id ?? null;
}

/** The address keeps the view, so a reload comes back to the same place. */
export function toHash(view: View): string {
  const params = new URLSearchParams();
  if (view.scope) params.set("scope", view.scope);
  if (view.kinds.length) params.set("kind", view.kinds.join(","));
  if (view.trash) params.set("trash", "1");
  if (view.q) params.set("q", view.q);
  if (view.note) params.set("note", view.note);
  if (view.pane === "rail") params.set("pane", "rail");
  if (view.read) params.set("read", "1");
  return "#" + params;
}

export function fromHash(hash: string): View {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    scope: params.get("scope") || null,
    kinds: (params.get("kind") ?? "").split(",").filter(Boolean),
    trash: params.has("trash"),
    q: params.get("q") ?? "",
    note: params.get("note") || null,
    pane: params.get("pane") === "rail" ? "rail" : "list",
    read: params.has("read"),
  };
}

/** A repo scope is host/owner/name. Show owner/name for GitHub. */
export function scopeName(scope: string): string {
  return scope.startsWith("github.com/") ? scope.slice("github.com/".length) : scope;
}

/** The address of the repo when the scope is one. */
export function scopeHref(scope: string): string | undefined {
  const parts = scope.split("/");
  return parts.length >= 2 && parts[0]!.includes(".") ? `https://${scope}` : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_MS = 86_400_000;

/** How long until the trash deletes a note: "today", "in 1 day", "in 12 days". */
export function clearsIn(iso: string, now = new Date()): string {
  const days = Math.ceil((Date.parse(iso) - now.getTime()) / DAY_MS);
  return days <= 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`;
}

/** A short date in the zone of this machine: "16 Nov", with the year when it is not this year. Browsers spell some months differently, so the names are fixed here. */
export function day(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const text = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? text : `${text} ${date.getFullYear()}`;
}

/** The scope of the audit page in the address (#audit=<scope>), or null on the notes. */
export const auditScope = (hash = location.hash) => new URLSearchParams(hash.replace(/^#/, "")).get("audit");
