<#
.SYNOPSIS
  Windows system-tray companion for the session-ram Claude Code mod.

.DESCRIPTION
  Shows the RAM of every Claude Code session the desktop app has loaded (the whole
  process tree of each), in a tray icon by the clock. Click it for the list: each
  session's RAM and status, click a session to open it in Claude, and set the limit
  or the Auto switch.

  Working/idle status and the sessions Auto stopped come from files the session-ram
  mod writes in %USERPROFILE%\.claude, so they need at least one Claude session
  running the mod. The limit and Auto switch live in
  %USERPROFILE%\.claude\session-ram-settings.json, shared with the mod.

  Run with -SelfTest to check the process matching and limit parsing.
#>
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$UserDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$ClaudeDir = Join-Path $UserDir '.claude'
$SettingsPath = Join-Path $ClaudeDir 'session-ram-settings.json'
$StatusPath = Join-Path $ClaudeDir 'session-ram-status.json'
$StoppedPath = Join-Path $ClaudeDir 'session-ram-stopped.json'
$RequestsPath = Join-Path $ClaudeDir 'session-ram-requests.json'
$SessionsRoot = "$env:APPDATA\Claude\claude-code-sessions"
$DefaultLimitMb = 6144
$StatusFreshMs = 60000
# Kept ASCII-only so Windows PowerShell 5.1 reads this file right without a BOM.
$MarkStopped = [char]0x26A0
$MarkWorking = [char]0x25CF
$MarkIdle = [char]0x25CB
$Ellipsis = [char]0x2026

function Read-Json([string]$Path) {
    try {
        if (Test-Path -LiteralPath $Path) { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    } catch { }
    return $null
}

function Write-Json([string]$Path, $Value) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    # WriteAllText writes UTF-8 without a BOM, which the mod's JSON.parse needs.
    [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Compress -Depth 5))
}

function Get-Settings {
    $s = Read-Json $SettingsPath
    $limit = $DefaultLimitMb
    if ($s -and [int]$s.limitMb -gt 0) { $limit = [int]$s.limitMb }
    return @{ limitMb = $limit; isAuto = [bool]($s -and $s.isAuto -eq $true) }
}

function ConvertTo-LimitMb([string]$Text) {
    # A typed limit: "8", "8 GB", "8.5g" or "8192 MB" (a bare number is GB); at least 1 GB. Same rule as the mod.
    $m = [regex]::Match($Text, '^\s*(\d+(?:\.\d+)?)\s*(gb?|mb?)?\s*$', 'IgnoreCase')
    if (-not $m.Success) { return $null }
    $n = [double]::Parse($m.Groups[1].Value, [System.Globalization.CultureInfo]::InvariantCulture)
    $unit = if ($m.Groups[2].Success) { $m.Groups[2].Value.ToLower() } else { 'g' }
    $mb = if ($unit.StartsWith('m')) { $n } else { $n * 1024 }
    if ($mb -lt 1024) { return $null }
    return [int][Math]::Round($mb)
}

function Test-SessionCommand([string]$Cmd) {
    # The program itself is claude.exe, started as `claude.exe --output-format ...` (same rule as the mod).
    $m = [regex]::Match($Cmd, '^"?(.*?)"?\s+--output-format\b')
    if (-not $m.Success) { return $false }
    $exe = $m.Groups[1].Value
    return (-not [regex]::IsMatch($exe, '\s-')) -and [regex]::IsMatch($exe, '[\\/]claude(?:\.exe)?$', 'IgnoreCase')
}

function Get-TreeKb($Kids, [int]$ProcId, [int]$Depth) {
    if ($Depth -gt 50 -or -not $Kids.ContainsKey($ProcId)) { return 0 }
    $sum = 0
    foreach ($c in $Kids[$ProcId]) { $sum += $c.Kb + (Get-TreeKb $Kids $c.ProcId ($Depth + 1)) }
    return $sum
}

function Get-SessionProcs($Procs) {
    # Each session process with the RAM of its whole tree, largest first.
    $kids = @{}
    foreach ($p in $Procs) {
        if ($p.ProcId -ne $p.ParentId) {
            if (-not $kids.ContainsKey($p.ParentId)) { $kids[$p.ParentId] = @() }
            $kids[$p.ParentId] += $p
        }
    }
    $matched = @($Procs | Where-Object { Test-SessionCommand $_.Cmd })
    $isMatched = @{}
    foreach ($m in $matched) { $isMatched[$m.ProcId] = $true }
    $rows = foreach ($m in $matched) {
        # A launcher wrapping the real session process carries the same args: keep the innermost.
        if ($kids.ContainsKey($m.ProcId) -and @($kids[$m.ProcId] | Where-Object { $isMatched.ContainsKey($_.ProcId) }).Count -gt 0) { continue }
        $cli = [regex]::Match($m.Cmd, '--(?:resume|session-id)[= ]"?([0-9a-f-]{36})')
        $child = Get-TreeKb $kids $m.ProcId 0
        [pscustomobject]@{
            ProcId  = $m.ProcId
            Cli     = $(if ($cli.Success) { $cli.Groups[1].Value } else { $null })
            Kb      = $m.Kb + $child
            ChildKb = $child
        }
    }
    return @($rows | Sort-Object Kb -Descending)
}

function Get-Procs {
    Get-CimInstance Win32_Process | ForEach-Object {
        [pscustomobject]@{
            ProcId   = [int]$_.ProcessId
            ParentId = [int]$_.ParentProcessId
            Kb       = [long]($_.WorkingSetSize / 1KB)
            Cmd      = [string]$_.CommandLine
        }
    }
}

function Get-SessionMeta {
    # cli session id -> app session id, and app session id -> title, from the app's session files.
    $byCli = @{}
    $titles = @{}
    if (Test-Path -LiteralPath $SessionsRoot) {
        foreach ($f in Get-ChildItem -LiteralPath $SessionsRoot -Recurse -Depth 2 -Filter '*.json' -File) {
            $d = Read-Json $f.FullName
            if (-not $d -or -not $d.sessionId) { continue }
            $titles[$d.sessionId] = $(if ($d.title) { $d.title } else { $d.sessionId })
            foreach ($k in 'cliSessionId', 'lastAssistantCliSessionId') {
                if ($d.$k) { $byCli[$d.$k] = $d.sessionId }
            }
        }
    }
    return @{ ByCli = $byCli; Titles = $titles }
}

function Get-Snapshot {
    $rows = Get-SessionProcs (Get-Procs)
    # shortcut: sessions started fresh in this app run have no --resume id, and Windows can't read
    # another process's environment, so they show as unknown until resumed.
    if ($null -eq $script:Meta -or @($rows | Where-Object { $_.Cli -and -not $script:Meta.ByCli.ContainsKey($_.Cli) }).Count -gt 0) {
        $script:Meta = Get-SessionMeta
    }
    $settings = Get-Settings
    $status = Read-Json $StatusPath
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $isFresh = [bool]($status -and ($nowMs - [double]$status.writtenAt) -lt $StatusFreshMs)
    $working = @{}
    if ($isFresh) { foreach ($r in $status.rows) { if ($r.sessionId) { $working[$r.sessionId] = $r.isWorking } } }
    $pending = @{}
    $requests = Read-Json $RequestsPath
    if ($requests) { foreach ($p in $requests.PSObject.Properties) { $pending[$p.Name] = $true } }
    $stopped = @{}
    $flags = Read-Json $StoppedPath
    if ($flags) { foreach ($p in $flags.PSObject.Properties) { $stopped[$p.Name] = $true } }

    $items = foreach ($r in $rows) {
        $sid = if ($r.Cli -and $script:Meta.ByCli.ContainsKey($r.Cli)) { $script:Meta.ByCli[$r.Cli] } else { $null }
        $title = if ($sid -and $script:Meta.Titles.ContainsKey($sid)) { $script:Meta.Titles[$sid] } else { "Unknown session (pid $($r.ProcId))" }
        $state = 'unknown'
        if ($sid -and $stopped.ContainsKey($sid)) { $state = 'stopped' }
        elseif ($sid -and $working.ContainsKey($sid)) { $state = $(if ($working[$sid]) { 'working' } else { 'idle' }) }
        [pscustomobject]@{ SessionId = $sid; Title = $title; Mb = [int]($r.Kb / 1024); ChildMb = [int]($r.ChildKb / 1024); State = $state; IsStopping = [bool]($sid -and $pending.ContainsKey($sid)) }
    }
    $items = @($items)
    $total = 0
    foreach ($i in $items) { $total += $i.Mb }
    return [pscustomobject]@{ Items = $items; TotalMb = $total; LimitMb = $settings.limitMb; IsAuto = $settings.isAuto; IsFresh = $isFresh }
}

function Format-Size([int]$Mb) {
    if ($Mb -ge 1024) { return ('{0:0.0} GB' -f ($Mb / 1024)) }
    return "$Mb MB"
}

function Set-LimitMb([int]$Mb) {
    $s = Get-Settings
    $s.limitMb = [Math]::Max(1024, $Mb)
    Write-Json $SettingsPath $s
    Update-Tray
}

function Read-LimitFromUser {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $prompt = 'RAM limit for Claude sessions (for example 8 or 8 GB):'
    $current = '{0:0.#}' -f ((Get-Settings).limitMb / 1024)
    while ($true) {
        $text = [Microsoft.VisualBasic.Interaction]::InputBox($prompt, 'Session RAM', $current)
        if ([string]::IsNullOrWhiteSpace($text)) { return }  # cancelled
        $mb = ConvertTo-LimitMb $text
        if ($null -ne $mb) { Set-LimitMb $mb; return }
        $prompt = 'Use a number of GB, at least 1. RAM limit for Claude sessions:'
    }
}

function Request-Stop([string]$SessionId) {
    # Only a Claude session running the mod can stop a turn: leave it a request (it checks every 3 s).
    $requests = @{}
    $current = Read-Json $RequestsPath
    if ($current) { foreach ($p in $current.PSObject.Properties) { $requests[$p.Name] = $p.Value } }
    $requests[$SessionId] = @{ action = 'stop'; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    Write-Json $RequestsPath $requests
    if (-not $script:Snap.IsFresh) {
        $script:Icon.ShowBalloonTip(5000, 'Session RAM', "No Claude session is running the session-ram mod, so the stop can't happen yet. Open a new Claude session.", 'Info')
    }
    Update-Tray
}

function Switch-Auto {
    $s = Get-Settings
    $s.isAuto = -not $s.isAuto
    Write-Json $SettingsPath $s
    Update-Tray
}

function Update-Tray {
    try {
        $script:Snap = Get-Snapshot
    } catch {
        $script:Icon.Text = 'Session RAM: could not measure'
        return
    }
    $s = $script:Snap
    $flagged = @($s.Items | Where-Object { $_.State -eq 'stopped' }).Count
    $isOver = $s.TotalMb -gt $s.LimitMb
    $script:Icon.Icon = if ($isOver -or $flagged) { [System.Drawing.SystemIcons]::Warning } else { [System.Drawing.SystemIcons]::Information }
    $text = "Claude sessions: $(Format-Size $s.TotalMb) of $(Format-Size $s.LimitMb)"
    $script:Icon.Text = $text.Substring(0, [Math]::Min(63, $text.Length))
    if ($isOver -and -not $script:WasOver) {
        $script:Icon.ShowBalloonTip(5000, 'Session RAM', "Claude sessions use $(Format-Size $s.TotalMb), over your $(Format-Size $s.LimitMb) limit.", 'Warning')
    }
    $script:WasOver = $isOver
}

function Add-Label($Menu, [string]$Text, $Color) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem $Text
    $item.Enabled = $false
    if ($Color) { $item.ForeColor = $Color }
    [void]$Menu.Items.Add($item)
}

function Build-Menu {
    $menu = $script:Menu
    $menu.Items.Clear()
    $s = $script:Snap
    if (-not $s) { Add-Label $menu 'Measuring...' $null; return }
    $red = [System.Drawing.Color]::Firebrick
    $green = [System.Drawing.Color]::ForestGreen
    $flagged = @($s.Items | Where-Object { $_.State -eq 'stopped' }).Count
    $nWorking = @($s.Items | Where-Object { $_.State -eq 'working' }).Count

    Add-Label $menu "$(Format-Size $s.TotalMb) of $(Format-Size $s.LimitMb) limit" $(if ($s.TotalMb -gt $s.LimitMb) { $red })
    Add-Label $menu $(if ($s.IsFresh) { "$($s.Items.Count) sessions in memory, $nWorking working" } else { "$($s.Items.Count) sessions in memory" }) $null
    if ($flagged) { Add-Label $menu "$MarkStopped $flagged stopped for going over the limit. Check before resuming." $red }
    if (-not $s.IsFresh) { Add-Label $menu 'Working/idle unknown: no Claude session running the session-ram mod reported in the last minute' ([System.Drawing.Color]::Gray) }
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    foreach ($it in $s.Items) {
        $mark = switch ($it.State) { 'stopped' { $MarkStopped } 'working' { $MarkWorking } 'idle' { $MarkIdle } default { '-' } }
        $label = "$mark $(Format-Size $it.Mb)  $($it.Title)"
        if ($it.State -eq 'stopped') { $label += '  (stopped: over limit)' }
        if ($it.IsStopping) { $label += "  (stopping$Ellipsis)" }
        if ($label.Length -gt 70) { $label = $label.Substring(0, 69) + $Ellipsis }
        $item = New-Object System.Windows.Forms.ToolStripMenuItem $label
        if ($it.State -eq 'stopped') { $item.ForeColor = $red } elseif ($it.State -eq 'working') { $item.ForeColor = $green }
        if ($it.ChildMb -gt 0) { $item.ToolTipText = "Child processes: $(Format-Size $it.ChildMb)" }
        if ($it.SessionId) {
            $open = New-Object System.Windows.Forms.ToolStripMenuItem 'Open in Claude'
            $open.Tag = "claude://claude.ai/epitaxy/$($it.SessionId)"
            $open.add_Click({ param($sender) Start-Process $sender.Tag })
            [void]$item.DropDownItems.Add($open)
            if ($it.State -eq 'working' -and -not $it.IsStopping) {
                $stop = New-Object System.Windows.Forms.ToolStripMenuItem 'Stop turn'
                $stop.Tag = $it.SessionId
                $stop.add_Click({ param($sender) Request-Stop $sender.Tag })
                [void]$item.DropDownItems.Add($stop)
            }
        }
        [void]$menu.Items.Add($item)
    }
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    $limit = New-Object System.Windows.Forms.ToolStripMenuItem "Limit: $(Format-Size $s.LimitMb)"
    $ask = $limit.DropDownItems.Add("Set limit$Ellipsis")
    $ask.add_Click({ Read-LimitFromUser })
    foreach ($gb in 4, 6, 8, 12, 16) {
        $preset = New-Object System.Windows.Forms.ToolStripMenuItem "$gb GB"
        $preset.Tag = $gb * 1024
        $preset.Checked = ($s.LimitMb -eq $gb * 1024)
        $preset.add_Click({ param($sender) Set-LimitMb $sender.Tag })
        [void]$limit.DropDownItems.Add($preset)
    }
    [void]$menu.Items.Add($limit)

    $auto = New-Object System.Windows.Forms.ToolStripMenuItem $(if ($s.IsAuto) { 'Auto: on' } else { 'Auto: off' })
    $auto.ToolTipText = 'While over the limit, stops the turn of the largest working session and flags it. Never archives.'
    $auto.add_Click({ Switch-Auto })
    [void]$menu.Items.Add($auto)

    $refresh = $menu.Items.Add('Refresh')
    $refresh.add_Click({ Update-Tray })
    $exit = $menu.Items.Add('Exit')
    $exit.add_Click({
            $script:Icon.Visible = $false
            [System.Windows.Forms.Application]::Exit()
        })
}

function Start-Tray {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $created = $false
    $script:Mutex = New-Object System.Threading.Mutex($true, 'Local\SessionRamTray', [ref]$created)
    if (-not $created) { return }  # already running

    $script:Icon = New-Object System.Windows.Forms.NotifyIcon
    $script:Icon.Icon = [System.Drawing.SystemIcons]::Information
    $script:Icon.Text = 'Session RAM'
    $script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
    $script:Menu.add_Opening({ Build-Menu })
    $script:Icon.ContextMenuStrip = $script:Menu
    # A left click opens the same menu as a right click.
    $script:Icon.add_MouseUp({
            param($sender, $e)
            if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
                $show = [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
                $show.Invoke($script:Icon, $null)
            }
        })
    $script:Icon.Visible = $true
    $script:WasOver = $false

    $script:Timer = New-Object System.Windows.Forms.Timer
    $script:Timer.Interval = 15000
    $script:Timer.add_Tick({ Update-Tray })
    $script:Timer.Start()
    Update-Tray
    [System.Windows.Forms.Application]::Run()
}

function Invoke-SelfTest {
    function Assert($Condition, [string]$What) { if (-not $Condition) { throw "selftest failed: $What" } }
    $exe = '"C:\Users\x\AppData\Local\AnthropicClaude\claude-code\2.1.317\claude.exe" --output-format stream-json --verbose'
    $procs = @(
        [pscustomobject]@{ ProcId = 4; ParentId = 0; Kb = 1; Cmd = '' }
        [pscustomobject]@{ ProcId = 500; ParentId = 4; Kb = 307200; Cmd = "$exe --resume=aaaaaaaa-0000-0000-0000-000000000001" }
        [pscustomobject]@{ ProcId = 501; ParentId = 500; Kb = 409600; Cmd = 'node.exe eslint.js' }
        [pscustomobject]@{ ProcId = 600; ParentId = 4; Kb = 102400; Cmd = "$exe --resume=bbbbbbbb-0000-0000-0000-000000000002" }
        [pscustomobject]@{ ProcId = 700; ParentId = 4; Kb = 2048; Cmd = 'cmd.exe /c findstr "claude.exe --output-format" log.txt' }
        [pscustomobject]@{ ProcId = 800; ParentId = 4; Kb = 1024; Cmd = "C:\Windows\System32\cmd.exe /c $exe --session-id=cccccccc-0000-0000-0000-000000000003" }
        [pscustomobject]@{ ProcId = 801; ParentId = 800; Kb = 51200; Cmd = "$exe --session-id=cccccccc-0000-0000-0000-000000000003" }
    )
    $rows = Get-SessionProcs $procs
    Assert (($rows.ProcId -join ',') -eq '500,600,801') "sessions found: $($rows.ProcId -join ',')"
    Assert ($rows[0].Kb -eq 716800 -and $rows[0].ChildKb -eq 409600) 'tree RAM'
    Assert ($rows[0].Cli -eq 'aaaaaaaa-0000-0000-0000-000000000001') 'resume id'
    Assert ($rows[2].Cli -eq 'cccccccc-0000-0000-0000-000000000003') 'session id'
    Assert ((ConvertTo-LimitMb '8') -eq 8192) 'limit 8'
    Assert ((ConvertTo-LimitMb ' 8.5 GB ') -eq 8704) 'limit 8.5 GB'
    Assert ((ConvertTo-LimitMb '2048 mb') -eq 2048) 'limit 2048 mb'
    Assert ($null -eq (ConvertTo-LimitMb '512 MB')) 'limit under 1 GB'
    Assert ($null -eq (ConvertTo-LimitMb 'lots')) 'limit text'
    Assert ((Format-Size 1536) -eq '1.5 GB' -or (Format-Size 1536) -eq '1,5 GB') 'format'

    # The snapshot end to end, on the same processes, with the shared files in a temp folder.
    # Functions and variables defined here shadow the script's for the calls below.
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('session-ram-test-' + [guid]::NewGuid())
    try {
        $SessionsRoot = Join-Path $tmp 'sessions'
        $ClaudeDir = Join-Path $tmp 'claude'
        $SettingsPath = Join-Path $ClaudeDir 'session-ram-settings.json'
        $StatusPath = Join-Path $ClaudeDir 'session-ram-status.json'
        $StoppedPath = Join-Path $ClaudeDir 'session-ram-stopped.json'
        $RequestsPath = Join-Path $ClaudeDir 'session-ram-requests.json'
        $acct = Join-Path (Join-Path $SessionsRoot 'org') 'acct'
        Write-Json (Join-Path $acct 'local_a.json') @{ sessionId = 'local_a'; title = 'Busy lint session'; cliSessionId = 'aaaaaaaa-0000-0000-0000-000000000001' }
        Write-Json (Join-Path $acct 'local_b.json') @{ sessionId = 'local_b'; title = 'Idle session'; cliSessionId = 'bbbbbbbb-0000-0000-0000-000000000002' }
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        Write-Json $StatusPath @{ writtenAt = $now; rows = @(@{ sessionId = 'local_a'; isWorking = $true }, @{ sessionId = 'local_b'; isWorking = $false }) }
        Write-Json $StoppedPath @{ local_b = @{ at = $now; mb = 100; title = 'Idle session' } }
        Write-Json $SettingsPath @{ limitMb = 600; isAuto = $false }
        Assert ([System.IO.File]::ReadAllBytes($SettingsPath)[0] -eq [byte][char]'{') 'settings written without a BOM'
        function Get-Procs { $procs }
        function Update-Tray { }
        $script:Meta = $null
        $snap = Get-Snapshot
        Assert ($snap.TotalMb -eq 850 -and $snap.LimitMb -eq 600 -and $snap.IsFresh) "snapshot totals: $($snap.TotalMb) of $($snap.LimitMb), fresh $($snap.IsFresh)"
        Assert (($snap.Items.State -join ',') -eq 'working,stopped,unknown') "states: $($snap.Items.State -join ',')"
        Assert ($snap.Items[0].Title -eq 'Busy lint session' -and $snap.Items[0].SessionId -eq 'local_a') 'title from session file'
        $script:Snap = $snap
        Request-Stop 'local_a'
        $req = Read-Json $RequestsPath
        Assert ($req.local_a.action -eq 'stop') 'stop request written'
        Assert ((Get-Snapshot).Items[0].IsStopping) 'pending stop shown'
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    'selftest ok'
}

if ($SelfTest) { Invoke-SelfTest } else { Start-Tray }
