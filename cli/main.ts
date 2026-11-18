#!/usr/bin/env bun
// kb: a personal knowledge store for coding agents. Harness-agnostic: flags and stdin only.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { openAudits, proposeAudit, readAudit } from "./audit.ts";
import { RUN_ENV, startRun, waitRun } from "./audit-run.ts";
import { rememberRepo } from "./repos.ts";
import { buildBudget, buildContext, rank } from "./context.ts";
import { REPO_FILES, globalInstructions } from "./instructions.ts";
import { CONFIDENCES, KINDS, KbError, byTrashedAt, type Note, isValidScope, normalizeTitle, slugify, validateNote } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import { rejectSecrets } from "./secrets.ts";
import { searchNotes } from "./search.ts";
import { DEFAULT_PORT, isKbServer, runningPort, serve } from "./serve.ts";
import { resultGroups } from "./wire.ts";
import { markSaved } from "./session.ts";
import { clearStaleCache, findStale, saveStaleCount } from "./stale.ts";
import { Store } from "./store.ts";
import { syncNow } from "./sync.ts";
import { afterWrite, clearsAt, closeIds, deleteNotes, deleteProject, emptyTrash, moveNotes, nowIso, requireNote, restoreProject, tidyTrash, trashProject, updateNote } from "./write.ts";

const USAGE = `kb - a personal knowledge store for coding agents

  kb context [--repo .]                  text for a session start: index, top notes, pointer
  kb add [--repo .]                      create or update a note from JSON on stdin
  kb show <id> [--no-use]                print one note, and count a use of it. A part of the id is
                                         enough when one note has it. --no-use for a check, not a use
  kb search <words> [--scope s] [--trash]
                                         notes that have every word, in any order, this repo first
  kb list [--scope s] [--trash]          every note with kind, uses and verified date
                                         --scope takes "repo", "global" or a repo id
  kb use <id>...                         record that these notes changed what you did, when you did not
                                         read them with kb show
  kb trash <id>... | kb restore <id>...  trash retires a note: restore brings it back. A note in the
                                         trash for more than trashDays (30) is deleted for good
  kb delete <id>...                      remove notes for good, active or in the trash. When the user
                                         wants a note gone now. In a git store, the history keeps the file
  kb empty-trash                         remove every note in the trash for good
  kb trash --scope <repo id>             move every note of a project to the trash. restore --scope
                                         brings that move back. delete --scope removes the project's
                                         notes for good, and empty-trash --scope only its trash. Each
                                         takes the exact repo id, never "global". Only when the user asks
  kb stale [--repo .]                    notes that may no longer be true, each with a reason
  kb verify <id>... [--repo .]           record that these notes are still true, at HEAD
  kb budget [--repo .]                   what a session loads, and what reaches no session
  kb audit [--repo .] [--no-wait]        start an agent that audits this repo's notes, and print the
                                         page link. Outside any repo, it audits the global notes
  kb audit propose [--repo .]            save /kb:audit's proposal from JSON on stdin, for the page
  kb audit status [--repo .]             where the audit of this scope stands, and the notes the user
                                         sent back for a rewrite
  kb instructions [--repo .]             the instruction files for a rule the user states: the global
                                         one, and the repo's CLAUDE.md and AGENTS.md
  kb checkpointed <session-id>           record that this session saved its knowledge
  kb scope [--repo .]                    print the scope id of a directory
  kb serve [--port n] [--no-open]        the store as a local page: read, edit and trash notes
                                         kb alone in a terminal does the same. Behind a proxy, name it in
                                         KB_SERVE_HOSTS: kb.example.com, or .example.com for every name under it
  kb sync                                commit, pull and push the store

Every command accepts --json. The store is ~/.kb, or KB_HOME.

kb add reads: {"title", "kind", "body", "scope"?, "id"?, "anchors"?, "confidence"?, "supersedes"?}
  scope: "repo" (the default inside a git repo), "global", or the id of a repo that has notes
  kind: ${KINDS.join(" | ")}
  confidence: ${CONFIDENCES.join(" | ")} (default medium)
  With "id", the note is updated. A new title, body or anchors also counts as a verification.
  Without "id", a note with the same title in the same scope
  is not overwritten: the result is {"status": "exists", "id"}.`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["repo", "scope", "to", "port"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new KbError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---- commands: each returns a JSON value and the human text ----

type Output = { json: unknown; text: string };

/** Body lines printed under one note in `kb search`. */
const MAX_HIT_LINES = 3;

function cmdContext(store: Store, args: Args): Output {
  const result = buildContext(store, String(args.flags.get("repo") ?? "."));
  return { json: result, text: result.text.trimEnd() };
}

function cmdScope(store: Store, args: Args): Output {
  const info = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  return { json: info, text: info.scope ?? "global" };
}

function cmdAdd(store: Store, args: Args, stdin: string): Output {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdin);
  } catch {
    throw new KbError("kb add reads one JSON object on stdin");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new KbError("kb add reads one JSON object on stdin");

  store.ensure();
  const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  const now = nowIso();
  const active = store.notes();
  const trashed = store.notes({ trashed: true });

  // Update: merge the given fields over the stored note.
  if (typeof input.id === "string") {
    const existing = active.find((n) => n.id === input.id);
    if (!existing) throw new KbError(`no active note with id "${input.id}"`);
    if (input.scope !== undefined && resolveScopeInput(input.scope, repo.scope) !== existing.scope) {
      throw new KbError("a note cannot change scope. Trash it and add a new one.");
    }
    const updated = updateNote(store, input as Record<string, unknown> & { id: string }, repo);
    return { json: { status: "updated", ...updated }, text: `updated ${updated.id}` };
  }

  const scope = resolveScopeInput(input.scope, repo.scope);
  // A scope that no repo resolves to never loads in a session. A typing error must not hide a note there.
  if (scope !== repo.scope && !knownScopes(store).includes(scope)) {
    throw new KbError(`${unknownScope(store, scope)} To start the notes of another repo, pass --repo <its directory>.`);
  }
  if (typeof input.title !== "string" || !input.title.trim()) throw new KbError("invalid note: title: required");
  rejectSecrets({ title: input.title, body: input.body, anchors: input.anchors }, "the note");
  const slug = slugify(input.title);
  if (!slug) throw new KbError("invalid note: title: needs letters or digits");

  // Same normalised title in the same scope: let the caller decide to update.
  const title = normalizeTitle(input.title);
  const twin = active.find((n) => n.scope === scope && (normalizeTitle(n.title) === title || n.id === title));
  if (twin) return { json: { status: "exists", id: twin.id, path: twin.path }, text: `exists ${twin.id}` };

  const raw: Record<string, unknown> = {
    confidence: "medium",
    anchors: [],
    ...input,
    // An id with counters on any machine belongs to a deleted note: a new note must not inherit its uses.
    id: uniqueId(slug, new Set([...active, ...trashed].map((n) => n.id).concat([...store.usage().keys()]))),
    scope,
    created: now,
    last_verified: now,
  };
  if (scope !== "global" && repo.scope === scope && repo.head) raw.verified_at_commit = repo.head;
  const note: Note = validateNote(raw);
  const path = store.writeNote(note);
  afterWrite(store, `kb: add ${note.id}`);
  return { json: { status: "created", id: note.id, path }, text: `created ${note.id}` };
}

function resolveScopeInput(value: unknown, repoScope: string | null): string {
  if (value === undefined || value === "repo") {
    if (repoScope) return repoScope;
    if (value === "repo") throw new KbError("scope \"repo\" needs a git repo. Pass --repo, or use \"global\".");
    return "global";
  }
  if (typeof value !== "string" || !isValidScope(value)) throw new KbError("invalid note: scope: must be \"global\", \"repo\" or a repo id");
  return value;
}

/** "global" and each scope that has a note, active or in the trash. */
function knownScopes(store: Store): string[] {
  const scopes = new Set([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.scope));
  scopes.delete("global");
  return ["global", ...[...scopes].sort()];
}

function unknownScope(store: Store, scope: string): string {
  return `no notes have the scope "${scope}". Scopes: ${knownScopes(store).join(", ")}.`;
}

/** The --scope filter of search and list. "repo" is the repo of the directory, as in `kb add`. */
function scopeFilter(store: Store, args: Args): string | undefined {
  const value = args.flags.get("scope");
  if (typeof value !== "string") return undefined;
  if (value === "repo") {
    const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
    if (!repo.scope) throw new KbError("scope \"repo\" needs a git repo. Pass --repo, or use \"global\".");
    return repo.scope;
  }
  // An answer of "no match" for a scope that does not exist reads as "no such note".
  if (!knownScopes(store).includes(value)) throw new KbError(unknownScope(store, value));
  return value;
}

function cmdShow(store: Store, args: Args): Output {
  const given = args.positional[0];
  if (!given) throw new KbError("usage: kb show <id> [--no-use]");
  // Ids are long. A part of one is enough to read a note, when only one note has it.
  const close = store.find(given) ? [] : closeIds(store, given);
  const note = requireNote(store, close.length === 1 ? close[0]! : given);
  const id = note.id;
  // An agent reads a note because it needs it now: that is a use. A check (an audit, a search
  // before a write) passes --no-use, so it does not count.
  if (!note.trashed && !args.flags.has("no-use")) {
    store.bumpUsage([id], nowIso());
    afterWrite(store, `kb: show ${id}`);
  }
  const usage = store.usage().get(id) ?? { uses: 0 };
  const header = `# ${relative(store.home, note.path)} | uses ${usage.uses}${usage.last_used ? `, last used ${usage.last_used}` : ""}`;
  return { json: { ...note, ...usage }, text: `${header}\n${readFileSync(note.path, "utf8").trimEnd()}` };
}

function cmdSearch(store: Store, args: Args): Output {
  const query = args.positional.join(" ");
  if (!query) throw new KbError("usage: kb search <words> [--scope s] [--trash]");
  const scope = scopeFilter(store, args);
  const first = resolveRepo(String(args.flags.get("repo") ?? "."), store).scope ?? undefined;
  const { hits, complete } = searchNotes(store, query, { scope, trash: inTrash(args), first });
  // One line per note. The body lines that matched follow it, because the title is already there.
  const rows: string[] = [];
  let last = "";
  let shown = 0;
  for (const h of hits) {
    const key = `${h.trashed} ${h.id}`;
    if (key !== last) {
      rows.push(`${h.id}${h.trashed ? " (in the trash)" : ""} | ${h.scope} | ${h.title}`);
      last = key;
      shown = 0;
    }
    if (h.text.startsWith("title:")) continue;
    shown++;
    if (shown <= MAX_HIT_LINES) rows.push(`  ${h.line}: ${h.text}`);
    else if (shown === MAX_HIT_LINES + 1) rows.push("  ...");
  }
  const text = hits.length === 0 ? "no match" : [...(complete ? [] : ["no note has every word. Closest:"]), ...rows].join("\n");
  return { json: hits, text };
}

const inTrash = (args: Args) => args.flags.has("trash");

function cmdList(store: Store, args: Args): Output {
  const scope = scopeFilter(store, args);
  const usage = store.usage();
  const trash = inTrash(args);
  const days = store.config().trashDays;
  const found = store.notes({ trashed: trash }).filter((n) => scope === undefined || n.scope === scope);
  // The trash lists the most recently trashed note first.
  const notes = trash ? found.sort(byTrashedAt) : rank(found, usage);
  const rows = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    scope: n.scope,
    title: n.title,
    uses: usage.get(n.id)?.uses ?? 0,
    last_used: usage.get(n.id)?.last_used ?? null,
    last_verified: n.last_verified,
    confidence: n.confidence,
    promoted_to: n.promoted_to ?? null,
    ...(trash ? { trashed_at: n.trashed_at ?? null, clears_at: n.trashed_at ? clearsAt(n.trashed_at, days) : null } : {}),
  }));
  const width = (key: "id" | "kind" | "scope") => Math.max(key.length, ...rows.map((r) => r[key].length));
  const [wId, wKind, wScope] = [width("id"), width("kind"), width("scope")];
  const line = (id: string, kind: string, scope: string, uses: string, verified: string, title: string) =>
    `${id.padEnd(wId)}  ${kind.padEnd(wKind)}  ${scope.padEnd(wScope)}  ${uses.padStart(4)}  ${verified.padEnd(10)}  ${title}`;
  const text =
    rows.length === 0
      ? trash ? "the trash is empty" : "no notes"
      : [line("id", "kind", "scope", "uses", "verified", "title"), ...rows.map((r) => line(r.id, r.kind, r.scope, String(r.uses), r.last_verified.slice(0, 10), `${r.title}${r.clears_at ? ` (deleted ${r.clears_at.slice(0, 10)})` : ""}`))].join("\n");
  return { json: rows, text };
}

function cmdUse(store: Store, args: Args): Output {
  if (args.positional.length === 0) throw new KbError("usage: kb use <id>...");
  const known = new Set(store.notes().map((n) => n.id));
  const used = [...new Set(args.positional.filter((id) => known.has(id)))];
  const unknown = args.positional.filter((id) => !known.has(id));
  if (used.length === 0) throw new KbError(`no active note with id: ${unknown.join(", ")}`);
  store.bumpUsage(used, nowIso());
  afterWrite(store, `kb: use ${used.join(" ")}`);
  const text = `used ${used.join(", ")}${unknown.length > 0 ? `\nunknown ${unknown.join(", ")}` : ""}`;
  return { json: { used, unknown }, text };
}

/** The --scope of a project command: the exact repo id, with no note ids next to it. */
function projectScope(args: Args, verb: string): string | undefined {
  const scope = args.flags.get("scope");
  if (scope === undefined) return undefined;
  if (typeof scope !== "string" || args.positional.length > 0) throw new KbError(`usage: kb ${verb} --scope <repo id>, with no note ids`);
  return scope;
}

function cmdMove(store: Store, args: Args, toTrash: boolean): Output {
  const verb = toTrash ? "trash" : "restore";
  const scope = projectScope(args, verb);
  if (scope !== undefined) {
    const moved = toTrash ? trashProject(store, scope) : restoreProject(store, scope);
    const count = `${moved.length} ${moved.length === 1 ? "note" : "notes"}`;
    return { json: { scope, [toTrash ? "trashed" : "restored"]: moved }, text: toTrash ? `moved ${count} of ${scope} to the trash: ${moved.join(", ")}` : `restored ${count} of ${scope}: ${moved.join(", ")}` };
  }
  if (args.positional.length === 0) throw new KbError(`usage: kb ${verb} <id>...`);
  const moved = moveNotes(store, args.positional, toTrash);
  return { json: { [toTrash ? "trashed" : "restored"]: moved }, text: `${toTrash ? "moved to the trash:" : "restored"} ${moved.join(", ")}` };
}

function cmdEmptyTrash(store: Store, args: Args): Output {
  const scope = projectScope(args, "empty-trash");
  if (scope !== undefined && !store.notes({ trashed: true }).some((n) => n.scope === scope)) throw new KbError(`${scope} has no notes in the trash`);
  const deleted = emptyTrash(store, scope);
  return { json: { deleted }, text: deleted.length === 0 ? "the trash is empty" : `deleted ${deleted.join(", ")}` };
}

function cmdDelete(store: Store, args: Args): Output {
  const scope = projectScope(args, "delete");
  if (scope !== undefined) {
    const deleted = deleteProject(store, scope);
    return { json: { scope, deleted }, text: `deleted ${deleted.length} ${deleted.length === 1 ? "note" : "notes"} of ${scope}: ${deleted.join(", ")}` };
  }
  if (args.positional.length === 0) throw new KbError("usage: kb delete <id>...");
  const deleted = deleteNotes(store, args.positional);
  return { json: { deleted }, text: `deleted ${deleted.join(", ")}` };
}

function cmdStale(store: Store, args: Args): Output {
  const result = findStale(store, String(args.flags.get("repo") ?? "."));
  saveStaleCount(store, result);
  const text = result.candidates.length === 0 ? "no stale candidates" : result.candidates.map((c) => `${c.id} | ${c.reason} | ${c.detail}`).join("\n");
  return { json: result, text };
}

function cmdVerify(store: Store, args: Args): Output {
  if (args.positional.length === 0) throw new KbError("usage: kb verify <id>... [--repo .]");
  const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  const notes = args.positional.map((id) => {
    const note = requireNote(store, id);
    if (note.trashed) throw new KbError(`${id} is in the trash. Restore it first.`);
    if (note.scope !== "global" && note.scope !== repo.scope) throw new KbError(`${id} belongs to ${note.scope}. Run kb verify inside that repo, so the commit is recorded.`);
    return note;
  });
  const now = nowIso();
  for (const { path: _path, trashed: _trashed, ...note } of notes) {
    note.last_verified = now;
    if (note.scope !== "global" && repo.head) note.verified_at_commit = repo.head;
    store.writeNote(note);
  }
  const ids = notes.map((n) => n.id);
  afterWrite(store, `kb: verify ${ids.join(" ")}`);
  return { json: { verified: ids, commit: repo.head }, text: `verified ${ids.join(", ")}` };
}

function cmdBudget(store: Store, args: Args): Output {
  const b = buildBudget(store, String(args.flags.get("repo") ?? "."));
  const count = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  const lines = [
    `scope    ${b.scope ?? "global only"}`,
    `index    ${b.index.lines} of ${b.index.budget} lines`,
    `context  ${b.context.chars} of ${b.context.budget} characters, ${b.context.bodies} bodies shown, ${b.index.lines} in the index only`,
  ];
  // One long body ends the list of bodies, so the longest ones are the first to shorten.
  const longest = b.notes.filter((n) => n.shown === "body").sort((x, y) => y.chars - x.chars).slice(0, 3);
  if (b.context.dropped > 0 && longest.length > 0) lines.push(`longest  ${longest.map((n) => `${n.id} (${n.chars})`).join(", ")}`);
  if (b.index.capped > 0) lines.push(`global   ${b.index.globalBudget} global notes load here, the most used. ${count(b.index.capped)} with fewer uses stay out, on purpose.`);
  if (b.over) {
    lines.push(`${count(b.index.hidden)} ${b.index.hidden === 1 ? "reaches" : "reach"} no session, because the index is full.`);
    if (b.trim.length > 0) lines.push(`Trash or merge first: ${b.trim.map((d) => `${d.id} (${d.reason})`).join(", ")}`);
    if (b.ask.length > 0) lines.push(`Then ask the user, because these are rules: ${b.ask.map((d) => `${d.id} (${d.kind}, ${d.reason})`).join(", ")}`);
    if (b.trim.length === 0 && b.ask.length === 0) lines.push("Nothing to take out: only open work is left.");
  } else lines.push(b.notes.length === 0 ? "no notes load here" : "every note reaches a session, as a body or as an index line");
  return { json: b, text: lines.join("\n") };
}

function cmdCheckpointed(store: Store, args: Args): Output {
  const session = args.positional[0];
  if (!session) throw new KbError("usage: kb checkpointed <session-id>");
  if (store.exists()) markSaved(store, session);
  return { json: { session, recorded: store.exists() }, text: `recorded ${session}` };
}

function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    // no opener on this machine: the printed address is enough
  }
}

/** Start the page server and stay up until the process is stopped. */
async function cmdServe(store: Store, args: Args, json: boolean): Promise<never> {
  if (!store.exists()) throw new KbError("the store does not exist yet. `kb add` creates it.");
  const flag = args.flags.get("port");
  const port = flag === undefined ? DEFAULT_PORT : Number(flag);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new KbError("--port needs a number from 0 to 65535");
  const open = !args.flags.has("no-open") && !json;
  let url: string;
  try {
    url = serve(store, { port }).url;
  } catch (error) {
    if ((error as { code?: string })?.code !== "EADDRINUSE") throw error;
    if (!(await isKbServer(port))) throw new KbError(`port ${port} is in use by another program. Pass --port.`);
    // One server per port is enough: show the one that is already up.
    url = `http://127.0.0.1:${port}/`;
    if (open) openInBrowser(url);
    console.log(json ? JSON.stringify({ url, started: false }, null, 2) : `kb serve is already running at ${url}`);
    process.exit(0);
  }
  console.log(json ? JSON.stringify({ url, started: true }, null, 2) : `kb serve: ${url}
Press Ctrl+C to stop.`);
  if (open) openInBrowser(url);
  return new Promise<never>(() => {});
}

/**
 * `kb audit` starts one headless agent that audits this repo, waits for its proposal, and prints the
 * page link. An audit that waits for the user's picks opens as it is. `kb audit propose` saves the
 * agent's proposal for the page. `kb audit status` says where the audit of this repo stands: none,
 * waiting for the user's picks, or applied, with the notes sent back.
 */
async function cmdAudit(store: Store, args: Args, stdin: () => Promise<string>): Promise<Output> {
  const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  const scope = repo.scope ?? "global";
  // The audit agent itself only asks where the audit stands: it never starts another one.
  const sub = args.positional[0] ?? (process.env[RUN_ENV] ? "status" : undefined);
  if (sub !== undefined && sub !== "propose" && sub !== "status") throw new KbError("usage: kb audit [propose | status] [--repo .] [--no-wait]");
  // The link goes to the server that is running: the port kb serve recorded, or the default.
  const port = (await runningPort(store)) ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/#audit=${encodeURIComponent(scope)}`;
  const served = () => isKbServer(port);
  const open = async (cards: number, lead: string): Promise<Output> => ({
    json: { scope, status: "open", cards, url, served: await served() },
    text: `${lead}\n${(await served()) ? `open ${url}` : `kb serve is not running. Start it with \`kb serve\`, then open ${url}`}`,
  });
  if (sub === "propose") {
    let input: unknown;
    try {
      input = JSON.parse(await stdin());
    } catch {
      throw new KbError('kb audit propose reads {"items": [...]} on stdin');
    }
    store.ensure();
    // A move writes the repo's own instruction file at Apply, so the page must find the checkout.
    if (repo.root && repo.scope) rememberRepo(store, scope, repo.root);
    const audit = proposeAudit(store, input, repo);
    return open(audit.items.length, `saved ${audit.items.length} cards for ${scope}`);
  }
  if (sub === undefined) {
    const waiting = readAudit(store, scope);
    if (waiting && !waiting.result && openAudits(store).includes(scope)) return open(waiting.items.length, `the audit of ${scope} waits for your picks`);
    if (repo.root && repo.scope) rememberRepo(store, scope, repo.root);
    let state = startRun(store, scope, repo.root ?? undefined);
    const what = scope === "global" ? "the global notes" : `the notes of ${scope}`;
    if (args.flags.has("no-wait")) return { json: state, text: `an agent audits ${what} now. Run kb audit again to see where it stands. Log: ${state.log}` };
    if (!args.flags.has("json")) process.stderr.write(`an agent audits ${what}. This takes a few minutes.\nlog: ${state.log}\n`);
    state = await waitRun(store, scope);
    if (state.status === "proposed") return open(state.cards ?? 0, `the agent proposed ${state.cards} cards for ${scope}`);
    if (state.status === "nothing") return { json: state, text: `the agent found nothing to change in ${scope}${state.said ? `:\n${state.said}` : ""}` };
    throw new KbError(`the audit agent stopped with no proposal. Its last lines:\n${state.said || "(no output)"}\nlog: ${state.log}`);
  }
  const audit = readAudit(store, scope);
  if (!audit) return { json: { scope, status: "none" }, text: `no audit for ${scope}` };
  if (!audit.result) return { json: { scope, status: "open", cards: audit.items.length, created: audit.created, url }, text: `the audit of ${scope} waits for the user's picks: ${url}` };
  const r = audit.result;
  const lines = [`the audit of ${scope} was applied at ${r.at}`, ...resultGroups(r).filter(([, ids]) => ids.length).map(([name, ids]) => `${name}: ${ids.join(", ")}`)];
  if (r.requests.length) lines.push("sent back for a rewrite:", ...r.requests.map((q) => `  ${q.id}: ${q.request}`));
  return { json: { scope, status: "applied", ...r }, text: lines.join("\n") };
}

/** Where a rule the user states goes. The note skill writes it there, never to kb. */
function cmdInstructions(store: Store, args: Args): Output {
  const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  let global: { file: string; path: string; link: boolean } | { file: string; error: string };
  try {
    const found = globalInstructions(store);
    global = { file: found.name, path: found.path, link: found.link };
  } catch (error) {
    global = { file: store.config().globalInstructions, error: (error as Error).message };
  }
  const files = repo.root ? REPO_FILES.map((name) => ({ file: name, path: join(repo.root!, name), exists: existsSync(join(repo.root!, name)) })) : [];
  const lines = [`global  ${"path" in global ? `${global.path}${global.link ? ` (${global.file} links here)` : ""}` : global.error}`];
  if (repo.root) for (const f of files) lines.push(`repo    ${f.path}${f.exists ? "" : " (does not exist yet)"}`);
  else lines.push("repo    none: this directory is not in a git repo");
  return { json: { global, repo: repo.root ? { scope: repo.scope, root: repo.root, files } : null }, text: lines.join("\n") };
}

function cmdSync(store: Store): Output {
  const result = syncNow(store);
  return { json: result, text: `${result.status}: ${result.detail}` };
}

async function main(): Promise<number> {
  let json = false;
  try {
    const [command, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);
    json = args.flags.has("json");
    const store = new Store();
    // A note whose time in the trash is up is gone before any command reads the store.
    if (command && store.exists() && !["help", "--help", "-h"].includes(command) && !args.flags.has("help")) {
      // Housekeeping must never stop the command, above all a restore or a delete.
      try {
        tidyTrash(store);
      } catch (error) {
        console.error(`kb: the trash was not cleared: ${(error as Error).message}`);
      }
    }
    // A person who types only `kb` in a terminal wants to see the notes. A script gets the help.
    if (!command && process.stdout.isTTY && store.exists()) await cmdServe(store, args, json);
    if (!command || command === "help" || command === "--help" || command === "-h" || args.flags.has("help")) {
      console.log(USAGE);
      return 0;
    }
    let out: Output;
    switch (command) {
      case "context": out = cmdContext(store, args); break;
      case "scope": out = cmdScope(store, args); break;
      case "add": out = cmdAdd(store, args, await Bun.stdin.text()); break;
      case "show": out = cmdShow(store, args); break;
      case "search": out = cmdSearch(store, args); break;
      case "list": out = cmdList(store, args); break;
      case "use": out = cmdUse(store, args); break;
      case "trash": out = cmdMove(store, args, true); break;
      case "restore": out = cmdMove(store, args, false); break;
      case "delete": out = cmdDelete(store, args); break;
      case "empty-trash": out = cmdEmptyTrash(store, args); break;
      case "stale": out = cmdStale(store, args); break;
      case "verify": out = cmdVerify(store, args); break;
      case "budget": out = cmdBudget(store, args); break;
      case "instructions": out = cmdInstructions(store, args); break;
      case "checkpointed": out = cmdCheckpointed(store, args); break;
      case "serve": out = await cmdServe(store, args, json); break;
      case "audit": out = await cmdAudit(store, args, () => Bun.stdin.text()); break;
      case "sync": out = cmdSync(store); break;
      default: throw new KbError(`unknown command "${command}". Run \`kb help\`.`);
    }
    if (json) console.log(JSON.stringify(out.json, null, 2));
    else if (out.text && !args.flags.has("quiet")) console.log(out.text);
    return 0;
  } catch (error) {
    const message = error instanceof KbError ? error.message : `kb failed: ${(error as Error)?.message ?? error}`;
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  }
}

process.exit(await main());
