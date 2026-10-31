import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { commandDirs, mentionsCodex, parseCodex } from '../hooks/codex'

const NOW = 1_800_000_000_000
const START = NOW - 3_600_000
const DAY = (() => {
  const d = new Date(NOW)
  return `/home/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
})()

const PANE = {
  plugin: 'agent-watch', component: 'Pane', requestId: 'agent-watch', surface: 'desktop',
  props: { title: '子助手', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = {
  plugin: 'agent-watch', component: 'AbovePrompt', requestId: 'agents', surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 120, scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function iso(ms: number) {
  return new Date(ms).toISOString()
}

// A Codex run record in the shape `codex exec` writes it.
function record(o: { id: string; cwd: string; startedAt?: number; prompt?: string; end?: 'complete' | 'aborted'; steps?: number; meta?: Record<string, unknown> }) {
  const at = o.startedAt ?? START + 60_000
  const lines: unknown[] = [
    { timestamp: iso(at), type: 'session_meta', payload: { id: o.id, timestamp: iso(at), cwd: o.cwd, originator: 'codex_exec', source: 'exec', ...o.meta } },
    { timestamp: iso(at), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: iso(at), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol' } } },
    { timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: `Base task: 7\n\n${o.prompt ?? 'Implement the parser'}\nmore detail` }] } } },
  ]
  for (let i = 0; i < (o.steps ?? 2); i++) lines.push({ timestamp: iso(at + 1000), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec' } })
  lines.push({ timestamp: iso(at + 2000), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'text', text: '正在跑测试\n细节' }] } } })
  if (o.end) lines.push({ timestamp: iso(at + 90_000), type: 'event_msg', payload: { type: o.end === 'complete' ? 'task_complete' : 'turn_aborted' } })
  return lines.map(l => JSON.stringify(l)).join('\n')
}

function setup(on: On, files: Record<string, { text: string; mtimeMs?: number }>) {
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  const reads: string[] = []
  const world = { failList: false }
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: '子助手', isShown: true, isFocused: false, isPlaced: true })) }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('command.register', () => ({ value: { command: 'agent-watch' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/p/wt' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: e.path === DAY }))
  on('fs.list', (_, e) => world.failList ? { deny: 'EACCES' } : e.path === DAY
    ? { value: Object.entries(files).map(([name, f]) => ({ name, kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs ?? NOW - 1000, isLink: false })) }
    : { deny: 'ENOENT' })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const f = files[e.path.slice(DAY.length + 1)]
    return f ? { value: f.text } : { deny: 'ENOENT' }
  })
  on('turn.step', async function* (_, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as never })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  return { clock, reads, world }
}

async function endTurn($: Engine) {
  const stream = $.turn.step({ turnId: 'main', index: 0, model: 'model' } as never)
  for await (const _ of stream) { /* drain */ }
  await $.turn.complete({ turnId: 'main', reason: 'answer', answer: '', durationMs: 0, isAborted: false })
}

test('a record gives the prompt, model, steps, latest message and end', () => {
  const r = parseCodex(record({ id: 'a', cwd: '/p/wt', end: 'complete', steps: 3 }), true)!
  expect(r.prompt).toBe('Implement the parser')
  expect(r.model).toBe('gpt-6.1-sol')
  expect(r.steps).toBe(3)
  expect(r.latest).toBe('正在跑测试')
  expect(r.state).toBe('completed')
  expect(r.endedAt).toBe(START + 60_000 + 90_000)
  expect(parseCodex(record({ id: 'b', cwd: '/p', end: 'aborted' }), true)!.state).toBe('failed')
  expect(parseCodex(record({ id: 'c', cwd: '/p' }), true)!.state).toBe('running')
  expect(parseCodex(record({ id: 'd', cwd: '/p' }), false)!.steps).toBeUndefined()
  expect(parseCodex('not json\n{"type":"x"', true)).toBeUndefined()
})

test("a pipeline brief's row says its Task line, and a report's heading is passed over for its first sentence", () => {
  const msg = (type: string, text: string) => JSON.stringify({ timestamp: iso(START), type: 'event_msg', payload: { type: 'item_completed', item: { type, content: [{ type: 'text', text }] } } })
  const meta = JSON.stringify({ timestamp: iso(START), type: 'session_meta', payload: { id: 'p', timestamp: iso(START), cwd: '/p', originator: 'codex_exec', source: 'exec' } })
  const brief = 'Base task: demo-task-1\nParent task: demo-task-1\nModel gpt-6.1-sol, effort max (router: tier hard). One task.\n\nProject: Demo App\nTask: Show the account balance\n# Usage panel'
  const r = parseCodex([meta, msg('UserMessage', brief), msg('AgentMessage', '**已做什么**\n我会先核对项目说明。\n\n**需要 Momo 决定什么**\n没有。')].join('\n'), true)!
  expect(r.prompt).toBe('Show the account balance')
  expect(r.latest).toBe('我会先核对项目说明。')
  const bare = parseCodex([meta, msg('UserMessage', 'Base task: x\nModel gpt-6.1-sol, effort high (router: tier standard).\nFix the parser')].join('\n'), true)!
  expect(bare.prompt).toBe('Fix the parser')
  const last = (text: string) => parseCodex([meta, msg('UserMessage', 'Task: Fix __init__.py import failure'), msg('AgentMessage', 'Running tests.'), msg('AgentMessage', text)].join('\n'), true)!
  expect(last('**All 65 tests passed.**').latest).toBe('All 65 tests passed.')
  expect(last('**已做什么**').latest).toBe('已做什么')
  expect(last('x').prompt).toBe('Fix __init__.py import failure')
  expect(last('**已做什么**：\n已修复解析错误。').latest).toBe('已修复解析错误。')
  expect(last('Updated **/*.ts.').latest).toBe('Updated **/*.ts.')
  expect(last('__已做什么__\n已修复解析错误。').latest).toBe('已修复解析错误。')
  expect(last('**验证结果（test_codex.py）**\n65 项测试全部通过。').latest).toBe('65 项测试全部通过。')
  expect(last('**Updated test_codex.py.**').latest).toBe('Updated test_codex.py.')
  expect(last('**检查 __init__**\n已修复包初始化导入错误。').latest).toBe('已修复包初始化导入错误。')
  expect(parseCodex([meta, msg('UserMessage', 'Fix parser\n\nTask:\nConstraints: keep the API')].join('\n'), true)!.prompt).toBe('Fix parser')
})

test("only command-line runs count: not the Codex app's, an editor's or the approval reviewer's", () => {
  expect(parseCodex(record({ id: 'r', cwd: '/p', meta: { source: { subagent: 'review' } } }), true)).toBeDefined()
  expect(parseCodex(record({ id: 'g', cwd: '/p', meta: { source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' } }), true)).toBeUndefined()
  expect(parseCodex(record({ id: 'v', cwd: '/p', meta: { originator: 'Codex Desktop', source: 'vscode' } }), true)).toBeUndefined()
  const child = parseCodex(record({ id: 'c', cwd: '/p', meta: { source: { subagent: { thread_spawn: { parent_thread_id: 'top' } } } } }), true)!
  expect(child.parentId).toBe('codex:top')
})

test('a Codex command names its folders, quoted or bare, but not short ones or home', () => {
  expect(mentionsCodex('codex exec -C /a/b/c "spec"')).toBe(true)
  expect(mentionsCodex('zsh ~/x/codex_lanes.sh A lane.tsv')).toBe(true)
  expect(mentionsCodex('git status')).toBe(false)
  expect(commandDirs('cd "/Volumes/SSD/my project/wt" && APP_DIR=/Volumes/SSD/worktrees/app codex exec -C /tmp - < /dev/null', '/Users/me'))
    .toEqual(['/Volumes/SSD/my project/wt', '/Volumes/SSD/worktrees/app'])
  expect(commandDirs('codex exec -C /Users/me --add-dir /Users/me/', '/Users/me')).toEqual([])
})

test("a Codex run in the session's folder shows as a running row, counted on the band", async ($, on) => {
  setup(on, { 'rollout-1.jsonl': { text: record({ id: 'run1', cwd: '/p/wt/sub' }) } })
  await endTurn($)
  const pane = await $.ui.mount(PANE)
  const row = (await pane.find({ type: 'Text', text: 'Implement the parser' }))?.text
  expect(row).toBe('⏳ Implement the parser · Codex · gpt-6.1-sol · 59m 0s · 2 步')
  expect(await pane.find({ type: 'Text', text: '└ 正在跑测试' })).toBeDefined()
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'agents' }))?.text).toContain('子助手 1')
  expect((await band.find({ key: 'agents' }))?.text).toContain('已停下，在等后台')
})

test('a run elsewhere shows only after a Codex command of this chat names its folder', async ($, on) => {
  setup(on, { 'rollout-2.jsonl': { text: record({ id: 'run2', cwd: '/ssd/worktrees/app/wt-7', prompt: 'Lane task', end: 'complete' }) } })
  await endTurn($)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: '这个会话还没有子助手。' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'APP_DIR=/ssd/worktrees/app nohup zsh codex_lanes.sh A t.tsv < /dev/null &' })
  await pane.redraw()
  await pane.press({ key: 'done' })
  const row = (await pane.find({ type: 'Text', text: 'Lane task' }))?.text
  expect(row).toBe('✅ Lane task · Codex · gpt-6.1-sol · 1m 30s · 2 步')
})

test('runs started before the session are left out', async ($, on) => {
  setup(on, { 'rollout-3.jsonl': { text: record({ id: 'run3', cwd: '/p/wt', startedAt: START - 60_000, prompt: 'Old run' }) } })
  await endTurn($)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: 'Old run' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '这个会话还没有子助手。' })).toBeDefined()
})

test('a run with no end and no write for 15 minutes ends as 结束方式未知', async ($, on) => {
  setup(on, { 'rollout-4.jsonl': { text: record({ id: 'run4', cwd: '/p/wt', prompt: 'Stuck run' }), mtimeMs: NOW - 20 * 60_000 } })
  await endTurn($)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'done' })
  const row = (await pane.find({ type: 'Text', text: 'Stuck run' }))?.text
  expect(row?.startsWith('✅ Stuck run')).toBe(true)
  expect(row).toContain('结束方式未知')
})

test('an unchanged record is not read again', async ($, on) => {
  const { reads, clock } = setup(on, { 'rollout-5.jsonl': { text: record({ id: 'run5', cwd: '/p/wt', end: 'complete' }) } })
  await endTurn($)
  await endTurn($)
  await clock.advance(10_000)
  expect(reads.filter(p => p.endsWith('rollout-5.jsonl')).length).toBe(1)
})

test('a detached Codex command whose record appears after the turn ended still shows within seconds', async ($, on) => {
  const files: Record<string, { text: string }> = {}
  const { clock } = setup(on, files)
  await $.tool.call({ tool: 'Bash', command: 'nohup codex exec -C /p/wt - < /tmp/x/spec.md > /tmp/x/log 2>&1 &' })
  await endTurn($)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: '这个会话还没有子助手。' })).toBeDefined()
  files['rollout-6.jsonl'] = { text: record({ id: 'run6', cwd: '/p/wt', prompt: 'Late record' }) }
  await clock.advance(6000)
  await pane.redraw()
  expect((await pane.find({ type: 'Text', text: 'Late record' }))?.text?.startsWith('⏳ Late record')).toBe(true)
})

test('a sessions folder that cannot be listed keeps the rows already shown', async ($, on) => {
  const { world } = setup(on, { 'rollout-7.jsonl': { text: record({ id: 'run7', cwd: '/p/wt', prompt: 'Kept row' }) } })
  await endTurn($)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: 'Kept row' })).toBeDefined()
  world.failList = true
  await $.tool.call({ tool: 'Bash', command: 'codex exec -C /p/wt "again"' })
  await pane.redraw()
  expect(await pane.find({ type: 'Text', text: 'Kept row' })).toBeDefined()
})
