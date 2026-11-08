// Session usage: a small "上下文 42% | 缓存 52m" label in the prompt footer. A click on it opens the
//   details above the prompt (usage windows, session cost, prompt cache, context fill); another
//   click folds them again. Every session starts folded. A toast warns once per window past WARN_AT.
//   The cache countdown is estimated: the API keeps the main conversation's cache for one TTL
//   after its last request, and the mod has no reading of it, so it counts from the last
//   main-loop response that reported cache tokens, with the TTL Claude Code would request.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, RenderNode, Timer, TurnUsage } from 'claude-code'

import type { CacheState, ContextReading, PaceBase, UsageSnapshot, UsageWindow } from '../types'
import { detectLang, sliceLabel, t, windowLabel } from './i18n'
import type { Lang } from './i18n'

const BIG_CONTEXT = 100_000 // from here an expiring cache is worth a toast
const FIVE_MIN = 5 * 60_000
const HOUR = 60 * 60_000
const TICK_MS = 30_000
const WARN_AT = 90
const TOP_SLICES = 4
const EXPIRY_WARN_MS = 5 * 60_000 // how long before the cache expires the toast warns
const PACE_MIN_MS = 10 * 60_000 // the shortest stretch a pace estimate is drawn from
const LABEL_GAP = 2 // cells between the longest label and the number column
const VALUE_CELLS = 9 // its number column, left-aligned like the others so each column starts on one line; fits $1000.00
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
// Held by the host, so they survive a hot reload of this file.
const usage = atom({ plugin: 'session-usage', key: 'usage' } as const, null as UsageSnapshot | null)
const ctx = atom({ plugin: 'session-usage', key: 'ctx' } as const, null as ContextReading | null)
const cache = atom({ plugin: 'session-usage', key: 'cache' } as const, null as CacheState | null)
const tick = atom({ plugin: 'session-usage', key: 'tick' } as const, 0)
const isOpen = atom({ plugin: 'session-usage', key: 'isOpen' } as const, false)
const warned = atom({ plugin: 'session-usage', key: 'warned' } as const, {} as Record<string, number>)
const pace = atom({ plugin: 'session-usage', key: 'pace' } as const, {} as Record<string, PaceBase>)
const expiryWarned = atom({ plugin: 'session-usage', key: 'expiryWarned' } as const, 0)

// The language is detected once per load, on first use.
let setting: unknown
let detected: Promise<Lang> | undefined
function langOf($: EngineInterface) {
  return (detected ??= detectLang($, setting))
}

export const register: Register = (on, options) => {
  setting = options.language
  detected = undefined
  let timer: Timer | undefined // one countdown timer, even if session.start fires again
  let steppedTurn: string | undefined // the main-loop turn whose steps already moved the countdown

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(undefined) // clears the test line an earlier version pinned
    // Moves the cache countdown on while it runs.
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void (async () => {
        const c = await read($, cache)
        const now = await $.clock.now()
        if (c && c.tokens > 0 && c.at + c.ttlMs + TICK_MS > now) await update($, tick, n => n + 1)
        await warnExpiry($, c, now, await langOf($))
      })().catch(() => {})
    })
    const u = await $.session.usage().catch(() => null)
    if (u) await take($, u.rateLimits, u.cost?.usd, await langOf($)).catch(() => {})
    void refresh($).catch(() => {})
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await take($, e.rateLimits, e.cost?.usd, await langOf($)).catch(() => {})
    return r
  })

  // Every main-loop request renews the cache, so a long turn moves the countdown at each step,
  // not only when its reply ends.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!e.agentId && r.usage) {
      // Only a stamp that landed stands in for the turn's end; a failed one leaves the fallback.
      const stamped = await stampCache($, r.usage).then(() => true, () => false)
      if (stamped) steppedTurn = e.turnId
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r // a subagent's turn fills its own window and cache, not this one's
    await refresh($).catch(() => {})
    // A turn whose steps stamped already holds its last request; the turn's usage is a sum.
    if (e.usage && steppedTurn !== e.turnId) await stampCache($, e.usage).catch(() => {})
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && 'messages' in r) void refresh($).catch(() => {}) // a /compact empties the window without a turn ending
    return r
  })

  // The footer label, right of the prompt footer, beside the engine's own mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const snap = await read($, usage)
    const reading = await read($, ctx)
    const open = await read($, isOpen)
    await read($, tick) // redraws on each tick of the cache countdown
    const c = await read($, cache)
    const now = await $.clock.now()
    const L = t(await langOf($))
    const { Box, Button, Text } = $.ui.resolve(e)
    // One short plain label: the footer slot is narrow, and separate pills cut it off sooner.
    // A click opens the details above the prompt; another click folds them.
    // Context and cache only: plans lost the five-hour window (2026-11-01) and the app's own ring shows the
    // weekly one; a click opens every window in the details.
    const label = [`${L.context} ${pct(reading?.percent)}`, `${L.cache} ${cacheShort(c, now, await langOf($))}`].join(' | ')
    const expiring = !!c && c.tokens > 0 && c.at + c.ttlMs - now > 0 && c.at + c.ttlMs - now <= EXPIRY_WARN_MS
    return (
      <Box flexDirection="row" gap="md">
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button key="usage" plain label={label} onPress={() => toggle($)}><Text>{`${L.context} ${pct(reading?.percent)} | `}</Text><Text color={expiring ? 'warning' : undefined}>{`${L.cache} ${cacheShort(c, now, await langOf($))}`}</Text></Button>
      </Box>
    )
  })

  // Above the prompt: the details, while the footer label holds them open.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    if (e.props.hasSurvey || !(await read($, isOpen))) return rest
    const snap = await read($, usage)
    const reading = await read($, ctx)
    await read($, tick) // redraws on each tick of the cache countdown
    const c = await read($, cache)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    // The details card, as a list of one so the tree keeps the array shape the desktop draws.
    const rows = detailRows(snap, c, reading, now, await read($, pace), await langOf($))
    const cards = [rows]
    const labelCells = Math.max(...rows.map(r => cells(r.label))) + LABEL_GAP // fits the longest label
    const mine = (
      <Box key="momo-band-3-usage" flexDirection="column">
        {cards.map(rows => (
          <Box key="details" flexDirection="column">
            {rows.map(row => (
              <Box key={row.label} flexDirection="row">
                {/* One cell in, so the labels line up with button text drawn above them. */}
                <Box width={1} flexShrink={0} />
                <Box width={labelCells} flexShrink={0}>
                  <Text dimColor>{row.label}</Text>
                </Box>
                <Box width={VALUE_CELLS} flexShrink={0}>
                  <Text wrap="truncate">{row.value}</Text>
                </Box>
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate">
                    {row.note}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
    return stack(rest, mine, Box)
  })
}

async function toggle($: EngineInterface) {
  const now = await update($, isOpen, o => !o)
  if (now) await refresh($).catch(() => {})
}

async function take($: EngineInterface, rateLimits: readonly UsageWindow[], costUsd: number | undefined, lang: Lang) {
  const windows = rateLimits
    .filter(w => Number.isFinite(w.percentUsed))
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
  const now = await $.clock.now()
  await update($, usage, () => ({ rateLimits: windows, costUsd, at: now }))
  await update($, pace, old => nextBases(old, windows, now))
  await warn($, windows, lang)
}

// Asks the engine for /context's breakdown, estimated locally (no token-count calls).
async function refresh($: EngineInterface) {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return // no window to measure against
  const slices = b.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens }))
    .sort((x, y) => y.tokens - x.tokens)
  await update($, ctx, () => ({
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
  }))
}

// One toast per window per reset period, once it passes WARN_AT.
async function warn($: EngineInterface, windows: UsageWindow[], lang: Lang) {
  const done = await read($, warned)
  const now = await $.clock.now()
  const fresh: Record<string, number> = {}
  for (const w of windows) {
    if (w.percentUsed < WARN_AT) continue
    const resetMs = resetTime(w)
    const last = done[w.kind]
    if (last !== undefined && resetMs <= last + 30 * 60_000) continue // a reset time that moved on by more than half an hour is a new period
    fresh[w.kind] = resetMs
    $.ui.toast(t(lang).quotaToast(quotaName(w.kind, lang), Math.round(w.percentUsed), resetMs > 0 ? t(lang).resetsIn(countdown(resetMs - now)) : ''))
  }
  if (Object.keys(fresh).length > 0) await update($, warned, old => ({ ...old, ...fresh }))
}

// The TTL Claude Code requests for the main conversation, in its order of precedence:
// FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting,
// ENABLE_PROMPT_CACHING_1H, then one hour on a subscription within its plan usage, else five minutes.
async function cacheTtl($: EngineInterface) {
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M').catch(() => undefined)) === '1') return FIVE_MIN
  const fromEnv = ttlOf(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(() => undefined))
  if (fromEnv) return fromEnv
  for (const source of ['policy', 'flag', 'local', 'project', 'user'] as const) {
    const settings = (await $.settings.read({ source }).catch(() => ({}))) as Record<string, unknown>
    const fromSettings = ttlOf(settings.promptCacheTtl)
    if (fromSettings) return fromSettings
  }
  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(() => undefined)) === '1') return HOUR
  // A subscription reports rate-limit windows; one at 100% means usage credits, which drop to five minutes.
  const windows = (await read($, usage))?.rateLimits ?? []
  return windows.length > 0 && windows.every(w => w.percentUsed < 100) ? HOUR : FIVE_MIN
}

function ttlOf(value: unknown) {
  return value === '1h' ? HOUR : value === '5m' ? FIVE_MIN : undefined
}

function windowPct(snap: UsageSnapshot | null, kind: string) {
  return snap?.rateLimits.find(w => w.kind === kind)?.percentUsed
}

// The footer's word for the cache: minutes left, 已过期, or — before the first reply.
export function cacheShort(c: CacheState | null, now: number, lang: Lang = 'zh') {
  if (!c) return '—'
  if (c.tokens === 0) return t(lang).cacheUnused
  const left = c.at + c.ttlMs - now
  return left > 0 ? `${Math.max(1, Math.ceil(left / 60_000))}m` : t(lang).cacheExpired
}

// One row per window, then context, cache and this session: a short label, a number and a note,
// laid out in three aligned columns.
export type DetailRow = { label: string; value: string; note: string }

export function detailRows(snap: UsageSnapshot | null, c: CacheState | null, reading: ContextReading | null, now: number, bases: Record<string, PaceBase> = {}, lang: Lang = 'zh'): DetailRow[] {
  const L = t(lang)
  const rows: DetailRow[] = (snap?.rateLimits ?? [])
    .filter(w => !(resetTime(w) > 0 && resetTime(w) <= now)) // a window past its reset waits for a fresh reading
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(w => {
      const resetMs = resetTime(w)
      const reset = resetMs > 0 ? L.resetsIn(countdown(resetMs - now)) : ''
      const out = paceOut(bases[w.kind], w, snap?.at ?? now, now, lang)
      return { label: windowName(w.kind, lang), value: `${Math.round(w.percentUsed)}%`, note: [reset, out].filter(Boolean).join(' · ') }
    })
  if (rows.length === 0) rows.push({ label: L.quota, value: '—', note: L.appearsAfterReply })
  if (reading) {
    const compacts = reading.compactsAt ? L.compactsAt(tokens(reading.compactsAt)) : ''
    rows.push({ label: L.context, value: `${reading.percent}%`, note: `${tokens(reading.total)} / ${tokens(reading.window)}${compacts}` })
  } else rows.push({ label: L.context, value: '—', note: L.noData })
  rows.push({ label: L.cache, value: cacheShort(c, now, lang), note: cacheNote(c, reading, now, lang) })
  const cost = snap?.costUsd !== undefined && snap.costUsd > 0 ? `$${snap.costUsd.toFixed(2)}` : '—'
  const slices = reading ? reading.slices.slice(0, TOP_SLICES).map(s => `${sliceLabel(lang, s.name)} ${tokens(s.tokens)}`).join(' · ') : ''
  rows.push({ label: L.session, value: cost, note: slices })
  return rows
}

// "按现在速度约 40m 后用完", only when the window would run out before it resets.
// The first reading of each reset period is the base a pace is measured from. A window missing from
// one reading keeps its base; a new reset time, or a share below the last reading, starts a new one.
async function stampCache($: EngineInterface, usage: TurnUsage) {
  const tokens = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const now = await $.clock.now()
  const ttlMs = await cacheTtl($).catch(() => HOUR)
  await update($, cache, () => ({ at: now, ttlMs, tokens }))
}

export function nextBases(old: Record<string, PaceBase>, windows: readonly UsageWindow[], now: number) {
  const fresh: Record<string, PaceBase> = { ...old }
  for (const w of windows) {
    const base = old[w.kind]
    const same = base && base.resetsAt === w.resetsAt && (base.last ?? base.pct) <= w.percentUsed
    fresh[w.kind] = same ? { ...base, last: w.percentUsed } : { at: now, pct: w.percentUsed, last: w.percentUsed, resetsAt: w.resetsAt }
  }
  return fresh
}

// The rate runs from the period's first reading to the latest one (`sampledAt`), so time passing
// with no new reading does not dilute it.
export function paceOut(base: PaceBase | undefined, w: UsageWindow, sampledAt: number, now: number, lang: Lang = 'zh') {
  if (!base || sampledAt - base.at < PACE_MIN_MS || w.percentUsed <= base.pct) return ''
  const perMs = (w.percentUsed - base.pct) / (sampledAt - base.at)
  const runsOutAt = sampledAt + (100 - w.percentUsed) / perMs
  const resetMs = resetTime(w)
  if (runsOutAt <= now || (resetMs > 0 && runsOutAt >= resetMs)) return ''
  return t(lang).runsOutIn(countdown(runsOutAt - now))
}

// One toast per cached response, a few minutes before a large conversation's cache expires.
async function warnExpiry($: EngineInterface, c: CacheState | null, now: number, lang: Lang) {
  if (!c || c.tokens < BIG_CONTEXT) return
  const left = c.at + c.ttlMs - now
  if (left <= 0 || left > EXPIRY_WARN_MS || (await read($, expiryWarned)) === c.at) return
  await update($, expiryWarned, () => c.at)
  $.ui.toast(t(lang).expiryToast(countdown(left)))
}

function cacheNote(c: CacheState | null, reading: ContextReading | null, now: number, lang: Lang) {
  const L = t(lang)
  if (!c) return L.appearsAfterReply
  if (c.tokens === 0) return L.cacheNotUsed
  const left = c.at + c.ttlMs - now
  if (left > 0) return L.cacheValid(c.ttlMs >= HOUR ? '1h' : '5m', tokens(c.tokens)) // the value column holds the minutes left
  return L.cacheRead(reading ? tokens(reading.total) : tokens(c.tokens))
}

export function countdown(ms: number) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  // Times read m, h and d throughout, as in the footer.
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

function pct(n: number | undefined) {
  return n === undefined ? '—' : `${Math.round(n)}%`
}

// Character cells a label takes: CJK and other wide characters take two.
export function cells(text: string) {
  return [...text].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
}

function windowName(kind: string, lang: Lang) {
  return windowLabel(lang, kind)
}

// The window's name as a toast says it: 周额度, 5h 额度, 花费上限.
function quotaName(kind: string, lang: Lang) {
  return t(lang).quotaName(windowName(kind, lang))
}

function rank(kind: string) {
  const i = ORDER.indexOf(kind)
  return i < 0 ? ORDER.length : i
}

function resetTime(w: UsageWindow) {
  const ms = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(ms) ? ms : 0
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
