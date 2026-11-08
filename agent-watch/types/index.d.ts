export type WatchedAgent = {
  id: string
  description: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  parentId?: string
  model?: string
  startedAt?: number
  lastActivityAt?: number
  endedAt?: number
  endUnknown?: true
  steps: number
  latest: string
  tasks: Record<string, boolean>
}

export type TurnTiming = { turnId?: string; startedAt?: number; endedAt?: number }
export type BackgroundSnapshot = {
  tasks: { id: string; type: string; description: string; status?: 'running' | 'pending' }[]
  crons: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': {
      selected: string | null
      agents: WatchedAgent[]
      tick: number
      doneOpen: boolean
      turn: TurnTiming
      background: BackgroundSnapshot
      codex: WatchedAgent[]
      codexDirs: string[]
    }
  }
}
