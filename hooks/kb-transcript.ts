// The `kb-transcript` command (bin/kb-transcript), for /kb:recover.
// `kb-transcript <session id>` writes what an unsaved session holds to a private file in the
// store's per-machine state folder. `kb-transcript --measure` measures every unsaved session that
// no session start measured yet, and forgets the short ones, so `kb unsaved` lists only sessions
// that are worth a recovery. Both read a transcript, so they live here and not in the CLI.

import { maskSecrets } from "../cli/secrets.ts";
import { type UnsavedSession, allUnsaved, isDir, unsavedSession, writeRecoverFile } from "../cli/session.ts";
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
    const conversation = readConversation(mark.transcript);
    // A commit subject is text that kb did not write, so the head is masked as the turns are.
    const head = maskSecrets(
      [
        `# Session that ended ${mark.ended} in ${mark.cwd}\n`,
        `${commitsSince(mark)}\n`,
        `Notes that an earlier /kb:recover of this session saved:\n${savedBefore(store, mark.notes)}\n`,
      ].join("\n"),
    );
    // A mask knows the common shapes only. The file is private, and it goes when the session is
    // marked or forgotten, or after 7 days.
    const file = writeRecoverFile(store, session, `${head}\n${conversation.text}`);
    // `ended` is the end that this read is of. `kb checkpointed --ended` marks the session only while that is its last end.
    console.log(JSON.stringify({ file, prompts: conversation.prompts, chars: conversation.chars, failed: conversation.failed, ended: mark.ended }));
  } catch (error) {
    // No path and no stack: the caller must not go and read the raw transcript, which holds tool output.
    fail(`the conversation of session ${session} cannot be read now (${(error as { code?: string })?.code ?? "error"}). Its mark stays.`);
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: kb-transcript <session id> | --measure");
  process.exit(1);
}
const store = new Store();
if (arg === "--measure") measure(store);
else write(store, arg);
