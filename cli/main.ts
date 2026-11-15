#!/usr/bin/env bun
// kb: a personal knowledge store for coding agents. Harness-agnostic: flags and stdin only.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { buildContext, rank } from "./context.ts";
import { htmlPath, writeHtml } from "./html.ts";
import { CONFIDENCES, KINDS, KbError, type Note, isValidScope, normalizeTitle, slugify, validateNote } from "./note.ts";
import { resolveRepo } from "./scope.ts";
import { search } from "./search.ts";
import { Store, type StoredNote } from "./store.ts";
import { kickSync, syncNow } from "./sync.ts";

const USAGE = `kb - a personal knowledge store for coding agents

  kb context [--repo .]                  text for a session start: index, top notes, pointer
  kb add [--repo .]                      create or update a note from JSON on stdin
  kb show <id>                           print one note
  kb search <query> [--scope s] [--archive]
  kb list [--scope s] [--archive]        every note with kind, uses and verified date
  kb use <id>...                         record that these notes changed what you did
  kb archive <id>... | kb restore <id>...
  kb scope [--repo .]                    print the scope id of a directory
  kb html [--no-open]                    write the overview page and open it
  kb sync                                commit, pull and push the store

Every command accepts --json. The store is ~/.kb, or KB_HOME.

kb add reads: {"title", "kind", "body", "scope"?, "id"?, "anchors"?, "confidence"?, "indexed"?, "supersedes"?}
  scope: "repo" (the default inside a git repo), "global", or an explicit repo id
  kind: ${KINDS.join(" | ")}
  confidence: ${CONFIDENCES.join(" | ")} (default medium)
  With "id", the note is updated. Without it, a note with the same title in the same scope
  is not overwritten: the result is {"status": "exists", "id"}.`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["repo", "scope"]);

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

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Regenerate the derived files, commit, and start a background sync. */
function afterWrite(store: Store, message: string): void {
  store.writeIndex();
  writeHtml(store);
  if (store.commit(message)) kickSync(store);
}

function requireNote(store: Store, id: string): StoredNote {
  const note = store.find(id);
  if (!note) throw new KbError(`no note with id "${id}"`);
  return note;
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
    const { path: _path, archived: _archived, ...stored } = existing;
    const merged: Record<string, unknown> = { ...stored, ...input, scope: existing.scope, created: existing.created, last_verified: now };
    if (repo.scope === existing.scope && repo.head) merged.verified_at_commit = repo.head;
    const note = validateNote(merged);
    const path = store.writeNote(note);
    afterWrite(store, `kb: update ${note.id}`);
    return { json: { status: "updated", id: note.id, path }, text: `updated ${note.id}` };
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
  if (!query) throw new KbError("usage: kb search <query> [--scope s] [--archive]");
  const scope = args.flags.get("scope");
  const hits = search(store, query, { scope: typeof scope === "string" ? scope : undefined, archive: args.flags.has("archive") });
  const text = hits.length === 0 ? "no match" : hits.map((h) => `${h.id}${h.archived ? " (archived)" : ""} | ${h.title} | ${h.line}: ${h.text}`).join("\n");
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
    indexed: n.indexed,
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
  const moved: string[] = [];
  for (const id of args.positional) {
    const note = requireNote(store, id);
    if (note.archived === toArchive) throw new KbError(`${id} is already ${toArchive ? "archived" : "active"}`);
    store.move(note, toArchive);
    moved.push(id);
  }
  afterWrite(store, `kb: ${verb} ${moved.join(" ")}`);
  return { json: { [toArchive ? "archived" : "restored"]: moved }, text: `${toArchive ? "archived" : "restored"} ${moved.join(", ")}` };
}

function cmdHtml(store: Store, args: Args): Output {
  if (!store.exists()) throw new KbError("the store does not exist yet. `kb add` creates it.");
  const path = writeHtml(store);
  const open = !args.flags.has("no-open") && !args.flags.has("json");
  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    try {
      Bun.spawn([opener, path], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    } catch {
      // no opener on this machine: the path below is enough
    }
  }
  return { json: { path, opened: open }, text: path };
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
    if (!command || command === "help" || args.flags.has("help")) {
      console.log(USAGE);
      return 0;
    }
    const store = new Store();
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
      case "html": out = cmdHtml(store, args); break;
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
