#!/usr/bin/env python3
# <swiftbar.title>Session RAM</swiftbar.title>
# <swiftbar.desc>RAM of each Claude Code desktop session, with the session-ram mod's limit and flags.</swiftbar.desc>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
"""SwiftBar plugin (macOS menu bar) for the session-ram mod.

Measures every Claude Code session the desktop app has loaded (`ps`, whole process tree, each
process's memory footprint as Activity Monitor shows it) and names it from the app's session files. Working/idle and the Auto stops come from files the
session-ram mod writes in ~/.claude, so they need at least one Claude session running the mod.
The limit and Auto switch live in ~/.claude/session-ram-settings.json, shared with the mod.

Run with `--selftest` to check the process matching.
"""
import ctypes
import glob
import json
import os
import re
import subprocess
import sys
import time

CLAUDE_DIR = os.path.expanduser("~/.claude")
SETTINGS = os.path.join(CLAUDE_DIR, "session-ram-settings.json")
STATUS = os.path.join(CLAUDE_DIR, "session-ram-status.json")
STOPPED = os.path.join(CLAUDE_DIR, "session-ram-stopped.json")
STATE = os.path.join(CLAUDE_DIR, "session-ram-menubar-state.json")
REQUESTS = os.path.join(CLAUDE_DIR, "session-ram-requests.json")
AUTOFIX = os.path.join(CLAUDE_DIR, "session-ram-autofix.json")
AUTOFIX_STALE_MS = 10 * 60_000
# Session files are local_<id>.json; the app keeps other files there too (mod-commands.json is a list).
SESSIONS_GLOB = os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json")
DEFAULT_LIMIT_MB = 6144
STATUS_FRESH_MS = 60_000


def read_json(path, default):
    """The file's JSON, or `default` when it's missing, unreadable, or not the same kind (dict, list) as `default`."""
    try:
        with open(path) as f:
            value = json.load(f)
    except (OSError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


def write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def settings():
    """The shared settings, keeping any keys this script doesn't know so a write never drops them."""
    s = read_json(SETTINGS, {})
    s = s if isinstance(s, dict) else {}
    s["limitMb"] = int(s.get("limitMb") or DEFAULT_LIMIT_MB)
    s["isAuto"] = s.get("isAuto") is True
    s["autoOpenPanel"] = s.get("autoOpenPanel") is not False
    return s


def parse_ps(out):
    procs = []
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$", line)
        if m:
            procs.append((int(m[1]), int(m[2]), int(m[3]), m[4]))
    return procs


class RusageInfoV2(ctypes.Structure):
    """<sys/resource.h> rusage_info_v2: ri_uuid, then 26 uint64 counters; ri_phys_footprint is the 8th."""
    _fields_ = [("uuid", ctypes.c_uint8 * 16), ("before", ctypes.c_uint64 * 7), ("phys_footprint", ctypes.c_uint64), ("after", ctypes.c_uint64 * 10)]


def footprints(pids):
    """pid -> memory footprint in KB, what Activity Monitor shows. Unlike ps's RSS it includes memory macOS
    compressed, often half of an idle session's. Missing for processes this user can't inspect."""
    try:
        lib = ctypes.CDLL("/usr/lib/libproc.dylib")
    except OSError:
        return {}
    out = {}
    for pid in pids:
        info = RusageInfoV2()
        if lib.proc_pid_rusage(pid, 2, ctypes.byref(info)) == 0:  # 2: RUSAGE_INFO_V2
            out[pid] = info.phys_footprint // 1024
    return out


def with_footprints(procs):
    """The ps rows with RSS replaced by the footprint where it can be read."""
    fp = footprints([p[0] for p in procs])
    return [(pid, ppid, fp.get(pid, kb), cmd) for pid, ppid, kb, cmd in procs]


def is_session(cmd):
    """The program itself is claude, started as `claude --output-format ...` (same rule as the mod)."""
    m = re.match(r'^"?(.*?)"?\s+--output-format\b', cmd)
    return bool(m) and not re.search(r"\s-", m[1]) and bool(re.search(r"[\\/]claude(?:\.exe)?$", m[1], re.I))


def session_procs(procs):
    """Same rules as the mod's sessionProcs:
    - [(pid, cli_session_id, total_kb, child_kb)] for each session, largest first;
    - [(pid, kb, command)] the app started through its launcher (preview dev servers, MCP servers);
    - [(pid, kb, command)] under launchd (pid 1): build and test processes that detached (`&`, nohup,
      daemons) are among them, and their environment names the session that started them."""
    kids = {}
    for p in procs:
        if p[0] != p[1]:
            kids.setdefault(p[1], []).append(p)
    counted = set()  # each process counts once

    def tree_kb(pid, depth=0):
        total = 0
        for c in kids.get(pid, []) if depth <= 50 else []:
            if c[0] not in counted:
                counted.add(c[0])
                total += c[2] + tree_kb(c[0], depth + 1)
        return total

    def own_kb(p):
        counted.add(p[0])
        return p[2] + tree_kb(p[0])

    matched = [p for p in procs if is_session(p[3])]
    pids = {p[0] for p in matched}

    def is_wrapper(p):
        return any(c[0] in pids for c in kids.get(p[0], []))

    out = []
    for p in matched:
        if is_wrapper(p):
            continue  # a launcher wrapping the real session process
        cli = re.search(r'--(?:resume|session-id)[= ]"?([0-9a-f-]{36})', p[3])
        counted.add(p[0])
        child = tree_kb(p[0])
        out.append((p[0], cli[1] if cli else None, p[2] + child, child))
    app = []
    for p in procs:
        if re.search(r"[\\/]Helpers[\\/]disclaimer\b", p[3]) and not is_wrapper(p) and p[0] not in counted:
            app.append((p[0], own_kb(p), p[3]))
    detached = [(p[0], own_kb(p), p[3]) for p in procs if p[1] == 1 and p[0] not in counted]
    return sorted(out, key=lambda r: -r[2]), app, detached


def session_meta():
    """({cli session id: app session id}, {app session id: title}) from the app's session files."""
    by_cli, titles = {}, {}
    for path in glob.glob(SESSIONS_GLOB):
        d = read_json(path, {})
        sid = d.get("sessionId")
        if not isinstance(sid, str):
            continue
        titles[sid] = d.get("title") or sid
        for key in ("cliSessionId", "lastAssistantCliSessionId"):
            if isinstance(d.get(key), str):
                by_cli[d[key]] = sid
    return by_cli, titles


def host_ids(pids):
    """pid -> app session id, read from each process's environment: names sessions started fresh, and the
    session a detached build or test process came from (it inherits the variable)."""
    if not pids:
        return {}
    out = subprocess.run(["ps", "-wwE", "-o", "pid=,command=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
    ids = {}
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\s.*\bCLAUDE_CODE_HOST_SESSION_ID=(local_[\w-]+)", line)
        if m:
            ids[int(m[1])] = m[2]
    return ids


def short_cmd(cmd):
    """`node server.js` for `/opt/homebrew/bin/node server.js`, without the app's launcher prefix."""
    cmd = re.sub(r"^.*?[\\/]Helpers[\\/]disclaimer\b.*? -- ", "", cmd)
    return re.sub(r"^\S*[\\/]", "", cmd)[:50]


def fmt(mb):
    return f"{mb / 1024:.1f} GB" if mb >= 1024 else f"{mb} MB"


def clean(text):
    # SwiftBar reads "|" as the start of a line's parameters.
    return text.replace("|", "/")


def notify(text):
    subprocess.run(["osascript", "-e", f"display notification {json.dumps(text)} with title \"Session RAM\""], check=False)


def parse_limit_mb(text):
    """A typed limit: "8", "8 GB", "8.5g" or "8192 MB" (a bare number is GB); at least 1 GB. Same rule as the mod."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(gb?|mb?)?\s*$", text, re.I)
    if not m:
        return None
    mb = float(m[1]) if (m[2] or "g").lower().startswith("m") else float(m[1]) * 1024
    return round(mb) if mb >= 1024 else None


def ask_limit(current_mb):
    script = (
        f'display dialog "RAM limit for Claude sessions (for example 8 or 8 GB):" '
        f'default answer "{current_mb / 1024:g}" with title "Session RAM"'
    )
    while True:
        r = subprocess.run(["osascript", "-e", script, "-e", "text returned of result"], capture_output=True, text=True)
        if r.returncode != 0:
            return None  # cancelled
        mb = parse_limit_mb(r.stdout)
        if mb is not None:
            return mb
        script = script.replace("RAM limit for", "Use a number of GB, at least 1. RAM limit for", 1)


def act(args):
    s = settings()
    if args[0] == "limit":
        s["limitMb"] = max(1024, s["limitMb"] + int(args[1]))
    elif args[0] == "limit-set":
        s["limitMb"] = max(1024, int(args[1]))
    elif args[0] == "limit-ask":
        mb = ask_limit(s["limitMb"])
        if mb is None:
            return
        s["limitMb"] = mb
    elif args[0] == "stop":
        # Only a Claude session running the mod can stop a turn: leave it a request (it checks every 3 s).
        requests = read_json(REQUESTS, {})
        requests[args[1]] = {"action": "stop", "at": time.time() * 1000}
        write_json(REQUESTS, requests)
        status = read_json(STATUS, {})
        if time.time() * 1000 - float(status.get("writtenAt") or 0) > STATUS_FRESH_MS:
            notify("No Claude session is running the session-ram mod, so the stop can't happen yet. Open a new Claude session.")
        return
    elif args[0] == "autofix-off":
        # Only the session itself can switch off its PR's Auto-fix; the mod in it does so once it runs
        # (within seconds if it's loaded). "all": every session the last Auto-fix check found.
        ids = [a.get("sessionId") for a in read_json(AUTOFIX, {}).get("sessions") or []] if args[1] == "all" else [args[1]]
        ids = [i for i in ids if isinstance(i, str)]
        requests = read_json(REQUESTS, {})
        for sid in ids:
            requests[f"autofix-off:{sid}"] = {"action": "autofix-off", "session": sid, "at": time.time() * 1000}
        write_json(REQUESTS, requests)
        what = "that session" if len(ids) == 1 else f"each of the {len(ids)} sessions"
        notify(f"Auto-fix turns off for {what}: right away if it's loaded, otherwise the next time it runs. Claude may ask you to approve it there.")
        return
    elif args[0] == "panel":
        s["autoOpenPanel"] = not s["autoOpenPanel"]
    elif args[0] == "auto":
        s["isAuto"] = not s["isAuto"]
    write_json(SETTINGS, s)


def autofix_lines(autofix, working, loaded, pending_af, titles, now_ms, me):
    """The Auto-fix section: open PRs whose session Auto-fix can wake, and whether each is running now."""
    checked_at = float(autofix.get("checkedAt") or 0)
    if not checked_at or now_ms - checked_at > AUTOFIX_STALE_MS:
        return ["Auto-fix: not checked yet (needs a Claude session running the mod) | color=gray"]
    if autofix.get("checked") and autofix.get("errors") == autofix.get("checked"):
        return ["Auto-fix: couldn't read PR status | color=gray"]
    found = autofix.get("sessions") or []
    age = max(0, int((now_ms - checked_at) // 60_000))
    when = "just now" if age == 0 else f"{age} min ago"
    n_running = sum(1 for a in found if working.get(a["sessionId"]))
    head = f"Auto-fix on: {len(found)} open PR{'' if len(found) == 1 else 's'}" + (f", {n_running} running now" if n_running else "")
    lines = [f"{head} (checked {when}){' | color=orange' if n_running > 1 else ''}"]
    n_left = sum(1 for a in found if a["sessionId"] not in pending_af)
    if n_left > 1:
        lines.append(f"--Turn off Auto-fix for all {n_left} | bash={json.dumps(me)} param1=autofix-off param2=all terminal=false refresh=true")
        lines.append("-----")
    for a in found:
        sid = a["sessionId"]
        if working.get(sid):
            mark, opts = "●", " color=green"
        elif sid in loaded:
            mark, opts = "○", ""
        else:
            mark, opts = "·", ""
        if a.get("isCiKnown") is False:
            ci = "CI: unknown"
        else:
            ci = f"CI: {a['failing']} failing" if a.get("failing") else ("CI: running" if a.get("pending") else "CI: passing")
        title = clean(titles.get(sid) or a.get("title") or sid)
        lines.append(f"--{mark} #{a['pr']}  {title}  ({ci}) | length=70{opts}")
        lines.append(f"----Open PR | href={a['url']}")
        lines.append(f"----Open in Claude | href=claude://claude.ai/epitaxy/{sid}")
        if sid in pending_af:
            lines.append("----Turning off… (when the session next runs)")
        else:
            lines.append(f"----Turn off Auto-fix | bash={json.dumps(me)} param1=autofix-off param2={sid} terminal=false refresh=true")
    return lines


def render():
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,rss=,command="], capture_output=True, text=True).stdout
    rows, other, detached = session_procs(with_footprints(parse_ps(out)))
    by_cli, titles = session_meta()
    hosts = host_ids([r[0] for r in rows] + [d[0] for d in detached])
    sid_of = {r[0]: hosts.get(r[0]) or by_cli.get(r[1]) for r in rows}
    # A detached process counts with the loaded session that started it; one from a closed session counts as other.
    extra = {}
    for pid, kb, cmd in detached:
        sid = hosts.get(pid)
        if sid and sid in sid_of.values():
            extra[sid] = extra.get(sid, 0) + kb
        elif sid:
            other.append((pid, kb, cmd))
    rows = sorted(((pid, cli, kb + extra.get(sid_of[pid], 0), child + extra.get(sid_of[pid], 0)) for pid, cli, kb, child in rows), key=lambda r: -r[2])
    other_mb = sum(o[1] for o in other) // 1024
    s = settings()
    status = read_json(STATUS, {})
    now_ms = time.time() * 1000
    is_fresh = now_ms - float(status.get("writtenAt") or 0) < STATUS_FRESH_MS
    working = {r.get("sessionId"): r.get("isWorking") for r in status.get("rows", [])} if is_fresh else {}
    stopped = read_json(STOPPED, {})
    pending = read_json(REQUESTS, {})
    pending_af = {r.get("session") for r in pending.values() if isinstance(r, dict) and r.get("action") == "autofix-off"}
    autofix = read_json(AUTOFIX, {})
    on_autofix = {a.get("sessionId") for a in autofix.get("sessions") or []}

    total_mb = (sum(r[2] for r in rows) + sum(o[1] for o in other)) // 1024
    limit_mb = s["limitMb"]
    is_over = total_mb > limit_mb
    n_working = sum(1 for r in rows if working.get(sid_of[r[0]]))
    flagged = [r for r in rows if sid_of[r[0]] in stopped]

    # Notify once each time usage crosses the limit.
    state = read_json(STATE, {})
    if is_over and not state.get("wasOver"):
        notify(f"Claude sessions use {fmt(total_mb)}, over your {fmt(limit_mb)} limit.")
    if bool(state.get("wasOver")) != is_over:
        write_json(STATE, {"wasOver": is_over})

    color = " color=red" if is_over or flagged else ""
    print(f"{'⚠ ' if flagged else ''}{fmt(total_mb)} | sfimage=memorychip{color}")
    print("---")
    print(f"{fmt(total_mb)} of {fmt(limit_mb)} limit{color and ' | color=red'}")
    print(f"{len(rows)} sessions in memory, {n_working} working" if working else f"{len(rows)} sessions in memory")
    if flagged:
        print(f"⚠ {len(flagged)} stopped for going over the limit. Check before resuming. | color=red")
    if not is_fresh:
        print("Working/idle unknown: no Claude session running the session-ram mod reported in the last minute | color=gray size=11")
    print("---")
    for pid, cli, kb, child_kb in rows:
        sid = sid_of[pid]
        title = titles.get(sid) or f"Unknown session (pid {pid})"
        mb, child_mb = kb // 1024, child_kb // 1024
        if sid in stopped:
            mark, opts = "⚠", " color=red"
        elif working.get(sid):
            mark, opts = "●", " color=green"
        elif sid in working:
            mark, opts = "○", ""
        else:
            mark, opts = "·", ""
        link = f" href=claude://claude.ai/epitaxy/{sid}" if sid else ""
        label = f"{mark} {fmt(mb)}  {clean(title)}" + ("  (stopped: over limit)" if sid in stopped else "")
        if sid in on_autofix:
            label += "  ↻ Auto-fix"
        if sid in pending:
            label += "  (stopping…)"
        print(f"{label} | length=60{opts}{link}")
        if child_mb > 0:
            print(f"--Child processes: {fmt(child_mb)}")
        if sid:
            print(f"--Open in Claude |{link}")
        if sid and working.get(sid) and sid not in pending:
            print(f"--Stop turn | bash={json.dumps(os.path.abspath(__file__))} param1=stop param2={sid} terminal=false refresh=true")
    if other_mb > 0:
        print(f"· {fmt(other_mb)}  Dev servers, MCP servers, leftovers | length=60")
        print("--Started by the app, or left running by sessions since closed. Counted in the total. | size=11")
        for pid, kb, cmd in sorted(other, key=lambda o: -o[1])[:8]:
            print(f"--{fmt(kb // 1024)}  {clean(short_cmd(cmd))}  (pid {pid}) | length=60")
    me = os.path.abspath(__file__)
    print("---")
    for line in autofix_lines(autofix, working, set(sid_of.values()), pending_af, titles, now_ms, me):
        print(line)
    print("---")
    print(f"Limit: {fmt(limit_mb)}")
    print(f"--Set limit… | bash={json.dumps(me)} param1=limit-ask terminal=false refresh=true")
    for gb in (4, 6, 8, 12, 16):
        check = " checked=true" if limit_mb == gb * 1024 else ""
        print(f"--{gb} GB | bash={json.dumps(me)} param1=limit-set param2={gb * 1024} terminal=false refresh=true{check}")
    print("-----")
    print(f"--Raise by 1 GB | bash={json.dumps(me)} param1=limit param2=1024 terminal=false refresh=true")
    print(f"--Lower by 1 GB | bash={json.dumps(me)} param1=limit param2=-1024 terminal=false refresh=true")
    print(f"Auto: {'on' if s['isAuto'] else 'off'} | bash={json.dumps(me)} param1=auto terminal=false refresh=true")
    print("--While over the limit, stops the turn of the largest working session and flags it. Never archives. | size=11")
    print(f"Open panel when a session starts: {'on' if s['autoOpenPanel'] else 'off'} | bash={json.dumps(me)} param1=panel terminal=false refresh=true")
    print("Refresh | refresh=true")


def selftest():
    claude = "/x/claude.app/Contents/MacOS/claude --output-format stream-json --verbose"
    ps = "\n".join([
        f" 100 1 1024 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- {claude} --resume=aaaaaaaa-0000-0000-0000-000000000001",
        f" 101 100 204800 {claude} --resume=aaaaaaaa-0000-0000-0000-000000000001",
        " 102 101 512000 node eslint.js",
        f" 201 1 102400 {claude} --resume=bbbbbbbb-0000-0000-0000-000000000002",
        " 400 1 2048 /bin/zsh -c ps -axo command | grep '[M]acOS/claude --output-format'",
        ' 500 1 4096 "C:\\Users\\x\\claude.exe" --output-format stream-json --session-id=cccccccc-0000-0000-0000-000000000003',
    ])
    rows, app, detached = session_procs(parse_ps(ps + "\n" + "\n".join([
        " 600 1 307200 /opt/homebrew/bin/node next dev",
        " 601 600 102400 /opt/homebrew/bin/node worker.js",
        " 700 2 1024 /Applications/Claude.app/Contents/Helpers/disclaimer -- /opt/homebrew/bin/node server.js",
        " 701 700 51200 /opt/homebrew/bin/node server.js",
    ])))
    assert app == [(700, 1024 + 51200, "/Applications/Claude.app/Contents/Helpers/disclaimer -- /opt/homebrew/bin/node server.js")], app
    assert (600, 307200 + 102400, "/opt/homebrew/bin/node next dev") in detached, detached
    assert not any(d[0] in (101, 102, 201, 500, 601, 701) for d in detached), detached
    assert short_cmd(app[0][2]) == "node server.js" and short_cmd("/opt/homebrew/bin/node next dev") == "node next dev"
    assert [r[0] for r in rows] == [101, 201, 500], rows
    assert rows[0] == (101, "aaaaaaaa-0000-0000-0000-000000000001", 204800 + 512000, 512000), rows[0]
    assert rows[2][1] == "cccccccc-0000-0000-0000-000000000003", rows[2]
    me_fp = footprints([os.getpid()]).get(os.getpid(), 0)
    assert me_fp > 1024, me_fp  # this Python process: a few MB
    assert with_footprints([(999999, 1, 77, "gone")]) == [(999999, 1, 77, "gone")]  # unreadable: RSS stays
    assert clean("a | b") == "a / b"
    assert parse_limit_mb("8") == 8192 and parse_limit_mb(" 8.5 GB ") == 8704 and parse_limit_mb("2048 mb") == 2048
    global SETTINGS
    real, SETTINGS = SETTINGS, os.path.join(os.environ.get("TMPDIR", "/tmp"), f"session-ram-selftest-{os.getpid()}.json")
    try:
        write_json(SETTINGS, {"limitMb": 8192, "futureKey": 1})
        act(["panel"])
        act(["limit-set", "4096"])
        saved = read_json(SETTINGS, {})
        assert saved == {"limitMb": 4096, "isAuto": False, "autoOpenPanel": False, "futureKey": 1}, saved
    finally:
        os.remove(SETTINGS)
        SETTINGS = real
    now = 10_000_000
    af = {"checkedAt": now - 120_000, "checked": 3, "errors": 0, "sessions": [
        {"sessionId": "local_a", "title": "A", "pr": 11, "url": "https://x/11", "failing": 2, "pending": 0},
        {"sessionId": "local_b", "title": "B", "pr": 12, "url": "https://x/12", "failing": 0, "pending": 3}]}
    lines = autofix_lines(af, {"local_a": True}, {"local_a"}, {"local_b"}, {}, now, "/me")
    assert lines[0] == "Auto-fix on: 2 open PRs, 1 running now (checked 2 min ago)", lines[0]
    assert lines[1] == "--● #11  A  (CI: 2 failing) | length=70 color=green", lines[1]
    assert "param1=autofix-off param2=local_a" in lines[4], lines[4]
    assert lines[5].startswith("--· #12  B  (CI: running)") and lines[8] == "----Turning off… (when the session next runs)", lines
    assert autofix_lines({}, {}, set(), set(), {}, now, "/me")[0].startswith("Auto-fix: not checked yet")
    lines = autofix_lines(af, {}, set(), set(), {}, now, "/me")
    assert lines[1] == '--Turn off Auto-fix for all 2 | bash="/me" param1=autofix-off param2=all terminal=false refresh=true', lines[1]
    global REQUESTS, AUTOFIX, notify
    saved_paths = REQUESTS, AUTOFIX, notify
    tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"session-ram-selftest-{os.getpid()}")
    REQUESTS, AUTOFIX, notify = tmp + "-requests.json", tmp + "-autofix.json", lambda text: None
    try:
        write_json(REQUESTS, {"local_x": {"action": "stop", "at": 1}})
        write_json(AUTOFIX, af)
        act(["autofix-off", "all"])
        queued = read_json(REQUESTS, {})
        assert sorted(queued) == ["autofix-off:local_a", "autofix-off:local_b", "local_x"], queued
        assert queued["autofix-off:local_b"]["session"] == "local_b" and queued["autofix-off:local_b"]["action"] == "autofix-off"
    finally:
        for path in (REQUESTS, AUTOFIX):
            os.remove(path)
        REQUESTS, AUTOFIX, notify = saved_paths
    odd = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"session-ram-selftest-list-{os.getpid()}.json")
    write_json(odd, [{"folder": "/x"}])
    try:
        assert read_json(odd, {}) == {}, "a list where an object belongs reads as the default"
    finally:
        os.remove(odd)
    assert parse_limit_mb("512 MB") is None and parse_limit_mb("lots") is None and parse_limit_mb("") is None
    print("selftest ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        selftest()
    elif len(sys.argv) > 1:
        act(sys.argv[1:])
    else:
        render()
