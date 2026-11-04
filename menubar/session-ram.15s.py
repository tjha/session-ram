#!/usr/bin/env python3
# <swiftbar.title>Session RAM</swiftbar.title>
# <swiftbar.desc>RAM of each Claude Code desktop session, with the session-ram mod's limit and flags.</swiftbar.desc>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
"""SwiftBar plugin (macOS menu bar) for the session-ram mod.

Measures every Claude Code session the desktop app has loaded (`ps`, whole process tree) and
names it from the app's session files. Working/idle and the Auto stops come from files the
session-ram mod writes in ~/.claude, so they need at least one Claude session running the mod.
The limit and Auto switch live in ~/.claude/session-ram-settings.json, shared with the mod.

Run with `--selftest` to check the process matching.
"""
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
SESSIONS_GLOB = os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions/*/*/*.json")
DEFAULT_LIMIT_MB = 6144
STATUS_FRESH_MS = 60_000


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def settings():
    s = read_json(SETTINGS, {})
    return {"limitMb": int(s.get("limitMb") or DEFAULT_LIMIT_MB), "isAuto": s.get("isAuto") is True}


def parse_ps(out):
    procs = []
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$", line)
        if m:
            procs.append((int(m[1]), int(m[2]), int(m[3]), m[4]))
    return procs


def is_session(cmd):
    """The program itself is claude, started as `claude --output-format ...` (same rule as the mod)."""
    m = re.match(r'^"?(.*?)"?\s+--output-format\b', cmd)
    return bool(m) and not re.search(r"\s-", m[1]) and bool(re.search(r"[\\/]claude(?:\.exe)?$", m[1], re.I))


def session_procs(procs):
    """[(pid, cli_session_id, total_kb, child_kb)] for each session, largest first."""
    kids = {}
    for p in procs:
        if p[0] != p[1]:
            kids.setdefault(p[1], []).append(p)

    def tree_kb(pid, depth=0):
        return 0 if depth > 50 else sum(c[2] + tree_kb(c[0], depth + 1) for c in kids.get(pid, []))

    matched = [p for p in procs if is_session(p[3])]
    pids = {p[0] for p in matched}
    out = []
    for p in matched:
        if any(c[0] in pids for c in kids.get(p[0], [])):
            continue  # a launcher wrapping the real session process
        cli = re.search(r'--(?:resume|session-id)[= ]"?([0-9a-f-]{36})', p[3])
        child = tree_kb(p[0])
        out.append((p[0], cli[1] if cli else None, p[2] + child, child))
    return sorted(out, key=lambda r: -r[2])


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
    """pid -> app session id, read from each session process's environment (names sessions started fresh)."""
    if not pids:
        return {}
    out = subprocess.run(["ps", "-wwE", "-o", "pid=,command=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
    ids = {}
    for line in out.splitlines():
        m = re.match(r"^\s*(\d+)\s.*\bCLAUDE_CODE_HOST_SESSION_ID=(local_[\w-]+)", line)
        if m:
            ids[int(m[1])] = m[2]
    return ids


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
    elif args[0] == "auto":
        s["isAuto"] = not s["isAuto"]
    write_json(SETTINGS, s)


def render():
    out = subprocess.run(["ps", "-axww", "-o", "pid=,ppid=,rss=,command="], capture_output=True, text=True).stdout
    rows = session_procs(parse_ps(out))
    by_cli, titles = session_meta()
    hosts = host_ids([r[0] for r in rows])
    sid_of = {r[0]: hosts.get(r[0]) or by_cli.get(r[1]) for r in rows}
    s = settings()
    status = read_json(STATUS, {})
    now_ms = time.time() * 1000
    is_fresh = now_ms - float(status.get("writtenAt") or 0) < STATUS_FRESH_MS
    working = {r.get("sessionId"): r.get("isWorking") for r in status.get("rows", [])} if is_fresh else {}
    stopped = read_json(STOPPED, {})
    pending = read_json(REQUESTS, {})

    total_mb = sum(r[2] for r in rows) // 1024
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
        if sid in pending:
            label += "  (stopping…)"
        print(f"{label} | length=60{opts}{link}")
        if child_mb > 0:
            print(f"--Child processes: {fmt(child_mb)}")
        if sid:
            print(f"--Open in Claude |{link}")
        if sid and working.get(sid) and sid not in pending:
            print(f"--Stop turn | bash={json.dumps(os.path.abspath(__file__))} param1=stop param2={sid} terminal=false refresh=true")
    print("---")
    me = os.path.abspath(__file__)
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
    rows = session_procs(parse_ps(ps))
    assert [r[0] for r in rows] == [101, 201, 500], rows
    assert rows[0] == (101, "aaaaaaaa-0000-0000-0000-000000000001", 204800 + 512000, 512000), rows[0]
    assert rows[2][1] == "cccccccc-0000-0000-0000-000000000003", rows[2]
    assert clean("a | b") == "a / b"
    assert parse_limit_mb("8") == 8192 and parse_limit_mb(" 8.5 GB ") == 8704 and parse_limit_mb("2048 mb") == 2048
    assert parse_limit_mb("512 MB") is None and parse_limit_mb("lots") is None and parse_limit_mb("") is None
    print("selftest ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        selftest()
    elif len(sys.argv) > 1:
        act(sys.argv[1:])
    else:
        render()
