import type { AgentInfo, AgentSpawnInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { latestStep } from '../hooks/register'

const BAND = {
  plugin: 'agent-watch', component: 'AbovePrompt', requestId: 'agents', surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function setup(on: On, surfaces: ('desktop' | 'mobile')[] = ['desktop'], paneFailure?: string) {
  const paneErrors = new Set<string>()
  const opened = panes(on, surfaces, paneFailure, paneErrors)
  const world = { beneath: 'text' as 'text' | 'bands', lists: 0, list: [] as AgentInfo[], task: 0, failList: false, failClock: false, periods: 0, afters: 0, refusePeriods: [] as number[], refuseAllPeriods: false, hold: undefined as Promise<void> | undefined }
  on('clock.*', (_, e, next) => {
    if (next.is('clock.now', e) && world.failClock) return { deny: 'Clock unavailable' }
    if (next.is('clock.every', e) && (world.refusePeriods.includes(++world.periods) || world.refuseAllPeriods)) return { deny: 'Interval refused or ended' }
    if (next.is('clock.after', e)) world.afters++
    return next(e)
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('agent.list', async () => {
    world.lists++
    if (world.failList) return { deny: 'Agent list unavailable' }
    const snap = world.list.map(a => ({ ...a }))
    // A held list answers with what it saw before the hold was released.
    if (world.hold) { const held = world.hold; world.hold = undefined; await held }
    return { value: snap }
  })
  on('agent.spawn', (_, e) => {
    const id = e.description
    if (!e.workflow) world.list.push({ id, description: e.description, type: e.subagentType, status: 'running', parentId: e.parentAgentId })
    return { agentId: id, model: 'resolved-model' }
  })
  on('turn.step', async function* (_, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as never })
  on('classic.Stop', () => ({}))
  on('turn.complete', (_, e) => {
    world.list = world.list.filter(a => a.id !== e.agentId)
    return { text: e.answer }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++world.task), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // The two other mods' bands, stacked in the wrong order, as the engine may nest them.
    if (world.beneath === 'bands') return (
      <Box key="momo-bands" flexDirection="column" gap="md">
        <Box key="momo-band-3-usage"><Text>usage</Text></Box>
        <Box key="momo-band-2-toolbar"><Text>toolbar</Text></Box>
        <Text>other band</Text>
      </Box>
    )
    return <Text>other band</Text>
  })
  return { clock, world, opened, paneErrors }
}

function spawn($: Engine, description = 'Research', extra: Partial<AgentSpawnInput> = {}) {
  return $.agent.spawn({
    tool_use_id: description, prompt: 'PRIVATE PROMPT', description, subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'parent-model', background: true, fork: false, ...extra,
  })
}

function finish($: Engine, agentId: string, reason: 'answer' | 'error' | 'aborted' = 'answer') {
  return $.turn.complete({ agentId, reason, answer: '', durationMs: 1000, isAborted: reason === 'aborted', turnId: agentId })
}

async function step($: Engine, turnId = 'main', index = 0, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'model', agentId } as never)
  for await (const _ of stream) { /* drain */ }
  return stream.result
}

function finishTurn($: Engine, turnId = 'main') {
  return $.turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 0, isAborted: false })
}

const BACKGROUND = {
  background_tasks: [
    { id: 'shell', type: 'shell', status: 'running', description: 'Run checks' },
    { id: 'monitor', type: 'monitor', status: 'pending', description: 'Watch checks' },
    { id: 'workflow', type: 'workflow', status: 'running', description: 'Review changes' },
    { id: 'other', type: 'unknown', status: 'running', description: 'Other work' },
    { id: 'agent', type: 'subagent', status: 'running', description: 'Counted separately' },
    { id: 'done', type: 'shell', status: 'completed', description: 'Finished work' },
    { id: 'failed', type: 'shell', status: 'failed', description: 'Failed work' },
  ],
  session_crons: [{ id: 'cron', schedule: '* * * * *', recurring: true, prompt: 'PRIVATE PROMPT' }],
}

test('the status line says 正在工作 and how long while a turn runs', async ($, on) => {
  const { clock, world } = setup(on)
  await step($)
  expect(world.periods).toBe(1)
  await clock.advance(42_000)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true } })
  expect((await band.find({ key: 'agents' }))?.text).toBe('● 正在工作 42s')
  await step($, 'main', 1)
  await clock.advance(150_000)
  expect((await band.find({ key: 'agents' }))?.text).toBe('● 正在工作 3m 12s')
  await spawn($)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [BACKGROUND.background_tasks[0]!] })
  expect((await band.find({ key: 'agents' }))?.text).toBe('● 正在工作 3m 12s · 子助手 1 在跑 · 后台命令 1')
  await finish($, 'Research')
  await step($, 'child-turn', 0, 'child')
  await clock.advance(1000)
  expect((await band.find({ key: 'agents' }))?.text).toContain('正在工作 3m 13s')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '这一轮已做 3m 13s' })).toBeDefined()
})

test('the status line says what the chat waits on after a turn ends with background work', async ($, on) => {
  const { clock } = setup(on)
  await step($)
  await spawn($)
  await finishTurn($)
  await $.classic.Stop({ stop_hook_active: false, ...BACKGROUND })
  await clock.advance(240_000)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('◐ 已停下，在等后台 · 子助手 1 · 后台命令 1 · 监控 1 · 流程 1 · 其他后台 1 · 定时唤醒 1 · 已等 4m')
  await $.classic.Stop({ stop_hook_active: false, agent_id: 'child', background_tasks: [] })
  expect((await band.find({ key: 'agents' }))?.text).toContain('后台命令 1')
  await $.classic.Stop({ stop_hook_active: false })
  expect((await band.find({ key: 'agents' }))?.text).toBe('◐ 已停下，在等后台 · 子助手 1 · 已等 4m')
  await finish($, 'Research')
  await $.classic.Stop({ stop_hook_active: false, session_crons: BACKGROUND.session_crons })
  expect((await band.find({ key: 'agents' }))?.text).toBe('◐ 已停下，在等后台 · 定时唤醒 1 · 已等 4m')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务 · 上一轮做了 0s')
})

test('the status line says nothing runs and how long the last turn took', async ($, on) => {
  const { clock, world } = setup(on)
  await step($)
  await clock.advance(720_000)
  await finishTurn($)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务 · 上一轮做了 12m 0s')
  const lists = world.lists
  await clock.advance(5000)
  expect(world.lists).toBe(lists)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '上一轮做了 12m 0s' })).toBeDefined()
  // Check hour formatting without replaying thousands of one-second redraws.
  world.refuseAllPeriods = true
  await step($, 'next')
  await clock.advance(3_900_000)
  await finishTurn($, 'next')
  expect((await band.find({ key: 'agents' }))?.text).toContain('上一轮做了 1h 5m')
})

test("a background task's command is never recorded", async ($, on) => {
  setup(on)
  const writes: unknown[] = []
  on('state.set', { plugin: 'agent-watch', key: 'background' }, (_, e, next) => {
    writes.push(e.value)
    return next(e)
  })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [
    { id: 'shell', type: 'shell', description: '🔎'.repeat(100), command: 'PRIVATE SECRET COMMAND' },
  ] } as never)
  const expected = { tasks: [{ id: 'shell', type: 'shell', description: '🔎'.repeat(80) }], crons: 0 }
  expect(writes).toEqual([expected])
  const band = await $.ui.mount(BAND)
  expect(JSON.stringify(writes)).not.toContain('command')
  expect((await band.find({ key: 'agents' }))?.text).toContain('后台命令 1')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: `后台命令 · ${'🔎'.repeat(80)}` })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'PRIVATE SECRET COMMAND' })).toBeUndefined()
})

test('pressing 详情 opens the pane and pressing it again closes it', async ($, on) => {
  const { opened } = setup(on)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'details' }))?.text).toBe('详情 ›')
  await band.press({ key: 'details' })
  expect(opened).toEqual(['agent-watch'])
  expect((await band.find({ key: 'details' }))?.text).toBe('详情 ‹')
  await band.press({ key: 'details' })
  expect(opened).toEqual([])
  expect((await band.find({ key: 'details' }))?.text).toBe('详情 ›')
  expect(await band.find({ key: 'agents' })).toBeDefined()
})

test('the pane shows 当前任务 and the background tasks', async ($, on) => {
  const { clock } = setup(on)
  await step($)
  await clock.advance(42_000)
  await finishTurn($)
  await $.classic.Stop({ stop_hook_active: false, ...BACKGROUND })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: '当前任务' }))?.props.bold).toBe(true)
  expect(await pane.find({ type: 'Text', text: /^◐ 已停下，在等后台$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '上一轮做了 42s' })).toBeDefined()
  for (const text of ['后台 5', '后台命令 · Run checks', '监控 · Watch checks', '流程 · Review changes', '其他后台 · Other work', '定时唤醒 1 个']) {
    expect(await pane.find({ type: 'Text', text })).toBeDefined()
  }
  expect(await pane.find({ type: 'Text', text: /PRIVATE|Counted separately|Finished work|Failed work/ })).toBeUndefined()
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  expect(await pane.find({ type: 'Text', text: /^后台 / })).toBeUndefined()
})

test('spawn adds a running row with description, type and model', async ($, on) => {
  setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toContain('子助手 1')
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await band.drawn()
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toBe('⏳ Research · Explore · resolved-model · 0s · 0 步')
  expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
})

test('a sub-agent tool call counts a step and sets the latest step; a main-loop call does not', async ($, on) => {
  setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.tool.call({ tool: 'Read', agentId: 'Research', file_path: '/private/source/main.ts' })
  await $.tool.call({ tool: 'Bash', command: 'main-loop secret' })
  await $.tool.call({ tool: 'Bash', agentId: 'workflow-id', command: 'not a listed agent' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain('1 步')
  expect((await pane.find({ type: 'Text', text: '└' }))?.text).toBe('└ Read main.ts')
  expect((await band.find({ key: 'agents' }))?.text).toContain('子助手 1')
})

test('tasks created and completed by the agent show as 待办 d/t', async ($, on) => {
  setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.tool.call({ tool: 'TaskCreate', agentId: 'Research', subject: 'One', description: 'private' })
  await $.tool.call({ tool: 'TaskCreate', agentId: 'Research', subject: 'Two', description: 'private' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Main', description: 'private' })
  await $.tool.call({ tool: 'TaskUpdate', agentId: 'Research', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', agentId: 'Research', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', agentId: 'Research', taskId: '3', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain('待办 1/2')
  await $.tool.call({ tool: 'TaskUpdate', agentId: 'Research', taskId: '1', status: 'in_progress' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain('待办 0/2')
})

test('turn.complete marks the agent done, or failed on error or aborted', async ($, on) => {
  setup(on)
  for (const name of ['Done', 'Error', 'Abort']) await spawn($, name)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await finish($, 'Done')
  await finish($, 'Error', 'error')
  await finish($, 'Abort', 'aborted')
  await pane.press({ key: 'done' })
  expect(await pane.find({ type: 'Text', text: '✅ Done' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '✗ Error' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '✗ Abort' })).toBeDefined()
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('the line stays visible without agents and after completion, but yields to a survey', async ($, on) => {
  const { clock } = setup(on)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
  await spawn($)
  expect(await band.find({ key: 'agents' })).toBeDefined()
  await band.redraw({ ...BAND.props, hasSurvey: true })
  expect(await band.find({ key: 'agents' })).toBeUndefined()
  await band.redraw(BAND.props)
  await finish($, 'Research')
  await clock.advance(119_999)
  expect(await band.find({ key: 'agents' })).toBeDefined()
  await clock.advance(1)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('the summary counts running, done and failed, with the details in the pane', async ($, on) => {
  const { clock } = setup(on)
  for (const name of ['Running', 'Done', 'Failed']) await spawn($, name)
  await finish($, 'Done')
  await finish($, 'Failed', 'error')
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toContain('子助手 1')
  expect(await band.find({ type: 'Text', text: '⏳ Running' })).toBeUndefined()
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '子助手 1 运行中 · 1 完成 · 1 失败' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '⏳ Running' })).toBeDefined()
  await finish($, 'Running')
  await clock.advance(120_000)
  await pane.press({ key: 'done' })
  expect(await pane.find({ type: 'Text', text: '✅ Running' })).toBeDefined()
  await band.press({ key: 'agents' })
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('an agent spawned by another agent is indented under it', async ($, on) => {
  const { clock } = setup(on)
  await spawn($, 'Parent')
  await clock.advance(1000)
  await spawn($, 'Child', { parentAgentId: 'Parent' })
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Box', key: 'Parent' }))?.props.marginLeft).toBe(0)
  expect((await pane.find({ type: 'Box', key: 'Child' }))?.props.marginLeft).toBe(2)
  expect((await pane.findAll({ type: 'Text', text: /^⏳/ })).map(a => a.text.split(' · ')[0])).toEqual(['⏳ Parent', '⏳ Child'])
})

test('an agent listed by agent.list but never seen spawning still appears', async ($, on) => {
  const { world } = setup(on)
  world.list = [{ id: 'unseen', description: 'Already running', type: 'general-purpose', status: 'running' }]
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: 'Already running' }))?.text).toBe('⏳ Already running · general-purpose · — · — · 0 步')
})

test('the latest step never exceeds 60 characters and never shows a prompt', async ($, on) => {
  setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.tool.call({ tool: 'Agent', agentId: 'Research', prompt: 'PRIVATE PROMPT', description: 'Safe description' })
  expect((await pane.find({ type: 'Text', text: '└' }))?.text).toBe('└ Agent Safe description')
  expect(await pane.find({ type: 'Text', text: 'PRIVATE PROMPT' })).toBeUndefined()
  const cases = [
    { tool: 'Bash', command: 'x'.repeat(200) },
    { tool: 'Bash', command: 'private command', description: 'Safe command' },
    { tool: 'Read', file_path: 'C:\\private\\main.ts' },
    { tool: 'Edit', file_path: '/private/main.ts', old_string: 'PRIVATE CONTENT', new_string: 'PRIVATE CONTENT' },
    { tool: 'Write', file_path: '/private/main.ts', content: 'PRIVATE CONTENT' },
    { tool: 'Grep', pattern: 'needle' },
    { tool: 'Glob', pattern: '*.tsx' },
    { tool: 'WebFetch', url: 'https://example.com', prompt: 'PRIVATE PROMPT' },
  ] as const
  for (const e of cases) {
    const step = latestStep(e)
    expect([...step].length).toBeLessThanOrEqual(60)
    expect(step).not.toContain('PRIVATE')
    expect(step).not.toContain('private')
  }
  expect(latestStep({ tool: 'Bash', command: 'private', description: 'Safe command' })).toBe('Bash Safe command')
})

test('agent.list overrides event status and includes waiting, idle and killed agents', async ($, on) => {
  const { world } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const status of ['waiting', 'idle', 'killed', 'completed', 'pending', 'running'] as const) {
    world.list[0]!.status = status
    await pane.redraw()
    if (status === 'killed') await pane.press({ key: 'done' })
    const icon = status === 'killed' ? '✗' : status === 'completed' ? '✅' : status === 'waiting' || status === 'idle' ? '⏸' : '⏳'
    expect(await pane.find({ type: 'Text', text: `${icon} Research` })).toBeDefined()
  }
})

test('pane rows are newest first and include every agent without inline rows', async ($, on) => {
  const { clock } = setup(on)
  for (let n = 0; n < 10; n++) {
    await spawn($, `Agent ${n}`)
    await clock.advance(1)
  }
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rows = await pane.findAll({ type: 'Text', text: /^⏳/ })
  expect(rows).toHaveLength(10)
  expect(rows[0]?.text).toContain('Agent 9')
  expect(rows[9]?.text).toContain('Agent 0')
  expect(await band.find({ type: 'Text', text: /^⏳/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /更多/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /更多/ })).toBeUndefined()
})

test('elapsed ticks while running and stops when completed or hidden by a survey', async ($, on) => {
  const { clock } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(2000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain(' · 2s · ')
  await finish($, 'Research')
  await clock.advance(2000)
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 2s · ')
  await band.redraw({ ...BAND.props, hasSurvey: true })
  expect(await band.find({ key: 'agents' })).toBeUndefined()
})

test('workflow agents are excluded even when their spawn is observed', async ($, on) => {
  setup(on)
  await spawn($, 'Workflow', { workflow: { runId: 'wf_test', agentIndex: 1 } })
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('a completed agent first discovered in agent.list remains in the pane after 120 s', async ($, on) => {
  const { clock, world } = setup(on)
  world.list = [{ id: 'unseen', description: 'Finished before reload', type: 'Explore', status: 'completed' }]
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  await clock.advance(60_000)
  await band.press({ key: 'agents' })
  await band.press({ key: 'agents' })
  await clock.advance(60_000)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'done' })
  expect(await pane.find({ type: 'Text', text: '✅ Finished before reload' })).toBeDefined()
})

test('a listed status change is polled and its completion time stays fixed', async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(1000)
  world.list[0]!.status = 'completed'
  await clock.advance(1000)
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 2s · ')
  await clock.advance(10_000)
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 2s · ')
  await band.press({ key: 'agents' })
  await clock.advance(110_000)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('there are no clock periods with no agents or after completion, a waiting agent ticks slowly, and a running agent ticks even under a survey', async ($, on) => {
  let status: AgentInfo['status'] | undefined
  let periods = 0
  let afters = 0
  on('agent.list', () => ({ value: status ? [{ id: 'listed', description: 'Listed', type: 'Explore', status }] : [] }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => { periods++; return { deny: 'Count scheduling without running a period' } })
  on('clock.after', () => { afters++; return { deny: 'Count scheduling without advancing time' } })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const band = await $.ui.mount(BAND)
  expect(periods).toBe(0)
  expect(afters).toBe(0)
  status = 'waiting'
  await band.redraw()
  expect(periods).toBe(1)
  status = 'running'
  // The phone pane may be the one showing it: the band's survey must not stop the shared tick.
  await band.redraw({ ...BAND.props, hasSurvey: true })
  expect(periods).toBe(2)
  await band.redraw(BAND.props)
  expect(periods).toBe(3)
  status = 'completed'
  await band.redraw()
  await band.redraw({ ...BAND.props, hasSurvey: true })
  expect(periods).toBe(3)
})

test('a failing agent.list keeps the band and the agents the mod already holds', async ($, on) => {
  const { clock, world } = setup(on)
  world.failClock = true
  await spawn($)
  expect(world.list).toHaveLength(1)
  world.failList = true
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toContain('子助手 1')
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toBe('⏳ Research · Explore · resolved-model · — · 0 步')
  expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
  world.failClock = false
  await clock.advance(1000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain(' · — · ')
})

test('a clock failure at spawn shows the elapsed time as —, not a time counted from zero', async ($, on) => {
  const { clock, world } = setup(on)
  world.failClock = true
  await spawn($)
  world.failClock = false
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toBe('⏳ Research · Explore · resolved-model · — · 0 步')
  await clock.advance(2000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain(' · — · ')
})

test('a clock failure at the end keeps the finished agent visible with a real end time', async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($)
  await clock.advance(2000)
  const band = await $.ui.mount(BAND)
  world.failClock = true
  await finish($, 'Research')
  world.failClock = false
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 2s · ')
  await clock.advance(1000)
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 2s · ')
  await band.press({ key: 'agents' })
  await clock.advance(118_999)
  expect(await band.find({ key: 'agents' })).toBeDefined()
  await clock.advance(1)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('a failing agent.list in tool.call and turn.complete still counts the step and the end', async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(2000)
  world.failList = true
  world.failClock = true
  await $.tool.call({ tool: 'Read', agentId: 'Research', file_path: '/private/source/main.ts' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain('1 步')
  expect((await pane.find({ type: 'Text', text: '└' }))?.text).toBe('└ Read main.ts')
  await finish($, 'Research')
  expect(world.list).toHaveLength(0)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 2s · 1 步')
})

test("a resumed agent whose end-time read fails keeps its own end, not the previous run's", async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($)
  await clock.advance(3000)
  await finish($, 'Research')
  const band = await $.ui.mount(BAND)
  await clock.advance(200_000)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  await spawn($, 'Research', { resume: { agentId: 'Research' } })
  world.failClock = true
  await finish($, 'Research')
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toBe('✅ Research · Explore · resolved-model · 3m 23s · 0 步')
  world.failClock = false
  await clock.advance(1000)
  await band.redraw()
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 3m 23s · ')
  await band.press({ key: 'agents' })
  await clock.advance(118_999)
  expect(await band.find({ key: 'agents' })).toBeDefined()
  await clock.advance(1)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('while the clock is down the band keeps its rows and schedules no expiry', async ($, on) => {
  const { clock, world } = setup(on)
  world.failClock = true
  await spawn($)
  await finish($, 'Research')
  world.list = [{ id: 'unseen', description: 'Listed completion', type: 'Explore', status: 'completed' }]
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(world.afters).toBe(0)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toBe('✅ Research · Explore · resolved-model · — · 0 步')
  expect((await pane.find({ type: 'Text', text: '✅ Listed completion' }))?.text).toBe('✅ Listed completion · Explore · — · — · 0 步')
  await clock.advance(200_000)
  await band.redraw()
  expect(await pane.findAll({ type: 'Text', text: /^✅/ })).toHaveLength(2)
  await band.press({ key: 'agents' })
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(world.afters).toBe(0)
})

test('a finished agent with an unknown end gets a fixed end when the clock returns', async ($, on) => {
  const { clock, world } = setup(on)
  world.failClock = true
  await spawn($)
  expect(world.list).toHaveLength(1)
  await finish($, 'Research')
  expect(world.list).toHaveLength(0)
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(world.afters).toBe(0)
  await clock.advance(3_600_000)
  await band.redraw()
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(world.afters).toBe(0)
  world.failClock = false
  await band.redraw()
  expect(world.afters).toBe(0)
  await clock.advance(60_000)
  await band.redraw()
  await clock.advance(59_999)
  expect(await band.find({ key: 'agents' })).toBeDefined()
  await clock.advance(1)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
})

test('every clock read goes through one helper that falls back to the last good reading', async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(3000)
  world.failClock = true
  await spawn($, 'Fallback')
  await clock.advance(2000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toBe('⏳ Research · Explore · resolved-model · 3s · 0 步')
  world.failClock = false
  await clock.advance(4000)
  world.failClock = true
  await clock.advance(2000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain(' · 9s · ')
  expect((await pane.find({ type: 'Text', text: '⏳ Fallback' }))?.text).toContain(' · 6s · ')
  await finish($, 'Fallback')
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Fallback' }))?.text).toBe('✅ Fallback · Explore · resolved-model · 6s · 0 步')
  world.failClock = false
  await clock.advance(2000)
  expect((await pane.find({ type: 'Text', text: '✅ Fallback' }))?.text).toContain(' · 6s · ')
})

test('a refused or ended interval is started again on the next render while an agent runs', async ($, on) => {
  const { clock, world } = setup(on)
  world.refusePeriods = [1, 3]
  await spawn($)
  const band = await $.ui.mount(BAND)
  await clock.settle()
  expect(world.periods).toBe(2)
  await band.redraw()
  expect(world.periods).toBe(3)
  await clock.advance(1000)
  expect(world.periods).toBeGreaterThanOrEqual(3)
  const periods = world.periods
  await band.redraw()
  expect(world.periods).toBe(periods + 1)
  await band.press({ key: 'agents' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(1000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain(' · 2s · ')
  world.list[0]!.status = 'completed'
  await clock.advance(1000)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

const PANE = {
  plugin: 'agent-watch', component: 'Pane', requestId: 'agent-watch',
  props: { title: '子助手', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

function panes(on: On, surfaces: ('desktop' | 'mobile')[], reason?: string, errors = new Set<string>()) {
  const opened: string[] = []
  on('ui.open', (_, e) => {
    if (errors.has('ui.open')) return { deny: 'Pane engine unavailable' }
    if (reason) return { value: { isPlaced: false, reason } }
    if (!opened.includes(e.id)) opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    if (errors.has('ui.close')) return { deny: 'Pane engine unavailable' }
    const i = opened.indexOf(e.id)
    if (i >= 0) opened.splice(i, 1)
    return { value: undefined }
  })
  on('ui.panes', () => errors.has('ui.panes') ? { deny: 'Pane engine unavailable' }
    : { value: opened.map(id => ({ id, title: '子助手', isShown: true, isFocused: false, isPlaced: true })) })
  on('session.surfaces', () => ({ value: surfaces }))
  on('command.register', () => ({ value: { command: 'agent-watch' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return opened
}

test('the pane lists every agent on the phone, with the summary on top', async ($, on) => {
  const { clock } = setup(on, ['mobile'])
  await spawn($)
  await $.tool.call({ tool: 'Read', agentId: 'Research', file_path: '/private/source/main.ts' })
  await clock.advance(5_000)
  await spawn($, 'Second')
  await finish($, 'Second')
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await pane.find({ type: 'Text', text: /^子助手/ }))?.text).toBe('子助手 1 运行中 · 1 完成')
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toBe('⏳ Research · Explore · resolved-model · 5s · 1 步')
  expect((await pane.find({ type: 'Text', text: '└' }))?.text).toBe('└ Read main.ts')
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Second' }))?.text).toBe('✅ Second · Explore · resolved-model · 0s · 0 步')
  await pane.unmount()
})

test('the pane says so when the session has no sub-agents yet', async ($, on) => {
  setup(on, ['mobile'])
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await pane.find({ type: 'Text', text: '这个会话还没有子助手。' })).toBeDefined()
  await pane.unmount()
})

test('the pane shows running agents first and keeps finished ones folded', async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($, 'Parent')
  await clock.advance(1000)
  await spawn($, 'Child', { parentAgentId: 'Parent' })
  await spawn($, 'Pending')
  world.list.find(a => a.id === 'Pending')!.status = 'pending'
  await $.tool.call({ tool: 'Read', agentId: 'Pending', file_path: '/source/main.ts' })
  for (const status of ['waiting', 'idle'] as const) {
    await spawn($, status)
    world.list.find(a => a.id === status)!.status = status
  }
  await spawn($, 'Finished')
  await finish($, 'Finished')
  await spawn($, 'Failed')
  await finish($, 'Failed', 'error')
  await spawn($, 'Killed')
  world.list.find(a => a.id === 'Killed')!.status = 'killed'
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const tree = await pane.drawn()
  expect(tree).toMatchObject({ type: 'Box', children: [
    { type: 'Text', children: ['子助手 5 运行中 · 1 完成 · 2 失败'] },
    { type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Text', props: { bold: true }, children: ['当前任务'] }] },
    { type: 'Text', children: ['◐ 已停下，在等后台'] },
    { type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Text', props: { bold: true }, children: ['运行中 5'] }] },
    ...Array.from({ length: 5 }, () => ({ type: 'Box' })),
    { type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Button', props: { key: 'done', plain: true, label: '已完成 3 ▸' } }] },
  ] })
  expect(await pane.findAll({ type: 'Text', text: /^[✅✗]/ })).toHaveLength(0)
  expect((await pane.find({ type: 'Box', key: 'Child' }))?.props.marginLeft).toBe(2)
  expect((await pane.find({ type: 'Text', text: '└' }))?.text).toBe('└ Read main.ts')
})

test('pressing 已完成 unfolds and folds the finished agents', async ($, on) => {
  const { clock } = setup(on)
  await spawn($, 'Parent')
  await clock.advance(1000)
  await spawn($, 'Child', { parentAgentId: 'Parent' })
  await spawn($, 'Running child', { parentAgentId: 'Parent' })
  await finish($, 'Parent')
  await finish($, 'Child', 'error')
  let pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'done' }))?.text).toBe('已完成 2 ▸')
  expect(await pane.find({ key: 'Parent' })).toBeUndefined()
  expect((await pane.find({ type: 'Box', key: 'Running child' }))?.props.marginLeft).toBe(0)
  await pane.press({ key: 'done' })
  expect((await pane.find({ key: 'done' }))?.text).toBe('已完成 2 ▾')
  expect((await pane.findAll({ type: 'Text', text: /^[✅✗]/ })).map(row => row.text.split(' · ')[0])).toEqual(['✅ Parent', '✗ Child'])
  expect((await pane.find({ type: 'Box', key: 'Parent' }))?.props.marginLeft).toBe(0)
  expect((await pane.find({ type: 'Box', key: 'Child' }))?.props.marginLeft).toBe(2)
  await pane.unmount()
  pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'done' }))?.text).toBe('已完成 2 ▾')
  await pane.press({ key: 'done' })
  expect((await pane.find({ key: 'done' }))?.text).toBe('已完成 2 ▸')
  expect(await pane.findAll({ type: 'Text', text: /^[✅✗]/ })).toHaveLength(0)
  expect(await pane.find({ type: 'Text', text: '⏳ Running child' })).toBeDefined()
})

test('the pane says when no agent is running and leaves out an empty 已完成', async ($, on) => {
  setup(on)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '这个会话还没有子助手。' })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: '现在没有在运行的子助手。' }))?.props.dimColor).toBe(true)
  expect(await pane.find({ key: 'done' })).toBeUndefined()
  await spawn($)
  expect(await pane.find({ type: 'Text', text: '现在没有在运行的子助手。' })).toBeUndefined()
  expect(await pane.find({ key: 'done' })).toBeUndefined()
  await finish($, 'Research')
  expect(await pane.find({ type: 'Text', text: '现在没有在运行的子助手。' })).toBeDefined()
  expect((await pane.find({ key: 'done' }))?.text).toBe('已完成 1 ▸')
})

test('a spawn starts the one-second tick before any view draws', async ($, on) => {
  const { clock, world } = setup(on)
  const invalidations: string[] = []
  on('ui.invalidate', (_, e) => {
    invalidations.push(e.event)
    return { deny: 'Redraw unavailable' }
  })
  await spawn($)
  await clock.settle()
  expect(world.periods).toBe(1)
  expect(world.lists).toBe(0)
  expect(invalidations).toEqual(['ui.render'])
  await clock.advance(1000)
  expect(world.lists).toBe(1)
  await finish($, 'Research')
  await clock.advance(1000)
  const settled = world.lists
  await clock.advance(5000)
  expect(world.lists).toBe(settled)
})

test('/agent-watch opens the pane and says so', async ($, on) => {
  const { opened } = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'agent-watch', args: '' } as never)
  expect(opened).toEqual(['agent-watch'])
  expect(r.text).toBe('子助手面板已打开。')
})

test('a spawn opens the pane only while a phone is attached', async ($, on) => {
  const surfaces: ('desktop' | 'mobile')[] = ['desktop']
  const { opened } = setup(on, surfaces)
  await spawn($, 'First')
  expect(opened).toEqual([])
  surfaces.push('mobile')
  await spawn($, 'Second')
  expect(opened).toEqual(['agent-watch'])
})

test('a survey on the desktop band does not stop the phone pane counting', async ($, on) => {
  const { clock } = setup(on, ['desktop', 'mobile'])
  await spawn($)
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  const band = await $.ui.mount(BAND)
  await band.redraw({ ...BAND.props, hasSurvey: true })
  await clock.advance(3000)
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toBe('⏳ Research · Explore · resolved-model · 3s · 0 步')
})

test('after the pane closes, the tick stops once the last agent finishes', async ($, on) => {
  const { clock, world } = setup(on, ['mobile'])
  await spawn($)
  const pane = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await clock.advance(1000)
  await pane.unmount()
  await finish($, 'Research')
  await clock.advance(1000)
  const settled = world.lists
  await clock.advance(5000)
  expect(world.lists).toBe(settled)
})

test('/agent-watch says why the pane was not placed', async ($, on) => {
  setup(on, ['desktop'], 'the attached surfaces place no panes')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'agent-watch', args: '' } as never)
  expect(r.text).toBe('子助手面板没能打开（the attached surfaces place no panes）。可以稍后再输入 /agent-watch 试一次。')
})

test('pressing the band opens the pane, and pressing again closes it', async ($, on) => {
  const { opened } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  expect(opened).toEqual([])
  await band.press({ key: 'agents' })
  expect(opened).toEqual(['agent-watch'])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '⏳ Research' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '⏳ Research' })).toBeUndefined()
  await band.press({ key: 'agents' })
  expect(opened).toEqual([])
  // A person's Esc close must be read from the engine, not remembered by the band.
  await band.press({ key: 'agents' })
  opened.splice(opened.indexOf('agent-watch'), 1)
  expect(opened).toEqual([])
  await band.press({ key: 'agents' })
  expect(opened).toEqual(['agent-watch'])
})

test('the band stays shown after completion whether the pane is open or closed', async ($, on) => {
  const { clock, opened } = setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  await finish($, 'Research')
  await clock.advance(120_000)
  expect(opened).toEqual(['agent-watch'])
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  await band.redraw({ ...BAND.props, hasSurvey: true })
  expect(await band.find({ key: 'agents' })).toBeUndefined()
  await band.redraw(BAND.props)
  await band.press({ key: 'agents' })
  expect(opened).toEqual([])
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
  expect(await band.find({ type: 'Text', text: 'other band' })).toBeDefined()
})

test("the sub-agent band draws above the other plugins' band", async ($, on) => {
  setup(on)
  await spawn($)
  const band = await $.ui.mount(BAND)
  expect(await band.drawn()).toMatchObject({
    type: 'Box', props: { key: 'momo-bands', flexDirection: 'column', gap: 'md' },
    children: [{ type: 'Box', props: { key: 'momo-band-1-agents' }, children: [{ type: 'Button', props: { key: 'agents', plain: true } }, { type: 'Box', props: { flexGrow: 1 } }, { type: 'Button', props: { key: 'details', plain: true } }] }, { type: 'Text', children: ['other band'] }],
  })
})

test('the bands stack sub-agents, toolbar, usage details whatever order they were nested in', async ($, on) => {
  const { world } = setup(on)
  world.beneath = 'bands'
  await spawn($)
  const band = await $.ui.mount(BAND)
  expect(await band.drawn()).toMatchObject({
    type: 'Box', props: { key: 'momo-bands', gap: 'md' },
    children: [
      { type: 'Box', props: { key: 'momo-band-1-agents' } },
      { type: 'Box', props: { key: 'momo-band-2-toolbar' } },
      { type: 'Box', props: { key: 'momo-band-3-usage' } },
      { type: 'Text', children: ['other band'] },
    ],
  })
})

test('pane engine failures leave the band usable and preserve the pane record', async ($, on) => {
  const { opened, paneErrors } = setup(on)
  paneErrors.add('ui.open')
  await spawn($)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'agents' })
  expect(opened).toEqual([])
  paneErrors.clear()
  await band.press({ key: 'agents' })
  expect(opened).toEqual(['agent-watch'])
  for (const event of ['ui.close', 'ui.panes']) {
    paneErrors.add(event)
    await band.press({ key: 'agents' })
    expect(opened).toEqual(['agent-watch'])
    expect(await band.find({ key: 'agents' })).toBeDefined()
    paneErrors.clear()
  }
  paneErrors.clear()
  await band.press({ key: 'agents' })
  expect(opened).toEqual([])
})

test('a resume keeps steps and tasks recorded since the last listing observation', async ($, on) => {
  setup(on)
  await spawn($)
  await $.tool.call({ tool: 'TaskCreate', agentId: 'Research', subject: 'One', description: 'private' })
  await $.tool.call({ tool: 'Read', agentId: 'Research', file_path: '/source/main.ts' })
  await spawn($, 'Research', { resume: { agentId: 'Research' } })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))?.text).toContain(' · 2 步 · 待办 0/1')
})

test('a failure that ends while a render is still listing stays a failure', async ($, on) => {
  const { clock, world } = setup(on)
  await spawn($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let release = () => {}
  world.hold = new Promise<void>(r => { release = r })
  const redraw = pane.redraw()
  for (let i = 0; i < 20 && world.hold; i++) await Promise.resolve()
  await finish($, 'Research', 'error')
  release()
  await redraw
  await clock.advance(5000)
  await pane.redraw()
  await pane.press({ key: 'done' })
  const row = (await pane.find({ type: 'Text', text: 'Research' }))?.text
  expect(row?.startsWith('✗ Research')).toBe(true)
  expect(row).not.toContain('结束方式未知')
})

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('after a reload, agents a successful list no longer holds end with an unknown ending', async ($, on) => {
  const { clock, world } = setup(on)
  for (const status of ['pending', 'running', 'waiting', 'idle'] as const) {
    await spawn($, status)
    world.list.find(a => a.id === status)!.status = status
  }
  await spawn($, 'Kept')
  const band = await $.ui.mount(BAND)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  world.list = world.list.filter(a => a.id === 'Kept')
  await $.session.start(START)
  await pane.redraw()
  expect((await band.find({ key: 'agents' }))?.text).toContain('子助手 1')
  await pane.press({ key: 'done' })
  const rows = await pane.findAll({ type: 'Text', text: /^✅/ })
  expect(rows).toHaveLength(4)
  for (const row of rows) expect(row.text.endsWith(' · 结束方式未知')).toBe(true)
  expect((await pane.find({ type: 'Text', text: '⏳ Kept' }))?.text).not.toContain('结束方式未知')
  await finish($, 'Kept')
  await clock.advance(120_000)
  expect((await band.find({ key: 'agents' }))?.text).toBe('○ 已停下，没有在跑的任务')
})

test('a failed agent.list at reload ends nothing', async ($, on) => {
  const { world } = setup(on)
  await spawn($)
  world.list = []
  world.failList = true
  await $.session.start(START)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: '⏳ Research' }))).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '结束方式未知' })).toBeUndefined()
})

test('a turn.complete after an unknown ending clears it', async ($, on) => {
  const { world } = setup(on)
  await spawn($)
  world.list = []
  await $.session.start(START)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'done' })
  expect((await pane.find({ type: 'Text', text: '✅ Research' }))?.text).toContain(' · 结束方式未知')
  await finish($, 'Research', 'error')
  expect(await pane.find({ type: 'Text', text: '✗ Research' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '结束方式未知' })).toBeUndefined()
})

test('a resume spawn after an unknown ending clears it', async ($, on) => {
  const { world } = setup(on)
  await spawn($)
  world.list = []
  await $.session.start(START)
  await spawn($, 'Research', { resume: { agentId: 'Research' } })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '⏳ Research' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '结束方式未知' })).toBeUndefined()
})

test('a list that shows the agent again clears its unknown ending', async ($, on) => {
  const { world } = setup(on)
  await spawn($)
  const saved = world.list
  world.list = []
  await $.session.start(START)
  world.list = saved
  await $.tool.call({ tool: 'Read', agentId: 'Research', file_path: '/source/main.ts' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = (await pane.find({ type: 'Text', text: 'Research' }))?.text
  expect(row?.startsWith('⏳ Research')).toBe(true)
  expect(row).not.toContain('结束方式未知')
})
