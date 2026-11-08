// 收尾: where the work stands, from git, gh and the outstanding-work ledger, with no model call.
//   An item is done only on direct evidence about the commit HEAD points at: the working tree is
//   clean, a remote-tracking ref holds HEAD, the remote default branch holds HEAD, the CI runs for
//   HEAD all passed. Anything inferred (a PR's state, a ledger with nothing visibly open) is shown
//   as unknown with what was seen, never as done; so is every lookup that failed.

import type { CloseoutItem, CloseoutReport } from '../types'
import { OPEN_SECTION, OPEN_SECTION_ZH, t } from './i18n'
import type { Lang } from './i18n'

export type Run = (argv: string[], init: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string } | null>
export type ReadResult = { kind: 'missing' } | { kind: 'error' } | { kind: 'text'; text: string }
export type ReadText = (path: string) => Promise<ReadResult>

export type PrNote = { number: number; state: string; base: string; head: string }
export type CiFacts = { pass: number; fail: number; pending: number; other: number } // other: neutral or skipped
export type CloseoutFacts = {
  top: string | null // the repository's top folder; null outside a repository
  gitFailed: boolean // git could not be asked, or failed for a reason other than "not a repository"
  head: string | null // the commit HEAD points at
  changed: number | null // modified, staged or deleted tracked files
  untracked: number | null
  otherWorktrees: { path: string; dirty: number | null }[]
  worktreesUnchecked: number | null // worktrees not looked at; null when the list could not be read
  stashes: number | null
  hasRemote: boolean | null
  fetched: boolean // every remote was fetched just now
  remoteHolds: string[] | null // remote-tracking refs (refs/remotes/...) that contain HEAD
  defaultBranch: string | null // as origin/<name>
  merged: boolean | null // origin's default branch contains HEAD
  onGitHub: boolean
  githubRepo: string | null // owner/name of origin on GitHub, which the CI and PR lookups are pinned to
  branch: string | null
  ci: CiFacts | null // the GitHub Actions runs for HEAD; null when gh could not be asked or the list may be cut
  changedDuring: boolean // HEAD or the working tree changed while the checks ran
  shallow: boolean | null // a shallow clone lacks the history that proves containment
  pr: PrNote | 'none' | null // shown for information only
  ledgers: { path: string; open: number; readable: boolean }[]
}

const QUICK = 10_000
const NETWORK = 20_000
const MAX_WORKTREES = 12
const MAX_RUNS = 100 // a full page of CI runs may hide more: then the CI reads as unknown
export const LEDGER_NAMES = ['OUTSTANDING.md', 'ACTIVE-WORK.md', 'HANDOVER.md'] as const

export async function gatherFacts(run: Run, read: ReadText, cwd: string): Promise<CloseoutFacts> {
  const git = (args: string[], timeoutMs = QUICK, at = cwd) => run(['git', '-C', at, ...args], { cwd: at, timeoutMs })
  const facts: CloseoutFacts = {
    top: null,
    gitFailed: false,
    head: null,
    changed: null,
    untracked: null,
    otherWorktrees: [],
    worktreesUnchecked: 0,
    stashes: null,
    hasRemote: null,
    fetched: false,
    remoteHolds: null,
    defaultBranch: null,
    merged: null,
    onGitHub: false,
    githubRepo: null,
    branch: null,
    ci: null,
    changedDuring: false,
    shallow: null,
    pr: null,
    ledgers: [],
  }
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top?.exitCode === 0) facts.top = top.stdout.trim()
  else if (!top || !/not a git repository/i.test(top.stderr)) facts.gitFailed = true
  const readLedgers = async () => {
    for (const path of [...new Set([cwd, ...(facts.top ? [facts.top] : [])])].flatMap(dir => LEDGER_NAMES.map(name => `${dir}/${name}`))) {
      const r = await read(path)
      if (r.kind === 'text') facts.ledgers.push({ path, open: openItems(r.text), readable: true })
      else if (r.kind === 'error') facts.ledgers.push({ path, open: 0, readable: false })
    }
  }

  if (facts.top) {
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    if (status?.exitCode === 0) {
      const lines = status.stdout.split('\n').filter(Boolean)
      facts.untracked = lines.filter(l => l.startsWith('??')).length
      facts.changed = lines.length - facts.untracked
    }
    const head = await git(['rev-parse', 'HEAD'])
    if (head?.exitCode === 0) facts.head = head.stdout.trim()
    // Compare contents too: a dirty file can change without changing the status or file count.
    // Read-only hash-object (no -w) includes new files; failed/truncated evidence never passes.
    const contents = async (): Promise<string | null> => {
      const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'], QUICK, facts.top!)
      const files = await git(['ls-files', '--others', '--exclude-standard', '-z'], QUICK, facts.top!)
      if (diff?.exitCode !== 0 || files?.exitCode !== 0) return null
      const paths = files.stdout.split('\0').filter(Boolean)
      if (paths.length > 200) return null // bound argv and work; an incomplete snapshot refuses
      const hashes = paths.length ? await git(['hash-object', '--no-filters', '--', ...paths], QUICK, facts.top!) : null
      if (paths.length && (hashes?.exitCode !== 0 || hashes.stdout.trim().split('\n').length !== paths.length)) return null
      return JSON.stringify([diff.stdout, files.stdout, hashes?.stdout ?? ''])
    }
    const before = await contents()
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch?.exitCode === 0 && branch.stdout.trim() !== 'HEAD') facts.branch = branch.stdout.trim()
    const shallow = await git(['rev-parse', '--is-shallow-repository'])
    if (shallow?.exitCode === 0) facts.shallow = shallow.stdout.trim() === 'true'

    const worktrees = await git(['worktree', 'list', '--porcelain'])
    if (worktrees?.exitCode === 0) {
      const others = worktrees.stdout
        .split('\n')
        .filter(l => l.startsWith('worktree '))
        .map(l => l.slice('worktree '.length))
        .filter(p => p !== facts.top)
      for (const path of others.slice(0, MAX_WORKTREES)) {
        const s = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], QUICK, path)
        facts.otherWorktrees.push({ path, dirty: s?.exitCode === 0 ? s.stdout.split('\n').filter(Boolean).length : null })
      }
      facts.worktreesUnchecked = Math.max(0, others.length - MAX_WORKTREES)
    } else facts.worktreesUnchecked = null
    const stash = await git(['stash', 'list'])
    if (stash?.exitCode === 0) facts.stashes = stash.stdout.split('\n').filter(Boolean).length

    const remotes = await git(['remote', '-v'])
    if (remotes?.exitCode === 0) {
      facts.hasRemote = remotes.stdout.trim() !== ''
      // github.com exactly: as git@github.com:owner/name, ssh://git@github.com/owner/name or https://github.com/owner/name.
      const onGitHub = /(?:@|\/\/)(?:[^@/\s]+@)?github\.com[:/]/
      facts.onGitHub = remotes.stdout.split('\n').some(l => onGitHub.test(l))
      const origin = /^origin\t(?:https:\/\/(?:[^@/\s]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s\(fetch\)$/m.exec(remotes.stdout)
      facts.githubRepo = origin?.[1] ? `github.com/${origin[1]}` : null
    }
    const names = remotes?.exitCode === 0 ? [...new Set(remotes.stdout.split('\n').map(l => l.split('\t')[0]?.trim() ?? '').filter(Boolean))] : []
    if (facts.hasRemote) {
      // Each remote by name (so skipFetchAll cannot leave one stale), pruned, and origin's default
      // branch asked of the server, not read from a symbolic ref that may be old.
      let ok = names.length > 0
      for (const name of names) {
        const fetch = await git(['fetch', '--quiet', '--prune', name], NETWORK)
        if (fetch?.exitCode !== 0) ok = false
      }
      // What each server holds now, asked directly: local remote-tracking refs may be stale.
      const server = new Map<string, string>() // "origin/main" -> commit
      for (const name of names) {
        const ls = await git(['ls-remote', '--symref', name], NETWORK)
        if (ls?.exitCode !== 0) {
          ok = false
          continue
        }
        for (const line of ls.stdout.split('\n')) {
          const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line)
          if (sym && name === 'origin') facts.defaultBranch = `origin/${sym[1]}`
          const head = /^([0-9a-f]{40})\trefs\/heads\/(\S+)$/.exec(line)
          if (head?.[1] && head[2]) server.set(`${name}/${head[2]}`, head[1])
        }
      }
      facts.fetched = ok
      const sha = facts.head
      if (sha && ok) {
        // A local remote-tracking ref counts only while the server still has it at the same commit.
        const holds = await git(['for-each-ref', '--contains', sha, '--format=%(refname) %(objectname)', ...names.map(n => `refs/remotes/${n}/`)])
        if (holds?.exitCode === 0) {
          facts.remoteHolds = holds.stdout
            .split('\n')
            .map(l => l.split(' '))
            .filter(([ref, obj]) => ref?.startsWith('refs/remotes/') && server.get(ref.slice('refs/remotes/'.length)) === obj)
            .map(([ref]) => ref ?? '')
        }
        const mainSha = facts.defaultBranch ? server.get(facts.defaultBranch) : undefined
        if (mainSha) {
          const ancestor = await git(['merge-base', '--is-ancestor', sha, mainSha])
          facts.merged = ancestor?.exitCode === 0 ? true : ancestor?.exitCode === 1 ? false : null
        }
      }
    }
    const sha = facts.head
    if (facts.githubRepo && sha) {
      // Pinned to origin's repository, disabled workflows included, so another repo's runs never count.
      const runs = await run(['gh', 'run', 'list', '--repo', facts.githubRepo, '--all', '--commit', sha, '--json', 'status,conclusion', '--limit', String(MAX_RUNS)], { cwd: facts.top, timeoutMs: NETWORK })
      if (runs?.exitCode === 0) facts.ci = ciFacts(runs.stdout)
    }
    if (facts.githubRepo && facts.branch) {
      const pr = await run(['gh', 'pr', 'view', facts.branch, '--repo', facts.githubRepo, '--json', 'number,state,baseRefName,headRefOid'], { cwd: facts.top, timeoutMs: NETWORK })
      if (pr?.exitCode === 0) facts.pr = prNote(pr.stdout)
      else if (pr && /no pull requests found/i.test(pr.stderr)) facts.pr = 'none'
    }
    await readLedgers()
    // The answers above must describe one state: if HEAD or the working tree moved meanwhile, none counts.
    const headAfter = await git(['rev-parse', 'HEAD'])
    const statusAfter = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    const after = await contents()
    facts.changedDuring = headAfter?.exitCode !== 0 || headAfter.stdout.trim() !== facts.head || status?.exitCode !== 0 || statusAfter?.exitCode !== 0 || statusAfter.stdout !== status.stdout || before === null || after === null || before !== after
  } else await readLedgers()
  return facts
}

function ciFacts(json: string): CiFacts | null {
  try {
    const runs = JSON.parse(json) as { status?: string; conclusion?: string }[]
    if (runs.length >= MAX_RUNS) return null
    let pass = 0
    let fail = 0
    let pending = 0
    let other = 0
    for (const r of runs) {
      const conclusion = (r.conclusion ?? '').toLowerCase()
      if ((r.status ?? '').toLowerCase() !== 'completed') pending++
      else if (conclusion === 'success') pass++
      else if (conclusion === 'neutral' || conclusion === 'skipped') other++ // proves nothing either way
      else fail++
    }
    return { pass, fail, pending, other }
  } catch {
    return null
  }
}

function prNote(json: string): PrNote | null {
  try {
    const v = JSON.parse(json) as { number: number; state: string; baseRefName?: string; headRefOid?: string }
    return { number: v.number, state: v.state, base: v.baseRefName ?? '', head: v.headRefOid ?? '' }
  } catch {
    return null
  }
}

// What a ledger visibly leaves open: unchecked boxes at any depth, plus list items under a line
// that names an open section ("Open", "Remaining", "待办"...). Only a lower bound: zero never
// proves the ledger is finished, so judge() shows a ledger with none as unknown, not done.
export function openItems(text: string): number {
  let count = 0
  let inOpen = false
  for (const line of text.split('\n')) {
    if (/^\s*[-*] \[ \]/.test(line)) {
      count++
      continue
    }
    if (OPEN_SECTION.test(line.trim()) || OPEN_SECTION_ZH.test(line.trim())) {
      inOpen = true
      continue
    }
    if (/^#/.test(line) || /^[^\s\-*\d][^:：]{0,60}[:：]/.test(line)) inOpen = false
    else if (inOpen && /^(\d+\.|[-*])\s/.test(line) && !/^[-*] \[[xX]\]/.test(line)) count++
  }
  return count
}

export function judge(f: CloseoutFacts, at: number, time: string, lang: Lang = 'zh'): CloseoutReport {
  const C = t(lang).closeout
  const items: CloseoutItem[] = []
  if (f.gitFailed) items.push({ state: 'unknown', label: C.code, note: C.gitFailed })
  if (f.top) {
    const stale = f.fetched ? '' : C.stale
    if (f.changed === null || f.untracked === null) items.push({ state: 'unknown', label: C.commit, note: C.noChanges })
    else if (f.changed + f.untracked === 0) items.push({ state: 'done', label: C.commit, note: C.clean })
    else items.push({ state: 'missing', label: C.commit, note: C.uncommitted(f.changed + f.untracked, f.untracked) })

    const dirty = f.otherWorktrees.filter(w => w.dirty !== null && w.dirty > 0)
    const unread = f.otherWorktrees.filter(w => w.dirty === null).length + (f.worktreesUnchecked ?? 0)
    if (dirty.length > 0) items.push({ state: 'missing', label: C.others, note: C.dirtyOthers(dirty.map(w => w.path.split('/').pop() ?? '')) })
    if (f.worktreesUnchecked === null) items.push({ state: 'unknown', label: C.others, note: C.noWorktrees })
    else if (unread > 0) items.push({ state: 'unknown', label: C.others, note: C.unreadWorktrees(unread) })

    if (f.stashes === null) items.push({ state: 'unknown', label: C.stash, note: C.noStash })
    else if (f.stashes > 0) items.push({ state: 'missing', label: C.stash, note: C.stashes(f.stashes) })

    const cut = f.shallow !== false // a shallow clone, or one not known to be whole, cannot prove a commit is absent
    if (f.hasRemote === false) items.push({ state: 'unknown', label: C.push, note: C.noRemote })
    else if (f.hasRemote === null || f.remoteHolds === null) items.push({ state: 'unknown', label: C.push, note: C.pushUnknown })
    else if (f.remoteHolds.length === 0 && cut) items.push({ state: 'unknown', label: C.push, note: C.pushShallow })
    else if (f.remoteHolds.length === 0) items.push({ state: f.fetched ? 'missing' : 'unknown', label: C.push, note: C.notPushed(stale) })
    else items.push({ state: f.fetched ? 'done' : 'unknown', label: C.push, note: C.pushed(f.remoteHolds[0]?.replace(/^refs\/remotes\//, ''), stale) })

    if (f.hasRemote) {
      const main = f.defaultBranch?.replace(/^origin\//, '') ?? C.mainBranch
      const pr = f.pr && f.pr !== 'none' ? C.prNote(f.pr.number, f.pr.state) : ''
      if (f.merged === null) items.push({ state: 'unknown', label: C.merge, note: C.mergeUnknown(main, pr) })
      else if (f.merged && f.fetched) items.push({ state: 'done', label: C.merge, note: C.merged(main) })
      else if (f.merged) items.push({ state: 'unknown', label: C.merge, note: C.mergedLocal(main, stale) })
      else if (f.pr && f.pr !== 'none' && f.pr.state === 'MERGED' && f.pr.head === f.head && `origin/${f.pr.base}` === f.defaultBranch) {
        items.push({ state: 'unknown', label: C.merge, note: C.squashed(f.pr.number, main) })
      } else if (cut) items.push({ state: 'unknown', label: C.merge, note: C.mergeShallow(main) })
      else items.push({ state: f.fetched ? 'missing' : 'unknown', label: C.merge, note: C.notMerged(main, pr || (f.pr === 'none' ? C.noPr : ''), stale) })
    }

    if (f.hasRemote && !f.onGitHub) items.push({ state: 'unknown', label: C.ci, note: C.notGitHub })
    if (f.onGitHub) {
      if (f.ci === null) items.push({ state: 'unknown', label: C.ci, note: C.ciUnknown })
      else if (f.ci.fail > 0) items.push({ state: 'missing', label: C.ci, note: C.ciFailed(f.ci.fail) })
      else if (f.ci.pending > 0) items.push({ state: 'unknown', label: C.ci, note: C.ciPending(f.ci.pending) })
      else if (f.ci.other > 0) items.push({ state: 'unknown', label: C.ci, note: C.ciSkipped(f.ci.other) })
      else if (f.ci.pass > 0) items.push({ state: 'done', label: C.ci, note: C.ciPassed(f.ci.pass) })
      else items.push({ state: 'unknown', label: C.ci, note: C.ciNone })
    }
    items.push({ state: 'unknown', label: C.deliver, note: C.delivery })
  }
  for (const l of f.ledgers) {
    const name = l.path.split('/').slice(-2).join('/')
    if (!l.readable) items.push({ state: 'unknown', label: C.ledger, note: C.ledgerUnreadable(name) })
    else if (l.open > 0) items.push({ state: 'missing', label: C.ledger, note: C.ledgerOpen(name, l.open) })
    else items.push({ state: 'unknown', label: C.ledger, note: C.ledgerNone(name) })
  }
  if (f.changedDuring) {
    // Evidence about a commit that is no longer HEAD proves nothing: no item of this run stays done.
    for (const item of items) if (item.state === 'done') item.state = 'unknown'
    items.unshift({ state: 'unknown', label: C.moved, note: C.changedDuring })
  }
  if (!f.top && !f.gitFailed && f.ledgers.length === 0) items.push({ state: 'unknown', label: C.scope, note: C.nothing })

  const missing = items.filter(i => i.state === 'missing').length
  const unknown = items.filter(i => i.state === 'unknown').length
  const verdict =
    missing > 0
      ? C.verdictMissing(missing, unknown, time)
      : unknown > 0
        ? C.verdictUnknown(unknown, time)
        : C.verdictDone(time)
  const open = items.filter(i => i.state !== 'done')
  const prompt =
    open.length === 0
      ? ''
      : [
          C.promptHead(time),
          ...open.map(i => C.promptItem(i.state === 'missing', i.label, i.note)),
          ...C.promptBody,
        ].join('\n')
  return { at, verdict, items, prompt }
}
