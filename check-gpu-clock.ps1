<#
.SYNOPSIS
    Pre-launch check: are the NVIDIA GPU clocks locked for low-latency audio?
    If not, offer to fix it (one UAC prompt). Never blocks the launch.

.DESCRIPTION
    Called by start-pianoid.bat before launching Pianoid, alongside check-cuda.ps1 /
    check-updates.ps1 / check-running-servers.ps1, and follows the same best-effort
    contract as those: anything unexpected -> fall through silently and let Pianoid launch.

    WHY
    ---
    Pianoid's synthesis kernel is a short, periodic, latency-sensitive workload on the audio-
    callback cadence. The NVIDIA driver's boost heuristics do not read that as load worth
    boosting for -- measured on this machine with the engine running at 77-84% utilization,
    the GPU sat at 1110-1245 MHz against a 3120 MHz max (~38% of ceiling) on ~74 W of a 450 W
    budget, with the `gpu_idle` clock-event reason ACTIVE (the driver's idle limiter dropping
    clocks *while the engine was busy*). That makes each synthesis cycle ~2.6x slower than the
    hardware allows, cycles miss their deadline, and you hear dropouts.

    Locking the clocks to max fixes it. But a clock lock is DRIVER state: every Windows reboot
    clears it, which is why the dropouts come back after a restart. (`nvidia-smi -pm 1` does not
    help -- persistence mode is a Tesla/TCC feature and reports [N/A] on GeForce/WDDM.)

    Rather than pin the GPU to max clock 24/7 via a boot task -- which would burn power and spin
    fans on a machine that is mostly idle -- this check re-applies the lock at LAUNCH time, so
    the lock is scoped to when Pianoid is actually being used, and any reset is caught by the
    next launch. See docs/guides/STARTUP_TROUBLESHOOTING.md#gpu-clock-lock.

    BEHAVIOUR
    ---------
      clocks already locked  -> silent no-op, zero prompts, ~100 ms. (The common case.)
      clocks not locked      -> explain WHY on the console, then ONE UAC prompt; on approval the
                                clocks are locked and the launch proceeds.
      user declines the UAC  -> warn that dropouts are likely, LAUNCH ANYWAY (degraded, running).
      anything else fails    -> silent fall-through, launch proceeds.

    It NEVER blocks the launch: it never returns the abort code (30) that start-pianoid.bat
    honours for the CUDA check. Pianoid always starts.

    OPT-OUT: set PIANOID_SKIP_GPU_CLOCK_CHECK=1 to disable this check entirely (for someone who
    deliberately wants stock dynamic-boost behaviour and does not want to be asked again).

.PARAMETER Auto
    Set by start-pianoid.bat under /auto (the desktop shortcut). Reserved for symmetry with the
    sibling checks; this check behaves identically either way, because its only interaction is
    the UAC prompt itself -- which is a real Windows dialog the user can always dismiss, so it
    can never hang a headless launch the way a scripted pop-up could.
#>
[CmdletBinding()]
param(
    [switch]$Auto
)

# Best-effort by contract: never let this check take down the launch.
$ErrorActionPreference = 'Continue'

# A locked GPU holds (at or within boost-bin rounding of) its ceiling even at idle -- that is
# exactly what the lock does, and it is what makes this a reliable discriminator at launch time,
# when Pianoid is not yet running and an UNLOCKED card would be sitting far down at idle clocks.
# nvidia-smi exposes no direct "is a clock lock active" query on GeForce, so this is the check.
$LOCKED_FRACTION = 0.95

$WORKER = Join-Path $PSScriptRoot 'tools\gpu_rt_config.ps1'

function Fall-Through {
    # The best-effort exit: say nothing, change nothing, let Pianoid launch.
    exit 0
}

if ($env:PIANOID_SKIP_GPU_CLOCK_CHECK -eq '1') { Fall-Through }
if (-not (Test-Path $WORKER)) { Fall-Through }

# --- Is nvidia-smi even here? (No GPU / no driver -> not our problem; check-cuda.ps1 owns that.)
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) {
    foreach ($c in @((Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
                     (Join-Path ${env:ProgramFiles} 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'))) {
        if (Test-Path $c) { $smi = $c; break }
    }
    if (-not $smi) { Fall-Through }
} else {
    $smi = $smi.Source
}

# --- The check itself: one nvidia-smi call, ~100 ms. -----------------------------------------
try {
    $csv = & $smi --query-gpu=clocks.sm,clocks.max.sm --format=csv,noheader,nounits 2>&1
    if ($LASTEXITCODE -ne 0) { Fall-Through }
    $f = ("$csv" -split ',').Trim()
    $sm    = [int]$f[0]
    $smMax = [int]$f[1]
    if ($smMax -le 0) { Fall-Through }
} catch {
    Fall-Through
}

if ($sm -ge ($smMax * $LOCKED_FRACTION)) {
    # Locked. The common case. Say nothing, cost nothing.
    exit 0
}

# --- Not locked. Explain BEFORE raising UAC. --------------------------------------------------
# A bare, unexplained UAC box appearing because you double-clicked a piano icon is user-hostile.
# The operator must be able to tell what is asking and why, so the reason goes on the console
# first, and only then does the elevation prompt fire.
Write-Host ''
Write-Host '  ----------------------------------------------------------------------'
Write-Host '   Pianoid: GPU clocks are NOT locked for low-latency audio.' -ForegroundColor Yellow
Write-Host ''
Write-Host ("   The GPU is running at {0} MHz of {1} MHz. Windows cleared the clock" -f $sm, $smMax)
Write-Host '   lock on the last restart. Left as-is, the synthesis cycle runs several'
Write-Host '   times slower than the hardware allows and you will hear DROPOUTS.'
Write-Host ''
Write-Host '   Windows will now ask for Administrator permission so Pianoid can lock'
Write-Host '   the clocks. Click YES.' -ForegroundColor Cyan
Write-Host ''
Write-Host '   (Declining is fine - Pianoid will still start, just with likely dropouts.'
Write-Host '    To never be asked again: set PIANOID_SKIP_GPU_CLOCK_CHECK=1)'
Write-Host '  ----------------------------------------------------------------------'
Write-Host ''

# --- Elevate and apply. gpu_rt_config.ps1 is the SOLE writer of GPU clock state. ---------------
try {
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ErrorAction Stop `
        -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', "`"$WORKER`"", '-Apply'
        )
    if ($p.ExitCode -eq 0) {
        # Read the state back from the driver rather than trusting the exit code.
        $csv = & $smi --query-gpu=clocks.sm,clocks.max.sm --format=csv,noheader,nounits 2>&1
        $f = ("$csv" -split ',').Trim()
        if ($LASTEXITCODE -eq 0 -and [int]$f[0] -ge ([int]$f[1] * $LOCKED_FRACTION)) {
            Write-Host ("   GPU clocks LOCKED at {0} MHz. Launching." -f $f[0]) -ForegroundColor Green
            Write-Host ''
        } else {
            Write-Host '   Clock lock did not take effect. Launching anyway (dropouts possible).' -ForegroundColor Yellow
            Write-Host ''
        }
    } else {
        Write-Host '   Could not lock the GPU clocks. Launching anyway (dropouts possible).' -ForegroundColor Yellow
        Write-Host ''
    }
} catch {
    # The user declined the UAC prompt (or elevation is unavailable). That is a legitimate
    # choice, not an error -- warn plainly and get out of the way. NEVER block the app.
    Write-Host '   Administrator permission declined - GPU clocks left unlocked.' -ForegroundColor Yellow
    Write-Host '   Pianoid will start, but expect audio dropouts. To fix later, run:' -ForegroundColor Yellow
    Write-Host '     tools\gpu_rt_config.ps1 -Apply   (from an elevated PowerShell)'
    Write-Host ''
}

# Always proceed to launch, whatever happened above.
exit 0
