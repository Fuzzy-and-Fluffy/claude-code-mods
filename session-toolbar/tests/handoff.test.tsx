import { expect, test } from 'claude-code/testing'

import { buildHandoff, checkRuns, clipboardCommand, findTranscript, openCommand, planOf, prefill, PREFILL_LIMIT, redact, userWords, workFolder } from '../hooks/handoff'

const BAND = {
  plugin: 'session-toolbar',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const MESSAGES = [
  { role: 'user', text: '<system-reminder>noise</system-reminder>帮我做一个用量 mod', toolUses: [] },
  {
    role: 'assistant',
    text: '好的',
    toolUses: [
      { tool_use_id: 't1', tool: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'Write mod', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] } },
      { tool_use_id: 't2', tool: 'Write', input: { file_path: '/p/register.tsx', content: 'x' } },
      { tool_use_id: 't3', tool: 'mcp__ccd_turn__update_plan', input: { advance: true } },
    ],
  },
  { role: 'user', text: '交接按钮放在上面', toolUses: [] },
  { role: 'assistant', text: '最后的汇报：已完成工具栏。', toolUses: [] },
] as const

test('userWords drops the reminders the engine adds', () => {
  expect(userWords('<system-reminder>x</system-reminder>你好')).toBe('你好')
})

test('planOf follows advance after the last items call', () => {
  expect(planOf(MESSAGES as never)).toEqual([
    { content: 'Write mod', status: 'completed' },
    { content: 'Test it', status: 'in_progress' },
  ])
})

test('the note carries goal, instructions, report, plan, files, git and ledger', () => {
  const { note, kickoff } = buildHandoff({
    messages: MESSAGES as never,
    cwd: '/p',
    notePath: '/h/n.md',
    transcriptPath: '/t.jsonl',
    git: { status: '## main\n M register.tsx', lastCommit: 'abc fix' },
    ledger: { path: '/p/OUTSTANDING.md', text: '还剩：安装' },
    now: Date.parse('2026-10-25T07:00:00Z'),
  })
  expect(note).toContain('帮我做一个用量 mod')
  expect(note).not.toContain('noise')
  expect(note).toContain('- 交接按钮放在上面')
  expect(note).toContain('最后的汇报：已完成工具栏。')
  expect(note).toContain('- [x] Write mod')
  expect(note).toContain('- [~] Test it')
  expect(note).toContain('`/p/register.tsx`')
  expect(note).toContain('M register.tsx')
  expect(note).toContain('还剩：安装')
  expect(kickoff).toContain('/h/n.md')
  expect(kickoff).toContain('/t.jsonl')
})

// A finished call carries a result (or the error text); `inFlight` is one still waiting for its answer.
const bash = (command: string, isError?: true, text?: string, description?: string) => ({
  tool_use_id: 'b',
  tool: 'Bash',
  input: { command, ...(description === undefined ? {} : { description }) },
  ...(isError ? { isError, text } : { result: { stdout: 'ok', stderr: '', interrupted: false } }),
})
const edit = () => ({ tool_use_id: 'e', tool: 'Edit', input: { file_path: '/p/a.ts' }, result: 'ok' })
const inFlight = (command: string) => ({ tool_use_id: 'f', tool: 'Bash', input: { command } })
const turn = (...toolUses: object[]) => [{ role: 'assistant', text: '', toolUses }]

test('redact hides tokens, bearer headers, password assignments and long secrets', () => {
  const secrets = [
    ['sk', 'ant-api03-abcdefghijklmnop'].join('-'), // fakes, joined so the source holds no secret shape
    ['ghp', 'abcdefghij1234567890'].join('_'),
    ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['xoxb', '1234567890-abcdefghij'].join('-'),
    'abc.def-ghi',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
    'hunter2',
    's3cret',
    's3cr3tpw',
    'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg',
    'YWxpY2U6cGFzcy93b3Jk',
    'wJalr/XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'abc123@',
    'ghs_secretvalue99',
    'dbpw99',
  ]
  const hidden = (text: string, ...gone: string[]) => {
    const out = redact(text)
    for (const g of gone) expect(out).not.toContain(g)
    return out
  }
  expect(hidden(`curl ${secrets[0]} ${secrets[1]} ${secrets[2]} ${secrets[3]} ${secrets[5]}`, ...secrets.slice(0, 4), secrets[5]!)).toContain('curl')
  expect(hidden('curl -H "Authorization: Bearer abc.def-ghi" x', 'abc.def-ghi')).toBe('curl -H "Authorization: [已隐去]" x')
  expect(hidden('curl -H "Authorization: Basic YWxpY2U6cGFzcy93b3Jk"', 'YWxpY2U6')).toContain('Authorization: [已隐去]"')
  expect(hidden('curl -H "authorization: Basic YWxpY2U6cGFzcy93b3Jk" -d x', 'YWxpY2U6')).toContain('-d x')
  expect(hidden('authorization=Basic abc def\nnext line', 'abc')).toContain('next line') // up to the end of the line
  expect(hidden('echo bearer abc.def-ghi and BEARER xyz.uvw', 'abc.def-ghi', 'xyz.uvw')).toContain('echo')
  expect(hidden('curl -u alice:hunter2 https://x', 'hunter2')).toContain('https://x')
  expect(hidden('curl --user "alice:hunter2" https://x', 'hunter2')).toContain('https://x')
  expect(hidden('curl --user=alice:hunter2 -u=bob:hunter2', 'hunter2')).toContain('--user=')
  expect(hidden('git clone https://abc123@example.test/r.git', 'abc123')).toContain('://[已隐去]@example.test/r.git')
  expect(hidden('psql postgres://bob:s3cr3tpw@db/x', 's3cr3tpw', 'bob')).toContain('://[已隐去]@db/x')
  expect(hidden('password=hunter2 PASSWORD: s3cret', 'hunter2', 's3cret')).toContain('password=[已隐去]')
  expect(hidden('AWS_SECRET_ACCESS_KEY=wJalr/XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls', secrets[11]!)).toBe('AWS_SECRET_ACCESS_KEY=[已隐去] aws s3 ls')
  expect(hidden('GH_TOKEN=ghs_secretvalue99 DB_PASSWORD="dbpw99 x" npm test', 'ghs_secret', 'dbpw99')).toContain('npm test')
  expect(hidden('{"api_key": "dbpw99", "private_key":\'dbpw99\'}', 'dbpw99')).toContain('"api_key": [已隐去]')
  expect(hidden(`export ${secrets[9]}`, secrets[9]!)).toBe('export [已隐去]')
  expect(hidden('0123456789abcdef0123456789abcdef0123ABCD', '0123456789abcdef')).toBe('[已隐去]')
})

test('a credential in the goal, an instruction, the report, the plan or the ledger never reaches the note', () => {
  const secret = ['sk-', 'proj', 'ABCDEFGH12345678'].join('')
  const { note, kickoff } = buildHandoff({
    messages: [
      { role: 'user', text: `目标：用 ${secret} 调接口`, toolUses: [] },
      { role: 'assistant', text: '好的', toolUses: [{ tool_use_id: 'p', tool: 'mcp__ccd_turn__update_plan', input: { items: [{ content: `Set key ${secret}`, status: 'pending' }] } }] },
      { role: 'user', text: `换成 token=${secret}`, toolUses: [] },
      { role: 'assistant', text: `已写入 ${secret}`, toolUses: [] },
    ] as never,
    cwd: '/p',
    notePath: '/h/n.md',
    git: { status: `## main\n?? token=${secret}`, lastCommit: `abc fix token=${secret}` },
    ledger: { path: '/p/OUTSTANDING.md', text: `密钥 ${secret}` },
    now: Date.parse('2026-10-25T07:00:00Z'),
  })
  expect(note).not.toContain(secret)
  expect(kickoff).not.toContain(secret)
  expect(prefill(kickoff, note, '/h/n.md', '/p')).not.toContain(secret)
  expect(note.split('[已隐去]').length - 1).toBeGreaterThanOrEqual(7)
})

test('a credential in a path, the folder or the transcript path is hidden too, short note or long', () => {
  // Built from parts, so no whole token shape sits in this file.
  const body = ['AbCdEf', '0123456789', 'xyzW'].join('')
  const prefixed = ['ghp_', 'github_pat_11', 'glpat-', 'AIzaSy', 'hf_', 'npm_', 'sk_live_', 'xapp-1-'].map(p => p + body)
  for (const secret of prefixed) {
  const input = {
    messages: [{ role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 'w', tool: 'Write', input: { file_path: `/p/${secret}.txt`, content: 'x' } }] }] as never,
    cwd: `/p/${secret}`,
    notePath: `/h/${secret}.md`,
    transcriptPath: `/t/${secret}.jsonl`,
    ledger: { path: `/p/${secret}/OUTSTANDING.md`, text: 'x' },
    now: Date.parse('2026-10-25T07:00:00Z'),
  }
  const { note, kickoff } = buildHandoff(input)
  for (const text of [note, kickoff, prefill(kickoff, note, input.notePath, input.cwd), prefill(kickoff, 'x'.repeat(PREFILL_LIMIT + 1), input.notePath, input.cwd)]) {
    expect(text).not.toContain(secret)
  }
  expect(note).toContain('`/p/[已隐去]')
  }
})

test('redact leaves ordinary identifiers and paths readable', () => {
  const text = 'pytest tests/test_handoff_note_redacts_credentials.py /Volumes/SSD/projects/app abcdefghijklmnopqrstuvwxyz 0123456789abcdef0123456789abcdef0123 handoff-sections-toolbar-hooks'
  expect(redact(text)).toBe(text)
})

const background = (command: string) => ({ tool_use_id: 'g', tool: 'Bash', input: { command }, result: { backgroundTaskId: 'bg1', stdout: '' } })

test('checkRuns counts only a pure check command', () => {
  const notChecks = [
    'echo "npm test"',
    'git commit -m "fix tsc"',
    'npm test || true',
    'npm test; rm x',
    'npm test && git push',
    'FOO=1 npm test',
    'npm test > out',
    'npm test | tee o',
    'pytest $(cat f)',
    'pytest `cat f`',
    'npm test "a;b"',
    'cd a && cd b && npm test',
    'npm test\nrm x',
    'npx evil tsc',
    'ls | pytest -q',
    'tsc --init',
    'pytest --version',
    'pytest -h',
    'jest --listTests',
    'tsc --showConfig',
    'pytest --collect-only',
    'cargo test --help',
    'vitest -v',
    'pytest "--help"',
    'tsc "--init"',
    'cargo test --no-run',
    'tsc -help',
    'cd #workspace && npm test',
    'go test -n ./...',
    'go test -c ./pkg',
    'tsc -version',
    'jest -listTests',
    'pytest -k "a b"',
    // Collect, list, dry-run or build-only forms: anything off a check's allowlist is left out.
    'pytest --co',
    'tsc --build --dry',
    'tsc -b',
    'tsc -p',
    'tsc -p --init',
    'vitest list',
    'vitest bench',
    'jest --version',
    'go test -list .',
    'cargo test -- --list',
    'npm test -- --listTests',
    'pnpm test --help',
    'go test -count=0 ./...', // runs no test at all
    'tsc @check.args', // reads more arguments, such as --version, from a file
    'pytest @checks.txt',
    'vitest run @args',
  ]
  expect(checkRuns(turn(...notChecks.map(c => bash(c))) as never)).toEqual([])
  const lines = checkRuns(
    turn(
      bash('claude plugin test pkg', true, 'x'),
      bash('npx -y -p typescript tsc -p pkg'),
      bash('claude plugin test pkg'),
      bash('cd /missing && pnpm run lint', true, 'cd: no such file'),
      bash('go test ./...'),
      inFlight('cargo test'),
      bash('pytest tests/test_credentials.py'),
      edit(), // nothing says a run is stale: the heading tells the reader to run again
    ) as never,
  )
  expect(lines).toEqual([
    '- `npx -y -p typescript tsc -p pkg`：通过',
    '- `claude plugin test pkg`：通过',
    '- `cd /missing && pnpm run lint`：未通过',
    '- `go test ./...`：通过',
    '- （命令已省略）：通过', // the command could hold a secret
  ])
  expect(checkRuns(turn(bash('pytest tests/a.py', true, 'x'), bash('pytest tests/b.py')) as never)).toEqual(['- `pytest tests/a.py`：未通过', '- `pytest tests/b.py`：通过'])
  const allowed = ['vitest run', 'pytest -q -x tests/a.py', 'go test -race -count=1 ./...', 'cargo test --workspace', 'tsc --noEmit -p pkg', 'jest --ci']
  expect(checkRuns(turn(...allowed.map(c => bash(c))) as never)).toEqual(allowed.map(c => `- \`${c}\`：通过`))
})

test('checkRuns leaves out a call whose record does not prove it ran to the end', () => {
  const unproven = [
    background('npm test'),
    inFlight('npm test'),
    { tool_use_id: 'h', tool: 'Bash', input: { command: 'npm test' }, text: 'ok', result: 'ok' }, // no record
    { tool_use_id: 'j', tool: 'Bash', input: { command: 'npm test' }, text: 'Command running in background with ID: bg2' },
    { tool_use_id: 'i', tool: 'Bash', input: { command: 'npm test' }, result: { interrupted: true, stdout: '' } },
    { tool_use_id: 'k', tool: 'Bash', input: { command: 'npm test' }, result: { stdout: '' } }, // no interrupted field
  ]
  const bashResult = (fields: object) => ({ stdout: '', stderr: '', interrupted: false, ...fields })
  const objects = [{ backgroundTaskId: 'bg7' }, { backgroundedByUser: true }, { backgroundedByTurnAbort: true }, { backgroundedToDeliverMessage: true }, { timedOutAfterMs: 120000 }]
  unproven.push(...objects.map(f => ({ tool_use_id: 's', tool: 'Bash', input: { command: 'npm test' }, result: bashResult(f) })))
  expect(checkRuns(turn(...unproven) as never)).toEqual([])
  // the earlier finished run stands; a run that proves nothing does not overwrite it
  expect(checkRuns(turn(bash('npm test', true, 'x'), ...unproven) as never)).toEqual(['- `npm test`：未通过'])
  expect(checkRuns(turn(bash('npm test'), ...unproven) as never)).toEqual(['- `npm test`：通过'])
  // an errored call did not pass, whether it failed or was interrupted
  expect(checkRuns(turn(bash('npm test'), bash('npm test', true, '[Request interrupted by user]')) as never)).toEqual(['- `npm test`：未通过'])
})

test('checkRuns never reads what a run printed: test names and output say nothing about how it ended', () => {
  const run = (isError: boolean, words: string) => ({ tool_use_id: 't', tool: 'Bash', input: { command: 'pytest -q' }, ...(isError ? { isError, text: words, result: words } : { text: words, result: { stdout: words, stderr: '', interrupted: false } }) })
  expect(checkRuns(turn(run(false, 'ok'), run(true, 'FAILED tests/test_interrupt.py::test_cancel')) as never)).toEqual(['- `pytest -q`：未通过'])
  expect(checkRuns(turn(run(true, 'x'), run(false, 'tests/test_background.py interrupted=1 passed')) as never)).toEqual(['- `pytest -q`：通过'])
})

test('the note carries 最近的检查, or says none, and no failed-command list', () => {
  const empty = buildHandoff({ messages: MESSAGES as never, cwd: '/p', notePath: '/h/n.md', now: 0 }).note
  expect(empty).toMatch(/## 改过的文件\n[^#]*\n## 最近的检查（接手后请重跑一次再相信）\n（没有跑过）\n\n## 代码状态/)
  expect(empty).not.toContain('试过但失败')
  const messages = [...MESSAGES, ...turn(bash('vitest run', true, 'FAIL token=abc123'), bash('vitest run', true, 'x', 'Run the unit tests'), edit())]
  const note = buildHandoff({ messages: messages as never, cwd: '/p', notePath: '/h/n.md', now: 0 }).note
  expect(note).toContain('## 最近的检查（接手后请重跑一次再相信）\n- `vitest run`：未通过\n')
  expect(note).not.toContain('abc123')
})

const FAKE_PAT = ['github', 'pat_11abcdefghijklmnopqrstuvwxyz0123'].join('_') // joined: no secret shape in the source

test('no secret reaches the note through a failed command, an error line or a check', () => {
  const secrets = ['hunter2', 's3cr3t-x', 'k3yvalue', FAKE_PAT, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY', 'alice', 'abc123']
  const messages = [
    ...MESSAGES,
    ...turn(
      bash('curl -ualice:hunter2 https://h', true, 'Error: Command failed: curl -ualice:hunter2 https://h'),
      bash('curl -ualice:hunter2 https://h', true, 'curl: (22) error: 401 X-Api-Key: k3yvalue'),
      bash("PASSWORD=$'s3cr3t-x' ./deploy", true, 'error: bad PASSWORD s3cr3t-x'),
      bash('curl -H "X-Api-Key: k3yvalue" https://h', true, `error: ${FAKE_PAT}`, 'Log in with the token'),
      bash('git clone https://alice:hunter2@host/r.git', true, 'fatal: could not read QUJDREVGR0hJSktMTU5PUFFSU1RVVldY'),
      bash('curl --user alice:hunter2 x', true, 'error: refused\nauthorization: Basic QUJDREVGR0hJSktMTU5PUFFSU1RVVldY'),
      bash('npm test -- --token hunter2'),
      bash('npm test "a;b" --password=hunter2', true, 'x error'),
      bash('FOO=abc123 npm test'),
      bash('npm test || echo s3cr3t-x'),
      bash('cd /missing && npm test', true, 'cd: no such file'),
      bash('npm test; rm -rf /tmp/k3yvalue'),
      background('npm test'),
      bash('pytest tests/token_hunter2_test.py'), // an accepted check whose words look secret is withheld whole
    ),
  ]
  const note = buildHandoff({ messages: messages as never, cwd: '/p', notePath: '/h/n.md', now: 0 }).note
  for (const secret of secrets) expect(note).not.toContain(secret)
  expect(note).toContain('- （命令已省略）：通过')
  expect(note).not.toContain('试过但失败')
  expect(note).toContain('- `cd /missing && npm test`：未通过')
  expect(note).not.toContain('已过期')
})

test('both kickoff forms first check the folder and ask Momo to switch a non-Auto mode back', () => {
  const { note, kickoff } = buildHandoff({ messages: MESSAGES as never, cwd: '/p', notePath: '/h/n.md', now: 0 })
  for (const text of [kickoff, prefill(kickoff, note, '/h/n.md', '/p'), prefill(kickoff, 'x'.repeat(PREFILL_LIMIT), '/h/n.md', '/p')]) {
    expect(text).toContain('工作文件夹应是 /p')
    expect(text).toContain('change_directory')
    expect(text).toContain('权限模式应是 auto')
    expect(text).toContain('不要自己改模式')
  }
})

test('交接 writes the note and copies the kickoff without any model call', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const runs: { argv: readonly string[]; stdin?: string; lang?: string }[] = []
  let modelCalls = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/scratch' })) // the folder can fall back to where the session started
  on('session.root', () => ({ value: '/p' }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.messages', () => ({ value: MESSAGES as never }))
  on('env.get', () => ({ value: '/home' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T07:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => ({ value: String(e.path).endsWith('OUTSTANDING.md') ? '还剩：安装' : '' }))
  on('fs.write', (_, e) => {
    writes.push({ path: String(e.path), text: String(e.text) })
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, lang: e.init?.env?.LANG })
    const isLog = e.argv.includes('log')
    return { value: { exitCode: 0, stdout: isLog ? 'abc fix' : '## main', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => {
    modelCalls += 1
    return { value: undefined as never }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Button', key: 'handoff' }))?.text).toBe('交接')
  expect((await band.find({ type: 'Button', key: 'compact' }))?.text).toBe('压缩')
  await band.press({ key: 'handoff' })

  const note = writes.find(w => w.path.startsWith('/home/.claude/handoffs/'))
  expect(note?.text).toContain('交接按钮放在上面')
  const copy = runs.find(r => r.argv[0] === 'pbcopy')
  expect(copy?.stdin).toContain('交接按钮放在上面')
  expect(copy?.lang).toBe('en_US.UTF-8') // without a UTF-8 locale pbcopy garbles Chinese
  const open = runs.find(r => r.argv[0] === 'open')
  const link = new URL(open?.argv[1] ?? 'claude://missing')
  expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('claude://code/new')
  expect(link.searchParams.get('folder')).toBe('/p')
  expect(link.searchParams.get('q')).toContain('交接按钮放在上面')
  expect(link.searchParams.get('q')).toContain(note?.path ?? 'missing')
  expect(modelCalls).toBe(0)
  expect((await band.find({ type: 'Text', text: /已打开新会话/ }))?.text).toMatch(/检查后按回车发送。剪贴板里也有一份备用/)
})

test('clipboard and link commands per system read UTF-8 and pass the link whole', () => {
  expect(clipboardCommand('mac')).toEqual({ argv: ['pbcopy'], env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } })
  const win = clipboardCommand('windows')
  expect(win.argv[0]).toBe('powershell')
  expect(win.argv.join(' ')).toMatch(/InputEncoding = \[Text.Encoding\]::UTF8; Set-Clipboard/)
  const link = 'claude://code/new?q=%E4%BA%A4&folder=%2Fx'
  expect(openCommand('mac', link)).toEqual({ argv: ['open', link] })
  const winOpen = openCommand('windows', link)
  expect(winOpen.env).toEqual({ USAGE_PEEK_LINK: link }) // never on the command line
  expect(winOpen.argv.at(-1)).toBe("$ErrorActionPreference = 'Stop'; if ($null -eq (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\claude' -Name 'URL Protocol' -ErrorAction SilentlyContinue)) { exit 3 }; Start-Process -FilePath $env:USAGE_PEEK_LINK")
})

test('the transcript is found after the session moved to another folder, also through a linked folder, and a failed lookup finds nothing', async () => {
  const started = '/home/.claude/projects/-scratch-a/sid.jsonl'
  const files = new Set([started, '/home/.claude/projects/-p/other.jsonl'])
  const dirs = [{ name: 'notes.txt', kind: 'file' }, { name: '-p', kind: 'dir' }, { name: '-scratch-a', kind: 'dir' }]
  const exists = async (path: string) => files.has(path)
  const list = async () => dirs
  expect(await findTranscript('/home', '/p', 'sid', exists, list)).toBe(started)
  files.add('/home/.claude/projects/-p/sid.jsonl')
  expect(await findTranscript('/home', '/p', 'sid', exists, list)).toBe('/home/.claude/projects/-p/sid.jsonl')
  const linked = '/home/.claude/projects/-linked/moved.jsonl'
  files.add(linked)
  dirs.push({ name: '-linked', kind: 'other' })
  expect(await findTranscript('/home', '/p', 'moved', exists, list)).toBe(linked)
  expect(await findTranscript('/home', '/q', 'missing', exists, list)).toBeUndefined()
  expect(await findTranscript('/home', '/q', '../sid', exists, list)).toBeUndefined()
  const broken = async () => { throw new Error('denied') }
  expect(await findTranscript('/home', '/q', 'sid', broken, list)).toBeUndefined()
  expect(await findTranscript('/home', '/q', 'sid', exists, broken)).toBeUndefined()
})

test('a session born in a scratch folder hands off the last project folder its transcript records', () => {
  const scratch = '/Users/m/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1'
  const line = (cwd: string) => JSON.stringify({ type: 'user', cwd, message: { content: 'x' } })
  const transcript = [line(scratch), line('/p/proj'), 'not json "cwd":"/broken', line('/p/proj/.claude/worktrees/w'), line(scratch)].join('\n')
  expect(workFolder(scratch, transcript)).toBe('/p/proj/.claude/worktrees/w')
  expect(workFolder('/p/proj', transcript)).toBe('/p/proj') // a project root is kept as it is
  expect(workFolder(scratch, line(scratch))).toBe(scratch) // never left the scratch folder
  expect(workFolder(scratch, '')).toBe(scratch)
  // only a record's own folder counts: not one inside a tool call, and not a line that is not JSON
  const nested = JSON.stringify({ cwd: '/p/proj', message: { content: [{ input: { cwd: '/p/other' } }] } })
  expect(workFolder(scratch, [line(scratch), nested].join('\n'))).toBe('/p/proj')
  expect(workFolder(scratch, [line('/p/proj'), 'not json "cwd":"/p/other"', '{"cwd": "/p/spaced"}'].join('\n'))).toBe('/p/spaced')
  const win = 'C:\\Users\\m\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\s'
  expect(workFolder(win, [line(win), line('D:\\code\\proj')].join('\n'))).toBe('D:\\code\\proj')
})

test('交接 from a session born in a scratch folder opens the new session in its project folder', async ($, on) => {
  const scratch = '/Users/m/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1'
  const transcript = [scratch, '/p/proj', scratch].map(cwd => JSON.stringify({ cwd })).join('\n')
  const runs: { argv: readonly string[] }[] = []
  const writes: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: scratch }))
  on('session.root', () => ({ value: scratch }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.messages', () => ({ value: MESSAGES as never }))
  on('env.get', () => ({ value: '/home' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-28T09:35:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => ({ value: String(e.path).endsWith('sid.jsonl') ? transcript : '' }))
  on('fs.write', (_, e) => {
    writes.push(String(e.path))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv })
    return { value: { exitCode: 0, stdout: '## main', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: scratch, surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'handoff' })

  const open = runs.find(r => r.argv[0] === 'open')
  expect(new URL(open?.argv[1] ?? 'claude://missing').searchParams.get('folder')).toBe('/p/proj')
  expect(runs.find(r => r.argv[0] === 'git')?.argv).toContain('/p/proj')
  expect(writes.some(w => w.endsWith('-proj.md'))).toBe(true)
})

test('交接 uses the project folder the session was seen in after a tool call, when its transcript is too big to read', async ($, on) => {
  const scratch = '/Users/m/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1'
  let folder = scratch
  const runs: { argv: readonly string[] }[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: folder }))
  on('session.root', () => ({ value: scratch }))
  on('session.id', () => ({ value: 'sid' }))
  on('session.messages', () => ({ value: MESSAGES as never }))
  on('env.get', () => ({ value: '/home' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-28T09:35:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => {
    if (String(e.path).endsWith('sid.jsonl')) throw new Error('over 4 MiB')
    return { value: '' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} as never }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv })
    return { value: { exitCode: 0, stdout: '## main', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  await $.session.start({ cwd: scratch, surface: 'desktop', isInteractive: true })

  folder = '/p/big'
  await $.tool.call({ tool: 'Bash', command: 'cd /p/big && git status' } as never)
  folder = scratch // fell back before the press
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'handoff' })

  const open = runs.find(r => r.argv[0] === 'open')
  expect(new URL(open?.argv[1] ?? 'claude://missing').searchParams.get('folder')).toBe('/p/big')
})
