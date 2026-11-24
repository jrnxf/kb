// The store on disk: paths, config, notes, the usage counters of older versions, generated files and git.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
  /** Per machine: kb reads it from local.json. */
  sync: boolean;
  /** Per machine: kb reads it from local.json. The user's global instructions file, which a global audit moves rules into. A leading ~ is the home folder. */
  globalInstructions: string;
}

/**
 * The keys that differ per machine. They live in local.json, which is never synced, so a config
 * pulled from another machine cannot turn sync on or say where Apply writes.
 */
export const MACHINE_KEYS = ["sync", "globalInstructions"] as const;
type MachineKey = (typeof MACHINE_KEYS)[number];

export interface Local extends Partial<Pick<Config, MachineKey>> {
  machine: string;
  aliases: Record<string, string>;
  /** True once this machine took its per-machine keys from kb.config.json, where an older kb kept them. */
  movedKeys?: boolean;
}

/** What kb recorded per note before it had an event log. Nothing writes it now. */
export interface Usage {
  uses: number;
  last_used?: string;
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

/** Keys that an older kb wrote and that this version ignores. */
const DEAD_BUDGETS = ["indexLines", "globalIndexLines"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A config that an older kb wrote whole, without the keys whose value is the default. Each default
 * that kb ever shipped is the default of today, so a value equal to it changes nothing now. The
 * cost: a user who typed a default on purpose no longer holds it when a later kb changes it.
 */
export function withoutDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "budgets" && value && typeof value === "object" && !Array.isArray(value)) {
      const budgets = Object.fromEntries(
        Object.entries(value).filter(([name, v]) => !DEAD_BUDGETS.includes(name) && !same(v, DEFAULT_CONFIG.budgets[name as keyof Config["budgets"]])),
      );
      if (Object.keys(budgets).length > 0) kept.budgets = budgets;
    } else if (!(key in DEFAULT_CONFIG) || !same(value, DEFAULT_CONFIG[key as keyof Config])) {
      kept[key] = value;
    }
  }
  return kept;
}

// `index.html` and `.sync-*` are files of an older kb in the store's top folder. They stay ignored.
const GITIGNORE = ["INDEX.md", "index.html", "local.json", ".sync-*", "*.tmp-*", ".state/"];

/** Files of the store itself, which ensure() writes. Each commit takes them when they changed. */
const STORE_FILES = [".gitignore", "kb.config.json"];

/** Files that an older kb kept in the store's top folder, and their place in .state/ now. */
const MOVED_TO_STATE: Record<string, string> = { ".sync-error": "sync-error", ".sync-last": "sync-last" };

/** A path with a leading `~` for the home folder, as a config or a shell command writes it. */
export const tilde = (path: string) => (path === "~" || path.startsWith("~/") ? join(userHome(), path.slice(1)) : path);

/** The user's home folder. HOME wins, as in a shell. */
export const userHome = () => process.env.HOME || homedir();

/** The store's folder, always absolute: an agent that kb starts runs in another folder. */
export function kbHome(): string {
  return resolve(process.env.KB_HOME || join(homedir(), ".kb"));
}

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const result = gitRaw(cwd, ...args);
  return { ok: result.ok, out: result.out.trim() };
}

/** git with its output as git wrote it, for output where a leading space counts. */
function gitRaw(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { ok: result.exitCode === 0, out: result.stdout.toString() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Only the user may read the store: notes, the event log and the audits hold their work. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Write a file in one step. It and any folder made for it are for the user alone. */
export function writeAtomic(path: string, content: string, mode: number = FILE_MODE): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

/** A lock older than this is left over from a process that died. */
const LOCK_STALE_MS = 30_000;

/**
 * Run `fn` while this process holds the lock folder `path`. Another process waits for it, up to
 * `waitMs`. Returns undefined when the lock stays taken.
 */
export function withLock<T>(path: string, fn: () => T, waitMs = 10_000): T | undefined {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(path, { mode: DIR_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
      else {
        try {
          if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true });
        } catch {
          // the holder removed it: try again
        }
        if (Date.now() > until) return undefined;
        Bun.sleepSync(10 + Math.random() * 20);
      }
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
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

  /** The files that this process changed since its last commit. A commit takes only these. */
  private touched = new Set<string>();

  /** Mark a file in the store as changed, so the next commit takes it. */
  track(path: string): void {
    this.touched.add(relative(this.home, path));
  }

  /**
   * Create the store layout. Only commands that write call this. A new store starts as a git repo
   * with no remote, so a note that leaves the trash for good stays in the history.
   */
  ensure(): void {
    // A store is new when it has no notes folder and no git: an empty folder, or no folder at all.
    const fresh = !existsSync(join(this.home, "notes")) && !this.isGitRepo();
    mkdirSync(this.home, { recursive: true, mode: DIR_MODE });
    for (const dir of ["notes", "trash", ".state"]) mkdirSync(join(this.home, dir), { recursive: true, mode: DIR_MODE });
    // A store made by an older version can be readable by every user of the machine.
    for (const dir of [this.home, join(this.home, ".state")]) {
      try {
        if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, DIR_MODE);
      } catch {
        // a store on a file system with no modes still works
      }
    }
    this.moveToState();
    this.tidyConfig();
    const ignorePath = join(this.home, ".gitignore");
    // Add lines that a store made by an older version lacks.
    const have = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
    const missing = GITIGNORE.filter((line) => !have.split("\n").includes(line));
    if (missing.length > 0) writeAtomic(ignorePath, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    if (fresh) git(this.home, "init", "-q");
  }

  /** Move the files that an older kb kept in the store's top folder into .state/. */
  private moveToState(): void {
    for (const [old, now] of Object.entries(MOVED_TO_STATE)) {
      const from = join(this.home, old);
      if (!existsSync(from)) continue;
      try {
        if (existsSync(this.statePath(now))) rmSync(from, { force: true });
        else renameSync(from, this.statePath(now));
      } catch {
        // the next write tries again
      }
    }
    // The page of `kb html`, a command that is gone. Nothing reads it.
    rmSync(join(this.home, "index.html"), { force: true });
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
   * kb.config.json holds only the keys that the user set. An older kb wrote every default into it,
   * so a later default never reached the user, and it kept the per-machine keys there. A file that
   * names a per-machine key is such a file: its per-machine keys go to local.json, and a file that
   * an older kb wrote whole loses the keys whose value is the default.
   */
  private tidyConfig(): void {
    const raw = this.sharedConfig();
    this.machineKeys(raw);
    if (!MACHINE_KEYS.some((key) => key in raw)) return;
    const whole = FIRST_KEYS.every((key) => key in raw);
    const kept = Object.fromEntries(Object.entries(whole ? withoutDefaults(raw) : raw).filter(([key]) => !(MACHINE_KEYS as readonly string[]).includes(key)));
    writeAtomic(this.configPath(), `${JSON.stringify(kept, null, 2)}\n`);
  }

  /**
   * The per-machine keys of local.json. The first time, a machine takes the ones that an older kb
   * kept in kb.config.json, before a sync can pull a file that lacks them. After that, kb.config.json
   * has no say over them.
   */
  private machineKeys(shared: Record<string, unknown>): Local {
    const local = this.local();
    if (local.movedKeys || !this.exists()) return local;
    for (const key of MACHINE_KEYS) {
      if (key in shared && !(key in local) && !same(shared[key], DEFAULT_CONFIG[key])) Object.assign(local, { [key]: shared[key] });
    }
    local.movedKeys = true;
    this.saveLocal(local);
    return local;
  }

  config(): Config {
    const shared = this.sharedConfig() as Partial<Config>;
    const local = this.machineKeys(shared);
    const { sync: _sync, globalInstructions: _file, ...raw } = shared;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sync: typeof local.sync === "boolean" ? local.sync : DEFAULT_CONFIG.sync,
      globalInstructions: typeof local.globalInstructions === "string" && local.globalInstructions ? local.globalInstructions : DEFAULT_CONFIG.globalInstructions,
      // Only the budgets of this version are read. A config of an older kb can still name
      // `indexLines` and `globalIndexLines`: both limits are gone, and the keys are ignored.
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
    return { ...raw, machine: raw.machine ?? "", aliases: raw.aliases ?? {} };
  }

  saveLocal(local: Local): void {
    writeAtomic(join(this.home, "local.json"), `${JSON.stringify(local, null, 2)}\n`);
  }

  /** The id of this machine, made on first use. It names the file that only this machine writes: its roll-up in activity/. */
  machine(): string {
    const local = this.local();
    if (local.machine) return local.machine;
    local.machine = randomBytes(4).toString("hex");
    this.saveLocal(local);
    return local.machine;
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
    this.track(path);
    return path;
  }

  /** Move a note between notes/ and trash/, and record when it went to the trash. */
  move(note: StoredNote, trashed: boolean, at: string): string {
    const target = this.notePath(note, trashed);
    if (existsSync(target)) throw new KbError(`cannot move ${note.id}: ${relative(this.home, target)} already exists`);
    mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE });
    renameSync(note.path, target);
    const { path: _path, trashed: _trashed, trashed_at: _at, ...rest } = note;
    writeAtomic(target, serializeNote(trashed ? { ...rest, trashed_at: at } : rest));
    this.track(note.path);
    this.track(target);
    return target;
  }

  /** Remove a note file for good. In a git store, the history still has it. Another session may have removed it first. */
  remove(note: StoredNote): void {
    rmSync(note.path, { force: true });
    this.track(note.path);
  }

  // ---- usage, from older versions ----

  /**
   * The counters that kb kept in usage/, one file per machine, before it had an event log. They
   * are synced history, so the files stay. Two things still read them: the last activity of a note
   * takes `last_used`, and `kb add` never gives a new note an id that has counters. What a machine
   * shares of its log now is the roll-up in activity/, which log.ts reads and writes.
   */
  usage(): Map<string, Usage> {
    const total = new Map<string, Usage>();
    let files: string[] = [];
    try {
      files = readdirSync(join(this.home, "usage")).filter((f) => f.endsWith(".json"));
    } catch {
      return total;
    }
    for (const file of files) {
      const data = readJson<Record<string, Usage>>(join(this.home, "usage", file)) ?? {};
      for (const [id, entry] of Object.entries(data)) {
        const current = total.get(id) ?? { uses: 0 };
        current.uses += entry.uses ?? 0;
        if (entry.last_used && (!current.last_used || entry.last_used > current.last_used)) current.last_used = entry.last_used;
        total.set(id, current);
      }
    }
    return total;
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

  /**
   * Commit the files that this process changed, and only those, so each write gets its own commit
   * with its own message, also when other sessions write at the same time. With `all`, commit every
   * change in the store: a sync takes what a crash or a hand edit left. Returns true when a commit
   * was made.
   */
  commit(message: string, options: { all?: boolean } = {}): boolean {
    // The store's own files go with any write: ensure() may have changed them in an earlier command.
    const touched = [...this.touched, ...STORE_FILES];
    this.touched.clear();
    if (!this.isGitRepo() || !this.config().autocommit) return false;
    return this.withGitLock(() => {
      // Only the paths that changed: a path that was made and removed again is not a pathspec git knows.
      const status = gitRaw(this.home, "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", ...(options.all ? ["."] : touched.map((path) => `:(literal)${path}`)));
      if (!status.ok) return false;
      const changed = status.out.split("\0").filter(Boolean).map((entry) => entry.slice(3));
      if (changed.length === 0) return false;
      const paths = changed.map((path) => `:(literal)${path}`);
      if (!git(this.home, "add", "-A", "--", ...paths).ok) return false;
      // A machine with no git identity still keeps its history.
      const who = git(this.home, "config", "user.email").out ? [] : ["-c", "user.name=kb", "-c", "user.email=kb@localhost"];
      return git(this.home, ...who, "commit", "-q", "-m", message, "--", ...paths).ok;
    }) ?? false;
  }

  /** Run `fn` while no other kb process changes the store's git index. */
  withGitLock<T>(fn: () => T): T | undefined {
    return withLock(this.statePath("git-lock"), fn);
  }

  syncErrorPath(): string {
    return this.statePath("sync-error");
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
