// /kb:clear: the save of /kb:save, then /clear, but only when the save fully succeeded.
// A skill cannot run /clear: only the user or a mod can. This mod arms when the user runs
// /kb:clear, watches the turn for a `kb checkpointed` that succeeds, and at the end of the
// turn runs /clear when the answer starts with the verdict "Safe to clear".
import type { Register } from 'claude-code'

/** The verdict line that the save skill's report starts with. */
export const SAFE = /^\s*\*\*Safe to clear\*\*/

/** A shell command that records the save: `kb checkpointed <session>`, alone or in a chain. */
export const RECORDS_SAVE = /(^|[\s;&|(])kb\s+checkpointed\b/

/** Why a /kb:clear did not clear, in one line for the user. */
export function whyNot(state: { saved: boolean; reason: string; answer: string }): string | null {
  if (state.reason !== 'answer') return 'the save did not finish'
  if (!state.saved) return 'the save was not recorded (kb checkpointed did not run or failed)'
  if (!SAFE.test(state.answer)) return /\*\*Not safe to clear\*\*/.test(state.answer) ? 'the save says it is not safe' : 'the save asked a question or did not report'
  return null
}

export const register: Register = on => {
  // Module state: one /kb:clear at a time, for one turn. A reload drops it, and the session stays.
  let armed = false
  let saved = false

  // The command and Bash hooks only watch. If one fails, the call goes on as it would without
  // the mod: before next it runs, and after next its result stands, never run a second time.
  on('command.run', { command: 'kb:clear' }, async ($, e, next) => {
    armed = true
    saved = false
    return next(e)
  }).catch(async ($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (armed && e.agentId === undefined && RECORDS_SAVE.test(e.command) && 'result' in result && !result.isError) saved = true
    return result
  }).catch(async ($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!armed || e.agentId !== undefined) return result
    armed = false

    const why = whyNot({ saved, reason: e.reason, answer: e.answer })
    if (why !== null) {
      $.ui.toast(`Not cleared: ${why}`)
      return result
    }
    // The report scrolls away with the cleared session, so its first line stays as a toast.
    const verdict = e.answer.trim().split('\n')[0]?.replace(/\*\*/g, '') ?? 'Safe to clear'
    $.ui.toast(`Clearing after /kb:clear. ${verdict}`)
    // The turn waits on this hook, so /clear runs once the hook lets go.
    $.clock.after(250, () => void $.command.run({ command: 'clear', args: '' }))
    return result
  })
}
