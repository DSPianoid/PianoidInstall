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

# Normalise an NVIDIA version string to the human "XXX.YY" driver form (e.g.
# 560.94). nvml.dll's FileVersion (e.g. 8.17.15.6094) and WMI's DriverVersion
# (e.g. 32.0.15.6094) both encode the NVIDIA driver in their LAST 5 DIGITS
# (...56094 -> 560.94) regardless of the leading parts, which differ between the
# two but are NOT the driver number. So strip non-digits and read the last 5.
# Returns $null when fewer than 5 digits are present (so a non-NVIDIA /
# unparseable string never produces a bogus comparison). An already-short
# "560.94" -> "56094" -> "560.94" round-trips correctly.
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

# Version facts captured across sections 1/3/4/4b, compared in section 8. Each
# short is the normalised "XXX.YY" form (or $null when the source was missing).
$script:NvmlSys32Short    = $null   # nvml.dll in System32        (section 3)
$script:NvmlSys32Raw      = $null   # its raw FileVersion         (section 3)
$script:NvcudaSys32Short  = $null   # nvcuda.dll in System32      (section 3d)
$script:NvcudaSys32Raw    = $null   # its raw FileVersion         (section 3d)
$script:DriverShort       = $null   # display driver, from WMI    (section 1)
$script:DriverRaw         = $null   # raw WMI DriverVersion       (section 1)
$script:NvmlStoreShorts   = @()     # DriverStore nvml.dll shorts (section 3)
$script:SmiNvmlError      = $false  # nvidia-smi failed w/ an NVML error (section 4)
$script:SmiDriverShort    = $null   # driver version nvidia-smi -q reports (section 4)
$script:NvmlShadowed      = $false  # a non-System32 PATH nvml.dll precedes System32 (4b)
$script:NvcudaShadowed    = $false  # a non-System32 PATH nvcuda.dll precedes System32 (4b)
$script:NvmlMultiVersion  = $false  # >1 distinct nvml.dll version across PATH+System32 (4b)
$script:NvcudaMultiVersion = $false # >1 distinct nvcuda.dll version across PATH+System32 (4b)
$script:KmodShort         = $null   # LOADED kernel module nvlddmkm.sys short (section 2b)
$script:KmodLoadedDesync  = $false  # loaded nvlddmkm != on-disk System32 nvml/nvcuda (2b)
$script:SecondAdapter     = $false  # a non-NVIDIA display adapter present (section 1b)
$script:GpuConfigError    = $null   # NVIDIA GPU ConfigManagerErrorCode (e.g. 43) (section 1b)
$script:DriverServiceStopped = $false # nvlddmkm service present but State != Running (section 2)
$script:StaleDriverPackage   = $false # a DriverStore nvml.dll version != active driver (section 3)

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
            $short = Get-NvDriverShort $g.DriverVersion
            if ($short) {
                $nvDrv = " (NVIDIA driver ~{0})" -f $short
                # Capture the FIRST NVIDIA GPU's driver version as the canonical
                # one for the section-8 NVML version-mismatch comparison.
                if (-not $script:DriverShort) {
                    $script:DriverShort = $short
                    $script:DriverRaw   = $g.DriverVersion
                }
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
# 1b. GPU PnP state + second-adapter check. A driver-libraries-present-but-NVML-
#     fails situation can be caused by the GPU itself being in a problem state
#     (Device Manager "Code 43" = the driver reported a problem) or by a SECOND/
#     default display adapter (Intel/AMD integrated -> hybrid/Optimus) shadowing
#     the NVIDIA GPU. ConfigManagerErrorCode is the WMI PnP problem code (0 = OK).
# -------------------------------------------------------------------------
Write-Section '1b. GPU PnP state + display adapters'
try {
    $allGpus2 = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
    $nvGpus2  = @($allGpus2 | Where-Object { $_.Name -match 'NVIDIA' -or $_.AdapterCompatibility -match 'NVIDIA' })
    $otherGpus = @($allGpus2 | Where-Object { -not ($_.Name -match 'NVIDIA' -or $_.AdapterCompatibility -match 'NVIDIA') })

    foreach ($g in $nvGpus2) {
        $code = $g.ConfigManagerErrorCode
        if ($null -eq $script:GpuConfigError) { $script:GpuConfigError = $code }
        if ($code -eq 0 -or $null -eq $code) {
            Report 'GPU-state' 'OK' ("{0}: PnP ConfigManagerErrorCode=0 (no device problem)." -f $g.Name)
        } elseif ($code -eq 43) {
            Report 'GPU-state' 'FAIL' ("{0}: ConfigManagerErrorCode=43 - Windows STOPPED the device because the DRIVER REPORTED A PROBLEM. This is a driver/hardware fault (not a version-only issue): reinstall the display driver cleanly (DDU), and if it persists suspect the GPU/power/seating." -f $g.Name)
        } else {
            Report 'GPU-state' 'WARN' ("{0}: ConfigManagerErrorCode={1} (PnP device problem code; 0 would be healthy). See Device Manager for detail." -f $g.Name, $code)
        }
    }

    # A second/default adapter alongside the NVIDIA GPU = hybrid graphics; the
    # NVIDIA card can be the non-default adapter, so CUDA still works, but a
    # misconfigured hybrid setup is a candidate cause when NVML/CUDA mis-target.
    if ($otherGpus.Count -gt 0) {
        $script:SecondAdapter = $true
        Report 'GPU-state' 'INFO' ("Additional (non-NVIDIA) display adapter(s) present: {0}. Hybrid/Optimus configuration - usually fine, but a candidate cause if CUDA targets the wrong adapter." -f (($otherGpus | Select-Object -ExpandProperty Name) -join ', '))
    }
} catch {
    Report 'GPU-state' 'WARN' ("GPU PnP-state probe failed: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 2. NVIDIA kernel driver service (nvlddmkm). Confirms the DRIVER is
#    installed at the OS level (independent of NVML/CUDA usability).
# -------------------------------------------------------------------------
Write-Section '2. NVIDIA kernel driver service (nvlddmkm)'
$script:NvlddmkmPathName = $null
try {
    $svc = Get-CimInstance Win32_SystemDriver -Filter "Name='nvlddmkm'" -ErrorAction SilentlyContinue
    if ($svc) {
        $script:NvlddmkmPathName = $svc.PathName
        # A PRESENT service is not enough - it must be RUNNING. A healthy box is
        # State=Running / Started=True; State=Stopped / Started=False means the
        # NVIDIA driver service is installed but NOT servicing the GPU -> NVML
        # "Not Found" / "no CUDA device" even with all files matching + Code 0.
        $running = ($svc.State -eq 'Running') -and ($svc.Started -eq $true)
        if ($running) {
            Report 'Driver' 'OK' ("nvlddmkm present and RUNNING (State={0}, Started={1}). PathName: {2}" -f `
                $svc.State, $svc.Started, $svc.PathName)
        } else {
            $script:DriverServiceStopped = $true
            Report 'Driver' 'WARN' ("NVIDIA driver SERVICE present but NOT running (State={0}, Started={1}) - installed but not servicing the GPU. This alone makes NVML report 'Not Found' / 'no CUDA-capable device' even with matching files. PathName: {2}" -f `
                $svc.State, $svc.Started, $svc.PathName)
        }
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
# 2b. LOADED kernel-module version (nvlddmkm.sys). The user-mode driver
#     libraries (nvml.dll / nvcuda.dll in System32) must match the LOADED kernel
#     module - if a driver update staged a new .sys but the OLD one is still
#     loaded (no reboot yet), NVML fails with "driver/library version mismatch"
#     even though the on-disk DLL versions look fine. We read the .sys
#     FileVersion (from the service PathName, then System32\drivers) and capture
#     it; the loaded-vs-installed comparison is done in section 8 (after 3/3d
#     have read the DLL versions). Read-only; degrades gracefully if unreadable.
# -------------------------------------------------------------------------
Write-Section '2b. Loaded kernel module (nvlddmkm.sys) version'
try {
    $sysPath = $null
    # Resolve the .sys path from the service PathName (handles \SystemRoot\, \??\,
    # and System32\DriverStore\... forms), then fall back to System32\drivers.
    if (-not [string]::IsNullOrWhiteSpace($script:NvlddmkmPathName)) {
        $pn = $script:NvlddmkmPathName
        $pn = $pn -replace '^\\\?\?\\', ''                       # \??\C:\... -> C:\...
        $pn = $pn -replace '^\\SystemRoot\\', ($env:SystemRoot.TrimEnd('\') + '\')
        $pn = $pn -replace '^System32\\', ($env:SystemRoot.TrimEnd('\') + '\System32\')
        if (Test-Path -LiteralPath $pn) { $sysPath = $pn }
    }
    if (-not $sysPath) {
        $cand = Join-Path $env:SystemRoot 'System32\drivers\nvlddmkm.sys'
        if (Test-Path -LiteralPath $cand) { $sysPath = $cand }
    }
    if ($sysPath) {
        $kfv = (Get-Item -LiteralPath $sysPath).VersionInfo.FileVersion
        $script:KmodShort = Get-NvDriverShort $kfv
        $kStr = if ($script:KmodShort) { "v$($script:KmodShort)" } else { 'version unreadable' }
        Report 'Kmod' 'OK' ("nvlddmkm.sys found: {0} (FileVersion {1} -> {2})." -f $sysPath, $kfv, $kStr)
    } else {
        Report 'Kmod' 'INFO' 'nvlddmkm.sys not cleanly locatable (service PathName unresolved + not in System32\drivers). Loaded-vs-installed comparison skipped; nvidia-smi -q driver version (section 4) is the cross-check instead.'
    }
} catch {
    Report 'Kmod' 'INFO' ("Loaded kernel-module version probe skipped (read-only, non-fatal): {0}" -f $_.Exception.Message)
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
        $script:NvmlSys32Raw   = $fv
        $script:NvmlSys32Short = Get-NvDriverShort $fv
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
        foreach ($d in ($dsNvml | Select-Object -First 6)) {
            $dfv = $d.VersionInfo.FileVersion
            $dShort = Get-NvDriverShort $dfv
            if ($dShort) { $script:NvmlStoreShorts += $dShort }
            Report 'NVML' 'INFO' ("DriverStore copy: {0} (FileVersion {1})" -f $d.FullName, $dfv)
        }
        if (-not (Test-Path -LiteralPath $sys32Nvml)) {
            Report 'NVML' 'WARN' 'nvml.dll exists in the DriverStore but NOT in System32 -> NVML clients cannot load it. Recovery: reinstall the GPU DRIVER (or copy the DriverStore nvml.dll into System32).'
        }
        # STALE-PACKAGE check: a DriverStore nvml.dll whose version differs from the
        # ACTIVE display driver = a leftover older-driver package (e.g. an old
        # nv_dispig.inf alongside the new nv_dispi.inf). A stale package can BLOCK
        # the new driver service from starting -> a DDU clean wipe is the fix.
        if ($script:DriverShort) {
            $staleCopies = @($dsNvml | Where-Object {
                $s = Get-NvDriverShort $_.VersionInfo.FileVersion
                $s -and ($s -ne $script:DriverShort)
            })
            if ($staleCopies.Count -gt 0) {
                $script:StaleDriverPackage = $true
                $staleList = ($staleCopies | Select-Object -First 4 | ForEach-Object {
                    "{0} (v{1})" -f $_.FullName, (Get-NvDriverShort $_.VersionInfo.FileVersion)
                }) -join ' ; '
                Report 'NVML' 'WARN' ("STALE DRIVER PACKAGE: a DriverStore nvml.dll version differs from the active driver (v{0}): {1}. A leftover older-driver package can BLOCK the new driver service from starting. Fix: DDU clean wipe + reinstall the current driver." -f $script:DriverShort, $staleList)
            }
        }
    } else {
        Report 'NVML' 'INFO' 'No nvml.dll found in the DriverStore FileRepository.'
    }

    if (-not $nvmlFound) {
        Report 'NVML' 'FAIL' 'nvml.dll not found anywhere standard. NVML is a DRIVER component (NOT the CUDA toolkit) - fix by reinstalling/repairing the NVIDIA DISPLAY DRIVER, not the CUDA toolkit.'
    }

    # 3c. VERSION COMPARISON - the present-but-WRONG-VERSION case. nvml.dll is
    #     version-locked to the display driver; a System32 nvml.dll whose version
    #     != the driver version is UNLOADABLE ("driver/library version mismatch"
    #     / "Failed to load NVML"), even though the file is right there. Compare
    #     the normalised XXX.YY short forms (built the SAME way for all three).
    if ($script:NvmlSys32Short -and $script:DriverShort) {
        if ($script:NvmlSys32Short -ne $script:DriverShort) {
            Report 'NVML' 'FAIL' ("VERSION MISMATCH: System32 nvml.dll is v{0} (raw {1}) but the display driver is v{2} (raw {3}) -> nvml.dll is present but CANNOT LOAD. This is the 'NVML not found' / 'driver/library version mismatch' cause. See the DIAGNOSIS section for the fix." -f `
                $script:NvmlSys32Short, $script:NvmlSys32Raw, $script:DriverShort, $script:DriverRaw)
        } else {
            Report 'NVML' 'OK' ("Version match: System32 nvml.dll v{0} == display driver v{1}." -f $script:NvmlSys32Short, $script:DriverShort)
        }
    } elseif ($script:NvmlSys32Short -and $script:NvmlStoreShorts.Count -gt 0) {
        # Driver short form unavailable (rare): fall back to comparing System32
        # against the DriverStore copy, which the driver installs alongside it.
        $mismatchStore = @($script:NvmlStoreShorts | Where-Object { $_ -ne $script:NvmlSys32Short })
        if ($mismatchStore.Count -gt 0 -and -not ($script:NvmlStoreShorts -contains $script:NvmlSys32Short)) {
            Report 'NVML' 'WARN' ("Possible VERSION MISMATCH: System32 nvml.dll is v{0} but the DriverStore copy is v{1}. If nvidia-smi reports an NVML error, reinstall the matching display driver (see DIAGNOSIS)." -f `
                $script:NvmlSys32Short, ($script:NvmlStoreShorts -join '/'))
        }
    }

    # NOTE: the stray/shadowing nvml.dll-on-PATH check now lives in the
    #       comprehensive PATH scan (section 4b), which also covers nvcuda.dll,
    #       cudart and nvidia-smi.exe and detects ORDERED shadowing (a PATH copy
    #       that precedes System32). Section 8 consumes $script:NvmlShadowed.
} catch {
    Report 'NVML' 'WARN' ("NVML probe failed: {0}" -f $_.Exception.Message)
}

# -------------------------------------------------------------------------
# 3d. nvcuda.dll - the CUDA DRIVER API library. Like nvml.dll it is a
#     DISPLAY-DRIVER component (NOT the CUDA toolkit): it ships into
#     C:\Windows\System32, version-locked to the display driver. A stale or
#     mismatched nvcuda.dll is a common cause of cupy "no CUDA-capable device
#     is detected" / "driver version is insufficient" - so it is checked here
#     alongside nvml, and re-running the CUDA TOOLKIT installer does NOT fix it.
# -------------------------------------------------------------------------
Write-Section '3d. nvcuda.dll (CUDA Driver API - a DISPLAY-DRIVER component)'
try {
    $sys32Nvcuda = Join-Path $env:SystemRoot 'System32\nvcuda.dll'
    if (Test-Path -LiteralPath $sys32Nvcuda) {
        $nfv = (Get-Item -LiteralPath $sys32Nvcuda).VersionInfo.FileVersion
        $script:NvcudaSys32Raw   = $nfv
        $script:NvcudaSys32Short = Get-NvDriverShort $nfv
        Report 'nvcuda' 'OK' ("nvcuda.dll present in System32 (FileVersion {0}). This is the CUDA Driver API (driver-side)." -f $nfv)
        # Version comparison vs the display driver (same driver-locked rule as nvml).
        if ($script:NvcudaSys32Short -and $script:DriverShort) {
            if ($script:NvcudaSys32Short -ne $script:DriverShort) {
                Report 'nvcuda' 'FAIL' ("VERSION MISMATCH: System32 nvcuda.dll is v{0} (raw {1}) but the display driver is v{2} (raw {3}) -> the CUDA Driver API is out of sync with the driver. This causes cupy 'no CUDA-capable device' / 'driver version is insufficient'. See the DIAGNOSIS section." -f `
                    $script:NvcudaSys32Short, $script:NvcudaSys32Raw, $script:DriverShort, $script:DriverRaw)
            } else {
                Report 'nvcuda' 'OK' ("Version match: System32 nvcuda.dll v{0} == display driver v{1}." -f $script:NvcudaSys32Short, $script:DriverShort)
            }
        }
    } else {
        Report 'nvcuda' 'FAIL' ("nvcuda.dll is MISSING from {0}. The CUDA Driver API is a DISPLAY-DRIVER component; without it cupy/CUDA cannot initialise. Fix by reinstalling the NVIDIA DISPLAY DRIVER (NOT the CUDA toolkit)." -f $sys32Nvcuda)
    }
} catch {
    Report 'nvcuda' 'WARN' ("nvcuda.dll probe failed: {0}" -f $_.Exception.Message)
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

                # 4-verify: confirm the driver nvidia-smi loaded by DEFAULT matches
                # the installed driver (WMI, section 1). nvidia-smi loads nvml.dll,
                # which loads against the kernel driver - so a successful run whose
                # reported Driver Version != WMI would mean a different driver/NVML
                # is being picked up (e.g. a shadowing copy). Also count GPUs/drivers.
                $qOut = Join-Path $env:TEMP ("pianoid_smiq_out_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
                $qErr = Join-Path $env:TEMP ("pianoid_smiq_err_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
                try {
                    $pq = Start-Process -FilePath $smiPath -ArgumentList '-q' `
                        -NoNewWindow -Wait -PassThru `
                        -RedirectStandardOutput $qOut -RedirectStandardError $qErr
                    $qso = (Get-Content -LiteralPath $qOut -Raw -ErrorAction SilentlyContinue)
                    if ($pq.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($qso)) {
                        # "Driver Version : 560.94" (already XXX.YY); normalise defensively.
                        $drvLines = @([regex]::Matches($qso, '(?im)^\s*Driver Version\s*:\s*(.+?)\s*$'))
                        $smiDrvShort = $null
                        if ($drvLines.Count -gt 0) {
                            $smiDrvRaw = $drvLines[0].Groups[1].Value.Trim()
                            $smiDrvShort = Get-NvDriverShort $smiDrvRaw
                            if (-not $smiDrvShort) { $smiDrvShort = $smiDrvRaw }
                            $script:SmiDriverShort = $smiDrvShort
                            Report 'nvidia-smi' 'INFO' ("nvidia-smi -q reports Driver Version {0}." -f $smiDrvRaw)
                        }
                        # Count attached GPUs (each block starts with "GPU 00000000:..").
                        $gpuCount = @([regex]::Matches($qso, '(?im)^\s*GPU\s+[0-9A-Fa-f]{8}:')).Count
                        if ($gpuCount -gt 1) {
                            Report 'nvidia-smi' 'INFO' ("nvidia-smi sees {0} GPUs - if they use different drivers, NVML loads the primary one." -f $gpuCount)
                        }
                        # Compare the loaded driver vs the installed driver (WMI).
                        if ($smiDrvShort -and $script:DriverShort) {
                            if ($smiDrvShort -ne $script:DriverShort) {
                                Report 'nvidia-smi' 'WARN' ("DRIVER MISMATCH: nvidia-smi loaded driver v{0} but WMI reports the installed driver as v{1}. A different driver/NVML is being picked up (possible shadowing copy on PATH - see section 4b)." -f $smiDrvShort, $script:DriverShort)
                            } else {
                                Report 'nvidia-smi' 'OK' ("Driver-load verified: nvidia-smi driver v{0} == installed driver v{1} (the correct driver loads by default)." -f $smiDrvShort, $script:DriverShort)
                            }
                        }
                    }
                } catch {
                    Report 'nvidia-smi' 'INFO' ("nvidia-smi -q driver-load verification skipped: {0}" -f $_.Exception.Message)
                } finally {
                    Remove-Item -LiteralPath $qOut, $qErr -Force -ErrorAction SilentlyContinue
                }

                # nvidia-smi -L: the GPU list NVML actually enumerates (cross-check
                # against the WMI/PnP view in sections 1/1b).
                $lOut = Join-Path $env:TEMP ("pianoid_smil_out_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
                $lErr = Join-Path $env:TEMP ("pianoid_smil_err_{0}.txt" -f ([guid]::NewGuid().ToString('N')))
                try {
                    $pl = Start-Process -FilePath $smiPath -ArgumentList '-L' `
                        -NoNewWindow -Wait -PassThru `
                        -RedirectStandardOutput $lOut -RedirectStandardError $lErr
                    $lso = (Get-Content -LiteralPath $lOut -Raw -ErrorAction SilentlyContinue)
                    if ($pl.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($lso)) {
                        Report 'nvidia-smi' 'INFO' ("nvidia-smi -L: {0}" -f ($lso.Trim() -replace "`r?`n", ' ; '))
                    }
                } catch {
                } finally {
                    Remove-Item -LiteralPath $lOut, $lErr -Force -ErrorAction SilentlyContinue
                }
            } else {
                $msg = $se; if ([string]::IsNullOrWhiteSpace($msg)) { $msg = $so }
                if ([string]::IsNullOrWhiteSpace($msg)) { $msg = '(no output)' }
                Report 'nvidia-smi' 'FAIL' ("nvidia-smi FAILED (exit {0}). Output: {1}" -f $code, ($msg.Trim() -replace "`r?`n", ' / '))
                # NVML signatures: "NVML not found" / "Failed to load NVML" /
                # "driver/library version mismatch" (the classic mismatch wording).
                if ($msg -match 'NVML' -or $msg -match 'driver/library version mismatch' -or $msg -match 'version mismatch') {
                    $script:SmiNvmlError = $true
                    Report 'nvidia-smi' 'FAIL' 'NVML error confirmed via nvidia-smi -> see section 3 (nvml.dll). This is a DRIVER problem; reinstall/repair the NVIDIA display driver.'
                    # Present-but-mismatched signature: NVML error from nvidia-smi
                    # WHILE nvml.dll exists (section 3 found it in System32).
                    if (-not [string]::IsNullOrWhiteSpace($script:NvmlSys32Short)) {
                        Report 'nvidia-smi' 'FAIL' ("nvml.dll IS present in System32 (v{0}) yet nvidia-smi cannot load NVML -> present-but-UNLOADABLE = a version mismatch with the driver (v{1}). See the DIAGNOSIS section for the precise fix." -f `
                            $script:NvmlSys32Short, $(if ($script:DriverShort) { $script:DriverShort } else { 'unknown' }))
                    }
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
# 4b. COMPREHENSIVE PATH SCAN - for EVERY directory on PATH (Machine THEN User,
#     the order Windows uses) search for the four NVIDIA load-critical files:
#       nvml.dll       (NVML, driver-side)
#       nvcuda.dll     (CUDA Driver API, driver-side)
#       cudart64_*.dll (CUDA runtime - toolkit / app-bundled)
#       nvidia-smi.exe (driver tool)
#     Report each hit's full path + FileVersion, then FLAG the classic
#     "persists after reinstall" causes:
#       (a) >1 nvml.dll (or nvcuda.dll) with DIFFERENT versions across PATH+System32;
#       (b) a driver DLL on PATH that appears BEFORE System32 -> it SHADOWS the
#           correct System32 copy (so a driver reinstall doesn't take effect);
#       (c) a stray older copy from a different CUDA/driver install.
#     System32 holds the LEGITIMATE driver copies; the goal is to find copies
#     that PRECEDE it in the search order.
# -------------------------------------------------------------------------
Write-Section '4b. Comprehensive PATH scan (nvml / nvcuda / cudart / nvidia-smi)'
try {
    $sys32DirNorm = (Join-Path $env:SystemRoot 'System32').TrimEnd('\').ToLowerInvariant()

    # Build the ORDERED, de-duplicated directory list the way the loader sees it:
    # Machine PATH first, then User PATH (this is the effective DLL search order
    # for PATH). Fall back to the process PATH if a registry read fails.
    $orderedDirs = New-Object System.Collections.ArrayList
    $seen = New-Object System.Collections.Generic.HashSet[string]
    function Add-Dirs {
        param([string] $PathValue)
        if ([string]::IsNullOrWhiteSpace($PathValue)) { return }
        foreach ($d in ($PathValue -split ';')) {
            if ([string]::IsNullOrWhiteSpace($d)) { continue }
            # Expand any %VAR% the registry stores unexpanded.
            $de = [System.Environment]::ExpandEnvironmentVariables($d).TrimEnd('\')
            if ([string]::IsNullOrWhiteSpace($de)) { continue }
            $key = $de.ToLowerInvariant()
            if ($seen.Add($key)) { [void]$orderedDirs.Add($de) }
        }
    }
    $machPath = $null; $userPath = $null
    try { $machPath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') } catch { }
    try { $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User') } catch { }
    if ([string]::IsNullOrWhiteSpace($machPath) -and [string]::IsNullOrWhiteSpace($userPath)) {
        Add-Dirs $env:Path                  # registry unavailable -> process PATH
    } else {
        Add-Dirs $machPath                  # Machine first ...
        Add-Dirs $userPath                  # ... then User
        Add-Dirs $env:Path                  # plus any process-only dirs, last
    }

    # Index of System32 in the ordered list (-1 if, oddly, not present).
    $sys32Index = -1
    for ($i = 0; $i -lt $orderedDirs.Count; $i++) {
        if ($orderedDirs[$i].TrimEnd('\').ToLowerInvariant() -eq $sys32DirNorm) { $sys32Index = $i; break }
    }

    # Scan one file pattern across the ordered dirs. Returns the hit list
    # ([pscustomobject]@{ Path; Version; Index }) and reports each one.
    function Scan-PathFor {
        param([string] $Area, [string] $Pattern, [bool] $IsDriverComp)
        $hits = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $orderedDirs.Count; $i++) {
            $dir = $orderedDirs[$i]
            try {
                if (-not (Test-Path -LiteralPath $dir)) { continue }
                $found = @(Get-ChildItem -LiteralPath $dir -Filter $Pattern -File -ErrorAction SilentlyContinue)
                foreach ($f in $found) {
                    $ver = ''
                    try { $ver = $f.VersionInfo.FileVersion } catch { }
                    $inSys32 = ($dir.TrimEnd('\').ToLowerInvariant() -eq $sys32DirNorm)
                    $tag = if ($inSys32) { ' [System32]' } else { '' }
                    Report $Area 'INFO' ("{0} @ {1} (FileVersion {2}){3}" -f $Pattern, $f.FullName, $ver, $tag)
                    [void]$hits.Add([pscustomobject]@{ Path = $f.FullName; Version = $ver; Index = $i; InSys32 = $inSys32 })
                }
            } catch { }
        }
        if ($hits.Count -eq 0) {
            Report $Area 'INFO' ("No {0} found on any PATH directory." -f $Pattern)
        }
        return ,$hits
    }

    # --- nvml.dll (driver-side): shadowing + multi-version are the headline flags.
    $nvmlHits = Scan-PathFor 'PATH-scan' 'nvml.dll' $true
    $nvmlNonSys32Before = @($nvmlHits | Where-Object { -not $_.InSys32 -and ($sys32Index -lt 0 -or $_.Index -lt $sys32Index) })
    if ($nvmlNonSys32Before.Count -gt 0) {
        $script:NvmlShadowed = $true
        Report 'PATH-scan' 'FAIL' ("SHADOWING: nvml.dll on a NON-System32 PATH dir appears BEFORE System32 in the search order -> {0}. This stray copy LOADS INSTEAD OF the driver's System32 nvml.dll, so a driver reinstall does NOT take effect until it is removed. Remove/rename it." -f (($nvmlNonSys32Before | ForEach-Object { "$($_.Path) (v$($_.Version))" }) -join ' ; '))
    }
    $nvmlVers = @($nvmlHits | Where-Object { $_.Version } | ForEach-Object { Get-NvDriverShort $_.Version } | Where-Object { $_ } | Select-Object -Unique)
    if ($nvmlVers.Count -gt 1) {
        $script:NvmlMultiVersion = $true
        Report 'PATH-scan' 'WARN' ("MULTIPLE nvml.dll VERSIONS across PATH+System32: {0}. Different copies from different driver/CUDA installs -> whichever loads first wins; keep only the System32 (driver) copy." -f ($nvmlVers -join ' / '))
    }

    # --- nvcuda.dll (driver-side, CUDA Driver API): same shadowing/multi-version logic.
    $nvcudaHits = Scan-PathFor 'PATH-scan' 'nvcuda.dll' $true
    $nvcudaNonSys32Before = @($nvcudaHits | Where-Object { -not $_.InSys32 -and ($sys32Index -lt 0 -or $_.Index -lt $sys32Index) })
    if ($nvcudaNonSys32Before.Count -gt 0) {
        $script:NvcudaShadowed = $true
        Report 'PATH-scan' 'FAIL' ("SHADOWING: nvcuda.dll on a NON-System32 PATH dir appears BEFORE System32 -> {0}. This stray CUDA Driver API copy loads instead of the driver's, causing cupy 'no CUDA-capable device' / driver mismatch even after a driver reinstall. Remove/rename it." -f (($nvcudaNonSys32Before | ForEach-Object { "$($_.Path) (v$($_.Version))" }) -join ' ; '))
    }
    $nvcudaVers = @($nvcudaHits | Where-Object { $_.Version } | ForEach-Object { Get-NvDriverShort $_.Version } | Where-Object { $_ } | Select-Object -Unique)
    if ($nvcudaVers.Count -gt 1) {
        $script:NvcudaMultiVersion = $true
        Report 'PATH-scan' 'WARN' ("MULTIPLE nvcuda.dll VERSIONS across PATH+System32: {0}. Keep only the System32 (driver) copy." -f ($nvcudaVers -join ' / '))
    }

    # --- cudart64_*.dll (toolkit / app runtime): informational - multiple copies
    #     are NORMAL (toolkit + each app bundles its own). Just list them.
    [void](Scan-PathFor 'PATH-scan' 'cudart64_*.dll' $false)

    # --- nvidia-smi.exe (driver tool): note if found outside System32/NVSMI.
    $smiHits = Scan-PathFor 'PATH-scan' 'nvidia-smi.exe' $false
    $smiStray = @($smiHits | Where-Object { -not $_.InSys32 -and ($_.Path -notmatch '(?i)\\NVSMI\\') })
    if ($smiStray.Count -gt 0 -and @($smiHits | Where-Object { $_.InSys32 }).Count -gt 0) {
        Report 'PATH-scan' 'WARN' ("nvidia-smi.exe also found outside System32/NVSMI: {0}. If it precedes System32, an older copy may run." -f (($smiStray | ForEach-Object { $_.Path }) -join ' ; '))
    }
} catch {
    Report 'PATH-scan' 'WARN' ("comprehensive PATH scan failed: {0}" -f $_.Exception.Message)
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

# DRIVER LIBRARY PROBLEM - a driver-side library (nvml.dll / nvcuda.dll) is
# PRESENT yet NVML/CUDA still fails. THREE distinct sub-causes (the verdict must
# name the right one - do NOT say "version mismatch" when versions actually match):
#   * SHADOW       - a stray copy on PATH precedes System32 (loads instead of it).
#   * VERSION-DIFF - an on-disk version actually differs from the driver.
#   * MATCHED-BUT-FAILS - versions match on disk + no shadow, yet NVML fails to
#                   initialise (Dmitri's case): loaded nvlddmkm desynced from disk
#                   [reboot], corrupt driver install [DDU], or a 2nd adapter.
# All three explain "persists after a reboot AND after re-running setup-packages"
# (setup-packages is the CUDA TOOLKIT and never touches these driver files).
$nvmlMismatchFlag   = @($script:Findings | Where-Object { $_.Area -eq 'NVML'   -and $_.Detail -match 'VERSION MISMATCH' }).Count -gt 0
$nvcudaMismatchFlag = @($script:Findings | Where-Object { $_.Area -eq 'nvcuda' -and $_.Detail -match 'VERSION MISMATCH' }).Count -gt 0
$driverShadowed     = $script:NvmlShadowed -or $script:NvcudaShadowed
# A REAL on-disk version difference (the only thing that earns the "VERSION
# MISMATCH" label): an explicit section-3/3d mismatch finding, OR nvidia-smi's
# loaded driver differing from the WMI installed driver.
$smiDriverDiff      = (-not [string]::IsNullOrWhiteSpace($script:SmiDriverShort)) -and `
                      (-not [string]::IsNullOrWhiteSpace($script:DriverShort)) -and `
                      ($script:SmiDriverShort -ne $script:DriverShort)
$realVersionMismatch = $nvmlMismatchFlag -or $nvcudaMismatchFlag -or $smiDriverDiff
# LOADED kernel module (nvlddmkm.sys, section 2b) vs the on-disk System32 driver
# libraries - a difference means a staged-but-not-rebooted driver (loaded desync).
$loadedKmodDesync = $false
if (-not [string]::IsNullOrWhiteSpace($script:KmodShort)) {
    if ((-not [string]::IsNullOrWhiteSpace($script:NvmlSys32Short)   -and $script:KmodShort -ne $script:NvmlSys32Short) -or `
        (-not [string]::IsNullOrWhiteSpace($script:NvcudaSys32Short) -and $script:KmodShort -ne $script:NvcudaSys32Short)) {
        $loadedKmodDesync = $true
    }
}
$script:KmodLoadedDesync = $loadedKmodDesync
$nvmlPresent        = -not [string]::IsNullOrWhiteSpace($script:NvmlSys32Short)
# "Matched but fails": a driver-library FAILURE actually occurred (so a HEALTHY
# box never shows this), nvml.dll IS present, but there is NO real version
# difference and NO PATH shadow. This is Dmitri's case.
$matchedButFails    = ($script:SmiNvmlError -or $cupyFail) -and $nvmlPresent -and `
                      (-not $realVersionMismatch) -and (-not $driverShadowed)
# The unified "wrong/failing driver library" trigger for the verdict branch.
$driverLibProblem   = $realVersionMismatch -or $driverShadowed -or $matchedButFails

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
elseif ($driverLibProblem) {
    # PRECEDENCE: checked BEFORE the cupy-blame branch, so a driver-library
    # problem is diagnosed correctly even though the DLL exists (which would
    # otherwise let $cupyFail win). THREE sub-cases, labelled accurately:
    #   $driverShadowed      -> SHADOW
    #   $realVersionMismatch -> VERSION MISMATCH (versions actually differ)
    #   else ($matchedButFails) -> MATCHED-BUT-FAILS (present + matched, NVML fails)
    $nvmlVerStr   = if ($script:NvmlSys32Short)   { "v$($script:NvmlSys32Short)" }   else { 'present (version unreadable)' }
    $nvcudaVerStr = if ($script:NvcudaSys32Short) { "v$($script:NvcudaSys32Short)" } else { 'present (version unreadable)' }
    $drvVerStr    = if ($script:DriverShort)      { "v$($script:DriverShort)" }      else { 'unknown' }
    $kmodVerStr   = if ($script:KmodShort)        { "v$($script:KmodShort)" }        else { 'unreadable' }

    if ($driverShadowed) {
        Write-Host '  VERDICT: DRIVER LIBRARY PROBLEM (SHADOWING) - a driver-side library (nvml.dll /'
        Write-Host '           nvcuda.dll) is PRESENT, but a STRAY copy on PATH SHADOWS the correct System32'
        Write-Host '           copy (it loads INSTEAD of the driver`s) - so NVML/CUDA fail. This is why the'
        Write-Host '           error PERSISTS after a reboot AND a driver reinstall (the reinstall fixes'
        Write-Host '           System32, but the stray PATH copy still wins). See section 4b for the file(s).'
    }
    elseif ($realVersionMismatch) {
        Write-Host '  VERDICT: DRIVER LIBRARY PROBLEM (VERSION MISMATCH) - a driver-side library is PRESENT'
        Write-Host '           but its version actually DIFFERS from the installed display driver, so it'
        Write-Host '           cannot load (the user-mode library is out of sync with the kernel driver).'
    }
    elseif ($script:DriverServiceStopped) {
        # HIGHEST-priority matched-but-fails sub-case: the driver service is not
        # running. Files match + Code 0, but nvlddmkm is Stopped -> NVML "Not
        # Found" / "no CUDA device". This is Dmitri's actual root cause; rank it
        # ABOVE the generic loaded-desync / corruption / hybrid causes.
        Write-Host '  VERDICT: NVIDIA driver service (nvlddmkm) is NOT running - the driver is INSTALLED but'
        Write-Host '           not loaded / not servicing the GPU. The on-disk nvml.dll / nvcuda.dll versions'
        Write-Host '           MATCH the display driver and Device Manager shows no device problem, but with'
        Write-Host '           the service Stopped, NVML reports "Not Found" / "no CUDA-capable device". This'
        Write-Host '           is the root cause (NOT a version mismatch, NOT a toolkit problem).'
        Write-Host '  FIX (in order):'
        Write-Host '   1. REBOOT - this starts the driver service in most cases.'
        if ($script:StaleDriverPackage) {
            Write-Host '   2. ★ A STALE older-driver DriverStore package was detected (section 3) coexisting'
            Write-Host '      with the current driver - a leftover package can BLOCK the new service from'
            Write-Host '      starting. Do a DDU (Display Driver Uninstaller) clean wipe in Safe Mode, then'
            Write-Host '      reinstall the CURRENT driver from nvidia.com / the NVIDIA App, then reboot.'
        } else {
            Write-Host '   2. If it persists: DDU (Display Driver Uninstaller) clean wipe in Safe Mode, then'
            Write-Host '      reinstall the current driver from nvidia.com / the NVIDIA App, then reboot -'
            Write-Host '      ESPECIALLY if a stale older-driver DriverStore package coexists (it can block'
            Write-Host '      the new service from starting).'
        }
        if ($script:SecondAdapter) {
            Write-Host '   3. Hybrid graphics detected (section 1b): after the service runs, ensure the NVIDIA'
            Write-Host '      GPU is selected as the high-performance adapter so CUDA/NVML target it.'
        }
    }
    else {
        # MATCHED-BUT-FAILS (service running): loaded-desync / corruption / hybrid.
        Write-Host '  VERDICT: DRIVER LIBRARY PRESENT + VERSION-MATCHED ON DISK, yet NVML FAILS to initialise.'
        Write-Host '           The on-disk nvml.dll / nvcuda.dll versions MATCH the display driver and there'
        Write-Host '           is NO shadowing copy on PATH - so this is NOT a version mismatch. The likely'
        Write-Host '           causes (in order of likelihood):'
        if ($loadedKmodDesync) {
            Write-Host ("           (a) ★ the LOADED kernel module nvlddmkm ({0}) is OUT OF SYNC with the" -f $kmodVerStr)
            Write-Host ("               on-disk libraries ({0}) - a driver update was staged but the OLD module" -f $nvmlVerStr)
            Write-Host '               is still loaded.  FIX: REBOOT (this alone usually clears it).'
        } else {
            Write-Host '           (a) the LOADED kernel module nvlddmkm is out of sync with the on-disk'
            Write-Host '               libraries (driver update staged, not yet active).  FIX: REBOOT.'
        }
        Write-Host '           (b) the driver install / registration is CORRUPT.  FIX: DDU clean reinstall.'
        if ($script:StaleDriverPackage) {
            Write-Host '               ★ A stale older-driver DriverStore package was detected (section 3) -'
            Write-Host '               a DDU clean wipe is especially indicated.'
        }
        if ($script:SecondAdapter) {
            Write-Host '           (c) ★ a SECOND / default display adapter (section 1b) is shadowing the NVIDIA'
            Write-Host '               GPU (hybrid/Optimus).  FIX: in the NVIDIA Control Panel / Windows Graphics'
            Write-Host '               settings, set the NVIDIA GPU as the high-performance/default for the app.'
        } else {
            Write-Host '           (c) a second/default display adapter shadowing the NVIDIA GPU (none detected'
            Write-Host '               here - see section 1b).'
        }
    }

    Write-Host ("  VERSIONS: System32 nvml.dll = {0} | System32 nvcuda.dll = {1} | display driver = {2} | loaded nvlddmkm.sys = {3}" -f $nvmlVerStr, $nvcudaVerStr, $drvVerStr, $kmodVerStr)
    Write-Host ''
    Write-Host '  *** TOOLKIT vs DRIVER (read this) ***'
    Write-Host '  Re-running setup-packages (the CUDA TOOLKIT) does NOT reinstall the display driver and'
    Write-Host '  will NOT fix nvml.dll / nvcuda.dll - those are DISPLAY-DRIVER files, not toolkit files.'
    Write-Host '  That is why "driver reinstallation via setup-packages" did not help: it never touched them.'
    Write-Host ''
    Write-Host '  FIX (in order):'
    if ($driverShadowed) {
        Write-Host '   1. REMOVE THE SHADOWING COPY first (section 4b lists it): delete/rename the stray'
        Write-Host '      nvml.dll / nvcuda.dll on the NON-System32 PATH directory (or remove that directory'
        Write-Host '      from PATH) so the driver`s System32 copy loads. This is the likely root cause of'
        Write-Host '      "persists after reinstall".'
        Write-Host '   2. Reboot, then re-run this diagnostic - section 4b should show only the System32 copy.'
        Write-Host '   3. If STILL broken: do a REAL DISPLAY-DRIVER reinstall - DDU (Display Driver'
        Write-Host '      Uninstaller) in Safe Mode, then a fresh driver from nvidia.com / the NVIDIA App,'
        Write-Host '      then reboot. (NOT setup-packages / the CUDA toolkit.)'
    } else {
        Write-Host '   1. REBOOT FIRST. A driver update applied without a reboot leaves the loaded kernel'
        Write-Host '      module (nvlddmkm) out of sync with the on-disk nvml.dll/nvcuda.dll until restart'
        Write-Host '      - a reboot ALONE often clears "driver/library version mismatch".'
        Write-Host '   2. If still broken: do a REAL DISPLAY-DRIVER reinstall - DDU (Display Driver'
        Write-Host '      Uninstaller) in Safe Mode to fully remove the driver, then install a fresh driver'
        Write-Host '      from nvidia.com / the NVIDIA App, then reboot. This repairs a corrupt install and'
        Write-Host '      restores matching driver libraries. (NOT setup-packages / the CUDA toolkit.)'
        Write-Host '   3. Check no stray older nvml.dll / nvcuda.dll sits on a PATH directory shadowing'
        Write-Host '      System32 (section 4b reports any). If one exists, remove it.'
        if ($script:SecondAdapter) {
            Write-Host '   4. Hybrid graphics detected (section 1b): ensure the NVIDIA GPU is selected as the'
            Write-Host '      high-performance adapter so CUDA/NVML target it, not the integrated GPU.'
        }
    }
    Write-Host '  THEN: reboot and re-run this diagnostic - section 4 (nvidia-smi) should pass.'
    Write-Host '  NOTE: Pianoid synthesis needs a WORKING CUDA runtime; until NVML initialises, the UI'
    Write-Host '        loads but APPLY/synthesis fails. The launcher warns about this.'
}
elseif ($nvmlFail -or ($smiFail -and -not $nvmlInSys32)) {
    Write-Host '  VERDICT: GPU + driver are present, but NVML is broken ("NVML not found").'
    Write-Host '  ROOT CAUSE: nvml.dll (a DRIVER component, version-locked to the display driver)'
    Write-Host '              is MISSING from C:\Windows\System32 or not loadable. This is NOT'
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
