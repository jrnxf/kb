// The store on disk: paths, config, notes, generated files and git.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { foldOldCounters } from "./log.ts";
import { KINDS, KbError, type Note, parseNote, serializeNote } from "./note.ts";

export interface Config {
  /**
   * contextChars: the characters a session start may take, the one hard limit of the index.
   * briefChars: the characters the open-work briefs may take of them.
   */
  budgets: { contextChars: number; briefChars: number };
  /** HOLDBACK: the share of session starts that keep the old policy for bodies, 0 to 1. 0 turns it off. */
  holdback: number;
  decayDays: number;
  /** A note with no activity and no check for this many days has expired. The audit proposes trash for it. */
  expireDays: number;
  /** A note in the trash for longer than this is deleted for good. */
  trashDays: number;
  autocommit: boolean;
  /** Per machine: local.json wins, and kb.config.json is the fallback. */
  sync: boolean;
  /** Per machine, as above. The user's global instructions file, which a global audit moves rules into. A leading ~ is the home folder. */
  globalInstructions: string;
}

/**
 * The keys that differ per machine. They live in local.json, which is never synced. A machine
 * copies a valid value out of kb.config.json once per store (local.json then holds `pinned`), and
 * the shared file keeps the value for a machine that runs an older kb.
 */
export const MACHINE_KEYS = ["sync", "globalInstructions"] as const;
type MachineKey = (typeof MACHINE_KEYS)[number];

export interface Local extends Partial<Pick<Config, MachineKey>> {
  /** True once this machine has copied the per-machine keys of kb.config.json. */
  pinned?: boolean;
  machine: string;
  aliases: Record<string, string>;
}

export interface StoredNote extends Note {
  path: string;
  trashed: boolean;
}

/**
 * SessionStart output above 10,000 characters is replaced by a file preview, so stay well under it.
 * The hook adds lines of its own after the context, and drops a notice that would pass the limit.
 */
export const HARD_CONTEXT_CAP = 8800;

/** A count of days from the config: a number of 1 or more, else the default. */
const days = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : fallback);

/** A number from the config between two bounds, else the default. */
const within = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

const DEFAULT_CONFIG: Config = {
  budgets: { contextChars: 8000, briefChars: 1500 },
  holdback: 0.1,
  decayDays: 180,
  expireDays: 90,
  trashDays: 30,
  autocommit: true,
  sync: true,
  globalInstructions: "~/.claude/CLAUDE.md",
};

/** The keys of the first kb.config.json. An older kb wrote all of them into every new store. */
const FIRST_KEYS = ["budgets", "decayDays", "autocommit", "sync"];

/** Budgets that an older kb wrote and that this version ignores, with the default that it wrote. */
const DEAD_BUDGETS: Record<string, number> = { indexLines: 60, globalIndexLines: 20 };

/** A value that a per-machine key may hold. Anything else is a mistake, and the next source speaks. */
const validMachine: { [K in MachineKey]: (value: unknown) => value is Config[K] } = {
  sync: (value): value is boolean => typeof value === "boolean",
  globalInstructions: (value): value is string => typeof value === "string" && value !== "",
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A config that an older kb wrote whole, without the keys whose value is the default. Each default
 * that kb ever shipped is the default of today, so a value equal to it changes nothing now. The
 * cost: a user who typed a default on purpose no longer holds it when a later kb changes it.
 * A dead budget that differs from its old default stays, because an older kb still reads it.
 */
export function withoutDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "budgets" && value && typeof value === "object" && !Array.isArray(value)) {
      const budgets = Object.fromEntries(
        Object.entries(value).filter(([name, v]) => !same(v, name in DEAD_BUDGETS ? DEAD_BUDGETS[name] : DEFAULT_CONFIG.budgets[name as keyof Config["budgets"]])),
      );
      if (Object.keys(budgets).length > 0) kept.budgets = budgets;
    } else if (!(key in DEFAULT_CONFIG) || !same(value, DEFAULT_CONFIG[key as keyof Config])) {
      kept[key] = value;
    }
  }
  return kept;
}

const LOCAL_LOCK_WAIT_MS = 2000;
const LOCAL_LOCK_STALE_MS = 10_000;

const GITIGNORE = ["INDEX.md", "index.html", "local.json", ".sync-*", "*.tmp-*", ".state/"];

/** A path with a leading `~` for the home folder, as a config or a shell command writes it. */
export const tilde = (path: string) => (path === "~" || path.startsWith("~/") ? join(userHome(), path.slice(1)) : path);

/** The user's home folder, as an absolute path without a trailing slash. HOME wins, as in a shell. */
export const userHome = (env: Record<string, string | undefined> = process.env) => resolve(env.HOME || homedir());

/** The store's folder, always absolute: an agent that kb starts runs in another folder. */
export function kbHome(): string {
  return resolve(process.env.KB_HOME || join(userHome(), ".kb"));
}

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** With `mode`, the file gets those permissions, for text that only the user may read. */
export function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, content, mode === undefined ? undefined : { mode });
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export class Store {
  constructor(readonly home: string = kbHome()) {}

  exists(): boolean {
    return existsSync(join(this.home, "notes"));
  }

  /** Create the store layout. Only commands that write call this. */
  ensure(): void {
    for (const dir of ["notes", "trash"]) mkdirSync(join(this.home, dir), { recursive: true });
    this.tidyConfig();
    foldOldCounters(this); // counters of an older kb go into the roll-up, before any command reads the ids
    const ignorePath = join(this.home, ".gitignore");
    // Add lines that a store made by an older version lacks.
    const have = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
    const missing = GITIGNORE.filter((line) => !have.split("\n").includes(line));
    if (missing.length > 0) writeAtomic(ignorePath, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }

  /** Per-machine state that is never committed: session marks, the stale cache and the event log. */
  statePath(name: string): string {
    return join(this.home, ".state", name);
  }

  private configPath(): string {
    return join(this.home, "kb.config.json");
  }

  /** The synced config as the file has it. A file that is not a JSON object counts as empty. */
  private sharedConfig(): Record<string, unknown> {
    const raw = readJson<unknown>(this.configPath());
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  /**
   * Called by ensure(), so a read never writes. kb.config.json holds only the keys that the user
   * set: a file that an older kb wrote whole (every default key) loses the keys whose value is the
   * default. The per-machine keys stay in the shared file, because a machine that still runs an older
   * kb reads them there. This machine copies valid ones into local.json once.
   */
  private tidyConfig(): void {
    const raw = this.sharedConfig();
    this.pinMachineKeys(raw);
    if (!FIRST_KEYS.every((key) => key in raw)) return;
    const kept = withoutDefaults(raw);
    if (!same(kept, raw)) writeAtomic(this.configPath(), `${JSON.stringify(kept, null, 2)}\n`);
  }

  /**
   * Once per store, copy each valid per-machine key of kb.config.json that differs from the default
   * into local.json, so a later pull of that file cannot change it on this machine. A key that
   * local.json has wins. A globalInstructions file that does not exist on this machine stays out,
   * because it is the path of another machine. The copy sets `pinned`, and after that nothing is
   * copied again: a key that the user deletes from local.json does not come back, and a later change
   * of the shared file reaches this machine through the fallback in config(). Where there is nothing
   * to copy, nothing is written. This runs in ensure(), never in a read, and it merges into the
   * file as it is now.
   */
  private pinMachineKeys(shared: Record<string, unknown>): void {
    const local = this.local();
    if (local.pinned) return;
    const copy = MACHINE_KEYS.filter((key) => {
      const value = shared[key];
      if (key in local || !validMachine[key](value) || same(value, DEFAULT_CONFIG[key])) return false;
      return key !== "globalInstructions" || existsSync(tilde(value as string));
    });
    if (copy.length === 0) return;
    this.updateLocal((fresh) => {
      if (fresh.pinned) return;
      for (const key of copy) if (!(key in fresh)) Object.assign(fresh, { [key]: shared[key] });
      fresh.pinned = true;
    });
  }

  config(): Config {
    const shared = this.sharedConfig() as Partial<Config>;
    const local = this.local();
    // Per key, the first valid value wins: local.json, then the shared file (as a machine that runs
    // an older kb reads it), then the default. A wrong or empty value never hides a valid one.
    const machine = <K extends MachineKey>(key: K): Config[K] =>
      ([local[key], shared[key]] as unknown[]).find((value): value is Config[K] => validMachine[key](value)) ?? DEFAULT_CONFIG[key];
    const { sync: _sync, globalInstructions: _file, ...raw } = shared;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sync: machine("sync"),
      globalInstructions: machine("globalInstructions"),
      // Only these budgets are read. Any other key is ignored.
      budgets: {
        contextChars: within(raw.budgets?.contextChars, 0, Infinity, DEFAULT_CONFIG.budgets.contextChars),
        // 0 is a choice: no briefs, so open work is in the index only.
        briefChars: within(raw.budgets?.briefChars, 0, Infinity, DEFAULT_CONFIG.budgets.briefChars),
      },
      // HOLDBACK: a share that is not a number from 0 to 1 is a mistake, so the default holds.
      holdback: within(raw.holdback, 0, 1, DEFAULT_CONFIG.holdback),
      // A wrong value must not empty the trash, expire every note or stop every command.
      trashDays: days(raw.trashDays, DEFAULT_CONFIG.trashDays),
      decayDays: days(raw.decayDays, DEFAULT_CONFIG.decayDays),
      expireDays: days(raw.expireDays, DEFAULT_CONFIG.expireDays),
    };
  }

  /** Per-machine state. It is never committed, because paths and machine ids differ per machine. */
  local(): Local {
    const raw = readJson<Partial<Local>>(join(this.home, "local.json")) ?? {};
    return { ...raw, machine: raw.machine ?? "", aliases: { ...raw.aliases } };
  }

  saveLocal(local: Local): void {
    writeAtomic(join(this.home, "local.json"), `${JSON.stringify(local, null, 2)}\n`);
  }

  /**
   * Change local.json: take a lock, read the file as it is now, apply `change`, write it
   * atomically. Hooks start at once, so two of them must not both read the old file and lose one
   * write. The lock is a folder in .state/ that a waiter retries for up to two seconds. A lock that
   * is older than ten seconds is stale and goes. If the lock stays taken, the change goes ahead
   * without it, because a hook must never fail over a convenience.
   */
  updateLocal(change: (local: Local) => void): Local {
    const lock = this.statePath("local-lock");
    mkdirSync(dirname(lock), { recursive: true });
    let held = false;
    for (const start = Date.now(); !held && Date.now() - start < LOCAL_LOCK_WAIT_MS; ) {
      try {
        mkdirSync(lock);
        held = true;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCAL_LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
          else Bun.sleepSync(10);
        } catch {
          // the holder released it between the two calls: try again at once
        }
      }
    }
    try {
      const local = this.local();
      change(local);
      this.saveLocal(local);
      return local;
    } finally {
      if (held) rmSync(lock, { recursive: true, force: true });
    }
  }

  /** The id of this machine, made on first use. It names the file that only this machine writes: its roll-up in activity/. */
  machine(): string {
    const have = this.local().machine;
    if (have) return have;
    return this.updateLocal((local) => {
      local.machine ||= randomBytes(4).toString("hex");
    }).machine;
  }

  // ---- notes ----

  notePath(note: Pick<Note, "scope" | "id">, trashed = false): string {
    return join(this.home, trashed ? "trash" : "notes", note.scope, `${note.id}.md`);
  }

  private walk(dir: string): string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...this.walk(full));
      else if (entry.name.endsWith(".md")) files.push(full);
    }
    return files;
  }

  /** Load notes. A file that fails to parse is skipped, so one bad edit never breaks a session. */
  notes(options: { trashed?: boolean } = {}): StoredNote[] {
    const trashed = options.trashed ?? false;
    const notes: StoredNote[] = [];
    for (const path of this.walk(join(this.home, trashed ? "trash" : "notes"))) {
      try {
        notes.push({ ...parseNote(readFileSync(path, "utf8")), path, trashed });
      } catch {
        // skipped on purpose
      }
    }
    return notes;
  }

  find(id: string): StoredNote | undefined {
    return this.notes().find((n) => n.id === id) ?? this.notes({ trashed: true }).find((n) => n.id === id);
  }

  writeNote(note: Note, trashed = false): string {
    const path = this.notePath(note, trashed);
    writeAtomic(path, serializeNote(note));
    return path;
  }

  /** Move a note between notes/ and trash/, and record when it went to the trash. */
  move(note: StoredNote, trashed: boolean, at: string): string {
    const target = this.notePath(note, trashed);
    if (existsSync(target)) throw new KbError(`cannot move ${note.id}: ${relative(this.home, target)} already exists`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(note.path, target);
    const { path: _path, trashed: _trashed, trashed_at: _at, ...rest } = note;
    writeAtomic(target, serializeNote(trashed ? { ...rest, trashed_at: at } : rest));
    return target;
  }

  /** Remove a note file for good. In a git store, the history still has it. Another session may have removed it first. */
  remove(note: StoredNote): void {
    rmSync(note.path, { force: true });
  }

  // ---- generated files and git ----

  /** INDEX.md is the human overview of the whole store. Sessions get a filtered view from `kb context`. */
  writeIndex(): void {
    const notes = this.notes();
    const scopes = [...new Set(notes.map((n) => n.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
    const lines = ["# kb index", "", "Generated by kb. Do not edit.", ""];
    for (const scope of scopes) {
      const inScope = notes
        .filter((n) => n.scope === scope)
        .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
      lines.push(`## ${scope} (${inScope.length})`, "");
      for (const n of inScope) lines.push(`- [${n.id}](${relative(this.home, n.path)}) [${n.kind}] ${n.title}`);
      lines.push("");
    }
    writeAtomic(join(this.home, "INDEX.md"), lines.join("\n"));
  }

  isGitRepo(): boolean {
    return existsSync(join(this.home, ".git"));
  }

  hasRemote(): boolean {
    return this.isGitRepo() && git(this.home, "remote").out.length > 0;
  }

  /** Commit every change in the store. Returns true when a commit was made. */
  commit(message: string): boolean {
    if (!this.isGitRepo() || !this.config().autocommit) return false;
    // Another session may hold the index lock for a moment.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!git(this.home, "add", "-A").ok) {
        Bun.sleepSync(50);
        continue;
      }
      if (git(this.home, "diff", "--cached", "--quiet").ok) return false;
      if (git(this.home, "commit", "-q", "-m", message).ok) return true;
      Bun.sleepSync(50);
    }
    return false;
  }

  syncErrorPath(): string {
    return join(this.home, ".sync-error");
  }

  syncError(): string | null {
    try {
      return readFileSync(this.syncErrorPath(), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  clearSyncError(): void {
    rmSync(this.syncErrorPath(), { force: true });
  }
}
