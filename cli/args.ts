// The flags of each command. A flag that the command does not know is an error, so a typo never
// runs the command as if the flag were not there.

import { KbError } from "./note.ts";

/** An error in how the command was called: nothing ran. Exit code 1, as for any error: 2 is an answer of `kb add`. */
export class UsageError extends KbError {}

export const USAGE_EXIT = 1;

export interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

/** "value" takes the next word, or the text after "=". "switch" takes nothing. */
type Kind = "value" | "switch";

/**
 * Every command takes these. --session and --repo also name the session and the scope that the
 * events of the command record in the log.
 */
const GLOBAL: Record<string, Kind> = { json: "switch", help: "switch", quiet: "switch", session: "value", repo: "value" };

/** The flags of each command, on top of GLOBAL. A command that is not here takes GLOBAL only. */
export const COMMAND_FLAGS: Record<string, Record<string, Kind>> = {
  add: { file: "value", "as-of": "value", "recovered-from": "value" },
  show: { check: "switch", "no-use": "switch" },
  search: { scope: "value", trash: "switch", check: "switch", "no-use": "switch" },
  list: { scope: "value", trash: "switch" },
  scope: { "dry-run": "switch" },
  trash: { scope: "value" },
  restore: { scope: "value" },
  delete: { scope: "value" },
  "empty-trash": { scope: "value" },
  audit: { file: "value", "no-wait": "switch" },
  checkpointed: { ended: "value" },
  log: { since: "value" },
  unsaved: { all: "switch", forget: "value" },
  serve: { port: "value", "no-open": "switch" },
};

/** The flags that `command` takes, by name. */
export function flagsOf(command: string | undefined): Record<string, Kind> {
  return { ...GLOBAL, ...(command ? COMMAND_FLAGS[command] : undefined) };
}

/** The number of single-letter edits between two words. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The known flags that `name` is most likely a typo of: all that are equally close, or none. */
function closest(name: string, known: string[]): string[] {
  const ranked = known.map((k) => ({ k, d: k.startsWith(name) || name.startsWith(k) ? 1 : distance(name, k) })).sort((a, b) => a.d - b.d || a.k.localeCompare(b.k));
  const best = ranked[0];
  if (!best || best.d > Math.max(1, Math.floor(name.length / 3))) return [];
  return ranked.filter((r) => r.d === best.d).map((r) => r.k);
}

/**
 * Split the words after the command into positional words and flags. `--` ends the flags: every
 * word after it is positional, so `kb search -- --force` searches for "--force".
 */
export function parseArgs(argv: string[], command?: string): Args {
  const known = flagsOf(command);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const where = command ? `kb ${command}` : "kb";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && !arg.startsWith("--") && arg !== "-") {
      throw new UsageError(`"${arg}" starts with one dash, and kb flags start with two: --${arg.slice(1)}. To use it as text, put it after --: kb ${command ?? "<command>"} -- ${arg}. Nothing ran.`);
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (name === "") throw new UsageError(`"${arg}" has no flag name. Nothing ran.`);
    const kind = Object.hasOwn(known, name) ? known[name] : undefined;
    if (kind === undefined) {
      const guess = closest(name, Object.keys(known));
      const hint = guess.length > 0 ? ` Did you mean ${guess.map((k) => `--${k}`).join(" or ")}?` : ` It takes: ${Object.keys(known).sort().map((k) => `--${k}`).join(", ")}.`;
      throw new UsageError(`unknown flag --${name} for ${where}.${hint} Nothing ran.`);
    }
    if (kind === "value") {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value. Nothing ran.`);
      flags.set(name, true);
    }
  }
  return { positional, flags };
}
