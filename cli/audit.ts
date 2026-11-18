// An audit: the changes /kb:audit proposes for the notes of one repo, and the picks the user makes
// in the page. The agent writes the proposal with `kb audit propose`. The page shows one card per
// note, and Apply makes every pick in one commit. A note the user sends back for a rewrite waits in
// the audit file for the agent's next run.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildBudget } from "./context.ts";
import { KbError, type Note, validateNote } from "./note.ts";
import type { RepoInfo } from "./scope.ts";
import { type Store, type StoredNote, writeAtomic } from "./store.ts";
import type { AuditAction, AuditCard, AuditData, AuditNote, AuditPick, AuditResult } from "./wire.ts";
import { afterWrite, nowIso } from "./write.ts";

export const ACTIONS = ["verify", "rewrite", "trash", "merge", "demote", "keep"] as const;

/** One proposal, as the agent writes it. */
export interface AuditItem {
  id: string;
  action: AuditAction;
  /** One line: why this action. */
  why: string;
  /** What `kb stale` or `kb budget` said about the note. */
  reason?: string;
  /** Cards with the same group sit together, after a divider with this name. */
  group?: string;
  /** For a rewrite or a merge: the new text. A field left out keeps the note's own. */
  title?: string;
  body?: string;
  /** For a merge: the notes that go to the trash. The note `id` keeps every fact. */
  merge?: string[];
  /** Each note on the card (the note and its merge partners) as it was at the proposal: a hash of its file. */
  revs?: Record<string, string>;
}

export interface Audit {
  scope: string;
  /** The repo the agent ran in, and its HEAD then. A verify in the page records that commit. */
  root: string | null;
  head: string | null;
  created: string;
  items: AuditItem[];
  /** Set by Apply. The page then shows the result, and the agent reads the requests. */
  result?: AuditResult;
}

const FILE = "audits.json";

function readAll(store: Store): Record<string, Audit> {
  try {
    return JSON.parse(readFileSync(store.statePath(FILE), "utf8")) as Record<string, Audit>;
  } catch {
    return {};
  }
}

function writeAll(store: Store, audits: Record<string, Audit>): void {
  writeAtomic(store.statePath(FILE), `${JSON.stringify(audits, null, 2)}\n`);
}

export function readAudit(store: Store, scope: string): Audit | undefined {
  return readAll(store)[scope];
}

/** A hash of the note's file. Any edit since the proposal changes it, also one made outside kb. */
const rev = (note: StoredNote): string => createHash("sha256").update(readFileSync(note.path)).digest("hex").slice(0, 16);

/** The notes of the store that are active now, by id. */
const activeNotes = (store: Store) => new Map(store.notes().map((n) => [n.id, n]));

/**
 * A proposal fits only the notes it was written for. It is live while every note on its card is
 * still active and unchanged. Otherwise its text could overwrite a newer edit.
 */
function drift(item: AuditItem, active: Map<string, StoredNote>): string | undefined {
  for (const id of [item.id, ...(item.merge ?? [])]) {
    const note = active.get(id);
    if (!note) return `${id} is no longer an active note`;
    if (item.revs?.[id] !== undefined && item.revs[id] !== rev(note)) return `${id} changed after the agent proposed it`;
  }
  return undefined;
}
const live = (item: AuditItem, active: Map<string, StoredNote>) => drift(item, active) === undefined;

/** The scopes that have an audit with picks still to make: not applied, and with at least one card left. */
export function openAudits(store: Store): string[] {
  const active = activeNotes(store);
  return Object.values(readAll(store))
    .filter((a) => !a.result && a.items.some((item) => live(item, active)))
    .map((a) => a.scope)
    .sort();
}

const text = (value: unknown, field: string, i: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new KbError(`items[${i}].${field}: must be text`);
  return value;
};

/** Check the agent's proposal against the store, and save it. It replaces an earlier audit of the scope. */
export function proposeAudit(store: Store, input: unknown, repo: RepoInfo): Audit {
  const raw = input as { items?: unknown } | null;
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.items)) throw new KbError('kb audit propose reads {"items": [...]} on stdin');
  const scope = repo.scope ?? "global";
  const active = activeNotes(store);
  const seen = new Set<string>();
  const items = raw.items.map((value, i): AuditItem => {
    const item = value as Record<string, unknown>;
    if (item === null || typeof item !== "object") throw new KbError(`items[${i}]: must be an object`);
    const id = item.id;
    if (typeof id !== "string" || !active.has(id)) throw new KbError(`items[${i}].id: no active note "${String(id)}"`);
    const note = active.get(id)!;
    const inScope = (n: StoredNote) => n.scope === scope || n.scope === "global";
    if (!inScope(note)) throw new KbError(`items[${i}]: ${id} belongs to ${note.scope}. Run the audit inside that repo.`);
    const action = item.action as AuditAction;
    if (!ACTIONS.includes(action)) throw new KbError(`items[${i}].action: must be one of ${ACTIONS.join(", ")}`);
    const why = text(item.why, "why", i);
    if (!why) throw new KbError(`items[${i}].why: required`);
    const merge = item.merge;
    if (action === "merge" && (!Array.isArray(merge) || merge.length === 0)) throw new KbError(`items[${i}].merge: a merge names the notes that go to the trash`);
    if (merge !== undefined && action !== "merge") throw new KbError(`items[${i}].merge: only a merge has it`);
    const others = (merge ?? []) as unknown[];
    for (const other of others) {
      if (typeof other !== "string" || !active.has(other) || other === id) throw new KbError(`items[${i}].merge: no other active note "${String(other)}"`);
      const partner = active.get(other)!;
      if (!inScope(partner)) throw new KbError(`items[${i}].merge: ${other} belongs to ${partner.scope}. Run the audit inside that repo.`);
    }
    const title = text(item.title, "title", i), body = text(item.body, "body", i);
    if (action === "rewrite" && title === undefined && body === undefined) throw new KbError(`items[${i}]: a rewrite needs the new title or body`);
    if ((title !== undefined || body !== undefined) && action !== "rewrite" && action !== "merge") throw new KbError(`items[${i}]: only a rewrite or a merge has new text`);
    for (const each of [id, ...(others as string[])]) {
      if (seen.has(each)) throw new KbError(`items[${i}]: ${each} is in the audit twice`);
      seen.add(each);
    }
    return {
      id,
      action,
      why,
      ...(text(item.reason, "reason", i) ? { reason: item.reason as string } : {}),
      ...(text(item.group, "group", i) ? { group: item.group as string } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(action === "merge" ? { merge: others as string[] } : {}),
      revs: Object.fromEntries([id, ...(others as string[])].map((each) => [each, rev(active.get(each)!)])),
    };
  });
  if (items.length === 0) throw new KbError("the audit has no items. Say there is nothing to change instead.");
  const audit: Audit = { scope, root: repo.root, head: repo.head, created: nowIso(), items };
  const all = readAll(store);
  all[scope] = audit;
  writeAll(store, all);
  return audit;
}

/** What the page shows: each card with its note as it is now, and the index as it is now. */
export function auditData(store: Store, scope: string, token: string): AuditData {
  const audit = readAudit(store, scope);
  if (!audit) throw new KbError(`no audit for ${scope}. Run /kb:audit in that repo.`);
  const usage = store.usage();
  const active = activeNotes(store);
  const budget = buildBudget(store, audit.root && existsSync(audit.root) ? audit.root : store.home);
  const places = new Map(budget.notes.map((n) => [n.id, n.shown]));
  const shown = (n: StoredNote): AuditNote => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    scope: n.scope,
    body: n.body,
    uses: usage.get(n.id)?.uses ?? 0,
    indexed: n.indexed !== false,
    place: places.get(n.id) ?? "hidden",
  });
  // A note that changed or left since the proposal is not on a card: the proposal no longer fits it.
  const cards: AuditCard[] = audit.items
    .filter((item) => live(item, active))
    .map((item) => ({
      id: item.id,
      action: item.action,
      why: item.why,
      reason: item.reason,
      group: item.group,
      note: shown(active.get(item.id)!),
      proposed: item.title !== undefined || item.body !== undefined ? { title: item.title ?? active.get(item.id)!.title, body: item.body ?? active.get(item.id)!.body } : undefined,
      merge: item.merge?.map((id) => shown(active.get(id)!)),
    }));
  return {
    token,
    scope: audit.scope,
    created: audit.created,
    cards,
    index: { lines: budget.index.lines, budget: budget.index.budget, hidden: budget.index.hidden },
    hidden: budget.notes.filter((n) => n.shown === "hidden").map((n) => n.id),
    result: audit.result,
  };
}

/**
 * Make the user's picks, in one commit. Every pick is checked before the first note changes.
 * A pick may only make a change its card allows: the page cannot trash a note that is not on a card.
 */
export function applyAudit(store: Store, scope: string, input: unknown): AuditResult {
  const all = readAll(store);
  const audit = all[scope];
  if (!audit) throw new KbError(`no audit for ${scope}`);
  if (audit.result) throw new KbError("this audit is applied already. Run /kb:audit again for a new one.");
  const picks = (input as { picks?: unknown } | null)?.picks;
  if (!Array.isArray(picks)) throw new KbError('apply takes {"picks": [...]}');
  const items = new Map(audit.items.map((item) => [item.id, item]));
  const active = activeNotes(store);
  const result: AuditResult = { at: nowIso(), verified: [], rewritten: [], merged: [], trashed: [], demoted: [], indexed: [], kept: [], requests: [] };
  const done = new Set<string>();
  const now = nowIso();
  const verifiedAt = (note: StoredNote) => (note.scope !== "global" && note.scope === audit.scope && audit.head ? { verified_at_commit: audit.head } : {});
  /** The note as the pick leaves it, checked now, so a bad pick stops the apply before the first change. */
  const next = (note: StoredNote, fields: Partial<Note>, i: number): Note => {
    const { path: _path, trashed: _trashed, ...stored } = note;
    try {
      return validateNote({ ...stored, ...fields });
    } catch (error) {
      throw new KbError(`picks[${i}]: ${note.id}: ${(error as Error).message}`);
    }
  };

  const plan = (picks as AuditPick[]).map((pick, i) => {
    if (pick === null || typeof pick !== "object" || typeof pick.id !== "string") throw new KbError(`picks[${i}]: needs an id`);
    const item = items.get(pick.id);
    if (!item) throw new KbError(`picks[${i}]: ${pick.id} is not in this audit`);
    if (done.has(pick.id)) throw new KbError(`picks[${i}]: ${pick.id} is picked twice`);
    done.add(pick.id);
    const changed = drift(item, active);
    if (changed) throw new KbError(`${changed}. Reload the page, or run /kb:audit again.`);
    const note = active.get(pick.id)!;
    const allowed = ["verify", "rewrite", "trash", "demote", "keep", "ask", ...(item.merge ? ["merge"] : []), ...(note.indexed === false ? ["index"] : [])];
    if (!allowed.includes(pick.action)) throw new KbError(`picks[${i}].action: ${pick.action} is not an action for ${pick.id}`);
    if (pick.action === "ask" && (typeof pick.request !== "string" || !pick.request.trim())) throw new KbError(`picks[${i}]: say what is wrong with ${pick.id}`);
    const leaving = pick.action === "trash" ? [note] : pick.action === "merge" ? item.merge!.map((id) => active.get(id)!) : [];
    for (const each of leaving) if (existsSync(store.notePath(each, true))) throw new KbError(`cannot trash ${each.id}: the trash has a note with that id`);
    // A rewrite takes the user's text, or else the agent's. Without either there is nothing to write.
    const title = pick.title ?? item.title, body = pick.body ?? item.body;
    if (pick.action === "rewrite" && title === undefined && body === undefined) throw new KbError(`picks[${i}]: ${pick.id} has no new text. Edit it, or ask the agent for a rewrite.`);
    const text = { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
    const fields: Partial<Note> | null =
      pick.action === "verify" ? { last_verified: now, ...verifiedAt(note) }
      : pick.action === "rewrite" ? { ...text, last_verified: now, ...verifiedAt(note) }
      : pick.action === "merge" ? { ...text, last_verified: now, ...verifiedAt(note), supersedes: [...new Set([...(note.supersedes ?? []), ...item.merge!])] }
      : pick.action === "demote" ? { indexed: false }
      : pick.action === "index" ? { indexed: true }
      : null;
    return { pick, item, note, written: fields ? next(note, fields, i) : null };
  });

  const trash = (note: StoredNote) => store.move(note, true, now);
  for (const { pick, item, note, written } of plan) {
    if (written) store.writeNote(written);
    switch (pick.action) {
      case "verify":
        result.verified.push(note.id);
        break;
      case "rewrite":
        result.rewritten.push(note.id);
        break;
      case "merge":
        for (const other of item.merge!) trash(active.get(other)!);
        result.merged.push({ kept: note.id, trashed: item.merge! });
        break;
      case "trash":
        trash(note);
        result.trashed.push(note.id);
        break;
      case "demote":
        result.demoted.push(note.id);
        break;
      case "index":
        result.indexed.push(note.id);
        break;
      case "ask":
        result.requests.push({ id: note.id, request: pick.request!.trim() });
        break;
      default:
        result.kept.push(note.id);
    }
  }
  audit.result = result;
  writeAll(store, all);
  if (plan.some(({ pick }) => pick.action !== "keep" && pick.action !== "ask")) afterWrite(store, `kb: apply the audit of ${scope}`);
  return result;
}
