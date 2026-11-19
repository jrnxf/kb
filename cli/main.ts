#!/usr/bin/env bun
// kb: a personal knowledge store for coding agents. Harness-agnostic: flags and stdin only.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { openAudits, proposeAudit, readAudit } from "./audit.ts";
import { RUN_ENV, startRun, waitRun } from "./audit-run.ts";
import { rememberRepo, repoRoot } from "./repos.ts";
import { buildBudget, buildContext, rank } from "./context.ts";
import { REPO_FILES, globalInstructions } from "./instructions.ts";
import { MAX_NEIGHBORS, NOT_WRITTEN, type Neighbor, findNeighbors } from "./neighbors.ts";
import { FORGET_WHYS, type ForgetWhy, type Logged, type NoteLog, VERDICTS, type Verdict, type Why, emptyNoteLog, idsWithHistory, lastActivity, logEvent, readLog, saysWorth, sessionOf, setActor, summarize } from "./log.ts";
import { BODY_CHARS, CONFIDENCES, KINDS, KbError, byTrashedAt, type Note, isValidScope, normalizeTitle, slugify, validateNote } from "./note.ts";
import { commitAt, resolveRepo } from "./scope.ts";
import { rejectSecrets } from "./secrets.ts";
import { searchNotes } from "./search.ts";
import { DEFAULT_PORT, isKbServer, runningPort, serve } from "./serve.ts";
import { resultGroups } from "./wire.ts";
import { type UnsavedSession, allUnsaved, forgetUnsaved, isDir, isLive, markSaved, recordRecovered, unsavedSession, unsavedSessions } from "./session.ts";
import { clearStaleCache, findStale, saveStaleCount } from "./stale.ts";
import { Store } from "./store.ts";
import { syncNow } from "./sync.ts";
import { ERR_MIN_CHARS, requireTriggers } from "./trigger.ts";
import { afterWrite, asOfTime, clearsAt, closeIds, deleteNotes, deleteProject, emptyTrash, isoTime, logWrites, moveNotes, noteWarnings, nowIso, requireNote, restoreProject, tidyTrash, trashProject, updateNote } from "./write.ts";

/** `kb add` exits with this code when it wrote nothing because of close notes: an answer to read, not an error (1). */
const NEIGHBORS_EXIT = 2;

const USAGE = `kb - a personal knowledge store for coding agents

  kb context [--repo .]                  text for a session start: index, top notes, pointer
  kb add --file <path> [--repo .] [--as-of <ISO time>] [--recovered-from <session-id>]
                                         create or update a note from the JSON in a file. Without
                                         --file, the JSON comes from stdin.
                                         --as-of is for a fact learned at an earlier time: the
                                         note is verified then.
                                         --recovered-from records the note in that unsaved session
  kb show <id> [--check]                 print one note. A part of the id is enough when one note has
                                         it. --check when the read is a check, not a need for the note:
                                         an audit, or a look before an update
  kb search <words> [--scope s] [--trash] [--check]
                                         notes that have every word, in any order, this repo first.
                                         A word also finds its other forms: retry finds retries
  kb list [--scope s] [--trash]          every note with kind and verified date
                                         --scope takes "repo", "global" or a repo id
  kb verdict <${VERDICTS.join("|")}> <id>...
                                         record what a note did for this session: it changed what you
                                         did, it had no bearing, or it was false or misleading.
                                         not-needed is only for a note that a trigger loaded in the
                                         session, never for a note from the session start
  kb trash <id>... | kb restore <id>...  trash retires a note: restore brings it back. A note in the
                                         trash for more than trashDays (30) is deleted for good
  kb delete <id>...                      remove notes for good, active or in the trash. When the user
                                         wants a note gone now. In a git store, the history keeps the file
  kb empty-trash                         remove every note in the trash for good
  kb trash --scope <repo id>             move every note of a project to the trash. restore --scope
                                         brings that move back. delete --scope removes the project's
                                         notes for good, and empty-trash --scope only its trash. Each
                                         takes the exact repo id, never "global". Only when the user asks
  kb stale [--repo .]                    notes that may no longer be true, each with a reason: a changed
                                         or missing anchor, no use, an old check, a close note, or
                                         the verdicts wrong and not-needed of sessions on any machine
  kb verify <id>... [--repo .]           record that these notes are still true, at HEAD
  kb budget [--repo .]                   what a session loads, and what reaches no session
  kb audit [--repo .] [--no-wait]        start an agent that audits this repo's notes, and print the
                                         page link. Outside any repo, it audits the global notes
  kb audit propose --file <path> [--repo .]
                                         save /kb:audit's proposal for the page, from the JSON in a
                                         file. Without --file, the JSON comes from stdin
  kb audit status [--repo .]             where the audit of this scope stands, and the notes the user
                                         sent back for a rewrite
  kb instructions [--repo .]             the instruction files for a rule the user states: the global
                                         one, and the repo's CLAUDE.md and AGENTS.md
  kb checkpointed <session-id>           record that this session saved its knowledge. A recovery adds
                                         --ended <time>, the end it read: a session that ran again
                                         since then is not marked
  kb log [--session id] [--since days]   what the log of this machine says of each note: how often a
                                         session got it, opened it and judged it. With --session, the
                                         events of one session in time order. The log keeps 12 months
  kb unsaved [--repo .]                  sessions here that ended with no checkpoint, and their transcripts.
                                         Never the session that asks
  kb unsaved --all                       those of every directory, newest first, with the count per
                                         project. Each has its scope, its directory, and if that is gone
  kb unsaved --forget <session-id>       stop reporting one of them, as it holds nothing to save
  kb scope [--repo .]                    print the scope id of a directory
  kb serve [--port n] [--no-open]        the store as a local page: read, edit and trash notes
                                         kb alone in a terminal does the same. Behind a proxy, name it in
                                         KB_SERVE_HOSTS: kb.example.com, or .example.com for every name under it
  kb sync                                commit, pull and push the store

Every command accepts --json. The store is ~/.kb, or KB_HOME.
A read, a write and a verdict each add one line to a log on this machine. The line names the
session: --session <id>, or KB_SESSION, or the id that Claude Code sets for the command.
The log stays on its machine. A small roll-up of it syncs with the store, at most once per day.

The events of the log: start, fire, show, search, write, verdict, checkpoint, and for the end of a session:
  ended      a session ended: the reason, and if a checkpoint had run in it
  unsaved    a session that ended with no checkpoint is worth a recovery. Once per session
  recover    another session saved its knowledge: the notes it wrote
  forgotten  its record was dropped with no recovery: short, user, aged (7 days) or gone (no transcript)

kb add reads: {"title", "kind", "body", "scope"?, "id"?, "anchors"?, "triggers"?, "confidence"?, "supersedes"?, "new"?}
  Write the JSON to a file and pass --file <path>. A shell policy can refuse a command that
  holds the JSON in a heredoc. A file always passes.
  scope: "repo" (the default inside a git repo), "global", or the id of a repo that has notes
  kind: ${KINDS.join(" | ")}
  confidence: ${CONFIDENCES.join(" | ")} (default medium)
  anchors: repo-relative paths, or path#symbol. A repo note loads when the agent reads or changes
    a file that an anchor names, or runs a command that names it.
  triggers: when the note loads outside the session start, each "<kind>: <text>":
    "cmd: pkill -f"  before a shell command that runs it. One simple command of the line must
      hold the words in order, as whole words, the first as its command word. One word that is
      a common command (ls, git, bun, ...) needs a second word.
    "stop: git push --force"  the same match, and kb refuses the command once, with the note
      as the reason. A run 3 seconds later passes. For a command where one run does damage.
    "err: address already in use"  after a tool call that failed with this text in its error.
      At least ${ERR_MIN_CHARS} characters. Case does not count.
  A saved note can come with "warnings": a gotcha or a how-to with no trigger and no anchor, and
  a body over ${BODY_CHARS} characters. The note is stored in each case.
  With "id", the note is updated. A new title, body or anchors also counts as a verification.
  New triggers alone do not.
  An update never changes the scope of a note, so leave "scope" out of it.
  With --as-of (a full ISO time with a zone), the verification has that time and the newest commit
  of the repo at that time. An update of a note that was verified after that time changes nothing:
  the result is {"status": "newer", "id", "last_verified"}.
  With --recovered-from, a created or updated note is recorded in that unsaved session, so a second
  recovery of the session sees it.
  Without "id", a note with the same title in the same scope
  is not overwritten: the result is {"status": "exists", "id"}.
  Without "id", kb also compares the words of the new note with the notes of its scope and the
  global notes. When a note is close, nothing is written: the result is {"status": "neighbors",
  "neighbors": [{"id", "scope", "kind", "title", "first_line", "shared", "score"}]}, at most ${MAX_NEIGHBORS}.
  A note named in "supersedes" is never a neighbor: the new note replaces it.
  "shared" names the words both notes have. Read each neighbor with kb show <id> --check. Then pass
  its "id" with no "scope" to update the note that holds the same fact, or "new": true when this is
  a different fact.
  Update a neighbor of another scope only when the fact holds in that scope too: for a global
  note, in every repo. Else pass "new": true.
  With "new": true the note is written, and the result still lists the neighbors.
  Exit codes: 0 for "created", "updated", "exists" and "newer". ${NEIGHBORS_EXIT} for "neighbors": nothing was
  written, and the answer is on stdout as always. 1 for an error.`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["as-of", "ended", "file", "forget", "recovered-from", "repo", "scope", "to", "port", "session", "since"]);

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

/** `code` is the exit code, 0 when it is left out. */
type Output = { json: unknown; text: string; code?: number };

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

/** The JSON a command reads: the file of --file, or stdin. A shell can refuse a heredoc. A file always passes. */
async function inputText(args: Args): Promise<string> {
  const file = args.flags.get("file");
  if (file === undefined) return Bun.stdin.text();
  try {
    return readFileSync(resolve(String(file)), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a directory" : code === "EACCES" ? "no permission to read it" : (error as Error).message;
    throw new KbError(`cannot read --file ${file}: ${why}`);
  }
}

/** One close note as text: the line of `kb search`, with the kind, then the first line and the shared words. */
const neighborText = (n: Neighbor) => `${n.id} | ${n.scope} | ${n.kind} | ${n.title}\n  ${n.first_line}\n  shared: ${n.shared.join(", ")}`;

const NEIGHBORS_HINT = 'Read each with `kb show <id> --check`. To update the note that holds the same fact, pass its "id" and remove "scope". Pass "new": true when this is a different fact. When a neighbor says the opposite, update it with what is true now.';

/**
 * What the writer does with the close notes. A neighbor of another scope gets its own sentence: an
 * update by id would put a fact about one repo into a note that every repo gets.
 */
function neighborsHint(neighbors: Neighbor[], scope: string): string {
  const elsewhere = neighbors
    .filter((n) => n.scope !== scope)
    .map((n) => `${n.id} is ${n.scope === "global" ? "a global note: update it only when the fact holds in every repo" : `a note of ${n.scope}: update it only when the fact holds in that repo too`}. Else pass "new": true.`);
  return [NEIGHBORS_HINT, ...elsewhere].join(" ");
}

const ADD_INPUT = "kb add reads one JSON object, from --file <path> or on stdin";

function cmdAdd(store: Store, args: Args, text: string): Output {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(text);
  } catch {
    throw new KbError(ADD_INPUT);
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new KbError(ADD_INPUT);

  store.ensure();
  const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  // One clock read, so a time that is cut to now is the same now as `created`.
  const clock = Date.now();
  const now = isoTime(clock);
  // A fact from an earlier time, such as a session recovered later, is verified then and not now.
  const asOf = args.flags.has("as-of") ? asOfTime(String(args.flags.get("as-of")), clock) : undefined;
  // The session a recovery reads. Checked before the write, so a wrong id never passes in silence.
  const from = args.flags.get("recovered-from");
  if (typeof from === "string" && !unsavedSession(store, from)) throw new KbError(`no unsaved session ${from}. \`kb unsaved\` lists them.`);
  const recovered = (id: string) => {
    if (typeof from === "string") recordRecovered(store, from, id);
  };
  const active = store.notes();
  const trashed = store.notes({ trashed: true });

  // Update: merge the given fields over the stored note.
  if (typeof input.id === "string") {
    const existing = active.find((n) => n.id === input.id);
    if (!existing) throw new KbError(`no active note with id "${input.id}"`);
    // The neighbor check names a global note for a repo draft. The draft's scope must not send the writer to the trash.
    if (input.scope !== undefined && resolveScopeInput(input.scope, repo.scope) !== existing.scope) {
      throw new KbError(`the note ${existing.id} has the scope "${existing.scope}", and an update keeps it. Remove "scope" from the input to update the note.`);
    }
    // The note was checked after that time. Old text must not go under the newer check, so nothing changes.
    if (asOf !== undefined && Date.parse(existing.last_verified) > Date.parse(asOf)) {
      return {
        json: { status: "newer", id: existing.id, last_verified: existing.last_verified },
        text: `newer ${existing.id}: the note was checked at ${existing.last_verified}, after the time of --as-of. Nothing changed.`,
      };
    }
    const updated = updateNote(store, input as Record<string, unknown> & { id: string }, repo, asOf, typeof from === "string" ? from : undefined);
    recovered(updated.id);
    return added("updated", updated, store.notes().find((n) => n.id === updated.id) ?? existing);
  }

  const scope = resolveScopeInput(input.scope, repo.scope);
  // A scope that no repo resolves to never loads in a session. A typing error must not hide a note there.
  if (scope !== repo.scope && !knownScopes(store).includes(scope)) {
    throw new KbError(`${unknownScope(store, scope)} To start the notes of another repo, pass --repo <its directory>.`);
  }
  if (typeof input.title !== "string" || !input.title.trim()) throw new KbError("invalid note: title: required");
  rejectSecrets({ title: input.title, body: input.body, anchors: input.anchors, triggers: input.triggers }, "the note");
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
    // An id with a history on any machine belongs to a deleted note, or to a note that has not
    // synced here yet: a new note must not inherit its history.
    id: uniqueId(slug, new Set([...[...active, ...trashed].map((n) => n.id), ...idsWithHistory(store)])),
    scope,
    created: now,
    last_verified: asOf ?? now,
  };
  const commit = asOf === undefined ? repo.head : commitAt(repo.root, asOf);
  if (scope !== "global" && repo.scope === scope && commit) raw.verified_at_commit = commit;
  if (input.triggers !== undefined) raw.triggers = requireTriggers(input.triggers);
  const note: Note = validateNote(raw);

  // A known fact in other words has another title, so it passes the check above. The writer
  // decides: update the close note, or say with "new" that this is a different fact.
  const close = findNeighbors(active, note);
  // A repo note that is close to a global note never stops the write: it cannot become global.
  const own = close.filter((n) => n.scope === scope || n.scope === "global");
  const neighbors = [...own, ...close.filter((n) => !own.includes(n))].slice(0, MAX_NEIGHBORS);
  const shown = neighbors.map((n) => n.id);
  if (own.length > 0 && input.new !== true) {
    logEvent(store, { ev: "neighbors", title: note.title, neighbors: shown });
    const hint = neighborsHint(neighbors, scope);
    return {
      json: { status: "neighbors", neighbors, hint },
      text: [`neighbors: ${count(neighbors.length, "note is", "notes are")} ${NOT_WRITTEN}`, ...neighbors.map(neighborText), hint].join("\n"),
      // Nothing was written, so a caller that reads only the exit code must not take it for a save.
      code: NEIGHBORS_EXIT,
    };
  }

  const path = store.writeNote(note);
  afterWrite(store, `kb: add ${note.id}`);
  logWrites(store, "add", [note.id], shown, typeof from === "string" ? from : undefined);
  recovered(note.id);
  return added("created", { id: note.id, path }, note, neighbors);
}

/** The result of a note that `kb add` saved, with what the writer should look at again. */
function added(status: "created" | "updated", saved: { id: string; path: string }, note: Note, neighbors: Neighbor[] = []): Output {
  const warnings = noteWarnings(note);
  const close = neighbors.length > 0;
  return {
    json: { status, ...saved, ...(close ? { neighbors } : {}), ...(warnings.length > 0 ? { warnings } : {}) },
    text: [`${status} ${saved.id}`, ...warnings.map((warning) => `warning: ${warning}`), ...(close ? ["close notes, not changed:", ...neighbors.map(neighborText)] : [])].join("\n"),
  };
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

/**
 * Why the command reads: for a task, or as a check (an audit, a look before an update). --no-use is
 * the older name of --check, which a cached skill on another machine may still pass.
 */
const whyOf = (args: Args): Why => (args.flags.has("check") || args.flags.has("no-use") ? "check" : "task");

function cmdShow(store: Store, args: Args): Output {
  const given = args.positional[0];
  if (!given) throw new KbError("usage: kb show <id> [--check]");
  // Ids are long. A part of one is enough to read a note, when only one note has it.
  const close = store.find(given) ? [] : closeIds(store, given);
  const note = requireNote(store, close.length === 1 ? close[0]! : given);
  // A read changes nothing in the store. The log on this machine records it. A look into the
  // trash is marked, so it never counts as activity of the note.
  logEvent(store, { ev: "show", note: note.id, why: whyOf(args), ...(note.trashed ? { trashed: true as const } : {}) });
  return { json: note, text: `# ${relative(store.home, note.path)}\n${readFileSync(note.path, "utf8").trimEnd()}` };
}

function cmdSearch(store: Store, args: Args): Output {
  const query = args.positional.join(" ");
  if (!query) throw new KbError("usage: kb search <words> [--scope s] [--trash] [--check]");
  const scope = scopeFilter(store, args);
  const first = resolveRepo(String(args.flags.get("repo") ?? "."), store).scope ?? undefined;
  const { hits, complete } = searchNotes(store, query, { scope, trash: inTrash(args), first });
  // `hits` counts the notes with every word. The closest notes are not hits, so they have their own field.
  const found = new Set(hits.map((h) => h.id)).size;
  logEvent(store, { ev: "search", query, ...(complete ? { hits: found, complete } : { hits: 0, complete, closest: found }), why: whyOf(args) });
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
  const trash = inTrash(args);
  const days = store.config().trashDays;
  const found = store.notes({ trashed: trash }).filter((n) => scope === undefined || n.scope === scope);
  // The trash lists the most recently trashed note first.
  const notes = trash ? found.sort(byTrashedAt) : rank(found, lastActivity(store));
  const rows = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    scope: n.scope,
    title: n.title,
    last_verified: n.last_verified,
    confidence: n.confidence,
    triggers: n.triggers ?? [],
    promoted_to: n.promoted_to ?? null,
    ...(trash ? { trashed_at: n.trashed_at ?? null, clears_at: n.trashed_at ? clearsAt(n.trashed_at, days) : null } : {}),
  }));
  const width = (key: "id" | "kind" | "scope") => Math.max(key.length, ...rows.map((r) => r[key].length));
  const [wId, wKind, wScope] = [width("id"), width("kind"), width("scope")];
  const line = (id: string, kind: string, scope: string, verified: string, title: string) =>
    `${id.padEnd(wId)}  ${kind.padEnd(wKind)}  ${scope.padEnd(wScope)}  ${verified.padEnd(10)}  ${title}`;
  const text =
    rows.length === 0
      ? trash ? "the trash is empty" : "no notes"
      : [line("id", "kind", "scope", "verified", "title"), ...rows.map((r) => line(r.id, r.kind, r.scope, r.last_verified.slice(0, 10), `${r.title}${r.clears_at ? ` (deleted ${r.clears_at.slice(0, 10)})` : ""}`))].join("\n");
  return { json: rows, text };
}

/**
 * `kb verdict`: what a note did for the session that got it. `kb use <id>...` is the older form of
 * `kb verdict helped`, which a cached skill on another machine may still run.
 */
function cmdVerdict(store: Store, verdict: string | undefined, ids: string[], session?: string): Output {
  if (!VERDICTS.includes(verdict as Verdict) || ids.length === 0) throw new KbError(`usage: kb verdict <${VERDICTS.join("|")}> <id>...`);
  // A session may judge a note that it trashed a moment ago, for example a note that was wrong.
  const known = new Set([...store.notes(), ...store.notes({ trashed: true })].map((n) => n.id));
  const notes = [...new Set(ids.filter((id) => known.has(id)))];
  const unknown = ids.filter((id) => !known.has(id));
  if (notes.length === 0) throw new KbError(`no note with id: ${unknown.join(", ")}`);
  // "not-needed" says that a trigger loaded a note for nothing. A note that every session gets at
  // its start has no bearing on most sessions, so three of them would send it to the audit.
  if (verdict === "not-needed" && session !== undefined) {
    const fired = new Set(readLog(store, { session }).flatMap((event) => (event.ev === "fire" ? [event.note] : [])));
    const never = notes.filter((id) => !fired.has(id));
    if (never.length > 0) {
      throw new KbError(`not-needed is only for a note that a trigger loaded in the session: "fired" in \`kb log --session\`. Session ${session} has no fire of: ${never.join(", ")}. A note from the session start gets helped, wrong or no verdict. Nothing was recorded.`);
    }
  }
  // The log is all a verdict writes, so here a log that fails is an error.
  if (!logEvent(store, notes.map((note) => ({ ev: "verdict" as const, note, verdict: verdict as Verdict })))) throw new KbError("the verdict was not recorded: kb could not write its log");
  // A verdict changes what `kb stale` says, so the count that a session start reads is old now.
  clearStaleCache(store);
  const text = `${verdict}: ${notes.join(", ")}${unknown.length > 0 ? `\nunknown ${unknown.join(", ")}` : ""}`;
  return { json: { verdict, notes, unknown }, text };
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
  logWrites(store, "verify", ids);
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
  if (b.index.capped > 0) lines.push(`global   ${b.index.globalBudget} global notes load here, the highest ranked. ${count(b.index.capped)} of lower rank stay out, on purpose.`);
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
  if (!session) throw new KbError("usage: kb checkpointed <session-id> [--ended <time>]");
  // A session that ended with no checkpoint, and that another session now saves, is recovered. A
  // session that was resumed and saves itself is checkpointed, as any session is.
  const mark = store.exists() ? unsavedSession(store, session) : null;
  const by = sessionOf(args.flags.get("session"));
  // A recovery names the end of the session that it read: the `ended` of `kb-transcript`.
  const read = args.flags.get("ended");
  // The session was resumed while another session recovered it. What it learns from now on is
  // not in the notes of that recovery, so only the session itself can say that it is saved.
  if (mark === null && (read !== undefined || (by !== undefined && by !== session)) && store.exists() && isLive(store, session)) {
    throw new KbError(`session ${session} runs again: the user resumed it. Nothing was recorded. It gets a new record when it ends. Recover it again then.`);
  }
  // It was resumed, and it ended again in that time. The record is now of a longer session than
  // the one that the recovery read, so it stays for a second recovery.
  if (mark !== null && read !== undefined && !sameTime(mark.ended, String(read))) {
    throw new KbError(`session ${session} ran again and ended at ${mark.ended}, after this recovery read it. Nothing was recorded. Recover it again: /kb:recover reads what it said since.`);
  }
  const recovered = mark !== null && by !== session;
  if (store.exists()) markSaved(store, session);
  // The event has the scope of the old session, so the audit can count the recoveries of a project.
  if (recovered) logEvent(store, { ev: "recover", session, by, notes: mark.notes ?? [], ...(mark.reason ? { reason: mark.reason } : {}), ...(mark.scope !== undefined ? { scope: mark.scope ?? "global" } : {}) });
  else logEvent(store, { ev: "checkpoint", session });
  return { json: { session, recorded: store.exists(), ...(recovered ? { recovered: true } : {}) }, text: `recorded ${session}` };
}

/** Two times of a mark that are the same moment, however they are written. */
const sameTime = (a: string, b: string) => a === b || Date.parse(a) === Date.parse(b);

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A time of the log in the local time of this machine, for a person to read. */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Why a record was dropped, in words. */
const FORGOTTEN: Record<ForgetWhy, string> = { short: "too short to recover", user: "the user said so", aged: "aged out after 7 days", gone: "its transcript is gone" };

/** The same in the sum of `kb log`, after a count. */
const FORGOTTEN_AS: Record<ForgetWhy, string> = { short: "too short", user: "by the user", aged: "aged out", gone: "no transcript" };

/** One event of a session as text. An event that a later kb wrote prints its name and its note. */
function eventText(event: Logged): string {
  const e = event as Logged & Record<string, any>;
  const detail = (): string => {
    switch (e.ev) {
      case "start": return `${e.source}: ${count(e.bodies.length, "body", "bodies")}, ${count(e.index.length, "index line", "index lines")}, ${e.hidden.length} hidden, ${e.chars.total} characters`;
      // A path names the file. A trigger names itself: "cmd: pkill -f".
      case "fire": return e.kind === "path" || !e.kind ? `${e.note} (${e.tool} of ${e.match})` : `${e.note} (${e.tool}, ${e.kind}: ${e.match})`;
      case "show": return `${e.note} (${e.why}${e.trashed ? ", in the trash" : ""})`;
      // A line of an older kb has no `complete`: its `hits` may count the closest notes.
      case "search": return `${JSON.stringify(e.query)}: ${e.complete === false ? `no note has every word, ${count(e.closest ?? 0, "closest note", "closest notes")}` : count(e.hits, "note", "notes")} (${e.why})`;
      case "write": return `${e.op} ${e.note}${e.from ? ` (recovered from ${e.from})` : ""}${Array.isArray(e.neighbors) ? ` (close to ${e.neighbors.join(", ")})` : ""}`;
      case "neighbors": return `${JSON.stringify(e.title)}: not written, close to ${e.neighbors.join(", ")}`;
      case "verdict": return `${e.verdict} ${e.note}`;
      case "ended": return `after ${e.reason}, ${e.checkpoint ? "with a checkpoint" : "no checkpoint"}`;
      case "unsaved": {
        // A line of an older kb has no measure: it says only that a session ended with no checkpoint.
        if (!saysWorth(e)) return `${e.reason ? `after ${e.reason}, ` : ""}no checkpoint`;
        const measure = typeof e.prompts === "number" ? `${count(e.prompts, "prompt", "prompts")}, ${count(e.failed ?? 0, "failed tool call", "failed tool calls")}` : "a transcript too large to measure";
        return `worth a recovery: ${measure}${e.reason ? `, ended after ${e.reason}` : ""}`;
      }
      case "recover": return `${count(e.notes.length, "note", "notes")}${e.by ? `, by session ${e.by}` : ""}`;
      case "forgotten": return `${FORGOTTEN[e.why as ForgetWhy] ?? e.why}${e.worth ? ", was worth a recovery" : ""}${e.by ? `, by session ${e.by}` : ""}`;
      default: return typeof e.note === "string" ? e.note : "";
    }
  };
  let text = "";
  try {
    text = detail();
  } catch {
    // a line with a field missing still shows its time and its name
  }
  return `${localTime(e.t)}  ${e.ev.padEnd(10)}  ${text}${e.agent ? `  [agent ${e.agent}]` : ""}`.trimEnd();
}

/**
 * `kb log`: what the log of this machine says of each note. With --session, the events of one
 * session in time order, and the notes it got and has not judged yet. The JSON is what the audit
 * reads: one row per note, with the same fields in both forms.
 */
function cmdLog(store: Store, args: Args): Output {
  const session = args.flags.get("session");
  const sinceDays = args.flags.get("since");
  if (sinceDays !== undefined && !(Number(sinceDays) > 0)) throw new KbError("--since needs a number of days above 0");
  const since = sinceDays === undefined ? undefined : new Date(Date.now() - Number(sinceDays) * 86_400_000);
  const events = readLog(store, { since, session: typeof session === "string" ? session : undefined });
  const { notes: logged, ...totals } = summarize(events);

  const active = new Map(store.notes().map((n) => [n.id, n]));
  const trashed = new Map(store.notes({ trashed: true }).map((n) => [n.id, n]));
  const lastActive = lastActivity(store);
  const row = ({ id, ...counts }: NoteLog) => {
    const note = active.get(id) ?? trashed.get(id);
    // "gone": the note was deleted, or it lives on a machine that has not synced it here.
    return { id, scope: note?.scope ?? null, kind: note?.kind ?? null, state: active.has(id) ? "active" : trashed.has(id) ? "trash" : "gone", ...counts, last_activity: lastActive.get(id) ?? null };
  };
  const head = { since: since ? nowIso(since) : null, ...totals };
  // The records that were dropped with no recovery, by why, and how many of them held something.
  const dropped = FORGET_WHYS.map((why) => [FORGOTTEN_AS[why], totals.forgotten[why]] as const).filter(([, n]) => n > 0);
  const forgotten = `${dropped.reduce((sum, [, n]) => sum + n, 0)} forgotten${dropped.length > 0 ? ` (${dropped.map(([as, n]) => `${n} ${as}`).join(", ")})` : ""}${totals.forgotten.worth > 0 ? `, ${totals.forgotten.worth} of them worth a recovery` : ""}`;
  const period = totals.from ? `${localTime(totals.from)} to ${localTime(totals.to!)}` : "no events";

  if (typeof session === "string") {
    const notes = logged.map(row);
    // The notes the session can judge: it got the body, opened the note for a task, or a hook named it.
    const got = (n: (typeof notes)[number]) => [n.body > 0 ? "body" : "", n.opened.task > 0 ? "opened" : "", n.fired > 0 ? "fired" : ""].filter(Boolean);
    const judged = (n: (typeof notes)[number]) => VERDICTS.some((v) => n.verdicts[v] > 0);
    const unjudged = notes.filter((n) => n.state !== "gone" && got(n).length > 0 && !judged(n));
    const scope = events.find((e) => typeof e.scope === "string" && e.scope)?.scope ?? null;
    const lines = [`session ${session} | ${scope ?? "scope unknown"} | ${period} | ${count(events.length, "event", "events")}`, ...events.map(eventText)];
    if (unjudged.length > 0) lines.push("no verdict yet:", ...unjudged.map((n) => `- ${n.id} | ${got(n).join(", ")} | ${(active.get(n.id) ?? trashed.get(n.id))!.title}`));
    return { json: { session, scope, ...head, notes, unjudged: unjudged.map((n) => n.id), timeline: events }, text: lines.join("\n") };
  }

  // Every active note has a row, so a note that no session got shows as zeros, not as a gap.
  const named = new Set(logged.map((n) => n.id));
  const quiet = [...active.keys()].filter((id) => !named.has(id));
  const notes = [...logged, ...quiet.map(emptyNoteLog)].map(row).sort((a, b) => a.id.localeCompare(b.id));
  const columns = ["body", "index", "hidden", "opened", "checked", "fired", ...VERDICTS];
  const cells = (n: (typeof notes)[number]) => [n.body, n.index, n.hidden, n.opened.task, n.opened.check, n.fired, ...VERDICTS.map((v) => n.verdicts[v])];
  const wId = Math.max(2, ...logged.map((n) => n.id.length));
  const table = (id: string, values: (string | number)[]) => `${id.padEnd(wId)}  ${values.map((v, i) => String(v).padStart(columns[i]!.length)).join("  ")}`;
  const lines = [
    `log  ${period} | ${count(totals.sessions, "session", "sessions")}, ${count(totals.starts, "start", "starts")}, ${count(totals.checkpoints, "checkpoint", "checkpoints")} | searches: ${totals.searches.task} for a task, ${totals.searches.check} as a check`,
    // What an audit needs of the ends: how many sessions ended, and what came of their knowledge.
    `ends ${totals.ended.all} ended, ${totals.ended.checkpointed} with a checkpoint | ${totals.unsaved} worth a recovery, ${totals.recovered} recovered, ${forgotten}`,
  ];
  if (logged.length > 0) lines.push(table("id", columns), ...notes.filter((n) => named.has(n.id)).map((n) => table(n.id, cells(n))));
  if (quiet.length > 0) lines.push(`${count(quiet.length, "active note has", "active notes have")} no event${since ? " in this time" : ""}.`);
  return { json: { ...head, notes }, text: lines.join("\n") };
}

function cmdUnsaved(store: Store, args: Args): Output {
  const forget = args.flags.get("forget");
  // The session that asks is live. It is never in the list, also when its own mark is still there.
  const self = sessionOf(args.flags.get("session"));
  const others = (sessions: UnsavedSession[]) => sessions.filter((s) => s.session !== self);
  if (typeof forget === "string") {
    const forgotten = store.exists() && forgetUnsaved(store, forget, "user", self);
    return { json: { session: forget, forgotten }, text: forgotten ? `forgot ${forget}` : `no unsaved session ${forget}` };
  }
  const all = args.flags.has("all");
  if (!store.exists()) return { json: [], text: all ? "no unsaved session" : "no unsaved session here" };
  const known = new Set(knownScopes(store));
  if (all) {
    // The newest first: the user sees what just ended. The count per project comes before the list.
    const sessions = others(allUnsaved(store)).reverse().map((s) => ({ ...s, ...placeOf(store, s, known) }));
    if (sessions.length === 0) return { json: [], text: "no unsaved session" };
    const projects = new Map<string, number>();
    for (const s of sessions) projects.set(s.scope ?? "not known", (projects.get(s.scope ?? "not known") ?? 0) + 1);
    const lines = [
      `${count(sessions.length, "unsaved session", "unsaved sessions")} in ${count(projects.size, "project", "projects")}`,
      ...[...projects].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([scope, n]) => `${String(n).padStart(3)}  ${scope}`),
      "",
      ...sessions.map((s) => `${s.session} | ${s.scope ?? "scope not known"} | ended ${s.ended} | ${s.cwd}${s.exists ? "" : " (gone)"}${s.recoverable ? "" : " | not recoverable"}`),
    ];
    return { json: sessions, text: lines.join("\n") };
  }
  const dir = String(args.flags.get("repo") ?? ".");
  const sessions = others(unsavedSessions(store, resolve(dir), resolveRepo(dir, store).root)).map((s) => ({ ...s, ...placeOf(store, s, known) }));
  const text = sessions.map((s) => `${s.session} | ended ${s.ended} | ${s.transcript}`).join("\n") || "no unsaved session here";
  return { json: sessions, text };
}

/**
 * Where the notes of an unsaved session go, for the session that recovers it.
 * `scope`: the repo id, "global" for a session outside any repo, or null when nobody knows it.
 * `exists`: the directory the session ran in is still there.
 * `dir`: a checkout to pass as --repo: that directory, the root around it, the main checkout of
 * its repo, or the checkout of the same repo that kb saw last. Null when none is on disk. The
 * worktree of a finished run is often deleted, and the main checkout stays.
 * `recoverable`: false when no note can be written: the scope is not known, or the repo has no
 * note yet and no checkout, so `kb add` cannot start its notes.
 */
function placeOf(store: Store, session: UnsavedSession, known: Set<string>): { scope: string | null; exists: boolean; dir: string | null; recoverable: boolean } {
  const own = [session.cwd, session.root].find(isDir) ?? null;
  // A mark of an older kb has no scope. The directory still says it, while it is there.
  const scope = session.scope !== undefined ? (session.scope ?? "global") : own ? (resolveRepo(own, store, { record: false }).scope ?? "global") : null;
  const dir = own ?? (isDir(session.main) ? session.main : scope && scope !== "global" ? (repoRoot(store, scope) ?? null) : null);
  return { scope, exists: isDir(session.cwd), dir, recoverable: scope !== null && (scope === "global" || dir !== null || known.has(scope)) };
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
async function cmdAudit(store: Store, args: Args, input: () => Promise<string>): Promise<Output> {
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
    const text = await input();
    let proposal: unknown;
    try {
      proposal = JSON.parse(text);
    } catch {
      throw new KbError('kb audit propose reads {"items": [...]}, from --file <path> or on stdin');
    }
    store.ensure();
    const audit = proposeAudit(store, proposal, repo);
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
    // Each event of the command names the session that runs it. The scope takes a git call, so it
    // waits for the first event. The page server runs for hours and serves the user, so it names none.
    // The trash above is cleared for nobody, so its events come before this.
    if (command && command !== "serve") {
      let who: { session?: string; scope: string } | undefined;
      setActor(() => (who ??= { session: sessionOf(args.flags.get("session")), scope: resolveRepo(String(args.flags.get("repo") ?? "."), store, { record: false }).scope ?? "global" }));
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
      case "add": out = cmdAdd(store, args, await inputText(args)); break;
      case "show": out = cmdShow(store, args); break;
      case "search": out = cmdSearch(store, args); break;
      case "list": out = cmdList(store, args); break;
      case "verdict": out = cmdVerdict(store, args.positional[0], args.positional.slice(1), sessionOf(args.flags.get("session"))); break;
      case "use": out = cmdVerdict(store, "helped", args.positional); break;
      case "log": out = cmdLog(store, args); break;
      case "trash": out = cmdMove(store, args, true); break;
      case "restore": out = cmdMove(store, args, false); break;
      case "delete": out = cmdDelete(store, args); break;
      case "empty-trash": out = cmdEmptyTrash(store, args); break;
      case "stale": out = cmdStale(store, args); break;
      case "verify": out = cmdVerify(store, args); break;
      case "budget": out = cmdBudget(store, args); break;
      case "instructions": out = cmdInstructions(store, args); break;
      case "checkpointed": out = cmdCheckpointed(store, args); break;
      case "unsaved": out = cmdUnsaved(store, args); break;
      case "serve": out = await cmdServe(store, args, json); break;
      case "audit": out = await cmdAudit(store, args, () => inputText(args)); break;
      case "sync": out = cmdSync(store); break;
      default: throw new KbError(`unknown command "${command}". Run \`kb help\`.`);
    }
    if (json) console.log(JSON.stringify(out.json, null, 2));
    else if (out.text && !args.flags.has("quiet")) console.log(out.text);
    return out.code ?? 0;
  } catch (error) {
    const message = error instanceof KbError ? error.message : `kb failed: ${(error as Error)?.message ?? error}`;
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  }
}

process.exit(await main());
