import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEvent, type NoteRollUp, logEvent, readLog } from "../cli/log.ts";
import type { Note } from "../cli/note.ts";
import { Store } from "../cli/store.ts";

// Keep the tests independent of the developer's git identity, signing and hooks.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "kb test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "kb@example.com";

// The home folder is the temp folder: a test never reads or writes the user's own files, and a
// global instructions file in a temp folder is in the home folder, where kb writes it.
process.env.HOME = realpathSync(tmpdir());

// The session of the developer or the agent that runs the tests must not reach the event log of a test.
delete process.env.KB_SESSION;
delete process.env.CLAUDE_CODE_SESSION_ID;

export const ROOT = join(import.meta.dir, "..");
export const MAIN = join(ROOT, "cli", "main.ts");

export function tempDir(prefix = "kb-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function tempStore(): Store {
  const store = new Store(join(tempDir(), "store"));
  store.ensure();
  return store;
}

export function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A git repo with one commit. Pass a remote URL to set origin. */
export function tempRepo(options: { remote?: string; name?: string } = {}): string {
  const dir = join(tempDir(), options.name ?? "project");
  mkdirSync(dir, { recursive: true });
  sh(dir, "git", "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-q", "-m", "init");
  if (options.remote) sh(dir, "git", "remote", "add", "origin", options.remote);
  return dir;
}

/** Set per-machine keys, such as sync and globalInstructions, in the store's local.json. */
export function machineConfig(store: Store, keys: Record<string, unknown>): void {
  store.saveLocal({ ...store.local(), ...keys });
}

let counter = 0;

/** A time this many days ago, as kb writes it. */
export const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Write a note straight to the store, with defaults for every field. */
export function putNote(store: Store, fields: Partial<Note> & { id: string }, trashed = false): Note {
  counter++;
  const note: Note = {
    title: `Title of ${fields.id}`,
    scope: "global",
    kind: "gotcha",
    created: "2026-01-01T00:00:00Z",
    last_verified: "2026-01-01T00:00:00Z",
    anchors: [],
    confidence: "medium",
    // Words that no other note has: `kb stale` names two notes with the same words as twins.
    body: `${["a", "b", "c", "d", "e", "f"].map((part) => `k${counter}${part}`).join(" ")}.`,
    ...fields,
  };
  store.writeNote(note, trashed);
  return note;
}

/** The events in the log of a store, without their times. */
export const logged = (store: Store) => readLog(store).map(({ t: _t, ...event }) => event as Record<string, unknown>);

/** Add an event to the log at a given time. */
export const logAt = (store: Store, time: string, event: LogEvent) => logEvent(store, event, new Date(time));

/** The counters of a kb from before the event log, as one machine wrote them. */
export function legacyUsage(store: Store, machine: string, data: Record<string, { uses: number; last_used?: string }>): void {
  mkdirSync(join(store.home, "usage"), { recursive: true });
  writeFileSync(join(store.home, "usage", `${machine}.json`), JSON.stringify(data));
}

/** The roll-up of another machine, as a sync brings it: what that machine knows of each note. */
export function otherMachine(store: Store, machine: string, notes: Record<string, NoteRollUp>): void {
  mkdirSync(join(store.home, "activity"), { recursive: true });
  writeFileSync(join(store.home, "activity", `${machine}.json`), JSON.stringify({ v: 1, notes }));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

let plainDir: string | undefined;
/** A directory that is not a git repo. */
export function plain(): string {
  plainDir ??= tempDir("kb-plain-");
  return plainDir;
}

export function kb(store: Store | string, args: string[], options: { stdin?: string; cwd?: string; env?: Record<string, string> } = {}): CliResult {
  const home = typeof store === "string" ? store : store.home;
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: options.cwd ?? plain(),
    env: { ...process.env, KB_HOME: home, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    // not JSON output
  }
  return { code: r.exitCode ?? -1, stdout, stderr: r.stderr.toString(), json };
}
