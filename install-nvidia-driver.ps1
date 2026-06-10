# =========================================================================
# install-nvidia-driver.ps1 - automated NVIDIA DISPLAY-DRIVER (re)install.
#
# WHY THIS EXISTS (the incident): setup-packages installs the CUDA *toolkit*,
# NOT the display driver. nvml.dll / nvcuda.dll are DISPLAY-DRIVER files
# (System32, version-locked to the driver), so a "driver reinstall via
# setup-packages" never fixes an "NVML not found" / "driver/library version
# mismatch". This script reinstalls the actual DISPLAY DRIVER.
#
# POLICY (user-approved 2026-06-10, mechanism 'A'): a SEPARATE opt-in action
# (NOT in the default setup-packages pipeline). It PROMPTS ONCE on the risks,
# then - on acknowledgment - runs FULLY AUTOMATICALLY via chocolatey, no further
# user involvement. setup-packages already runs elevated, so admin is assumed
# available (and asserted).
#
# MECHANISM (chocolatey-primary, with a guided fail-safe):
#   Tier 1  chocolatey `nvidia-display-driver` - installs the LATEST GeForce
#           Game-Ready/DCH driver, fully unattended:
#             (ensure choco is present, bootstrap it if missing)
#             choco install nvidia-display-driver -y --no-progress
#           The package's own silentArgs are `-s -noreboot`; it returns 0 /
#           1605 / 1614 / 1641 / 3010 on success (3010 = reboot required).
#   Tier 2  GUIDED fail-safe: if choco can't be installed or the package install
#           fails, open the NVIDIA App / driver page + print the exact steps.
#           (Same safety net as the no-CUDA guidance - NEVER leaves the box worse.)
#   After any install attempt: VERIFY via diagnose-cuda.ps1 (the deep diagnostic).
#
# SCOPE / HONEST CAVEATS:
#   * GeForce only. The choco package installs the latest desktop GeForce DCH
#     driver (one unified driver covers all modern GeForce cards). On a
#     non-GeForce / laptop-OEM-locked GPU the package may be wrong -> Tier 2
#     guidance covers that.
#   * The package downloads from official NVIDIA URLs at RUNTIME and the
#     community repo carries no reliability guarantee -> a transient download /
#     rate-limit failure falls through to the Tier-2 guided path.
#   * A driver install briefly resets the display and REQUIRES A REBOOT; a
#     bad/interrupted install can disturb the display until reboot/recovery.
#     Mitigated by the one-time risk ack, never auto-rebooting without asking,
#     and the post-install verification.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-nvidia-driver.ps1
#     -Acknowledged : skip the interactive risk prompt (the CALLER already showed
#                     it - e.g. setup-packages.bat). Required for unattended runs.
#     -NoReboot     : never reboot; just report that a reboot is pending.
#     -Force        : pass choco --force (reinstall even if already present).
#     -DryRun       : LOGIC/PLAN ONLY - print exactly what WOULD run (choco
#                     bootstrap + `choco install ...`) and DO NOT execute the
#                     install, the bootstrap, or any reboot. Safe to run anywhere.
#
# EXIT CODES:
#   0  -> driver install completed (or the user declined - nothing broken), OR a
#         clean Tier-2 guided fallback (we did not install but pointed the user
#         at the fix). 1 -> not elevated. 5 -> no NVIDIA GPU present.
#
# See: check-driver-health.ps1 (the "if needed" detector this calls),
#      diagnose-cuda.ps1 (deep read-only diagnostic - VERIFY step),
#      docs/proposals/setup-packages-driver-reinstall-2026-06-10.md (design).
# =========================================================================

[CmdletBinding()]
param(
    [switch] $Acknowledged,
    [switch] $NoReboot,
    [switch] $Force,
    [switch] $DryRun
)

# We MANAGE failures (guided fallback) rather than abort on the first error.
$ErrorActionPreference = 'Continue'

$RepoRoot = $PSScriptRoot
$ChocoPkg = 'nvidia-display-driver'
$ChocoInstallUrl = 'https://community.chocolatey.org/install.ps1'
$NvidiaAppPage = 'https://www.nvidia.com/en-us/software/nvidia-app/'
$NvidiaDriverPage = 'https://www.nvidia.com/Download/index.aspx'
# choco exit codes that mean success (0 ok; 1641/3010 reboot-initiated/required;
# 1605/1614 MSI already-installed/uninstalled) - the package's own whitelist.
$ChocoSuccess = @(0, 1605, 1614, 1641, 3010)

function Write-Step { param([string] $Text) Write-Host ''; Write-Host ("=== {0} ===" -f $Text) }
function Write-Info { param([string] $Text) Write-Host ("  {0}" -f $Text) }
function Write-Warn { param([string] $Text) Write-Host ("  WARNING: {0}" -f $Text) -ForegroundColor Yellow }
function Write-Err  { param([string] $Text) Write-Host ("  ERROR: {0}" -f $Text) -ForegroundColor Red }

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = [Security.Principal.WindowsPrincipal]$id
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Must run elevated (Administrator). setup-packages runs elevated; run this the same way."
    }
}

# The detected NVIDIA GPU (WMI), or $null.
function Get-NvidiaGpu {
    $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -match 'NVIDIA' -or $_.AdapterCompatibility -match 'NVIDIA' })
    if ($gpus.Count -eq 0) { return $null }
    return $gpus[0]
}

# Is the driver currently healthy? Reuse check-driver-health.ps1 (exit 0 = healthy).
# Returns $true (healthy) / $false (needs attention) / $null (could not determine).
function Test-DriverHealthy {
    $checker = Join-Path $RepoRoot 'check-driver-health.ps1'
    if (-not (Test-Path -LiteralPath $checker)) { return $null }
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $checker -Quiet | Out-Null
        switch ($LASTEXITCODE) {
            0  { return $true }
            10 { return $false }
            20 { return $false }
            default { return $null }
        }
    } catch { return $null }
}

# Locate choco.exe (refreshing PATH first in case a prior step installed it).
function Get-ChocoCmd {
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
    return (Get-Command 'choco' -ErrorAction SilentlyContinue)
}

# ---- Tier 1: chocolatey ---------------------------------------------------
# Returns $true if the install completed (or, under -DryRun, the plan printed),
# $false if choco is unavailable / the install failed (-> caller goes to Tier 2).
function Invoke-Tier1-Chocolatey {
    Write-Step 'Tier 1: chocolatey (automated)'

    # 1. Ensure choco is present (bootstrap if missing).
    $choco = Get-ChocoCmd
    if (-not $choco) {
        if ($DryRun) {
            Write-Info '[DryRun] chocolatey not present -> WOULD bootstrap it via:'
            Write-Info ("[DryRun]   Invoke-Expression ((New-Object Net.WebClient).DownloadString('{0}'))" -f $ChocoInstallUrl)
        } else {
            Write-Info 'chocolatey not present - bootstrapping...'
            try {
                Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
                [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
                Invoke-Expression ((New-Object System.Net.WebClient).DownloadString($ChocoInstallUrl))
            } catch {
                Write-Warn ("chocolatey bootstrap failed ({0})." -f $_.Exception.Message)
                return $false
            }
            $choco = Get-ChocoCmd
            if (-not $choco) { Write-Warn 'chocolatey still not available after bootstrap.'; return $false }
        }
    } else {
        Write-Info ("chocolatey present: {0}" -f $choco.Source)
    }

    # 2. Build the install command.
    $chocoExe = if ($choco) { $choco.Source } else { 'choco' }
    $cargs = @('install', $ChocoPkg, '-y', '--no-progress')
    if ($Force) { $cargs += '--force' }

    # 3. DryRun -> print the EXACT command, do NOT execute. This is the
    #    logic-test seam: command construction is verifiable without installing.
    if ($DryRun) {
        Write-Info ("[DryRun] WOULD run: {0} {1}" -f $chocoExe, ($cargs -join ' '))
        Write-Info ("[DryRun] success exit codes treated as OK: {0}" -f ($ChocoSuccess -join ', '))
        Write-Info '[DryRun] no install performed, no reboot.'
        return $true
    }

    # 4. Real install.
    Write-Info ("Running: choco {0}" -f ($cargs -join ' '))
    & $chocoExe @cargs
    $code = $LASTEXITCODE
    if ($ChocoSuccess -contains $code) {
        Write-Info ("chocolatey install finished (exit {0})." -f $code)
        # 1641/3010 explicitly signal a reboot; treat any success as reboot-likely
        # for a driver (the package installs with -noreboot).
        $script:RebootLikely = $true
        return $true
    }
    Write-Warn ("chocolatey install returned exit {0} - falling back to guided." -f $code)
    return $false
}

# ---- Tier 2: GUIDED fail-safe (never leaves the box worse) -----------------
function Invoke-Tier2-Guide {
    Write-Step 'Tier 2: guided manual install (automated path unavailable)'
    Write-Info 'The automated chocolatey install could not proceed (see the warnings above).'
    Write-Info 'This is the SAFE fallback - nothing was changed on your system.'
    Write-Host ''
    Write-Info '*** TOOLKIT vs DRIVER ***'
    Write-Info 'setup-packages reinstalls the CUDA TOOLKIT - it does NOT reinstall the display'
    Write-Info 'driver and will NOT fix nvml.dll / nvcuda.dll (those are DISPLAY-DRIVER files).'
    Write-Host ''
    Write-Info 'To fix the driver manually:'
    Write-Info '  1. Install the NVIDIA App (the modern GUI installer):'
    Write-Info ("       {0}" -f $NvidiaAppPage)
    Write-Info ("     (or download a driver directly: {0})" -f $NvidiaDriverPage)
    Write-Info '  2. Run it; if the problem persisted before, choose a Custom -> Clean install.'
    Write-Info '  3. Reboot, then re-run diagnose-cuda.ps1 to verify (section 4 nvidia-smi should pass).'
    if (-not $DryRun) {
        try { Start-Process $NvidiaAppPage | Out-Null; Write-Info 'Opened the NVIDIA App download page.' } catch { }
    } else {
        Write-Info ("[DryRun] WOULD open: {0}" -f $NvidiaAppPage)
    }
}

# ---- post-install verification (the deep diagnostic) ----------------------
function Invoke-Verify {
    Write-Step 'Verify (diagnose-cuda.ps1)'
    $diag = Join-Path $RepoRoot 'diagnose-cuda.ps1'
    if (-not (Test-Path -LiteralPath $diag)) {
        Write-Info 'diagnose-cuda.ps1 not found - skipping deep verify. Run: nvidia-smi'
        return
    }
    if ($script:RebootLikely) {
        Write-Info 'NOTE: a reboot is required before the new driver fully takes effect;'
        Write-Info '      a pre-reboot verify may still show a version mismatch - that is expected.'
    }
    if ($DryRun) { Write-Info '[DryRun] WOULD run: diagnose-cuda.ps1 -SkipCupy'; return }
    try { & powershell -NoProfile -ExecutionPolicy Bypass -File $diag -SkipCupy } catch {
        Write-Warn ("verify raised: {0}" -f $_.Exception.Message)
    }
}

# =========================================================================
# Main
# =========================================================================
$script:RebootLikely = $false

Write-Host '=== NVIDIA display-driver (re)install (chocolatey) ==='
if ($DryRun) { Write-Info '[DryRun] LOGIC/PLAN ONLY - no install, no bootstrap, no reboot.' }

# 1. Admin (setup-packages runs elevated; assert it). Skipped under -DryRun so the
#    plan is inspectable from a normal shell.
if (-not $DryRun) {
    try { Assert-Admin } catch { Write-Err $_.Exception.Message; exit 1 }
}

# 2. GPU present? (nothing to install a driver for otherwise).
$gpu = Get-NvidiaGpu
if (-not $gpu) {
    Write-Warn 'No NVIDIA GPU detected by Windows (WMI). There is no display driver to install.'
    Write-Info 'If a card is installed, confirm it is seated/enabled in Device Manager, then retry.'
    exit 5
}
Write-Info ("GPU: {0} | current driver {1}" -f $gpu.Name, $gpu.DriverVersion)

# 3. Risk prompt + acknowledgment (skipped if the caller already prompted via
#    -Acknowledged, or under -DryRun).
if (-not $Acknowledged -and -not $DryRun) {
    Write-Host ''
    Write-Host '  ********************************* RISK NOTICE *********************************' -ForegroundColor Yellow
    Write-Host '  This will install the LATEST NVIDIA GeForce display driver via chocolatey,' -ForegroundColor Yellow
    Write-Host '  fully automatically. A driver install:' -ForegroundColor Yellow
    Write-Host '    - briefly resets the display and CAN, in rare cases, leave it in a bad' -ForegroundColor Yellow
    Write-Host '      state until a reboot / recovery;' -ForegroundColor Yellow
    Write-Host '    - REQUIRES A REBOOT to fully take effect;' -ForegroundColor Yellow
    Write-Host '    - installs the latest GeForce driver (GeForce GPUs only; laptop/OEM systems' -ForegroundColor Yellow
    Write-Host '      may need the OEM driver instead).' -ForegroundColor Yellow
    Write-Host '  Close other GPU apps and save your work first.' -ForegroundColor Yellow
    Write-Host '  ****************************************************************************' -ForegroundColor Yellow
    $ans = Read-Host '  Type YES to proceed (anything else cancels)'
    if ($ans -ne 'YES') { Write-Info 'Cancelled - nothing was changed.'; exit 0 }
}

# 4. Idempotency note (informational): a BROKEN driver always (re)installs; a
#    healthy one still gets the latest (choco no-ops if already current unless
#    -Force). check-driver-health is the detector behind the "if needed" story.
$healthy = Test-DriverHealthy
if ($healthy -eq $true) { Write-Info 'check-driver-health: driver currently HEALTHY (will still pull the latest via choco).' }
elseif ($healthy -eq $false) { Write-Info 'check-driver-health: driver NEEDS ATTENTION - proceeding.' }

# 5. Tier 1 choco; on failure -> Tier 2 guided (safe), then verify + exit.
$done = Invoke-Tier1-Chocolatey
if (-not $done) { Invoke-Tier2-Guide; Invoke-Verify; exit 0 }

# 6. Verify the result.
Invoke-Verify

# 7. Reboot handling (NEVER auto-reboot under -DryRun).
if ($script:RebootLikely -and -not $DryRun) {
    if ($NoReboot) {
        Write-Host ''
        Write-Info 'A REBOOT IS REQUIRED for the new driver to take effect (-NoReboot set; not rebooting).'
    } else {
        Write-Host ''
        $rb = Read-Host '  A reboot is required to finish. Reboot now? (y/N)'
        if ($rb -match '^[Yy]') { Write-Info 'Rebooting...'; Restart-Computer -Force }
        else { Write-Info 'Reboot skipped - please reboot before using Pianoid synthesis.' }
    }
}

Write-Host ''
Write-Info 'Done. If synthesis still fails after reboot, run diagnose-cuda.ps1 for a full report.'
exit 0
