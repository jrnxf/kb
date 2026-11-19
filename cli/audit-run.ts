// `kb audit` and the page's Audit button start one headless agent that runs the audit skill in the
// repo, or outside any repo for the global notes. The agent saves its proposal with `kb audit propose`, as it does in a session, and the
// user picks in the page. This file starts that agent and says where its run stands.

import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "./audit.ts";
import { KbError } from "./note.ts";
import { type Store, writeAtomic } from "./store.ts";
import type { AuditRunState } from "./wire.ts";
import { nowIso } from "./write.ts";

/** Set in the agent's environment. There `kb audit` only reports, so an agent never starts another one. */
export const RUN_ENV = "KB_AUDIT_RUN";
/** A command to run in place of `claude`, for tests. Its arguments are the prompt only. */
export const AGENT_ENV = "KB_AUDIT_AGENT";

const RUNS = "audit-runs.json";
const PLUGIN = join(import.meta.dir, "..");

interface Run {
  scope: string;
  root: string;
  pid: number;
  started: string;
  log: string;
  /** The agent's exit code is written here when it ends, also after the command that started it is gone. */
  exit: string;
}

export function readJson<T>(store: Store, name: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(store.statePath(name), "utf8")) as Record<string, T>;
  } catch {
    return {};
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The last lines of the agent's output: what it said when it stopped. */
function tail(path: string, lines = 12): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Where the last agent run for the scope stands. */
export function runState(store: Store, scope: string): AuditRunState | undefined {
  const run = readJson<Run>(store, RUNS)[scope];
  if (!run) return undefined;
  const audit = readAudit(store, scope);
  const base = { scope, started: run.started, log: run.log };
  if (audit && audit.created >= run.started) return { ...base, status: "proposed", cards: audit.items.length };
  let code: number | undefined;
  try {
    code = Number(readFileSync(run.exit, "utf8").trim());
  } catch {
    if (alive(run.pid)) return { ...base, status: "running" };
  }
  // An agent that ends with no proposal either found nothing to change, or failed.
  return { ...base, status: code === 0 ? "nothing" : "failed", said: tail(run.log) };
}

/** The headless prompt: the audit skill, with what changes when nobody is in the session. */
export function auditPrompt(): string {
  const skill = readFileSync(join(PLUGIN, "skills", "audit", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  return [
    "You run headless: `kb audit` started you, and no user is in this session. Never ask a question, and never start kb serve.",
    "First run `kb audit status`. If it lists notes sent back for a rewrite, rewrite each one as step 4 below says.",
    "Then do steps 1 to 3. When there is nothing to propose, say why in one line and stop without `kb audit propose`.",
    "When `kb audit propose` has saved the cards, stop. The user picks in the page.",
    "",
    skill.trim(),
  ].join("\n");
}

/**
 * What the headless agent may do with no question: kb, and reading the code. The skill has it
 * write the proposal to a file in its scratchpad directory. A write there needs no permission, so
 * no Write is allowed here: the agent can change no file of the repo.
 */
export const AGENT_TOOLS = ["Bash(kb *)", "Read", "Grep", "Glob"];

/** The agent command. `claude -p` with only what the skill needs. */
function agentCommand(prompt: string): string[] {
  const fake = process.env[AGENT_ENV];
  if (fake) return [fake, prompt];
  const claude = Bun.which("claude");
  if (!claude) throw new KbError("kb audit starts the audit with the claude CLI, and it is not on PATH. Run /kb:audit in a Claude Code session instead.");
  // A repo's own hooks can hang a headless run, so the agent loads the user's settings only.
  return [claude, "-p", prompt, "--model", "opus", "--setting-sources", "user", "--allowedTools", ...AGENT_TOOLS];
}

/**
 * Start the agent for the scope in its checkout, or return the run that is already going. It runs
 * detached: it keeps going when the command or the server that started it stops. The global audit
 * runs in a new empty folder, so no repo's scope or hooks reach it.
 */
export function startRun(store: Store, scope: string, root?: string): AuditRunState {
  if (process.env[RUN_ENV]) throw new KbError("an audit agent cannot start another audit");
  const now = runState(store, scope);
  if (now?.status === "running") return now;
  store.ensure();
  if (scope !== "global" && !root) throw new KbError(`kb does not know where ${scope} is checked out`);
  // The empty folder of a global audit is removed when the agent ends.
  const cwd = root ?? mkdtempSync(join(tmpdir(), "kb-audit-global-"));
  const started = nowIso();
  const stamp = started.replace(/[^0-9]/g, "");
  const safe = scope.replace(/[^a-z0-9.-]/gi, "_");
  const log = store.statePath(`audit-${safe}-${stamp}.log`);
  const exit = `${log}.exit`;
  writeAtomic(log, "");
  rmSync(exit, { force: true });
  const [command, ...args] = agentCommand(auditPrompt());
  const out = openSync(log, "a");
  // The shell writes the exit code when the agent ends, so a later `kb audit` can tell a failure
  // from an agent that found nothing to change.
  const script = `"$@"; code=$?; ${root ? "" : 'rm -rf "$KB_AUDIT_TMP"; '}echo $code > "$KB_AUDIT_EXIT"`;
  const child = spawn("/bin/sh", ["-c", script, "sh", command!, ...args], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, [RUN_ENV]: scope, KB_AUDIT_EXIT: exit, ...(root ? {} : { KB_AUDIT_TMP: cwd }), PATH: `${join(PLUGIN, "bin")}:${process.env.PATH ?? ""}` },
  });
  closeSync(out);
  child.unref();
  const runs = readJson<Run>(store, RUNS);
  writeAtomic(store.statePath(RUNS), `${JSON.stringify({ ...runs, [scope]: { scope, root: cwd, pid: child.pid!, started, log, exit } }, null, 2)}\n`);
  return { scope, started, log, status: "running" };
}

/** Wait until the run is no longer running. */
export async function waitRun(store: Store, scope: string, every = 2000): Promise<AuditRunState> {
  for (;;) {
    const state = runState(store, scope);
    if (!state || state.status !== "running") return state!;
    await Bun.sleep(every);
  }
}
