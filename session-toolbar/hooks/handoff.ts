// The handoff note and kickoff prompt, built from what is already on this machine: the
//   transcript rows, the task list's tool calls, the files the session edited, git state and the
//   outstanding-work ledger. No model call is made, so the long conversation's cache is never read.
//   Pure functions: the register file gathers the inputs through $ and writes the results.
import type { SessionMessage } from 'claude-code'

import { t } from './i18n'
import type { Lang } from './i18n'

export type HandoffInput = {
  messages: readonly SessionMessage[]
  cwd: string
  notePath: string
  transcriptPath?: string // absent when the transcript file could not be found
  git?: { status: string; lastCommit: string } // absent when Git evidence was not read
  ledgers?: { path: string; text: string }[]
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
export function clip(text: string, limit: number, lang: Lang = 'zh'): string {
  const s = text.trim()
  if (s.length <= limit) return s
  const head = Math.floor(limit * 0.65)
  return `${s.slice(0, head)}\n${t(lang).handoff.omitted(s.length - limit)}\n${s.slice(-(limit - head))}`
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

// Hides what looks like a secret in free text before it goes into a note that gets pasted into
//   a new session: the known shapes, then a generic rule for long random-looking runs.
export function redact(text: string, lang: Lang = 'zh'): string {
  const HIDDEN = t(lang).handoff.hidden
  return redactShapes(text, lang)
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, run => (/\d/.test(run) && /[A-Za-z]/.test(run) && /[A-Z+/=]/.test(run) ? HIDDEN : run))
}

// The known secret shapes only. It runs once more over the whole finished note, kickoff and
//   clipboard text, so a field that skipped redact() (a path, a folder) still loses them; the
//   generic long-run rule is left out there because it would hide ordinary paths.
export function redactShapes(text: string, lang: Lang = 'zh'): string {
  const HIDDEN = t(lang).handoff.hidden
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
function oneLine(text: string, limit: number, lang: Lang): string {
  return clip(redact(text.replace(/\s*\n\s*/g, ' '), lang), limit, lang).replace(/\s*\n\s*/g, ' ')
}

// redact() is only the second layer: a pattern list can always miss a secret. What a note writes
//   from a command is dropped whole when it looks like it could hold one.
const SUSPICIOUS = /key|token|secret|pass|auth|bearer|credential|cookie|session|@|\b[A-Za-z0-9+/=_-]{20,}\b/i

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
//   job ids and anything else. An errored call did not pass (it failed, or was interrupted).
//   A pass needs Bash's own record saying it ran to the end in the foreground. Anything else (in
//   flight, backgrounded, timed out, or a record the session did not store) proves nothing and is left out.
function outcome(use: SessionMessage['toolUses'][number]): 'passed' | 'failed' | undefined {
  if (use.isError) return 'failed'
  if (typeof use.result !== 'object' || use.result === null) return undefined
  const r = use.result as Record<string, unknown>
  const finished = r.interrupted === false && r.backgroundTaskId === undefined && r.backgroundedByUser !== true &&
    r.backgroundedByTurnAbort !== true && r.backgroundedToDeliverMessage !== true && r.timedOutAfterMs === undefined
  return finished ? 'passed' : undefined
}

// The last run of each pure check command as list lines, oldest run first. Nothing says whether a
//   run is still current: the note tells the reader to run the checks again.
export function checkRuns(messages: readonly SessionMessage[], lang: Lang = 'zh'): string[] {
  const T = t(lang)
  const last = new Map<string, string>()
  for (const m of messages) {
    for (const use of m.toolUses) {
      const command = use.tool === 'Bash' && typeof use.input.command === 'string' ? use.input.command : ''
      const result = isPureCheck(command) ? outcome(use) : undefined
      if (result === undefined) continue
      last.delete(command)
      last.set(command, `- ${SUSPICIOUS.test(command) ? T.handoff.withheld : `\`${oneLine(command, COMMAND_LIMIT, lang)}\``}${T.colon}${T.handoff[result]}`)
    }
  }
  return [...last.values()].slice(-CHECKS_KEPT)
}

export function buildHandoff(input: HandoffInput, lang: Lang = 'zh'): { note: string; kickoff: string } {
  const H = t(lang).handoff
  const users = input.messages.filter(m => m.role === 'user').map(m => userWords(m.text)).filter(t => t !== '')
  const lastReport = [...input.messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
  const plan = planOf(input.messages)
  const files = editedFiles(input.messages)
  const checks = checkRuns(input.messages, lang)
  const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }
  const when = new Date(input.now).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

  const sections = [
    H.title(when),
    '',
    H.folder(input.cwd),
    H.madeHere,
    '',
    H.goal,
    users[0] ? clip(redact(users[0], lang), GOAL_LIMIT, lang) : H.notFound,
    '',
    H.recent,
    ...(users.length > 1 ? users.slice(1).slice(-RECENT_USER).map(u => `- ${clip(redact(u, lang), USER_LIMIT, lang).replace(/\n/g, '\n  ')}`) : [H.none]),
    '',
    H.report,
    lastReport ? clip(redact(lastReport.text, lang), REPORT_LIMIT, lang) : H.none,
    '',
    H.plan,
    ...(plan.length > 0 ? plan.map(i => `- ${mark[i.status] ?? '[ ]'} ${redact(i.content, lang)}`) : [H.noPlan]),
    '',
    H.files,
    ...(files.length > 0 ? files.map(f => `- \`${f}\``) : [H.none]),
    '',
    H.checks,
    ...(checks.length > 0 ? checks : [H.noChecks]),
    '',
    H.code,
    ...(input.git
      ? ['```', redact(input.git.status.split('\n').slice(0, STATUS_LINES).join('\n'), lang).trim() || H.cleanTree, '```', H.lastCommit(redact(input.git.lastCommit, lang).trim() || H.none)]
      : [H.noGit]),
    '',
    H.ledgers,
    ...(input.ledgers?.length ? input.ledgers.flatMap(ledger => [H.ledgerFrom(ledger.path), '', clip(redact(ledger.text, lang), LEDGER_LIMIT, lang), '']) : [H.noLedgers]),
    '',
    H.transcript,
    input.transcriptPath ? H.transcriptAt(input.transcriptPath) : H.noTranscript,
  ]

  const kickoff = [
    H.takeOver,
    '',
    firstCheck(input.cwd, lang),
    '',
    H.readNote(input.notePath),
    H.checkState,
    H.continueOnly,
    ...(input.transcriptPath ? [H.searchTranscript(input.transcriptPath)] : []),
    '',
    H.next,
  ].join('\n')

  return { note: redactShapes(sections.join('\n') + '\n', lang), kickoff: redactShapes(kickoff, lang) }
}

// The desktop app opens `claude://code/new?q=…&folder=…` as a new Code session in that folder with
// `q` in its prompt box, unsent; it keeps the first 14336 characters of `q`. The whole note goes in
// while it fits, so it can be reviewed right there; a longer one is sent by its path instead.
export const PREFILL_LIMIT = 12_000

export function prefill(kickoff: string, note: string, notePath: string, folder: string, lang: Lang = 'zh'): string {
  const H = t(lang).handoff
  const whole = [
    H.prefillHead(notePath),
    '',
    firstCheck(folder, lang),
    '',
    H.afterReading,
    '',
    '---',
    '',
    note.trim(),
    '',
    '---',
    '',
    H.next,
  ].join('\n')
  return redactShapes(whole.length <= PREFILL_LIMIT ? whole : kickoff, lang)
}

// A link-opened session can start without its folder, and in the ask-every-time mode instead of
// Auto, which then asks for every approval. The new session moves itself to the folder; the mode
// is the user's to switch, so it only says so.
export function firstCheck(folder: string, lang: Lang = 'zh'): string {
  return t(lang).handoff.firstCheck(folder)
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
