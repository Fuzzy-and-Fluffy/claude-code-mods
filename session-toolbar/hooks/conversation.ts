// Local, per-conversation records. No transcript edits, native rewind or shell writes.
import type { EngineInterface } from 'claude-code'
import { newSessionLink, openCommand, userWords } from './handoff'
import { t } from './i18n'
import type { Lang } from './i18n'

import type { RewindSelection, SideHistory, SideQuestion, SideView } from '../types'
const LIMIT = 1_000_000 // below fs.read's 4 MiB even for UTF-8; refuse rather than truncate

export function choices(messages: readonly { role: 'user' | 'assistant'; text: string; toolResults?: readonly unknown[]; isQuestion?: boolean }[]) {
  return messages.flatMap((m, index) => m.role === 'user' && m.isQuestion !== false && !m.toolResults?.length && userWords(m.text)
    ? [{ index, text: userWords(m.text) }] : [])
}

export async function selection($: EngineInterface, lang: Lang = 'zh'): Promise<RewindSelection> {
  const T = t(lang).conversation
  const sessionId = await $.session.id()
  const cwd = await $.session.root()
  const messages = await $.session.messages()
  // The API gives only the newest 4096 rows. A full page cannot prove the start is present.
  if (messages.length >= 4096) throw new Error(T.fullPage)
  if (!choices(messages).length) throw new Error(T.noQuestions)
  const questionIndexes = new Set(choices(messages).map(c => c.index))
  return { sessionId, cwd, messages: messages.map((m, i) => ({ role: m.role, text: m.text, isQuestion: questionIndexes.has(i) })) }
}

export function choiceText(s: RewindSelection, lang: Lang = 'zh'): string {
  const T = t(lang).conversation
  return [T.choiceHead,
    ...choices(s.messages).map((c, i) => `${i + 1}. ${c.text.replace(/\s+/g, ' ').slice(0, 100)}`),
    T.choiceFoot].join('\n')
}

async function directory($: EngineInterface, sessionId: string, lang: Lang): Promise<string> {
  const T = t(lang).conversation
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error(T.badId)
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return `${config}/session-toolbar/${sessionId}`
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) throw new Error(T.noHome)
  return `${home}/.claude/session-toolbar/${sessionId}`
}

export async function writeVerified($: EngineInterface, path: string, value: unknown, lang: Lang = 'zh'): Promise<void> {
  const T = t(lang).conversation
  const text = JSON.stringify(value, null, 2)
  if (text.length > LIMIT) throw new Error(T.tooLarge)
  await $.fs.write(path, text)
  if (await $.fs.read(path) !== text) throw new Error(T.readbackFailed)
}

export async function branch($: EngineInterface, s: RewindSelection, number: number, lang: Lang = 'zh'): Promise<string> {
  const T = t(lang).conversation
  const chosen = choices(s.messages)[number - 1]
  if (!Number.isInteger(number) || !chosen) throw new Error(T.badNumber)
  const current = await selection($, lang)
  const prefix = s.messages.slice(0, chosen.index + 1)
  if (current.sessionId !== s.sessionId || current.cwd !== s.cwd ||
    JSON.stringify(current.messages.slice(0, chosen.index + 1)) !== JSON.stringify(prefix)) {
    throw new Error(T.changed)
  }
  const path = `${await directory($, s.sessionId, lang)}/branch-${await $.clock.now()}-${chosen.index}.json`
  if (await $.fs.exists(path)) throw new Error(T.exists)
  // Joined tool outcomes can have arrived after the chosen user row. Copy only text in order;
  // never leak a later tool result into an earlier branch or pretend to replay tool state.
  await writeVerified($, path, { version: 1, sourceSessionId: s.sessionId, cwd: s.cwd,
    messages: prefix.map(m => ({ role: m.role, text: m.text })) }, lang)
  const draft = T.draft(path, s.cwd)
  const platform = (await $.env.get('OS')) === 'Windows_NT' ? 'windows' : 'mac'
  const open = openCommand(platform, newSessionLink(draft, s.cwd))
  const result = await $.process.run(open.argv, { ...(open.env ? { env: open.env } : {}), timeoutMs: 15_000 }).catch(() => null)
  if (!result || result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated) {
    throw new Error(T.notOpened(path))
  }
  // A launch receipt does not prove a client opened: the owner sees the confirmation there.
  return T.opened(path)
}

export async function history($: EngineInterface, lang: Lang = 'zh'): Promise<{ key: string; value: SideHistory }> {
  const sessionId = await $.session.id()
  const key = `side-questions:${sessionId}`
  const raw = await $.store.get(key)
  if (raw === undefined) return { key, value: { version: 1, sessionId, questions: [] } }
  const v = raw as SideHistory | null
  if (!v || v.version !== 1 || v.sessionId !== sessionId || !Array.isArray(v.questions) ||
    !v.questions.every(q => q && typeof q.question === 'string' && typeof q.answer === 'string' &&
      typeof q.engine === 'string' && Number.isFinite(q.at) && Math.abs(q.at) <= 8.64e15 &&
      ['pending', 'answered', 'failed'].includes(q.status) && (q.error === undefined || typeof q.error === 'string') &&
      (q.modelAtRequest === undefined || typeof q.modelAtRequest === 'string'))) {
    throw new Error(t(lang).conversation.badHistory)
  }
  return { key, value: v }
}

async function saveHistory($: EngineInterface, key: string, value: SideHistory, lang: Lang) {
  const T = t(lang).conversation
  const text = JSON.stringify(value)
  if (text.length > LIMIT) throw new Error(T.historyFull)
  await $.store.set(key, value)
  if (JSON.stringify(await $.store.get(key)) !== text) throw new Error(T.historyReadback)
}

export function historyText(questions: readonly SideQuestion[], lang: Lang = 'zh'): string {
  const T = t(lang)
  return questions.length ? questions.map(q => [
    `${new Date(q.at).toISOString()} · ${q.engine} · ${q.status === 'answered' ? T.answered : q.status === 'failed' ? T.failed : T.unfinished}`,
    `${T.asked}${q.question}`, q.status === 'answered' ? `${T.answer}${q.answer}` : q.error ?? T.notSaved,
  ].join('\n')).join('\n\n') : T.conversation.noHistory
}

export function sidePrompt(questions: readonly SideQuestion[], question: string, lang: Lang = 'zh'): string {
  const T = t(lang).conversation
  return [
    T.sideHead,
    T.sideContext,
    JSON.stringify(questions.filter(q => q.status === 'answered').map(q => ({ question: q.question, answer: q.answer, at: q.at, engine: q.engine }))),
    T.sideCurrent, question,
  ].join('\n')
}

// Serialized by the caller across command and button paths. Persist pending before any model call.
export async function askSide($: EngineInterface, question: string, show: (view: SideView) => Promise<void>, lang: Lang = 'zh'): Promise<string> {
  const T = t(lang).conversation
  const { key, value } = await history($, lang)
  const entry: SideQuestion = { question, answer: '', at: await $.clock.now(), engine: 'Claude Code', modelAtRequest: await $.session.model(), status: 'pending' }
  const prompt = sidePrompt(value.questions, question, lang)
  if (prompt.length > LIMIT) throw new Error(T.contextTooLarge)
  value.questions.push(entry)
  await saveHistory($, key, value, lang)
  await show({ questions: value.questions, text: T.answering, busy: true })
  try {
    const reply = await $.model.fork({ prompt })
    if (!reply.isAnswered) throw new Error(reply.reason === 'nothing-to-fork'
      ? T.nothingToFork
      : T.noAnswer(reply.reason))
    if (!reply.text.trim()) throw new Error(T.emptyAnswer)
    entry.answer = reply.text
    entry.status = 'answered'
  } catch (err) {
    entry.status = 'failed'
    entry.error = err instanceof Error ? err.message : String(err)
  }
  try {
    await saveHistory($, key, value, lang)
  } catch {
    const text = T.saveFailed(historyText([entry], lang))
    await show({ questions: value.questions, text, busy: false })
    return text
  }
  const text = historyText([entry], lang)
  await show({ questions: value.questions, text: entry.status === 'failed' ? entry.error! : '', busy: false })
  return text
}
