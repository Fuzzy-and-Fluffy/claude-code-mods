import type { EngineInterface } from 'claude-code'

export type Lang = 'zh' | 'en'

// zh* (zh-Hans-AU, zh_CN.UTF-8) is Chinese; any other real tag is English; empty, C and POSIX say nothing.
export function langOf(tag: string | undefined): Lang | undefined {
  const t = tag?.trim()
  if (!t || /^(C|POSIX)([.@].*)?$/i.test(t)) return undefined
  return /^zh/i.test(t) ? 'zh' : 'en'
}

let detected: Promise<Lang> | undefined

// Forgets the system answer, so the next 'auto' asks again (a plugin load and the tests start clean).
export function resetLang() {
  detected = undefined
}

export async function detectLang($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'zh' || setting === 'en') return setting
  detected ??= fromSystem($).catch((): Lang => 'en')
  return detected
}

async function fromSystem($: EngineInterface): Promise<Lang> {
  for (const found of [
    await $.env.get('LC_ALL').catch(() => undefined),
    await $.env.get('LC_MESSAGES').catch(() => undefined),
    await $.env.get('LANG').catch(() => undefined),
  ]) {
    const lang = langOf(found)
    if (lang) return lang
  }
  const windows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const out = await $.process.run(windows ? ['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name'] : ['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 5000 }).catch(() => null)
  if (out?.exitCode !== 0) return 'en'
  // macOS prints a list: ( "en-AU", "zh-Hans-AU" ); Windows prints one culture name.
  const first = out.stdout.match(/[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*/)?.[0]
  return langOf(first) ?? 'en'
}

const TEXT = {
  zh: {
    paneTitle: '子助手',
    commandDescription: '在面板里看子助手进度（手机上也能看）',
    paneOpened: '子助手面板已打开。',
    paneFailed: (reason: string) => `子助手面板没能打开（${reason}）。可以稍后再输入 /agent-watch 试一次。`,
    details: '详情',
    transcriptUnreadable: '子助手记录无法读取，请返回后重新打开。',
    roleAgent: '子助手',
    roleTask: '任务',
    noMessages: '暂无子助手消息。',
    noAgents: '这个会话还没有子助手。',
    currentTask: '当前任务',
    thisTurn: '这一轮已做',
    lastTurn: '上一轮做了',
    runningWaiting: (n: number) => `在跑 / 等待 ${n}`,
    noneRunning: '现在没有在运行的子助手。',
    open: '打开',
    doneFold: (n: number, arrow: string) => `已完成 ${n} ${arrow}`,
    background: (n: number) => `后台 ${n}`,
    bgWaiting: '◐ 等待',
    bgRunning: '● 在跑',
    cronsPane: (n: number) => `定时唤醒 ${n} 个`,
    cronsBand: (n: number) => `定时唤醒 ${n}`,
    summary: (running: number, waits: number, stuck: number, done: number, failed: number) =>
      `子助手 ${running} 在跑${waits ? ` · ${waits} 等待` : ''}${stuck ? ` · ${stuck} 停住` : ''} · ${done} 完成${failed ? ` · ${failed} 失败` : ''}`,
    working: (time: string) => `● 正在工作 ${time}`,
    stoppedWaiting: '◐ 已停下，在等后台',
    stopped: '○ 已停下',
    typeNames: { shell: '后台命令', monitor: '监控', workflow: '流程', other: '其他后台' },
    agentsCount: (n: number, running: boolean) => `子助手 ${n}${running ? ' 在跑' : ''}`,
    stuckCount: (n: number) => `停住 ${n}`,
    waited: (time: string) => `已等 ${time}`,
    lastTurnTook: (time: string) => `上一轮做了 ${time}`,
    todo: (done: number, total: number) => ` · 待办 ${done}/${total}`,
    steps: (n: number) => ` · ${n} 步`,
    endUnknown: ' · 结束方式未知',
    itemDone: '✔︎ 完成',
    itemFailed: '✖︎ 失败',
    itemStuck: (min: number) => `◐ 停住 ${min} 分钟`,
    itemRunning: '● 在跑',
    itemWaiting: '◐ 等待',
    underOneMinute: '不到 1m',
    codexTask: 'Codex 任务',
  },
  en: {
    paneTitle: 'Sub-agents',
    commandDescription: 'Show sub-agent progress in a pane (works on the phone too)',
    paneOpened: 'Sub-agents pane opened.',
    paneFailed: (reason: string) => `Could not open the sub-agents pane (${reason}). Try /agent-watch again in a moment.`,
    details: 'Details',
    transcriptUnreadable: "Can't read this sub-agent's messages. Go back and open it again.",
    roleAgent: 'Sub-agent',
    roleTask: 'Task',
    noMessages: 'No sub-agent messages yet.',
    noAgents: 'No sub-agents in this chat yet.',
    currentTask: 'Current task',
    thisTurn: 'This turn so far',
    lastTurn: 'Last turn took',
    runningWaiting: (n: number) => `Running / waiting ${n}`,
    noneRunning: 'No sub-agents running right now.',
    open: 'Open',
    doneFold: (n: number, arrow: string) => `Done ${n} ${arrow}`,
    background: (n: number) => `Background ${n}`,
    bgWaiting: '◐ Waiting',
    bgRunning: '● Running',
    cronsPane: (n: number) => `Scheduled wake-ups: ${n}`,
    cronsBand: (n: number) => `Scheduled wake-ups ${n}`,
    summary: (running: number, waits: number, stuck: number, done: number, failed: number) =>
      `Sub-agents ${running} running${waits ? ` · ${waits} waiting` : ''}${stuck ? ` · ${stuck} stuck` : ''} · ${done} done${failed ? ` · ${failed} failed` : ''}`,
    working: (time: string) => `● Working ${time}`,
    stoppedWaiting: '◐ Stopped, waiting on background work',
    stopped: '○ Stopped',
    typeNames: { shell: 'Background command', monitor: 'Monitor', workflow: 'Workflow', other: 'Other background' },
    agentsCount: (n: number, running: boolean) => `Sub-agents ${n}${running ? ' running' : ''}`,
    stuckCount: (n: number) => `Stuck ${n}`,
    waited: (time: string) => `Waited ${time}`,
    lastTurnTook: (time: string) => `Last turn took ${time}`,
    todo: (done: number, total: number) => ` · To-do ${done}/${total}`,
    steps: (n: number) => ` · ${n} steps`,
    endUnknown: ' · Ended: unknown',
    itemDone: '✔︎ Done',
    itemFailed: '✖︎ Failed',
    itemStuck: (min: number) => `◐ Stuck ${min} min`,
    itemRunning: '● Running',
    itemWaiting: '◐ Waiting',
    underOneMinute: 'Under 1m',
    codexTask: 'Codex task',
  },
} as const

export function t(lang: Lang) {
  return TEXT[lang]
}
