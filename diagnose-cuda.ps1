# =========================================================================
# diagnose-cuda.ps1 - standalone CUDA / NVIDIA-driver diagnostic.
#
# PURPOSE
#   Pinpoint the classic "GPU is there and visible, but nvidia-smi says
#   'NVML not found' (or CUDA init fails)" failure so the user knows EXACTLY
#   what is broken - device / driver / NVML / PATH / CUDA runtime - and what
#   to do about it.
#
# DESIGN: DEGRADES GRACEFULLY. This is meant to be run ON THE BROKEN SYSTEM,
#   so EVERY probe is independently wrapped in try/catch and reports its own
#   result even when CUDA, NVML, nvidia-smi, cupy, or the engine venv is
#   missing or broken. It NEVER throws; a failed probe becomes a finding, not
#   a crash. The OS/driver/PATH probes use only built-in Windows facilities
#   (WMI Win32_VideoController, the registry, the filesystem, Get-Command) and
#   need NO healthy venv. The engine venv's python is invoked ONLY for the
#   OPTIONAL cupy section, and only if that python exists.
#
#   It is READ-ONLY: it inspects devices, files, the registry and env; it does
#   not install, modify, allocate GPU memory, or launch a kernel.
#
# WHY THE LAYERS (driver vs toolkit vs app runtime):
#   * nvml.dll + nvidia-smi.exe are DRIVER components, version-locked to the
#     installed DISPLAY DRIVER and shipped into C:\Windows\System32 (and the
#     DriverStore). "NVML not found" is therefore almost always a DRIVER-side
#     problem (nvml.dll missing from System32 / not on PATH, or a driver/NVML
#     version mismatch) - NOT something a CUDA *toolkit* re-install fixes.
#   * cudart64_*.dll + nvcc + CUDA_PATH are the CUDA TOOLKIT.
#   * Pianoid ships its OWN cudart next to the .pyd in the engine venv.
#   Separating these is what makes the diagnosis actionable.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File diagnose-cuda.ps1
#   Optional: -SkipCupy (skip the venv/cupy probe), -VenvPython <path>.
#
# EXIT CODE: always 0 (it is a report, not a gate). The DIAGNOSIS section at
#   the end is the payload.
#
# See: check-cuda.ps1 (the pre-launch gate that USES a subset of these probes),
#      docs/guides/STARTUP_TROUBLESHOOTING.md (CUDA/GPU failures).
# =========================================================================

param(
    [switch] $SkipCupy,
    [string] $VenvPython
)

# Best-effort everywhere: a non-terminating error must never abort the report.
$ErrorActionPreference = 'SilentlyContinue'

$RepoRoot = $PSScriptRoot

# Resolve the engine venv python (for the optional cupy probe). Honour an
# explicit -VenvPython, then PIANOID_VENV_DIR (Linux NTFS-relocation case),
# else default to PianoidCore\.venv (mirrors check-cuda.ps1 / start-pianoid.bat).
if (-not $VenvPython) {
    if ($env:PIANOID_VENV_DIR) {
        $VenvPython = Join-Path $env:PIANOID_VENV_DIR 'Scripts\python.exe'
    } else {
        $VenvPython = Join-Path $RepoRoot 'PianoidCore\.venv\Scripts\python.exe'
    }
}

# Findings accumulate here; each is { Area; Status (OK|WARN|FAIL|INFO); Detail }.
$script:Findings = New-Object System.Collections.ArrayList

function Add-Finding {
    param(
        [string] $Area,
        [ValidateSet('OK', 'WARN', 'FAIL', 'INFO')] [string] $Status,
        [string] $Detail
    )
    [void]$script:Findings.Add([pscustomobject]@{ Area = $Area; Status = $Status; Detail = $Detail })
}

function Write-Section {
    param([string] $Title)
    Write-Host ''
    Write-Host ('=' * 70)
    Write-Host $Title
    Write-Host ('=' * 70)
}

# Pretty status tag for the per-section console lines.
function Tag {
    param([string] $Status)
    switch ($Status) {
        'OK'   { return '[ OK ]' }
        'WARN' { return '[WARN]' }
        'FAIL' { return '[FAIL]' }
        default { return '[INFO]' }
    }
}

# Emit a console line AND record a finding in one call.
function Report {
    param([string] $Area, [string] $Status, [string] $Detail)
    Write-Host ("  {0} {1}" -f (Tag $Status), $Detail)
    Add-Finding -Area $Area -Status $Status -Detail $Detail
}

# -------------------------------------------------------------------------
# 0. Environment header.
# -------------------------------------------------------------------------
Write-Section 'Pianoid CUDA diagnostic'
try {
    Write-Host ("  Host        : {0}" -f $env:COMPUTERNAME)
    Write-Host ("  OS          : {0}" -f ((Get-CimInstance Win32_OperatingSystem).Caption))
    Write-Host ("  Timestamp   : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Host ("  Repo root   : {0}" -f $RepoRoot)
} catch {
    Write-Host "  (could not read OS/host info)"
}

# -------------------------------------------------------------------------
# 1. GPU device presence - via WMI (Win32_VideoController). This is the
#    graceful-degradation anchor: it reads the DEVICE from Windows directly
#    and works even when NVML / nvidia-smi / CUDA are completely broken.
# -------------------------------------------------------------------------
Write-Section '1. GPU device (WMI Win32_VideoController - works without NVML/CUDA)'
$nvGpus = @()
try {
    $allGpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
    $nvGpus = @($allGpus | Where-Object { $_.Name -match 'NVIDIA' -or $_.AdapterCompatibility -match 'NVIDIA' })
    if ($nvGpus.Count -gt 0) {
        foreach ($g in $nvGpus) {
            # WMI DriverVersion is the Windows 4-part form (e.g. 32.0.15.6094);
            # the last 5 digits map to the NVIDIA driver (15.6094 -> 560.94).
            $nvDrv = ''
            if ($g.DriverVersion -match '(\d{3})(\d{2})$') {
                $nvDrv = " (NVIDIA driver ~{0}.{1})" -f $matches[1], $matches[2]
            }
            Report 'GPU' 'OK' ("Found: {0} | WMI DriverVersion {1}{2} | DriverDate {3}" -f `
                $g.Name, $g.DriverVersion, $nvDrv, $g.DriverDate)
        }
    } else {
        if ($allGpus.Count -gt 0) {
            Report 'GPU' 'WARN' ("No NVIDIA GPU in WMI. Other display adapters present: {0}" -f `
                (($allGpus | Select-Object -ExpandProperty Name) -join ', '))
        } else {
            Report 'GPU' 'FAIL' 'No display adapters reported by WMI at all.'
        }
    }
} catch {
    Report 'GPU' 'WARN' ("WMI video-controller query failed: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 2. NVIDIA kernel driver service (nvlddmkm). Confirms the DRIVER is
#    installed at the OS level (independent of NVML/CUDA usability).
# -------------------------------------------------------------------------
Write-Section '2. NVIDIA kernel driver service (nvlddmkm)'
try {
    $svc = Get-CimInstance Win32_SystemDriver -Filter "Name='nvlddmkm'" -ErrorAction SilentlyContinue
    if ($svc) {
        Report 'Driver' 'OK' ("nvlddmkm present (State={0}, Started={1}). PathName: {2}" -f `
            $svc.State, $svc.Started, $svc.PathName)
    } else {
        $svcKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\nvlddmkm'
        if (Test-Path $svcKey) {
            Report 'Driver' 'WARN' 'nvlddmkm registry key exists but the service object was not returned (driver may be partially installed).'
        } else {
            Report 'Driver' 'FAIL' 'nvlddmkm NVIDIA kernel driver service NOT found - the display driver is not installed.'
        }
    }
} catch {
    Report 'Driver' 'WARN' ("Could not query nvlddmkm: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 3. NVML (nvml.dll) - THE classic culprit. nvml.dll is a DRIVER component:
#    it ships into C:\Windows\System32 and the DriverStore, version-locked to
#    the display driver. "NVML not found" => nvml.dll is missing from a
#    loadable location, OR present but the wrong version for the driver.
# -------------------------------------------------------------------------
Write-Section '3. NVML library (nvml.dll - source of "NVML not found")'
$nvmlFound = $false
try {
    # 3a. The load path that matters most: System32 (always on the DLL search path).
    $sys32Nvml = Join-Path $env:SystemRoot 'System32\nvml.dll'
    if (Test-Path -LiteralPath $sys32Nvml) {
        $nvmlFound = $true
        $fv = (Get-Item -LiteralPath $sys32Nvml).VersionInfo.FileVersion
        Report 'NVML' 'OK' ("nvml.dll present in System32 (FileVersion {0}). This is the primary load location." -f $fv)
    } else {
        Report 'NVML' 'FAIL' ("nvml.dll is MISSING from {0}. nvidia-smi and any NVML client will report 'NVML not found' / 'Failed to load NVML library'." -f $sys32Nvml)
    }

    # 3b. The DriverStore copies (where the driver actually keeps it). If these
    #     exist but System32 does not, the recovery is to copy/repair into System32.
    $repo = Join-Path $env:SystemRoot 'System32\DriverStore\FileRepository'
    $dsNvml = @()
    if (Test-Path -LiteralPath $repo) {
        $dsNvml = @(Get-ChildItem -LiteralPath $repo -Recurse -Filter 'nvml.dll' -ErrorAction SilentlyContinue)
    }
    if ($dsNvml.Count -gt 0) {
        $nvmlFound = $true
        foreach ($d in ($dsNvml | Select-Object -First 3)) {
            $dfv = $d.VersionInfo.FileVersion
            Report 'NVML' 'INFO' ("DriverStore copy: {0} (FileVersion {1})" -f $d.FullName, $dfv)
        }
        if (-not (Test-Path -LiteralPath $sys32Nvml)) {
            Report 'NVML' 'WARN' 'nvml.dll exists in the DriverStore but NOT in System32 -> NVML clients cannot load it. Recovery: reinstall the GPU DRIVER (or copy the DriverStore nvml.dll into System32).'
        }
    } else {
        Report 'NVML' 'INFO' 'No nvml.dll found in the DriverStore FileRepository.'
    }

    if (-not $nvmlFound) {
        Report 'NVML' 'FAIL' 'nvml.dll not found anywhere standard. NVML is a DRIVER component (NOT the CUDA toolkit) - fix by reinstalling/repairing the NVIDIA DISPLAY DRIVER, not the CUDA toolkit.'
    }
} catch {
    Report 'NVML' 'WARN' ("NVML probe failed: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 4. nvidia-smi - the tool the user saw fail. Locate it, then run it and
#    capture the EXACT error (stdout+stderr+exit code). This converts the
#    user's "NVML not found" into a precise, captured signal.
# -------------------------------------------------------------------------
Write-Section '4. nvidia-smi (locate + run, capture exact error)'
$smiOk = $false
try {
    $smiCmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    $smiPath = $null
    if ($smiCmd) {
        $smiPath = $smiCmd.Source
        Report 'nvidia-smi' 'INFO' ("nvidia-smi on PATH: {0}" -f $smiPath)
    } else {
        # Fall back to the standard install locations.
        foreach ($cand in @((Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
                            (Join-Path ${env:ProgramFiles} 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'))) {
            if (Test-Path -LiteralPath $cand) { $smiPath = $cand; break }
        }
        if ($smiPath) {
            Report 'nvidia-smi' 'WARN' ("nvidia-smi NOT on PATH but found at {0}" -f $smiPath)
        } else {
            Report 'nvidia-smi' 'FAIL' 'nvidia-smi not found on PATH or in standard locations (System32 / NVSMI). The driver may be missing or incompletely installed.'
        }
    }

    if ($smiPath) {
        # Capture stdout, stderr and exit code separately via a temp-file redirect
        # (robust under Windows PowerShell 5.1, which otherwise wraps native stderr).
        $outFile = Join-Path $env:TEMP ("pianoid_smi_out_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
        $errFile = Join-Path $env:TEMP ("pianoid_smi_err_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
        try {
            $p = Start-Process -FilePath $smiPath -ArgumentList '--query-gpu=name,driver_version,memory.total --format=csv,noheader' `
                -NoNewWindow -Wait -PassThru `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            $code = $p.ExitCode
            $so = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue)
            $se = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)
            if ($code -eq 0 -and -not [string]::IsNullOrWhiteSpace($so)) {
                $smiOk = $true
                Report 'nvidia-smi' 'OK' ("nvidia-smi works. GPU(s): {0}" -f ($so.Trim() -replace "`r?`n", ' ; '))
            } else {
                $msg = $se; if ([string]::IsNullOrWhiteSpace($msg)) { $msg = $so }
                if ([string]::IsNullOrWhiteSpace($msg)) { $msg = '(no output)' }
                Report 'nvidia-smi' 'FAIL' ("nvidia-smi FAILED (exit {0}). Output: {1}" -f $code, ($msg.Trim() -replace "`r?`n", ' / '))
                if ($msg -match 'NVML') {
                    Report 'nvidia-smi' 'FAIL' 'NVML error confirmed via nvidia-smi -> see section 3 (nvml.dll). This is a DRIVER problem; reinstall/repair the NVIDIA display driver.'
                }
            }
        } finally {
            Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Report 'nvidia-smi' 'WARN' ("nvidia-smi probe raised: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 5. CUDA toolkit / runtime on the system (cudart, CUDA_PATH, nvcc). Distinct
#    from the driver/NVML above and from Pianoid's own bundled runtime (6).
# -------------------------------------------------------------------------
Write-Section '5. CUDA toolkit / runtime (CUDA_PATH, cudart, nvcc)'
try {
    if ($env:CUDA_PATH) {
        if (Test-Path -LiteralPath $env:CUDA_PATH) {
            Report 'Toolkit' 'OK' ("CUDA_PATH = {0}" -f $env:CUDA_PATH)
        } else {
            Report 'Toolkit' 'WARN' ("CUDA_PATH set but does not exist: {0}" -f $env:CUDA_PATH)
        }
        $nvccPath = Join-Path $env:CUDA_PATH 'bin\nvcc.exe'
        if (Test-Path -LiteralPath $nvccPath) {
            Report 'Toolkit' 'OK' ("nvcc present: {0}" -f $nvccPath)
        } else {
            Report 'Toolkit' 'INFO' 'nvcc not found under CUDA_PATH\bin (only needed to BUILD, not to run).'
        }
    } else {
        Report 'Toolkit' 'INFO' 'CUDA_PATH not set (only needed to BUILD the engine, not to run a prebuilt one).'
    }

    # cudart64_*.dll anywhere on PATH (the runtime the engine could pick up).
    $pathDirs = @($env:Path -split ';' | Where-Object { $_ })
    $cudartOnPath = @()
    foreach ($d in $pathDirs) {
        try {
            $hit = @(Get-ChildItem -LiteralPath $d -Filter 'cudart64_*.dll' -ErrorAction SilentlyContinue)
            foreach ($h in $hit) { $cudartOnPath += $h.FullName }
        } catch { }
    }
    if ($cudartOnPath.Count -gt 0) {
        Report 'Toolkit' 'INFO' ("cudart64 on PATH: {0}" -f (($cudartOnPath | Select-Object -Unique -First 4) -join ' ; '))
    } else {
        Report 'Toolkit' 'INFO' 'No cudart64_*.dll on PATH (Pianoid ships its own next to the .pyd - see section 6).'
    }
} catch {
    Report 'Toolkit' 'WARN' ("Toolkit probe failed: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 6. Pianoid engine venv + its bundled CUDA runtime (cudart64_12.dll next to
#    the .pyd). This is what the BACKEND actually loads.
# -------------------------------------------------------------------------
Write-Section '6. Pianoid engine venv + bundled runtime'
try {
    if (Test-Path -LiteralPath $VenvPython) {
        Report 'Venv' 'OK' ("Engine venv python: {0}" -f $VenvPython)
        $sitePk = Join-Path (Split-Path -Parent (Split-Path -Parent $VenvPython)) 'Lib\site-packages'
        $pyd = @(Get-ChildItem -LiteralPath $sitePk -Filter 'pianoidCuda*.pyd' -ErrorAction SilentlyContinue)
        if ($pyd.Count -gt 0) {
            Report 'Venv' 'OK' ("pianoidCuda module(s): {0}" -f (($pyd | Select-Object -ExpandProperty Name) -join ', '))
        } else {
            Report 'Venv' 'WARN' ("No pianoidCuda*.pyd in {0} - the engine is not built/installed. Rebuild: build_pianoid_cuda.bat --heavy --both" -f $sitePk)
        }
        $bundledCudart = @(Get-ChildItem -LiteralPath $sitePk -Filter 'cudart64_*.dll' -ErrorAction SilentlyContinue)
        if ($bundledCudart.Count -gt 0) {
            Report 'Venv' 'OK' ("Bundled CUDA runtime: {0}" -f (($bundledCudart | Select-Object -ExpandProperty Name) -join ', '))
        } else {
            Report 'Venv' 'INFO' 'No cudart64_*.dll next to the .pyd (the --heavy build copies it; a --debug-only build may rely on the release copy).'
        }
    } else {
        Report 'Venv' 'WARN' ("Engine venv python not found at {0}. The cupy probe (section 7) will be skipped." -f $VenvPython)
    }
} catch {
    Report 'Venv' 'WARN' ("Venv probe failed: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 7. cupy probe (OPTIONAL) - the authoritative runtime check the engine
#    relies on. Invoked via the venv python from a TEMP FILE (quote-safe).
#    Captures device count + SM count + runtime/driver versions, and on
#    failure the EXACT cupy exception class + message (e.g. a CUDARuntimeError
#    "no CUDA-capable device is detected" or an NVRTC/driver mismatch).
# -------------------------------------------------------------------------
Write-Section '7. cupy / CUDA runtime probe (optional - needs the engine venv)'
if ($SkipCupy) {
    Report 'cupy' 'INFO' 'Skipped (-SkipCupy).'
} elseif (-not (Test-Path -LiteralPath $VenvPython)) {
    Report 'cupy' 'INFO' 'Skipped: engine venv python not available (see section 6).'
} else {
    $py = @'
import sys, json
res = {}
try:
    import cupy
    res["cupy_version"] = cupy.__version__
except Exception as e:
    print(json.dumps({"stage": "import", "error_type": type(e).__name__, "error": str(e)[:500]}))
    sys.exit(0)
for label, fn in (("runtime_version", lambda: cupy.cuda.runtime.runtimeGetVersion()),
                  ("driver_version",  lambda: cupy.cuda.runtime.driverGetVersion())):
    try:
        res[label] = fn()
    except Exception as e:
        res[label + "_error"] = "%s: %s" % (type(e).__name__, str(e)[:300])
try:
    n = cupy.cuda.runtime.getDeviceCount()
    res["device_count"] = n
    devs = []
    for i in range(n):
        p = cupy.cuda.runtime.getDeviceProperties(i)
        name = p["name"]
        if isinstance(name, bytes):
            name = name.decode("ascii", "replace")
        devs.append({"index": i, "name": name, "sm_count": p["multiProcessorCount"]})
    res["devices"] = devs
    res["stage"] = "ok"
except Exception as e:
    res["stage"] = "device_query"
    res["error_type"] = type(e).__name__
    res["error"] = str(e)[:500]
print(json.dumps(res))
'@
    $tmpPy = $null
    try {
        $tmpPy = Join-Path $env:TEMP ("pianoid_cuda_diag_{0}.py" -f ([guid]::NewGuid().ToString('N')))
        Set-Content -LiteralPath $tmpPy -Value $py -Encoding ASCII
        $raw = & $VenvPython $tmpPy 2>$null
        $jsonLine = $null
        foreach ($ln in @($raw)) {
            $t = ([string]$ln).Trim()
            if ($t.StartsWith('{') -and $t.EndsWith('}')) { $jsonLine = $t; break }
        }
        if (-not $jsonLine) {
            Report 'cupy' 'WARN' 'cupy probe produced no parseable JSON (cupy may be missing or python errored). Run manually for detail.'
        } else {
            $r = $jsonLine | ConvertFrom-Json
            if ($r.stage -eq 'import') {
                Report 'cupy' 'FAIL' ("cupy import failed: {0}: {1}" -f $r.error_type, $r.error)
            } elseif ($r.stage -eq 'device_query') {
                Report 'cupy' 'FAIL' ("cupy {0}: getDeviceCount/properties FAILED -> {1}: {2}" -f $r.cupy_version, $r.error_type, $r.error)
                Report 'cupy' 'FAIL' 'This is the engine-level failure: the backend will hit the same error on APPLY ("no CUDA-capable device is detected" / driver mismatch).'
            } elseif ($r.stage -eq 'ok') {
                Report 'cupy' 'INFO' ("cupy {0} | runtime {1} | driver {2}" -f $r.cupy_version, $r.runtime_version, $r.driver_version)
                if ($r.device_count -lt 1) {
                    Report 'cupy' 'FAIL' 'cupy reports 0 CUDA devices - APPLY/synthesis will fail.'
                } else {
                    foreach ($d in $r.devices) {
                        $smTag = if ($d.sm_count -lt 60) { 'WARN' } else { 'OK' }
                        $smNote = if ($d.sm_count -lt 60) { ' (< 60 SMs: full-keyboard 58-block presets may not fit the cooperative launch; use a *_56SM preset)' } else { '' }
                        Report 'cupy' $smTag ("Device {0}: {1} | {2} SMs{3}" -f $d.index, $d.name, $d.sm_count, $smNote)
                    }
                }
            } else {
                Report 'cupy' 'WARN' ("cupy probe returned an unexpected shape: {0}" -f $jsonLine)
            }
        }
    } catch {
        Report 'cupy' 'WARN' ("cupy probe raised: {0}" -f $_.Exception.Message)
    } finally {
        if ($tmpPy -and (Test-Path -LiteralPath $tmpPy)) {
            Remove-Item -LiteralPath $tmpPy -Force -ErrorAction SilentlyContinue
        }
    }
}

# -------------------------------------------------------------------------
# 8. DIAGNOSIS - synthesise the findings into a verdict + recommended fix.
#    This is the payload: a user on the broken machine reads THIS.
# -------------------------------------------------------------------------
Write-Section '8. DIAGNOSIS + recommended fix'

$has = { param($area, $status) @($script:Findings | Where-Object { $_.Area -eq $area -and $_.Status -eq $status }).Count -gt 0 }

$gpuPresent   = (& $has 'GPU' 'OK')
$driverFail   = (& $has 'Driver' 'FAIL')
$nvmlFail     = (& $has 'NVML' 'FAIL')
$nvmlInSys32  = @($script:Findings | Where-Object { $_.Area -eq 'NVML' -and $_.Status -eq 'OK' }).Count -gt 0
$smiFail      = (& $has 'nvidia-smi' 'FAIL')
$cupyFail     = (& $has 'cupy' 'FAIL')
$cupyOk       = @($script:Findings | Where-Object { $_.Area -eq 'cupy' -and $_.Detail -match 'Device \d+:' }).Count -gt 0
$lowSm        = @($script:Findings | Where-Object { $_.Area -eq 'cupy' -and $_.Status -eq 'WARN' -and $_.Detail -match 'SMs' }).Count -gt 0
# nvidia-smi succeeded? (system-level CUDA/driver healthy even if the engine
# venv / cupy probe was skipped or unavailable).
$smiOkFinding = @($script:Findings | Where-Object { $_.Area -eq 'nvidia-smi' -and $_.Status -eq 'OK' }).Count -gt 0
# cupy probe was inconclusive (skipped, no venv, or no parseable output) - i.e.
# neither a clear pass (cupyOk) nor a clear fail (cupyFail).
$cupyInconclusive = (-not $cupyOk) -and (-not $cupyFail)

Write-Host ''
if (-not $gpuPresent) {
    Write-Host '  VERDICT: No NVIDIA GPU detected by Windows itself (WMI).'
    Write-Host '  => Either there is no NVIDIA card, it is disabled in Device Manager, or'
    Write-Host '     the system is using integrated graphics only.'
    Write-Host '  FIX: Confirm the card is seated/enabled; install the NVIDIA display driver.'
}
elseif ($driverFail) {
    Write-Host '  VERDICT: GPU is present but the NVIDIA kernel driver (nvlddmkm) is not installed.'
    Write-Host '  FIX: Install the latest NVIDIA Game Ready / Studio driver for this GPU, then reboot.'
}
elseif ($nvmlFail -or ($smiFail -and -not $nvmlInSys32)) {
    Write-Host '  VERDICT: GPU + driver are present, but NVML is broken ("NVML not found").'
    Write-Host '  ROOT CAUSE: nvml.dll (a DRIVER component, version-locked to the display driver)'
    Write-Host '              is missing from C:\Windows\System32 or not loadable. This is NOT'
    Write-Host '              fixed by reinstalling the CUDA TOOLKIT (setup-packages) - the toolkit'
    Write-Host '              does not ship the driver-side nvml.dll.'
    Write-Host '  FIX (in order):'
    Write-Host '   1. Reinstall/repair the NVIDIA DISPLAY DRIVER (clean install via the NVIDIA'
    Write-Host '      installer or DDU + reinstall). This restores a matching nvml.dll into System32.'
    Write-Host '   2. If a DriverStore copy of nvml.dll exists (section 3) but System32 does not,'
    Write-Host '      a driver reinstall is still the correct fix (copying is a last-resort hack and'
    Write-Host '      can version-mismatch).'
    Write-Host '   3. Reboot, then re-run this diagnostic - section 4 (nvidia-smi) should pass.'
    Write-Host '  NOTE: Pianoid synthesis needs a WORKING CUDA runtime; until NVML/driver are fixed,'
    Write-Host '        the UI loads but APPLY/synthesis fails. The launcher now warns about this.'
}
elseif ($cupyFail) {
    Write-Host '  VERDICT: GPU/driver/NVML look OK, but the CUDA RUNTIME used by the engine fails'
    Write-Host '           (cupy could not query the device - see section 7 for the exact error).'
    Write-Host '  LIKELY CAUSES: CUDA runtime / driver version mismatch, a second process holding'
    Write-Host '                 the GPU exclusively, or a corrupt cupy/CUDA install in the venv.'
    Write-Host '  FIX: Match the CUDA runtime to the driver; close other GPU-exclusive apps;'
    Write-Host '       if needed reinstall cupy in the engine venv. See STARTUP_TROUBLESHOOTING.md.'
}
elseif ($lowSm) {
    Write-Host '  VERDICT: CUDA is WORKING, but the GPU has < 60 SMs.'
    Write-Host '  => Full-keyboard 58-block presets may exceed the cooperative-kernel launch budget.'
    Write-Host '  FIX: Use a reduced-keyboard preset (the *_56SM variants). Normal presets are fine.'
}
elseif ($cupyOk) {
    Write-Host '  VERDICT: CUDA is healthy. GPU, driver, NVML, and the engine runtime all check out.'
    Write-Host '  => If synthesis still fails, the problem is elsewhere (see STARTUP_TROUBLESHOOTING.md).'
}
elseif ($smiOkFinding -and $cupyInconclusive) {
    Write-Host '  VERDICT: System-level CUDA looks healthy (GPU, driver, NVML and nvidia-smi all'
    Write-Host '           pass), but the ENGINE venv / cupy probe was not run (section 6/7).'
    Write-Host '  => The driver/NVML are fine - this is NOT the "NVML not found" failure. Verify the'
    Write-Host '     engine venv exists and is built (build_pianoid_cuda.bat --heavy --both), then'
    Write-Host '     re-run with -VenvPython <path> for the authoritative SM-count / runtime check.'
}
else {
    Write-Host '  VERDICT: Could not fully determine CUDA state (some probes were inconclusive).'
    Write-Host '  => Review the per-section findings above. nvidia-smi (section 4) and cupy (section 7)'
    Write-Host '     are the most decisive; if both are inconclusive, install/repair the NVIDIA driver'
    Write-Host '     and the engine venv, then re-run.'
}

# Compact machine-readable summary line (greppable / loggable).
Write-Host ''
$counts = $script:Findings | Group-Object Status | ForEach-Object { "{0}={1}" -f $_.Name, $_.Count }
Write-Host ("  SUMMARY: " + ($counts -join ' '))
Write-Host ''

exit 0
