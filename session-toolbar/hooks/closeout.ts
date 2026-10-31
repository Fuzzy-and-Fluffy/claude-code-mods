// 收尾: where the work stands, from git, gh and the outstanding-work ledger, with no model call.
//   An item is done only on direct evidence about the commit HEAD points at: the working tree is
//   clean, a remote-tracking ref holds HEAD, the remote default branch holds HEAD, the CI runs for
//   HEAD all passed. Anything inferred (a PR's state, a ledger with nothing visibly open) is shown
//   as unknown with what was seen, never as done; so is every lookup that failed.

import type { CloseoutItem, CloseoutReport } from '../types'

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

  if (facts.top) {
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    if (status?.exitCode === 0) {
      const lines = status.stdout.split('\n').filter(Boolean)
      facts.untracked = lines.filter(l => l.startsWith('??')).length
      facts.changed = lines.length - facts.untracked
    }
    const head = await git(['rev-parse', 'HEAD'])
    if (head?.exitCode === 0) facts.head = head.stdout.trim()
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
  }

  if (facts.top) {
    // The answers above must describe one state: if HEAD or the working tree moved meanwhile, none counts.
    const headAfter = await git(['rev-parse', 'HEAD'])
    const statusAfter = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    const dirtyAfter = statusAfter?.exitCode === 0 ? statusAfter.stdout.split('\n').filter(Boolean).length : null
    facts.changedDuring = headAfter?.exitCode !== 0 || headAfter.stdout.trim() !== facts.head || dirtyAfter !== (facts.changed ?? -1) + (facts.untracked ?? 0)
  }

  for (const path of [...new Set([`${cwd}/OUTSTANDING.md`, ...(facts.top ? [`${facts.top}/OUTSTANDING.md`] : [])])]) {
    const r = await read(path)
    if (r.kind === 'text') facts.ledgers.push({ path, open: openItems(r.text), readable: true })
    else if (r.kind === 'error') facts.ledgers.push({ path, open: 0, readable: false })
  }
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
    if (/^(#+\s*)?(open|remaining|outstanding items|todo|to do|待办|未完成|还没做|剩下)\b/i.test(line.trim()) || /^(#+\s*)?(待办|未完成|还没做|剩下)/.test(line.trim())) {
      inOpen = true
      continue
    }
    if (/^#/.test(line) || /^[^\s\-*\d][^:：]{0,60}[:：]/.test(line)) inOpen = false
    else if (inOpen && /^(\d+\.|[-*])\s/.test(line) && !/^[-*] \[[xX]\]/.test(line)) count++
  }
  return count
}

export function judge(f: CloseoutFacts, at: number, time: string): CloseoutReport {
  const items: CloseoutItem[] = []
  if (f.gitFailed) items.push({ state: 'unknown', label: '代码', note: '没能用 git 读这个文件夹，查不了提交和推送' })
  if (f.top) {
    const stale = f.fetched ? '' : '（没能联网更新，按本机记录判断）'
    if (f.changed === null || f.untracked === null) items.push({ state: 'unknown', label: '提交', note: '没读到改动情况' })
    else if (f.changed + f.untracked === 0) items.push({ state: 'done', label: '提交', note: '没有没提交的改动' })
    else items.push({ state: 'missing', label: '提交', note: `有 ${f.changed + f.untracked} 个文件还没提交${f.untracked > 0 ? `（其中 ${f.untracked} 个是新文件）` : ''}` })

    const dirty = f.otherWorktrees.filter(w => w.dirty !== null && w.dirty > 0)
    const unread = f.otherWorktrees.filter(w => w.dirty === null).length + (f.worktreesUnchecked ?? 0)
    if (dirty.length > 0) items.push({ state: 'missing', label: '其他目录', note: `这个项目另有 ${dirty.length} 个工作目录有没提交的改动：${dirty.map(w => w.path.split('/').pop()).join('、')}` })
    if (f.worktreesUnchecked === null) items.push({ state: 'unknown', label: '其他目录', note: '没读到这个项目的其他工作目录' })
    else if (unread > 0) items.push({ state: 'unknown', label: '其他目录', note: `有 ${unread} 个工作目录没查到状态` })

    if (f.stashes === null) items.push({ state: 'unknown', label: '暂存', note: '没读到暂存（stash）列表' })
    else if (f.stashes > 0) items.push({ state: 'missing', label: '暂存', note: `有 ${f.stashes} 份暂存（stash）的改动还没处理` })

    const cut = f.shallow !== false // a shallow clone, or one not known to be whole, cannot prove a commit is absent
    if (f.hasRemote === false) items.push({ state: 'unknown', label: '推送', note: '这个项目没有远程仓库，只存在这台电脑上' })
    else if (f.hasRemote === null || f.remoteHolds === null) items.push({ state: 'unknown', label: '推送', note: '没法判断有没有推送到远程' })
    else if (f.remoteHolds.length === 0 && cut) items.push({ state: 'unknown', label: '推送', note: '这是浅克隆，历史不全，没法核对推送' })
    else if (f.remoteHolds.length === 0) items.push({ state: f.fetched ? 'missing' : 'unknown', label: '推送', note: `最新的提交还没推送到远程${stale}` })
    else items.push({ state: f.fetched ? 'done' : 'unknown', label: '推送', note: `远程已有最新提交（${f.remoteHolds[0]?.replace(/^refs\/remotes\//, '')}）${stale}` })

    if (f.hasRemote) {
      const main = f.defaultBranch?.replace(/^origin\//, '') ?? '主分支'
      const pr = f.pr && f.pr !== 'none' ? `；PR #${f.pr.number} ${f.pr.state === 'MERGED' ? '显示已合并' : f.pr.state === 'CLOSED' ? '已关闭' : '还开着'}` : ''
      if (f.merged === null) items.push({ state: 'unknown', label: '合并', note: `没法判断有没有合并进 ${main}${pr}` })
      else if (f.merged && f.fetched) items.push({ state: 'done', label: '合并', note: `已合并进 ${main}` })
      else if (f.merged) items.push({ state: 'unknown', label: '合并', note: `按本机记录已合并进 ${main}${stale}` })
      else if (f.pr && f.pr !== 'none' && f.pr.state === 'MERGED' && f.pr.head === f.head && `origin/${f.pr.base}` === f.defaultBranch) {
        items.push({ state: 'unknown', label: '合并', note: `PR #${f.pr.number} 显示已合并进 ${main}，但多半是压缩合并，没法按提交核对` })
      } else if (cut) items.push({ state: 'unknown', label: '合并', note: `这是浅克隆，历史不全，没法核对有没有合并进 ${main}` })
      else items.push({ state: f.fetched ? 'missing' : 'unknown', label: '合并', note: `最新的提交还没合并进 ${main}${pr || (f.pr === 'none' ? '；还没开 PR' : '')}${stale}` })
    }

    if (f.hasRemote && !f.onGitHub) items.push({ state: 'unknown', label: '检查', note: '不是 GitHub 仓库，没查自动检查' })
    if (f.onGitHub) {
      if (f.ci === null) items.push({ state: 'unknown', label: '检查', note: '没法查全自动检查（gh 没装好、没登录、没联网，或运行记录太多）' })
      else if (f.ci.fail > 0) items.push({ state: 'missing', label: '检查', note: `最新提交有 ${f.ci.fail} 项自动检查没通过` })
      else if (f.ci.pending > 0) items.push({ state: 'unknown', label: '检查', note: `最新提交还有 ${f.ci.pending} 项自动检查在跑` })
      else if (f.ci.other > 0) items.push({ state: 'unknown', label: '检查', note: `最新提交有 ${f.ci.other} 项自动检查被跳过，没法确认全部通过` })
      else if (f.ci.pass > 0) items.push({ state: 'done', label: '检查', note: `最新提交的 ${f.ci.pass} 项自动检查都通过了` })
      else items.push({ state: 'unknown', label: '检查', note: '最新提交没有自动检查结果（只看 GitHub Actions）' })
    }
  }
  for (const l of f.ledgers) {
    const name = l.path.split('/').slice(-2).join('/')
    if (!l.readable) items.push({ state: 'unknown', label: '待办', note: `${name} 读不了，请打开看看` })
    else if (l.open > 0) items.push({ state: 'missing', label: '待办', note: `${name} 里至少还有 ${l.open} 项没做完` })
    else items.push({ state: 'unknown', label: '待办', note: `${name} 还在，没看出未完成项，请打开确认都做完了` })
  }
  if (f.changedDuring) {
    // Evidence about a commit that is no longer HEAD proves nothing: no item of this run stays done.
    for (const item of items) if (item.state === 'done') item.state = 'unknown'
    items.unshift({ state: 'unknown', label: '变动', note: '检查期间代码有变动，这次结果不作数，请再查一次' })
  }
  if (!f.top && !f.gitFailed && f.ledgers.length === 0) items.push({ state: 'unknown', label: '范围', note: '这个文件夹不是 git 仓库，也没有待办记录，没什么可查' })

  const missing = items.filter(i => i.state === 'missing').length
  const unknown = items.filter(i => i.state === 'unknown').length
  const verdict =
    missing > 0
      ? `⛔ 还不能收尾：还差 ${missing} 项${unknown > 0 ? `，另有 ${unknown} 项没法核实` : ''}（${time} 核对）`
      : unknown > 0
        ? `❓ 暂时没法确认：有 ${unknown} 项没法核实（${time} 核对）`
        : `✅ 可以收尾：每一项都有证据（${time} 核对）`
  const open = items.filter(i => i.state !== 'done')
  const prompt =
    open.length === 0
      ? ''
      : [
          `请帮我把收尾做完。收尾检查（本机脚本，${time}）发现：`,
          ...open.map(i => `- ${i.state === 'missing' ? '还差' : '没法核实'}·${i.label}：${i.note}`),
          '请逐项处理：按项目的规矩完成还差的步骤；没法核实的先查清原因。需要我决定的先问我。做完后我会再点一次“收尾”核对。',
        ].join('\n')
  return { at, verdict, items, prompt }
}
