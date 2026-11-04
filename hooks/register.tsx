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
// After Auto stops a turn, give its RAM time to drop before stopping another.
const STOP_GAP_MS = 20_000

const view = atom(
  { plugin: 'session-ram', key: 'view' } as const,
  { rows: [], totalMb: 0, limitMb: DEFAULT_LIMIT_MB, isAuto: false, note: 'Measuring…' },
  { shape: 'view-2' },
)

type Proc = { pid: number; ppid: number; kb: number; cmd: string }
type Listed = { sessionId: string; title: string; isRunning: boolean }

// Module state: lost on reload, which only costs a re-read.
const cliToMeta = new Map<string, { sessionId: string; title: string }>()
const titleById = new Map<string, string>()
let wasOver = false
let inFlight: Promise<void> | undefined

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
      if (typeof meta.sessionId === 'string') titleById.set(meta.sessionId, meta.title ?? meta.sessionId)
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
  // A session started fresh in this app run has no --resume id; on macOS its environment names it.
  // shortcut: Windows can't read another process's environment, so fresh sessions there show as unknown until resumed.
  const hostIds = new Map<number, string>()
  const unnamed = roots.filter(p => !(p.cli && cliToMeta.has(p.cli)))
  if (!win && unnamed.length > 0) {
    const env = await $.process.run(['ps', '-wwE', '-o', 'pid=,command=', '-p', unnamed.map(p => p.pid).join(',')])
    for (const line of env.stdout.split('\n')) {
      const m = /^\s*(\d+)\s.*\bCLAUDE_CODE_HOST_SESSION_ID=(local_[\w-]+)/.exec(line)
      if (m) hostIds.set(Number(m[1]), m[2] ?? '')
    }
  }
  const sessionIdOf = (p: { pid: number; cli?: string }) => hostIds.get(p.pid) ?? (p.cli ? cliToMeta.get(p.cli)?.sessionId : undefined)
  if (roots.some(p => (p.cli && !cliToMeta.has(p.cli)) || (hostIds.has(p.pid) && !titleById.has(hostIds.get(p.pid)!)))) {
    await scanSessionFiles($)
  }
  // One small get_session per loaded session: a full list_sessions overflows the tool-result limit.
  const listed = new Map<string, Listed>()
  let note = ''
  const ids = roots.flatMap(p => sessionIdOf(p) || [])
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
      const sid = sessionIdOf(p)
      const s = sid ? listed.get(sid) : undefined
      const isSelf = p.pid === selfPid
      const name = s?.title ?? (sid ? titleById.get(sid) : undefined)
      return {
        pid: p.pid,
        sessionId: sid ?? null,
        title: isSelf ? `This session${name ? `: ${name}` : ''}` : (name ?? `Unknown session (pid ${p.pid})`),
        mb: Math.round((p.kb + p.childKb) / 1024),
        childMb: Math.round(p.childKb / 1024),
        // This session asks about itself too: an idle session running the mod is not working.
        isWorking: s ? s.isRunning : isSelf ? true : null,
        isSelf,
        isFlagged: false,
      }
    })
    .sort((a, b) => b.mb - a.mb)

  return { rows, note }
}

async function archive($: Engine, row: Row) {
  try {
    await mgmt($, 'archive_session', { session_id: row.sessionId, reason: `Free ${row.mb} MB of RAM` })
    return `Archived "${row.title}" (${row.mb} MB).`
  } catch (err) {
    return `Could not archive "${row.title}": ${String(err)}`
  }
}

// Files shared with every session and with the macOS menu-bar script (menubar/):
// the settings either side can change, and the latest snapshot for the menu bar to read.
const claudeDir = async ($: Engine) =>
  `${(await isWindows($)) ? await $.env.get('USERPROFILE') : await $.env.get('HOME')}/.claude`
type Settings = { limitMb: number; isAuto: boolean }

async function readSettings($: Engine): Promise<Settings> {
  try {
    const s = JSON.parse(await $.fs.read(`${await claudeDir($)}/session-ram-settings.json`))
    return { limitMb: Number(s.limitMb) || DEFAULT_LIMIT_MB, isAuto: s.isAuto === true }
  } catch {
    return { limitMb: DEFAULT_LIMIT_MB, isAuto: false }
  }
}

async function writeSettings($: Engine, s: Settings) {
  await $.fs.write(`${await claudeDir($)}/session-ram-settings.json`, JSON.stringify(s))
}

/** Sessions Auto stopped for going over the limit, by session id: shared so every session and the menu bar highlight them. */
type Flags = Record<string, { at: number; mb: number; title: string }>

/**
 * Stop requests from the menu bar or tray, which can't reach the app's session tools: any session
 * running this mod carries them out. A session can't stop its own turn, so it leaves requests for
 * itself to the others.
 * shortcut: two writers can race and drop a request made in the same instant; clicking Stop again re-sends it.
 */
async function handleRequests($: Engine) {
  const path = `${await claudeDir($)}/session-ram-requests.json`
  let requests: Record<string, { action: string; at: number }>
  try {
    requests = JSON.parse(await $.fs.read(path))
  } catch {
    return
  }
  const selfId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  const mine = Object.entries(requests).filter(([id]) => id !== selfId)
  if (mine.length === 0) return
  const rest = Object.fromEntries(Object.entries(requests).filter(([id]) => id === selfId))
  await $.fs.write(path, JSON.stringify(rest))
  const now = await $.clock.now()
  for (const [id, r] of mine) {
    if (r.action !== 'stop' || now - r.at > 120_000) continue
    const title = titleById.get(id) ?? id
    try {
      await mgmt($, 'stop_session', { session_id: id })
      $.ui.toast(`Stopped the turn in "${title}" (asked from the menu bar).`)
    } catch (err) {
      $.ui.toast(`Could not stop "${title}": ${errText(err)}`)
    }
  }
  await tick($)
}

async function readFlags($: Engine): Promise<Flags> {
  try {
    return JSON.parse(await $.fs.read(`${await claudeDir($)}/session-ram-stopped.json`))
  } catch {
    return {}
  }
}

/** One check at a time per session: the timer, Refresh and a press can overlap, and two overlapping checks would each stop a session. */
function tick($: Engine): Promise<void> {
  inFlight ??= runTick($).finally(() => {
    inFlight = undefined
  })
  return inFlight
}

async function runTick($: Engine) {
  const { limitMb, isAuto } = await readSettings($)
  let rows: Row[] = []
  let note = ''
  try {
    ;({ rows, note } = await measure($))
  } catch (err) {
    note = `Could not measure: ${errText(err)}`
  }
  const totalMb = rows.reduce((sum, r) => sum + r.mb, 0)
  const now = await $.clock.now()
  const flags = await readFlags($)
  const before = JSON.stringify(flags)
  for (const [id, f] of Object.entries(flags)) {
    const row = rows.find(r => r.sessionId === id)
    // Gone (archived or closed), or working again a minute after the stop: the person resumed it.
    if (!row || (row.isWorking && now - f.at > 60_000)) delete flags[id]
  }
  if (rows.length > 0 && totalMb > limitMb) {
    // Auto never archives: it stops the in-flight turn of the largest working session (its lint,
    // tsc and other child processes end with it) and flags it for the person to look at.
    const target = isAuto
      ? rows.find(r => r.isWorking && !r.isSelf && r.sessionId && !flags[r.sessionId])
      : undefined
    const isRecent = Object.values(flags).some(f => now - f.at < STOP_GAP_MS)
    if (target && !isRecent) {
      // Record the flag before stopping, so other sessions running this check see it and hold off.
      flags[target.sessionId!] = { at: now, mb: target.mb, title: target.title }
      await $.fs.write(`${await claudeDir($)}/session-ram-stopped.json`, JSON.stringify(flags)).catch(() => {})
      try {
        await mgmt($, 'stop_session', { session_id: target.sessionId })
        note = `Stopped "${target.title}" (${target.mb} MB): sessions were over the ${gb(limitMb)} limit.`
      } catch (err) {
        delete flags[target.sessionId!]
        note = `Could not stop "${target.title}": ${errText(err)}`
      }
      $.ui.toast(note)
    } else if (!wasOver) {
      $.ui.toast(`Sessions use ${gb(totalMb)}, over your ${gb(limitMb)} limit.`)
    }
    wasOver = true
  } else {
    wasOver = false
  }
  if (JSON.stringify(flags) !== before) {
    await $.fs.write(`${await claudeDir($)}/session-ram-stopped.json`, JSON.stringify(flags)).catch(() => {})
  }
  rows = rows.map(r => ({ ...r, isFlagged: !!(r.sessionId && flags[r.sessionId]) }))
  await update($, view, () => ({ rows, totalMb, limitMb, isAuto, note }))
  if (rows.length > 0) {
    const status = { writtenAt: now, rows, totalMb, limitMb, isAuto }
    await $.fs.write(`${await claudeDir($)}/session-ram-status.json`, JSON.stringify(status)).catch(() => {})
  }
}

/** A typed limit: "8", "8 GB", "8.5g" or "8192 MB" (a bare number is GB); at least 1 GB. */
export function parseLimitMb(text: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(gb?|mb?)?\s*$/i.exec(text)
  if (!m) return undefined
  const mb = (m[2] ?? 'g').toLowerCase().startsWith('m') ? Number(m[1]) : Number(m[1]) * 1024
  return mb >= 1024 ? Math.round(mb) : undefined
}

async function setLimitTo($: Engine, limitMb: number) {
  const s = await readSettings($)
  await writeSettings($, { ...s, limitMb })
  await update($, view, v => ({ ...v, limitMb }))
}

async function setLimit($: Engine, deltaMb: number) {
  await setLimitTo($, Math.max(1024, (await readSettings($)).limitMb + deltaMb))
}

async function setLimitText($: Engine, text: string) {
  const limitMb = parseLimitMb(text)
  if (limitMb === undefined) $.ui.toast('Type a limit like 8 or 8 GB (at least 1 GB).')
  else await setLimitTo($, limitMb)
}

async function toggleAuto($: Engine) {
  const s = await readSettings($)
  await writeSettings($, { ...s, isAuto: !s.isAuto })
  await update($, view, v => ({ ...v, isAuto: !s.isAuto }))
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
    $.clock.every(3_000, () => handleRequests($))

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
    const flagged = v.rows.filter(r => r.isFlagged).length

    return (
      <Box flexDirection="column">
        <Text bold color={isOver ? 'error' : undefined}>
          {gb(v.totalMb)} used of {gb(v.limitMb)} limit
        </Text>
        <Text dimColor>
          {v.rows.length} sessions in memory, {working} working
        </Text>
        {flagged > 0 && (
          <Text bold color="error">
            ⚠ {flagged} stopped for going over the limit. Check them before resuming.
          </Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          <Button key="down" label="− 1 GB" onPress={() => void setLimit($, -1024)} />
          <Button key="up" label="+ 1 GB" onPress={() => void setLimit($, 1024)} />
          <Button key="auto" label={v.isAuto ? 'Auto: on' : 'Auto: off'} onPress={() => void toggleAuto($)} />
          <Button key="refresh" label="Refresh" onPress={() => void tick($)} />
        </Box>
        {e.surface !== 'mobile' &&
          (() => {
            const { Input } = $.ui.resolve(e)
            return <Input key="limit" placeholder="Set limit, e.g. 8 GB" submitLabel="Set" onSubmit={text => void setLimitText($, text)} />
          })()}
        <Text dimColor>Auto: while over the limit, stop the turn of the largest working session and flag it. Never archives.</Text>
        {v.rows.map(r => (
          <Box flexDirection="column">
            <Text bold color={r.isFlagged ? 'error' : r.isWorking ? 'success' : undefined}>
              {r.isFlagged ? '⚠ stopped (over limit)' : r.isWorking ? '● working' : r.isWorking === false ? '○ idle' : '? unknown'} · {r.mb} MB
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
