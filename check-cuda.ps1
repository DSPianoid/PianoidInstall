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
#   * no CUDA device is found  -> APPLY/synthesis will fail (UI still loads);
#   * the device has < 60 SMs   -> full-keyboard presets may not run.
# A device with >= 60 SMs proceeds silently.
#
# Detection: PRIMARY = the engine venv's python + cupy (authoritative SM
# count). FALLBACK (availability only, if cupy/python missing) = nvidia-smi.
# If neither can determine anything -> skip SILENTLY (best-effort, never block).
#
# Contract (exit codes the .bat interprets):
#   30  -> a warning was shown AND the user clicked Cancel  -> .bat ABORTS.
#    0  -> proceed to launch: device present with >= 60 SMs (silent), OR the
#          user clicked Continue on a warning, OR the check could not determine
#          GPU state (skipped silently), OR ANY best-effort failure.
#
# -Auto switch (passed by the .bat when /auto / --no-prompt is set): run
# non-interactively. The CUDA warnings are INFORMATIONAL (the UI loads either
# way), so in -Auto we print the warning to the console and PROCEED (exit 0) -
# never block an unattended shortcut launch on an info pop-up.
#
# DESIGN: BEST-EFFORT - must NEVER block, hang, or error the launch. The whole
# body is wrapped so any unexpected failure falls through to exit 0.
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
    # Python probe printing "count|sm|name" (or "ERR" on any exception).
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
    n = cupy.cuda.runtime.getDeviceCount()
    if n < 1:
        print("0|0|none"); sys.exit(0)
    p = cupy.cuda.runtime.getDeviceProperties(0)
    name = p["name"]
    if isinstance(name, bytes):
        name = name.decode("ascii", "replace")
    print("%d|%d|%s" % (n, p["multiProcessorCount"], name))
except Exception:
    print("ERR")
'@
    $tmpPy = $null
    try {
        $tmpPy = Join-Path $env:TEMP ("pianoid_cuda_probe_{0}.py" -f ([System.Guid]::NewGuid().ToString('N')))
        Set-Content -Path $tmpPy -Value $py -Encoding ASCII -ErrorAction SilentlyContinue

        # 2>$null suppresses any benign CUDA-init stderr line. The output may be
        # multi-line (a stray banner/warning on stdout, or - under Windows
        # PowerShell 5.1 - a wrapped stderr ErrorRecord); scan for the FIRST
        # line matching the expected "count|sm|name" shape and ignore the rest.
        $out = & $VenvPython $tmpPy 2>$null
        if ($null -eq $out) { return @{ Determined = $false } }
        foreach ($raw in @($out)) {
            $line = ([string]$raw).Trim()
            if ($line -notmatch '^\d+\|\d+\|') { continue }
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
# Fallback: is ANY NVIDIA GPU present per nvidia-smi? Availability only -
# nvidia-smi does not report the SM count in a stable parseable form here, so
# this only answers "device present yes/no". Returns $true / $false / $null
# ($null = nvidia-smi missing or unparseable -> unknown).
# -------------------------------------------------------------------------
function Test-CudaViaNvidiaSmi {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($null -eq $smi) { return $null }
    try {
        $out = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
        if ([string]::IsNullOrWhiteSpace(($out | Out-String))) { return $false }
        return $true
    } catch {
        return $null
    }
}

# -------------------------------------------------------------------------
# Show a warning pop-up (interactive) or print it (-Auto). Returns $true to
# PROCEED, $false to CANCEL. In -Auto always proceeds (informational).
# -------------------------------------------------------------------------
function Show-CudaWarning {
    param([string] $Message)

    Write-Host "WARNING (CUDA check):"
    Write-Host ("  " + ($Message -replace "`n", "`n  "))

    if ($Auto) {
        Write-Host "  /auto mode: informational - proceeding."
        return $true
    }

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
            $proceed = Show-CudaWarning -Message ("No CUDA device found - Pianoid's synthesis engine needs an NVIDIA GPU.`n" +
                "The UI will load, but APPLY / synthesis will fail.")
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
            $proceed = Show-CudaWarning -Message $smMsg
            if (-not $proceed) { exit 30 }
            exit 0
        }
        # Device present and >= 60 SMs -> all good, proceed silently.
        exit 0
    }

    # cupy path failed -> fall back to nvidia-smi for AVAILABILITY only.
    $present = Test-CudaViaNvidiaSmi
    if ($present -eq $false) {
        $proceed = Show-CudaWarning -Message ("No CUDA device found (nvidia-smi reports no GPU) - Pianoid's synthesis engine needs an NVIDIA GPU.`n" +
            "The UI will load, but APPLY / synthesis will fail.")
        if (-not $proceed) { exit 30 }
        exit 0
    }

    # $present is $true (GPU present, SM count unknown) OR $null (could not
    # determine at all) -> skip silently per the best-effort contract.
    exit 0
}
catch {
    # Best-effort: never let an unexpected failure block the launch.
    exit 0
}
