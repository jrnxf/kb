// Scope resolution: which repo id does a directory belong to?

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { slugify } from "./note.ts";
import { git, type Store } from "./store.ts";

export interface RepoInfo {
  /** Repo id, or null when the path is not inside a git repo. */
  scope: string | null;
  root: string | null;
  head: string | null;
}

/**
 * Turn a remote URL into host/owner/name, so SSH and HTTPS clones match.
 * Returns null when the URL has no host (a local path remote).
 */
export function normalizeRemote(url: string): string | null {
  let rest = url.trim();
  if (!rest) return null;
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest);
  if (hasProtocol) {
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    if (url.toLowerCase().startsWith("file://")) return null;
  } else if (!/^[^/@]+@[^/:]+:/.test(rest) && !/^[^/:]+\.[^/:]+:/.test(rest)) {
    return null; // a plain filesystem path
  }
  rest = rest.replace(/^[^/@]+@/, ""); // user@
  if (hasProtocol) rest = rest.replace(/^([^/:]+):\d+\//, "$1/"); // host:port/
  else rest = rest.replace(/^([^/:]+):/, "$1/"); // scp form host:path
  rest = rest.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/{2,}/g, "/").toLowerCase();
  const parts = rest.split("/").map((part) => part.replace(/[^a-z0-9._~-]/g, "-")).filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

/**
 * Resolve the scope for a path.
 * With an origin remote: the normalised remote. Without one: the directory name of the main
 * checkout (worktrees share it), recorded in local.json so the id can be pinned after a rename.
 * `record: false` reads local.json and never writes it: a hook on every Read must not add an alias
 * for each scratch repo the agent looks at.
 */
export function resolveRepo(path: string, store: Store, options: { record?: boolean } = {}): RepoInfo {
  const none: RepoInfo = { scope: null, root: null, head: null };
  const top = git(path, "rev-parse", "--show-toplevel");
  if (!top.ok || !top.out) return none;
  const root = top.out;
  const headResult = git(root, "rev-parse", "--short", "HEAD");
  const head = headResult.ok ? headResult.out : null;

  const remote = git(root, "config", "--get", "remote.origin.url");
  const fromRemote = remote.ok ? normalizeRemote(remote.out) : null;
  if (fromRemote) return { scope: fromRemote, root, head };

  // No usable remote. All worktrees share one common git dir, so key on the main checkout.
  const common = git(root, "rev-parse", "--git-common-dir");
  let main = root;
  if (common.ok && common.out) {
    const commonDir = resolve(root, common.out);
    if (basename(commonDir) === ".git") main = dirname(commonDir);
  }
  try {
    main = realpathSync(main);
  } catch {
    // keep the unresolved path
  }

  const local = store.local();
  const known = local.aliases[main];
  if (known) return { scope: known, root, head };
  const scope = slugify(basename(main)) || "repo";
  if (store.exists() && options.record !== false) {
    local.aliases[main] = scope;
    try {
      store.saveLocal(local);
    } catch {
      // the alias is a convenience, never a reason to fail
    }
  }
  return { scope, root, head };
}
