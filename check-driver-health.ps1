# =========================================================================
# check-driver-health.ps1 - caller-branchable NVIDIA DISPLAY-DRIVER health check.
#
# PURPOSE
#   Answer ONE question for a calling script (setup-packages / setup-dev.ps1):
#   "does the NVIDIA DISPLAY DRIVER need (re)installation?" - via an EXIT CODE
#   a .bat / .ps1 can branch on. This is the "if needed" gate behind making
#   setup-packages offer a driver reinstall.
#
# WHY A SEPARATE CHECK (vs the two existing scripts):
#   * diagnose-cuda.ps1 is the deep READ-ONLY diagnostic - rich, but it prints a
#     human verdict (exit 0 always); it gives a CALLER nothing to branch on.
#   * check-cuda.ps1 is the pre-launch gate, but it only answers device-present /
#     SM-count - NOT driver-LIBRARY health (missing/mismatched nvml.dll/nvcuda.dll).
#   This helper fills exactly that gap: the DRIVER-side health, as an exit code.
#   It deliberately does NOT re-do the cupy / SM-count logic (that is check-cuda's
#   job) and points the user at diagnose-cuda.ps1 for the full report.
#
# WHY THE DRIVER, NOT THE TOOLKIT (the incident this exists for):
#   nvml.dll + nvcuda.dll are DISPLAY-DRIVER components (System32, version-locked
#   to the installed driver). setup-packages reinstalls the CUDA *toolkit*, which
#   never touches them - so a "driver reinstall via setup-packages" does NOT fix
#   an "NVML not found" / "driver/library version mismatch". This check detects
#   that case so the caller can guide the user to the REAL fix (the display driver).
#
# DESIGN: READ-ONLY + BEST-EFFORT. It only inspects WMI / the registry / files /
#   nvidia-smi; it NEVER installs, modifies, or launches a kernel. Every probe is
#   wrapped so an unexpected failure falls through to exit 0 (proceed) rather than
#   blocking the caller. Pure-ASCII (callable from a UTF-8-no-BOM context).
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File check-driver-health.ps1
#   -Quiet : suppress the human-readable report; only set the exit code + print one
#            machine-readable "VERDICT=<token>" line (for a calling script).
#
# EXIT CODES (the contract a caller branches on):
#    0  -> driver HEALTHY, OR the check could not determine state (best-effort
#          skip), OR any probe failure. Caller proceeds; no driver action needed.
#   10  -> driver NEEDS ATTENTION: kernel driver (nvlddmkm) missing, OR nvml.dll /
#          nvcuda.dll missing-or-version-mismatched, OR nvidia-smi NVML error.
#          Caller should surface the toolkit-vs-driver guidance / offer a reinstall.
#   20  -> NO NVIDIA GPU detected by Windows at all (WMI). Distinct from 10: there
#          is nothing to (re)install a driver *for* until a card is present/enabled.
#
# VERDICT tokens (printed as "VERDICT=<token>", greppable; one per run):
#   healthy | driver-needs-attention | no-gpu | unknown
#
# See: diagnose-cuda.ps1 (deep read-only diagnostic - run it for full detail),
#      check-cuda.ps1 (device/SM pre-launch gate),
#      docs/proposals/setup-packages-driver-reinstall-2026-06-10.md (the design),
#      docs/guides/STARTUP_TROUBLESHOOTING.md (CUDA/GPU failures).
# =========================================================================

param(
    [switch] $Quiet
)

# Best-effort everywhere: a non-terminating error must never abort the caller.
$ErrorActionPreference = 'SilentlyContinue'

# ---- console helpers (suppressed under -Quiet) --------------------------
function Say {
    param([string] $Text)
    if (-not $Quiet) { Write-Host $Text }
}

# Normalise an NVIDIA version string to the "XXX.YY" driver form. Both WMI's
# DriverVersion (e.g. 32.0.15.6094) and nvml.dll's FileVersion (e.g. 8.17.15.6094)
# encode the NVIDIA driver in their LAST 5 DIGITS (...56094 -> 560.94), regardless
# of the differing leading parts. Strip non-digits, read the last 5. Returns $null
# when fewer than 5 digits are present (so a non-NVIDIA string never produces a
# bogus comparison). Mirrors diagnose-cuda.ps1's Get-NvDriverShort.
function Get-NvDriverShort {
    param([string] $Version)
    if ([string]::IsNullOrWhiteSpace($Version)) { return $null }
    $digits = ($Version -replace '[^\d]', '')
    if ($digits.Length -ge 5) {
        $last5 = $digits.Substring($digits.Length - 5)
        return ("{0}.{1}" -f $last5.Substring(0, 3), $last5.Substring(3, 2))
    }
    return $null
}

# Emit the final verdict (one machine-readable line always; exit code) and stop.
function Resolve-Verdict {
    param(
        [ValidateSet('healthy', 'driver-needs-attention', 'no-gpu', 'unknown')] [string] $Token,
        [int] $Code
    )
    Write-Host ("VERDICT={0}" -f $Token)
    exit $Code
}

# =========================================================================
# Main - fully wrapped so ANY failure falls through to exit 0 (proceed).
# =========================================================================
try {
    Say ''
    Say '=== NVIDIA display-driver health check ==='

    # ---- 1. GPU present? (WMI - works even when NVML/CUDA are broken) ----
    $driverShort = $null
    $driverRaw   = $null
    $nvGpus = @()
    try {
        $allGpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
        $nvGpus = @($allGpus | Where-Object { $_.Name -match 'NVIDIA' -or $_.AdapterCompatibility -match 'NVIDIA' })
    } catch { }

    if ($nvGpus.Count -eq 0) {
        Say '  [INFO] No NVIDIA GPU reported by Windows (WMI).'
        Say '         There is no display driver to (re)install until a card is present/enabled.'
        Resolve-Verdict -Token 'no-gpu' -Code 20
    }

    $gpu0 = $nvGpus[0]
    $driverRaw = $gpu0.DriverVersion
    $driverShort = Get-NvDriverShort $driverRaw
    $drvLabel = if ($driverShort) { "v$driverShort" } else { 'version unreadable' }
    Say ("  [INFO] GPU: {0} | display driver {1} (raw {2})" -f $gpu0.Name, $drvLabel, $driverRaw)

    # Accumulate the reasons the driver needs attention.
    $problems = New-Object System.Collections.ArrayList

    # ---- 2. NVIDIA kernel driver service (nvlddmkm) installed at OS level? ----
    $nvlddmkmOk = $false
    try {
        $svc = Get-CimInstance Win32_SystemDriver -Filter "Name='nvlddmkm'" -ErrorAction SilentlyContinue
        if ($svc) {
            $nvlddmkmOk = $true
            Say ("  [ OK ] nvlddmkm kernel driver present (State={0})." -f $svc.State)
        } elseif (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\nvlddmkm') {
            Say '  [WARN] nvlddmkm registry key exists but service object not returned (driver may be partial).'
            [void]$problems.Add('nvlddmkm service not fully present (driver may be partially installed)')
        } else {
            Say '  [FAIL] nvlddmkm NVIDIA kernel driver service NOT found - the display driver is not installed.'
            [void]$problems.Add('NVIDIA kernel driver (nvlddmkm) not installed')
        }
    } catch { }

    # ---- 3. nvml.dll in System32 - present + version-matched to the driver? ----
    try {
        $sys32Nvml = Join-Path $env:SystemRoot 'System32\nvml.dll'
        if (Test-Path -LiteralPath $sys32Nvml) {
            $nvmlRaw = (Get-Item -LiteralPath $sys32Nvml).VersionInfo.FileVersion
            $nvmlShort = Get-NvDriverShort $nvmlRaw
            if ($nvmlShort -and $driverShort -and ($nvmlShort -ne $driverShort)) {
                Say ("  [FAIL] nvml.dll VERSION MISMATCH: System32 v{0} != driver v{1} -> present but UNLOADABLE." -f $nvmlShort, $driverShort)
                [void]$problems.Add(("System32 nvml.dll v{0} does not match the display driver v{1} (mismatch -> 'NVML not found')" -f $nvmlShort, $driverShort))
            } else {
                Say ("  [ OK ] nvml.dll present in System32 (v{0})." -f $(if ($nvmlShort) { $nvmlShort } else { $nvmlRaw }))
            }
        } else {
            Say '  [FAIL] nvml.dll MISSING from System32 -> NVML clients report "NVML not found".'
            [void]$problems.Add('nvml.dll missing from System32 (a DISPLAY-DRIVER file)')
        }
    } catch { }

    # ---- 3d. nvcuda.dll in System32 - present + version-matched? ----
    try {
        $sys32Nvcuda = Join-Path $env:SystemRoot 'System32\nvcuda.dll'
        if (Test-Path -LiteralPath $sys32Nvcuda) {
            $nvcRaw = (Get-Item -LiteralPath $sys32Nvcuda).VersionInfo.FileVersion
            $nvcShort = Get-NvDriverShort $nvcRaw
            if ($nvcShort -and $driverShort -and ($nvcShort -ne $driverShort)) {
                Say ("  [FAIL] nvcuda.dll VERSION MISMATCH: System32 v{0} != driver v{1} -> CUDA Driver API out of sync." -f $nvcShort, $driverShort)
                [void]$problems.Add(("System32 nvcuda.dll v{0} does not match the display driver v{1} (mismatch -> cupy 'no CUDA-capable device')" -f $nvcShort, $driverShort))
            } else {
                Say ("  [ OK ] nvcuda.dll present in System32 (v{0})." -f $(if ($nvcShort) { $nvcShort } else { $nvcRaw }))
            }
        } else {
            Say '  [FAIL] nvcuda.dll MISSING from System32 -> CUDA Driver API absent.'
            [void]$problems.Add('nvcuda.dll missing from System32 (a DISPLAY-DRIVER file)')
        }
    } catch { }

    # ---- 4. nvidia-smi - run it, catch an NVML error (the user-visible symptom) ----
    #   Locate it (PATH, then System32 / NVSMI). Run via a temp-file redirect so a
    #   native NVML error is captured cleanly under Windows PowerShell 5.1.
    try {
        $smiPath = $null
        $smiCmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
        if ($smiCmd) {
            $smiPath = $smiCmd.Source
        } else {
            foreach ($cand in @((Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
                                (Join-Path ${env:ProgramFiles} 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'))) {
                if (Test-Path -LiteralPath $cand) { $smiPath = $cand; break }
            }
        }
        if ($smiPath) {
            $outFile = Join-Path $env:TEMP ("pianoid_drv_smi_out_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
            $errFile = Join-Path $env:TEMP ("pianoid_drv_smi_err_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
            try {
                $p = Start-Process -FilePath $smiPath -ArgumentList '--query-gpu=driver_version --format=csv,noheader' `
                    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
                $so = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue)
                $se = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
                if ($p.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($so)) {
                    Say ("  [ OK ] nvidia-smi works (reports driver {0})." -f ($so.Trim() -replace "`r?`n", ' '))
                } else {
                    $msg = $se; if ([string]::IsNullOrWhiteSpace($msg)) { $msg = $so }
                    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = '(no output)' }
                    Say ("  [FAIL] nvidia-smi failed (exit {0}): {1}" -f $p.ExitCode, ($msg.Trim() -replace "`r?`n", ' / '))
                    if ($msg -match 'NVML' -or $msg -match 'driver/library version mismatch' -or $msg -match 'version mismatch') {
                        [void]$problems.Add('nvidia-smi reports an NVML error (driver-side library problem)')
                    }
                }
            } finally {
                Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
            }
        } else {
            # nvidia-smi absent but a GPU exists: only a *problem signal* when the
            # kernel driver is also absent (otherwise it may just not be on PATH;
            # the System32/NVSMI fallback above already tried the standard spots).
            if (-not $nvlddmkmOk) {
                Say '  [WARN] nvidia-smi not found and nvlddmkm absent -> driver not (fully) installed.'
            } else {
                Say '  [INFO] nvidia-smi not located on PATH or standard locations (informational).'
            }
        }
    } catch { }

    # ---- Verdict ----
    Say ''
    if ($problems.Count -gt 0) {
        Say '  VERDICT: the NVIDIA DISPLAY DRIVER needs attention.'
        foreach ($pr in $problems) { Say ("    - {0}" -f $pr) }
        Say ''
        Say '  *** TOOLKIT vs DRIVER (read this) ***'
        Say '  setup-packages reinstalls the CUDA TOOLKIT - it does NOT reinstall the display driver and'
        Say '  will NOT fix nvml.dll / nvcuda.dll (those are DISPLAY-DRIVER files). Reinstall the NVIDIA'
        Say '  display driver instead (NVIDIA App / nvidia.com), then reboot. A reboot ALONE often clears a'
        Say '  "driver/library version mismatch" after a driver update. Run diagnose-cuda.ps1 for full detail.'
        Resolve-Verdict -Token 'driver-needs-attention' -Code 10
    }

    Say '  VERDICT: NVIDIA display driver looks healthy (GPU + nvlddmkm + nvml/nvcuda + nvidia-smi all OK).'
    Resolve-Verdict -Token 'healthy' -Code 0
}
catch {
    # Best-effort: never let an unexpected failure block the caller.
    Write-Host 'VERDICT=unknown'
    exit 0
}
