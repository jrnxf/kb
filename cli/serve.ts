// `kb serve`: the store as a local page, where a person can read, edit and archive notes.
// It listens on this machine only. The page is rendered again on every load.

import { randomBytes } from "node:crypto";
import { renderHtml, storeVersion } from "./html.ts";
import { KbError } from "./note.ts";
import type { Store } from "./store.ts";
import { moveNotes, requireNote, updateNote } from "./write.ts";

export const DEFAULT_PORT = 4810;

export interface Served {
  url: string;
  port: number;
  /** Every request that changes the store must carry this. Only the served page knows it. */
  token: string;
  stop(): void;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** The fields a person may change in the page. The rest of a note belongs to the CLI. */
const EDITABLE = ["title", "kind", "confidence", "body"] as const;

/**
 * Names a reverse proxy in front of the server may use, from KB_SERVE_HOSTS, split by commas.
 * Everybody who can open the page under such a name can change notes.
 */
function extraHosts(): string[] {
  return (process.env.KB_SERVE_HOSTS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

async function handle(store: Store, token: string, port: number, request: Request): Promise<Response> {
  const url = new URL(request.url);
  // A page on another site can point its own name at 127.0.0.1. The Host header gives that away.
  const host = request.headers.get("host") ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && !extraHosts().includes(host)) return json({ error: "wrong host" }, 403);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response(renderHtml(store, token), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (request.method === "GET" && url.pathname === "/api/state") return json({ kb: true, version: storeVersion(store) });

  const match = url.pathname.match(/^\/api\/notes\/([a-z0-9-]+)(?:\/(archive|restore))?$/);
  if (!match) return json({ error: "not found" }, 404);
  const [, id, action] = match as unknown as [string, string, "archive" | "restore" | undefined];

  if (request.method === "GET" && !action) {
    const { path: _path, ...note } = requireNote(store, id);
    return json(note);
  }
  // Another site cannot read the page, so it cannot know the token.
  if (request.headers.get("x-kb-token") !== token) return json({ error: "wrong token. Reload the page." }, 403);

  if (request.method === "POST" && action) {
    moveNotes(store, [id], action === "archive");
    return json({ id, archived: action === "archive" });
  }
  if (request.method === "PUT" && !action) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new KbError("the request needs one JSON object");
    const input: Record<string, unknown> & { id: string } = { id };
    for (const key of EDITABLE) if (key in body) input[key] = body[key];
    // An edit in the page is made outside any repo, so it records no commit.
    return json(updateNote(store, input, { scope: null, head: null }));
  }
  return json({ error: "not found" }, 404);
}

export function serve(store: Store, options: { port?: number } = {}): Served {
  const token = randomBytes(16).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    async fetch(request, self): Promise<Response> {
      try {
        return await handle(store, token, self.port!, request);
      } catch (error) {
        if (error instanceof KbError) return json({ error: error.message }, error.message.startsWith("no note") ? 404 : 400);
        return json({ error: `kb failed: ${(error as Error)?.message ?? error}` }, 500);
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, port: server.port!, token, stop: () => server.stop(true) };
}

/** True when a kb server already answers on this port. */
export async function isKbServer(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1000) });
    return ((await response.json()) as { kb?: boolean }).kb === true;
  } catch {
    return false;
  }
}
