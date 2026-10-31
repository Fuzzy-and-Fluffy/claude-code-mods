export type UsageWindow = { kind: string; percentUsed: number; resetsAt?: string }
export type UsageSnapshot = { rateLimits: UsageWindow[]; costUsd?: number; at?: number } // at: when it was read
export type ContextSlice = { name: string; tokens: number }
export type ContextReading = {
  slices: ContextSlice[] // used categories, largest first
  total: number // tokens in use
  window: number // the window measured against
  percent: number
  compactsAt?: number // where auto-compaction runs, when it is on
}
// The main conversation's prompt cache, as the last main-loop response left it.
export type CacheState = {
  at: number // when that response came back, in $.clock.now() milliseconds
  ttlMs: number // the cache lifetime that response's request asked for
  tokens: number // tokens the response read from or wrote to the cache; 0 when caching is off
}

// The first reading of a usage window in its reset period, which a pace is measured from.
export type PaceBase = { at: number; pct: number; last?: number; resetsAt?: string } // last: the latest reading's share

declare module 'claude-code' {
  interface PluginState {
    'session-usage': {
      usage: UsageSnapshot | null
      ctx: ContextReading | null
      cache: CacheState | null
      tick: number
      isOpen: boolean
      warned: Record<string, number>
      pace: Record<string, PaceBase>
      expiryWarned: number
    }
  }
}
