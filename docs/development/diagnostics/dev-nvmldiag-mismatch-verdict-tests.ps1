# =========================================================================
# dev-nvmldiag-mismatch-verdict-tests.ps1
#
# Test harness for the NVML version-mismatch detection added to
# diagnose-cuda.ps1 (section 3 version comparison, section 4 NVML-error
# signature, section 8 verdict precedence).
#
# WHY a harness: this box has HEALTHY CUDA (versions MATCH), so the mismatch
# case cannot be reproduced live. This harness STUBS the version values and the
# Findings list that the real probes would produce on the broken box (Dmitri's:
# System32 nvml.dll v560.94 vs driver v552.xx, nvidia-smi NVML error) and
# asserts:
#   (1) Get-NvDriverShort normalises NVIDIA version strings correctly (the
#       last-5-digits rule), incl. the differing nvml.dll vs WMI lead parts.
#   (2) The section-8 verdict SELECTION fires the new NVML-MISMATCH branch and
#       that it takes PRECEDENCE over the cupy-blame branch EVEN WHEN nvml.dll
#       exists in System32 (the bug the change fixes).
#   (3) The healthy case (versions match) does NOT fire a false mismatch.
#   (4) The genuinely-missing case still routes to the NVML-missing branch.
#
# The verdict cascade is faithfully MIRRORED here from diagnose-cuda.ps1 section
# 8 (same boolean expressions, same elseif order) and the result is reduced to a
# single branch label, so a precedence regression in the real script's ordering
# would be caught by re-syncing this mirror. Get-NvDriverShort is DOT-SOURCED
# from the real script (no re-implementation) by extracting its function body.
#
# READ-ONLY. PowerShell 5.1 compatible. Exit 0 = all pass, 1 = a failure.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <thisfile>
# =========================================================================

$ErrorActionPreference = 'Stop'

$ScriptUnderTest = Join-Path $PSScriptRoot '..\..\..\diagnose-cuda.ps1'
$ScriptUnderTest = [System.IO.Path]::GetFullPath($ScriptUnderTest)

if (-not (Test-Path -LiteralPath $ScriptUnderTest)) {
    Write-Host "FAIL: cannot find diagnose-cuda.ps1 at $ScriptUnderTest"
    exit 1
}

# ---- Pull the REAL Get-NvDriverShort out of the script (no re-implementation).
# Parse the script's AST and extract the function definition so the test runs the
# exact normalisation code that ships.
$errs = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptUnderTest, [ref]$tokens, [ref]$errs)
if ($errs.Count -gt 0) {
    Write-Host "FAIL: diagnose-cuda.ps1 has parse errors:"
    $errs | ForEach-Object { Write-Host (" - line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) }
    exit 1
}
$fnAst = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-NvDriverShort' }, $true) | Select-Object -First 1
if (-not $fnAst) {
    Write-Host "FAIL: Get-NvDriverShort not found in diagnose-cuda.ps1"
    exit 1
}
# Define the real function in this session.
Invoke-Expression $fnAst.Extent.Text

$Failures = New-Object System.Collections.ArrayList
function Assert-Equal {
    param([string] $What, $Expected, $Actual)
    if ("$Expected" -eq "$Actual") {
        Write-Host ("  [PASS] {0} = {1}" -f $What, $Actual)
    } else {
        Write-Host ("  [FAIL] {0}: expected '{1}' got '{2}'" -f $What, $Expected, $Actual)
        [void]$Failures.Add($What)
    }
}

# -------------------------------------------------------------------------
# Part 1 - Get-NvDriverShort normalisation (the real shipped function).
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 1: Get-NvDriverShort (real function, AST-extracted) =='
# WMI DriverVersion form and nvml.dll FileVersion form have DIFFERENT lead parts
# but the SAME last 5 digits -> both must normalise to the same driver number.
Assert-Equal 'WMI 32.0.15.6094   -> 560.94' '560.94' (Get-NvDriverShort '32.0.15.6094')
Assert-Equal 'nvml 8.17.15.6094  -> 560.94' '560.94' (Get-NvDriverShort '8.17.15.6094')
Assert-Equal 'older 31.0.15.5222 -> 552.22' '552.22' (Get-NvDriverShort '31.0.15.5222')
Assert-Equal 'older 27.21.14.5671-> 456.71' '456.71' (Get-NvDriverShort '27.21.14.5671')
Assert-Equal 'already-short 560.94-> 560.94' '560.94' (Get-NvDriverShort '560.94')
Assert-Equal 'empty -> $null'            ''       (Get-NvDriverShort '')
Assert-Equal 'too-few-digits 1.2 -> $null' ''     (Get-NvDriverShort '1.2')

# -------------------------------------------------------------------------
# The verdict cascade, mirrored from diagnose-cuda.ps1 section 8. Given a
# stubbed Findings list + captured version vars, returns the single branch
# label that the real script's elseif cascade would select. Keep this in lockstep
# with section 8 (same boolean expressions, same order).
# -------------------------------------------------------------------------
function Get-Verdict {
    param(
        [System.Collections.ArrayList] $Findings,
        [string] $NvmlSys32Short,
        [string] $DriverShort,
        [bool]   $SmiNvmlError,
        [bool]   $NvmlShadowed = $false,
        [bool]   $NvcudaShadowed = $false,
        [string] $NvcudaSys32Short = '',
        [string] $KmodShort = '',
        [string] $SmiDriverShort = '',
        [bool]   $DriverServiceStopped = $false
    )
    $has = { param($area, $status) @($Findings | Where-Object { $_.Area -eq $area -and $_.Status -eq $status }).Count -gt 0 }

    $gpuPresent   = (& $has 'GPU' 'OK')
    $driverFail   = (& $has 'Driver' 'FAIL')
    $nvmlFail     = (& $has 'NVML' 'FAIL')
    $nvmlInSys32  = @($Findings | Where-Object { $_.Area -eq 'NVML' -and $_.Status -eq 'OK' }).Count -gt 0
    $smiFail      = (& $has 'nvidia-smi' 'FAIL')
    $cupyFail     = (& $has 'cupy' 'FAIL')
    $cupyOk       = @($Findings | Where-Object { $_.Area -eq 'cupy' -and $_.Detail -match 'Device \d+:' }).Count -gt 0
    $lowSm        = @($Findings | Where-Object { $_.Area -eq 'cupy' -and $_.Status -eq 'WARN' -and $_.Detail -match 'SMs' }).Count -gt 0
    $smiOkFinding = @($Findings | Where-Object { $_.Area -eq 'nvidia-smi' -and $_.Status -eq 'OK' }).Count -gt 0
    $cupyInconclusive = (-not $cupyOk) -and (-not $cupyFail)

    # Mirrors section 8 (refined): distinguish SHADOW vs real VERSION-DIFF vs
    # MATCHED-BUT-FAILS. Return distinct labels so the harness asserts the LABEL,
    # not just that the branch fires (the whole point of this refinement).
    $nvmlMismatchFlag   = @($Findings | Where-Object { $_.Area -eq 'NVML'   -and $_.Detail -match 'VERSION MISMATCH' }).Count -gt 0
    $nvcudaMismatchFlag = @($Findings | Where-Object { $_.Area -eq 'nvcuda' -and $_.Detail -match 'VERSION MISMATCH' }).Count -gt 0
    $driverShadowed     = $NvmlShadowed -or $NvcudaShadowed
    $smiDriverDiff      = (-not [string]::IsNullOrWhiteSpace($SmiDriverShort)) -and `
                          (-not [string]::IsNullOrWhiteSpace($DriverShort)) -and `
                          ($SmiDriverShort -ne $DriverShort)
    $realVersionMismatch = $nvmlMismatchFlag -or $nvcudaMismatchFlag -or $smiDriverDiff
    $nvmlPresent        = -not [string]::IsNullOrWhiteSpace($NvmlSys32Short)
    $matchedButFails    = ($SmiNvmlError -or $cupyFail) -and $nvmlPresent -and `
                          (-not $realVersionMismatch) -and (-not $driverShadowed)
    $driverLibProblem   = $realVersionMismatch -or $driverShadowed -or $matchedButFails

    if (-not $gpuPresent)            { return 'no-gpu' }
    elseif ($driverFail)             { return 'no-driver' }
    elseif ($driverLibProblem) {
        if ($driverShadowed)          { return 'driver-lib-shadow' }
        elseif ($realVersionMismatch) { return 'driver-lib-version-mismatch' }
        elseif ($DriverServiceStopped) { return 'driver-service-stopped' }
        else                          { return 'driver-lib-matched-but-fails' }
    }
    elseif ($nvmlFail -or ($smiFail -and -not $nvmlInSys32)) { return 'nvml-missing' }
    elseif ($cupyFail)               { return 'cupy-runtime' }
    elseif ($lowSm)                  { return 'low-sm' }
    elseif ($cupyOk)                 { return 'healthy' }
    elseif ($smiOkFinding -and $cupyInconclusive) { return 'smi-ok-cupy-inconclusive' }
    else                             { return 'inconclusive' }
}

# NOTE: the unary comma prevents PowerShell from UNROLLING the (empty) ArrayList
# on return, which would otherwise yield $null. Returns the list as one object.
function New-Findings { return ,(New-Object System.Collections.ArrayList) }
function Add-F {
    param([System.Collections.ArrayList] $F, [string] $Area, [string] $Status, [string] $Detail = '')
    [void]$F.Add([pscustomobject]@{ Area = $Area; Status = $Status; Detail = $Detail })
}

# -------------------------------------------------------------------------
# Part 2 - REAL version mismatch: nvml.dll present, an explicit section-3 VERSION
# MISMATCH finding (560.94 on disk vs 552.22 driver), nvidia-smi NVML error, cupy
# fails. Verdict MUST be driver-lib-version-mismatch (NOT cupy-runtime, and the
# "VERSION MISMATCH" label IS correct here because versions actually differ).
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 2: REAL version mismatch -> driver-lib-version-mismatch (precedence over cupy) =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ... (NVIDIA driver ~552.22)'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 (FileVersion 8.17.15.6094).'   # present!
Add-F $f 'NVML' 'FAIL' 'VERSION MISMATCH: System32 nvml.dll is v560.94 ... driver is v552.22 ...'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED (exit 255). Output: Failed to initialize NVML: driver/library version mismatch'
Add-F $f 'nvidia-smi' 'FAIL' 'NVML error confirmed via nvidia-smi ...'
Add-F $f 'cupy' 'FAIL' 'cupy 14.0.1: getDeviceCount/properties FAILED -> CUDARuntimeError: ...'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '552.22' -SmiNvmlError $true
Assert-Equal 'verdict (real version mismatch + cupyfail)' 'driver-lib-version-mismatch' $v

# Sub-case 2b: smi NVML error + nvml present, NO explicit VERSION MISMATCH finding
# and NO driver short to compare -> NOT a real version diff -> MATCHED-BUT-FAILS.
Write-Host ''
Write-Host '== Part 2b: smi NVML-error + nvml present, no real version diff -> matched-but-fails =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 (FileVersion 8.17.15.6094).'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... Failed to load NVML library'
Add-F $f 'cupy' 'FAIL' 'cupy ... device query failed'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '' -SmiNvmlError $true
Assert-Equal 'verdict (smi-nvml-error + present, no version diff)' 'driver-lib-matched-but-fails' $v

# -------------------------------------------------------------------------
# Part 3 - healthy box: versions match, no smi error -> NOT a mismatch.
# (Mirrors what the live run on this box produces.)
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 3: healthy (versions match) -> NOT mismatch =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ... (NVIDIA driver ~560.94)'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: System32 nvml.dll v560.94 == display driver v560.94.'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works. GPU(s): ...'
Add-F $f 'cupy' 'WARN' 'Device 0: NVIDIA GeForce RTX 4070 SUPER | 56 SMs (< 60 SMs ...)'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false
Assert-Equal 'verdict (healthy 56-SM box)' 'low-sm' $v

# Sub-case 3b: healthy with >=60 SMs -> healthy verdict, no mismatch.
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: ...'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works ...'
Add-F $f 'cupy' 'OK' 'Device 0: NVIDIA ... | 128 SMs'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false
Assert-Equal 'verdict (healthy 128-SM box)' 'healthy' $v

# -------------------------------------------------------------------------
# Part 4 - genuinely-MISSING nvml.dll -> nvml-missing (NOT mismatch).
# No NVML 'OK' present-finding; an NVML FAIL 'MISSING'; smi fails; sys32 short empty.
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 4: nvml.dll MISSING -> nvml-missing =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'FAIL' 'nvml.dll is MISSING from C:\Windows\System32\nvml.dll ...'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... Failed to load NVML library'
Add-F $f 'nvidia-smi' 'FAIL' 'NVML error confirmed via nvidia-smi ...'
# NvmlSys32Short is EMPTY (no System32 copy). Even though SmiNvmlError is true,
# the mismatch path requires a present System32 nvml.dll -> must NOT fire mismatch.
$v = Get-Verdict -Findings $f -NvmlSys32Short '' -DriverShort '560.94' -SmiNvmlError $true
Assert-Equal 'verdict (nvml missing, smi nvml-error)' 'nvml-missing' $v

# -------------------------------------------------------------------------
# Part 5 - no-driver and no-gpu still win at the top of the cascade.
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 5: no-driver / no-gpu precedence =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'FAIL' 'nvlddmkm NVIDIA kernel driver service NOT found ...'
Add-F $f 'NVML' 'OK' 'nvml.dll present ...'
Add-F $f 'NVML' 'FAIL' 'VERSION MISMATCH ...'   # even with a mismatch finding,
Add-F $f 'nvidia-smi' 'FAIL' 'NVML error ...'   # no-driver is more fundamental
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '552.22' -SmiNvmlError $true
Assert-Equal 'verdict (driver FAIL beats mismatch)' 'no-driver' $v

$f = New-Findings
Add-F $f 'GPU' 'FAIL' 'No display adapters ...'
$v = Get-Verdict -Findings $f -NvmlSys32Short '' -DriverShort '' -SmiNvmlError $false
Assert-Equal 'verdict (no GPU)' 'no-gpu' $v

# -------------------------------------------------------------------------
# Part 6 - nvcuda.dll VERSION MISMATCH (no nvml mismatch) -> driver-lib-problem,
# precedence over cupy. nvcuda is present but the wrong version; cupy fails with
# "no CUDA-capable device". Must NOT be blamed on cupy.
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 6: nvcuda.dll mismatch (nvml OK) -> driver-lib-version-mismatch (precedence over cupy) =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ... (NVIDIA driver ~560.94)'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: System32 nvml.dll v560.94 == display driver v560.94.'
Add-F $f 'nvcuda' 'OK' 'nvcuda.dll present in System32 (FileVersion ...).'
Add-F $f 'nvcuda' 'FAIL' 'VERSION MISMATCH: System32 nvcuda.dll is v552.22 ... driver is v560.94 ...'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works ...'        # smi can be fine; nvcuda only bites CUDA
Add-F $f 'cupy' 'FAIL' 'cupy ...: getDeviceCount FAILED -> CUDARuntimeError: no CUDA-capable device is detected'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -NvcudaSys32Short '552.22'
Assert-Equal 'verdict (nvcuda mismatch + cupy fail)' 'driver-lib-version-mismatch' $v

# -------------------------------------------------------------------------
# Part 7 - SHADOWING: a stray nvml.dll on a non-System32 PATH dir precedes
# System32 (NvmlShadowed=true). The "persists after reinstall" case. Verdict
# = driver-lib-shadow (the SHADOW label, not version-mismatch).
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 7: nvml shadowing on PATH -> driver-lib-shadow (precedence over cupy) =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'PATH-scan' 'FAIL' 'SHADOWING: nvml.dll on a NON-System32 PATH dir appears BEFORE System32 ...'
Add-F $f 'cupy' 'FAIL' 'cupy ... device query failed'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -NvmlShadowed $true
Assert-Equal 'verdict (nvml shadow + cupy fail)' 'driver-lib-shadow' $v

# Sub-case 7b: nvcuda shadowing (NvcudaShadowed) -> shadow (takes precedence even
# if a real version diff ALSO existed - shadow is the first sub-case checked).
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'PATH-scan' 'FAIL' 'SHADOWING: nvcuda.dll on a NON-System32 PATH dir appears BEFORE System32 ...'
Add-F $f 'cupy' 'FAIL' 'cupy ... no CUDA-capable device'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -NvcudaShadowed $true
Assert-Equal 'verdict (nvcuda shadow + cupy fail)' 'driver-lib-shadow' $v

# Sub-case 7c: healthy box with MULTIPLE cudart copies (toolkit + PhysX, as on this
# box) but NO shadow/mismatch -> must NOT trip the driver-lib-problem branch.
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: ...'
Add-F $f 'nvcuda' 'OK' 'Version match: ...'
Add-F $f 'PATH-scan' 'INFO' 'cudart64_*.dll @ ...v12.6...cudart64_12.dll'
Add-F $f 'PATH-scan' 'INFO' 'cudart64_*.dll @ ...PhysX...cudart64_65.dll'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works ...'
Add-F $f 'cupy' 'OK' 'Device 0: NVIDIA ... | 128 SMs'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -NvmlShadowed $false -NvcudaShadowed $false -KmodShort '560.94' -NvcudaSys32Short '560.94'
Assert-Equal 'verdict (healthy, multi-cudart, no shadow)' 'healthy' $v

# -------------------------------------------------------------------------
# Part 8 - THE refinement headline: MATCHED-BUT-FAILS (Dmitri's actual run).
# nvml + nvcuda + driver all v560.94 (MATCH on disk), no PATH shadow, yet NVML
# fails (nvidia-smi FAIL + cupy FAIL). Verdict MUST be matched-but-fails, NOT
# version-mismatch (the bug this refinement fixes).
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 8: versions MATCH on disk but NVML fails -> matched-but-fails (NOT version-mismatch) =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ... (NVIDIA driver ~560.94)'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 (FileVersion 8.17.15.6094).'
Add-F $f 'NVML' 'OK' 'Version match: System32 nvml.dll v560.94 == display driver v560.94.'
Add-F $f 'nvcuda' 'OK' 'Version match: System32 nvcuda.dll v560.94 == display driver v560.94.'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... Failed to initialize NVML: driver/library version mismatch'
Add-F $f 'cupy' 'FAIL' 'cupy ...: getDeviceCount FAILED -> no CUDA-capable device'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $true -NvcudaSys32Short '560.94' -KmodShort '560.94'
Assert-Equal 'verdict (versions match, NVML fails)' 'driver-lib-matched-but-fails' $v

# Sub-case 8b: same MATCHED-BUT-FAILS, but with a LOADED-kernel-module desync
# (loaded nvlddmkm v552.22 vs on-disk v560.94) - still matched-but-fails (the
# desync drives the wording/recipe, not a different verdict).
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: System32 nvml.dll v560.94 == display driver v560.94.'
Add-F $f 'nvcuda' 'OK' 'Version match: ...'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... driver/library version mismatch'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $true -NvcudaSys32Short '560.94' -KmodShort '552.22'
Assert-Equal 'verdict (matched on disk, loaded kmod desync)' 'driver-lib-matched-but-fails' $v

# Sub-case 8c: nvidia-smi RAN but reports a driver DIFFERENT from WMI (smiDriverDiff)
# -> that IS a real version mismatch (a different driver loaded) -> version-mismatch.
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ... (NVIDIA driver ~560.94)'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works ...'
Add-F $f 'nvidia-smi' 'WARN' 'DRIVER MISMATCH: nvidia-smi loaded driver v552.22 but WMI ... v560.94 ...'
Add-F $f 'cupy' 'FAIL' 'cupy ... device query failed'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -SmiDriverShort '552.22'
Assert-Equal 'verdict (smi driver != WMI driver)' 'driver-lib-version-mismatch' $v

# Sub-case 8d: healthy box, NVML works, smi driver == WMI -> NOT matched-but-fails
# (gate requires an actual NVML/CUDA failure; this guards the healthy box).
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: ...'
Add-F $f 'nvcuda' 'OK' 'Version match: ...'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works ...'
Add-F $f 'cupy' 'WARN' 'Device 0: NVIDIA ... | 56 SMs ...'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -SmiDriverShort '560.94' -KmodShort '560.94' -NvcudaSys32Short '560.94'
Assert-Equal 'verdict (healthy, NVML works, no false matched-but-fails)' 'low-sm' $v

# -------------------------------------------------------------------------
# Part 9 - DRIVER SERVICE STOPPED (Dmitri's actual ROOT CAUSE). nvlddmkm present
# but State=Stopped/Started=False ($driverServiceStopped), files all match, yet
# NVML fails. This is the HIGHEST-priority matched-but-fails sub-case -> verdict
# driver-service-stopped (ranked above the generic loaded-desync/hybrid cause).
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '== Part 9: nvlddmkm service Stopped + files match + NVML fails -> driver-service-stopped =='
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA RTX 3080 ... (NVIDIA driver ~610.47)'
Add-F $f 'GPU-state' 'OK' 'PnP ConfigManagerErrorCode=0 (no device problem).'
Add-F $f 'Driver' 'WARN' 'NVIDIA driver SERVICE present but NOT running (State=Stopped, Started=False) ...'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'OK' 'Version match: System32 nvml.dll v610.47 == display driver v610.47.'
Add-F $f 'nvcuda' 'OK' 'Version match: System32 nvcuda.dll v610.47 == display driver v610.47.'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... Failed to initialize NVML: Not Found'
Add-F $f 'cupy' 'FAIL' 'cupy ...: no CUDA-capable device is detected'
$v = Get-Verdict -Findings $f -NvmlSys32Short '610.47' -DriverShort '610.47' -SmiNvmlError $true -NvcudaSys32Short '610.47' -KmodShort '610.47' -DriverServiceStopped $true
Assert-Equal 'verdict (service stopped, files match, NVML fails)' 'driver-service-stopped' $v

# Sub-case 9b: service stopped + a STALE DriverStore package coexists (Dmitri's
# nv_dispig.inf v560.94 alongside nv_dispi.inf v610.47). Still service-stopped
# (the stale-package note augments the FIX recipe, not the verdict label).
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA RTX 3080 ...'
Add-F $f 'Driver' 'WARN' 'NVIDIA driver SERVICE present but NOT running (State=Stopped, Started=False) ...'
Add-F $f 'NVML' 'OK' 'nvml.dll present in System32 ...'
Add-F $f 'NVML' 'WARN' 'STALE DRIVER PACKAGE: a DriverStore nvml.dll version differs from the active driver (v610.47): ...nv_dispig.inf... (v560.94) ...'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... Not Found'
Add-F $f 'cupy' 'FAIL' 'cupy ... no CUDA-capable device'
$v = Get-Verdict -Findings $f -NvmlSys32Short '610.47' -DriverShort '610.47' -SmiNvmlError $true -NvcudaSys32Short '610.47' -KmodShort '610.47' -DriverServiceStopped $true
Assert-Equal 'verdict (service stopped + stale package)' 'driver-service-stopped' $v

# Sub-case 9c: service stopped takes precedence over the generic matched-but-fails
# (no version diff, no shadow) but NOT over a real version mismatch (which is a
# concrete file defect). With a real nvcuda version diff present -> version-mismatch.
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'WARN' 'NVIDIA driver SERVICE present but NOT running (State=Stopped) ...'
Add-F $f 'NVML' 'OK' 'nvml.dll present ...'
Add-F $f 'nvcuda' 'FAIL' 'VERSION MISMATCH: System32 nvcuda.dll is v552.22 ... driver is v610.47 ...'
Add-F $f 'nvidia-smi' 'FAIL' 'nvidia-smi FAILED ... Not Found'
Add-F $f 'cupy' 'FAIL' 'cupy ... no CUDA-capable device'
$v = Get-Verdict -Findings $f -NvmlSys32Short '610.47' -DriverShort '610.47' -SmiNvmlError $true -NvcudaSys32Short '552.22' -DriverServiceStopped $true
Assert-Equal 'verdict (service stopped BUT real version diff -> version-mismatch wins)' 'driver-lib-version-mismatch' $v

# Sub-case 9d: HEALTHY box - service Running (DriverServiceStopped=false), NVML
# works -> must NOT show service-stopped or any driver-lib-problem.
$f = New-Findings
Add-F $f 'GPU' 'OK' 'Found: NVIDIA ...'
Add-F $f 'Driver' 'OK' 'nvlddmkm present and RUNNING (State=Running, Started=True) ...'
Add-F $f 'NVML' 'OK' 'nvml.dll present ...'
Add-F $f 'NVML' 'OK' 'Version match: ...'
Add-F $f 'nvcuda' 'OK' 'Version match: ...'
Add-F $f 'nvidia-smi' 'OK' 'nvidia-smi works ...'
Add-F $f 'cupy' 'OK' 'Device 0: NVIDIA ... | 128 SMs'
$v = Get-Verdict -Findings $f -NvmlSys32Short '560.94' -DriverShort '560.94' -SmiNvmlError $false -KmodShort '560.94' -NvcudaSys32Short '560.94' -DriverServiceStopped $false
Assert-Equal 'verdict (healthy, service running, no false service-stopped)' 'healthy' $v

# -------------------------------------------------------------------------
# Summary.
# -------------------------------------------------------------------------
Write-Host ''
if ($Failures.Count -eq 0) {
    Write-Host 'ALL TESTS PASSED'
    exit 0
} else {
    Write-Host ("FAILED: {0} assertion(s) -> {1}" -f $Failures.Count, ($Failures -join '; '))
    exit 1
}
