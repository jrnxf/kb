// The store on disk: paths, config, notes, the usage counters of older versions, generated files and git.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { KINDS, KbError, type Note, parseNote, serializeNote } from "./note.ts";

export interface Config {
  /** globalIndexLines: the places global notes may take in a repo session, bodies and index lines together. */
  budgets: { indexLines: number; contextChars: number; globalIndexLines: number };
  decayDays: number;
  /** A note with no activity and no check for this many days has expired. The audit proposes trash for it. */
  expireDays: number;
  /** A note in the trash for longer than this is deleted for good. */
  trashDays: number;
  autocommit: boolean;
  sync: boolean;
  /** The user's global instructions file. A global audit moves rules into it. A leading ~ is the home folder. */
  globalInstructions: string;
}

export interface Local {
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

const DEFAULT_CONFIG: Config = {
  budgets: { indexLines: 60, contextChars: 8000, globalIndexLines: 20 },
  decayDays: 180,
  expireDays: 90,
  trashDays: 30,
  autocommit: true,
  sync: true,
  globalInstructions: "~/.claude/CLAUDE.md",
};

const GITIGNORE = ["INDEX.md", "index.html", "local.json", ".sync-*", "*.tmp-*", ".state/"];

/** The store's folder, always absolute: an agent that kb starts runs in another folder. */
export function kbHome(): string {
  return resolve(process.env.KB_HOME || join(homedir(), ".kb"));
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
    const configPath = join(this.home, "kb.config.json");
    if (!existsSync(configPath)) writeAtomic(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
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

  config(): Config {
    const raw = readJson<Partial<Config>>(join(this.home, "kb.config.json")) ?? {};
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      budgets: {
        ...DEFAULT_CONFIG.budgets,
        ...(raw.budgets ?? {}),
        // 0 is a choice: no global notes in a repo session. A value that is not a number is a mistake.
        globalIndexLines: Number.isFinite(raw.budgets?.globalIndexLines) && raw.budgets!.globalIndexLines! >= 0 ? Math.floor(raw.budgets!.globalIndexLines!) : DEFAULT_CONFIG.budgets.globalIndexLines,
      },
      // A wrong value must not empty the trash, expire every note or stop every command.
      trashDays: days(raw.trashDays, DEFAULT_CONFIG.trashDays),
      decayDays: days(raw.decayDays, DEFAULT_CONFIG.decayDays),
      expireDays: days(raw.expireDays, DEFAULT_CONFIG.expireDays),
    };
  }

  /** Per-machine state. It is never committed, because paths and machine ids differ per machine. */
  local(): Local {
    const raw = readJson<Partial<Local>>(join(this.home, "local.json")) ?? {};
    return { machine: raw.machine ?? "", aliases: raw.aliases ?? {} };
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
