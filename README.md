# Session RAM

<img src="docs/screenshot.png" alt="The Session RAM panel: total RAM against a 6 GB limit, limit and Auto buttons, then one row per session with its RAM, working or idle status, and a Stop turn or Archive button" width="300">

*The panel, shown with sample sessions.*

A Claude Code mod for the Claude desktop app on macOS and Windows. It opens a **Session RAM** panel beside each Code session and shows:

- every Claude Code session currently loaded in memory, largest first
- how much RAM each one uses, counting its child processes (lint, tsc, dev servers)
- whether it is **working** or **idle**
- a **Stop turn** button for working sessions and an **Archive** button for idle ones

It also has a RAM limit (default 6 GB, change it with **− 1 GB / + 1 GB**). Going over the limit shows a toast. With **Auto** on, the panel archives the largest idle session each refresh until usage is back under the limit; working sessions and the session showing the panel are never archived. Auto is off by default.

The mod cannot hard-cap a process's RAM, so the limit is a warning plus optional archiving, not a hard cap.

## Install

At the prompt of a terminal session:

```
/plugin marketplace add tjha/session-ram
/plugin install session-ram@session-ram
```

From a shell:

```bash
claude plugin marketplace add tjha/session-ram
claude plugin install session-ram@session-ram
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `tjha/session-ram`, then Add plugin.

Installed at the user scope, the mod loads in every Code session the desktop app starts. Type `/session-ram` to reopen the panel after closing it.

## Notes

- Refreshes every 15 seconds. Each session with the mod runs its own refresh: one process listing (`ps` on macOS, a PowerShell `Get-CimInstance Win32_Process` query on Windows) plus one lookup per loaded session.
- Archiving a session stops its process and, by default, removes its worktree; the app keeps a worktree with uncommitted changes. Archived sessions can be restored from the Archived list.
- The limit and the Auto setting are shared by all sessions.
- Session names come from the desktop app's files under `~/Library/Application Support/Claude/claude-code-sessions` (macOS) or `%APPDATA%\Claude\claude-code-sessions` (Windows); working/idle status and the buttons use the app's own session tools, so they work only inside the desktop app.
- Windows support is checked with sample data only, not yet on a Windows machine. If the panel says "Could not measure" there, please open an issue with that line.
