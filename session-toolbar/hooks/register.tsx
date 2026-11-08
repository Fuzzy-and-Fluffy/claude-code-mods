// Session toolbar: a row of quick buttons above the prompt.
//   进度 asks Claude for decisions waiting on Momo, what is done and what comes next.
//   交接 writes a handoff note with no model call and opens a new session with it prefilled.
//   压缩 runs /compact, asking for a second press when the cache has gone cold.
//   撤回 opens a new conversation from a chosen question; 旁问 keeps its own Q&A history.
//   收尾 checks commit, push, merge, CI and
//   the outstanding-work ledger with git and gh, and shows what is left.
//   The phone draws no AbovePrompt band and places no pane, so the same buttons also live in a
//   工具栏 pane (opened when a phone joins and on /toolbar) and in /toolbar's own output row, which
//   every surface draws; /progress, /handoff and /closeout run 进度, 交接 and 收尾 by name.
//   The cache state comes from session-usage when it is installed (any plugin may read another's
//   state; only the owner writes it). Without it the toolbar shows no cache hint and 压缩 runs at once.
import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, RenderNode, ResolveInput, Timer } from 'claude-code'

import type { CacheState, CloseoutReport, HandoffStatus } from '../types'
import { gatherFacts, judge, LEDGER_NAMES } from './closeout'
import type { ReadResult } from './closeout'
import { buildHandoff, clipboardCommand, newSessionLink, noteName, openCommand, prefill, findTranscript, isScratch, workFolder } from './handoff'
import type { Platform } from './handoff'
import { askSide, branch, choices, choiceText, history, historyText, selection } from './conversation'
import type { RewindSelection, SideView } from '../types'
import { langFor, t } from './i18n'

// 进度: what the button sends, as Momo's own words, once the session is idle.
export const PROGRESS_PROMPT = t('zh').progressPrompt

const STATUS_MS = 3 * 60_000 // how long the last handoff's outcome stays above the prompt
// How long a cold-cache 压缩 waits for its confirming press.
const ARM_MS = 10_000
const BIG_CONTEXT = 100_000 // from here a cold cache makes a handoff the cheaper move
const LABEL_CELLS = 8 // the closeout card's label column, in character cells
const TICK_MS = 5_000 // how often time-bound hints are redrawn while one is showing
const PANE = 'session-toolbar'

// session-usage's own cache reading: undefined when that mod is not installed. Read, never written.
const usageCache = { plugin: 'session-usage', key: 'cache' } as const

// Held by the host, so they survive a hot reload of this file.
const handoff = atom({ plugin: 'session-toolbar', key: 'handoff' } as const, null as HandoffStatus | null)
const compactArmed = atom({ plugin: 'session-toolbar', key: 'compactArmed' } as const, 0)
const closeout = atom({ plugin: 'session-toolbar', key: 'closeout' } as const, null as CloseoutReport | null)
const closeoutBusy = atom({ plugin: 'session-toolbar', key: 'closeoutBusy' } as const, false)
const tick = atom({ plugin: 'session-toolbar', key: 'tick' } as const, 0)
// The last project folder the session was seen in, for 交接 when its root is a scratch workspace.
const workedIn = atom({ plugin: 'session-toolbar', key: 'workedIn' } as const, null as string | null)
const rewindSelection = atom({ plugin: 'session-toolbar', key: 'rewindSelection' } as const, null as RewindSelection | null)
const conversationStatus = atom({ plugin: 'session-toolbar', key: 'conversationStatus' } as const, '')
const sideView = atom({ plugin: 'session-toolbar', key: 'sideView' } as const, null as SideView | null)

// Synchronous locks also cover two surfaces pressing before an awaited state update settles.
let branching = false
let asking = false
// The `language` setting of this load; the language itself is detected once, on first use.
let setting: unknown = 'auto'
const textOf = async ($: EngineInterface) => t(await langFor($, setting))

export const register: Register = (on, options) => {
  setting = options?.language ?? 'auto'
  let timer: Timer | undefined // one redraw timer, even if session.start fires again

  // Redraws while a hint depends on the clock: the handoff outcome (STATUS_MS), the 压缩
  // confirmation (ARM_MS), and the cold-cache hint, which appears once the cache expires.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        const c = await readCache($)
        const done = await read($, handoff)
        const armed = await read($, compactArmed)
        const pending =
          (done !== null && now - done.at < STATUS_MS + TICK_MS) ||
          (armed > 0 && now - armed < ARM_MS + TICK_MS) ||
          (c !== null && c.tokens >= BIG_CONTEXT && c.at + c.ttlMs + TICK_MS > now)
        if (pending) await update($, tick, n => n + 1)
      })().catch(() => {})
    })
    const T = await textOf($)
    await $.command.register({ name: 'toolbar', description: T.cmdToolbar }).catch(() => {})
    await $.command.register({ name: 'progress', description: T.cmdProgress }).catch(() => {})
    await $.command.register({ name: 'handoff', description: T.cmdHandoff }).catch(() => {})
    await $.command.register({ name: 'closeout', description: T.cmdCloseout }).catch(() => {})
    await $.command.register({ name: 'toolbar-rewind', description: T.cmdRewind }).catch(() => {})
    await $.command.register({ name: 'toolbar-ask', description: T.cmdAsk }).catch(() => {})
    return r
  })

  // After each tool call: a session born in a scratch workspace keeps that root while a shell cd works in
  //   a project, and its folder can fall back to the scratch one before 交接 is pressed.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const cwd = await $.session.cwd().catch(() => '')
    if (cwd && !isScratch(cwd)) await update($, workedIn, () => cwd).catch(() => {})
    return r
  })

  // A phone draws only panes: the toolbar opens as one as soon as a phone joins.
  on('session.attach', { surface: 'mobile' }, async ($, e, next) => {
    const r = await next(e)
    void textOf($).then(T => $.ui.open({ id: PANE, title: T.paneTitle })).catch(() => {})
    return r
  })

  on('command.run', { command: 'toolbar' }, async $ => {
    const T = await textOf($)
    const opened = await $.ui.open({ id: PANE, title: T.paneTitle }).catch(() => ({ isPlaced: false as const }))
    // The row under this output draws the buttons where the surface can; the text is for one that cannot,
    // such as a Remote Control phone. Why the pane did not open means nothing to the person reading it.
    if (opened.isPlaced) return { text: T.paneOpened }
    return { text: T.commandList }
  })

  // A command hook may not submit a prompt (the turn would wait on the hook), so 进度 is sent just after it returns.
  on('command.run', { command: 'progress' }, async $ => {
    void $.clock.sleep(0).then(() => askProgress($), () => askProgress($))
    return { text: (await textOf($)).progressQueued }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    await runHandoff($)
    return { text: (await read($, handoff))?.text ?? (await textOf($)).handoffNoResult }
  })

  on('command.run', { command: 'toolbar-rewind' }, async ($, e) => ({ text: await runRewind($, e.args.trim()) }))
  on('command.run', { command: 'toolbar-ask' }, async ($, e) => ({ text: await runSide($, e.args.trim()) }))

  on('command.run', { command: 'closeout' }, async $ => {
    await runCloseout($)
    const r = await read($, closeout)
    const T = await textOf($)
    if (!r) return { text: T.closeoutNoResult }
    const icon = (state: string) => (state === 'done' ? '✅' : state === 'missing' ? '⛔' : '❓')
    return { text: [r.verdict, ...r.items.map(item => `${icon(item.state)} ${item.label}${T.colon}${item.note}`), ...(r.prompt ? ['', T.continueHeader, r.prompt] : [])].join('\n') }
  })

  // /toolbar's output row: the buttons themselves, on every surface that draws it, the phone's included.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'toolbar' || e.props.isErrored) return next(e)
    return toolbar($, e, true)
  })

  // Above the prompt: the toolbar row, the last handoff's outcome and the 收尾 result.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    if (e.props.hasSurvey) return rest
    return stack(rest, await toolbar($, e, false), $.ui.resolve(e).Box)
  })

  // The same toolbar in a pane, its buttons wrapping onto more rows on a narrow phone.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => toolbar($, e, true))
}

async function toolbar($: EngineInterface, e: ResolveInput, wrap: boolean): Promise<RenderElement> {
  await read($, tick) // redraws when a time-bound hint appears or ends
  const c = await readCache($) // also redraws when session-usage records a new reply
  const done = await read($, handoff)
  const report = await read($, closeout)
  const checking = await read($, closeoutBusy)
  const armed = await read($, compactArmed)
  const rewind = await read($, rewindSelection)
  const conversationText = await read($, conversationStatus)
  const side = await read($, sideView)
  const now = await $.clock.now()
  const T = await textOf($)
  const { Box, Button, Text } = $.ui.resolve(e)
  const hint = isCold(c, now) && (c?.tokens ?? 0) >= BIG_CONTEXT ? T.coldHint : ''
  const status = done && now - done.at < STATUS_MS ? done.text : armed && now - armed < ARM_MS ? T.compactConfirm : ''
  const mine = (
    <Box key="momo-band-2-toolbar" flexDirection="column" gap="sm">
      <Box flexDirection="row" gap="sm" flexWrap={wrap ? 'wrap' : 'nowrap'}>
        <Button key="progress" label={T.btnProgress} onPress={() => askProgress($)} />
        <Button key="handoff" label={T.btnHandoff} onPress={() => runHandoff($)} />
        <Button key="compact" label={T.btnCompact} onPress={() => runCompact($)} />
        <Button key="rewind" label={T.btnRewind} onPress={() => runRewind($, '')} />
        <Button key="btw" label={T.btnAside} onPress={async () => { await runSide($, ''); await fillDraft($, '/toolbar-ask ') }} />
        <Button key="closeout" label={T.btnCloseout} onPress={() => runCloseout($)} />
        {hint !== '' && <Text dimColor>{hint}</Text>}
      </Box>
      {conversationText !== '' && <Text>{conversationText}</Text>}
      {rewind && <Box flexDirection="column" gap="sm">
        <Text>{T.rewindPick}</Text>
        {choices(rewind.messages).map((c, i) => ({ ...c, number: i + 1 })).slice(-20).map(c => (
          <Button key={`rewind-choice-${c.index}`} label={`${c.number}. ${c.text.replace(/\s+/g, ' ').slice(0, 80)}`}
            onPress={() => runRewind($, String(c.number))} />
        ))}
        <Button key="rewind-hide" label="⌃" onPress={() => update($, rewindSelection, () => null)} />
      </Box>}
      {side && <Box flexDirection="column" gap="sm">
        {side.questions.length === 0 && <Text>{T.noAside}</Text>}
        {side.questions.map((q, i) => <Box key={`side-record-${i}`} flexDirection="column">
          <Text wrap="truncate">{new Date(q.at).toISOString()} · {q.engine} · {q.status === 'answered' ? T.answered : q.status === 'failed' ? T.failed : T.unfinished}</Text>
          <Text>{T.asked}{q.question}</Text>
          <Text>{q.status === 'answered' ? `${T.answer}${q.answer}` : q.error ?? T.notSaved}</Text>
        </Box>)}
        {side.text !== '' && <Text>{side.text}</Text>}
        <Button key="side-hide" label="⌃" onPress={() => update($, sideView, () => null)} />
      </Box>}
      {/* One cell in, as every text line under the buttons, so they start where the button text does. */}
      {status !== '' && (
        <Box flexDirection="row">
          <Box width={1} flexShrink={0} />
          <Text wrap="truncate">{status}</Text>
        </Box>
      )}
      {checking && (
        <Box flexDirection="row">
          <Box width={1} flexShrink={0} />
          <Text dimColor>{T.checking}</Text>
        </Box>
      )}
      {(report ? [report] : []).map(r => (
        <Box key="closeout-card" flexDirection="column">
          <Box flexDirection="row">
            {/* One cell in, so the text starts where the button text does, not at the button's border. */}
            <Box width={1} flexShrink={0} />
            <Text>{r.verdict}</Text>
          </Box>
          {r.items.map((item, i) => (
            <Box key={`closeout-${i}`} flexDirection="row">
              <Box width={1} flexShrink={0} />
              <Box width={3} flexShrink={0}>
                <Text>{item.state === 'done' ? '✅' : item.state === 'missing' ? '⛔' : '❓'}</Text>
              </Box>
              <Box width={LABEL_CELLS} flexShrink={0}>
                <Text dimColor>{item.label}</Text>
              </Box>
              <Box flexShrink={1}>
                <Text wrap="truncate">{item.note}</Text>
              </Box>
            </Box>
          ))}
          <Box flexDirection="row" gap="sm" marginTop="sm">
            {r.prompt !== '' && <Button key="closeout-go" label={T.btnContinue} onPress={() => fillDraft($, r.prompt)} />}
            <Button key="closeout-again" label={T.btnAgain} onPress={() => runCloseout($)} />
            <Button key="closeout-hide" label={T.btnHide} onPress={() => void update($, closeout, () => null).catch(() => {})} />
          </Box>
        </Box>
      ))}
    </Box>
  )
  return mine
}

async function runRewind($: EngineInterface, arg: string): Promise<string> {
  const lang = await langFor($, setting)
  if (branching) return t(lang).rewindBusy
  branching = true
  try {
    if (!arg) {
      const s = await selection($, lang)
      await update($, rewindSelection, () => s)
      await update($, conversationStatus, () => '')
      return choiceText(s, lang)
    }
    const s = await read($, rewindSelection) ?? await selection($, lang)
    const text = await branch($, s, /^\d+$/.test(arg) ? Number(arg) : NaN, lang)
    await update($, rewindSelection, () => null)
    await update($, conversationStatus, () => text)
    return text
  } catch (err) {
    const text = t(lang).rewindFailed(err instanceof Error ? err.message : String(err))
    await update($, conversationStatus, () => text)
    return text
  } finally { branching = false }
}

async function runSide($: EngineInterface, question: string): Promise<string> {
  const lang = await langFor($, setting)
  if (asking) return t(lang).asideBusy
  asking = true
  const show = (view: SideView) => update($, sideView, () => view).then(() => {})
  try {
    if (!question) {
      const { value } = await history($, lang)
      await show({ questions: value.questions, text: '', busy: false })
      return historyText(value.questions, lang)
    }
    return await askSide($, question, show, lang)
  } catch (err) {
    const text = t(lang).asideFailed(err instanceof Error ? err.message : String(err))
    await update($, sideView, previous => ({ questions: previous?.questions ?? [], text, busy: false }))
    return text
  } finally { asking = false }
}

// 进度: asks Claude, in Momo's words, for decisions waiting on her, what is done and what comes
// next. The prompt runs as its own turn once the session is idle, so a busy session finishes first.
// Not awaited: the submit settles only when its turn runs, which may be after the current one.
async function askProgress($: EngineInterface) {
  const T = await textOf($)
  $.ui.toast(T.progressToast)
  void $.prompt.submit({ text: T.progressPrompt, asUser: true }).catch(() => $.ui.toast(T.progressFailed))
}

// Keep an unsent text draft. The mod API exposes text, not the composer's attachments.
async function fillDraft($: EngineInterface, text: string) {
  const T = await textOf($)
  try {
    const draft = await $.prompt.read()
    if (draft.text === text) return
    if (draft.text.trim()) {
      $.ui.toast(T.draftPresent)
      return
    }
    if (!(await $.prompt.fill({ text, mode: 'replace' })).isFilled) $.ui.toast(T.fillRefused)
  } catch {
    $.ui.toast(T.fillFailed)
  }
}

// 收尾: runs the checks in closeout.ts (git, gh, the ledger; no model call) and shows the result
// above the prompt, with 接着做 to put what is left in the prompt box, unsent.
async function runCloseout($: EngineInterface) {
  if (await read($, closeoutBusy)) return
  const lang = await langFor($, setting)
  await update($, closeoutBusy, () => true)
  await update($, closeout, () => null) // an earlier verdict never stands in for this one
  try {
    const cwd = await $.session.root() // the project folder; the session's own folder can fall back to where it started
    const run = async (argv: string[], init: { cwd: string; timeoutMs: number }) => {
      const result = await $.process.run(argv, init).catch(() => null)
      return result?.isStdoutTruncated || result?.isStderrTruncated ? null : result
    }
    const readText = async (path: string): Promise<ReadResult> => {
      const exists = await $.fs.exists(path).catch(() => null)
      if (exists === null) return { kind: 'error' }
      if (!exists) return { kind: 'missing' }
      const text = await $.fs.read(path).catch(() => null)
      return text === null ? { kind: 'error' } : { kind: 'text', text }
    }
    const facts = await gatherFacts(run, readText, cwd)
    const now = await $.clock.now()
    await update($, closeout, () => judge(facts, now, new Date(now).toTimeString().slice(0, 5), lang))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    const now = await $.clock.now().catch(() => 0)
    await update($, closeout, () => ({ at: now, verdict: t(lang).closeoutError(why), items: [], prompt: '' }))
  } finally {
    await update($, closeoutBusy, () => false)
  }
}

// 交接: gathers what the machine already holds, writes the note, and opens a new Code session in the
// same folder with the handoff in its prompt box, unsent. No model call: the long conversation's
// cache is never read.
async function runHandoff($: EngineInterface) {
  const now = await $.clock.now()
  const lang = await langFor($, setting)
  const T = t(lang)
  await update($, handoff, () => ({ at: now, text: T.handoffPreparing }))
  try {
    // Windows always sets OS=Windows_NT; there HOME may be missing and USERPROFILE holds the home folder.
    const platform: Platform = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT' ? 'windows' : 'mac'
    const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
    if (!home) throw new Error(T.handoffNoHome)
    const root = await $.session.root() // the project folder; the session's own folder can fall back to where it started
    const sessionId = await $.session.id()
    const messages = await $.session.messages()
    const transcript = await findTranscript(home, root, sessionId, path => $.fs.exists(path), path => $.fs.list(path))
    // Seen while it worked, else the transcript's last project record (one read: up to 4 MiB), else the root.
    const seen = isScratch(root) ? await read($, workedIn) : null
    const moved = seen ?? (isScratch(root) && transcript ? workFolder(root, await $.fs.read(transcript).catch(() => '')) : root)
    const cwd = moved !== root && (await $.fs.exists(moved).catch(() => false)) ? moved : root
    const dir = `${home}/.claude/handoffs`
    const notePath = `${dir}/${noteName(cwd, now)}`
    const status = await $.process.run(['git', '-C', cwd, 'status', '--short', '--branch'], { timeoutMs: 10_000 }).catch(() => null)
    const last = status?.exitCode === 0 ? await $.process.run(['git', '-C', cwd, 'log', '-1', '--format=%h %s (%cr)'], { timeoutMs: 10_000 }).catch(() => null) : null
    const ledgers: { path: string; text: string }[] = []
    for (const name of LEDGER_NAMES) {
      const path = `${cwd}/${name}`
      const exists = await $.fs.exists(path).catch(() => null)
      if (exists === false) continue
      const text = exists === null ? null : await $.fs.read(path).catch(() => null)
      ledgers.push({ path, text: text === null ? T.ledgerUnreadable : text.trim() || T.ledgerEmpty })
    }
    const { note, kickoff } = buildHandoff({
      messages,
      cwd,
      notePath,
      transcriptPath: transcript,
      git: status?.exitCode === 0 ? { status: status.stdout, lastCommit: last?.exitCode === 0 ? last.stdout : '' } : undefined,
      ledgers,
      now,
    }, lang)
    await $.fs.write(notePath, note) // creates the folder as needed, on any system
    const draft = prefill(kickoff, note, notePath, cwd, lang)
    const clip = clipboardCommand(platform)
    const copied = await $.process.run(clip.argv, { stdin: draft, ...(clip.env ? { env: clip.env } : {}), timeoutMs: 10_000 }).catch(() => null)
    const open = openCommand(platform, newSessionLink(draft, cwd))
    const opened = await $.process.run(open.argv, { ...(open.env ? { env: open.env } : {}), timeoutMs: 15_000 })
    if (opened.exitCode !== 0) {
      throw new Error(T.openFailed(opened.stderr.trim() || T.unknownReason, copied?.exitCode === 0))
    }
    const text = T.handoffOpened(Math.round(draft.length / 1000), copied?.exitCode === 0)
    await update($, handoff, () => ({ at: now, text }))
    $.ui.toast(text)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, handoff, () => ({ at: now, text: T.handoffFailed(why) }))
  }
}

// 压缩: runs /compact. With the cache gone cold the summary re-reads the whole conversation,
// so the first press only warns and a second press within ARM_MS confirms.
async function runCompact($: EngineInterface) {
  const now = await $.clock.now()
  if (isCold(await readCache($), now)) {
    const armed = await read($, compactArmed)
    if (!armed || now - armed > ARM_MS) {
      await update($, compactArmed, () => now)
      return
    }
  }
  await update($, compactArmed, () => 0)
  await $.command.run({ command: 'compact' })
}

function isCold(c: CacheState | null, now: number) {
  return c !== null && (c.tokens === 0 || c.at + c.ttlMs <= now)
}

// session-usage's cache reading, or null when that mod is not installed or has not seen a reply.
// Any shape it is not drawn from reads as no reading, so a missing or odd answer never stops the row drawing.
async function readCache($: EngineInterface): Promise<CacheState | null> {
  const read = await $.state.get(usageCache).catch(() => null)
  const c = read?.value
  const sane = c && Number.isFinite(c.at) && c.at > 0 && Number.isFinite(c.ttlMs) && c.ttlMs > 0 && Number.isFinite(c.tokens) && c.tokens >= 0
  return sane ? c : null
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
