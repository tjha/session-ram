import { expect, test } from 'claude-code/testing'

const CLAUDE = '/x/claude.app/Contents/MacOS/claude --output-format stream-json --verbose'
const PS = [
  ` 100 1 1024 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${CLAUDE} --resume=aaaaaaaa-0000-0000-0000-000000000001`,
  ` 101 100 204800 ${CLAUDE} --resume=aaaaaaaa-0000-0000-0000-000000000001`,
  ` 102 101 512000 node eslint.js`,
  ` 200 1 1024 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${CLAUDE} --resume=bbbbbbbb-0000-0000-0000-000000000002`,
  ` 201 200 102400 ${CLAUDE} --resume=bbbbbbbb-0000-0000-0000-000000000002`,
  ` 301 1 51200 ${CLAUDE} --session-id=cccccccc-0000-0000-0000-000000000003`,
  ` 302 301 1024 ps -axww -o pid=,ppid=,rss=,command=`,
  // A shell whose arguments mention the session command is not a session.
  ` 400 1 2048 /bin/zsh -c ps -axo command | grep '[M]acOS/claude --output-format'`,
].join('\n')

const LISTED = [
  { sessionId: 'local_a', title: 'Busy lint session', isRunning: true },
  { sessionId: 'local_b', title: 'Idle session', isRunning: false },
]

const PANE = {
  plugin: 'session-ram',
  component: 'Pane',
  requestId: 'session-ram',
  props: {
    title: 'Session RAM',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })

test('lists each session with its process-tree RAM and status, and flags the limit', async ($, on) => {
  on('command.register', () => ({ value: { command: 'session-ram' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: PS, stderr: '' } }))
  const CLI: Record<string, string> = {
    local_a: 'aaaaaaaa-0000-0000-0000-000000000001',
    local_b: 'bbbbbbbb-0000-0000-0000-000000000002',
    local_self: 'cccccccc-0000-0000-0000-000000000003',
  }
  on('env.get', () => ({ value: '/Users/x' }))
  const ls = (files: string[]) => (_: unknown, e: { path?: string }) => {
    const path = String(e.path)
    if (path.endsWith('claude-code-sessions')) return { value: [{ name: 'org1', kind: 'dir' }] }
    if (path.endsWith('/org1')) return { value: [{ name: 'acct1', kind: 'dir' }] }
    return { value: files.map(name => ({ name, kind: 'file' })) }
  }
  on('fs.list', ls(Object.keys(CLI).map(id => `${id}.json`)))
  on('fs.read', (_, e) => {
    const id = /(local_\w+)\.json$/.exec(String(e.path))?.[1] ?? ''
    return { value: JSON.stringify({ sessionId: id, title: `file title ${id}`, cliSessionId: CLI[id] }) }
  })
  on('mcp.call', (_, e) => text(LISTED.find(s => s.sessionId === (e.args as { session_id?: string })?.session_id)))
  on('store.get', (_, e) => ({ value: e.key === 'limitMb' ? 600 : undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-ram__snapshot' } }))
  on('clock.every', () => ({ value: {} }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 200 MB session + 500 MB eslint child = 700 MB; idle one 100 MB; this one 51 MB; total 851 MB > 600 MB limit.
  expect((await ui.find({ type: 'Text', text: /used of/ }))?.text).toBe('0.8 GB used of 0.6 GB limit')
  expect((await ui.find({ type: 'Text', text: /700 MB/ }))?.text).toContain('● working')
  expect((await ui.find({ type: 'Text', text: /100 MB/ }))?.text).toContain('○ idle')
  expect(await ui.find({ type: 'Text', text: /^Idle session$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /This session/ })).toBeDefined()
  expect(await ui.find({ key: 'act-101' })).toBeDefined()
  expect(await ui.find({ key: 'act-301' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /sessions in memory/ }))?.text).toBe('3 sessions in memory, 2 working')
  await ui.unmount()

  // A narrow pane wraps the controls instead of clipping them.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 24 }, surface: 'desktop' })
  expect(await narrow.find({ key: 'refresh' })).toBeDefined()
  expect(await narrow.find({ key: 'auto' })).toBeDefined()
  await narrow.unmount()
})

test('when the app session list fails, rows keep file titles and show the error', async ($, on) => {
  on('command.register', () => ({ value: { command: 'session-ram' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: PS, stderr: '' } }))
  on('env.get', () => ({ value: '/Users/x' }))
  const ls = (files: string[]) => (_: unknown, e: { path?: string }) => {
    const path = String(e.path)
    if (path.endsWith('claude-code-sessions')) return { value: [{ name: 'org1', kind: 'dir' }] }
    if (path.endsWith('/org1')) return { value: [{ name: 'acct1', kind: 'dir' }] }
    return { value: files.map(name => ({ name, kind: 'file' })) }
  }
  on('fs.list', ls(['local_b.json']))
  on('fs.read', () => ({ value: JSON.stringify({ sessionId: 'local_b', title: 'From file', cliSessionId: 'bbbbbbbb-0000-0000-0000-000000000002' }) }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Error: not allowed' }], isError: false } }))
  on('store.get', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-ram__snapshot' } }))
  on('clock.every', () => ({ value: {} }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^From file$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Working\/idle unknown/ }))?.text).toContain('Error: not allowed')
  await ui.unmount()
})

test('Windows: lists sessions from the PowerShell process query and %APPDATA% session files', async ($, on) => {
  const EXE = '"C:\\Users\\x\\AppData\\Roaming\\Claude\\claude-code\\2.1.317\\claude.exe" --output-format stream-json --verbose'
  const WIN = JSON.stringify([
    { ProcessId: 4, ParentProcessId: 0, WorkingSetSize: 1024, CommandLine: null },
    { ProcessId: 500, ParentProcessId: 4, WorkingSetSize: 300 * 1048576, CommandLine: `${EXE} --resume=aaaaaaaa-0000-0000-0000-000000000001` },
    { ProcessId: 501, ParentProcessId: 500, WorkingSetSize: 400 * 1048576, CommandLine: 'node.exe eslint.js' },
    { ProcessId: 600, ParentProcessId: 4, WorkingSetSize: 100 * 1048576, CommandLine: `${EXE} --resume=bbbbbbbb-0000-0000-0000-000000000002` },
    { ProcessId: 700, ParentProcessId: 4, WorkingSetSize: 50 * 1048576, CommandLine: `${EXE} --session-id=cccccccc-0000-0000-0000-000000000003` },
    { ProcessId: 701, ParentProcessId: 700, WorkingSetSize: 60 * 1048576, CommandLine: 'powershell.exe -NoProfile -NonInteractive -Command Get-CimInstance Win32_Process | Select-Object ...' },
  ])
  const CLI: Record<string, string> = {
    local_a: 'aaaaaaaa-0000-0000-0000-000000000001',
    local_b: 'bbbbbbbb-0000-0000-0000-000000000002',
  }
  const LISTED = [
    { sessionId: 'local_a', title: 'Busy lint session', isRunning: true },
    { sessionId: 'local_b', title: 'Idle session', isRunning: false },
  ]
  let argv: readonly string[] = []
  let listedRoot = ''
  on('command.register', () => ({ value: { command: 'session-ram' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : e.name === 'APPDATA' ? 'C:\\Users\\x\\AppData\\Roaming' : undefined }))
  on('process.run', (_, e) => {
    argv = e.argv
    return { value: { exitCode: 0, stdout: WIN, stderr: '' } }
  })
  on('fs.list', (_, e) => {
    const path = String(e.path)
    if (path.endsWith('claude-code-sessions')) {
      listedRoot = path
      return { value: [{ name: 'org1', kind: 'dir' }] }
    }
    if (path.endsWith('/org1')) return { value: [{ name: 'acct1', kind: 'dir' }] }
    return { value: Object.keys(CLI).map(id => ({ name: `${id}.json`, kind: 'file' })) }
  })
  on('fs.read', (_, e) => {
    const id = /(local_\w+)\.json$/.exec(String(e.path))?.[1] ?? ''
    return { value: JSON.stringify({ sessionId: id, title: id, cliSessionId: CLI[id] }) }
  })
  on('mcp.call', (_, e) => text(LISTED.find(s => s.sessionId === (e.args as { session_id?: string })?.session_id)))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__session-ram__snapshot' } }))
  on('clock.every', () => ({ value: {} }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: 'C:\\', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 50))

  expect(argv[0]).toBe('powershell.exe')
  // A Mac test host resolves C:\ as relative; on Windows it is absolute.
  expect(listedRoot.endsWith('C:\\Users\\x\\AppData\\Roaming/Claude/claude-code-sessions')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 300 MB + 400 MB child = 700 MB working; 100 MB idle; this session 50 + 60 = 110 MB.
  expect((await ui.find({ type: 'Text', text: /700 MB/ }))?.text).toContain('● working')
  expect((await ui.find({ type: 'Text', text: /100 MB/ }))?.text).toContain('○ idle')
  expect(await ui.find({ type: 'Text', text: /^Idle session$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /This session/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /sessions in memory/ }))?.text).toBe('3 sessions in memory, 2 working')
  await ui.unmount()
})
