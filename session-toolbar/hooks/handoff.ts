// The handoff note and kickoff prompt, built from what is already on this machine: the
//   transcript rows, the task list's tool calls, the files the session edited, git state and the
//   outstanding-work ledger. No model call is made, so the long conversation's cache is never read.
//   Pure functions: the register file gathers the inputs through $ and writes the results.
import type { SessionMessage } from 'claude-code'

export type HandoffInput = {
  messages: readonly SessionMessage[]
  cwd: string
  notePath: string
  transcriptPath?: string // absent when the transcript file could not be found
  git?: { status: string; lastCommit: string } // absent outside a git repository
  ledger?: { path: string; text: string }
  now: number
}

export type PlanItem = { content: string; status: string }

const GOAL_LIMIT = 1200
const RECENT_USER = 6
const USER_LIMIT = 600
const REPORT_LIMIT = 2500
const FILES_LIMIT = 30
const STATUS_LINES = 40
const LEDGER_LIMIT = 3000
const COMMAND_LIMIT = 200
const CHECKS_KEPT = 10

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

// The person's own words in a user row: the reminders, command echoes and tags the engine adds go.
export function userWords(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-[a-z]+|command-[a-z]+|task-notification|side-sessions-event)>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Keeps the head and the tail of a long text, as a reader skims it.
export function clip(text: string, limit: number): string {
  const t = text.trim()
  if (t.length <= limit) return t
  const head = Math.floor(limit * 0.65)
  return `${t.slice(0, head)}\n……（中间省略 ${t.length - limit} 字）……\n${t.slice(-(limit - head))}`
}

// The task list as the last update_plan call and the steps after it left it.
export function planOf(messages: readonly SessionMessage[]): PlanItem[] {
  let items: PlanItem[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.tool === WRAP_TOOL) {
        items = items.map(i => ({ ...i, status: 'completed' }))
        continue
      }
      if (use.tool !== PLAN_TOOL) continue
      const input = use.input
      if (Array.isArray(input.items)) {
        items = input.items
          .filter((i): i is { content: string; status: string } => typeof i === 'object' && i !== null && typeof (i as PlanItem).content === 'string')
          .map(i => ({ content: i.content, status: typeof i.status === 'string' ? i.status : 'pending' }))
        continue
      }
      if (input.advance === true) {
        const at = items.findIndex(i => i.status === 'in_progress')
        if (at >= 0) items[at] = { ...items[at]!, status: 'completed' }
        const next = items.findIndex(i => i.status === 'pending')
        if (next >= 0) items[next] = { ...items[next]!, status: 'in_progress' }
      }
      if (Array.isArray(input.done)) {
        for (const n of input.done) if (typeof n === 'number' && items[n - 1]) items[n - 1] = { ...items[n - 1]!, status: 'completed' }
      }
      if (typeof input.start === 'number' && items[input.start - 1]) {
        items = items.map((i, k) => (k === (input.start as number) - 1 ? { ...i, status: 'in_progress' } : i.status === 'in_progress' ? { ...i, status: 'pending' } : i))
      }
    }
  }
  return items
}

// The files the session wrote, newest last, each once.
export function editedFiles(messages: readonly SessionMessage[]): string[] {
  const seen: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      const path = use.input.file_path ?? use.input.notebook_path
      if (!EDIT_TOOLS.has(use.tool) || typeof path !== 'string' || use.isError) continue
      const at = seen.indexOf(path)
      if (at >= 0) seen.splice(at, 1)
      seen.push(path)
    }
  }
  return seen.slice(-FILES_LIMIT)
}

const HIDDEN = '[已隐去]'

// Hides what looks like a secret in free text before it goes into a note that gets pasted into
//   a new session: the known shapes, then a generic rule for long random-looking runs.
export function redact(text: string): string {
  return redactShapes(text)
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, run => (/\d/.test(run) && /[A-Za-z]/.test(run) && /[A-Z+/=]/.test(run) ? HIDDEN : run))
}

// The known secret shapes only. It runs once more over the whole finished note, kickoff and
//   clipboard text, so a field that skipped redact() (a path, a folder) still loses them; the
//   generic long-run rule is left out there because it would hide ordinary paths.
export function redactShapes(text: string): string {
  return text
    // The unprefixed shapes start only where a word starts, so the tail of an ordinary word stays:
    //   disk-cleanup-tool, risk-assessment, task-management, laughs_and_cries.
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, HIDDEN)
    .replace(/github_pat_[A-Za-z0-9_]{8,}/g, HIDDEN)
    // Prefixed tokens of common services: GitLab, Google, Hugging Face, npm, PyPI, Stripe, Shopify,
    //   SendGrid, DigitalOcean, Slack app tokens, OpenAI/Anthropic project keys are caught by sk- above.
    .replace(/\b(?:glpat-|glrt-|gldt-|AIza|ya29\.|hf_|npm_|pypi-|(?:sk|rk|pk)_(?:live|test)_|shp(?:at|ss|ca|pa)_|SG\.|dop_v1_|xapp-)[A-Za-z0-9._-]{8,}/g, HIDDEN)
    .replace(/\b(?:ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, HIDDEN)
    .replace(/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}/g, HIDDEN)
    .replace(/AKIA[0-9A-Z]{16}/g, HIDDEN)
    .replace(/(?<![A-Za-z0-9])xox[A-Za-z]-[A-Za-z0-9-]{8,}/g, HIDDEN)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, HIDDEN)
    .replace(/(:\/\/)[^\s/@]+@/g, `$1${HIDDEN}@`)
    .replace(/(authorization["']?[ \t]*[=:][ \t]*)(?:"[^"]*"|'[^']*'|[^"'\n]*)/gi, `$1${HIDDEN}`)
    .replace(/bearer\s+[^\s"']+/gi, HIDDEN)
    .replace(/((?:^|\s)(?:-u|--user)(?:=|[ \t]+))(?:"[^"]*"|'[^']*'|\S+)/g, `$1${HIDDEN}`)
    .replace(/([A-Za-z0-9_]*(?:pass|secret|token|api[_-]?key|access_key|private_key|credential|auth)[A-Za-z0-9_]*["']?[ \t]*[=:][ \t]*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, `$1${HIDDEN}`)
}

// One redacted, clipped line: a label as a list item shows it.
function oneLine(text: string, limit: number): string {
  return clip(redact(text.replace(/\s*\n\s*/g, ' ')), limit).replace(/\s*\n\s*/g, ' ')
}

// redact() is only the second layer: a pattern list can always miss a secret. What a note writes
//   from a command is dropped whole when it looks like it could hold one.
const SUSPICIOUS = /key|token|secret|pass|auth|bearer|credential|cookie|session|@|\b[A-Za-z0-9+/=_-]{20,}\b/i
const COMMAND_WITHHELD = '（命令已省略）'

const CD_FIRST = /^cd[ \t]+[A-Za-z0-9_./~-]+[ \t]*&&[ \t]*/
const CHECK = /^(?:npx(?:[ \t]+-y)?(?:[ \t]+(?:-p|--package)[ \t]+[\w@./-]+)?[ \t]+)?(claude[ \t]+plugin[ \t]+(?:test|validate)|tsc|pytest|(?:npm|pnpm|yarn|bun)[ \t]+(?:run[ \t]+)?(?:test|typecheck|lint|validate)|vitest|jest|cargo[ \t]+(?:test|check)|go[ \t]+test)((?:[ \t]+[A-Za-z0-9_./:=,@+-]+)*)$/

// What each check accepts after its name, by allowlist: a flag or a word not listed here may make it
//   print, list, collect or dry-run instead of checking, and such a call is left out of the note.
//   `values` are flags that take the next word; `words` are the positional words a check takes.
const NONE = /(?!)/
const ANY_WORD = /^[^-@]/ // `@file` makes tsc and pytest read more arguments from a file
const ALLOWED: Record<string, { flags: RegExp; values?: readonly string[]; words: RegExp }> = {
  claude: { flags: NONE, words: ANY_WORD },
  tsc: { flags: /^--noEmit$/, values: ['-p', '--project'], words: ANY_WORD },
  pytest: { flags: /^(?:-q|-qq|-x|-v|-vv|--tb=\w+)$/, words: ANY_WORD },
  vitest: { flags: /^--run$/, words: /^(?:run|[^-@].*[/.].*)$/ }, // `vitest list` lists, `vitest bench` benches
  jest: { flags: /^(?:--ci|--silent|--runInBand|-i)$/, words: ANY_WORD },
  cargo: { flags: /^(?:--all|--workspace|-q|--quiet|--release)$/, words: ANY_WORD },
  go: { flags: /^(?:-v|-race|-short|-count=[1-9]\d*)$/, words: ANY_WORD },
  package: { flags: NONE, words: NONE }, // npm, pnpm, yarn, bun: the script runs as written
}

// One check invocation with plain, unquoted arguments, each one on its check's allowlist: no
//   operator, redirect, substitution, quote or env assignment.
function isPureCheck(command: string): boolean {
  const match = CHECK.exec(command.trim().replace(CD_FIRST, ''))
  if (!match) return false
  const name = match[1]!.split(/[ \t]+/)[0]!
  const allowed = ALLOWED[name] ?? ALLOWED.package!
  const args = match[2]!.trim().split(/[ \t]+/).filter(Boolean)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (allowed.values?.includes(arg)) {
      if (args[i + 1] === undefined || args[i + 1]!.startsWith('-')) return false
      i++
    } else if (!(arg.startsWith('-') ? allowed.flags : allowed.words).test(arg)) return false
  }
  return true
}

// What one call proves, from the stored record alone and never from its words, which name test files,
//   job ids and anything else. An errored call did not pass (it failed, or was interrupted): 未通过.
//   A pass needs Bash's own record saying it ran to the end in the foreground. Anything else (in
//   flight, backgrounded, timed out, or a record the session did not store) proves nothing and is left out.
function outcome(use: SessionMessage['toolUses'][number]): '通过' | '未通过' | undefined {
  if (use.isError) return '未通过'
  if (typeof use.result !== 'object' || use.result === null) return undefined
  const r = use.result as Record<string, unknown>
  const finished = r.interrupted === false && r.backgroundTaskId === undefined && r.backgroundedByUser !== true &&
    r.backgroundedByTurnAbort !== true && r.backgroundedToDeliverMessage !== true && r.timedOutAfterMs === undefined
  return finished ? '通过' : undefined
}

// The last run of each pure check command as list lines, oldest run first. Nothing says whether a
//   run is still current: the note tells the reader to run the checks again.
export function checkRuns(messages: readonly SessionMessage[]): string[] {
  const last = new Map<string, string>()
  for (const m of messages) {
    for (const use of m.toolUses) {
      const command = use.tool === 'Bash' && typeof use.input.command === 'string' ? use.input.command : ''
      const result = isPureCheck(command) ? outcome(use) : undefined
      if (result === undefined) continue
      last.delete(command)
      last.set(command, `- ${SUSPICIOUS.test(command) ? COMMAND_WITHHELD : `\`${oneLine(command, COMMAND_LIMIT)}\``}：${result}`)
    }
  }
  return [...last.values()].slice(-CHECKS_KEPT)
}

export function buildHandoff(input: HandoffInput): { note: string; kickoff: string } {
  const users = input.messages.filter(m => m.role === 'user').map(m => userWords(m.text)).filter(t => t !== '')
  const lastReport = [...input.messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
  const plan = planOf(input.messages)
  const files = editedFiles(input.messages)
  const checks = checkRuns(input.messages)
  const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }
  const when = new Date(input.now).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

  const sections = [
    `# 交接说明（${when}）`,
    '',
    `工作目录：\`${input.cwd}\``,
    '本说明由交接按钮在本机整理，没有调用模型；内容是原话摘录，不是完整总结。',
    '',
    '## 最初的目标',
    users[0] ? clip(redact(users[0]), GOAL_LIMIT) : '（没有找到）',
    '',
    '## 最近的指示（原话，最新的在最后）',
    ...(users.length > 1 ? users.slice(1).slice(-RECENT_USER).map(t => `- ${clip(redact(t), USER_LIMIT).replace(/\n/g, '\n  ')}`) : ['（没有）']),
    '',
    '## Claude 最后的汇报',
    lastReport ? clip(redact(lastReport.text), REPORT_LIMIT) : '（没有）',
    '',
    '## 任务清单',
    ...(plan.length > 0 ? plan.map(i => `- ${mark[i.status] ?? '[ ]'} ${redact(i.content)}`) : ['（这个会话没有任务清单）']),
    '',
    '## 改过的文件',
    ...(files.length > 0 ? files.map(f => `- \`${f}\``) : ['（没有）']),
    '',
    '## 最近的检查（接手后请重跑一次再相信）',
    ...(checks.length > 0 ? checks : ['（没有跑过）']),
    '',
    '## 代码状态',
    ...(input.git
      ? ['```', redact(input.git.status.split('\n').slice(0, STATUS_LINES).join('\n')).trim() || '（工作区干净）', '```', `最近一次提交：${redact(input.git.lastCommit).trim() || '（没有）'}`]
      : ['（不是 git 仓库）']),
    '',
    '## 待办记录',
    ...(input.ledger ? [`来自 \`${input.ledger.path}\`：`, '', clip(redact(input.ledger.text), LEDGER_LIMIT)] : ['（工作目录里没有 OUTSTANDING.md）']),
    '',
    '## 原会话记录',
    input.transcriptPath
      ? `\`${input.transcriptPath}\`（很大：需要细节时按关键词搜索，不要整份读取）`
      : '（没有找到记录文件）',
  ]

  const kickoff = [
    '请接手上一个会话的工作。',
    '',
    firstCheck(input.cwd),
    '',
    `1. 先读交接说明：${input.notePath}`,
    '2. 核对现在的实际状态（git status、相关文件、待办记录），以现状为准。',
    '3. 只继续没做完的部分，不要重复已完成的工作；有等我决定的事，先用一句话重新问我。',
    ...(input.transcriptPath ? [`4. 需要更多细节时，到原会话记录里按关键词搜索，不要整份读取：${input.transcriptPath}`] : []),
    '',
    '下一步：',
  ].join('\n')

  return { note: redactShapes(sections.join('\n') + '\n'), kickoff: redactShapes(kickoff) }
}

// The desktop app opens `claude://code/new?q=…&folder=…` as a new Code session in that folder with
// `q` in its prompt box, unsent; it keeps the first 14336 characters of `q`. The whole note goes in
// while it fits, so it can be reviewed right there; a longer one is sent by its path instead.
export const PREFILL_LIMIT = 12_000

export function prefill(kickoff: string, note: string, notePath: string, folder: string): string {
  const whole = [
    '请接手上一个会话的工作。下面是交接说明（同一份也存在 ' + notePath + '）。',
    '',
    firstCheck(folder),
    '',
    '读完后：先核对现在的实际状态（git status、相关文件、待办记录），以现状为准；只继续没做完的部分，不要重复已完成的工作；有等我决定的事，先用一句话重新问我。需要更多细节时，到交接说明里写的原会话记录按关键词搜索，不要整份读取。',
    '',
    '---',
    '',
    note.trim(),
    '',
    '---',
    '',
    '下一步：',
  ].join('\n')
  return redactShapes(whole.length <= PREFILL_LIMIT ? whole : kickoff)
}

// A link-opened session can start without its folder, and in the ask-every-time mode instead of
// Auto, which then asks for every approval. The new session moves itself to the folder; the mode
// is the user's to switch, so it only says so.
export function firstCheck(folder: string): string {
  return `开工前先检查本会话（get_session self）：工作文件夹应是 ${folder} 或它所在的项目，不是的话先用 change_directory 切过去；权限模式应是 auto，不是的话，回复第一行用中文告诉我“这个会话是每次询问模式，请在输入框下方把模式切回 Auto”，不要自己改模式。`
}

export function newSessionLink(text: string, folder: string): string {
  return `claude://code/new?q=${encodeURIComponent(text)}&folder=${encodeURIComponent(folder)}`
}

export type Platform = 'mac' | 'windows'

// The commands that put text on the clipboard and open a link, per system. Both read text as
// UTF-8 on purpose: without it, macOS pbcopy and Windows PowerShell garble the Chinese.
export function clipboardCommand(platform: Platform): { argv: string[]; env?: Record<string, string> } {
  if (platform === 'windows') {
    return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'] }
  }
  return { argv: ['pbcopy'], env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }
}

// On Windows the link reaches PowerShell through an environment variable, so no shell splits it at
// the & between its parameters. Start-Process does not fail for an unregistered scheme (Windows
// asks which app to use instead), so the claude:// handler is checked first (its key with a URL Protocol value): exit 3 without it.
export function openCommand(platform: Platform, link: string): { argv: string[]; env?: Record<string, string> } {
  if (platform === 'windows') {
    const script = "$ErrorActionPreference = 'Stop'; if ($null -eq (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\claude' -Name 'URL Protocol' -ErrorAction SilentlyContinue)) { exit 3 }; Start-Process -FilePath $env:USAGE_PEEK_LINK"
    return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script], env: { USAGE_PEEK_LINK: link } }
  }
  return { argv: ['open', link] }
}

// The transcript file Claude Code keeps for a session, by its folder and id.
export function transcriptFile(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
}

// The transcript stays under the folder the session started in; a later move (a folder change, a
//   worktree) does not take it along. So when it is not under the current folder, every project folder
//   is looked in for this session's id. Any failed lookup counts as not found.
export async function findTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  exists: (path: string) => Promise<boolean>,
  list: (path: string) => Promise<readonly { name: string; kind: string }[]>,
): Promise<string | undefined> {
  const here = transcriptFile(home, cwd, sessionId)
  if (await exists(here).catch(() => false)) return here
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined
  const projects = `${home}/.claude/projects`
  const dirs = await list(projects).catch(() => [])
  for (const dir of dirs) {
    if (dir.kind === 'file') continue // a link ('other') may lead to a folder
    const path = `${projects}/${dir.name}/${sessionId}.jsonl`
    if (await exists(path).catch(() => false)) return path
  }
  return undefined
}

// A chat started with no project lives in a scratch workspace, and that stays its root after it moves
//   into a project; its folder can also fall back there. Then the work happened in the last project
//   folder its transcript records, and the next session belongs there. Unreadable lines are skipped.
export function isScratch(folder: string): boolean {
  return /[\\/]scratch-workspaces[\\/]/.test(folder)
}

export function workFolder(root: string, transcript: string): string {
  if (!isScratch(root)) return root
  const lines = transcript.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown
    try {
      record = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    const folder = record && typeof record === 'object' ? (record as { cwd?: unknown }).cwd : undefined
    if (typeof folder === 'string' && folder && !isScratch(folder)) return folder
  }
  return root
}

// A file name for the note: when it was made and the folder it came from.
export function noteName(cwd: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
  const folder = (cwd.split('/').filter(Boolean).at(-1) ?? 'session').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)
  return `${stamp}-${folder}.md`
}
