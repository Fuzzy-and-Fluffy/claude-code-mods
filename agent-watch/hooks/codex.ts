import type { WatchedAgent } from '../types'
import { t } from './i18n'
import type { Lang } from './i18n'

// Codex runs started from this chat through Bash (`codex exec`, lane scripts, the companion) are no
// sub-agents of the engine: agent.list never holds them. Codex writes each run to its own record,
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, and the rows here are read from those records.
// A run belongs to this chat when it started after the session did and its folder is the session's,
// or under a folder named in a Bash command of this chat that mentions Codex.

export type CodexRecord = {
  id: string
  cwd: string
  startedAt?: number
  parentId?: string // a Codex sub-agent's parent run
  prompt: string
  model?: string
  steps?: number // unknown when only the head and tail of a large record were read
  latest: string
  state: 'running' | 'completed' | 'failed'
  endedAt?: number
}

export const MAX_READ = 4 * 1024 * 1024 - 1 // $.fs.read rejects anything larger
export const DAY_MS = 86_400_000
const STALE_MS = 15 * 60_000

export function mentionsCodex(command: string) {
  return /\bcodex\b|codex_lanes/i.test(command)
}

// Absolute folders a command names, bare or quoted; the shortest ones (/, /Users, /Users/x) and the
// home folder itself are dropped, since every run would sit under them.
export function commandDirs(command: string, home: string | undefined) {
  const found = new Set<string>()
  const add = (raw: string) => {
    const path = slash(raw).replace(/\/+$/, '')
    if (path.split('/').filter(Boolean).length < 3) return
    if (home && path === slash(home).replace(/\/+$/, '')) return
    found.add(path)
  }
  for (const m of command.matchAll(/["']((?:\/|[A-Za-z]:[\\/])[^"']*)["']/g)) add(m[1]!)
  for (const m of command.matchAll(/(?:^|[\s=:(])((?:\/|[A-Za-z]:[\\/])[^\s'"`;|&()<>]*)/g)) add(m[1]!)
  return [...found]
}

export function parseCodex(text: string, whole: boolean): CodexRecord | undefined {
  let meta: { id: string; cwd: string; startedAt?: number; parentId?: string } | undefined
  let prompt = ''
  let model: string | undefined
  let steps = 0
  let latest = ''
  let state: CodexRecord['state'] = 'running'
  let endedAt: number | undefined
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let d: { type?: string; timestamp?: string; payload?: Record<string, unknown> }
    try { d = JSON.parse(line) } catch { continue } // a cut first or last line of a partial read
    const p = d.payload ?? {}
    const at = d.timestamp ? Date.parse(d.timestamp) : NaN
    if (d.type === 'session_meta' && !meta && typeof p.id === 'string' && typeof p.cwd === 'string') {
      // Only command-line runs: the Codex app's and editors' sessions and Codex's own approval
      // reviewer write records here too.
      const sub = (p.source as { subagent?: { other?: unknown; thread_spawn?: { parent_thread_id?: unknown } } } | undefined)?.subagent
      if (p.originator !== 'codex_exec' || p.thread_source === 'guardian_review' || sub?.other === 'guardian') return undefined
      const parent = sub?.thread_spawn?.parent_thread_id
      const start = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : at
      meta = { id: p.id, cwd: slash(p.cwd), startedAt: Number.isFinite(start) ? start : undefined, ...(typeof parent === 'string' ? { parentId: `codex:${parent}` } : {}) }
    } else if (d.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call')) {
      steps++
    } else if (d.type === 'event_msg') {
      if (p.type === 'thread_settings_applied') {
        const m = (p.thread_settings as { model?: unknown } | undefined)?.model
        if (typeof m === 'string') model = m
      } else if (p.type === 'item_completed') {
        const item = p.item as { type?: string; content?: unknown; text?: unknown } | undefined
        // A pipeline brief says what its run does on a "Task:" line, below a routing header.
        if (item?.type === 'UserMessage' && !prompt) prompt = taskName(textOf(item)) || firstLine(textOf(item), BRIEF_HEADER)
        else if (item?.type === 'AgentMessage') latest = firstLine(textOf(item), HEADING) || firstLine(textOf(item)) || latest
      } else if (p.type === 'task_started') {
        state = 'running'
        endedAt = undefined
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        state = p.type === 'task_complete' ? 'completed' : 'failed'
        endedAt = Number.isFinite(at) ? at : undefined
      }
    }
  }
  if (!meta) return undefined
  return { ...meta, prompt, model, steps: whole ? steps : undefined, latest, state, endedAt }
}

export function codexRow(r: CodexRecord, mtimeMs: number, current: number, lang: Lang = 'zh'): WatchedAgent {
  const endUnknown = r.state === 'running' && current - mtimeMs >= STALE_MS
  return {
    id: `codex:${r.id}`, description: r.prompt || t(lang).codexTask, type: 'Codex', model: r.model, parentId: r.parentId,
    status: endUnknown ? 'completed' : r.state, startedAt: r.startedAt, lastActivityAt: mtimeMs,
    endedAt: endUnknown ? mtimeMs : r.endedAt, ...(endUnknown ? { endUnknown: true as const } : {}),
    steps: r.steps ?? -1, latest: r.latest, tasks: {},
  }
}

export function owned(cwd: string, root: string | undefined, dirs: readonly string[]) {
  return [...(root ? [slash(root)] : []), ...dirs].some(base => inside(cwd, base))
}

function textOf(item: { content?: unknown; text?: unknown }) {
  if (typeof item.text === 'string') return item.text
  if (!Array.isArray(item.content)) return ''
  return item.content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
}

const BRIEF_HEADER = /^((Base|Parent) task:|Model \S+, effort )/
const HEADING = /^(#+\s|(\*\*|__)(?:(?!\2).)*[^.。!！?？\s]\2[:：]?$)/ // a heading line says nothing on its own; a bold sentence does

function taskName(text: string) {
  return firstLine(text.match(/^Task:[ \t]*(.+)$/m)?.[1] ?? '')
}

function firstLine(text: string, skip?: RegExp) {
  const line = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(l => l && !(skip?.test(l))) ?? ''
  return [...line.replace(/^(\*\*|__)((?:(?!\1).)+)\1([:：]?)$/, '$2$3')].slice(0, 60).join('') // only a wholly bold line is unwrapped
}

function inside(path: string, base: string) {
  const b = base.replace(/\/+$/, '')
  return path === b || path.startsWith(`${b}/`)
}

function slash(path: string) {
  return path.replace(/\\/g, '/')
}

export function pad(n: number) {
  return String(n).padStart(2, '0')
}
