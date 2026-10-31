import { expect, test } from 'claude-code/testing'

const FOOTER = { plugin: 'session-usage', component: 'SessionMode', requestId: 'mode', props: { modes: [] } } as const
const BAND = {
  plugin: 'session-usage',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

const USAGE = {
  startedAt: 0,
  context: { window: 1_000_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 15, resetsAt: '2099-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 71, resetsAt: '2099-01-01T00:00:00Z' },
  ],
  cost: { usd: 10.67 },
}

for (const beneath of ['engine node', 'another band'] as const) {
  test(`a click on the footer label opens the details above the prompt on desktop (${beneath} beneath)`, async ($, on) => {
    on('session.usage', () => ({ value: USAGE }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
    on('clock.every', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', () => ({ value: undefined }))
    on('fs.read', () => ({ value: '' }))
    on('fs.write', () => ({ value: undefined }))
    // What the engine, or a band mod beneath, draws in each place.
    on('ui.render', ($, e) => {
      if (beneath === 'another band' && e.component === 'AbovePrompt') {
        const { Text } = $.ui.resolve(e)
        return <Text>other band</Text>
      }
      return { type: 'engine', ref: 0 }
    })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await footer.find({ type: 'Button', key: 'usage' }))?.text).toBe('7d 71% | 上下文 — | 缓存 —')
    expect(await band.find({ type: 'Text', text: '5h' })).toBeUndefined()

    await footer.press({ key: 'usage' })
    await band.drawn() // rejects with the surface's refusal if the details cannot be drawn
    expect((await band.find({ type: 'Text', text: '5h' }))?.text).toBe('5h')
    expect((await band.find({ type: 'Text', text: '15%' }))?.text).toBe('15%')
    expect((await band.find({ type: 'Text', text: '$10.67' }))?.text).toBe('$10.67')
    expect(await band.find({ type: 'Text', text: /重置/ })).toBeDefined()

    await footer.press({ key: 'usage' })
    expect(await band.find({ type: 'Text', text: '5h' })).toBeUndefined()
  })
}
