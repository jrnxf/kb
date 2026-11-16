// Reads the SessionStart JSON on stdin and prints `kb context` for the session's directory,
// plus at most three one-line notices. With hooks/session-end.ts and the skills, this is the
// only code that knows about Claude Code.

import { buildContext } from "../cli/context.ts";
import { resolveRepo } from "../cli/scope.ts";
import { isSaved, takeUnsaved } from "../cli/session.ts";
import { cachedStaleCount } from "../cli/stale.ts";
import { Store } from "../cli/store.ts";
import { detached, kickSync } from "../cli/sync.ts";

const STALE_NOTICE_ABOVE = 5;

try {
  let cwd = process.cwd();
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(await Bun.stdin.text()) ?? {};
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    // no stdin or not JSON: use the process directory
  }
  const store = new Store();
  const { text, hiddenIndexLines } = buildContext(store, cwd);
  const notices: string[] = [];

  if (store.exists()) {
    // Sessions of this directory that ended with /clear and no checkpoint. Reported once.
    for (const lost of takeUnsaved(store, cwd)) {
      notices.push(`An earlier session in this directory ended with /clear before /kb:checkpoint ran. Its transcript is ${lost.transcript}. Read it only if the user asks to recover something from it.`);
    }

    if (input.source === "compact" && typeof input.session_id === "string" && !isSaved(store, input.session_id)) {
      notices.push("This session was compacted and /kb:checkpoint has not run in it. Knowledge from before the compaction now exists only in the summary. Tell the user once that /kb:checkpoint saves it.");
    }

    // The stale checks run git once per commit, so they never run here. This reads the last
    // count and, when it is out of date, starts the checks in the background for next time.
    const repo = resolveRepo(cwd, store);
    const stale = cachedStaleCount(store, repo.scope, repo.head);
    // Hook output reaches the agent only, so each line asks it to pass the message on.
    if (stale && stale.notes > STALE_NOTICE_ABOVE) notices.push(`${stale.notes} kb notes for this scope may be stale. Tell the user in one line, in your first reply, that /kb:audit checks them.`);
    // Bodies that do not fit are normal in a large store. Index lines that do not fit mean notes are invisible.
    if (hiddenIndexLines > 0) notices.push(`The kb store is over its index budget here: ${hiddenIndexLines} ${hiddenIndexLines === 1 ? "note is" : "notes are"} hidden from the index. Tell the user in one line, in your first reply, that /kb:audit fixes this.`);
    if (text && !stale?.fresh) detached(store, ["stale", "--repo", cwd, "--quiet"]);
  }

  const out = notices.length === 0 ? text : `${text || "# kb\n"}${text ? "\n" : ""}${notices.join("\n")}\n`;
  if (out) process.stdout.write(out);
  // Fetch changes from other machines in the background, at most once per 5 minutes.
  kickSync(store, 5 * 60_000);
} catch {
  // silent on purpose
}
process.exit(0);
