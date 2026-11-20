// Reads the SessionStart JSON on stdin and prints `kb context` for the session's directory (the
// open work of the repo in short form, and the index), the rule for where rules and facts go, and
// a few one-line notices. With the other files in hooks/ and the skills, this is the only
// code that knows about Claude Code. After the output it adds one `start` line to the event log:
// which notes this session got, and in what form.

import { forgetSeen } from "../cli/by-path.ts";
import { SAVE_RULE, buildContext, contextFor } from "../cli/context.ts";
import { hookWho, logEvent } from "../cli/log.ts";
import { resolveRepo } from "../cli/scope.ts";
import { reopenSession, savedAt } from "../cli/session.ts";
import { cachedStaleCount } from "../cli/stale.ts";
import { Store } from "../cli/store.ts";
import { detached, kickSync } from "../cli/sync.ts";
import { MEMORY_ON_NOTICE, MEMORY_RULE, autoMemoryOn } from "./auto-memory.ts";
import { CHECKPOINT_RULE } from "./checkpoint-rule.ts";
import { promptAfter } from "./transcript.ts";
import { unsavedNotice } from "./unsaved-notice.ts";

const STALE_NOTICE_ABOVE = 5;
/** Claude Code shows SessionStart output above 10,000 characters as a file preview. */
const OUTPUT_LIMIT = 9900;
/**
 * The rules for saving. The auto memory rule is there only while auto memory is on: with it off,
 * no system prompt tells the agent to save there. Until the settings are read the rule stays in,
 * because a rule too many costs less than a fact in the wrong store.
 */
let rules = `${SAVE_RULE}\n${MEMORY_RULE}`;
/**
 * False for a headless run, where nobody reads a first reply. Claude Code names the way it was
 * started in this variable: print mode (`claude -p`) is "sdk-cli", and a run of the Agent SDK is
 * "sdk-ts" or "sdk-py". Every name that starts with "sdk" is such a run. No hook input says it.
 */
const attended = () => !process.env.CLAUDE_CODE_ENTRYPOINT?.startsWith("sdk");
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
  // Nobody reads the line in a headless run, and a subagent does not end the session.
  if (attended() && !input.agent_id) rules = rules.replace(SAVE_RULE, `${SAVE_RULE}\n${CHECKPOINT_RULE}`);
  const store = new Store();
  // The notes a trigger loaded before a compaction or a /clear are gone from the context, so they may load again.
  if (input.source === "compact" || input.source === "clear") forgetSeen(store, input.session_id);
  // HOLDBACK: the session id picks the arm, so a resume, a compaction and a /clear stay in one.
  const context = buildContext(store, cwd, typeof input.session_id === "string" ? input.session_id : undefined);
  const { text } = context;
  const notices: string[] = [];

  if (store.exists()) {
    const repo = resolveRepo(cwd, store);
    const session = typeof input.session_id === "string" && !input.agent_id ? input.session_id : undefined;
    // A session that ended with no checkpoint and starts again is live: the user resumed it. Its
    // record goes, so no other session recovers it while it works. Its next end records it again.
    if (session) reopenSession(store, session);
    // Sessions of this directory or checkout that ended with no checkpoint, and from 5 on those of
    // other directories. A resume or a compaction is the same session, which already had the line.
    // The step never throws and has its own time budget, so no transcript can cost the session its notes.
    const lost = input.source === "startup" || input.source === "clear" ? unsavedNotice(store, cwd, repo.root, { session, attended: attended(), startup: input.source === "startup" }) : null;
    if (lost) notices.push(lost);

    if (input.source === "compact" && typeof input.session_id === "string") {
      // A checkpoint before the compaction saves only what came before it.
      const at = savedAt(store, input.session_id);
      const went = at !== null && typeof input.transcript_path === "string" && promptAfter(input.transcript_path, at) !== null;
      if (at === null) notices.push("This session was compacted and /kb:save has not run in it. Knowledge from before the compaction now exists only in the summary. Tell the user once that /kb:save saves it.");
      else if (went) notices.push("This session was compacted, and the user typed more after its last /kb:save. Knowledge from that part now exists only in the summary. Tell the user once that /kb:save saves it.");
    }

    // The stale checks run git once per commit, so they never run here. This reads the last
    // count and, when it is out of date, starts the checks in the background for next time.
    const stale = cachedStaleCount(store, repo.scope, repo.head);
    // Hook output reaches the agent only, so each line asks it to pass the message on.
    if (stale && stale.notes > STALE_NOTICE_ABOVE) notices.push(`${stale.notes} kb notes for this scope may be stale. Tell the user in one line, in your first reply, that /kb:audit checks them.`);
    // The index is how a note reaches a session. Index lines that do not fit mean notes are invisible.
    // HOLDBACK: the arm hides notes by its old limits, which no audit changes. So the notice counts
    // what the new policy hides, as `kb budget` does.
    const { hiddenBy, globalAudit } = context.holdback ? contextFor(store, repo.scope, repo.root) : context;
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
    // Repo notes rank first, so the notice says whose notes are hidden: an audit covers one scope only.
    const hidden = [hiddenBy.repo > 0 ? count(hiddenBy.repo, "note") + " of this repo" : "", hiddenBy.global > 0 ? count(hiddenBy.global, "global note") : ""].filter(Boolean);
    const verb = hiddenBy.repo + hiddenBy.global === 1 ? "is" : "are";
    if (globalAudit) {
      notices.push(`The global kb notes do not fit the index: ${hidden[0]} ${verb} hidden here, and no note of this repo is. Tell the user in one line, in your first reply, that /kb:audit outside any repo, the global audit, fixes this. An audit of this repo does not.`);
    } else if (hidden.length > 0) {
      notices.push(`The kb store is over its index budget here: ${hidden.join(" and ")} ${verb} hidden from the index. Tell the user in one line, in your first reply, that /kb:audit fixes this.`);
    }
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
  const { briefs, index, bodies } = context.charsBy;
  logEvent(store, {
    ev: "start",
    ...hookWho(input),
    scope: context.scope ?? "global",
    source: typeof input.source === "string" ? input.source : "unknown",
    // HOLDBACK: the flag says which policy this start had. Only the hold-back arm has bodies.
    holdback: context.holdback,
    briefs: context.briefs,
    bodies: context.bodies,
    index: context.index,
    triggerOnly: context.triggerOnly,
    // In no session: the index line did not fit the character budget. HOLDBACK: or the note is over an old limit of the arm.
    hidden: context.hidden,
    chars: { fixed: output.length - briefs - index - bodies, briefs, index, bodies, total: output.length },
  });
  // Fetch changes from other machines in the background, at most once per 5 minutes.
  kickSync(store, 5 * 60_000);
} catch {
  // The rules for saving reach every session, also one with a broken store: `kb add` says what is wrong.
  process.stdout.write(rulesOnly());
}
process.exit(0);
