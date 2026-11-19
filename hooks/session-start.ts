// Reads the SessionStart JSON on stdin and prints `kb context` for the session's directory,
// the rule for where rules and facts go, and at most four one-line notices. With the other
// files in hooks/ and the skills, this is the only code that knows about Claude Code. After the
// output it adds one `start` line to the event log: which notes this session got, and in what form.

import { forgetSeen } from "../cli/by-path.ts";
import { SAVE_RULE, buildContext } from "../cli/context.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { resolveRepo } from "../cli/scope.ts";
import { isSaved, takeUnsaved } from "../cli/session.ts";
import { cachedStaleCount } from "../cli/stale.ts";
import { Store } from "../cli/store.ts";
import { detached, kickSync } from "../cli/sync.ts";
import { MEMORY_ON_NOTICE, MEMORY_RULE, autoMemoryOn } from "./auto-memory.ts";

const STALE_NOTICE_ABOVE = 5;
/** Claude Code shows SessionStart output above 10,000 characters as a file preview. */
const OUTPUT_LIMIT = 9900;
/**
 * The rules for saving. The auto memory rule is there only while auto memory is on: with it off,
 * no system prompt tells the agent to save there. Until the settings are read the rule stays in,
 * because a rule too many costs less than a fact in the wrong store.
 */
let rules = `${SAVE_RULE}\n${MEMORY_RULE}`;
/** What a session gets when there is no note to show: no store yet, or a broken one. */
const rulesOnly = () => `# kb\n${rules}\n`;

try {
  let cwd = process.cwd();
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(await Bun.stdin.text()) ?? {};
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    // no stdin or not JSON: use the process directory
  }
  const memoryOn = autoMemoryOn(process.env, process.env.CLAUDE_PROJECT_DIR || cwd);
  if (!memoryOn) rules = SAVE_RULE;
  const store = new Store();
  // The notes a Read named before a compaction or a /clear are gone from the context, so a Read may name them again.
  if (input.source === "compact" || input.source === "clear") forgetSeen(store, input.session_id);
  const context = buildContext(store, cwd);
  const { text, hiddenIndexLines } = context;
  const notices: string[] = [];

  if (store.exists()) {
    const repo = resolveRepo(cwd, store);
    // Sessions of this directory or checkout that ended with /clear and no checkpoint. Reported once.
    for (const lost of takeUnsaved(store, cwd, repo.root)) {
      notices.push(`An earlier session in this directory ended with /clear before /kb:checkpoint ran. Its transcript is ${lost.transcript}. Read it only if the user asks to recover something from it.`);
    }

    if (input.source === "compact" && typeof input.session_id === "string" && !isSaved(store, input.session_id)) {
      notices.push("This session was compacted and /kb:checkpoint has not run in it. Knowledge from before the compaction now exists only in the summary. Tell the user once that /kb:checkpoint saves it.");
    }

    // The stale checks run git once per commit, so they never run here. This reads the last
    // count and, when it is out of date, starts the checks in the background for next time.
    const stale = cachedStaleCount(store, repo.scope, repo.head);
    // Hook output reaches the agent only, so each line asks it to pass the message on.
    if (stale && stale.notes > STALE_NOTICE_ABOVE) notices.push(`${stale.notes} kb notes for this scope may be stale. Tell the user in one line, in your first reply, that /kb:audit checks them.`);
    // Bodies that do not fit are normal in a large store. Index lines that do not fit mean notes are invisible.
    if (hiddenIndexLines > 0) notices.push(`The kb store is over its index budget here: ${hiddenIndexLines} ${hiddenIndexLines === 1 ? "note is" : "notes are"} hidden from the index. Tell the user in one line, in your first reply, that /kb:audit fixes this.`);
    if (text && !stale?.fresh) detached(store, ["stale", "--repo", cwd, "--quiet"]);
  }

  // Once per session: a /clear, a resume or a compaction is the same session to the user.
  if (input.source === "startup" && memoryOn) notices.push(MEMORY_ON_NOTICE);

  // The auto memory rule goes right under the save rule, so the two read as one instruction.
  // It comes at every start, also after a compaction, because it must hold for the whole session.
  const head = text ? text.replace(SAVE_RULE, rules) : rulesOnly();
  // Output over the limit becomes a file preview. A notice that does not fit is left out.
  const shown: string[] = [];
  let length = head.length + 1;
  for (const notice of notices) {
    if (length + notice.length + 1 > OUTPUT_LIMIT) continue;
    shown.push(notice);
    length += notice.length + 1;
  }
  const output = shown.length === 0 ? head : `${head}\n${shown.join("\n")}\n`;
  process.stdout.write(output);
  // The log comes after the output, so it can never change or delay what the session gets.
  const { index, bodies } = context.charsBy;
  logEvent(store, {
    ev: "start",
    ...hookWho(input),
    scope: context.scope ?? "global",
    source: typeof input.source === "string" ? input.source : "unknown",
    bodies: context.bodies,
    index: context.index,
    // In no session: a note the index budget cut, or a global note over the global cap.
    hidden: [...context.dropped.filter((id) => !context.index.includes(id)), ...context.capped],
    chars: { fixed: output.length - index - bodies, index, bodies, total: output.length },
  });
  // Fetch changes from other machines in the background, at most once per 5 minutes.
  kickSync(store, 5 * 60_000);
} catch {
  // The rules for saving reach every session, also one with a broken store: `kb add` says what is wrong.
  process.stdout.write(rulesOnly());
}
process.exit(0);
