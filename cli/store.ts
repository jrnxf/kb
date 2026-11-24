// The store on disk: paths, config, notes, the usage counters of older versions, generated files and git.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** Per machine: local.json wins, and kb.config.json is the fallback. */
  sync: boolean;
  /** Per machine, as above. The user's global instructions file, which a global audit moves rules into. A leading ~ is the home folder. */
  globalInstructions: string;
  /** The model of the headless agent that `kb audit` and the page's Audit button start. */
  auditModel: string;
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
  auditModel: "opus",
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

// `index.html` and `.sync-*` are files of an older kb in the store's top folder. They stay ignored.
const GITIGNORE = ["INDEX.md", "index.html", "local.json", ".sync-*", "*.tmp-*", ".state/"];

/** Files that an older kb kept in the store's top folder, and their place in .state/ now. */
const MOVED_TO_STATE: Record<string, string> = { ".sync-error": "sync-error", ".sync-last": "sync-last" };

/** A path with a leading `~` for the home folder, as a config or a shell command writes it. */
export const tilde = (path: string) => (path === "~" || path.startsWith("~/") ? join(userHome(), path.slice(1)) : path);

/** The user's home folder, as an absolute path without a trailing slash. HOME wins, as in a shell. */
export const userHome = (env: Record<string, string | undefined> = process.env) => resolve(env.HOME || homedir());

/** The store's folder, always absolute: an agent that kb starts runs in another folder. */
export function kbHome(): string {
  return resolve(process.env.KB_HOME || join(userHome(), ".kb"));
}

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const result = gitRaw(cwd, ...args);
  return { ok: result.ok, out: result.out.trim() };
}

/** git with its output as git wrote it, for output where a leading space counts. */
function gitRaw(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    // Bun gives a child the environment of the start without `env`, so a change to process.env would not reach git.
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
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

export interface LockOptions {
  /** How long to wait for a lock that another process holds. */
  waitMs?: number;
  /** A lock whose holder is alive but older than this is stale too: a hung holder must not block for ever. */
  staleMs?: number;
}

const NO_OWNER_GRACE_MS = 2000;

/** True when a process with this pid runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The owner text of a lock that has no live holder, or null when the lock is held (or gone).
 * The holder writes "pid token" in the file `owner` of the lock folder. A lock is stale when its
 * pid is gone, or when it is older than `staleMs`. A lock with no owner file yet is stale after a
 * short grace time, which covers a holder that died between mkdir and the write.
 */
function staleOwner(path: string, staleMs: number): string | null {
  try {
    const file = join(path, "owner");
    let owner: string;
    try {
      owner = readFileSync(file, "utf8");
    } catch {
      return Date.now() - statSync(path).mtimeMs > Math.min(NO_OWNER_GRACE_MS, staleMs) ? "" : null;
    }
    const pid = Number.parseInt(owner, 10);
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid) || Date.now() - statSync(file).mtimeMs > staleMs) return owner;
    return null;
  } catch {
    return null; // the holder released it between two calls
  }
}

/**
 * Take over a stale lock. The rename is atomic, so only one waiter wins it. The winner checks that
 * it moved the lock it judged stale: a lock that a new holder made in between goes back.
 */
function takeOver(path: string, owner: string): void {
  const moved = `${path}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(path, moved);
  } catch {
    return; // another waiter won, or the holder released it
  }
  let found = "";
  try {
    found = readFileSync(join(moved, "owner"), "utf8");
  } catch {
    // no owner file: the lock that we judged had none
  }
  if (found !== owner) {
    try {
      renameSync(moved, path);
      return;
    } catch {
      // a third process holds the lock now: drop the copy
    }
  }
  rmSync(moved, { recursive: true, force: true });
}

/**
 * Run `fn` while this process holds the lock folder `path`. Another process waits for it, up to
 * `waitMs` (0 tries once). Returns undefined when the lock stays taken. A lock whose holder died
 * goes to the first waiter that renames it away. The holder removes only its own lock. Throws when the
 * lock folder cannot be made (a read-only store): a caller that must not throw catches it.
 */
export function withLock<T>(path: string, fn: () => T, { waitMs = 10_000, staleMs = 300_000 }: LockOptions = {}): T | undefined {
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(path, { mode: DIR_MODE });
      try {
        writeFileSync(join(path, "owner"), token, { mode: FILE_MODE });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
      else if (code !== "EEXIST") throw error;
      else {
        const owner = staleOwner(path, staleMs);
        if (owner !== null) {
          takeOver(path, owner);
          continue;
        }
        if (Date.now() >= until) return undefined;
        Bun.sleepSync(10 + Math.random() * 20);
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(join(path, "owner"), "utf8") === token) rmSync(path, { recursive: true, force: true });
    } catch {
      // another process took the lock over: it is not ours to remove
    }
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
    this.closeOldStore();
    this.moveToState();
    this.tidyConfig();
    const ignorePath = join(this.home, ".gitignore");
    // Add lines that a store made by an older version lacks.
    const have = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
    const missing = GITIGNORE.filter((line) => !have.split("\n").includes(line));
    if (missing.length > 0) {
      writeAtomic(ignorePath, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
      this.track(ignorePath);
    }
    if (fresh) git(this.home, "init", "-q");
  }

  /**
   * A store made by an older version can be readable by every user of the machine. Once per store
   * (the file .state/private marks it), close the root, the notes, the trash and the state: folders
   * to 0700 and files to 0600. The .git folder stays as git made it, because the root is closed.
   */
  private closeOldStore(): void {
    const mark = this.statePath("private");
    try {
      if (existsSync(mark) && (statSync(this.home).mode & 0o077) === 0) return;
    } catch {
      return;
    }
    const close = (path: string): void => {
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink()) return;
        const want = info.isDirectory() ? DIR_MODE : FILE_MODE;
        if ((info.mode & 0o777) !== want) chmodSync(path, want);
        if (info.isDirectory()) for (const entry of readdirSync(path)) if (entry !== ".git") close(join(path, entry));
      } catch {
        // a store on a file system with no modes still works
      }
    };
    close(this.home);
    try {
      writeAtomic(mark, "");
    } catch {
      // the next write tries again
    }
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
    if (!same(kept, raw)) {
      writeAtomic(this.configPath(), `${JSON.stringify(kept, null, 2)}\n`);
      this.track(this.configPath());
    }
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
      // The model goes on the claude command line, so audit-run checks it when an audit starts and
      // refuses a wrong value. Here it stays as written, so a mistake stops no other command.
      auditModel: raw.auditModel === undefined ? DEFAULT_CONFIG.auditModel : typeof raw.auditModel === "string" ? raw.auditModel : "",
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
    let ran: { local: Local } | undefined;
    const run = () => {
      const local = this.local();
      change(local);
      this.saveLocal(local);
      ran = { local };
      return local;
    };
    try {
      withLock(this.statePath("local-lock"), run, { waitMs: LOCAL_LOCK_WAIT_MS, staleMs: LOCAL_LOCK_STALE_MS });
    } catch (error) {
      if (ran) throw error;
    }
    // A lock that stays taken, or cannot be made, does not stop the change.
    return (ran as { local: Local } | undefined)?.local ?? run();
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
    if (!this.isGitRepo() || !this.config().autocommit) {
      this.touched.clear();
      return false;
    }
    // A path leaves the set only after a commit that took it, so a lock timeout keeps it for the next one.
    // .gitignore is written by kb alone, and a command that does not commit (a read that ran ensure()) may have changed it.
    const touched = [...new Set([...this.touched, ".gitignore"])];
    try {
      return (
        this.withGitLock(() => {
          // isGitRepo() looks for .git in the store itself, so the store is the repo root and git's paths are relative to it.
          // Only the paths that changed: a path that was made and removed again is not a pathspec git knows.
          const status = gitRaw(this.home, "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", "--", ...(options.all ? ["."] : touched.map((path) => `:(literal)${path}`)));
          if (!status.ok) return false;
          const changed = status.out.split("\0").filter(Boolean).map((entry) => entry.slice(3));
          if (changed.length > 0) {
            const paths = changed.map((path) => `:(literal)${path}`);
            if (!git(this.home, "add", "-A", "--", ...paths).ok) return false;
            // A machine with no git identity still keeps its history.
            const who = git(this.home, "config", "user.email").out ? [] : ["-c", "user.name=kb", "-c", "user.email=kb@localhost"];
            if (!git(this.home, ...who, "commit", "-q", "-m", message, "--", ...paths).ok) return false;
          }
          for (const path of touched) this.touched.delete(path);
          return changed.length > 0;
        }) ?? false
      );
    } catch (error) {
      // The note is saved already: a store that git cannot lock must not fail the write.
      process.stderr.write(`kb: warning: could not commit to the store's git history (${(error as Error).message})\n`);
      return false;
    }
  }

  /** How long a commit waits for the git lock. A test sets it low. */
  gitLockWaitMs = 10_000;

  /** Run `fn` while no other kb process changes the store's git index. */
  withGitLock<T>(fn: () => T): T | undefined {
    return withLock(this.statePath("git-lock"), fn, { waitMs: this.gitLockWaitMs, staleMs: 600_000 });
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
