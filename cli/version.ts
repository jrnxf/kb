// The commit that kb runs from. Every commit on main is a release, so the commit is the version.

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git } from "./store.ts";

/** The folder of the plugin: the parent of cli/. */
const ROOT = join(import.meta.dir, "..");

export interface Version {
  /** The commit, 12 hex digits, or null when kb cannot tell. */
  commit: string | null;
  /** "plugin" for an installed plugin, "git" for a checkout. */
  from: "plugin" | "git" | null;
}

/**
 * Claude Code installs a plugin to a folder named after its commit:
 * <plugins>/cache/<marketplace>/kb/<12 hex digits>. A git checkout asks git. A checkout that has
 * changes that are not committed is still named by its HEAD.
 */
export function version(root = ROOT): Version {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // the folder name is enough
  }
  const name = basename(real);
  if (/^[0-9a-f]{12}$/.test(name) && basename(dirname(real)) === "kb") return { commit: name, from: "plugin" };
  // Only a checkout of kb itself: the plugin folder can sit inside another repo.
  const top = git(real, "rev-parse", "--show-toplevel");
  if (top.ok && realOf(top.out) === real) {
    const head = git(real, "rev-parse", "--short=12", "HEAD");
    if (head.ok && /^[0-9a-f]{12}$/.test(head.out)) return { commit: head.out, from: "git" };
  }
  return { commit: null, from: null };
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `kb 0123456789ab (pre-release)`, or `kb unknown (pre-release)`. */
export const versionText = (v: Version) => `kb ${v.commit ?? "unknown"} (pre-release)`;
