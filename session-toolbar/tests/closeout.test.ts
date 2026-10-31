import { expect, test } from 'claude-code/testing'

import { gatherFacts, judge, openItems } from '../hooks/closeout'
import type { ReadResult, Run } from '../hooks/closeout'

type Reply = { exitCode: number; stdout?: string; stderr?: string } | null

// A fake git and gh: each argv (joined, without "git -C <dir>") maps to a reply; anything else fails.
function runner(replies: Record<string, Reply>): Run {
  return async argv => {
    const key = argv[0] === 'git' ? argv.slice(3).join(' ') : argv.join(' ')
    const r: Reply = key in replies ? (replies[key] ?? null) : { exitCode: 128, stderr: 'unexpected' }
    return r && { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
}

const CI = 'gh run list --repo github.com/me/repo --all --commit abc123 --json status,conclusion --limit 100'
const MAIN = 'a'.repeat(40) // origin/main on the server
const FEAT = 'f'.repeat(40) // origin/feature on the server
const HOLDS = 'for-each-ref --contains abc123 --format=%(refname) %(objectname) refs/remotes/origin/'
const MERGED = `merge-base --is-ancestor abc123 ${MAIN}`
const PR = 'gh pr view feature --repo github.com/me/repo --json number,state,baseRefName,headRefOid'
// A feature branch: clean, pushed, merged into origin/main, its one CI run green.
const DONE: Record<string, Reply> = {
  'rev-parse --show-toplevel': { exitCode: 0, stdout: '/repo\n' },
  'status --porcelain=v1 --untracked-files=all --ignore-submodules=none': { exitCode: 0, stdout: '' },
  'rev-parse HEAD': { exitCode: 0, stdout: 'abc123\n' },
  'rev-parse --is-shallow-repository': { exitCode: 0, stdout: 'false\n' },
  'rev-parse --abbrev-ref HEAD': { exitCode: 0, stdout: 'feature\n' },
  'worktree list --porcelain': { exitCode: 0, stdout: 'worktree /repo\nHEAD abc\n' },
  'stash list': { exitCode: 0, stdout: '' },
  'remote -v': { exitCode: 0, stdout: 'origin\tgit@github.com:me/repo.git (fetch)\n' },
  'fetch --quiet --prune origin': { exitCode: 0 },
  'ls-remote --symref origin': { exitCode: 0, stdout: `ref: refs/heads/main\tHEAD\n${MAIN}\tHEAD\n${MAIN}\trefs/heads/main\n${FEAT}\trefs/heads/feature\n` },
  [HOLDS]: { exitCode: 0, stdout: `refs/remotes/origin/main ${MAIN}\nrefs/remotes/origin/feature ${FEAT}\n` },
  [MERGED]: { exitCode: 0 },
  [CI]: { exitCode: 0, stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) },
  [PR]: { exitCode: 0, stdout: JSON.stringify({ number: 7, state: 'MERGED', baseRefName: 'main', headRefOid: 'abc123' }) },
}
const noLedger = async (): Promise<ReadResult> => ({ kind: 'missing' })
const check = async (replies: Record<string, Reply>, read: (p: string) => Promise<ReadResult> = noLedger) => judge(await gatherFacts(runner(replies), read, '/repo'), 0, '10:00')
const state = (r: Awaited<ReturnType<typeof check>>, label: string) => r.items.find(i => i.label === label)?.state

test('done only on evidence about HEAD: clean, held by a remote ref, in origin/main, CI green', async () => {
  const r = await check(DONE)
  expect(r.items.map(i => `${i.state}:${i.label}`)).toEqual(['done:提交', 'done:推送', 'done:合并', 'done:检查'])
  expect(r.verdict).toBe('✅ 可以收尾：每一项都有证据（10:00 核对）')
  expect(r.prompt).toBe('')
})

test('uncommitted files, a stash, a dirty second worktree and an unpushed HEAD are missing', async () => {
  const r = await check({
    ...DONE,
    'status --porcelain=v1 --untracked-files=all --ignore-submodules=none': { exitCode: 0, stdout: ' M a.ts\n?? b.ts\n' },
    'worktree list --porcelain': { exitCode: 0, stdout: 'worktree /repo\n\nworktree /wt/other\n' },
    'stash list': { exitCode: 0, stdout: 'stash@{0}: WIP\n' },
    [HOLDS]: { exitCode: 0, stdout: '' },
    [MERGED]: { exitCode: 1 },
    [PR]: { exitCode: 1, stderr: 'no pull requests found for branch "feature"' },
  })
  // The fake answers the second worktree's status like the first one's: dirty too.
  expect(r.items.filter(i => i.state === 'missing').map(i => i.label)).toEqual(['提交', '其他目录', '暂存', '推送', '合并'])
  expect(r.items.find(i => i.label === '提交')?.note).toBe('有 2 个文件还没提交（其中 1 个是新文件）')
  expect(r.items.find(i => i.label === '合并')?.note).toBe('最新的提交还没合并进 main；还没开 PR')
  expect(r.prompt).toMatch(/还差·推送：最新的提交还没推送到远程/)
})

test('failed lookups read as unknown, never as done', async () => {
  const r = await check({ ...DONE, 'fetch --quiet --prune origin': { exitCode: 128, stderr: 'Could not resolve host' }, [CI]: null, 'stash list': null, 'worktree list --porcelain': { exitCode: 128 } })
  expect(state(r, '推送')).toBe('unknown')
  expect(state(r, '合并')).toBe('unknown')
  expect(state(r, '检查')).toBe('unknown')
  expect(state(r, '暂存')).toBe('unknown')
  expect(state(r, '其他目录')).toBe('unknown')
  expect(r.verdict.startsWith('❓')).toBe(true)
  const broken = await check({ 'rev-parse --show-toplevel': { exitCode: 128, stderr: 'fatal: detected dubious ownership' } })
  expect(state(broken, '代码')).toBe('unknown')
})

test('a PR marked merged is information, not proof', async () => {
  // Squash-merged: HEAD is not in origin/main, the PR says merged for this very commit.
  const squash = await check({ ...DONE, [MERGED]: { exitCode: 1 } })
  expect(state(squash, '合并')).toBe('unknown')
  // New commits after the merge: the PR's head is an older commit.
  const later = await check({
    ...DONE,
    [MERGED]: { exitCode: 1 },
    [PR]: { exitCode: 0, stdout: JSON.stringify({ number: 7, state: 'MERGED', baseRefName: 'main', headRefOid: 'old999' }) },
  })
  expect(state(later, '合并')).toBe('missing')
})

test('CI: a failing or running run, or none at all, is never done', async () => {
  const runs = (list: unknown[]) => ({ ...DONE, [CI]: { exitCode: 0, stdout: JSON.stringify(list) } })
  expect(state(await check(runs([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }])), '检查')).toBe('missing')
  expect(state(await check(runs([{ status: 'in_progress', conclusion: '' }])), '检查')).toBe('unknown')
  expect(state(await check(runs([])), '检查')).toBe('unknown')
})

test('a ledger is never done by parsing: open items are missing, none visible is unknown', async () => {
  const ledger = (text: string) => async (p: string): Promise<ReadResult> => (p === '/repo/OUTSTANDING.md' ? { kind: 'text', text } : { kind: 'missing' })
  expect(state(await check(DONE, ledger('Open:\n1. ship it\n')), '待办')).toBe('missing')
  expect(state(await check(DONE, ledger('# Ledger\nAll shipped.\n')), '待办')).toBe('unknown')
  expect(state(await check(DONE, async () => ({ kind: 'error' })), '待办')).toBe('unknown')
  expect(openItems('## Open\n- [x] Parent\n  - [ ] Deploy\n')).toBe(1) // a box at any depth
  expect(openItems('- [ ] a\n- [x] b\n- [ ] c\n')).toBe(2)
  expect(openItems('Done:\n- x\n\nOpen (waiting):\n1. one\n   detail\n2. two\n\nNotes:\n- not counted\n')).toBe(2)
})

test('offline, nothing is called missing either; a move during the check voids it', async () => {
  const offline = await check({
    ...DONE,
    'fetch --quiet --prune origin': { exitCode: 128 },
    [HOLDS]: { exitCode: 0, stdout: '' },
    [MERGED]: { exitCode: 1 },
  })
  expect(state(offline, '推送')).toBe('unknown')
  expect(state(offline, '合并')).toBe('unknown')
  let calls = 0
  const moving: Run = async (argv, init) => {
    if (argv.slice(3).join(' ') === 'rev-parse HEAD') return { exitCode: 0, stdout: calls++ === 0 ? 'abc123\n' : 'def456\n', stderr: '' }
    return runner(DONE)(argv, init)
  }
  const moved = judge(await gatherFacts(moving, noLedger, '/repo'), 0, '10:00')
  expect(state(moved, '变动')).toBe('unknown')
  expect(moved.verdict.startsWith('✅')).toBe(false)
})

test('CI evidence: only success counts, a possibly cut list and a non-GitHub remote are unknown', async () => {
  const runs = (list: unknown[]) => ({ ...DONE, [CI]: { exitCode: 0, stdout: JSON.stringify(list) } })
  expect(state(await check(runs([{ status: 'completed', conclusion: 'skipped' }])), '检查')).toBe('unknown')
  expect(state(await check(runs(Array.from({ length: 100 }, () => ({ status: 'completed', conclusion: 'success' })))), '检查')).toBe('unknown')
  const gitlab = await check({ ...DONE, 'remote -v': { exitCode: 0, stdout: 'origin\tgit@gitlab.com:me/repo.git (fetch)\n' } })
  const lookalike = await check({ ...DONE, 'remote -v': { exitCode: 0, stdout: 'origin\tgit@notgithub.com:me/repo.git (fetch)\n' } })
  expect(state(lookalike, '检查')).toBe('unknown')
  expect(state(gitlab, '检查')).toBe('unknown')
  expect(gitlab.verdict.startsWith('✅')).toBe(false)
})

test('a local remote ref the server no longer has at that commit proves nothing', async () => {
  const r = await check({ ...DONE, 'ls-remote --symref origin': { exitCode: 0, stdout: `ref: refs/heads/main\tHEAD\n${'b'.repeat(40)}\trefs/heads/main\n` } })
  // origin/feature is gone from the server, origin/main moved: no fresh ref holds HEAD.
  expect(state(r, '推送')).toBe('missing')
  expect(state(r, '合并')).not.toBe('done')
})

test('a success beside a skipped run is not proof; a run voided by a move shows no done', async () => {
  const mixed = await check({ ...DONE, [CI]: { exitCode: 0, stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]) } })
  expect(state(mixed, '检查')).toBe('unknown')
  let calls = 0
  const moving: Run = async (argv, init) => {
    if (argv.slice(3).join(' ') === 'rev-parse HEAD') return { exitCode: 0, stdout: calls++ === 0 ? 'abc123\n' : 'def456\n', stderr: '' }
    return runner(DONE)(argv, init)
  }
  const moved = judge(await gatherFacts(moving, noLedger, '/repo'), 0, '10:00')
  expect(moved.items.some(i => i.state === 'done')).toBe(false)
  // The second read of HEAD fails, though it printed the same commit: nothing stays done either.
  let reads = 0
  const flaky: Run = async (argv, init) => {
    if (argv.slice(3).join(' ') === 'rev-parse HEAD') return { exitCode: reads++ === 0 ? 0 : 128, stdout: 'abc123\n', stderr: '' }
    return runner(DONE)(argv, init)
  }
  const unsure = judge(await gatherFacts(flaky, noLedger, '/repo'), 0, '10:00')
  expect(unsure.items.some(i => i.state === 'done')).toBe(false)
})

test('a shallow clone cannot prove a commit was never pushed or merged', async () => {
  const r = await check({
    ...DONE,
    'rev-parse --is-shallow-repository': { exitCode: 0, stdout: 'true\n' },
    [HOLDS]: { exitCode: 0, stdout: '' },
    [MERGED]: { exitCode: 1 },
  })
  expect(state(r, '推送')).toBe('unknown')
  expect(state(r, '合并')).toBe('unknown')
})

test('a repository with no remote cannot be called pushed', async () => {
  const r = await check({ ...DONE, 'remote -v': { exitCode: 0, stdout: '' } })
  expect(state(r, '推送')).toBe('unknown')
  expect(r.items.some(i => i.label === '合并' || i.label === '检查')).toBe(false)
})
