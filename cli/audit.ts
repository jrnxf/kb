// An audit: the changes /kb:audit proposes for the notes of one scope, and the picks the user makes
// in the page. A repo audit covers the repo's notes, and can move a rule into the repo's CLAUDE.md
// or AGENTS.md. A global audit, run outside any repo, covers the global notes, and can move a global
// rule into the global instructions file. The agent writes the proposal with `kb audit propose`. The page shows one card per
// note, and Apply makes every pick in one commit. A note the user sends back for a rewrite waits in
// the audit file for the agent's next run.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { budgetOf } from "./context.ts";
import { type InstructionsFile, checkWritable, fileName, instructionsFor, hasRule, insertRule, readInstructions, shortPath, writeInstructions } from "./instructions.ts";
import { KbError, type Note, validateNote } from "./note.ts";
import type { RepoInfo } from "./scope.ts";
import { rejectSecrets } from "./secrets.ts";
import { type Store, type StoredNote, writeAtomic } from "./store.ts";
import type { AuditAction, AuditCard, AuditData, AuditNote, AuditPick, AuditPromote, AuditResult } from "./wire.ts";
import { afterWrite, logWrites, nowIso } from "./write.ts";

/** The card shows `why` as one short line, so it stays brief. */
export const WHY_MAX = 140;

export const ACTIONS = ["rewrite", "trash", "merge", "keep", "promote"] as const;

/** One proposal, as the agent writes it. */
export interface AuditItem {
  id: string;
  action: AuditAction;
  /** One line: why this action. */
  why: string;
  /** For a keep: the agent checked the note against the code or a source, so a keep records the check. */
  checked?: boolean;
  /** What `kb stale` or `kb budget` said about the note. */
  reason?: string;
  /** Cards with the same group sit together, after a divider with this name. */
  group?: string;
  /** For a rewrite or a merge: the new text. A field left out keeps the note's own. */
  title?: string;
  body?: string;
  /** For a merge: the notes that go to the trash. The note `id` keeps every fact. For a promote: the notes whose rule the text holds too, so they move with it. */
  merge?: string[];
  /** For a promote: the text to add to the instruction file of the audit's scope. */
  rule?: string;
  /** For a promote: the heading to add it under. */
  section?: string;
  /** Each note on the card (the note and its merge partners) as it was at the proposal: a hash of its file. */
  revs?: Record<string, string>;
}

export interface Audit {
  scope: string;
  /** The repo the agent ran in, and its HEAD then. A keep or a rewrite in the page records that commit. */
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
    // Each audit covers one scope: a repo audit has no global note, and the global audit has no repo note.
    const where = (n: StoredNote) => (n.scope === "global" ? "Run the global audit outside any repo." : "Run the audit inside that repo.");
    const check = (n: StoredNote, field: string) => {
      if (n.scope !== scope) throw new KbError(`items[${i}]${field}: ${n.id} belongs to ${n.scope}. ${where(n)}`);
      if (n.promoted_to) throw new KbError(`items[${i}]${field}: ${n.id} is in ${n.promoted_to} already`);
    };
    check(note, "");
    const action = item.action as AuditAction;
    if (!ACTIONS.includes(action)) throw new KbError(`items[${i}].action: must be one of ${ACTIONS.join(", ")}`);
    const why = text(item.why, "why", i);
    if (!why) throw new KbError(`items[${i}].why: required`);
    if (why.length > WHY_MAX) throw new KbError(`items[${i}].why: ${why.length} characters, at most ${WHY_MAX}. Say only the evidence for the pick.`);
    if (item.checked !== undefined && typeof item.checked !== "boolean") throw new KbError(`items[${i}].checked: must be true or false`);
    if (item.checked === true && action !== "keep") throw new KbError(`items[${i}].checked: only a keep has it`);
    const merge = item.merge;
    if (action === "merge" && (!Array.isArray(merge) || merge.length === 0)) throw new KbError(`items[${i}].merge: a merge names the notes that go to the trash`);
    if (merge !== undefined && action !== "merge" && action !== "promote") throw new KbError(`items[${i}].merge: only a merge or a promote has it`);
    if (merge !== undefined && !Array.isArray(merge)) throw new KbError(`items[${i}].merge: must be a list of ids`);
    const others = (merge ?? []) as unknown[];
    for (const other of others) {
      if (typeof other !== "string" || !active.has(other) || other === id) throw new KbError(`items[${i}].merge: no other active note "${String(other)}"`);
      check(active.get(other)!, ".merge");
    }
    const title = text(item.title, "title", i), body = text(item.body, "body", i);
    if (action === "rewrite" && title === undefined && body === undefined) throw new KbError(`items[${i}]: a rewrite needs the new title or body`);
    if ((title !== undefined || body !== undefined) && action !== "rewrite" && action !== "merge") throw new KbError(`items[${i}]: only a rewrite or a merge has new text`);
    const rule = text(item.rule, "rule", i), section = text(item.section, "section", i);
    if (action === "promote" && rule === undefined) throw new KbError(`items[${i}].rule: a promote needs the text to add to the instructions file`);
    if ((rule !== undefined || section !== undefined) && action !== "promote") throw new KbError(`items[${i}]: only a promote has a rule or a section`);
    for (const each of [id, ...(others as string[])]) {
      if (seen.has(each)) throw new KbError(`items[${i}]: ${each} is in the audit twice`);
      seen.add(each);
    }
    return {
      id,
      action,
      why,
      ...(item.checked === true ? { checked: true } : {}),
      ...(text(item.reason, "reason", i) ? { reason: item.reason as string } : {}),
      ...(text(item.group, "group", i) ? { group: item.group as string } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(others.length > 0 ? { merge: others as string[] } : {}),
      ...(rule !== undefined ? { rule: rule.trim() } : {}),
      ...(section !== undefined ? { section: section.trim() } : {}),
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
  if (!audit) throw new KbError(`no audit for ${scope}. Run /kb:audit ${scope === "global" ? "outside any repo" : "in that repo"}.`);
  const active = activeNotes(store);
  const budget = budgetOf(store, audit.scope === "global" ? null : audit.scope);
  const places = new Map(budget.notes.map((n) => [n.id, n.shown]));
  const shown = (n: StoredNote): AuditNote => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    scope: n.scope,
    body: n.body,
    place: places.get(n.id) ?? "hidden",
  });
  // A note that changed or left since the proposal is not on a card: the proposal no longer fits it.
  // So is a card whose action this kb does not know: an older kb wrote it, and Apply would refuse it.
  const items = audit.items.filter((item) => ACTIONS.includes(item.action) && live(item, active));
  // A promote card shows the file as it will be when every card before it is accepted, as Apply
  // adds the rules in this order. So two rules in one new section add its heading once. The file is
  // read once, and only when a card needs it.
  const previews = new Map<string, { above: string[]; added: string[]; present?: true }>();
  let file: InstructionsFile | undefined;
  const promoting = items.filter((item) => item.action === "promote");
  if (promoting.length > 0) {
    file = instructionsFor(store, audit.scope, audit.root);
    let content = readInstructions(file);
    for (const item of promoting) {
      const { content: after, above, added } = insertRule(content, item.rule!, item.section);
      const present = hasRule(content, item.rule!);
      previews.set(item.id, { above, added, ...(present ? { present: true as const } : {}) });
      if (!present) content = after;
    }
  }
  const promote = (item: AuditItem): AuditPromote => ({
    file: file!.name,
    path: shortPath(file!.path),
    link: file!.link,
    ...(file!.create ? { create: true } : {}),
    ...(item.section ? { section: item.section } : {}),
    ...previews.get(item.id)!,
    rule: item.rule!,
  });
  const cards: AuditCard[] = items
    .map((item) => ({
      id: item.id,
      action: item.action,
      why: item.why,
      ...(item.checked ? { checked: true } : {}),
      reason: item.reason,
      group: item.group,
      note: shown(active.get(item.id)!),
      proposed: item.title !== undefined || item.body !== undefined ? { title: item.title ?? active.get(item.id)!.title, body: item.body ?? active.get(item.id)!.body } : undefined,
      merge: item.merge?.map((id) => shown(active.get(id)!)),
      ...(item.action === "promote" ? { promote: promote(item) } : {}),
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
  const result: AuditResult = { at: nowIso(), rewritten: [], merged: [], trashed: [], kept: [], checked: [], requests: [], promoted: [] };
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

  // The instruction file of the scope, resolved when the first promote pick needs it.
  let target: InstructionsFile | undefined;
  const promotedTo = () => fileName((target ??= instructionsFor(store, audit.scope, audit.root)));

  const plan = (picks as AuditPick[]).map((pick, i) => {
    if (pick === null || typeof pick !== "object" || typeof pick.id !== "string") throw new KbError(`picks[${i}]: needs an id`);
    const item = items.get(pick.id);
    if (!item) throw new KbError(`picks[${i}]: ${pick.id} is not in this audit`);
    if (done.has(pick.id)) throw new KbError(`picks[${i}]: ${pick.id} is picked twice`);
    done.add(pick.id);
    const changed = drift(item, active);
    if (changed) throw new KbError(`${changed}. Reload the page, or run /kb:audit again.`);
    const note = active.get(pick.id)!;
    // A promote card offers no rewrite: its text is the rule.
    const allowed = item.action === "promote" ? ["promote", "keep", "ask", "trash"] : ["rewrite", "trash", "keep", "ask", ...(item.merge ? ["merge"] : [])];
    if (!allowed.includes(pick.action)) throw new KbError(`picks[${i}].action: ${pick.action} is not an action for ${pick.id}`);
    if (pick.action === "ask" && (typeof pick.request !== "string" || !pick.request.trim())) throw new KbError(`picks[${i}]: say what is wrong with ${pick.id}`);
    // A trash takes every note on the card: on a card with several notes, the user trashes them all.
    const partners = (item.merge ?? []).map((id) => active.get(id)!);
    const leaving = pick.action === "trash" ? [note, ...partners] : pick.action === "merge" ? partners : [];
    for (const each of leaving) if (existsSync(store.notePath(each, true))) throw new KbError(`cannot trash ${each.id}: the trash has a note with that id`);
    // A rewrite takes the user's text, or else the agent's. Without either there is nothing to write.
    const title = pick.title ?? item.title, body = pick.body ?? item.body;
    if (pick.action === "rewrite" && title === undefined && body === undefined) throw new KbError(`picks[${i}]: ${pick.id} has no new text. Edit it, or ask the agent for a rewrite.`);
    const text = { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
    if (pick.rule !== undefined && (pick.action !== "promote" || typeof pick.rule !== "string" || !pick.rule.trim())) throw new KbError(`picks[${i}].rule: only a promote has it, and it must be text`);
    const rule = pick.action === "promote" ? (pick.rule ?? item.rule)!.trim() : undefined;
    // New text reaches the synced store or the instructions file only without a secret in it.
    if (pick.action === "rewrite" || pick.action === "merge") rejectSecrets(text, `the new text of ${note.id}`);
    if (rule !== undefined) rejectSecrets({ rule }, `the rule of ${note.id}`);
    // A keep records the check only when someone looked: the user picked it on the card, or the agent
    // checked the note. A group kept in one key, or a card the user never opened, records nothing.
    // Keep both on a merge card only says the notes differ.
    const checked = pick.action === "keep" && !item.merge && (pick.checked === true || item.checked === true);
    const fields: Partial<Note> | null =
      pick.action === "keep" ? (checked ? { last_verified: now, ...verifiedAt(note) } : null)
      : pick.action === "rewrite" ? { ...text, last_verified: now, ...verifiedAt(note) }
      : pick.action === "merge" ? { ...text, last_verified: now, ...verifiedAt(note), supersedes: [...new Set([...(note.supersedes ?? []), ...item.merge!])] }
      : null;
    const moving = pick.action === "promote" ? [note, ...partners] : [];
    const written = fields ? [next(note, fields, i)] : moving.map((each) => next(each, { promoted_to: promotedTo() }, i));
    return { pick, item, note, checked, written, rule, leaving };
  });

  // Every rule goes into the instructions file before the first note changes. A note marked as moved
  // whose rule is not in the file would reach no session at all.
  const promotes = plan.filter((p) => p.pick.action === "promote");
  if (promotes.length > 0) {
    const file = target!;
    checkWritable(file);
    let content = readInstructions(file);
    // A rule the file holds already is not added again: an Apply that failed after this write and
    // runs again must not add the same lines twice.
    for (const { rule, item } of promotes) if (!hasRule(content, rule!)) content = insertRule(content, rule!, item.section).content;
    writeInstructions(file, content);
  }

  const trash = (note: StoredNote) => store.move(note, true, now);
  for (const { pick, item, note, checked, written, leaving } of plan) {
    for (const each of written) store.writeNote(each);
    switch (pick.action) {
      case "rewrite":
        result.rewritten.push(note.id);
        break;
      case "merge":
        for (const other of leaving) trash(other);
        result.merged.push({ kept: note.id, trashed: item.merge! });
        break;
      case "trash":
        for (const each of leaving) trash(each);
        result.trashed.push(...leaving.map((each) => each.id));
        break;
      case "ask":
        result.requests.push({ id: note.id, request: pick.request!.trim() });
        break;
      case "promote":
        result.promoted!.push(...written.map((each) => each.id));
        break;
      default:
        (checked ? result.checked : result.kept).push(note.id);
    }
  }
  audit.result = result;
  writeAll(store, all);
  if (plan.some(({ pick, written }) => written.length > 0 || pick.action === "trash")) afterWrite(store, `kb: apply the audit of ${scope}`);
  logWrites(store, "update", [...result.rewritten, ...result.merged.map((m) => m.kept), ...result.promoted!]);
  logWrites(store, "trash", [...result.merged.flatMap((m) => m.trashed), ...result.trashed]);
  logWrites(store, "verify", result.checked);
  return result;
}
