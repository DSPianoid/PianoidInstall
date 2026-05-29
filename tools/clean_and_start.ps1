<#
.SYNOPSIS
    Clean (kill) any running Pianoid stack, then start the frontend + launcher in the
    foreground via `npm run dev`.

.DESCRIPTION
    Companion to kill_pianoid.ps1. Two phases:

      (1) CLEAN -- calls kill_pianoid.ps1 (real kill, supervisor-tree aware) to tear down
          any running stack, then confirms ports 3000/3001/5000/5001 are clear before
          proceeding. Aborts with a clear error if a port is still held after the kill.

      (2) START -- runs `npm run dev` from the PianoidTunner directory in the FOREGROUND
          (this same window). That is the user's normal flow: leave the terminal open,
          watch the launcher + React logs, Ctrl+C to stop. `npm run dev` runs
          `concurrently` which starts BOTH the Node launcher (port 3001) and the React
          dev server (port 3000).

    IMPORTANT -- what `npm run dev` does and does NOT start:
      - STARTS now: React dev server (3000) + Node launcher (3001).
      - Does NOT auto-start: the Flask backend (5000) or the modal adapter (5001).
        Per docs/guides/STARTUP_TROUBLESHOOTING.md (Three-Process Architecture), the
        launcher spawns the backend only when you click APPLY in the browser UI (or POST
        /api/start-backend to the launcher on :3001). The modal adapter starts on demand.
      => After this script's `npm run dev` is up, open http://localhost:3000 and click
         APPLY to bring up the backend. The script prints this next step before exec.

    Linux equivalent (trivial):
        "$(dirname "$0")/kill_pianoid.sh"   # or the pkill/fuser block from kill_pianoid.ps1's header
        cd "$(dirname "$0")/../PianoidTunner" && npm run dev

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\clean_and_start.ps1

.NOTES
    Windows / PowerShell. Foreground by design -- the process blocks here streaming logs
    until you Ctrl+C. Does not commit, does not touch docs.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$Ports       = @(3000, 3001, 5000, 5001)
$KillScript  = Join-Path $PSScriptRoot 'kill_pianoid.ps1'
$FrontendDir = Resolve-Path (Join-Path $PSScriptRoot '..\PianoidTunner') -ErrorAction SilentlyContinue
$PackageJson = if ($FrontendDir) { Join-Path $FrontendDir 'package.json' } else { $null }

function Get-OpenPorts {
    $open = @()
    foreach ($p in $Ports) {
        try {
            $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop
            if ($c) { $open += $p }
        } catch { }
    }
    return ($open | Sort-Object -Unique)
}

function Abort {
    param([string]$Message)
    Write-Host ''
    Write-Host "ABORT: $Message" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '=== clean_and_start.ps1 ===' -ForegroundColor Cyan
Write-Host ''

# --- Pre-flight checks (fail fast, BEFORE killing anything) -----------------

if (-not (Test-Path -LiteralPath $KillScript)) {
    Abort "kill_pianoid.ps1 not found next to this script (expected: $KillScript)."
}
if (-not $FrontendDir -or -not (Test-Path -LiteralPath $FrontendDir)) {
    Abort "PianoidTunner directory not found (expected sibling of tools\: ..\PianoidTunner)."
}
if (-not (Test-Path -LiteralPath $PackageJson)) {
    Abort "PianoidTunner\package.json not found (expected: $PackageJson)."
}

# Confirm package.json actually defines a 'dev' script.
try {
    $pkg = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
} catch {
    Abort "Could not parse $PackageJson as JSON: $($_.Exception.Message)"
}
if (-not $pkg.scripts -or -not $pkg.scripts.dev) {
    Abort "package.json has no 'dev' script. Available scripts: $(@($pkg.scripts.PSObject.Properties.Name) -join ', ')"
}
Write-Host "Frontend dir   : $FrontendDir"
Write-Host "dev script     : npm run dev  ->  $($pkg.scripts.dev)" -ForegroundColor DarkGray

# npm must be on PATH.
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Abort "npm not found on PATH. Install Node.js 20.x (see docs/guides/STARTUP_TROUBLESHOOTING.md) and retry."
}
Write-Host "npm            : $($npm.Source)"
Write-Host ''

# --- Phase 1: CLEAN ---------------------------------------------------------

Write-Host '--- Phase 1: cleaning any running Pianoid stack ---' -ForegroundColor Cyan
# Reuse kill_pianoid.ps1 (real kill -- no -DryRun). It is supervisor-tree aware and
# already re-checks + retries ports. We do NOT duplicate its matching logic here.
& $KillScript
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    Abort "kill_pianoid.ps1 exited with code $LASTEXITCODE -- not starting the stack."
}

# Independent confirmation that the ports are actually clear before we start.
$stillOpen = Get-OpenPorts
if ($stillOpen.Count -gt 0) {
    Write-Host ("Ports still in use after clean: {0}" -f ($stillOpen -join ', ')) -ForegroundColor Red
    Write-Host 'Inspect: Get-NetTCPConnection -State Listen -LocalPort 3000,3001,5000,5001 | Select LocalPort,OwningProcess' -ForegroundColor Red
    Abort "Ports not clear after kill_pianoid.ps1 -- refusing to start a new stack on top of stragglers."
}
Write-Host 'Ports 3000/3001/5000/5001: ALL CLEAR.' -ForegroundColor Green
Write-Host ''

# --- Phase 2: START (foreground) -------------------------------------------

Write-Host '--- Phase 2: starting frontend + launcher (npm run dev) ---' -ForegroundColor Cyan
Write-Host ''
Write-Host 'NEXT STEP -------------------------------------------------------------' -ForegroundColor Yellow
Write-Host '  npm run dev starts the React dev server (port 3000) and the Node'        -ForegroundColor Yellow
Write-Host '  launcher (port 3001). It does NOT start the backend or modal adapter.'    -ForegroundColor Yellow
Write-Host '  ==> Open http://localhost:3000 and click APPLY to bring up the backend'   -ForegroundColor Yellow
Write-Host '      (port 5000). The launcher spawns it on APPLY; the modal adapter'      -ForegroundColor Yellow
Write-Host '      (port 5001) starts on demand.'                                        -ForegroundColor Yellow
Write-Host '  This window now streams launcher + React logs. Press Ctrl+C to stop.'     -ForegroundColor Yellow
Write-Host '-----------------------------------------------------------------------'    -ForegroundColor Yellow
Write-Host ''

# Run in the foreground from the frontend dir. Push-Location so a relative invocation
# resolves package.json correctly; npm run dev blocks here until Ctrl+C.
Push-Location -LiteralPath $FrontendDir
try {
    & npm run dev
} finally {
    Pop-Location
}
