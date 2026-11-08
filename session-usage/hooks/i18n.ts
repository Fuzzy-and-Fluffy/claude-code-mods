// Language: the mod's on-screen text follows the system language (Chinese if it starts with zh,
//   otherwise English); the `language` setting (auto, zh, en) overrides it.
import type { EngineInterface } from 'claude-code'

export type Lang = 'zh' | 'en'

export function langOf(tag: string | undefined): Lang | undefined {
  const s = tag?.trim()
  if (!s || s === 'C' || s === 'POSIX') return undefined
  return /^zh/i.test(s) ? 'zh' : 'en'
}

// The setting first, then LC_ALL, LC_MESSAGES, LANG, then the system's own list of languages.
// Never throws: no answer is English.
export async function detectLang($: EngineInterface, setting: unknown): Promise<Lang> {
  if (setting === 'zh' || setting === 'en') return setting
  try {
    for (const tag of [await $.env.get('LC_ALL').catch(() => undefined), await $.env.get('LC_MESSAGES').catch(() => undefined), await $.env.get('LANG').catch(() => undefined)]) {
      const lang = langOf(tag)
      if (lang) return lang
    }
    const windows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
    const argv = windows ? ['powershell', '-NoProfile', '-Command', '(Get-UICulture).Name'] : ['defaults', 'read', '-g', 'AppleLanguages']
    const out = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)
    if (out && out.exitCode === 0) {
      // macOS prints a list: ( "en-AU", "zh-Hans-AU" ); Windows prints one name.
      const first = out.stdout.split('\n').map(l => l.replace(/[\s",()]/g, '')).find(Boolean)
      return langOf(first) ?? 'en'
    }
  } catch {}
  return 'en'
}

const WINDOW_NAMES = {
  zh: { five_hour: '5h', seven_day: '周额度', spend_limit: '花费上限' },
  en: { five_hour: '5h', seven_day: 'Weekly', spend_limit: 'Spend cap' },
} as const
const SLICE_NAMES = {
  zh: {
    'system prompt': '系统提示词',
    'system tools': '系统工具',
    'mcp tools': 'MCP 工具',
    'mcp server instructions': 'MCP 说明',
    'custom agents': '自定义代理',
    'memory files': '记忆文件',
    skills: '技能',
    messages: '对话消息',
  },
  en: {
    'system prompt': 'System prompt',
    'system tools': 'System tools',
    'mcp tools': 'MCP tools',
    'mcp server instructions': 'MCP notes',
    'custom agents': 'Custom agents',
    'memory files': 'Memory files',
    skills: 'Skills',
    messages: 'Messages',
  },
} as const

const TEXT = {
  zh: {
    context: '上下文',
    cache: '缓存',
    cacheUnused: '未用',
    cacheExpired: '已过期',
    quota: '额度',
    session: '本次',
    appearsAfterReply: '回复一次后出现',
    noData: '暂无数据',
    resetsIn: (t: string) => `${t} 后重置`,
    runsOutIn: (t: string) => `按现在速度约 ${t} 后用完`,
    compactsAt: (t: string) => ` · 到 ${t} 自动压缩`,
    cacheNotUsed: '上一次回复没有用到缓存',
    cacheValid: (ttl: string, cached: string) => `有效期 ${ttl}，每次回复后重新计时 · 已缓存 ${cached}`,
    cacheRead: (t: string) => `下一条消息要重新读取约 ${t}，会多用一些额度`,
    quotaName: (name: string) => (/(额度|上限)$/.test(name) ? name : `${name} 额度`),
    quotaToast: (name: string, pct: number, resets: string) => `${name}已用 ${pct}%${resets ? `，${resets}` : ''}`,
    expiryToast: (t: string) => `缓存约 ${t} 后过期。要离开一会儿的话，先交接或收尾更省额度`,
  },
  en: {
    context: 'Context',
    cache: 'Cache',
    cacheUnused: 'unused',
    cacheExpired: 'expired',
    quota: 'Quota',
    session: 'Session',
    appearsAfterReply: 'appears after a reply',
    noData: 'no data yet',
    resetsIn: (t: string) => `resets in ${t}`,
    runsOutIn: (t: string) => `runs out in ~${t} at this pace`,
    compactsAt: (t: string) => ` · auto-compacts at ${t}`,
    cacheNotUsed: 'the last reply did not use the cache',
    cacheValid: (ttl: string, cached: string) => `lasts ${ttl}, restarts after each reply · ${cached} cached`,
    cacheRead: (t: string) => `the next message re-reads ~${t}, using a bit more quota`,
    quotaName: (name: string) => (/(limit|cap)$/.test(name) ? name : `${name} limit`),
    quotaToast: (name: string, pct: number, resets: string) => `${name} ${pct}% used${resets ? `, ${resets}` : ''}`,
    expiryToast: (t: string) => `Cache expires in ~${t}. If you step away, wrap up or hand off first to save quota`,
  },
} as const

export function t(lang: Lang) {
  return TEXT[lang]
}

export function windowLabel(lang: Lang, kind: string) {
  return (WINDOW_NAMES[lang] as Record<string, string>)[kind] ?? kind.replace(/_/g, ' ')
}

export function sliceLabel(lang: Lang, name: string) {
  return (SLICE_NAMES[lang] as Record<string, string>)[name] ?? name
}
