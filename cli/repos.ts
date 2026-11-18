// Where each repo is checked out, so the page can start an audit for a repo with no session open.

import { existsSync, readFileSync } from "node:fs";
import { type Store, writeAtomic } from "./store.ts";

const REPOS = "repos.json";

function read(store: Store): Record<string, string> {
  try {
    return JSON.parse(readFileSync(store.statePath(REPOS), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Remember where each repo is checked out, so the page can start an audit for a repo that has no
 * session open. Every session start calls this. It writes only when the path changes.
 */
export function rememberRepo(store: Store, scope: string, root: string): void {
  const repos = read(store);
  if (repos[scope] === root) return;
  try {
    writeAtomic(store.statePath(REPOS), `${JSON.stringify({ ...repos, [scope]: root }, null, 2)}\n`);
  } catch {
    // the page only offers no Audit button for this repo
  }
}

/** The checkout of a repo, when it is still on disk. */
export function repoRoot(store: Store, scope: string): string | undefined {
  const root = read(store)[scope];
  return root && existsSync(root) ? root : undefined;
}

/** The scopes the page can audit: the global notes, and each repo with a checkout on disk. */
export function auditableScopes(store: Store): string[] {
  return ["global", ...Object.keys(read(store)).filter((scope) => scope !== "global" && repoRoot(store, scope)).sort()];
}

