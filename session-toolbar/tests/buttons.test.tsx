import { expect, test } from 'claude-code/testing'

import { PROGRESS_PROMPT } from '../hooks/register'

const BAND = {
  plugin: 'session-toolbar',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

test('旁问 fills /btw and 撤回 runs /rewind', async ($, on) => {
  const commands: string[] = []
  const fills: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.run', (_, e) => {
    commands.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await band.press({ key: 'btw' })
  await band.press({ key: 'rewind' })
  expect(fills).toEqual(['/btw '])
  expect(commands).toEqual(['/rewind'])
})

test('进度 sends the three-part progress request as Momo’s own words', async ($, on) => {
  const sent: { text: string; asUser?: boolean }[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'progress' })
  expect(sent).toEqual([{ text: PROGRESS_PROMPT, asUser: true }])
  expect(PROGRESS_PROMPT).toMatch(/需要我决定的事/)
  expect(PROGRESS_PROMPT).toMatch(/已经完成的事/)
  expect(PROGRESS_PROMPT).toMatch(/下一步怎么推进/)
  expect(PROGRESS_PROMPT).toMatch(/先快速核对实际状态/)
  expect(PROGRESS_PROMPT).toMatch(/不要开始新的工作/)
})

test('进度 says so when the request could not be sent', async ($, on) => {
  const toasts: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', () => {
    throw new Error('no session')
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'progress' })
  for (let i = 0; i < 200 && !toasts.some(t => t.includes('没能发出')); i++) await Promise.resolve() // the rejection lands a few microtasks after the press settles
  expect(toasts.some(t => t.includes('没能发出进度请求'))).toBe(true)
})

// session-usage's cache reading as that mod would have written it: undefined while it is not installed.
function usageCacheOf(value: { at: number; ttlMs: number; tokens: number } | undefined) {
  return (_: unknown, e: { plugin: string; key: string }, next: (e: never) => unknown) =>
    e.plugin === 'session-usage' && e.key === 'cache' ? { value: { value, version: value ? 1 : 0 } } : next(e as never)
}

test('with session-usage installed, 压缩 asks for a second press once its cache reading has gone cold', async ($, on) => {
  let now = Date.parse('2026-10-25T07:00:00Z')
  const commands: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // A reply that cached 150k tokens for an hour, as session-usage recorded it.
  on('state.get', usageCacheOf({ at: now, ttlMs: 60 * 60_000, tokens: 150_000 }) as never)
  on('command.run', (_, e) => {
    commands.push(e.command)
    return {}
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '缓存已过期，交接比压缩更省' })).toBeUndefined()
  await band.press({ key: 'compact' }) // warm: runs at once
  expect(commands).toEqual(['compact'])
  now += 61 * 60_000 // past the hour
  await band.press({ key: 'compact' }) // cold: only warns
  expect(commands).toEqual(['compact'])
  const later = await $.ui.mount({ ...BAND, requestId: 'band-later', surface: 'desktop' })
  expect(await later.find({ type: 'Text', text: /再点一次“压缩”确认/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: '缓存已过期，交接比压缩更省' })).toBeDefined()
  await later.press({ key: 'compact' }) // confirmed within ten seconds
  expect(commands).toEqual(['compact', 'compact'])
})

test('without session-usage, the toolbar shows no cache hint and 压缩 runs at once', async ($, on) => {
  let now = Date.parse('2026-10-25T07:00:00Z')
  const commands: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('state.get', usageCacheOf(undefined) as never)
  on('command.run', (_, e) => {
    commands.push(e.command)
    return {}
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  now += 3 * 60 * 60_000
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '缓存已过期，交接比压缩更省' })).toBeUndefined()
  await band.press({ key: 'compact' })
  expect(commands).toEqual(['compact'])
})

test('a nonsensical cache reading from session-usage counts as none', async ($, on) => {
  const commands: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('state.get', usageCacheOf({ at: Date.parse('2026-10-25T07:00:00Z'), ttlMs: -1, tokens: 150_000 }) as never)
  on('command.run', (_, e) => {
    commands.push(e.command)
    return {}
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '缓存已过期，交接比压缩更省' })).toBeUndefined()
  await band.press({ key: 'compact' })
  expect(commands).toEqual(['compact'])
})

test('the toolbar draws below the sub-agent band and above the usage details, whichever is outer', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  // The other two mods' bands beneath this one, the usage details first.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="momo-bands" flexDirection="column" gap="md">
        <Box key="momo-band-3-usage"><Text>usage</Text></Box>
        <Box key="momo-band-1-agents"><Text>agents</Text></Box>
      </Box>
    )
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The toolbar's rows get the surface's small gap: desktop spaces them, the terminal keeps one line each.
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.drawn()).toMatchObject({
      type: 'Box', props: { key: 'momo-bands', gap: 'md' },
      children: [
        { type: 'Box', props: { key: 'momo-band-1-agents' } },
        { type: 'Box', props: { key: 'momo-band-2-toolbar', gap: 'sm' } },
        { type: 'Box', props: { key: 'momo-band-3-usage' } },
      ],
    })
  }
})

const PANE = {
  plugin: 'session-toolbar',
  component: 'Pane',
  requestId: 'session-toolbar',
  props: { title: '工具栏', isFocused: false, bodyColumns: 30, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the phone gets the toolbar as a pane: it opens when a phone joins, and its buttons work', async ($, on) => {
  const opened: string[] = []
  const fills: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'toolbar' } }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('ui.open', (_, e) => {
    opened.push(`${e.id}:${e.title}`)
    return { value: { isPlaced: true } }
  })
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  for (let i = 0; i < 20 && opened.length === 0; i++) await Promise.resolve() // the open is not awaited by the attach
  expect(opened).toEqual(['session-toolbar:工具栏'])

  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  for (const key of ['progress', 'handoff', 'compact', 'rewind', 'btw', 'closeout']) expect(await pane.find({ key })).toBeDefined()
  await pane.press({ key: 'btw' })
  expect(fills).toEqual(['/btw '])
  await pane.unmount()
})

test('/toolbar opens the pane, and lists the commands when it cannot', async ($, on) => {
  let reason: string | undefined
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'toolbar' } }))
  on('ui.open', () => ({ value: reason ? { isPlaced: false, reason } : { isPlaced: true } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'toolbar', args: '' } as never)).text).toBe('工具栏面板已打开。')
  reason = 'no-surface'
  const text = (await $.command.run({ command: 'toolbar', args: '' } as never)).text
  expect(text).toMatch(/\/progress（进度）/)
  expect(text).not.toMatch(/no-surface|面板没能打开/)
})

const OUTPUT = {
  plugin: 'session-toolbar',
  component: 'CommandOutput',
  requestId: 'out',
  props: { command: 'toolbar', args: '', text: '工具栏', isErrored: false },
} as const

test('/toolbar draws the six buttons in its own output row, which the phone draws too', async ($, on) => {
  const fills: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'toolbar' } }))
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const row = await $.ui.mount({ ...OUTPUT, surface: 'mobile' })
  for (const key of ['progress', 'handoff', 'compact', 'rewind', 'btw', 'closeout']) expect(await row.find({ key })).toBeDefined()
  await row.press({ key: 'btw' })
  expect(fills).toEqual(['/btw '])
  await row.unmount()
  const other = await $.ui.mount({ ...OUTPUT, props: { ...OUTPUT.props, command: 'cost' }, surface: 'mobile' })
  expect(await other.find({ key: 'btw' })).toBeUndefined()
  await other.unmount()
})

test('/progress sends the same request as 进度, just after the command returns', async ($, on) => {
  const sent: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'progress', args: '' } as never)).text).toMatch(/正在发出进度请求/)
  for (let i = 0; i < 200 && sent.length === 0; i++) await Promise.resolve() // sent after the hook has returned
  expect(sent).toEqual([PROGRESS_PROMPT])
})

test('/closeout runs 收尾 by name and prints what it found', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await $.command.run({ command: 'closeout', args: '' } as never)).text).toMatch(/^❓ 收尾检查没完成/)
})

