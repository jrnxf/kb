import type { AuditData, AuditPick, AuditResult, AuditRunState, NoteEdit, PageData } from "../../../cli/wire.ts";

// The key that lets the page change notes. `kb serve` prints the page's link with the key in the
// fragment (#token=...), as Jupyter does. The page keeps it in this browser and takes it out of the
// address. A page opened without it reads, and says how to get the key.

const KEY = "kb-token";

function kept(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Take the key from the address, keep it, and leave the rest of the address alone. Runs before the page reads its view. */
function takeKey(): string {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fresh = params.get("token");
  if (fresh === null) return kept();
  params.delete("token");
  const rest = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  try {
    localStorage.setItem(KEY, fresh);
  } catch {
    // the key lasts until the page closes
  }
  return fresh;
}

let token = takeKey();
// A link pasted into a tab that shows the page already changes only the fragment, and loads nothing.
// popstate comes first, before the page writes its view back into the address.
for (const event of ["popstate", "hashchange"]) {
  addEventListener(event, () => {
    if (new URLSearchParams(location.hash.replace(/^#/, "")).has("token")) token = takeKey();
  });
}

/** Shown when the server does not answer, in place of the browser's own "Failed to fetch". */
export const OFFLINE = "kb serve is not running. Start it with `kb serve`, and the page reconnects.";

async function call<T>(method: string, path: string, body?: unknown, again = true): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "content-type": "application/json", "x-kb-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(OFFLINE);
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  // Another tab may have opened a newer link since this page loaded. Its key is in this browser too.
  if (response.status === 403 && again && kept() && kept() !== token) {
    token = kept();
    return call(method, path, body, false);
  }
  if (!response.ok) throw new Error(data.error || `kb answered ${response.status}`);
  return data as T;
}

export const loadPage = () => call<PageData>("GET", "/api/page");

/** The version of the store, and whether this page's key lets it change notes. */
export function storeState(): Promise<{ version: string; write: boolean }> {
  if (kept() && kept() !== token) token = kept();
  return call<{ version: string; write: boolean }>("GET", "/api/state");
}

export const saveNote = (id: string, edit: NoteEdit) => call("PUT", `/api/notes/${id}`, edit);
export const trashNote = (id: string) => call("POST", `/api/notes/${id}/trash`);
export const deleteNote = (id: string) => call("DELETE", `/api/notes/${id}`);
/** Without a scope, the whole trash. With one, only the trash of that project. */
export const emptyTrash = (scope?: string) => call<{ deleted: string[] }>("POST", "/api/trash/empty", scope === undefined ? undefined : { scope });
export const trashProject = (scope: string) => call<{ trashed: string[] }>("POST", "/api/projects/trash", { scope });
export const restoreProject = (scope: string) => call<{ restored: string[] }>("POST", "/api/projects/restore", { scope });
export const restoreNote = (id: string) => call("POST", `/api/notes/${id}/restore`);

export const loadAudit = (scope: string) => call<AuditData>("GET", `/api/audit?scope=${encodeURIComponent(scope)}`);
/** One agent audits the repo in its checkout. The page data says when its cards are ready. */
export const startAudit = (scope: string) => call<AuditRunState>("POST", "/api/audit/start", { scope });
export const applyAudit = (scope: string, picks: AuditPick[]) => call<AuditResult>("POST", "/api/audit/apply", { scope, picks });
