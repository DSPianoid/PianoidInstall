<#
.SYNOPSIS
    Lock the NVIDIA GPU clocks at maximum for low-latency realtime audio synthesis,
    and (optionally) install a Scheduled Task that re-applies the lock on every boot.

.DESCRIPTION
    WHY THIS EXISTS
    ---------------
    Pianoid's synthesis kernel runs as a short, periodic, latency-sensitive workload
    driven at the audio-callback cadence. The NVIDIA driver's dynamic-boost heuristics
    do not recognise this pattern as "load worth boosting for": the GPU is held in a low
    P-state at a fraction of its clock ceiling even while heavily utilised.

    Measured on this machine (RTX 4090, driver 565.90) with the engine running:

        GPU utilization : 77-84 %
        SM clock        : 1125-1245 MHz   (max 3120 MHz)
        power draw      : ~74 W           (of a 450 W budget)

    i.e. 80% utilised at ~38% of the clock ceiling. Each synthesis cycle therefore takes
    ~2.6x longer than the hardware allows, which is what pushes cycles past their deadline
    and produces audible dropouts / latency.

    Locking the clocks to maximum removes the downclocking and makes cycle time
    deterministic. This is ALSO what makes before/after benchmarks meaningful
    (see tools/lock_gpu_clock.bat, the original manual-only version of this).

    THE CATCH: a clock lock is driver state, NOT persistent. Every Windows reboot clears
    it. `nvidia-smi -pm 1` (persistence mode) does NOT help — it is a Tesla/TCC feature and
    reports [N/A] on GeForce/WDDM. The only reliable fix is to re-apply the lock at boot,
    which is what -Install does.

    ADMINISTRATOR IS REQUIRED for -Apply, -Install, -Uninstall and -Reset. Changing clocks
    is a privileged driver operation (an unelevated nvidia-smi -lgc exits 4 with
    "The current user does not have permission to change clocks"). -Status needs no rights.

.PARAMETER Status
    Report current clock / max clock / p-state / utilization, and whether the boot task is
    installed. Requires no privileges. This is the default when no switch is given.

.PARAMETER Apply
    Lock graphics + memory clocks to their maximum, now. (Requires Administrator.)

.PARAMETER Install
    Register the "PianoidGpuRtConfig" Scheduled Task: at system startup, as SYSTEM, run this
    script with -Apply. Survives reboots and needs no logged-on user and no UAC prompt.
    (Requires Administrator.) Combine with -Apply to also lock the clocks immediately.

.PARAMETER Uninstall
    Remove the Scheduled Task. (Requires Administrator.) Does not unlock the clocks; use -Reset.

.PARAMETER Reset
    Restore default dynamic-boost clock behaviour (nvidia-smi -rgc / -rmc). (Requires Administrator.)

.EXAMPLE
    # The one-time setup, from an ELEVATED shell. Locks the clocks now AND every boot from now on.
    powershell -NoProfile -ExecutionPolicy Bypass -File D:\repos\PianoidInstall\tools\gpu_rt_config.ps1 -Install -Apply

.EXAMPLE
    # Check state at any time (no admin needed).
    powershell -NoProfile -ExecutionPolicy Bypass -File D:\repos\PianoidInstall\tools\gpu_rt_config.ps1 -Status

.NOTES
    Side effect of locking to max: the GPU holds a high clock even when idle, so it draws more
    power and runs the fans harder than it otherwise would. If the machine is not being used for
    Pianoid, -Reset (or -Uninstall for good) restores normal behaviour.
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Apply,
    [switch]$Install,
    [switch]$Uninstall,
    [switch]$Reset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Shared helpers: bounded nvidia-smi calls, the lock record (this script is its sole writer),
# and the lock-in-effect test used by -Status and by check-gpu-clock.ps1.
. (Join-Path $PSScriptRoot 'gpu_clock_state.ps1')

$TaskName = 'PianoidGpuRtConfig'
$LogDir   = Join-Path $env:ProgramData 'Pianoid'
$LogFile  = Join-Path $LogDir 'gpu_rt_config.log'

# --------------------------------------------------------------------------------------
# Logging. The boot-time run has no console attached, so everything also goes to a file --
# that file is how the operator confirms the task actually fired at boot.
# The file is written FIRST: a console write can block (a click into a QuickEdit console
# freezes the process at its next write), and the file must still show how far we got.
# --------------------------------------------------------------------------------------
function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        Add-Content -Path $LogFile -Value $line -Encoding utf8
    } catch {
        # Never let a logging failure take down the actual work.
    }
    Write-Host $line
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Elevated {
    param([string]$What)
    if (-not (Test-Elevated)) {
        Write-Log "$What requires Administrator. Re-run from an elevated shell." 'ERROR'
        exit 1
    }
}

# --------------------------------------------------------------------------------------
# At boot, an "At startup" task can easily fire BEFORE the NVIDIA driver stack (nvlddmkm /
# NVML) is ready -- nvidia-smi then fails and a naive script would silently do nothing.
# Poll until the driver answers. This retry loop is the whole reason the boot task is
# reliable; do not remove it.
# --------------------------------------------------------------------------------------
function Wait-ForDriver {
    param([string]$Smi, [int]$TimeoutSec = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $attempt = 0
    while ((Get-Date) -lt $deadline) {
        $attempt++
        $r = Invoke-Smi -Smi $Smi -Arguments @('--query-gpu=clocks.max.sm', '--format=csv,noheader,nounits')
        $out = $r.Output
        if ($r.ExitCode -eq 0 -and $out -match '\d+') {
            if ($attempt -gt 1) { Write-Log "NVIDIA driver ready after $attempt attempt(s)." }
            return $true
        }
        Start-Sleep -Seconds 3
    }
    Write-Log "NVIDIA driver did not become ready within ${TimeoutSec}s (last: $out)." 'ERROR'
    return $false
}

function Get-ClockState {
    param([string]$Smi)
    $r = Invoke-Smi -Smi $Smi -Arguments @(
        '--query-gpu=clocks.sm,clocks.max.sm,clocks.mem,clocks.max.mem,pstate,utilization.gpu,power.draw',
        '--format=csv,noheader,nounits')
    if ($r.ExitCode -ne 0) { throw "nvidia-smi query failed: $($r.Output)" }
    $f = (($r.Output -split "`r?`n")[0] -split ',').Trim()
    [pscustomobject]@{
        SmMhz    = [int]$f[0]
        SmMaxMhz = [int]$f[1]
        MemMhz   = [int]$f[2]
        MemMaxMhz= [int]$f[3]
        PState   = $f[4]
        UtilPct  = $f[5]
        PowerW   = $f[6]
    }
}

# --------------------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------------------
function Invoke-Apply {
    param([string]$Smi)
    Assert-Elevated 'Locking GPU clocks'
    if (-not (Wait-ForDriver -Smi $Smi)) { exit 1 }

    $before = Get-ClockState -Smi $Smi
    Write-Log ("BEFORE: sm={0} MHz (max {1}), mem={2} MHz (max {3}), pstate={4}, util={5}%, power={6} W" -f `
        $before.SmMhz, $before.SmMaxMhz, $before.MemMhz, $before.MemMaxMhz, $before.PState, $before.UtilPct, $before.PowerW)

    # Graphics/SM clock -- the one that matters for cycle time. Hard-fail if this does not take.
    $r = Invoke-Smi -Smi $Smi -Arguments @('-lgc', "$($before.SmMaxMhz),$($before.SmMaxMhz)")
    if ($r.ExitCode -ne 0) {
        Write-Log "Failed to lock graphics clock: $($r.Output)" 'ERROR'
        exit 1
    }
    Write-Log "Graphics/SM clock LOCKED at $($before.SmMaxMhz) MHz."

    # Memory clock -- a bonus, and not supported on every GeForce/driver combo. Never fatal.
    $r = Invoke-Smi -Smi $Smi -Arguments @('-lmc', "$($before.MemMaxMhz),$($before.MemMaxMhz)")
    if ($r.ExitCode -ne 0) {
        Write-Log "Memory clock lock not supported on this GPU/driver -- graphics clock is locked, continuing. ($($r.Output))" 'WARN'
    } else {
        Write-Log "Memory clock LOCKED at $($before.MemMaxMhz) MHz."
    }

    # The record is how check-gpu-clock.ps1 recognises the lock (see gpu_clock_state.ps1).
    # Write it before the informational read-back, which must never fail the apply.
    $live = Get-GpuLiveState -Smi $Smi
    if (-not $live) { Write-Log 'Could not read the GPU identity -- lock record NOT written.' 'WARN'; return }
    Write-GpuLockRecord -Live $live -SmTargetMhz $before.SmMaxMhz -MemTargetMhz $before.MemMaxMhz
    Write-Log "Lock record written: $GpuLockRecordFile"

    Start-Sleep -Milliseconds 500
    try { $after = Get-ClockState -Smi $Smi } catch { Write-Log "AFTER read-back skipped: $_" 'WARN'; return }
    Write-Log ("AFTER : sm={0} MHz (max {1}), mem={2} MHz, pstate={3}, util={4}%, power={5} W, gpu_idle={6}" -f `
        $after.SmMhz, $after.SmMaxMhz, $after.MemMhz, $after.PState, $after.UtilPct, $after.PowerW, $live.IdleActive)
}

function Invoke-Reset {
    param([string]$Smi)
    Assert-Elevated 'Resetting GPU clocks'
    $r = Invoke-Smi -Smi $Smi -Arguments @('-rgc')
    if ($r.ExitCode -ne 0) { Write-Log "Failed to reset graphics clock: $($r.Output)" 'ERROR'; exit 1 }
    Remove-GpuLockRecord
    Write-Log 'Graphics clock reset to default dynamic boost.'
    $r = Invoke-Smi -Smi $Smi -Arguments @('-rmc')
    if ($r.ExitCode -ne 0) { Write-Log "Memory clock reset unsupported (ignored). ($($r.Output))" 'WARN' }
    else { Write-Log 'Memory clock reset to default.' }
}

function Invoke-Install {
    Assert-Elevated 'Installing the scheduled task'
    $self = $PSCommandPath
    if (-not (Test-Path $self)) { throw "Cannot resolve own path for the task action: '$self'" }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Apply' -f $self)
    $trigger = New-ScheduledTaskTrigger -AtStartup
    # SYSTEM: runs with no logged-on user, no UAC prompt, and already holds the rights
    # nvidia-smi -lgc needs.
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force `
        -Description 'Pianoid: lock NVIDIA GPU clocks at max for low-latency realtime audio synthesis. Re-applied at every boot because a clock lock is driver state and does not survive a restart.' | Out-Null

    Write-Log "Scheduled task '$TaskName' registered (trigger: at startup; account: SYSTEM)."
}

function Invoke-Uninstall {
    Assert-Elevated 'Removing the scheduled task'
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Log "Scheduled task '$TaskName' is not installed -- nothing to do."; return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Log "Scheduled task '$TaskName' removed. (Clocks are unchanged -- use -Reset to unlock.)"
}

function Invoke-Status {
    param([string]$Smi)
    $s = Get-ClockState -Smi $Smi
    $pct = [math]::Round(100.0 * $s.SmMhz / $s.SmMaxMhz)
    Write-Host ''
    Write-Host '=== GPU clock state ==='
    Write-Host ("  SM clock      : {0} MHz  of {1} MHz max   ({2}% of ceiling)" -f $s.SmMhz, $s.SmMaxMhz, $pct)
    Write-Host ("  Memory clock  : {0} MHz  of {1} MHz max" -f $s.MemMhz, $s.MemMaxMhz)
    Write-Host ("  P-state       : {0}" -f $s.PState)
    Write-Host ("  Utilization   : {0} %" -f $s.UtilPct)
    Write-Host ("  Power draw    : {0} W" -f $s.PowerW)
    Write-Host ''

    # Same decision as the launcher gate (lock record + driver corroboration). Not a clock
    # ratio: a locked RTX 4090 reads 2790 of 3120 MHz -- see gpu_clock_state.ps1.
    $lock = Test-GpuClockLocked -Smi $Smi
    if (-not $lock) {
        Write-Host '  => Lock state unknown (nvidia-smi query failed).' -ForegroundColor Yellow
    } elseif ($lock.Locked) {
        Write-Host '  => Clocks are LOCKED (applied by Pianoid since this boot).' -ForegroundColor Green
    } else {
        Write-Host ("  => Clocks are NOT locked: {0}." -f $lock.Reason) -ForegroundColor Yellow
        Write-Host '     Under Pianoid load this is the low-latency problem: the driver holds the'
        Write-Host '     GPU well below its ceiling even at high utilization.'
    }

    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host '=== Boot persistence ==='
    if ($t) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Host ("  Scheduled task '{0}': INSTALLED (state: {1})" -f $TaskName, $t.State) -ForegroundColor Green
        if ($info) {
            Write-Host ("  Last run   : {0}  (result: {1})" -f $info.LastRunTime, $info.LastTaskResult)
        }
        Write-Host ("  Log file   : {0}" -f $LogFile)
    } else {
        Write-Host ("  Scheduled task '{0}': NOT INSTALLED -- the lock will be lost on the next reboot." -f $TaskName) -ForegroundColor Yellow
        Write-Host '  Install it from an ELEVATED shell with:  -Install -Apply'
    }
    Write-Host ''
}

# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------
$smi = Get-NvidiaSmi
if (-not $smi) {
    Write-Log 'nvidia-smi not found. Install the NVIDIA driver or put nvidia-smi on PATH.' 'ERROR'
    exit 1
}

if ($Uninstall) { Invoke-Uninstall }
if ($Reset)     { Invoke-Reset -Smi $smi }
if ($Install)   { Invoke-Install }
if ($Apply)     { Invoke-Apply -Smi $smi }

# Status is the default when nothing else was asked for, and a courtesy confirmation
# after any state-changing action.
if ($Status -or -not ($Apply -or $Install -or $Uninstall -or $Reset)) {
    Invoke-Status -Smi $smi
}
