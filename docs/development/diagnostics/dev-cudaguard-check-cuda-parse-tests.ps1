# =========================================================================
# dev-cudaguard-check-cuda-parse-tests.ps1
#
# Tests the two NOVEL parsing helpers in check-cuda.ps1 against synthetic probe
# output, WITHOUT a GPU:
#   * Get-CudaInfoViaCupy - by pointing $VenvPython at a tiny fake "python" .cmd
#     that echoes a chosen line (device line / RUNTIME_ERR / IMPORT_ERR / 0|0|none
#     / noise), so the parse-loop classification is exercised end to end.
#   * Test-CudaViaNvidiaSmi - logic is exercised by the decision-test harness
#     (it stubs the function). Here we add a direct string-classification check
#     of the NVML/exit-code mapping rules by re-evaluating the same predicates.
#
# Dot-sources the real helper functions from check-cuda.ps1 (no duplication) by
# cutting the file before the Main block (Main would call exit on load).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <thisfile> [-Script <path>]
# Exit 0 = all pass; 1 = a failure.
# =========================================================================
param(
    [string] $Script = (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'check-cuda.ps1')
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Script)) { Write-Host "FATAL: $Script not found"; exit 1 }

# Load only the functions (cut before the Main banner).
$all = Get-Content -LiteralPath $Script -Raw
$idx = $all.IndexOf('# Main - fully wrapped')
$mainStart = $all.LastIndexOf('# ===', $idx)
$funcsPart = $all.Substring(0, $mainStart)
$fnTmp = Join-Path $env:TEMP ("cc_funcs_{0}.ps1" -f ([guid]::NewGuid().ToString('N')))
Set-Content -LiteralPath $fnTmp -Value $funcsPart -Encoding UTF8
. $fnTmp   # dot-source the real Get-CudaInfoViaCupy / Test-CudaViaNvidiaSmi / etc.
Remove-Item -LiteralPath $fnTmp -Force -ErrorAction SilentlyContinue

$fails = 0
function Check {
    param([string] $Name, [bool] $Cond)
    $tag = if ($Cond) { '[PASS]' } else { '[FAIL]'; $script:fails++ }
    Write-Host ("  {0} {1}" -f $tag, $Name)
}

# A fake "python" that prints the content of the file named in %FAKE_PY_FILE%.
# We use `type` (not `echo`) so the '|' pipe characters in the synthetic probe
# lines are emitted VERBATIM - `echo %VAR%` would let cmd interpret the '|' as a
# pipe operator and mangle the line.
$fakePy = Join-Path $env:TEMP ("fake_python_{0}.cmd" -f ([guid]::NewGuid().ToString('N')))
Set-Content -LiteralPath $fakePy -Value "@echo off`r`ntype `"%FAKE_PY_FILE%`"" -Encoding ASCII
$lineFile = Join-Path $env:TEMP ("fake_python_line_{0}.txt" -f ([guid]::NewGuid().ToString('N')))

function Probe-With {
    param([string] $Line)
    # Write the synthetic line to a file the fake interpreter `type`s back.
    Set-Content -LiteralPath $lineFile -Value $Line -Encoding ASCII
    $env:FAKE_PY_FILE = $lineFile
    # Override $VenvPython (script-scope var the function reads) to our fake.
    Set-Variable -Name VenvPython -Value $fakePy -Scope Script
    return (Get-CudaInfoViaCupy)
}

try {
    # 1. Device line -> Determined, count/sm/name parsed.
    $r = Probe-With '1|56|NVIDIA GeForce RTX 4070 SUPER'
    Check 'device line -> Determined true' ($r.Determined -eq $true)
    Check 'device line -> DeviceCount 1'   ($r.DeviceCount -eq 1)
    Check 'device line -> SMCount 56'      ($r.SMCount -eq 56)
    Check 'device line -> Name parsed'     ($r.Name -eq 'NVIDIA GeForce RTX 4070 SUPER')

    # 2. Zero devices.
    $r = Probe-With '0|0|none'
    Check '0|0|none -> Determined true'    ($r.Determined -eq $true)
    Check '0|0|none -> DeviceCount 0'      ($r.DeviceCount -eq 0)

    # 3. RUNTIME_ERR -> Broken with reason (THE FIX: thrown device query).
    $r = Probe-With 'RUNTIME_ERR|CUDARuntimeError|no CUDA-capable device is detected'
    Check 'RUNTIME_ERR -> Determined false' ($r.Determined -eq $false)
    Check 'RUNTIME_ERR -> Broken true'      ($r.Broken -eq $true)
    Check 'RUNTIME_ERR -> Reason has type'  ($r.Reason -match 'CUDARuntimeError')
    Check 'RUNTIME_ERR -> Reason has msg'   ($r.Reason -match 'no CUDA-capable device')

    # 4. IMPORT_ERR -> NOT broken (cupy missing = no probe, fall to nvidia-smi).
    $r = Probe-With 'IMPORT_ERR|No module named cupy'
    Check 'IMPORT_ERR -> Determined false'  ($r.Determined -eq $false)
    Check 'IMPORT_ERR -> NOT Broken'        (-not $r.Broken)

    # 5. Noise / unparseable -> Determined false, not broken.
    $r = Probe-With 'some unrelated banner text'
    Check 'noise -> Determined false'       ($r.Determined -eq $false)
    Check 'noise -> NOT Broken'             (-not $r.Broken)
}
finally {
    Remove-Item -LiteralPath $fakePy -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $lineFile -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\FAKE_PY_FILE -ErrorAction SilentlyContinue
}

# 6. nvidia-smi string-classification rules (mirror the predicates in
#    Test-CudaViaNvidiaSmi: NVML/'Failed to initialize' OR non-zero -> broken).
function Classify-Smi { param([string]$combined, [int]$code)
    if ($combined -match 'NVML' -or $combined -match 'Failed to initialize') { return 'broken' }
    if ($code -ne 0) { return 'broken' }
    if ([string]::IsNullOrWhiteSpace($combined)) { return 'absent' }
    return 'present'
}
Check 'smi: NVML error text -> broken'      ((Classify-Smi 'NVML library not found' 0) -eq 'broken')
Check 'smi: Failed to init -> broken'       ((Classify-Smi 'Failed to initialize NVML: Driver/library version mismatch' 9) -eq 'broken')
Check 'smi: non-zero exit -> broken'        ((Classify-Smi '' 255) -eq 'broken')
Check 'smi: clean empty -> absent'          ((Classify-Smi '   ' 0) -eq 'absent')
Check 'smi: name + exit0 -> present'        ((Classify-Smi 'NVIDIA GeForce RTX 4070 SUPER' 0) -eq 'present')

Write-Host ''
if ($fails -eq 0) { Write-Host '  RESULT: all parse cases pass'; exit 0 }
else { Write-Host ("  RESULT: {0} parse case(s) FAILED" -f $fails); exit 1 }
