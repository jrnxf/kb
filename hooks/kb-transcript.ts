// The `kb-transcript` command (bin/kb-transcript), for /kb:recover.
// `kb-transcript <session id>` writes what an unsaved session holds to a private file in the
// store's per-machine state folder. `kb-transcript --measure` measures every unsaved session that
// no session start measured yet, and forgets the short ones, so `kb unsaved` lists only sessions
// that are worth a recovery. Both read a transcript, so they live here and not in the CLI.
// `kb-transcript --memory` names Claude Code's auto memory folder of this project, for /kb:save.
// `kb-transcript --remove-memory <file>` keeps a private copy of one memory file, then removes it.

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { maskSecrets } from "../cli/secrets.ts";
import { claudeConfigDir } from "./auto-memory.ts";
import { MEMORY_BACKUPS, type UnsavedSession, allUnsaved, isDir, privateDir, unsavedSession, writeRecoverFile } from "../cli/session.ts";
import { localDate } from "../cli/note.ts";
import { Store, git } from "../cli/store.ts";
import { readConversation } from "./transcript.ts";
import { settle } from "./unsaved-notice.ts";

/** The user waits for this command, so it has more time than a session start. Marks left over wait for the next run. */
const MEASURE_MS = 10_000;

/**
 * The commits made since the session ended, newest first, under a line that says where.
 * /kb:recover reads them to see what work is finished. The directory of a finished run is often
 * gone: the main checkout of its repo then says what landed there. With neither, they are not known.
 */
function commitsSince(mark: UnsavedSession): string {
  const own = [mark.cwd, mark.root].find(isDir);
  const dir = own ?? (isDir(mark.main) ? mark.main : undefined);
  if (!dir) return "Commits in that directory since it ended:\nnot known: the directory is gone";
  const log = git(dir, "log", "--oneline", "-30", `--since=${mark.ended}`);
  const where = own ? "in that directory" : `in the main checkout of its repo (${dir}), as the directory is gone,`;
  return `Commits ${where} since it ended:\n${log.ok && log.out ? log.out : "none"}`;
}

/**
 * The notes that an earlier /kb:recover of this session wrote, as its mark names them. A search
 * can miss a note that says the fact in other words, so the second recovery gets the list and
 * adds no twin. A note that went to the trash since then stays in the list, so it does not come back.
 */
function savedBefore(store: Store, ids: string[] = []): string {
  const lines = ids.flatMap((id) => {
    const note = store.find(id);
    return note ? [`${note.id}${note.trashed ? " (in the trash)" : ""} | ${note.title}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : "none";
}

/** A failure is one JSON line, as the result is. The skill reads it and goes on to the next session. */
function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function measure(store: Store): void {
  const start = performance.now();
  const before = store.exists() ? allUnsaved(store) : [];
  const { forgotten } = settle(store, before, () => performance.now() - start < MEASURE_MS);
  console.log(JSON.stringify({ sessions: before.length - forgotten, forgotten }));
}

function write(store: Store, session: string): void {
  // Only a session with a mark is read, so the command never reads a path that a caller makes up.
  const mark = store.exists() ? unsavedSession(store, session) : null;
  if (!mark) fail(`no unsaved session ${session}. \`kb unsaved\` lists them.`);
  try {
    // A session that went on after a checkpoint: what came before it is saved, so only the rest is read.
    const conversation = readConversation(mark.transcript, false, mark);
    // A commit subject is text that kb did not write, so the head is masked as the turns are.
    const head = maskSecrets(
      [
        `# Session that ended ${mark.ended} in ${mark.cwd}\n`,
        ...(mark.since ? [`It ran /kb:save at ${mark.since}, and what came before is saved. Below is only what it said after.\n`] : []),
        `${commitsSince(mark)}\n`,
        `Notes that an earlier /kb:recover of this session saved:\n${savedBefore(store, mark.notes)}\n`,
      ].join("\n"),
    );
    // A mask knows the common shapes only. The file is private, and it goes when the session is
    // marked or forgotten, or after 7 days.
    const file = writeRecoverFile(store, session, `${head}\n${conversation.text}`);
    // `ended` is the end that this read is of. `kb saved --ended` marks the session only while that is its last end.
    console.log(JSON.stringify({ file, prompts: conversation.prompts, chars: conversation.chars, failed: conversation.failed, ended: mark.ended }));
  } catch (error) {
    // No path and no stack: the caller must not go and read the raw transcript, which holds tool output.
    fail(`the conversation of session ${session} cannot be read now (${(error as { code?: string })?.code ?? "error"}). Its mark stays.`);
  }
}

/** Claude Code cuts a project folder name over this length, and adds a hash after it. */
const NAME_MAX = 200;

/**
 * Claude Code's auto memory folder of the project in this directory, and its files but MEMORY.md.
 * The folder is named after the real path of the project, with each character that is not a
 * letter or a digit changed to `-`. The save and clear skills run this command: in the default
 * permission mode, Claude Code asks before a shell command with a variable, or a list of a folder
 * outside the project.
 */
function memory(): void {
  const projects = join(claudeConfigDir(), "projects");
  const name = realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
  let dir = name;
  if (name.length > NAME_MAX && !isDir(join(projects, name))) {
    const list = isDir(projects) ? readdirSync(projects) : [];
    dir = list.find((entry) => entry.startsWith(`${name.slice(0, NAME_MAX)}-`)) ?? name;
  }
  const folder = join(projects, dir, "memory");
  const files = isDir(folder) ? readdirSync(folder).filter((file) => file.endsWith(".md") && file !== "MEMORY.md").sort().map((file) => join(folder, file)) : [];
  console.log(JSON.stringify({ folder, files }));
}

/**
 * Remove one auto memory file that kb or an instruction file holds now, after a private copy of it
 * goes to the store's per-machine state folder. /kb:save runs this in place of `rm`, so a fact that
 * a save got wrong can come back. The path must be a memory file, as Claude Code lays them out:
 * `<config>/projects/<name>/memory/<file>.md` in Claude's own config folder, not MEMORY.md, and not
 * a link. A copy goes with the trash, `trashDays` after the day of its removal.
 */
function removeMemory(store: Store, args: string[]): void {
  if (args.length !== 1 || !args[0]) fail("usage: kb-transcript --remove-memory <absolute path of one memory file>, one file per command");
  const file = args[0];
  try {
    removeOne(store, file);
  } catch (error) {
    // The file stays unless its copy was written, as the copy comes first. One JSON line, as every result is.
    fail(`could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function removeOne(store: Store, file: string): void {
  let dir: string;
  try {
    dir = realpathSync(dirname(file));
  } catch {
    return fail(`no folder ${dirname(file)}`);
  }
  const real = join(dir, basename(file));
  let projects: string;
  const config = claudeConfigDir();
  try {
    projects = realpathSync(join(config, "projects"));
  } catch {
    return fail(`Claude's projects folder ${join(config, "projects")} does not exist or cannot be read`);
  }
  const folder = dirname(real);
  const name = basename(dirname(folder));
  if (!real.endsWith(".md") || basename(real) === "MEMORY.md" || basename(folder) !== "memory" || dirname(dirname(folder)) !== projects) {
    return fail(`${file} is not an auto memory file: kb removes only ${join(projects, "<name>", "memory", "<file>.md")}, and never MEMORY.md`);
  }
  // Open once, without following a link at the last step, and read from that handle: a swap of the file between the check and the read cannot send the read elsewhere.
  let text: string;
  try {
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) return fail(`${file} is not a file`);
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(code === "ENOENT" ? `no memory file ${file}` : code === "ELOOP" ? `${file} is a link` : `cannot read ${file}: ${(error as Error).message}`);
  }
  store.ensure();
  const root = store.statePath(MEMORY_BACKUPS);
  const into = join(root, localDate(new Date().toISOString()), name);
  privateDir(into, root);
  // A second file of the same name on the same day gets a number. An exclusive create never takes a copy that is there.
  let backup = join(into, basename(real));
  for (let n = 2; ; n++) {
    try {
      writeFileSync(backup, text, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      backup = join(into, `${basename(real, ".md")}.${n}.md`);
    }
  }
  rmSync(real);
  console.log(JSON.stringify({ removed: real, backup }));
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: kb-transcript <session id> | --measure | --memory | --remove-memory <file>");
  process.exit(1);
}
if (arg === "--memory") memory();
else if (arg === "--remove-memory") removeMemory(new Store(), process.argv.slice(3));
else {
  const store = new Store();
  if (arg === "--measure") measure(store);
  else write(store, arg);
}
