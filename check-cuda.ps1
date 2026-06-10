# =========================================================================
# check-cuda.ps1 - pre-launch CUDA device + SM-count sanity check.
#
# Called by start-pianoid.bat before launch. Pianoid's synthesis engine runs
# a COOPERATIVE CUDA kernel: every thread block must run concurrently on the
# GPU, so the block count (= numStrings / NUM_STRINGS_IN_ARRAY = strings / 4)
# must fit within the GPU's cooperative-launch budget (roughly the SM count).
# A full 88-key 58-block preset needs ~58 blocks -> a GPU with < ~60 SMs may
# fail the cooperative launch for full-keyboard presets. See
# docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md (Kernel Grid Layout) and
# docs/historical/technical-notes/COOPERATIVE_KERNEL_LIMITS.md.
#
# This check therefore warns when:
#   * no CUDA device is found        -> APPLY/synthesis will fail (UI still loads);
#   * CUDA is present but BROKEN     -> the runtime/NVML failed to initialise
#                                       ("NVML not found" / driver mismatch / a
#                                       thrown getDeviceCount); APPLY/synthesis
#                                       will fail even though a GPU is visible;
#   * the device has < 60 SMs        -> full-keyboard presets may not run.
# A device with >= 60 SMs proceeds silently.
#
# Detection: PRIMARY = the engine venv's python + cupy (authoritative SM count;
# a thrown device query is captured as a BROKEN signal, distinct from cupy being
# absent). FALLBACK = nvidia-smi, returning present / absent / BROKEN (an NVML
# error or non-zero exit = broken, not just "no device"). If neither can
# determine anything -> skip SILENTLY (best-effort, never block).
#
# The broken-but-present case was the gap that let a wedged-NVML machine launch
# straight into a backend crash: the old probe collapsed a thrown getDeviceCount
# to bare "ERR" (indistinguishable from cupy-missing) and nvidia-smi's NVML error
# to "no device"/unknown, so the only outcomes were "no-device" or silent-skip.
# For a DEEP diagnosis of WHY CUDA is broken, run the sibling diagnose-cuda.ps1.
#
# Contract (exit codes the .bat interprets):
#   30  -> a warning was shown AND the user clicked Cancel  -> .bat ABORTS.
#    0  -> proceed to launch: device present with >= 60 SMs (silent), OR the
#          user clicked Continue on a warning, OR the check could not determine
#          GPU state (skipped silently), OR ANY best-effort failure.
#
# -Auto switch (passed by the .bat when /auto / --no-prompt is set, e.g. the
# desktop shortcut): the two warnings are routed DIFFERENTLY because their
# severity differs:
#   * NO CUDA DEVICE -> SHOW the warning even under -Auto (a missing GPU means
#     APPLY/synthesis will fail - worth a heads-up), but as a TIMED pop-up
#     (WScript.Shell.Popup, 30 s) so a headless launch can't hang; on timeout
#     the default is Continue (the UI still loads).
#   * < 60 SMs -> SUPPRESS under -Auto. It is purely informational and would
#     nag on EVERY desktop-icon launch on a sub-60-SM GPU (e.g. a 56-SM card),
#     so it is shown ONLY on bare/interactive (terminal) runs.
# Bare/interactive runs show BOTH warnings as a normal blocking MessageBox.
#
# DESIGN: BEST-EFFORT - must NEVER hang or error the launch. The whole body is
# wrapped so any unexpected failure falls through to exit 0; the -Auto pop-up
# is time-bounded so it cannot hang a headless launch.
#
# See: start-pianoid.bat (the caller), check-running-servers.ps1 +
#      check-updates.ps1 (sibling pre-launch helpers, same pattern).
# =========================================================================

param(
    [switch] $Auto
)

# Soft error mode: a non-terminating error must not abort the launch.
$ErrorActionPreference = 'SilentlyContinue'

# Below this SM count, full-keyboard (58-block) presets may not fit the
# cooperative launch. 58 blocks for a full 88-key preset + headroom -> 60.
$MinSMCount = 60

# How long the -Auto (timed) no-device pop-up waits for a click before taking
# the safe default (Continue). Bounded so a headless launch never hangs.
$PopupTimeoutSec = 30

$RepoRoot = $PSScriptRoot

# Honour PIANOID_VENV_DIR (Linux NTFS-relocation case); default to
# PianoidCore\.venv on Windows (mirrors start-pianoid.bat).
if ($env:PIANOID_VENV_DIR) {
    $VenvPython = Join-Path $env:PIANOID_VENV_DIR 'Scripts\python.exe'
} else {
    $VenvPython = Join-Path $RepoRoot 'PianoidCore\.venv\Scripts\python.exe'
}

# -------------------------------------------------------------------------
# Query CUDA via the engine venv + cupy. Returns a hashtable:
#   @{ Determined = $true; DeviceCount = <int>; SMCount = <int>; Name = <str> }
# or @{ Determined = $false } if python/cupy is unavailable or the query
# failed (-> caller falls back to nvidia-smi).
#
# The query is read-only - it only inspects device properties, it does NOT
# allocate, launch a kernel, or touch the running engine.
# -------------------------------------------------------------------------
function Get-CudaInfoViaCupy {
    if (-not (Test-Path -LiteralPath $VenvPython)) {
        return @{ Determined = $false }
    }
    # Python probe. Prints ONE of:
    #   "count|sm|name"        - device present, properties read (Determined)
    #   "0|0|none"             - cupy says zero devices (Determined, DeviceCount 0)
    #   "IMPORT_ERR|<msg>"     - cupy not installed / failed to import (NOT broken
    #                            CUDA - just no probe; -> Determined=$false)
    #   "RUNTIME_ERR|<type>|<msg>" - cupy imported but getDeviceCount /
    #                            getDeviceProperties THREW. THIS is the broken-but-
    #                            present signal (e.g. CUDARuntimeError "no
    #                            CUDA-capable device is detected", NVML / driver
    #                            mismatch). The old code collapsed this to bare
    #                            "ERR" -> indistinguishable from cupy-missing ->
    #                            the launch silently proceeded into a backend crash.
    # cupy.cuda.runtime is a thin wrapper over the driver - no GPU work, just
    # property reads. NOTE: this is run from a TEMP FILE, not via `python -c`.
    # Passing a multi-line snippet through `-c` mangles the embedded double
    # quotes in `print("...")` (PowerShell strips them when handing the string
    # to native python.exe -> a Python SyntaxError + empty output). Writing to
    # a file and running `python <file>` is quote-safe and portable.
    $py = @'
import sys
try:
    import cupy
except Exception as e:
    print("IMPORT_ERR|%s" % (str(e)[:200],)); sys.exit(0)
try:
    n = cupy.cuda.runtime.getDeviceCount()
    if n < 1:
        print("0|0|none"); sys.exit(0)
    p = cupy.cuda.runtime.getDeviceProperties(0)
    name = p["name"]
    if isinstance(name, bytes):
        name = name.decode("ascii", "replace")
    print("%d|%d|%s" % (n, p["multiProcessorCount"], name))
except Exception as e:
    print("RUNTIME_ERR|%s|%s" % (type(e).__name__, str(e)[:200]))
'@
    $tmpPy = $null
    try {
        $tmpPy = Join-Path $env:TEMP ("pianoid_cuda_probe_{0}.py" -f ([System.Guid]::NewGuid().ToString('N')))
        Set-Content -Path $tmpPy -Value $py -Encoding ASCII -ErrorAction SilentlyContinue

        # 2>$null suppresses any benign CUDA-init stderr line. The output may be
        # multi-line (a stray banner/warning on stdout, or - under Windows
        # PowerShell 5.1 - a wrapped stderr ErrorRecord); scan each line for the
        # FIRST recognised shape (device line, then RUNTIME_ERR, then IMPORT_ERR).
        $out = & $VenvPython $tmpPy 2>$null
        if ($null -eq $out) { return @{ Determined = $false } }
        $runtimeErr = $null
        foreach ($raw in @($out)) {
            $line = ([string]$raw).Trim()
            if ($line -match '^\d+\|\d+\|') {
                $parts = $line.Split('|')
                if ($parts.Count -lt 3) { continue }
                $count = 0; $sm = 0
                if (-not [int]::TryParse($parts[0], [ref]$count)) { continue }
                if (-not [int]::TryParse($parts[1], [ref]$sm))    { continue }
                # parts[0] and parts[1] are int; name may itself contain '|' so
                # rejoin the remainder.
                $name = ($parts[2..($parts.Count - 1)] -join '|')
                return @{ Determined = $true; DeviceCount = $count; SMCount = $sm; Name = $name }
            }
            elseif ($line -match '^RUNTIME_ERR\|') {
                # cupy imported but the device query threw -> CUDA runtime broken.
                # Remember it but keep scanning (a device line, if any, wins).
                $p2 = $line.Split('|')
                $etype = if ($p2.Count -ge 2) { $p2[1] } else { 'Error' }
                $emsg  = if ($p2.Count -ge 3) { ($p2[2..($p2.Count - 1)] -join '|') } else { '' }
                $runtimeErr = ("{0}: {1}" -f $etype, $emsg).Trim(': ')
            }
            # IMPORT_ERR -> cupy unavailable; treat as "no probe" (Determined=$false),
            # NOT broken. Fall through to the nvidia-smi fallback.
        }
        if ($runtimeErr) {
            return @{ Determined = $false; Broken = $true; Reason = $runtimeErr }
        }
        return @{ Determined = $false }
    } catch {
        return @{ Determined = $false }
    } finally {
        if ($tmpPy -and (Test-Path -LiteralPath $tmpPy)) {
            Remove-Item -LiteralPath $tmpPy -Force -ErrorAction SilentlyContinue
        }
    }
}

# -------------------------------------------------------------------------
# Fallback: query nvidia-smi for GPU availability. Returns a STRING state:
#   'present' -> nvidia-smi ran and listed a GPU.
#   'absent'  -> nvidia-smi ran cleanly but reported NO GPU.
#   'broken'  -> nvidia-smi IS installed but FAILED to run (non-zero exit, or an
#                NVML error in its output, e.g. "NVML library not found" /
#                "Failed to initialize NVML"). This is the broken-but-present
#                signal: the driver/NVML stack is wedged even though a GPU is
#                physically there. The old code returned $false (-> "no device")
#                or $null (-> silent skip) for this, missing it.
#   $null     -> nvidia-smi not installed / output unparseable -> truly unknown.
# stderr is captured (a temp-file redirect, robust under Windows PowerShell 5.1
# which otherwise wraps native stderr into ErrorRecords).
# -------------------------------------------------------------------------
function Test-CudaViaNvidiaSmi {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($null -eq $smi) { return $null }
    $errFile = $null
    try {
        $errFile = Join-Path $env:TEMP ("pianoid_smi_err_{0}.txt" -f ([System.Guid]::NewGuid().ToString('N')))
        $p = Start-Process -FilePath $smi.Source `
            -ArgumentList '--query-gpu=name --format=csv,noheader' `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput ($errFile + '.out') -RedirectStandardError $errFile
        $code = $p.ExitCode
        $so = (Get-Content -LiteralPath ($errFile + '.out') -Raw -ErrorAction SilentlyContinue)
        $se = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
        $combined = (("" + $so) + " " + ("" + $se))
        # An NVML error in the output = broken regardless of exit code.
        if ($combined -match 'NVML' -or $combined -match 'Failed to initialize') { return 'broken' }
        if ($code -ne 0) { return 'broken' }
        if ([string]::IsNullOrWhiteSpace($so)) { return 'absent' }
        return 'present'
    } catch {
        return $null
    } finally {
        if ($errFile) {
            Remove-Item -LiteralPath $errFile, ($errFile + '.out') -Force -ErrorAction SilentlyContinue
        }
    }
}

# -------------------------------------------------------------------------
# Show a CUDA warning and return $true to PROCEED or $false to CANCEL.
# $Kind is 'no-device', 'cuda-broken', or 'low-sm' and drives the -Auto routing:
#
#  * Interactive (no -Auto): a normal BLOCKING MessageBox (OKCancel) for ALL
#    kinds. OK -> proceed, Cancel -> cancel.
#  * -Auto + 'low-sm'  -> SUPPRESSED: return proceed WITHOUT showing anything
#    (purely informational; would nag every icon launch on a sub-60-SM GPU).
#  * -Auto + 'no-device' / 'cuda-broken' -> a TIMED WScript.Shell.Popup
#    (OKCancel, 30 s). OK -> proceed; Cancel -> cancel; timeout (no click) ->
#    proceed (UI still loads). A broken CUDA runtime is as serious as a missing
#    device (APPLY/synthesis will fail either way), so it is shown, not suppressed.
# -------------------------------------------------------------------------
function Show-CudaWarning {
    param(
        [string] $Message,
        [ValidateSet('no-device', 'cuda-broken', 'low-sm')] [string] $Kind
    )

    # -Auto + low-sm: suppress entirely (no console line, no pop-up).
    if ($Auto -and $Kind -eq 'low-sm') { return $true }

    Write-Host "WARNING (CUDA check):"
    Write-Host ("  " + ($Message -replace "`n", "`n  "))

    if ($Auto) {
        # Only 'no-device' / 'cuda-broken' reach here under -Auto -> timed pop-up.
        # WScript.Shell.Popup button codes: 1 = OK/Cancel, 48 = Warning icon.
        # Returns 1 = OK, 2 = Cancel, -1 = timed out (no click).
        try {
            $wshell = New-Object -ComObject WScript.Shell
            $rc = $wshell.Popup(
                ($Message + "`n`n(Auto-launch: continues in $PopupTimeoutSec s.)"),
                $PopupTimeoutSec, 'Pianoid - CUDA check', (1 + 48))
            if ($rc -eq 2) { return $false }   # Cancel
            return $true                        # OK (1) or timeout (-1) -> proceed
        } catch {
            # COM unavailable -> proceed (informational; UI still loads).
            return $true
        }
    }

    # Interactive: blocking dialog (both kinds).
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $full = $Message + "`n`n[OK] Continue launching`n[Cancel] Abort the launch"
    $result = [System.Windows.Forms.MessageBox]::Show(
        $full, 'Pianoid - CUDA check',
        [System.Windows.Forms.MessageBoxButtons]::OKCancel,
        [System.Windows.Forms.MessageBoxIcon]::Warning)
    return ($result -eq [System.Windows.Forms.DialogResult]::OK)
}

# =========================================================================
# Main - fully wrapped so ANY failure falls through to exit 0 (launch).
# =========================================================================
try {
    $info = Get-CudaInfoViaCupy

    if ($info.Determined) {
        # Authoritative path (cupy gave us device count + SM count).
        if ($info.DeviceCount -lt 1) {
            $proceed = Show-CudaWarning -Kind 'no-device' -Message ("No CUDA device found - Pianoid's GPU synthesis needs an NVIDIA GPU.`n" +
                "The UI will load in LIMITED mode: loading a GPU preset (APPLY) is disabled, but the Modal Adapter still works on CPU.")
            if (-not $proceed) { exit 30 }
            exit 0
        }
        if ($info.SMCount -lt $MinSMCount) {
            # NB: wrap the whole concatenation in parens BEFORE -f; the -f
            # operator binds tighter than +, so without the parens it would
            # only format the last literal (and drop the args).
            $smMsg = ("GPU '{0}' has {1} SMs (< {2}).`n" +
                "Full-keyboard presets may not run - the synthesis engine's cooperative kernel launch needs one block per 4 strings (a full 88-key preset = ~58 blocks), which can exceed the SM count.`n" +
                "Use a reduced-keyboard preset (e.g. the *_56SM variants) if APPLY fails.") -f $info.Name, $info.SMCount, $MinSMCount
            # 'low-sm' is suppressed under -Auto (informational) and shown only
            # on bare/interactive runs.
            $proceed = Show-CudaWarning -Kind 'low-sm' -Message $smMsg
            if (-not $proceed) { exit 30 }
            exit 0
        }
        # Device present and >= 60 SMs -> all good, proceed silently.
        exit 0
    }

    # cupy imported but the device query THREW (broken-but-present CUDA runtime,
    # e.g. NVML not found / driver mismatch). This is the most decisive signal -
    # it is the exact runtime the engine uses - so warn (was: silently skipped).
    if ($info.Broken) {
        $reason = if ($info.Reason) { "`nDetail: " + $info.Reason } else { "" }
        $proceed = Show-CudaWarning -Kind 'cuda-broken' -Message ("CUDA is installed but NOT working - the GPU runtime failed to initialise." + $reason + "`n" +
            "The UI will load in LIMITED mode: loading a GPU preset (APPLY) is disabled, but the Modal Adapter still works on CPU.`n" +
            "Run  diagnose-cuda.ps1  for a full diagnosis (device / driver / NVML / PATH).")
        if (-not $proceed) { exit 30 }
        exit 0
    }

    # cupy path could not determine -> fall back to nvidia-smi.
    $smiState = Test-CudaViaNvidiaSmi
    if ($smiState -eq 'absent') {
        $proceed = Show-CudaWarning -Kind 'no-device' -Message ("No CUDA device found (nvidia-smi reports no GPU) - Pianoid's GPU synthesis needs an NVIDIA GPU.`n" +
            "The UI will load in LIMITED mode: loading a GPU preset (APPLY) is disabled, but the Modal Adapter still works on CPU.")
        if (-not $proceed) { exit 30 }
        exit 0
    }
    if ($smiState -eq 'broken') {
        # nvidia-smi is installed but fails (NVML not found / init failure): the
        # GPU may be physically present but the driver/NVML stack is wedged.
        $proceed = Show-CudaWarning -Kind 'cuda-broken' -Message ("The NVIDIA driver/NVML is not working (nvidia-smi failed - e.g. 'NVML not found').`n" +
            "A GPU may be present, but Pianoid's GPU synthesis cannot use it: the UI will load in LIMITED mode (loading a GPU preset / APPLY is disabled; the Modal Adapter still works on CPU).`n" +
            "This is usually a DRIVER problem (reinstall/repair the NVIDIA display driver), NOT the CUDA toolkit.`n" +
            "Run  diagnose-cuda.ps1  for a full diagnosis (device / driver / NVML / PATH).")
        if (-not $proceed) { exit 30 }
        exit 0
    }

    # $smiState is 'present' (GPU present, SM count unknown - proceed) OR $null
    # (nvidia-smi missing / unparseable AND cupy unavailable = truly cannot
    # determine) -> skip silently per the best-effort contract.
    exit 0
}
catch {
    # Best-effort: never let an unexpected failure block the launch.
    exit 0
}
