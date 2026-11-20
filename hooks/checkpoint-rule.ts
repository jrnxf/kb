// The line that tells the agent when to suggest /kb:clear. Its own file, so a test can import
// it without running the SessionStart hook.

/**
 * When to suggest a save and a clear. Only the user can start /kb:clear, so the agent says the
 * line, and the user decides. A rule, not a notice: it must hold for the whole session, also after
 * a compaction, and a notice that does not fit is left out.
 */
export const CHECKPOINT_RULE =
  'Once per breakpoint, say in one line "Good time to /kb:clear." when a task landed or the context is large, and the session learned something worth saving. /kb:clear saves the session, then clears it if the save succeeded. Not while you wait on CI or a review you must act on, and not after a save with nothing since. Only the user can run it.';
