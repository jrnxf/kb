// Where each repo is checked out, so the page can start an audit for a repo with no session open.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { mainCheckout } from "./scope.ts";
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
 * True when `root` is a linked worktree of the checkout at `main`. A linked worktree has a file
 * `.git` that names its git dir, `<main>/.git/worktrees/<name>`. Reading it starts no git process.
 */
function worktreeOf(root: string, main: string): boolean {
  try {
    const gitDir = /^gitdir: (.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"))?.[1];
    return gitDir !== undefined && realpathSync(resolve(root, gitDir, "..", "..")) === join(main, ".git");
  } catch {
    return false; // a main checkout, where `.git` is a folder, or a git dir that is gone
  }
}

/**
 * Remember where each repo is checked out, so the page can start an audit for a repo that has no
 * session open, and a recovery can write the notes of a session whose folder is gone. Every
 * session start calls this. It writes only when the path changes.
 *
 * A start in a linked worktree remembers the main checkout of the repo, while that is on disk:
 * the worktree of a finished run is often deleted, and the main checkout stays. Once kb has
 * the main checkout, a start in one of its worktrees costs one read of a file and no git call.
 */
export function rememberRepo(store: Store, scope: string, root: string): void {
  const repos = read(store);
  const known = repos[scope];
  if (known === root || (known !== undefined && worktreeOf(root, known))) return;
  const main = mainCheckout(root);
  const place = main !== root && existsSync(main) ? main : root;
  if (repos[scope] === place) return;
  try {
    writeAtomic(store.statePath(REPOS), `${JSON.stringify({ ...repos, [scope]: place }, null, 2)}\n`);
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


/** The checkout of `scope` goes to its new id, for a scope move. A checkout that `to` has already stays. */
export function moveRepo(store: Store, from: string, to: string): void {
  const repos = read(store);
  if (!(from in repos)) return;
  const { [from]: root, ...rest } = repos;
  try {
    writeAtomic(store.statePath(REPOS), `${JSON.stringify({ ...rest, [to]: rest[to] ?? root }, null, 2)}\n`);
  } catch {
    // the page only offers no Audit button for this repo until the next session start
  }
}

/**
 * The scopes that another checkout uses. This checkout is the one that `scope` has on record,
 * else `root`. A scope whose checkout is this one, or is gone from disk, is not in the set.
 */
export function scopesElsewhere(store: Store, scope: string, root: string | null): Set<string> {
  const repos = read(store);
  const here = repos[scope] ?? root;
  return new Set(Object.entries(repos).filter(([other, path]) => other !== scope && path !== here && existsSync(path)).map(([other]) => other));
}
