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
