// The line that tells the agent when to suggest /kb:checkpoint. Its own file, so a test can import
// it without running the SessionStart hook.

/**
 * When to suggest a checkpoint. Only the user can start /kb:checkpoint and /clear, so the agent
 * says the line, and the user decides. A rule, not a notice: it must hold for the whole session,
 * also after a compaction, and a notice that does not fit is left out.
 */
export const CHECKPOINT_RULE =
  'Once per breakpoint, say in one line "Good time to /kb:checkpoint, then /clear." when a task landed or the context is large, and the session learned something worth saving. Not while you wait on CI or a review you must act on, and not after a checkpoint with nothing since. Only the user can run these commands.';
