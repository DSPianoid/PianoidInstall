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
      apply takes too long   -> after WORKER_TIMEOUT_SEC, say so and LAUNCH ANYWAY.
      anything else fails    -> silent fall-through, launch proceeds (nvidia-smi missing,
                                erroring or hung: every call is bounded, see gpu_clock_state.ps1).

    "Locked" is decided by Test-GpuClockLocked (tools/gpu_clock_state.ps1): the lock record the
    worker writes after a successful lock, valid for this boot / GPU / driver, corroborated by the
    driver's gpu_idle clock-event reason. It is NOT a clock ratio -- a locked RTX 4090 reads
    2790 of 3120 MHz, which the old 95%-of-max test misread as "not locked" on every launch.

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

# Upper bound on the elevated apply, counted from UAC approval. A normal apply takes ~1 s; the
# launch must never wait on it indefinitely (2026-10-16: an unbounded -Wait froze the launcher).
$WORKER_TIMEOUT_SEC = 20

$WORKER = Join-Path $PSScriptRoot 'tools\gpu_rt_config.ps1'
$STATE  = Join-Path $PSScriptRoot 'tools\gpu_clock_state.ps1'

function Fall-Through {
    # The best-effort exit: say nothing, change nothing, let Pianoid launch.
    exit 0
}

if ($env:PIANOID_SKIP_GPU_CLOCK_CHECK -eq '1') { Fall-Through }
if (-not (Test-Path $WORKER) -or -not (Test-Path $STATE)) { Fall-Through }
try { . $STATE } catch { Fall-Through }

# --- Is nvidia-smi even here? (No GPU / no driver -> not our problem; check-cuda.ps1 owns that.)
$smi = Get-NvidiaSmi
if (-not $smi) { Fall-Through }

# --- The check itself: one bounded nvidia-smi call + the lock record, ~300 ms. ----------------
try { $lock = Test-GpuClockLocked -Smi $smi -TimeoutMs 5000 } catch { Fall-Through }
if (-not $lock) { Fall-Through }     # nvidia-smi errored or hung -> not decidable, launch.

if ($lock.Locked) {
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
Write-Host ("   Reason: {0}." -f $lock.Reason)
Write-Host '   Left as-is, the driver downclocks the GPU under Pianoid''s load, the synthesis'
Write-Host '   cycle runs several times slower than the hardware allows, and you will hear DROPOUTS.'
Write-Host ''
Write-Host '   Windows will now ask for Administrator permission so Pianoid can lock'
Write-Host '   the clocks. Click YES.' -ForegroundColor Cyan
Write-Host ''
Write-Host '   (Declining is fine - Pianoid will still start, just with likely dropouts.'
Write-Host '    To never be asked again: set PIANOID_SKIP_GPU_CLOCK_CHECK=1)'
Write-Host '  ----------------------------------------------------------------------'
Write-Host ''

# --- Elevate and apply. gpu_rt_config.ps1 is the SOLE writer of GPU clock state. ---------------
# Hidden window: no console for a stray click to freeze (QuickEdit), and nothing to close by hand.
# Bounded wait, never -Wait: if the worker hangs, the launch goes ahead and the worker is left to
# finish or die on its own (an elevated process cannot be killed from here).
try {
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop `
        -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', "`"$WORKER`"", '-Apply'
        )
    if (-not $p.WaitForExit($WORKER_TIMEOUT_SEC * 1000)) {
        Write-Host ("   The clock-lock tool did not finish within {0} s. Launching anyway" -f $WORKER_TIMEOUT_SEC) -ForegroundColor Yellow
        Write-Host ("   (dropouts possible). Details: {0}" -f (Join-Path $env:ProgramData 'Pianoid\gpu_rt_config.log'))
        Write-Host ''
    } elseif ($p.ExitCode -eq 0) {
        # Re-check rather than trusting the exit code.
        $after = Test-GpuClockLocked -Smi $smi -TimeoutMs 5000
        if ($after -and $after.Locked) {
            Write-Host ("   GPU clocks LOCKED (now {0} MHz). Launching." -f $after.Live.SmMhz) -ForegroundColor Green
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
