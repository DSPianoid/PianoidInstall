<#
.SYNOPSIS
    Identify and kill the full Pianoid dev stack (frontend, launcher, backend, modal adapter).

.DESCRIPTION
    Standalone ops utility. Finds Pianoid processes by (a) listening on one of the
    Pianoid ports 3000/3001/5000/5001, and/or (b) a command line containing a Pianoid
    marker (the four script names, server/launcher.js, react-scripts / concurrently
    invoked from the Pianoid frontend, or the repo path). It then kills the matched
    process *trees* (taskkill /F /T) so nothing respawns, and re-checks the ports.

    Agent leftovers (2026-10-10): worktree CRA dev servers on spare ports 3002-3020 and
    worktree/isolated backends on 5002-5020 are caught by the marker pass (a wt-* worktree
    path + a dev-server shape, or backendServer.py). Spare-port listeners and processes
    holding pianoidCuda*.pyd (build holders) are REPORTED in every run; a foreign spare-port
    listener and a non-server .pyd holder (a live agent's harness) are never killed here.

    The Pianoid stack runs under a supervisor tree:

        cmd.exe (user shell -- DO NOT KILL)
          `- npm run dev
               `- node ...concurrently... "node server/launcher.js" "react-scripts start"
                    |- node server/launcher.js            (launcher, port 3001)
                    |    |- python -u backendServer.py     (backend, port 5000)   [spawned on APPLY]
                    |    `- python -u modal_adapter_server.py (modal adapter, 5001) [on demand]
                    `- node ...react-scripts start         (CRA dev server, port 3000)
                         `- node ...webpack dev server child

    Killing only a LEAF (the CRA node or the launcher node) does NOT work: react-scripts
    respawns the webpack child and `concurrently` respawns a dead child. So we kill the
    TREE at the supervisor (the `concurrently` node process -- identified by its Pianoid
    "server/launcher.js" + "react-scripts" command line) with taskkill /F /T. We do NOT
    walk up to or touch the parent cmd.exe / powershell.exe (the user's shell). The two
    python backends are also killed by port + marker in case they were orphaned or started
    standalone outside the launcher.

    SAFE EXCLUSIONS (never matched): the user's interactive shell (cmd.exe / powershell.exe),
    VS Code (Code.exe + its node helpers), Claude Code, MCP servers (bun.exe + any node/python
    whose command line does NOT contain a Pianoid marker, e.g. whatsapp-mcp `main.py`,
    mcp-mail-server, context7-mcp, chrome-devtools-mcp, workspace-mcp), and the user's Chrome.
    Matching is anchored strictly to Pianoid markers -- a generic node/python process that
    cannot be positively tied to Pianoid is left alone.

.PARAMETER DryRun
    Preview only. Lists what WOULD be killed (PID, name, port, why-matched) and does not
    kill anything. Use this first -- it is the safe preview. (-WhatIf is accepted as an alias.)

.EXAMPLE
    # Safe preview -- shows what would be killed, kills nothing:
    powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1 -DryRun

.EXAMPLE
    # Real run -- kills the matched trees, re-checks ports, retries stragglers once:
    powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1

.NOTES
    Windows / PowerShell. Never blanket-kills node.exe or python.exe (that has killed MCP
    servers and Claude Code before). Port-targeted + marker-pattern only.

    Linux equivalent (the stack runs the same four ports there):
        # preview
        for p in 3000 3001 5000 5001; do fuser $p/tcp 2>/dev/null; done
        pgrep -af 'backendServer.py|modal_adapter_server.py|server/launcher.js|react-scripts|concurrently.*launcher.js'
        # kill
        pkill -TERM -f 'backendServer.py|modal_adapter_server.py|server/launcher.js|react-scripts'
        pkill -TERM -f 'concurrently.*server/launcher.js'   # the supervisor (kills its children)
        for p in 3000 3001 5000 5001; do fuser -k $p/tcp 2>/dev/null; done
#>

[CmdletBinding()]
param(
    [Alias('WhatIf')]
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PianoidPorts = @(3000, 3001, 5000, 5001)

# Agent SPARE ports (worktree CRA dev servers 3002-3020, worktree / isolated backends 5002-5020).
# NOT killed by port (a foreign app may own one) -- a Pianoid process there is caught by the
# command-line marker pass (incl. the wt-* worktree dev-server match); see Show-SparePortListeners.
$SparePorts = @(3002..3020) + @(5002..5020)

# Command-line substrings that positively identify a Pianoid process.
# Matched case-insensitively against the full command line.
$PianoidMarkers = @(
    'backendServer.py',           # main backend (port 5000)
    'modal_adapter_server.py',    # modal adapter (port 5001)
    'server\launcher.js',         # node launcher (port 3001)
    'server/launcher.js',         # ... forward-slash form, just in case
    'PianoidTunner',              # frontend repo dir (CRA / react-scripts / webpack live here)
    'PianoidCore\pianoid_middleware',  # backend repo dir
    'PianoidCore/pianoid_middleware'
)

# --- helpers ---------------------------------------------------------------

# Map: ProcessId -> @(port, port, ...) for anything LISTENING on a Pianoid port.
function Get-PianoidPortOwners {
    $byPid = @{}
    foreach ($port in $PianoidPorts) {
        try {
            $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
        } catch {
            $conns = @()   # nothing listening on this port
        }
        foreach ($c in $conns) {
            $opid = [int]$c.OwningProcess
            if ($opid -le 0) { continue }
            if (-not $byPid.ContainsKey($opid)) { $byPid[$opid] = New-Object System.Collections.Generic.List[int] }
            if (-not $byPid[$opid].Contains($port)) { $byPid[$opid].Add($port) }
        }
    }
    return $byPid
}

# Does this command line look like a real Pianoid marker (and not a false positive)?
function Test-PianoidCmdLine {
    param([string]$CmdLine)
    if ([string]::IsNullOrWhiteSpace($CmdLine)) { return $null }

    # 'react-scripts' / 'concurrently' alone are too generic to match on their own;
    # only treat them as Pianoid when the command line also references the frontend repo
    # OR the launcher script (the concurrently supervisor command embeds both).
    $hasFrontendContext = ($CmdLine -match '(?i)PianoidTunner') -or
                          ($CmdLine -match '(?i)server[\\/]launcher\.js')

    foreach ($m in $PianoidMarkers) {
        if ($CmdLine -like "*$m*") { return $m }
    }
    # Agent WORKTREE dev servers (D:\repos\wt-<name>[-tunner]\... on a spare port 3002-3020,
    # e.g. `PORT=3013 BROWSER=none npx react-scripts start`): the worktree path carries no
    # 'PianoidTunner' marker, so match a wt-* path ONLY together with a dev-server shape
    # (never a bare wt-* path -- that would hit a concurrent agent's pytest/harness run).
    if (($CmdLine -match '(?i)[\\/]wt-[^\\/\s"'']+[\\/]') -and
        ($CmdLine -match '(?i)react-scripts|webpack|concurrently|server[\\/]launcher\.js')) {
        return 'worktree dev server (wt-*)'
    }
    if ($hasFrontendContext) {
        if ($CmdLine -match '(?i)react-scripts') { return 'react-scripts (PianoidTunner)' }
        if ($CmdLine -match '(?i)concurrently')  { return 'concurrently (launcher.js)' }
        if ($CmdLine -match '(?i)webpack')        { return 'webpack (PianoidTunner)' }
    }
    return $null
}

# Build the set of matched Pianoid processes.
# Each result: PID, Name, CmdLine, Ports (list), Reason (why matched).
function Get-PianoidProcesses {
    $portOwners = Get-PianoidPortOwners

    # Pull command lines once for all candidate processes (node/python only --
    # those are the only image names the Pianoid stack uses).
    $cmdByPid = @{}
    foreach ($p in Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue) {
        $cmdByPid[[int]$p.ProcessId] = [pscustomobject]@{
            Name    = $p.Name
            CmdLine = $p.CommandLine
            PPID    = [int]$p.ParentProcessId
        }
    }

    $results = @{}   # pid -> result object

    # 1) Anything LISTENING on a Pianoid port. (Confirm it's node/python with a
    #    plausible cmdline; a port owner that isn't node/python would be highly
    #    unexpected for this stack, but we still report it so it isn't silently missed.)
    foreach ($opid in $portOwners.Keys) {
        $ports = $portOwners[$opid]
        $info = $cmdByPid[$opid]
        $name = if ($info) { $info.Name } else { (Get-Process -Id $opid -ErrorAction SilentlyContinue).ProcessName }
        $cmd  = if ($info) { $info.CmdLine } else { '' }
        $results[$opid] = [pscustomobject]@{
            PID     = $opid
            Name    = $name
            CmdLine = $cmd
            Ports   = ($ports | Sort-Object)
            Reason  = "listening on port(s) $([string]::Join(',', ($ports | Sort-Object)))"
        }
    }

    # 2) Anything whose command line carries a Pianoid marker (catches orphans not
    #    yet bound to a port, and the concurrently supervisor which owns no port).
    foreach ($kvp in $cmdByPid.GetEnumerator()) {
        $opid = $kvp.Key
        $info = $kvp.Value
        $marker = Test-PianoidCmdLine -CmdLine $info.CmdLine
        if ($null -ne $marker) {
            if ($results.ContainsKey($opid)) {
                # already matched by port -- enrich the reason
                $results[$opid].Reason = "$($results[$opid].Reason); cmdline marker '$marker'"
            } else {
                $results[$opid] = [pscustomobject]@{
                    PID     = $opid
                    Name    = $info.Name
                    CmdLine = $info.CmdLine
                    Ports   = @()
                    Reason  = "cmdline marker '$marker'"
                }
            }
        }
    }

    return $results.Values | Sort-Object PID
}

function Format-Cmd {
    param([string]$CmdLine, [int]$Max = 110)
    if ([string]::IsNullOrWhiteSpace($CmdLine)) { return '<no command line>' }
    $c = $CmdLine.Trim()
    if ($c.Length -gt $Max) { return $c.Substring(0, $Max) + ' ...' }
    return $c
}

# Kill a process tree via taskkill /F /T (Windows). Returns $true on success.
function Stop-ProcessTree {
    param([int]$ProcessId)
    try {
        # /T kills the whole child tree; /F forces. This is what stops respawn.
        taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-OpenPorts {
    $open = @()
    foreach ($port in $PianoidPorts) {
        try {
            $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
            if ($c) { $open += $port }
        } catch { }
    }
    return ($open | Sort-Object -Unique)
}

# Report-only: listeners on the agent SPARE ports (worktree CRA 3002-3020 / worktree or isolated
# backends 5002-5020). A Pianoid-marked one is killed by the marker pass above (it is a node/python
# with a Pianoid / wt-* dev-server command line); anything else is shown as FOREIGN and left alone.
function Show-SparePortListeners {
    $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
               Where-Object { $SparePorts -contains $_.LocalPort -and $_.OwningProcess -gt 0 })
    if ($conns.Count -eq 0) {
        Write-Host 'Spare ports    : no listeners on 3002-3020 / 5002-5020.' -ForegroundColor Green
        return
    }
    Write-Host 'Spare ports    : listeners on agent spare ports (3002-3020 / 5002-5020):' -ForegroundColor Cyan
    foreach ($c in $conns) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        $tag = if ($p -and ($p.Name -in 'node.exe','python.exe') -and (Test-PianoidCmdLine -CmdLine $p.CommandLine)) { 'PIANOID (killed by marker pass)' } else { 'FOREIGN (left alone)' }
        Write-Host ("  port {0,-5} PID {1,-7} {2,-11} {3}" -f $c.LocalPort, $c.OwningProcess, $(if ($p) { $p.Name } else { '?' }), $tag)
    }
}

# Report-only: processes holding the CUDA engine module (build holders). A holder that is NOT a
# matched Pianoid server is usually a live agent's in-process harness/pytest -- never killed here;
# stop it via its owner (or the orchestrator) before a rebuild.
function Show-BuildHolders {
    $holders = @()
    foreach ($mod in 'pianoidCuda.cp312-win_amd64.pyd', 'pianoidCuda_debug.cp312-win_amd64.pyd') {
        $rows = tasklist /M $mod /FO CSV /NH 2>$null
        foreach ($r in $rows) {
            if ($r -match '^"([^"]+)","(\d+)"') { $holders += [pscustomobject]@{ Name = $Matches[1]; PID = [int]$Matches[2]; Module = $mod } }
        }
    }
    if ($holders.Count -eq 0) {
        Write-Host 'Build holders  : none (no process holds pianoidCuda*.pyd).' -ForegroundColor Green
        return
    }
    Write-Host 'Build holders  : processes holding pianoidCuda*.pyd:' -ForegroundColor Cyan
    foreach ($h in $holders) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($h.PID)" -ErrorAction SilentlyContinue
        Write-Host ("  PID {0,-7} {1,-11} {2}" -f $h.PID, $h.Name, $h.Module)
        if ($p) { Write-Host ("            cmd: {0}" -f (Format-Cmd $p.CommandLine)) -ForegroundColor DarkGray }
    }
}

# --- main ------------------------------------------------------------------

Write-Host ''
Write-Host '=== kill_pianoid.ps1 ===' -ForegroundColor Cyan
Write-Host ("Ports targeted : {0}" -f ([string]::Join(', ', $PianoidPorts)))
if ($DryRun) {
    Write-Host 'Mode           : DRY RUN (preview only -- nothing will be killed)' -ForegroundColor Yellow
} else {
    Write-Host 'Mode           : LIVE (matched process trees will be killed)' -ForegroundColor Red
}
Write-Host ''
Show-SparePortListeners
Show-BuildHolders
Write-Host ''

$matched = @(Get-PianoidProcesses)

if ($matched.Count -eq 0) {
    Write-Host 'No Pianoid processes found. Nothing to kill.' -ForegroundColor Green
    $stillOpen = Get-OpenPorts
    if ($stillOpen.Count -gt 0) {
        Write-Host ("WARNING: ports still listening (owner not identified as Pianoid): {0}" -f ([string]::Join(', ', $stillOpen))) -ForegroundColor Yellow
    } else {
        Write-Host 'Port state     : ALL CLEAR (3000/3001/5000/5001 free).' -ForegroundColor Green
    }
    return
}

Write-Host ("Found {0} Pianoid process(es):" -f $matched.Count) -ForegroundColor Cyan
foreach ($m in $matched) {
    $portStr = if ($m.Ports.Count -gt 0) { [string]::Join(',', $m.Ports) } else { '-' }
    Write-Host ("  PID {0,-7} {1,-11} port[{2,-13}] {3}" -f $m.PID, $m.Name, $portStr, $m.Reason)
    Write-Host ("            cmd: {0}" -f (Format-Cmd $m.CmdLine)) -ForegroundColor DarkGray
}
Write-Host ''

if ($DryRun) {
    Write-Host 'DRY RUN complete -- no processes were killed.' -ForegroundColor Yellow
    Write-Host 'Re-run without -DryRun to actually kill the matched trees.' -ForegroundColor Yellow
    return
}

# --- LIVE kill --------------------------------------------------------------
# Kill order mirrors the documented shutdown sequence: frontend(3000) -> launcher(3001)
# -> modal(5001) -> backend(5000). We sort matched procs by their lowest targeted port
# (port-less supervisors like `concurrently` sort last and are killed via /T anyway).
function PortRank {
    param($Proc)
    if ($Proc.Ports.Count -eq 0) { return 9999 }
    return ([int[]]$Proc.Ports | Measure-Object -Minimum).Minimum
}
$ordered = $matched | Sort-Object @{ Expression = { PortRank $_ } }, PID

$killed = New-Object System.Collections.Generic.List[object]
$failed = New-Object System.Collections.Generic.List[object]
foreach ($m in $ordered) {
    Write-Host ("Killing tree of PID {0} ({1})..." -f $m.PID, $m.Name)
    if (Stop-ProcessTree -ProcessId $m.PID) {
        $killed.Add($m)
    } else {
        $failed.Add($m)
    }
}

# Give the OS a moment to release the sockets, then re-check.
Start-Sleep -Milliseconds 1500

$stillOpen = Get-OpenPorts

# One retry pass for stragglers (newly-orphaned children, or a port still held).
if ($stillOpen.Count -gt 0) {
    Write-Host ''
    Write-Host ("Ports still listening after first pass: {0} -- retrying once..." -f ([string]::Join(', ', $stillOpen))) -ForegroundColor Yellow
    $retry = @(Get-PianoidProcesses)
    foreach ($m in $retry) {
        Write-Host ("  retry: killing tree of PID {0} ({1}) [{2}]" -f $m.PID, $m.Name, $m.Reason)
        if (Stop-ProcessTree -ProcessId $m.PID) { $killed.Add($m) }
    }
    Start-Sleep -Milliseconds 1500
    $stillOpen = Get-OpenPorts
}

# --- summary ----------------------------------------------------------------
Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
Write-Host ("Processes found : {0}" -f $matched.Count)
Write-Host ("Trees killed    : {0}" -f $killed.Count)
if ($failed.Count -gt 0) {
    Write-Host ("Kill failures   : {0}" -f $failed.Count) -ForegroundColor Yellow
    foreach ($f in $failed) { Write-Host ("    PID {0} ({1})" -f $f.PID, $f.Name) -ForegroundColor Yellow }
}
if ($stillOpen.Count -eq 0) {
    Write-Host 'Port state      : ALL CLEAR (3000/3001/5000/5001 free).' -ForegroundColor Green
} else {
    Write-Host ("Port state      : STILL IN USE -> {0}" -f ([string]::Join(', ', $stillOpen))) -ForegroundColor Red
    Write-Host 'Inspect manually: Get-NetTCPConnection -State Listen -LocalPort 3000,3001,5000,5001 | Select LocalPort,OwningProcess' -ForegroundColor Red
}
Write-Host ''
