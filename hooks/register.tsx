import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Row, View } from '../types'

const PANE = 'session-ram'
const MGMT = 'ccd_session_mgmt'
const PR = 'ccd_pr'
const AUTOFIX_EVERY_MS = 120_000
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
  { rows: [], otherMb: 0, totalMb: 0, limitMb: DEFAULT_LIMIT_MB, isAuto: false, note: 'Measuring…' },
  { shape: 'view-3' },
)

type Proc = { pid: number; ppid: number; kb: number; cmd: string }
type Listed = { sessionId: string; title: string; isRunning: boolean }

// Module state: lost on reload, which only costs a re-read.
const cliToMeta = new Map<string, { sessionId: string; title: string }>()
const titleById = new Map<string, string>()
// Sessions not archived, from the app's session files: the ones whose PRs the Auto-fix check reads.
const liveIds = new Set<string>()
let wasOver = false
let inFlight: Promise<void> | undefined

const errText = (err: unknown) => String(err).slice(0, 300)

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

const PS_ARGV = ['ps', '-axww', '-o', 'pid=,ppid=,rss=,command=']
// Each process's memory footprint, what Activity Monitor shows. ps's RSS leaves out memory macOS
// compressed, often half of an idle session's. Costs ~0.4 s of CPU, so one session measures for all.
const TOP_ARGV = ['top', '-l', '1', '-stats', 'pid,mem']
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

/** macOS `top -l 1 -stats pid,mem`: pid -> memory footprint in KB ("363M", "1008K", "1.2G"; a trailing +/- marks a change). */
export function parseTop(out: string): Map<number, number> {
  const unitKb: Record<string, number> = { B: 1 / 1024, K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 }
  const kb = new Map<number, number>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s*$/.exec(line)
    if (m) kb.set(Number(m[1]), Math.round(Number(m[2]) * (unitKb[m[3] ?? 'K'] ?? 1)))
  }
  return kb
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

/**
 * Session processes, each with the RAM of its whole process tree, and which one runs this mod.
 * Also what builds and tests leave outside those trees: `appKb`, what the app started through its
 * launcher (preview dev servers, MCP servers), and `detached`, processes that moved under launchd
 * (pid 1) when started with `&`, nohup or as a daemon; measure() reads their environment to find
 * the session that started them.
 */
export function sessionProcs(procs: Proc[]) {
  const kids = new Map<number, Proc[]>()
  for (const p of procs) {
    if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  }
  // Every process is counted once: a tree walked later skips what an earlier one counted.
  const counted = new Set<number>()
  // shortcut: Windows reuses PIDs, so an orphan can be counted under a new process with its dead parent's PID; rare, check CreationDate if it shows up.
  const treeKb = (pid: number, depth = 0): number =>
    depth > 50
      ? 0
      : (kids.get(pid) ?? []).reduce((sum, c) => {
          if (counted.has(c.pid)) return sum
          counted.add(c.pid)
          return sum + c.kb + treeKb(c.pid, depth + 1)
        }, 0)

  // The desktop app starts each session as `<path>/claude[.exe] --output-format ...`: the program
  // itself must be claude, not a shell or grep whose arguments mention it. A launcher that still
  // wraps it with the same args is dropped below, keeping only the innermost match.
  const isSession = (cmd: string) => {
    const exe = /^"?(.*?)"?\s+--output-format\b/.exec(cmd)?.[1]
    return exe !== undefined && !/\s-/.test(exe) && /[\\/]claude(?:\.exe)?$/i.test(exe)
  }
  const matched = procs.filter(p => isSession(p.cmd))
  const matchedPids = new Set(matched.map(p => p.pid))
  const isWrapper = (p: Proc) => (kids.get(p.pid) ?? []).some(c => matchedPids.has(c.pid))
  const roots = matched
    .filter(p => !isWrapper(p))
    .map(p => {
      counted.add(p.pid)
      return { pid: p.pid, cli: /--(?:resume|session-id)[= ]"?([0-9a-f-]{36})/.exec(p.cmd)?.[1], kb: p.kb, childKb: treeKb(p.pid) }
    })
  const ownKb = (p: Proc) => {
    counted.add(p.pid)
    return p.kb + treeKb(p.pid)
  }
  // The macOS app starts sessions, preview dev servers and MCP servers through Helpers/disclaimer.
  const appKb = procs
    .filter(p => /[\\/]Helpers[\\/]disclaimer\b/.test(p.cmd) && !isWrapper(p))
    .reduce((sum, p) => (counted.has(p.pid) ? sum : sum + ownKb(p)), 0)
  const detached = procs.filter(p => p.ppid === 1 && !counted.has(p.pid)).map(p => ({ pid: p.pid, kb: ownKb(p) }))

  // This session is the root above the process listing it just ran.
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const rootPids = new Set(roots.map(r => r.pid))
  let cur = procs.find(p => p.cmd.startsWith('ps -axww') || p.cmd.includes('Get-CimInstance Win32_Process'))
  for (let hops = 0; cur && !rootPids.has(cur.pid) && hops < 50; hops++) cur = byPid.get(cur.ppid)

  return { roots, appKb, detached, selfPid: cur && rootPids.has(cur.pid) ? cur.pid : undefined }
}

const isWindows = async ($: Engine) => (await $.env.get('OS')) === 'Windows_NT'

async function mgmt($: Engine, tool: string, args: Record<string, unknown>, server = MGMT) {
  const res = await $.mcp.call(server, tool, args)
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
        // Session files are local_<id>.json; the app keeps other files there too (mod-commands.json is a list).
        if (e.kind === 'file' && /^local_.*\.json$/.test(base(e.name))) files.push(`${account}/${base(e.name)}`)
      }
    }
  }

  cliToMeta.clear()
  liveIds.clear()
  for (const file of files) {
    try {
      const meta = JSON.parse(await $.fs.read(file))
      if (typeof meta.sessionId === 'string') titleById.set(meta.sessionId, meta.title ?? meta.sessionId)
      if (typeof meta.sessionId === 'string' && !meta.isArchived) liveIds.add(meta.sessionId)
      for (const id of [meta.cliSessionId, meta.lastAssistantCliSessionId]) {
        if (typeof id === 'string') cliToMeta.set(id, { sessionId: meta.sessionId, title: meta.title ?? meta.sessionId })
      }
    } catch {
      // Unreadable file: its session shows as unknown.
    }
  }
}

async function measure($: Engine): Promise<{ rows: Row[]; otherMb: number; note: string }> {
  const win = await isWindows($)
  const [listing, top] = await Promise.all([
    $.process.run(win ? WIN_ARGV : PS_ARGV),
    win ? undefined : $.process.run(TOP_ARGV).catch(() => undefined),
  ])
  let procs = win ? parseWin(listing.stdout) : parsePs(listing.stdout)
  // Without top's figure (it failed, or the process started after it ran), RSS stands in.
  const footprint = parseTop(top?.stdout ?? '')
  procs = procs.map(p => ({ ...p, kb: footprint.get(p.pid) ?? p.kb }))
  const { roots, appKb, detached, selfPid } = sessionProcs(procs)
  // A session started fresh in this app run has no --resume id; on macOS its environment names it,
  // and so does the environment of a build or test process that detached from it (inherited).
  // shortcut: Windows can't read another process's environment, so fresh sessions there show as unknown until resumed
  // and detached processes aren't counted.
  const hostIds = new Map<number, string>()
  const unnamed = roots.filter(p => !(p.cli && cliToMeta.has(p.cli)))
  const envPids = [...unnamed, ...detached].map(p => p.pid)
  if (!win && envPids.length > 0) {
    const env = await $.process.run(['ps', '-wwE', '-o', 'pid=,command=', '-p', envPids.join(',')])
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

  // Detached processes go to the loaded session that started them; the rest (from a session since
  // closed) count with what the app started.
  const detachedKb = new Map<string, number>()
  let otherKb = appKb
  const loadedIds = new Set(roots.map(p => sessionIdOf(p)))
  for (const d of detached) {
    const sid = hostIds.get(d.pid)
    if (sid && loadedIds.has(sid)) detachedKb.set(sid, (detachedKb.get(sid) ?? 0) + d.kb)
    else if (sid) otherKb += d.kb
  }

  const rows = roots
    .map(p => {
      const sid = sessionIdOf(p)
      const s = sid ? listed.get(sid) : undefined
      const isSelf = p.pid === selfPid
      const name = s?.title ?? (sid ? titleById.get(sid) : undefined)
      const childKb = p.childKb + (sid ? (detachedKb.get(sid) ?? 0) : 0)
      return {
        pid: p.pid,
        sessionId: sid ?? null,
        title: name ?? `Unknown session (pid ${p.pid})`,
        mb: Math.round((p.kb + childKb) / 1024),
        childMb: Math.round(childKb / 1024),
        // This session asks about itself too: an idle session running the mod is not working.
        isWorking: s ? s.isRunning : isSelf ? true : null,
        isSelf,
        isFlagged: false,
      }
    })
    .sort((a, b) => b.mb - a.mb)

  return { rows, otherMb: Math.round(otherKb / 1024), note }
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
// autoOpenPanel: open the panel when a session starts (off for people who use the menu bar or tray instead).
type Settings = { limitMb: number; isAuto: boolean; autoOpenPanel: boolean }

async function readSettings($: Engine): Promise<Settings> {
  try {
    const s = JSON.parse(await $.fs.read(`${await claudeDir($)}/session-ram-settings.json`))
    return { limitMb: Number(s.limitMb) || DEFAULT_LIMIT_MB, isAuto: s.isAuto === true, autoOpenPanel: s.autoOpenPanel !== false }
  } catch {
    return { limitMb: DEFAULT_LIMIT_MB, isAuto: false, autoOpenPanel: true }
  }
}

async function writeSettings($: Engine, s: Settings) {
  await $.fs.write(`${await claudeDir($)}/session-ram-settings.json`, JSON.stringify(s))
}

/** Sessions Auto stopped for going over the limit, by session id: shared so every session and the menu bar highlight them. */
type Flags = Record<string, { at: number; mb: number; title: string }>

type Request = { action: string; at: number; session?: string }

/**
 * Requests from the menu bar or tray, which can't reach the app's session tools.
 * - `stop` (keyed by session id): any other session running this mod stops that session's turn;
 *   a session can't stop its own turn.
 * - `autofix-off` (keyed `autofix-off:<id>`): only that session itself can switch off its PR's
 *   Auto-fix, so it waits until that session runs (an Auto-fix event waking it is enough).
 * shortcut: two writers can race and drop a request made in the same instant; clicking again re-sends it.
 */
async function handleRequests($: Engine) {
  const path = `${await claudeDir($)}/session-ram-requests.json`
  let requests: Record<string, Request>
  try {
    requests = JSON.parse(await $.fs.read(path))
  } catch {
    return
  }
  const selfId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  const isMine = ([key, r]: [string, Request]) =>
    r.action === 'stop' ? key !== selfId : r.action === 'autofix-off' && !!selfId && r.session === selfId
  const mine = Object.entries(requests).filter(isMine)
  if (mine.length === 0) return
  await $.fs.write(path, JSON.stringify(Object.fromEntries(Object.entries(requests).filter(e => !isMine(e)))))
  const now = await $.clock.now()
  for (const [key, r] of mine) {
    if (r.action === 'stop') {
      if (now - r.at > 120_000) continue
      const title = titleById.get(key) ?? key
      try {
        await mgmt($, 'stop_session', { session_id: key })
        $.ui.toast(`Stopped the turn in "${title}" (asked from the menu bar).`)
      } catch (err) {
        $.ui.toast(`Could not stop "${title}": ${errText(err)}`)
      }
    } else {
      try {
        const status = JSON.parse(await mgmt($, 'get_status', {}, PR))
        if (status.bound && status.monitor?.auto_fix) {
          await mgmt($, 'set_monitor', { auto_fix: false, address_comments: false, url: status.pr.url }, PR)
          $.ui.toast(`Turned off Auto-fix for PR #${status.pr.number} (asked from the menu bar).`)
        }
      } catch (err) {
        $.ui.toast(`Could not turn off Auto-fix: ${errText(err)}`)
      }
    }
  }
  await tick($, true)
  await scanAutofix($, true)
}

/**
 * Which sessions have Auto-fix on for an open PR: Auto-fix wakes them on CI failures and review
 * comments, so several can start working at once. The app keeps the switch per session, so this
 * reads each live session's PR status. One check every 2 minutes across all sessions, recorded in
 * a shared file the menu bar and tray read.
 */
let autofixInFlight: Promise<void> | undefined

function scanAutofix($: Engine, isForced = false): Promise<void> {
  autofixInFlight ??= runAutofixScan($, isForced).finally(() => {
    autofixInFlight = undefined
  })
  return autofixInFlight
}

async function runAutofixScan($: Engine, isForced: boolean) {
  const path = `${await claudeDir($)}/session-ram-autofix.json`
  let prev: { checkedAt?: number; sessions?: unknown[] } | undefined
  try {
    prev = JSON.parse(await $.fs.read(path))
  } catch {
    prev = undefined
  }
  const now = await $.clock.now()
  if (!isForced && prev?.checkedAt && now - prev.checkedAt < AUTOFIX_EVERY_MS) return
  // Claim this round, then check the claim held: when Claude starts, many sessions get here together.
  const owner = `${await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')}:${now}:${Math.random()}`
  await $.fs.write(path, JSON.stringify({ ...prev, checkedAt: now, owner }))
  if (JSON.parse(await $.fs.read(path)).owner !== owner) return
  await scanSessionFiles($)
  const ids = [...liveIds]
  const sessions: { sessionId: string; title: string; pr: number; url: string; failing: number; pending: number; isCiKnown: boolean }[] = []
  let errors = 0
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map(async id => {
        try {
          const st = JSON.parse(await mgmt($, 'get_status', { session_id: id }, PR))
          if (st.bound && st.monitor?.auto_fix && st.pr?.state === 'open') {
            const title = titleById.get(id) ?? id
            sessions.push({ sessionId: id, title, pr: st.pr.number, url: st.pr.url, failing: st.checks?.failing ?? 0, pending: st.checks?.pending ?? 0, isCiKnown: st.checks?.available === true })
          }
        } catch {
          errors++
        }
      }),
    )
  }
  const result = { checkedAt: now, checked: ids.length, errors, sessions: sessions.sort((a, b) => a.pr - b.pr) }
  await $.fs.write(path, JSON.stringify(result))
}

async function readFlags($: Engine): Promise<Flags> {
  try {
    return JSON.parse(await $.fs.read(`${await claudeDir($)}/session-ram-stopped.json`))
  } catch {
    return {}
  }
}

/**
 * One check at a time per session: the timer, Refresh and a press can overlap, and two overlapping checks would each stop a session.
 * isForced measures even when another session measured this round (Refresh, after a stop).
 */
function tick($: Engine, isForced = false): Promise<void> {
  // A check that fails (the module reloading under it, a file it can't write) is retried by the next one.
  inFlight ??= runTick($, isForced)
    .catch(() => {})
    .finally(() => {
    inFlight = undefined
  })
  return inFlight
}

type Status = { writtenAt: number; measuredBy?: string; rows: Row[]; otherMb?: number; totalMb: number }

async function readStatus($: Engine): Promise<Status | undefined> {
  try {
    const s = JSON.parse(await $.fs.read(`${await claudeDir($)}/session-ram-status.json`))
    return typeof s.writtenAt === 'number' && Array.isArray(s.rows) && typeof s.totalMb === 'number' ? s : undefined
  } catch {
    return undefined
  }
}

async function runTick($: Engine, isForced = false) {
  const { limitMb, isAuto } = await readSettings($)
  const selfId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  // Another session measured this round: show its snapshot. It also runs Auto, so only one session stops turns.
  const shared = isForced ? undefined : await readStatus($)
  // A snapshot without measuredBy is from an older version of this mod, which measured RSS.
  if (shared?.measuredBy && shared.measuredBy !== selfId && (await $.clock.now()) - shared.writtenAt < TICK_MS - 3_000) {
    const isOver = shared.totalMb > limitMb
    if (isOver && !wasOver) $.ui.toast(`Sessions use ${gb(shared.totalMb)}, over your ${gb(limitMb)} limit.`)
    wasOver = isOver
    const rows = shared.rows.map(r => ({ ...r, isSelf: !!selfId && r.sessionId === selfId }))
    await update($, view, () => ({ rows, otherMb: shared.otherMb ?? 0, totalMb: shared.totalMb, limitMb, isAuto, note: '' }))
    return
  }
  let rows: Row[] = []
  let otherMb = 0
  let note = ''
  try {
    ;({ rows, otherMb, note } = await measure($))
  } catch (err) {
    note = `Could not measure: ${errText(err)}`
  }
  const totalMb = rows.reduce((sum, r) => sum + r.mb, otherMb)
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
  await update($, view, () => ({ rows, otherMb, totalMb, limitMb, isAuto, note }))
  if (rows.length > 0) {
    const status = { writtenAt: now, measuredBy: selfId, rows, otherMb, totalMb, limitMb, isAuto }
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
  await tick($, true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'session-ram', description: 'Show loaded sessions and their RAM' })
    await $.tool.register({
      name: 'snapshot',
      description: 'Session RAM panel: re-measures and returns the rows it shows (per-session RAM, working/idle) and any error, as JSON.',
    })
    if ((await readSettings($)).autoOpenPanel) void $.ui.open({ id: PANE, title: 'Session RAM' })
    void tick($)
    $.clock.every(TICK_MS, () => tick($))
    $.clock.every(3_000, () => handleRequests($).catch(() => {}))
    // Each session's period differs a little, so sessions that start together don't all check together.
    $.clock.every(30_000 + Math.round(Math.random() * 10_000), () => scanAutofix($).catch(() => {}))

    return started
  })

  on('tool.call', { tool: 'mcp__session-ram__snapshot' }, async $ => {
    await tick($, true)

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
          <Button key="refresh" label="Refresh" onPress={() => void tick($, true)} />
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
            <Text dimColor={r.isWorking === false}>{r.isSelf ? `This session: ${r.title}` : r.title}</Text>
            {!r.isSelf && r.sessionId && r.isWorking !== null && (
              <Button key={`act-${r.pid}`} label={r.isWorking ? 'Stop turn' : 'Archive'} onPress={() => void act($, r)} />
            )}
          </Box>
        ))}
        {v.otherMb > 0 && (
          <Text dimColor>
            {v.otherMb} MB in dev servers and MCP servers the app started, and processes left by closed sessions (counted in the total).
          </Text>
        )}
        {v.note !== '' && <Text dimColor>{v.note}</Text>}
      </Box>
    )
  })
}
