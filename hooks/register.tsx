import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Row, View } from '../types'

const PANE = 'session-ram'
const MGMT = 'ccd_session_mgmt'
// The desktop app keeps one JSON file per session under <org>/<account>/ here
// (macOS: under $HOME; Windows: under %APPDATA%, the app's Electron data folder).
const SESSIONS_ROOT = 'Library/Application Support/Claude/claude-code-sessions'
const SESSIONS_ROOT_WIN = 'Claude/claude-code-sessions'
const TICK_MS = 15_000
const DEFAULT_LIMIT_MB = 6144
const SKIP_MS = 10 * 60_000

const view = atom(
  { plugin: 'session-ram', key: 'view' } as const,
  { rows: [], totalMb: 0, limitMb: DEFAULT_LIMIT_MB, isAuto: false, note: 'Measuring…' },
  { shape: 'view-1' },
)

type Proc = { pid: number; ppid: number; kb: number; cmd: string }
type Listed = { sessionId: string; title: string; isRunning: boolean }

// Module state: lost on reload, which only costs a re-read.
const cliToMeta = new Map<string, { sessionId: string; title: string }>()
const skipUntil = new Map<string, number>()
let wasOver = false

const errText = (err: unknown) => String(err).slice(0, 300)

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

const PS_ARGV = ['ps', '-axww', '-o', 'pid=,ppid=,rss=,command=']
const WIN_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'
const WIN_ARGV = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WIN_QUERY]

/** macOS/Linux: `ps -o pid=,ppid=,rss=,command=` lines (rss in KB). */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), kb: Number(m[3]), cmd: m[4] ?? '' })
  }
  return procs
}

type WinProc = { ProcessId?: number; ParentProcessId?: number; WorkingSetSize?: number; CommandLine?: string | null }

/** Windows: WIN_QUERY's JSON (WorkingSetSize in bytes; one process comes back as an object, not a list). */
export function parseWin(out: string): Proc[] {
  const raw: WinProc | WinProc[] = JSON.parse(out.trim() || '[]')
  return (Array.isArray(raw) ? raw : [raw]).map(p => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId),
    kb: Math.round(Number(p.WorkingSetSize ?? 0) / 1024),
    cmd: p.CommandLine ?? '',
  }))
}

/** Session processes, each with the RAM of its whole process tree, and which one runs this mod. */
export function sessionProcs(procs: Proc[]) {
  const kids = new Map<number, Proc[]>()
  for (const p of procs) {
    if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  }
  // shortcut: Windows reuses PIDs, so an orphan can be counted under a new process with its dead parent's PID; rare, check CreationDate if it shows up.
  const treeKb = (pid: number, depth = 0): number =>
    depth > 50 ? 0 : (kids.get(pid) ?? []).reduce((sum, c) => sum + c.kb + treeKb(c.pid, depth + 1), 0)

  // The desktop app starts each session as `<path>/claude[.exe] --output-format ...`: the program
  // itself must be claude, not a shell or grep whose arguments mention it. A launcher that still
  // wraps it with the same args is dropped below, keeping only the innermost match.
  const isSession = (cmd: string) => {
    const exe = /^"?(.*?)"?\s+--output-format\b/.exec(cmd)?.[1]
    return exe !== undefined && !/\s-/.test(exe) && /[\\/]claude(?:\.exe)?$/i.test(exe)
  }
  const matched = procs.filter(p => isSession(p.cmd))
  const matchedPids = new Set(matched.map(p => p.pid))
  const roots = matched
    .filter(p => !(kids.get(p.pid) ?? []).some(c => matchedPids.has(c.pid)))
    .map(p => ({
      pid: p.pid,
      cli: /--(?:resume|session-id)[= ]"?([0-9a-f-]{36})/.exec(p.cmd)?.[1],
      kb: p.kb,
      childKb: treeKb(p.pid),
    }))

  // This session is the root above the process listing it just ran.
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const rootPids = new Set(roots.map(r => r.pid))
  let cur = procs.find(p => p.cmd.startsWith('ps -axww') || p.cmd.includes('Get-CimInstance Win32_Process'))
  for (let hops = 0; cur && !rootPids.has(cur.pid) && hops < 50; hops++) cur = byPid.get(cur.ppid)

  return { roots, selfPid: cur && rootPids.has(cur.pid) ? cur.pid : undefined }
}

const isWindows = async ($: Engine) => (await $.env.get('OS')) === 'Windows_NT'

async function mgmt($: Engine, tool: string, args: Record<string, unknown>) {
  const res = await $.mcp.call(MGMT, tool, args)
  const text = res.content.map(b => b.text ?? '').join('')
  // The app's tools can answer a failure as plain "Error: ..." text without isError.
  if (res.isError || /^\s*error\b/i.test(text)) throw new Error(text.slice(0, 300) || `${tool} failed`)

  return text
}

/** Maps CLI session ids (the --resume uuid) to the app's sessions, from the app's own session files. */
async function scanSessionFiles($: Engine) {
  const base = (name: string) => name.split(/[\\/]/).pop() ?? name
  const subdirs = async (dir: string) =>
    (await $.fs.list(dir)).filter(e => e.kind === 'dir').map(e => `${dir}/${base(e.name)}`)
  const root = (await isWindows($))
    ? `${await $.env.get('APPDATA')}/${SESSIONS_ROOT_WIN}`
    : `${await $.env.get('HOME')}/${SESSIONS_ROOT}`
  const files: string[] = []
  for (const org of await subdirs(root)) {
    for (const account of await subdirs(org)) {
      for (const e of await $.fs.list(account)) {
        if (e.kind === 'file' && e.name.endsWith('.json')) files.push(`${account}/${base(e.name)}`)
      }
    }
  }

  cliToMeta.clear()
  for (const file of files) {
    try {
      const meta = JSON.parse(await $.fs.read(file))
      for (const id of [meta.cliSessionId, meta.lastAssistantCliSessionId]) {
        if (typeof id === 'string') cliToMeta.set(id, { sessionId: meta.sessionId, title: meta.title ?? meta.sessionId })
      }
    } catch {
      // Unreadable file: its session shows as unknown.
    }
  }
}

async function measure($: Engine): Promise<{ rows: Row[]; note: string }> {
  const win = await isWindows($)
  const listing = await $.process.run(win ? WIN_ARGV : PS_ARGV)
  const { roots, selfPid } = sessionProcs(win ? parseWin(listing.stdout) : parsePs(listing.stdout))
  if (roots.some(p => p.cli && !cliToMeta.has(p.cli))) await scanSessionFiles($)
  // One small get_session per loaded session: a full list_sessions overflows the tool-result limit.
  const listed = new Map<string, Listed>()
  let note = ''
  const ids = roots.flatMap(p => (p.pid !== selfPid && p.cli && cliToMeta.get(p.cli)?.sessionId) || [])
  await Promise.all(
    ids.map(async id => {
      try {
        listed.set(id, JSON.parse(await mgmt($, 'get_session', { session_id: id })))
      } catch (err) {
        note = `Working/idle unknown for some sessions: ${errText(err)}`
      }
    }),
  )

  const rows = roots
    .map(p => {
      const meta = p.cli ? cliToMeta.get(p.cli) : undefined
      const s = meta ? listed.get(meta.sessionId) : undefined
      const isSelf = p.pid === selfPid
      return {
        pid: p.pid,
        sessionId: meta?.sessionId ?? null,
        title: isSelf ? 'This session (RAM panel)' : (s?.title ?? meta?.title ?? `Unknown session (pid ${p.pid})`),
        mb: Math.round((p.kb + p.childKb) / 1024),
        childMb: Math.round(p.childKb / 1024),
        isWorking: isSelf ? true : s ? s.isRunning : null,
        isSelf,
      }
    })
    .sort((a, b) => b.mb - a.mb)

  return { rows, note }
}

async function archive($: Engine, row: Row) {
  skipUntil.set(row.sessionId!, (await $.clock.now()) + SKIP_MS)
  try {
    await mgmt($, 'archive_session', { session_id: row.sessionId, reason: `Free ${row.mb} MB of RAM` })
    return `Archived "${row.title}" (${row.mb} MB).`
  } catch (err) {
    return `Could not archive "${row.title}": ${String(err)}`
  }
}

async function tick($: Engine) {
  const limitMb = Number((await $.store.get('limitMb')) ?? DEFAULT_LIMIT_MB)
  const isAuto = (await $.store.get('isAuto')) === true
  let rows: Row[] = []
  let note = ''
  try {
    ;({ rows, note } = await measure($))
  } catch (err) {
    note = `Could not measure: ${errText(err)}`
  }
  const totalMb = rows.reduce((sum, r) => sum + r.mb, 0)
  if (rows.length > 0 && totalMb > limitMb) {
    const now = await $.clock.now()
    // Largest idle session first; working sessions and this one are never archived.
    const victim = isAuto
      ? rows.find(r => r.isWorking === false && !r.isSelf && r.sessionId && (skipUntil.get(r.sessionId) ?? 0) < now)
      : undefined
    if (victim) {
      note = await archive($, victim)
      $.ui.toast(note)
    } else if (!wasOver) {
      $.ui.toast(`Sessions use ${gb(totalMb)}, over your ${gb(limitMb)} limit.`)
    }
    wasOver = true
  } else {
    wasOver = false
  }
  await update($, view, () => ({ rows, totalMb, limitMb, isAuto, note }))
}

async function setLimit($: Engine, deltaMb: number) {
  const cur = Number((await $.store.get('limitMb')) ?? DEFAULT_LIMIT_MB)
  const limitMb = Math.max(1024, cur + deltaMb)
  await $.store.set('limitMb', limitMb)
  await update($, view, v => ({ ...v, limitMb }))
}

async function toggleAuto($: Engine) {
  const isAuto = (await $.store.get('isAuto')) !== true
  await $.store.set('isAuto', isAuto)
  await update($, view, v => ({ ...v, isAuto }))
  await tick($)
}

async function act($: Engine, row: Row) {
  if (row.isWorking) {
    try {
      await mgmt($, 'stop_session', { session_id: row.sessionId })
      $.ui.toast(`Stopped the turn in "${row.title}".`)
    } catch (err) {
      $.ui.toast(`Could not stop "${row.title}": ${String(err)}`)
    }
  } else {
    $.ui.toast(await archive($, row))
  }
  await tick($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'session-ram', description: 'Show loaded sessions and their RAM' })
    await $.tool.register({
      name: 'snapshot',
      description: 'Session RAM panel: re-measures and returns the rows it shows (per-session RAM, working/idle) and any error, as JSON.',
    })
    void $.ui.open({ id: PANE, title: 'Session RAM' })
    void tick($)
    $.clock.every(TICK_MS, () => tick($))

    return started
  })

  on('tool.call', { tool: 'mcp__session-ram__snapshot' }, async $ => {
    await tick($)

    return { result: JSON.stringify(await read($, view), null, 1) }
  })

  on('command.run', { command: 'session-ram' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session RAM' })
    void tick($)

    return { text: 'Session RAM pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v: View = await read($, view)
    const isOver = v.totalMb > v.limitMb
    const working = v.rows.filter(r => r.isWorking).length

    return (
      <Box flexDirection="column">
        <Text bold color={isOver ? 'error' : undefined}>
          {gb(v.totalMb)} used of {gb(v.limitMb)} limit
        </Text>
        <Text dimColor>
          {v.rows.length} sessions in memory, {working} working
        </Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          <Button key="down" label="− 1 GB" onPress={() => void setLimit($, -1024)} />
          <Button key="up" label="+ 1 GB" onPress={() => void setLimit($, 1024)} />
          <Button key="auto" label={v.isAuto ? 'Auto: on' : 'Auto: off'} onPress={() => void toggleAuto($)} />
          <Button key="refresh" label="Refresh" onPress={() => void tick($)} />
        </Box>
        <Text dimColor>Auto: archive the largest idle session while over the limit.</Text>
        {v.rows.map(r => (
          <Box flexDirection="column">
            <Text bold color={r.isWorking ? 'success' : undefined}>
              {r.isWorking ? '● working' : r.isWorking === false ? '○ idle' : '? unknown'} · {r.mb} MB
              {r.childMb > 0 ? ` (${r.childMb} MB child processes)` : ''}
            </Text>
            <Text dimColor={r.isWorking === false}>{r.title}</Text>
            {!r.isSelf && r.sessionId && r.isWorking !== null && (
              <Button key={`act-${r.pid}`} label={r.isWorking ? 'Stop turn' : 'Archive'} onPress={() => void act($, r)} />
            )}
          </Box>
        ))}
        {v.note !== '' && <Text dimColor>{v.note}</Text>}
      </Box>
    )
  })
}
