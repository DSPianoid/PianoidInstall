# =========================================================================
# dev-drvinstall-driver-health-tests.ps1
#
# Unit tests for the LOGIC in check-driver-health.ps1 (the NVIDIA display-driver
# health gate behind "setup-packages should reinstall the driver if needed").
#
# WHY a logic mirror, not an end-to-end run: check-driver-health.ps1 inspects the
# LIVE machine (WMI / System32 / nvidia-smi) and exits with a verdict code. We
# cannot break the real driver to test the FAIL branches, so we test the two
# decision pieces in isolation against synthetic inputs:
#   1. Get-NvDriverShort  - the version normaliser (dot-sourced from the REAL
#      script via a temp extraction, so we test the actual code, not a copy).
#   2. Resolve-DriverVerdict - the verdict decision (GPU-present + problem-list
#      -> token/exit-code). Mirrored here EXACTLY from the script's main block
#      (the script's main `try` cannot be unit-isolated because it reads WMI and
#      calls `exit`). Kept byte-faithful to the script's rule:
#        no NVIDIA GPU                       -> no-gpu / 20
#        >=1 problem (missing/mismatch/NVML) -> driver-needs-attention / 10
#        else                                -> healthy / 0
#
# A live smoke run of the REAL script (it returns VERDICT=healthy / exit 0 on a
# healthy box) is the end-to-end check and is recorded in the session log; this
# harness covers the branches a healthy box can't reach.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File `
#        docs\development\diagnostics\dev-drvinstall-driver-health-tests.ps1
# Exit 0 = all pass; 1 = a failure (count printed).
# =========================================================================

$ErrorActionPreference = 'Stop'

$script:Pass = 0
$script:Fail = 0

function Assert-Equal {
    param([string] $Name, $Expected, $Actual)
    if ($Expected -eq $Actual) {
        $script:Pass++
        Write-Host ("  [PASS] {0}" -f $Name)
    } else {
        $script:Fail++
        Write-Host ("  [FAIL] {0} : expected '{1}', got '{2}'" -f $Name, $Expected, $Actual)
    }
}

# -------------------------------------------------------------------------
# Load the REAL Get-NvDriverShort from check-driver-health.ps1 so we test the
# shipped function (not a copy that could silently drift).
# -------------------------------------------------------------------------
$scriptPath = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'check-driver-health.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    # Fallback: the script lives at the repo root; PSScriptRoot is .../docs/development/diagnostics
    $scriptPath = Join-Path $PSScriptRoot '..\..\..\check-driver-health.ps1'
}
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Host "FATAL: cannot locate check-driver-health.ps1 (looked at $scriptPath)"
    exit 1
}

# Extract just the Get-NvDriverShort function body via the AST and dot-source it,
# so we exercise the real shipped implementation.
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$null)
$fnAst = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-NvDriverShort' }, $true) | Select-Object -First 1
if (-not $fnAst) {
    Write-Host "FATAL: Get-NvDriverShort not found in check-driver-health.ps1"
    exit 1
}
Invoke-Expression $fnAst.Extent.Text   # defines Get-NvDriverShort in this scope

# -------------------------------------------------------------------------
# Resolve-DriverVerdict - MIRRORS the script's main-block decision exactly.
# (The script computes this inline after reading WMI; here it is a pure fn so
# the branches are testable. Keep in sync with check-driver-health.ps1.)
# -------------------------------------------------------------------------
function Resolve-DriverVerdict {
    param(
        [bool] $GpuPresent,
        [int]  $ProblemCount
    )
    if (-not $GpuPresent) { return @{ Token = 'no-gpu'; Code = 20 } }
    if ($ProblemCount -gt 0) { return @{ Token = 'driver-needs-attention'; Code = 10 } }
    return @{ Token = 'healthy'; Code = 0 }
}

Write-Host ''
Write-Host '=== check-driver-health.ps1 logic tests ==='
Write-Host ''
Write-Host '-- Get-NvDriverShort (real shipped function) --'

# WMI 4-part form (last 5 digits 15.6094 -> 560.94).
Assert-Equal 'WMI 32.0.15.6094 -> 560.94'        '560.94' (Get-NvDriverShort '32.0.15.6094')
# nvml.dll FileVersion form (8.17.15.6094 -> same driver).
Assert-Equal 'nvml 8.17.15.6094 -> 560.94'       '560.94' (Get-NvDriverShort '8.17.15.6094')
# Already-short driver string round-trips (56094 -> 560.94).
Assert-Equal 'short 560.94 -> 560.94'            '560.94' (Get-NvDriverShort '560.94')
# A different driver (537.58: ...53758 -> 537.58).
Assert-Equal 'WMI 31.0.15.3758 -> 537.58'        '537.58' (Get-NvDriverShort '31.0.15.3758')
# Non-NVIDIA / unparseable -> $null (so no bogus comparison is ever made).
Assert-Equal 'empty -> null'                     $null    (Get-NvDriverShort '')
Assert-Equal 'whitespace -> null'                $null    (Get-NvDriverShort '   ')
Assert-Equal 'too-few-digits 1.2 -> null'        $null    (Get-NvDriverShort '1.2')
Assert-Equal 'no-digits abc -> null'             $null    (Get-NvDriverShort 'abc.def')

Write-Host ''
Write-Host '-- Resolve-DriverVerdict (decision mirror) --'

# No GPU at all -> no-gpu / 20 (regardless of problem count).
$v = Resolve-DriverVerdict -GpuPresent $false -ProblemCount 0
Assert-Equal 'no GPU -> token'                   'no-gpu' $v.Token
Assert-Equal 'no GPU -> code'                     20      $v.Code

# GPU present, zero problems -> healthy / 0 (this is the live-box result).
$v = Resolve-DriverVerdict -GpuPresent $true -ProblemCount 0
Assert-Equal 'GPU+0problems -> token'            'healthy' $v.Token
Assert-Equal 'GPU+0problems -> code'              0        $v.Code

# GPU present, one problem (e.g. nvml mismatch) -> needs-attention / 10.
$v = Resolve-DriverVerdict -GpuPresent $true -ProblemCount 1
Assert-Equal 'GPU+1problem -> token'             'driver-needs-attention' $v.Token
Assert-Equal 'GPU+1problem -> code'              10       $v.Code

# GPU present, several problems (missing nvml + missing nvcuda + nvidia-smi NVML
# error) -> still needs-attention / 10 (any problem trips the gate).
$v = Resolve-DriverVerdict -GpuPresent $true -ProblemCount 3
Assert-Equal 'GPU+3problems -> token'            'driver-needs-attention' $v.Token
Assert-Equal 'GPU+3problems -> code'             10       $v.Code

# -------------------------------------------------------------------------
# Cross-check: the MISMATCH condition the script uses to ADD a problem -
# nvml short != driver short, both non-null. Asserts the exact rule that
# turns a present-but-wrong-version nvml.dll into a problem.
# -------------------------------------------------------------------------
Write-Host ''
Write-Host '-- mismatch rule (drives the problem list) --'
function Test-Mismatch {
    param([string] $LibRaw, [string] $DrvRaw)
    $libShort = Get-NvDriverShort $LibRaw
    $drvShort = Get-NvDriverShort $DrvRaw
    # The script's exact predicate: both parse AND differ -> mismatch (a problem).
    return ($libShort -and $drvShort -and ($libShort -ne $drvShort))
}
# Same version -> NOT a mismatch (no problem).
Assert-Equal 'nvml==driver (both 560.94) -> no mismatch' $false (Test-Mismatch '8.17.15.6094' '32.0.15.6094')
# Different version -> mismatch (problem).
Assert-Equal 'nvml 537.58 vs driver 560.94 -> mismatch'  $true  (Test-Mismatch '8.17.15.3758' '32.0.15.6094')
# Unreadable lib version -> NOT flagged a mismatch (avoid false positive; the
# "missing" branch handles a truly absent file).
Assert-Equal 'nvml unreadable vs driver -> no mismatch'  $false (Test-Mismatch '' '32.0.15.6094')

Write-Host ''
Write-Host ('=== RESULT: {0} passed, {1} failed ===' -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
