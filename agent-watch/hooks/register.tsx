import { atom, read, update } from 'claude-code'
import type { AgentStatus, BuiltinToolResults, ElementTable, EngineInterface, Register, RenderElement, RenderNode, RenderSurface, Timer } from 'claude-code'

import type { BackgroundSnapshot, TurnTiming, WatchedAgent } from '../types'
import { codexRow, commandDirs, DAY_MS, MAX_READ, mentionsCodex, owned, pad, parseCodex } from './codex'
import type { CodexRecord } from './codex'

// The phone draws no AbovePrompt band; a Pane is raised on every surface, the mobile app's included.
const PANE = 'agent-watch'
const PANE_TITLE = '子助手'
const agents = atom({ plugin: 'agent-watch', key: 'agents' } as const, [] as WatchedAgent[])
const tick = atom({ plugin: 'agent-watch', key: 'tick' } as const, 0)
const doneOpen = atom({ plugin: 'agent-watch', key: 'doneOpen' } as const, false)
const turn = atom({ plugin: 'agent-watch', key: 'turn' } as const, {} as TurnTiming)
const background = atom({ plugin: 'agent-watch', key: 'background' } as const, { tasks: [], crons: 0 } as BackgroundSnapshot)
const codex = atom({ plugin: 'agent-watch', key: 'codex' } as const, [] as WatchedAgent[])
const codexDirs = atom({ plugin: 'agent-watch', key: 'codexDirs' } as const, [] as string[])
let lastNow: number | undefined
let timer: Timer | undefined
let codexRows: WatchedAgent[] = []
let codexAt = -Infinity
let codexScan: Promise<WatchedAgent[]> | undefined
let since: number | undefined
// A detached Codex command writes its record a moment after Bash returns: look again for a minute.
let codexExpectUntil = -Infinity

async function clockNow($: EngineInterface) {
  try {
    lastNow = await $.clock.now()
  } catch {}
  return lastNow
}

async function togglePane($: EngineInterface) {
  const panes = await $.ui.panes().catch(() => undefined)
  if (panes === undefined) return
  if (panes.some(pane => pane.id === PANE)) await $.ui.close({ id: PANE }).catch(() => {})
  else await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => {})
  await update($, tick, n => n + 1).catch(() => {})
}

async function toggleDone($: EngineInterface) {
  await update($, doneOpen, open => !open).catch(() => {})
}

// After a reload mid-run the mod misses those agents' turn.complete: whatever a successful list no
// longer holds has ended, its outcome unknown. Only at session start, so no render or tick races it.
async function endMissing($: EngineInterface) {
  const listed = await $.agent.list().catch(() => undefined)
  if (listed === undefined) return
  const current = await clockNow($)
  const ids = new Set(listed.map(info => info.id))
  await update($, agents, list => endUnlisted(list, ids, current))
}

function endUnlisted(list: WatchedAgent[], ids: Set<string>, current: number | undefined): WatchedAgent[] {
  return list.map(a => active(a.status) && !ids.has(a.id) ? { ...a, status: 'completed', endUnknown: true, endedAt: current } : a)
}

// Codex's records are read at most every 5 s, at once after a Codex command or a turn's end;
// renders only read the atom, since a render cannot write one.
async function refreshCodex($: EngineInterface, force = false) {
  const current = await clockNow($)
  if (current === undefined) return codexRows
  if (codexScan) return codexScan
  if (!force && current - codexAt < 5000) return codexRows
  codexAt = current
  codexScan = scanAndStore($, current).finally(() => { codexScan = undefined })
  return codexScan
}

async function scanAndStore($: EngineInterface, current: number) {
  if (since === undefined) {
    const usage = await $.session.usage().catch(() => undefined)
    since = usage?.startedAt
  }
  if (since === undefined) return codexRows
  const root = await $.session.root().catch(() => undefined)
  const dirs = await read($, codexDirs).catch(() => [] as string[])
  const rows = await scanCodex($, since, current, root, dirs).catch(() => undefined)
  if (rows === undefined) return codexRows
  await update($, codex, () => rows).catch(() => {})
  codexRows = rows
  return rows
}

// Folders named by a Bash command that mentions Codex; a run in one of them is this chat's.
async function noteCodexDirs($: EngineInterface, command: string) {
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  const current = await clockNow($)
  if (current !== undefined) codexExpectUntil = current + 60_000
  const found = commandDirs(command, home)
  if (found.length) await update($, codexDirs, old => [...new Set([...old, ...found])].slice(-100)).catch(() => {})
}

type Cached = { size: number; mtimeMs: number; record?: CodexRecord }
const cache = new Map<string, Cached>()

// Every record of the days since the session started (at most a week), each read again only when it
// changed. Undefined when the records cannot be found at all, so the caller keeps what it had.
async function scanCodex($: EngineInterface, since: number, current: number, root: string | undefined, dirs: readonly string[]) {
  const home = (await $.env.get('CODEX_HOME').catch(() => undefined))
    || ((await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined)))?.replace(/[\\/]+$/, '').concat('/.codex')
  if (!home || !Number.isFinite(since) || !Number.isFinite(current)) return undefined
  const rows: WatchedAgent[] = []
  for (let day = Math.max(since, current - 7 * DAY_MS); ; day += DAY_MS) {
    const date = new Date(Math.min(day, current))
    const dir = `${home}/sessions/${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    const entries = await $.fs.list(dir).catch(() => undefined)
    // A day with no Codex run has no folder; a folder there that cannot be listed keeps the old rows.
    if (entries === undefined) {
      if (await $.fs.exists(dir).catch(() => true)) return undefined
      if (day >= current) break
      continue
    }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !/^rollout-.*\.jsonl$/.test(entry.name) || entry.mtimeMs < since) continue
      const path = `${dir}/${entry.name}`
      let hit = cache.get(path)
      if (!hit || hit.size !== entry.size || hit.mtimeMs !== entry.mtimeMs) {
        const text = await readRecord($, path, entry.size)
        // A failed read keeps what the last read of this record gave.
        if (text !== undefined) {
          hit = { size: entry.size, mtimeMs: entry.mtimeMs, record: parseCodex(text, entry.size <= MAX_READ) }
          cache.set(path, hit)
        } else if (!hit) continue
      }
      const r = hit.record
      if (!r || (r.startedAt ?? 0) < since || !owned(r.cwd, root, dirs) || rows.some(a => a.id === `codex:${r.id}`)) continue
      rows.push(codexRow(r, entry.mtimeMs, current))
    }
    if (day >= current) break
  }
  return rows
}

// A record over the read limit is read as its first and last part (meta and prompt, then the end).
async function readRecord($: EngineInterface, path: string, size: number) {
  if (size <= MAX_READ) {
    const text = await $.fs.read(path).catch(() => undefined)
    return typeof text === 'string' ? text : undefined
  }
  const head = await $.process.run(['head', '-c', '262144', path], { timeoutMs: 5000 }).catch(() => null)
  const tail = await $.process.run(['tail', '-c', '1048576', path], { timeoutMs: 5000 }).catch(() => null)
  if (head?.exitCode !== 0 || tail?.exitCode !== 0) return undefined
  return `${head.stdout}\n${tail.stdout}`
}

export const register: Register = on => {
  const ended = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'agent-watch', description: '在面板里看子助手进度（手机上也能看）' }).catch(() => {})
    await endMissing($).catch(() => {})
    void refreshCodex($, true).catch(() => {})
    return r
  })

  // Closing the pane by Esc or its mark redraws the details button.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    await update($, tick, n => n + 1).catch(() => {})
    return r
  })

  on('command.run', { command: 'agent-watch' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE }).catch((err: unknown) => ({ isPlaced: false as const, reason: err instanceof Error ? err.message : String(err) }))
    if (opened.isPlaced) return { text: '子助手面板已打开。' }
    // The engine's reason names what keeps it undrawn: a narrow window, a surface that places no panes.
    return { text: `子助手面板没能打开（${opened.reason}）。可以稍后再输入 /agent-watch 试一次。` }
  })

  on('agent.spawn', async ($, e, next) => {
    const startedAt = await clockNow($)
    const r = await next(e)
    if (!r.agentId || e.workflow) return r
    const id = r.agentId
    if (e.resume) ended.delete(id)
    const list = await update($, agents, list => {
      const old = list.find(a => a.id === id)
      const one: WatchedAgent = {
        id, description: e.description, type: e.subagentType, parentId: e.parentAgentId,
        status: 'running', model: r.model, startedAt, steps: 0, latest: '', tasks: {}, ...old,
      }
      if (e.resume) Object.assign(one, { status: 'running', endedAt: undefined, endUnknown: undefined })
      return [one, ...list.filter(a => a.id !== id)]
    }).catch(() => undefined)
    if (list) keepTicking($, ended, list, working(await read($, turn).catch(() => ({})))) // a failed write leaves a running tick alone
    try { await $.ui.invalidate('ui.render') } catch {}
    const surfaces = await $.session.surfaces().catch((): readonly RenderSurface[] => [])
    if (surfaces.includes('mobile')) void $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => {})
    return r
  })

  on('tool.call', async ($, e, next) => {
    const isCodex = e.tool === 'Bash' && mentionsCodex(e.command ?? '')
    if (isCodex) await noteCodexDirs($, e.command ?? '').catch(() => {})
    if (!e.agentId) {
      const r = await next(e)
      if (isCodex) await refreshCodex($, true).catch(() => {})
      return r
    }
    await refresh($, ended).catch(() => {})
    await update($, agents, list => list.map(a => a.id === e.agentId ? { ...a, steps: a.steps + 1, latest: latestStep(e) } : a)).catch(() => {})
    const r = await next(e)
    if (isCodex) await refreshCodex($, true).catch(() => {})
    if (r.deny || r.isError) return r
    if (e.tool === 'TaskCreate') {
      const result = r.result as BuiltinToolResults['TaskCreate']
      await update($, agents, list => list.map(a => a.id === e.agentId ? { ...a, tasks: { ...a.tasks, [result.task.id]: false } } : a)).catch(() => {})
    } else if (e.tool === 'TaskUpdate') {
      const result = r.result as BuiltinToolResults['TaskUpdate']
      if (result.success && e.status) {
        await update($, agents, list => list.map(a => a.id === e.agentId && e.taskId in a.tasks
          ? { ...a, tasks: { ...a.tasks, [e.taskId]: e.status === 'completed' } } : a)).catch(() => {})
      }
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    // The turn's id is kept with its times, so a reload mid-turn does not restart the count.
    if (!e.agentId && (await read($, turn).catch(() => undefined))?.turnId !== e.turnId) {
      const startedAt = await clockNow($)
      await update($, turn, () => ({ turnId: e.turnId, startedAt })).catch(() => {})
      keepTicking($, ended, await read($, agents).catch(() => []), true)
    }
    const r = yield* next(e)
    return r
  })

  on('classic.Stop', async ($, e, next) => {
    if (!e.agent_id) await update($, background, () => ({
      tasks: (e.background_tasks ?? [])
        .filter(task => task.type !== 'subagent' && (!task.status || task.status === 'running' || task.status === 'pending'))
        // A description that repeats the command line is dropped with it: a command can hold a secret.
        .map(task => ({ id: task.id, type: task.type, description: task.command && task.description.startsWith(task.command.slice(0, 20)) ? '' : [...task.description].slice(0, 80).join('') })),
      crons: e.session_crons?.length ?? 0,
    })).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const endedAt = await clockNow($)
    if (!e.agentId) {
      // A turn whose start was missed still ends the stored one, so no stale 正在工作 is left open.
      await update($, turn, old => (old.turnId === e.turnId ? { ...old, endedAt } : old.endedAt === undefined ? { turnId: e.turnId, endedAt } : old)).catch(() => {})
      await refreshCodex($, true).catch(() => {})
      keepTicking($, ended, await read($, agents).catch(() => []), false)
      return r
    }
    await refresh($, ended).catch(() => {})
    const status: AgentStatus = e.reason === 'error' || e.reason === 'aborted' ? 'failed' : 'completed'
    await update($, agents, list => list.map(a => a.id === e.agentId
      ? { ...a, endedAt, status, endUnknown: undefined } : a)).catch(() => {})
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, agents).catch(() => {})
    await read($, tick).catch(() => {})
    const timing = await read($, turn).catch(() => ({} as TurnTiming))
    const bg = await read($, background).catch(() => ({ tasks: [], crons: 0 } as BackgroundSnapshot))
    const rest = await next(e)
    // Read after the listing, so a render reaches agent.list as soon as before.
    const list = [...await refresh($, ended, false).catch(() => []), ...await read($, codex).catch(() => [] as WatchedAgent[])]
    const open = (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)
    const current = await clockNow($)
    keepTicking($, ended, list, e.props.isWorking || working(timing), waiting(bg, list))
    if (e.props.hasSurvey) return rest
    let elements
    try { elements = $.ui.resolve(e) } catch { return rest }
    const { Box, Button } = elements
    // One line that opens or hides the side pane, the top band of the stack.
    const mine = (
      <Box key="momo-band-1-agents" flexDirection="row">
        <Button key="agents" plain label={statusLabel(e.props.isWorking, timing, bg, list, current)} onPress={() => togglePane($)} />
        <Box flexGrow={1} />
        <Button key="details" plain label={open ? '详情 ‹' : '详情 ›'} onPress={() => togglePane($)} />
      </Box>
    )
    return stack(rest, mine, Box)
  })

  // The same rows in a pane, every agent of the session, wrapped instead of cut for a narrow phone.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    await read($, agents).catch(() => {})
    await read($, tick).catch(() => {})
    const timing = await read($, turn).catch(() => ({} as TurnTiming))
    const bg = await read($, background).catch(() => ({ tasks: [], crons: 0 } as BackgroundSnapshot))
    const open = await read($, doneOpen).catch(() => false)
    // Read after the listing, so a render reaches agent.list as soon as before.
    const list = [...await refresh($, ended, false).catch(() => []), ...await read($, codex).catch(() => [] as WatchedAgent[])]
    const current = await clockNow($)
    const isWorking = working(timing)
    keepTicking($, ended, list, isWorking, waiting(bg, list))
    let elements
    try { elements = $.ui.resolve(e) } catch { return next(e) }
    const { Box, Text, Button } = elements
    const runningRows = ordered(list.filter(a => active(a.status)))
    const finishedRows = ordered(list.filter(a => !active(a.status)))
    return (
      <Box flexDirection="column">
        <Text bold>{list.length ? summary(list) : '这个会话还没有子助手。'}</Text>
        <Box marginTop={1}><Text bold>当前任务</Text></Box>
        <Text>{stateLine(isWorking, waiting(bg, list), timing, current)}</Text>
        {timing.startedAt !== undefined && (isWorking || timing.endedAt !== undefined) && (
          <Text>{`${isWorking ? '这一轮已做' : '上一轮做了'} ${duration(timing.startedAt, isWorking ? current : timing.endedAt)}`}</Text>
        )}
        <Box marginTop={1}>
          <Text bold>{`运行中 ${runningRows.length}`}</Text>
        </Box>
        {!runningRows.length && <Text dimColor>现在没有在运行的子助手。</Text>}
        {runningRows.map(({ agent: a, depth }) => (
          <Box key={a.id} flexDirection="column" marginLeft={depth * 2} marginTop={1}>
            <Text>{rowText(a, current)}</Text>
            {(a.status === 'running' || a.status === 'pending') && a.latest && <Text dimColor>{`└ ${a.latest}`}</Text>}
          </Box>
        ))}
        {finishedRows.length > 0 && (
          <Box marginTop={1}>
            <Button key="done" plain label={`已完成 ${finishedRows.length} ${open ? '▾' : '▸'}`} onPress={() => toggleDone($)} />
          </Box>
        )}
        {open && finishedRows.map(({ agent: a, depth }) => (
          <Box key={a.id} flexDirection="column" marginLeft={depth * 2} marginTop={1}>
            <Text>{rowText(a, current)}</Text>
          </Box>
        ))}
        {(bg.tasks.length > 0 || bg.crons > 0) && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{`后台 ${bg.tasks.length + bg.crons}`}</Text>
            {bg.tasks.map(task => <Text key={task.id}>{task.description ? `${typeName(task.type)} · ${task.description}` : typeName(task.type)}</Text>)}
            {bg.crons > 0 && <Text>{`定时唤醒 ${bg.crons} 个`}</Text>}
          </Box>
        )}
      </Box>
    )
  })
}

// One tick for the band and the pane, decided by the turn and agents, never by which view drew last.
// Every render restarts it (a refused period ends without notice), and it stops itself once no
// turn or agent runs, since a closed pane or a hidden band may never draw again.
// While only waiting on background work it ticks every 30 s: 已等 counts in minutes.
function keepTicking($: EngineInterface, ended: Map<string, number>, list: WatchedAgent[], isWorking = false, waits = false) {
  try {
    timer?.cancel()
    timer = undefined
    const busy = isWorking || list.some(running) || codexRows.some(running) || expecting()
    if (!busy && !waits) return
    const mine: Timer = $.clock.every(busy ? 1000 : 30_000, () => {
      void Promise.all([refresh($, ended), refreshCodex($)]).then(async ([agentsNow, runs]) => {
        const fresh = [...agentsNow, ...runs]
        const timing = await read($, turn).catch(() => undefined)
        const bg = await read($, background).catch(() => undefined)
        const still = timing === undefined || bg === undefined || working(timing) || fresh.some(running) || waiting(bg, fresh) || expecting()
        // Only this tick's own timer is stopped, never a newer one a turn or spawn started since.
        if (!still && timer === mine) {
          mine.cancel()
          timer = undefined
        }
        return update($, tick, n => n + 1)
      }).catch(() => {})
    })
    timer = mine
  } catch {}
}

function expecting() {
  return lastNow !== undefined && lastNow < codexExpectUntil
}

function running(a: WatchedAgent) {
  return a.status === 'running' || a.status === 'pending'
}

function summary(list: WatchedAgent[]) {
  const done = list.filter(a => a.status === 'completed').length
  const failed = list.filter(a => a.status === 'failed' || a.status === 'killed').length
  return `子助手 ${list.filter(a => active(a.status)).length} 运行中 · ${done} 完成${failed ? ` · ${failed} 失败` : ''}`
}

function working(timing: TurnTiming) {
  return timing.startedAt !== undefined && timing.endedAt === undefined
}

function waiting(bg: BackgroundSnapshot, list: WatchedAgent[]) {
  return list.some(a => active(a.status)) || bg.tasks.length > 0 || bg.crons > 0
}

function stateLine(isWorking: boolean, waits: boolean, timing: TurnTiming, current: number | undefined) {
  // A turn the mod has not timed yet (its first step not heard) shows no number rather than the last turn's.
  return isWorking ? `● 正在工作 ${timing.endedAt === undefined ? duration(timing.startedAt, current) : '—'}`
    : waits ? '◐ 已停下，在等后台' : '○ 已停下，没有在跑的任务'
}

function typeName(type: string) {
  return type === 'shell' ? '后台命令' : type === 'monitor' ? '监控' : type === 'workflow' ? '流程' : '其他后台'
}

function statusLabel(isWorking: boolean, timing: TurnTiming, bg: BackgroundSnapshot, list: WatchedAgent[], current: number | undefined) {
  const waits = waiting(bg, list)
  const parts = [stateLine(isWorking, waits, timing, current)]
  const count = list.filter(a => active(a.status)).length
  if (count) parts.push(`子助手 ${count}${isWorking ? ' 在跑' : ''}`)
  for (const name of ['后台命令', '监控', '流程', '其他后台']) {
    const n = bg.tasks.filter(task => typeName(task.type) === name).length
    if (n) parts.push(`${name} ${n}`)
  }
  if (bg.crons > 0) parts.push(`定时唤醒 ${bg.crons}`)
  if (!isWorking && waits) parts.push(`已等 ${minutes(timing.endedAt, current)}`)
  else if (!isWorking && timing.startedAt !== undefined && timing.endedAt !== undefined) parts.push(`上一轮做了 ${duration(timing.startedAt, timing.endedAt)}`)
  return parts.join(' · ')
}

function rowText(a: WatchedAgent, current: number | undefined) {
  const tasks = Object.keys(a.tasks).length ? ` · 待办 ${Object.values(a.tasks).filter(Boolean).length}/${Object.keys(a.tasks).length}` : ''
  // A Codex record too large to read whole has no step count.
  return `${icon(a.status)} ${a.description} · ${a.type} · ${a.model ?? '—'} · ${elapsed(a, current)}${a.steps >= 0 ? ` · ${a.steps} 步` : ''}${tasks}${a.endUnknown ? ' · 结束方式未知' : ''}`
}

async function refresh($: EngineInterface, ended: Map<string, number>, persist = true) {
  const listed = await $.agent.list().catch(() => [])
  const current = await clockNow($)
  const merge = (old: WatchedAgent[]) => {
    const list = [...old]
    for (const info of listed) {
      const i = list.findIndex(a => a.id === info.id)
      const a = list[i] ?? { steps: 0, latest: '', tasks: {} }
      const one: WatchedAgent = { ...a, ...info, endUnknown: undefined }
      if (active(info.status)) {
        ended.delete(info.id)
        one.endedAt = undefined
      }
      if (i < 0) list.unshift(one)
      else list[i] = one
    }
    return list.map(a => {
      if (active(a.status) || a.endedAt !== undefined) return a
      // A render cannot write atoms; remember when any ending was first seen.
      const end = ended.get(a.id) ?? current
      if (end !== undefined) ended.set(a.id, end)
      return { ...a, endedAt: end }
    })
  }
  return persist ? update($, agents, merge) : merge(await read($, agents))
}

function active(status: AgentStatus) {
  return status === 'pending' || status === 'running' || status === 'waiting' || status === 'idle'
}

function icon(status: AgentStatus) {
  return status === 'completed' ? '✅' : status === 'failed' || status === 'killed' ? '✗' : status === 'waiting' || status === 'idle' ? '⏸' : '⏳'
}

function elapsed(a: WatchedAgent, now: number | undefined) {
  const end = active(a.status) ? now : a.endedAt
  return duration(a.startedAt, end)
}

function minutes(start: number | undefined, end: number | undefined) {
  if (start === undefined || end === undefined) return '—'
  const m = Math.floor(Math.max(0, end - start) / 60_000)
  return m < 1 ? '不到 1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function duration(start: number | undefined, end: number | undefined) {
  if (start === undefined || end === undefined) return '—'
  const s = Math.max(0, Math.floor((end - start) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}

function ordered(list: WatchedAgent[]) {
  const sorted = [...list].sort((a, b) => (b.startedAt ?? Infinity) - (a.startedAt ?? Infinity))
  const rows: { agent: WatchedAgent; depth: number }[] = []
  const seen = new Set<string>()
  function add(a: WatchedAgent, depth: number) {
    if (seen.has(a.id)) return
    seen.add(a.id)
    rows.push({ agent: a, depth })
    for (const child of sorted.filter(b => b.parentId === a.id)) add(child, depth + 1)
  }
  for (const a of sorted.filter(a => !sorted.some(b => b.id === a.parentId))) add(a, 0)
  for (const a of sorted) add(a, 0)
  return rows
}

export function latestStep(e: { tool: string; file_path?: string; command?: string; description?: string; pattern?: string }) {
  let arg = ''
  if (e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write') arg = e.file_path?.split(/[\\/]/).pop() ?? ''
  else if (e.tool === 'Bash') arg = e.description || e.command || ''
  else if (e.tool === 'Grep' || e.tool === 'Glob') arg = e.pattern ?? ''
  else if (e.tool === 'Agent') arg = e.description ?? ''
  return [...`${e.tool}${arg ? ` ${arg}` : ''}`.replace(/\s+/g, ' ').trim()].slice(0, 60).join('')
}

// agent-watch, session-toolbar and session-usage each draw one band above the prompt, and the
// engine nests their hooks in an order a reload can change. So each takes apart the stack it is
// handed and sorts the bands by key: sub-agents, then the toolbar, then the usage details, with
// room between them. Anything else drawn here follows them. The same function is in all three.
const BANDS = 'momo-bands'
function stack(rest: RenderElement | undefined, mine: RenderElement, Box: ElementTable['Box']): RenderElement {
  const parts: RenderNode[] = [mine]
  if (rest?.type === 'Box' && rest.props?.key === BANDS) parts.push(...(rest.children ?? []))
  else if (rest && rest.type !== 'engine') parts.push(rest) // the engine's node draws nothing here without a survey
  const rank = (n: RenderNode) => {
    const key = typeof n !== 'string' && 'props' in n ? (n.props as { key?: unknown } | undefined)?.key : undefined
    return typeof key === 'string' && key.startsWith('momo-band-') ? key : '~'
  }
  parts.sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))
  return (
    <Box key={BANDS} flexDirection="column" gap="md">
      {parts}
    </Box>
  )
}
