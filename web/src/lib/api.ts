import type { NoteEdit, PageData } from "../../../cli/wire.ts";

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
export const archiveNote = (id: string) => call("POST", `/api/notes/${id}/archive`);
export const restoreNote = (id: string) => call("POST", `/api/notes/${id}/restore`);
