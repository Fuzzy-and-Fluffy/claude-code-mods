// The main conversation's prompt cache, as the last main-loop response left it.
export type CacheState = {
  at: number // when that response came back, in $.clock.now() milliseconds
  ttlMs: number // the cache lifetime that response's request asked for
  tokens: number // tokens the response read from or wrote to the cache; 0 when caching is off
}

// What the toolbar shows of the last handoff: working, done, or why it failed.
export type HandoffStatus = { at: number; text: string }

// One 收尾 check: each item done, missing, or unknown (a failed lookup never reads as done).
export type ItemState = 'done' | 'missing' | 'unknown'
export type CloseoutItem = { state: ItemState; label: string; note: string }
export type CloseoutReport = { at: number; verdict: string; items: CloseoutItem[]; prompt: string }

declare module 'claude-code' {
  interface PluginState {
    // session-usage's reading, which the toolbar only reads; that mod declares and writes it.
    'session-usage': {
      cache: CacheState | null
    }
    'session-toolbar': {
      handoff: HandoffStatus | null
      compactArmed: number
      closeout: CloseoutReport | null
      closeoutBusy: boolean
      tick: number
      workedIn: string | null
    }
  }
}
