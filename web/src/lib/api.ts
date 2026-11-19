import type { AuditData, AuditPick, AuditResult, AuditRunState, NoteEdit, PageData } from "../../../cli/wire.ts";

let token = "";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-kb-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || `kb answered ${response.status}`);
  return data as T;
}

export async function loadPage(): Promise<PageData> {
  const data = await call<PageData>("GET", "/api/page");
  token = data.token;
  return data;
}

export async function storeVersion(): Promise<string> {
  return (await call<{ version: string }>("GET", "/api/state")).version;
}

export const saveNote = (id: string, edit: NoteEdit) => call("PUT", `/api/notes/${id}`, edit);
export const trashNote = (id: string) => call("POST", `/api/notes/${id}/trash`);
export const deleteNote = (id: string) => call("DELETE", `/api/notes/${id}`);
/** Without a scope, the whole trash. With one, only the trash of that project. */
export const emptyTrash = (scope?: string) => call<{ deleted: string[] }>("POST", "/api/trash/empty", scope === undefined ? undefined : { scope });
export const trashProject = (scope: string) => call<{ trashed: string[] }>("POST", "/api/projects/trash", { scope });
export const restoreProject = (scope: string) => call<{ restored: string[] }>("POST", "/api/projects/restore", { scope });
export const restoreNote = (id: string) => call("POST", `/api/notes/${id}/restore`);

export async function loadAudit(scope: string): Promise<AuditData> {
  const data = await call<AuditData>("GET", `/api/audit?scope=${encodeURIComponent(scope)}`);
  token = data.token;
  return data;
}
/** One agent audits the repo in its checkout. The page data says when its cards are ready. */
export const startAudit = (scope: string) => call<AuditRunState>("POST", "/api/audit/start", { scope });
export const applyAudit = (scope: string, picks: AuditPick[]) => call<AuditResult>("POST", "/api/audit/apply", { scope, picks });
