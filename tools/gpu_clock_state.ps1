<#
.SYNOPSIS
    Shared GPU clock-lock state helpers. Dot-source only:  . (Join-Path $PSScriptRoot 'gpu_clock_state.ps1')

.DESCRIPTION
    Used by check-gpu-clock.ps1 (the launcher gate, read-only) and tools/gpu_rt_config.ps1 (the
    SOLE writer of GPU clock state and of the lock record). Defines functions only; no side effects.

    HOW "IS THE LOCK IN EFFECT?" IS DECIDED
    --------------------------------------
    nvidia-smi on GeForce/WDDM exposes no "a clock lock is active" query (driver 565.90:
    Applications / Default Applications clocks report N/A, there is no Locked-clocks field).
    Comparing clocks.sm against clocks.max.sm does NOT work either: an RTX 4090 locked with
    -lgc 3120,3120 reads sm=2790 (89%) -- 3120 is the clock-table max the card's voltage curve
    never reaches -- while the same card UNLOCKED with any GPU client open read sm=2535 (81%).
    No ratio threshold separates those reliably.

    So the decision is made from what the writer did, corroborated by the driver:
      1. gpu_rt_config.ps1 -Apply writes a LOCK RECORD after a successful lock: boot time, GPU
         UUID, driver version, targets. A lock is driver state that a reboot or a driver
         (re)install clears -- so the record only counts if the boot time, GPU and driver
         version all still match.
      2. The driver must agree: the gpu_idle clock-event reason must NOT be active. Under a
         min=max lock the idle limiter cannot drop the clock; on an unlocked idle GPU it is the
         reason that is active. (This also catches an out-of-band unlock such as nvidia-smi -rgc
         or tools\unlock_gpu_clock.bat while the GPU is idle.)
#>

$GpuClockStateDir  = Join-Path $env:ProgramData 'Pianoid'
$GpuLockRecordFile = Join-Path $GpuClockStateDir 'gpu_clock_lock.json'

# Bit 0 of clocks_event_reasons.active = gpu_idle (nvidia-smi --help-query-gpu).
$GPU_IDLE_REASON_BIT = 0x1

function Get-NvidiaSmi {
    # PIANOID_NVIDIA_SMI: explicit path (non-standard installs; the test suite's mock).
    if ($env:PIANOID_NVIDIA_SMI) {
        if (Test-Path $env:PIANOID_NVIDIA_SMI) { return $env:PIANOID_NVIDIA_SMI }
        return $null
    }
    $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @((Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
                     (Join-Path ${env:ProgramFiles} 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'))) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

function Invoke-Smi {
    # Run nvidia-smi with a hard timeout. nvidia-smi can block indefinitely inside NVML (driver
    # busy / resetting / mid clock change); an unbounded call is what can freeze the launch.
    # Returns @{ ExitCode; Output; TimedOut }. On timeout the child is killed (best effort).
    param([string]$Smi, [string[]]$Arguments, [int]$TimeoutMs = 10000)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $Smi
    $psi.Arguments              = ($Arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return [pscustomobject]@{ ExitCode = -1; Output = "$_"; TimedOut = $false }
    }
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) {
        try { $p.Kill() } catch { }
        return [pscustomobject]@{ ExitCode = -1; Output = "nvidia-smi timed out after $TimeoutMs ms"; TimedOut = $true }
    }
    $p.WaitForExit()   # flush the async readers
    [pscustomobject]@{ ExitCode = $p.ExitCode; Output = ($out.Result + $err.Result).Trim(); TimedOut = $false }
}

function Get-BootTime {
    # Round-trip string of the last boot; a clock lock never survives a reboot.
    (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o')
}

function Get-GpuLiveState {
    # One bounded query. Returns $null when nvidia-smi is unusable (missing field, error, hang).
    param([string]$Smi, [int]$TimeoutMs = 10000)
    $r = Invoke-Smi -Smi $Smi -TimeoutMs $TimeoutMs -Arguments @(
        '--query-gpu=uuid,driver_version,clocks.sm,clocks.max.sm,clocks_event_reasons.active',
        '--format=csv,noheader,nounits')
    if ($r.ExitCode -ne 0) { return $null }
    $f = (($r.Output -split "`r?`n")[0] -split ',').Trim()
    if ($f.Count -lt 5) { return $null }
    try {
        [pscustomobject]@{
            Uuid       = $f[0]
            Driver     = $f[1]
            SmMhz      = [int]$f[2]
            SmMaxMhz   = [int]$f[3]
            IdleActive = (([Convert]::ToUInt64($f[4], 16) -band $GPU_IDLE_REASON_BIT) -ne 0)
        }
    } catch { $null }
}

function Read-GpuLockRecord {
    if (-not (Test-Path $GpuLockRecordFile)) { return $null }
    try { Get-Content -Raw -Path $GpuLockRecordFile | ConvertFrom-Json } catch { $null }
}

function Write-GpuLockRecord {
    # Writer: gpu_rt_config.ps1 -Apply only, after the graphics clock lock succeeded.
    param([pscustomobject]$Live, [int]$SmTargetMhz, [int]$MemTargetMhz)
    if (-not (Test-Path $GpuClockStateDir)) { New-Item -ItemType Directory -Path $GpuClockStateDir -Force | Out-Null }
    [pscustomobject]@{
        BootTime     = Get-BootTime
        GpuUuid      = $Live.Uuid
        Driver       = $Live.Driver
        SmTargetMhz  = $SmTargetMhz
        MemTargetMhz = $MemTargetMhz
        AppliedAt    = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -Path $GpuLockRecordFile -Encoding utf8
}

function Remove-GpuLockRecord {
    # Writer: gpu_rt_config.ps1 -Reset only.
    if (Test-Path $GpuLockRecordFile) { Remove-Item -Path $GpuLockRecordFile -Force }
}

function Test-GpuClockLocked {
    # Returns @{ Locked; Reason; Live } -- or $null when the state cannot be determined
    # (nvidia-smi unusable), which callers treat as "do nothing".
    param([string]$Smi, [int]$TimeoutMs = 10000)
    $live = Get-GpuLiveState -Smi $Smi -TimeoutMs $TimeoutMs
    if (-not $live) { return $null }
    try { $boot = Get-BootTime } catch { return $null }
    $rec = Read-GpuLockRecord
    $why = $null
    if (-not $rec)                                { $why = 'no clock lock has been applied by Pianoid' }
    elseif ($rec.BootTime -ne $boot)              { $why = 'Windows has restarted since the clocks were locked' }
    elseif ($rec.GpuUuid -ne $live.Uuid)          { $why = 'the lock was applied to a different GPU' }
    elseif ($rec.Driver -ne $live.Driver)         { $why = 'the NVIDIA driver has changed since the clocks were locked' }
    elseif ($live.IdleActive)                     { $why = 'the driver is idling the GPU down (the lock was cleared)' }
    [pscustomobject]@{ Locked = (-not $why); Reason = $why; Live = $live }
}
