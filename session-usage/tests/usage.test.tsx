import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { nextBases, paceOut } from '../hooks/register'

const BAND = {
  plugin: 'session-usage',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

test('pace shows only when the window would run out before it resets', () => {
  const now = Date.parse('2026-10-25T07:00:00Z')
  const base = { at: now - 30 * 60_000, pct: 40, resetsAt: '2026-10-25T10:00:00Z' }
  // 40% -> 70% in 30 minutes: the last 30% takes 30 more minutes, before the 3-hour reset.
  expect(paceOut(base, { kind: 'five_hour', percentUsed: 70, resetsAt: base.resetsAt }, now, now)).toBe('按现在速度约 30m 后用完')
  // Ten minutes on with no new reading: the same rate, ten minutes less to go.
  expect(paceOut(base, { kind: 'five_hour', percentUsed: 70, resetsAt: base.resetsAt }, now, now + 10 * 60_000)).toBe('按现在速度约 20m 后用完')
  // A reset one quarter of an hour away comes first.
  expect(paceOut({ ...base, resetsAt: '2026-10-25T07:15:00Z' }, { kind: 'five_hour', percentUsed: 70, resetsAt: '2026-10-25T07:15:00Z' }, now, now)).toBe('')
  // Too short a stretch to judge.
  expect(paceOut({ ...base, at: now - 60_000 }, { kind: 'five_hour', percentUsed: 70, resetsAt: base.resetsAt }, now, now)).toBe('')
})

test('a window missing from one reading keeps its base for the period', () => {
  const w = { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-25T10:00:00Z' }
  const first = nextBases({}, [w], 1000)
  const absent = nextBases(first, [], 2000)
  const back = nextBases(absent, [{ ...w, percentUsed: 55 }], 3000)
  expect(back.five_hour).toEqual({ at: 1000, pct: 40, last: 55, resetsAt: w.resetsAt })
  // A rolling window that drops (70 -> 55) starts a new base.
  const dropped = nextBases(nextBases(first, [{ ...w, percentUsed: 70 }], 2500), [{ ...w, percentUsed: 55 }], 3500)
  expect(dropped.five_hour).toEqual({ at: 3500, pct: 55, last: 55, resetsAt: w.resetsAt })
  const reset = nextBases(back, [{ ...w, percentUsed: 2, resetsAt: '2026-10-25T15:00:00Z' }], 4000)
  expect(reset.five_hour).toEqual({ at: 4000, pct: 2, last: 2, resetsAt: '2026-10-25T15:00:00Z' })
})

test('the footer label leads with the context fill, and no five-hour window', async ($, on) => {
  const usage = {
    startedAt: 0,
    context: { window: 1_000_000, breakdown: { rawMaxTokens: 1_000_000, totalTokens: 420_000, percentage: 42, categories: [], isAutoCompactEnabled: false } },
    rateLimits: [{ kind: 'seven_day', percentUsed: 80, resetsAt: '2026-10-26T12:00:00Z' }],
  }
  on('session.usage', () => ({ value: usage as never })) // only the breakdown fields the mod reads
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'session-usage', component: 'SessionMode', requestId: 'mode', props: { modes: [] }, surface: 'desktop' })
  for (let i = 0; i < 20 && (await footer.find({ type: 'Button', key: 'usage' }))?.text?.startsWith('上下文 —'); i++) await footer.redraw()
  expect((await footer.find({ type: 'Button', key: 'usage' }))?.text).toBe('上下文 42% | 7d 80% | 缓存 —')
})

test('the footer label carries no warning marks, and times read m/h/d', async ($, on) => {
  const usage = {
    startedAt: 0,
    context: { window: 1_000_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-25T07:09:00Z' },
      { kind: 'seven_day', percentUsed: 80, resetsAt: '2026-10-26T12:00:00Z' },
      { kind: 'spend_limit', percentUsed: 76 },
    ],
  }
  on('session.usage', () => ({ value: usage }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'session-usage', component: 'SessionMode', requestId: 'mode', props: { modes: [] }, surface: 'desktop' })
  expect((await footer.find({ type: 'Button', key: 'usage' }))?.text).toBe('上下文 — | 7d 80% | 缓存 —')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await footer.press({ key: 'usage' })
  expect(await band.find({ type: 'Text', text: '9m 后重置' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^1d 5h 后重置/ })).toBeDefined()
})

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1000, model: 'm' }

function stepper(on: On, clock: { now: number }) {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-27T05:00:00Z' }] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: clock.now }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('turn.step', async function* (_, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as never })
  on('turn.complete', () => ({ text: '' }))
}

async function step($: Engine, turnId: string, agentId?: string) {
  const s = $.turn.step({ turnId, index: 0, model: 'm', agentId } as never)
  for await (const _ of s) { /* drain */ }
  return s.result
}

async function cacheLabel($: Engine) {
  const footer = await $.ui.mount({ plugin: 'session-usage', component: 'SessionMode', requestId: 'mode', props: { modes: [] }, surface: 'desktop' })
  const text = (await footer.find({ type: 'Button', key: 'usage' }))?.text
  await footer.unmount()
  return text?.split(' | ').pop()
}

test('each main-loop step of a long turn renews the cache countdown; a sub-agent step does not', async ($, on) => {
  const clock = { now: Date.parse('2026-10-27T01:00:00Z') }
  stepper(on, clock)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step($, 't1')
  clock.now += 50 * 60_000
  expect(await cacheLabel($)).toBe('缓存 10m')
  // Still inside the same turn, 50 minutes on: the request renews the cache.
  await step($, 't1')
  expect(await cacheLabel($)).toBe('缓存 60m')
  clock.now += 30 * 60_000
  await step($, 't2', 'sub-agent')
  expect(await cacheLabel($)).toBe('缓存 30m')
  // The turn's end does not move it back to a summed or older stamp.
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false, usage: USAGE } as never)
  expect(await cacheLabel($)).toBe('缓存 30m')
})
