// The /kb:clear mod. Run with `claude plugin test hooks` (bun test runs only test/).
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const REPORT = '**Safe to clear** - 2 saved, 1 updated\n\n**Saved**\n- **A note**'

const answer = (text: string, opts: { agentId?: string; reason?: string } = {}) =>
  ({ answer: text, durationMs: 1, isAborted: opts.reason === 'aborted', turnId: text, reason: opts.reason ?? 'answer', agentId: opts.agentId }) as never

// The engine beneath the mod: commands that run, Bash calls that answer, turns that end.
function world(on: On) {
  const ran: string[] = []
  const toasts: string[] = []
  on('command.run', ($, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  on('tool.call', ($, e) => ({ result: { stdout: '', stderr: '' }, isError: e.tool === 'Bash' && String((e as { command?: string }).command).includes('FAIL') }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: string }).text ?? e))
    return { value: undefined } as never
  })
  return { ran, toasts, clock: mock.clock(on) }
}

async function kbClear($: Engine, opts: { record?: string | null; report?: string; reason?: string; agentEndsFirst?: boolean } = {}) {
  await $.command.run({ command: 'kb:clear', args: '' } as never)
  const record = opts.record === undefined ? 'kb checkpointed abc-123' : opts.record
  if (record !== null) await $.tool.call({ tool: 'Bash', command: record } as never)
  if (opts.agentEndsFirst) await $.turn.complete(answer('found it', { agentId: 'agent-1' }))
  await $.turn.complete(answer(opts.report ?? REPORT, { reason: opts.reason }))
}

test('a save that succeeded clears the session', async ($, on) => {
  const w = world(on)
  await kbClear($)
  await w.clock.advance(250)
  expect(w.ran).toEqual(['kb:clear', 'clear'])
  expect(w.toasts).toEqual(['Clearing after /kb:clear. Safe to clear - 2 saved, 1 updated'])
})

test('a subagent that ends during the save does not end the watch', async ($, on) => {
  const w = world(on)
  await kbClear($, { agentEndsFirst: true })
  await w.clock.advance(250)
  expect(w.ran).toEqual(['kb:clear', 'clear'])
})

test('no clear when kb checkpointed did not run', async ($, on) => {
  const w = world(on)
  await kbClear($, { record: null })
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:clear'])
})

test('no clear when kb checkpointed failed', async ($, on) => {
  const w = world(on)
  await kbClear($, { record: 'kb checkpointed abc-123 FAIL' })
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:clear'])
})

test('no clear when the verdict is not safe', async ($, on) => {
  const w = world(on)
  await kbClear($, { report: '**Not safe to clear** - a kb add failed' })
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:clear'])
  expect(w.toasts).toEqual(['Not cleared: the save says it is not safe'])
})

test('no clear when the save stops to ask a question', async ($, on) => {
  const w = world(on)
  await kbClear($, { report: 'This rule is about this repo only. May I add it to CLAUDE.md?' })
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:clear'])
})

test('no clear when the turn was interrupted', async ($, on) => {
  const w = world(on)
  await kbClear($, { reason: 'aborted' })
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:clear'])
})

test('/kb:save never clears', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'kb:save', args: '' } as never)
  await $.tool.call({ tool: 'Bash', command: 'kb checkpointed abc-123' } as never)
  await $.turn.complete(answer(REPORT))
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:save'])
})

test('the watch lasts one turn', async ($, on) => {
  const w = world(on)
  await kbClear($, { report: 'May I add it to CLAUDE.md?' })
  await $.tool.call({ tool: 'Bash', command: 'kb checkpointed abc-123' } as never)
  await $.turn.complete(answer(REPORT))
  await w.clock.advance(1000)
  expect(w.ran).toEqual(['kb:clear'])
})
