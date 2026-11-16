#!/usr/bin/env bun
// kb: a personal knowledge store for coding agents. Harness-agnostic: flags and stdin only.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildBudget, buildContext, rank } from "./context.ts";
import { CONFIDENCES, KINDS, KbError, type Note, isValidScope, normalizeTitle, slugify, validateNote } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import { searchNotes } from "./search.ts";
import { DEFAULT_PORT, isKbServer, serve } from "./serve.ts";
import { markSaved } from "./session.ts";
import { clearStaleCache, findStale, saveStaleCount } from "./stale.ts";
import { Store } from "./store.ts";
import { syncNow } from "./sync.ts";
import { afterWrite, moveNotes, nowIso, requireNote, updateNote } from "./write.ts";

const USAGE = `kb - a personal knowledge store for coding agents

  kb context [--repo .]                  text for a session start: index, top notes, pointer
  kb add [--repo .]                      create or update a note from JSON on stdin
  kb show <id>                           print one note
  kb search <words> [--scope s] [--archive]
                                         notes that have every word, in any order
  kb list [--scope s] [--archive]        every note with kind, uses and verified date
  kb use <id>...                         record that these notes changed what you did
  kb archive <id>... | kb restore <id>...
  kb stale [--repo .]                    notes that may no longer be true, each with a reason
  kb verify <id>... [--repo .]           record that these notes are still true, at HEAD
  kb budget [--repo .]                   sizes against both budgets, and what to demote
  kb promote <id> --to CLAUDE.md|AGENTS.md [--dry-run] [--repo .]
                                         append a note to the repo's own file
  kb checkpointed <session-id>           record that this session saved its knowledge
  kb scope [--repo .]                    print the scope id of a directory
  kb serve [--port n] [--no-open]        the store as a local page: read, edit and archive notes
                                         kb alone in a terminal does the same
  kb sync                                commit, pull and push the store

Every command accepts --json. The store is ~/.kb, or KB_HOME.

kb add reads: {"title", "kind", "body", "scope"?, "id"?, "anchors"?, "confidence"?, "indexed"?, "supersedes"?}
  scope: "repo" (the default inside a git repo), "global", or an explicit repo id
  kind: ${KINDS.join(" | ")}
  confidence: ${CONFIDENCES.join(" | ")} (default medium)
  With "id", the note is updated. A new title, body or anchors also counts as a verification.
  {"id", "indexed": false} takes a note out of the session index. Without "id", a note with the same title in the same scope
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
  const archived = store.notes({ archived: true });

  // Update: merge the given fields over the stored note.
  if (typeof input.id === "string") {
    const existing = active.find((n) => n.id === input.id);
    if (!existing) throw new KbError(`no active note with id "${input.id}"`);
    if (input.scope !== undefined && resolveScopeInput(input.scope, repo.scope) !== existing.scope) {
      throw new KbError("a note cannot change scope. Archive it and add a new one.");
    }
    const updated = updateNote(store, input as Record<string, unknown> & { id: string }, repo);
    return { json: { status: "updated", ...updated }, text: `updated ${updated.id}` };
  }

  const scope = resolveScopeInput(input.scope, repo.scope);
  if (typeof input.title !== "string" || !input.title.trim()) throw new KbError("invalid note: title: required");
  const slug = slugify(input.title);
  if (!slug) throw new KbError("invalid note: title: needs letters or digits");

  // Same normalised title in the same scope: let the caller decide to update.
  const title = normalizeTitle(input.title);
  const twin = active.find((n) => n.scope === scope && (normalizeTitle(n.title) === title || n.id === title));
  if (twin) return { json: { status: "exists", id: twin.id, path: twin.path }, text: `exists ${twin.id}` };

  const raw: Record<string, unknown> = {
    confidence: "medium",
    indexed: true,
    anchors: [],
    ...input,
    id: uniqueId(slug, new Set([...active, ...archived].map((n) => n.id))),
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

function cmdShow(store: Store, args: Args): Output {
  const id = args.positional[0];
  if (!id) throw new KbError("usage: kb show <id>");
  const note = requireNote(store, id);
  const usage = store.usage().get(id) ?? { uses: 0 };
  const header = `# ${relative(store.home, note.path)} | uses ${usage.uses}${usage.last_used ? `, last used ${usage.last_used}` : ""}`;
  return { json: { ...note, ...usage }, text: `${header}\n${readFileSync(note.path, "utf8").trimEnd()}` };
}

function cmdSearch(store: Store, args: Args): Output {
  const query = args.positional.join(" ");
  if (!query) throw new KbError("usage: kb search <words> [--scope s] [--archive]");
  const scope = args.flags.get("scope");
  const { hits, complete } = searchNotes(store, query, { scope: typeof scope === "string" ? scope : undefined, archive: args.flags.has("archive") });
  const rows = hits.map((h) => `${h.id}${h.archived ? " (archived)" : ""} | ${h.title} | ${h.line}: ${h.text}`);
  const text = hits.length === 0 ? "no match" : [...(complete ? [] : ["no note has every word. Closest:"]), ...rows].join("\n");
  return { json: hits, text };
}

function cmdList(store: Store, args: Args): Output {
  const scope = args.flags.get("scope");
  const usage = store.usage();
  const notes = rank(
    store.notes({ archived: args.flags.has("archive") }).filter((n) => typeof scope !== "string" || n.scope === scope),
    usage,
  );
  const rows = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    scope: n.scope,
    title: n.title,
    uses: usage.get(n.id)?.uses ?? 0,
    last_used: usage.get(n.id)?.last_used ?? null,
    last_verified: n.last_verified,
    confidence: n.confidence,
    indexed: n.indexed,
    promoted_to: n.promoted_to ?? null,
  }));
  const width = (key: "id" | "kind" | "scope") => Math.max(key.length, ...rows.map((r) => r[key].length));
  const [wId, wKind, wScope] = [width("id"), width("kind"), width("scope")];
  const line = (id: string, kind: string, scope: string, uses: string, verified: string, title: string) =>
    `${id.padEnd(wId)}  ${kind.padEnd(wKind)}  ${scope.padEnd(wScope)}  ${uses.padStart(4)}  ${verified.padEnd(10)}  ${title}`;
  const text =
    rows.length === 0
      ? "no notes"
      : [line("id", "kind", "scope", "uses", "verified", "title"), ...rows.map((r) => line(r.id, r.kind, r.scope, String(r.uses), r.last_verified.slice(0, 10), r.title))].join("\n");
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

function cmdMove(store: Store, args: Args, toArchive: boolean): Output {
  const verb = toArchive ? "archive" : "restore";
  if (args.positional.length === 0) throw new KbError(`usage: kb ${verb} <id>...`);
  const moved = moveNotes(store, args.positional, toArchive);
  return { json: { [toArchive ? "archived" : "restored"]: moved }, text: `${toArchive ? "archived" : "restored"} ${moved.join(", ")}` };
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
    if (note.archived) throw new KbError(`${id} is archived. Restore it first.`);
    if (note.scope !== "global" && note.scope !== repo.scope) throw new KbError(`${id} belongs to ${note.scope}. Run kb verify inside that repo, so the commit is recorded.`);
    return note;
  });
  const now = nowIso();
  for (const { path: _path, archived: _archived, ...note } of notes) {
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
  const lines = [
    `scope    ${b.scope ?? "global only"}`,
    `index    ${b.index.lines} of ${b.index.budget} lines${b.index.hidden > 0 ? `, ${b.index.hidden} hidden` : ""}`,
    `context  ${b.context.chars} of ${b.context.budget} characters, ${b.context.bodies} bodies shown, ${b.context.dropped} in the index only`,
    b.over ? `demote first: ${b.demote.map((d) => `${d.id} (${d.reason})`).join(", ") || "nothing but open work is left"}` : "within both budgets",
  ];
  return { json: b, text: lines.join("\n") };
}

const PROMOTE_FILES = ["CLAUDE.md", "AGENTS.md"];

function cmdPromote(store: Store, args: Args): Output {
  const id = args.positional[0];
  const to = args.flags.get("to");
  if (!id || typeof to !== "string" || !PROMOTE_FILES.includes(to)) throw new KbError("usage: kb promote <id> --to CLAUDE.md|AGENTS.md [--dry-run] [--repo .]");
  const repo = resolveRepo(String(args.flags.get("repo") ?? "."), store);
  const { path: _path, archived, ...note } = requireNote(store, id);
  if (archived) throw new KbError(`${id} is archived. Restore it first.`);
  if (note.promoted_to) throw new KbError(`${id} is already in ${note.promoted_to}`);
  if (!repo.root || note.scope !== repo.scope) throw new KbError(`${id} belongs to ${note.scope}. Run kb promote inside that repo.`);

  const file = join(repo.root, to);
  const marker = `<!-- kb: ${note.id} -->`;
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (before.includes(marker)) throw new KbError(`${to} already has ${note.id}`);
  const gap = before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const addition = `${gap}${marker}\n## ${note.title}\n\n${note.body}\n`;
  const dryRun = args.flags.has("dry-run");
  if (!dryRun) {
    // The one write kb ever makes inside a repo. The caller asks the user first.
    appendFileSync(file, addition);
    note.promoted_to = to;
    store.writeNote(note);
    afterWrite(store, `kb: promote ${note.id} to ${to}`);
  }
  return { json: { id: note.id, file, written: !dryRun, addition }, text: dryRun ? `would append to ${file}:\n${addition.trimEnd()}` : `promoted ${note.id} to ${file}` };
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
    // A person who types only `kb` in a terminal wants to see the notes. A script gets the help.
    if (!command && process.stdout.isTTY && store.exists()) await cmdServe(store, args, json);
    if (!command || command === "help" || args.flags.has("help")) {
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
      case "archive": out = cmdMove(store, args, true); break;
      case "restore": out = cmdMove(store, args, false); break;
      case "stale": out = cmdStale(store, args); break;
      case "verify": out = cmdVerify(store, args); break;
      case "budget": out = cmdBudget(store, args); break;
      case "promote": out = cmdPromote(store, args); break;
      case "checkpointed": out = cmdCheckpointed(store, args); break;
      case "serve": out = await cmdServe(store, args, json); break;
      case "html": throw new KbError("kb html is gone. Run `kb serve`: the same page, and it can edit and archive notes.");
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
