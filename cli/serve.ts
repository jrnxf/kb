// `kb serve`: the store as a local page, where a person can read, edit, trash and delete notes, and trash a project.
// It listens on this machine only. The page is the React app built into web/dist, and it reads
// the store from /api/page. Anyone who can reach the server can read. Only a page opened with the
// link that `kb serve` prints can write: the link carries the key, as a Jupyter link does.

import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join, normalize, sep } from "node:path";
import { applyAudit, auditData } from "./audit.ts";
import { startRun } from "./audit-run.ts";
import { KbError } from "./note.ts";
import { pageData, storeVersion } from "./page.ts";
import { repoRoot } from "./repos.ts";
import { type Store, writeAtomic } from "./store.ts";
import { deleteNotes, emptyTrash, moveNotes, requireNote, restoreProject, tidyTrash, trashProject, updateNote } from "./write.ts";

export const DEFAULT_PORT = 4810;

/** How often a running server clears the notes whose time in the trash is up. */
const TIDY_MS = 3_600_000;

/** The built page. It is committed, so the plugin needs no install step. */
export const DIST = join(import.meta.dir, "..", "web", "dist");

export interface Served {
  url: string;
  port: number;
  /** Every request that changes the store must carry this. Only the link knows it. */
  token: string;
  /** The page with the key in its fragment: the address to open. A fragment never reaches a server or a proxy log. */
  link: string;
  stop(): void;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** The answer to a change that comes without the key. The page shows it as it is. */
export const NO_KEY = "this page has no key to change notes. Open the link that `kb serve` printed.";

/** The fields a person may change in the page. The rest of a note belongs to the CLI. */
const EDITABLE = ["title", "kind", "confidence", "body"] as const;

/**
 * Names a reverse proxy in front of the server may use, from KB_SERVE_HOSTS, split by commas.
 * A name that starts with a dot, such as `.example.com`, takes that domain and every name under
 * it, the same as Vite's allowedHosts. Everybody who can open the page under such a name can
 * read the notes. Changing them still needs the key.
 */
function extraHosts(): string[] {
  return (process.env.KB_SERVE_HOSTS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

function allowedHost(host: string, port: number): boolean {
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return extraHosts().some((entry) => {
    entry = entry.toLowerCase();
    if (!entry.startsWith(".")) return host.toLowerCase() === entry;
    return name === entry.slice(1) || name.endsWith(entry);
  });
}

async function handle(store: Store, key: Key, port: number, request: Request): Promise<Response> {
  const url = new URL(request.url);
  // A page on another site can point its own name at 127.0.0.1. The Host header gives that away.
  const host = request.headers.get("host") ?? "";
  if (!allowedHost(host, port)) return json({ error: "wrong host" }, 403);

  // `write` tells the page whether its key is right, so it can say that it is read only.
  // `store` tells `kb serve` whether the server on a port serves the same store.
  if (request.method === "GET" && url.pathname === "/api/state") {
    return json({ kb: true, version: storeVersion(store), store: storeId(store), write: request.headers.get("x-kb-token") === key.token });
  }
  // No answer carries the key: a process that can reach the server can read, and cannot write.
  if (request.method === "GET" && url.pathname === "/api/page") {
    // A note whose time in the trash is up goes before the page shows it.
    tidy(store);
    keepToken(store, key);
    return json(pageData(store));
  }
  if ((request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")) return staticFile(url.pathname);

  // An audit: the agent's proposal as cards, and Apply, which makes the user's picks.
  if (request.method === "GET" && url.pathname === "/api/audit") return json(auditData(store, url.searchParams.get("scope") ?? ""));
  // The page's Audit button: one agent audits the repo in its checkout, and the page opens its cards.
  if (url.pathname === "/api/audit/start") {
    if (request.headers.get("x-kb-token") !== key.token) return json({ error: NO_KEY }, 403);
    if (request.method !== "POST") return json({ error: "not found" }, 404);
    const scope = (await body(request))?.scope;
    if (typeof scope !== "string") throw new KbError("scope: must be a repo id or global");
    // The global audit runs in an empty folder of its own, so it needs no checkout.
    if (scope === "global") return json(startRun(store, scope));
    const root = repoRoot(store, scope);
    if (!root) throw new KbError(`kb does not know where ${scope} is checked out. Start a session in it once, or run kb audit there.`);
    return json(startRun(store, scope, root));
  }
  if (url.pathname === "/api/audit/apply") {
    if (request.headers.get("x-kb-token") !== key.token) return json({ error: NO_KEY }, 403);
    if (request.method !== "POST") return json({ error: "not found" }, 404);
    const input = await body(request);
    if (typeof input?.scope !== "string") throw new KbError("scope: must be a repo id or global");
    return json(applyAudit(store, input.scope, input));
  }

  if (url.pathname === "/api/trash/empty") {
    if (request.headers.get("x-kb-token") !== key.token) return json({ error: NO_KEY }, 403);
    if (request.method !== "POST") return json({ error: "not found" }, 404);
    // With a scope, only the trash of that project: the list shows only its notes.
    const scope = (await body(request))?.scope;
    if (scope !== undefined && typeof scope !== "string") throw new KbError("scope: must be a repo id");
    return json({ deleted: emptyTrash(store, scope) });
  }

  // A project goes to the trash whole, and comes back whole. The page deletes it for good only from the trash.
  const project = url.pathname.match(/^\/api\/projects\/(trash|restore)$/);
  if (project) {
    if (request.headers.get("x-kb-token") !== key.token) return json({ error: NO_KEY }, 403);
    if (request.method !== "POST") return json({ error: "not found" }, 404);
    const scope = (await body(request))?.scope;
    if (typeof scope !== "string") throw new KbError("scope: must be a repo id");
    return json(project[1] === "trash" ? { scope, trashed: trashProject(store, scope) } : { scope, restored: restoreProject(store, scope) });
  }

  const match = url.pathname.match(/^\/api\/notes\/([a-z0-9-]+)(?:\/(trash|restore))?$/);
  if (!match) return json({ error: "not found" }, 404);
  const [, id, action] = match as unknown as [string, string, "trash" | "restore" | undefined];

  if (request.method === "GET" && !action) {
    const { path: _path, ...note } = requireNote(store, id);
    return json(note);
  }
  // Only the link that `kb serve` printed holds the key.
  if (request.headers.get("x-kb-token") !== key.token) return json({ error: NO_KEY }, 403);

  if (request.method === "POST" && action) {
    moveNotes(store, [id], action === "trash");
    return json({ id, trashed: action === "trash" });
  }
  if (request.method === "DELETE" && !action) {
    // The page deletes only from the trash. An active note goes to the trash first.
    if (!requireNote(store, id).trashed) return json({ error: `${id} is not in the trash` }, 400);
    return json({ deleted: deleteNotes(store, [id]) });
  }
  if (request.method === "PUT" && !action) {
    const edit = await body(request);
    if (edit === null) throw new KbError("the request needs one JSON object");
    const input: Record<string, unknown> & { id: string } = { id };
    for (const key of EDITABLE) if (key in edit) input[key] = edit[key];
    // An edit in the page is made outside any repo, so it records no commit.
    return json(updateNote(store, input, { scope: null, head: null }));
  }
  return json({ error: "not found" }, 404);
}

/** The JSON object a request carries, or null when it carries none. */
async function body(request: Request): Promise<Record<string, unknown> | null> {
  const value = (await request.json().catch(() => null)) as unknown;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The rules the browser keeps for the page: scripts, styles, images and requests come only from
 * this server, and no other site may frame it. So a note that gets script past the renderer still
 * cannot run it. The inline script of the page, which sets the theme before the first paint, runs
 * by its hash.
 */
export function pagePolicy(html: string): string {
  const hashes: string[] = [];
  let code: string | undefined;
  const flush = () => {
    if (code !== undefined) hashes.push(` 'sha256-${createHash("sha256").update(code.replace(/\r\n?/g, "\n")).digest("base64")}'`);
    code = undefined;
  };
  // A script with a src is no inline script. The browser hashes the text after its parser turns CRLF into LF.
  new HTMLRewriter()
    .on("script", {
      element(script) {
        flush();
        if (!script.hasAttribute("src")) code = "";
        script.onEndTag(flush);
      },
      text(chunk) {
        if (code !== undefined) code += chunk.text;
      },
    })
    .transform(html);
  flush();
  return [
    "default-src 'none'",
    `script-src 'self'${hashes.join("")}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Every answer of the server carries these. An answer that is not the page needs no rights at all. */
const SAFETY: Record<string, string> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function withSafety(response: Response): Response {
  for (const [name, value] of Object.entries(SAFETY)) if (!response.headers.has(name)) response.headers.set(name, value);
  return response;
}

/** The page and its policy, worked out again only when the file changes. The file is small, so each request reads it, and a copy that keeps the times is still seen. */
let cached: { html: string; policy: string } | undefined;

async function indexPage(): Promise<{ html: string; policy: string } | undefined> {
  const file = Bun.file(join(DIST, "index.html"));
  if (!(await file.exists())) return undefined;
  const html = await file.text();
  if (cached?.html !== html) cached = { html, policy: pagePolicy(html) };
  return cached;
}

/** The page at /, and the files of the built page. The page keeps its view in the hash, so it has no other paths. */
async function staticFile(pathname: string): Promise<Response> {
  if (pathname === "/") {
    const page = await indexPage();
    if (!page) return json({ error: "the page is not built. Run `bun run build` in web/." }, 500);
    return new Response(page.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": page.policy } });
  }
  let name: string;
  try {
    name = decodeURIComponent(pathname);
  } catch {
    return json({ error: "bad path" }, 400);
  }
  const path = normalize(join(DIST, name));
  const file = Bun.file(path);
  if (!path.startsWith(DIST + sep) || path.endsWith(sep + "index.html") || !(await file.exists())) return json({ error: "not found" }, 404);
  // Vite puts a hash of the content in each asset's name, so an asset never changes.
  const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(file, { headers: { "cache-control": cache } });
}

/** Clear the trash. An error waits for the next turn, and never stops the page. */
function tidy(store: Store): void {
  try {
    tidyTrash(store);
  } catch {
    // the next turn tries again
  }
}

/** Names the store without saying where it is: a proxy can show /api/state to people other than the user. */
export const storeId = (store: Store) => Bun.hash(store.home).toString(36);

const TOKEN_FILE = "serve-token";

/**
 * The key to change notes, kept from the last start. It stays the same across restarts, so an open
 * page keeps working after a plugin update restarts the server. Only the user can read the file.
 * A running server reads the file once, so to revoke a key, delete the file and restart.
 */
export function serveToken(store: Store): string | undefined {
  try {
    return readFileSync(store.statePath(TOKEN_FILE), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The key of a running server: the one in memory, and whether it is in the file yet. */
interface Key {
  token: string;
  kept: boolean;
}

/**
 * Keep the key for the next start, once, when the store exists. A store that does not exist yet
 * gets no file: a folder in its place would stop a `git clone` into it. The file is made with a
 * link, which fails when it exists, so two servers of one store end up with the same key: the
 * server that comes second takes the key that is in the file.
 */
function keepToken(store: Store, key: Key): void {
  if (key.kept || !store.exists()) return;
  const path = store.statePath(TOKEN_FILE);
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${key.token}\n`, { mode: 0o600 });
    try {
      linkSync(temp, path);
    } catch (error) {
      if ((error as { code?: string })?.code !== "EEXIST") throw error;
      key.token = serveToken(store) ?? key.token;
    }
    key.kept = true;
  } catch {
    // the key lasts until the server stops
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // no temporary file to remove
    }
  }
}

function makeKey(store: Store): Key {
  const token = serveToken(store);
  const key = { token: token ?? randomBytes(16).toString("hex"), kept: token !== undefined };
  keepToken(store, key);
  return key;
}

/** The page's address with the key in its fragment. */
export const linkWithKey = (url: string, token: string) => `${url}${url.includes("#") ? "&" : "#"}token=${token}`;

/** The answer to a request. An error becomes an answer too. */
async function answer(store: Store, key: Key, port: number, request: Request): Promise<Response> {
  try {
    return await handle(store, key, port, request);
  } catch (error) {
    if (error instanceof KbError) return json({ error: error.message }, error.message.startsWith("no note") ? 404 : 400);
    return json({ error: `kb failed: ${(error as Error)?.message ?? error}` }, 500);
  }
}

export function serve(store: Store, options: { port?: number } = {}): Served {
  const key = makeKey(store);
  tidy(store);
  const timer = setInterval(() => tidy(store), TIDY_MS);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    async fetch(request, self): Promise<Response> {
      return withSafety(await answer(store, key, self.port!, request));
    },
  });
  // `kb audit` reads this to link to the server that is up, also one started with --port.
  try {
    if (store.exists()) writeAtomic(store.statePath(SERVE_FILE), `${JSON.stringify({ port: server.port })}\n`);
  } catch {
    // the link falls back to the default port
  }
  const url = `http://127.0.0.1:${server.port}/`;
  return { url, link: linkWithKey(url, key.token), port: server.port!, token: key.token, stop: () => {
    clearInterval(timer);
    server.stop(true);
  } };
}

const SERVE_FILE = "serve.json";

/** The port of the kb server that is up now, from what the last `kb serve` recorded. */
export async function runningPort(store: Store): Promise<number | undefined> {
  try {
    const { port } = JSON.parse(readFileSync(store.statePath(SERVE_FILE), "utf8")) as { port?: unknown };
    if (typeof port === "number" && (await isKbServer(port))) return port;
  } catch {
    // no record
  }
  return undefined;
}

/**
 * An address of the running server on this port, with the key when the key in the store's file
 * is the one the server uses. The server says so in `write`. A server that was started before the
 * file existed, or before the file was deleted, has another key, and the page opens read only.
 */
export async function linkToRunning(store: Store, port: number, hash = ""): Promise<{ link: string; keyed: boolean }> {
  const link = `http://127.0.0.1:${port}/${hash}`;
  const token = serveToken(store);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-kb-token": token ?? "" }, signal: AbortSignal.timeout(1000) });
    if (token && ((await response.json()) as { write?: boolean }).write === true) return { link: linkWithKey(link, token), keyed: true };
  } catch {
    // no server answers
  }
  return { link, keyed: false };
}

/** True when a kb server already answers on this port. */
export async function isKbServer(port: number): Promise<boolean> {
  return (await kbServerAt(port)) !== undefined;
}

/** The kb server that answers on this port, with the id of its store, or undefined. */
export async function kbServerAt(port: number): Promise<{ store?: string } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1000) });
    const state = (await response.json()) as { kb?: boolean; store?: string };
    return state.kb === true ? { store: state.store } : undefined;
  } catch {
    return undefined;
  }
}
