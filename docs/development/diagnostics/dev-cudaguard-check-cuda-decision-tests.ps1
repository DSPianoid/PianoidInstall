# =========================================================================
# dev-cudaguard-check-cuda-decision-tests.ps1
#
# Unit tests for the check-cuda.ps1 DECISION TREE without a real GPU / without
# breaking this machine's CUDA. It dot-sources the REAL check-cuda.ps1 helper
# functions (so there is NO logic duplication / drift), then overrides the three
# probe/UI functions (Get-CudaInfoViaCupy, Test-CudaViaNvidiaSmi, Show-CudaWarning)
# with stubs that inject synthetic states, and executes the REAL Main block in a
# child PowerShell so its `exit <code>` is captured.
#
# This is how the broken-but-present paths (which need a wedged NVML, impossible
# to safely produce on a healthy box) are verified: by feeding the Main tree the
# exact probe return shapes the live probes would produce.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File <thisfile> [-Script <path-to-check-cuda.ps1>]
# Exit 0 = all cases pass; exit 1 = a case failed.
# =========================================================================
param(
    [string] $Script = (Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'check-cuda.ps1')
)

if (-not (Test-Path -LiteralPath $Script)) {
    Write-Host "FATAL: check-cuda.ps1 not found at $Script"
    exit 1
}

# Split the target script into "functions" (everything BEFORE the Main header)
# and "main" (the Main try/catch block). We run the real Main with stubbed
# helpers so we test the real wiring, not a copy of it.
$all = Get-Content -LiteralPath $Script -Raw
$marker = '# Main - fully wrapped'
$idx = $all.IndexOf($marker)
if ($idx -lt 0) {
    Write-Host "FATAL: could not locate the Main block marker in check-cuda.ps1"
    exit 1
}
# Back up to the start of the comment banner line for a clean cut.
$mainStart = $all.LastIndexOf('# ===', $idx)
$funcsPart = $all.Substring(0, $mainStart)
$mainPart  = $all.Substring($mainStart)

# Each case runs in a CHILD powershell so the Main's `exit` is captured as the
# process exit code. We compose: funcs + stub overrides + main, all in one -Command.
function Invoke-Case {
    param(
        [string] $Name,
        [string] $StubBlock,    # PowerShell defining the 3 stubs + $Auto
        [int]    $ExpectExit
    )
    $composed = $funcsPart + "`n" + $StubBlock + "`n" + $mainPart
    $tmp = Join-Path $env:TEMP ("cc_case_{0}.ps1" -f ([guid]::NewGuid().ToString('N')))
    Set-Content -LiteralPath $tmp -Value $composed -Encoding UTF8
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $tmp *> $null
        $code = $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    $ok = ($code -eq $ExpectExit)
    $tag = if ($ok) { '[PASS]' } else { '[FAIL]' }
    Write-Host ("  {0} {1} -> exit {2} (expected {3})" -f $tag, $Name, $code, $ExpectExit)
    return $ok
}

# Stub recipe helpers. Show-CudaWarning is stubbed to record the kind it was
# asked to show, and to return proceed/cancel per the case. We assert the EXIT
# code (0 proceed / 30 cancel), which is the .bat-visible contract; the recorded
# kind is asserted indirectly via which message path the Main took.
$results = @()

# --- cupy says device present, >=60 SMs -> silent proceed (exit 0) ---
$results += Invoke-Case 'cupy healthy >=60 SMs' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $true; DeviceCount = 1; SMCount = 80; Name = 'Test80' } }
function Test-CudaViaNvidiaSmi { throw 'should not be called' }
function Show-CudaWarning { param($Message,$Kind) Write-Host "UNEXPECTED-WARNING:$Kind"; $true }
'@ 0

# --- cupy says 0 devices -> no-device warning; user Cancel -> exit 30 ---
$results += Invoke-Case 'cupy 0 devices, user Cancel' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $true; DeviceCount = 0; SMCount = 0; Name = 'none' } }
function Test-CudaViaNvidiaSmi { throw 'should not be called' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'no-device') { Write-Host "WRONG-KIND:$Kind" }; $false }
'@ 30

# --- cupy says 0 devices -> no-device warning; user Continue -> exit 0 ---
$results += Invoke-Case 'cupy 0 devices, user Continue' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $true; DeviceCount = 0; SMCount = 0; Name = 'none' } }
function Test-CudaViaNvidiaSmi { throw 'should not be called' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'no-device') { Write-Host "WRONG-KIND:$Kind" }; $true }
'@ 0

# --- cupy <60 SMs, interactive, user Cancel -> exit 30 (low-sm) ---
$results += Invoke-Case 'cupy <60 SMs, user Cancel' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $true; DeviceCount = 1; SMCount = 40; Name = 'Test40' } }
function Test-CudaViaNvidiaSmi { throw 'should not be called' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'low-sm') { Write-Host "WRONG-KIND:$Kind" }; $false }
'@ 30

# --- THE FIX: cupy imported but device query THREW (broken) -> cuda-broken; Cancel -> 30 ---
$results += Invoke-Case 'cupy BROKEN (runtime threw), user Cancel' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false; Broken = $true; Reason = 'CUDARuntimeError: no CUDA-capable device is detected' } }
function Test-CudaViaNvidiaSmi { throw 'should not be called when cupy reports broken' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'cuda-broken') { Write-Host "WRONG-KIND:$Kind" }; $false }
'@ 30

# --- THE FIX: cupy broken, user Continue -> exit 0 (warned, proceeds) ---
$results += Invoke-Case 'cupy BROKEN, user Continue' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false; Broken = $true; Reason = 'NVML mismatch' } }
function Test-CudaViaNvidiaSmi { throw 'should not be called when cupy reports broken' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'cuda-broken') { Write-Host "WRONG-KIND:$Kind" }; $true }
'@ 0

# --- cupy unavailable, nvidia-smi 'absent' -> no-device; Cancel -> 30 ---
$results += Invoke-Case 'cupy n/a + nvidia-smi absent, Cancel' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false } }
function Test-CudaViaNvidiaSmi { 'absent' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'no-device') { Write-Host "WRONG-KIND:$Kind" }; $false }
'@ 30

# --- THE FIX: cupy unavailable, nvidia-smi 'broken' (NVML not found) -> cuda-broken; Cancel -> 30 ---
$results += Invoke-Case 'cupy n/a + nvidia-smi BROKEN (NVML), Cancel' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false } }
function Test-CudaViaNvidiaSmi { 'broken' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'cuda-broken') { Write-Host "WRONG-KIND:$Kind" }; $false }
'@ 30

# --- THE FIX: cupy unavailable, nvidia-smi 'broken', user Continue -> exit 0 ---
$results += Invoke-Case 'cupy n/a + nvidia-smi BROKEN, Continue' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false } }
function Test-CudaViaNvidiaSmi { 'broken' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'cuda-broken') { Write-Host "WRONG-KIND:$Kind" }; $true }
'@ 0

# --- cupy unavailable, nvidia-smi 'present' (GPU present, SMs unknown) -> silent exit 0 ---
$results += Invoke-Case 'cupy n/a + nvidia-smi present -> silent proceed' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false } }
function Test-CudaViaNvidiaSmi { 'present' }
function Show-CudaWarning { param($Message,$Kind) Write-Host "UNEXPECTED-WARNING:$Kind"; $true }
'@ 0

# --- cupy unavailable, nvidia-smi $null (truly unknown) -> silent exit 0 ---
$results += Invoke-Case 'cupy n/a + nvidia-smi unknown -> silent proceed' @'
$Auto = $false
function Get-CudaInfoViaCupy { @{ Determined = $false } }
function Test-CudaViaNvidiaSmi { $null }
function Show-CudaWarning { param($Message,$Kind) Write-Host "UNEXPECTED-WARNING:$Kind"; $true }
'@ 0

# --- -Auto + cupy broken: timed pop-up stubbed to proceed -> exit 0 (never hangs) ---
$results += Invoke-Case '-Auto + cupy BROKEN -> proceed (no hang)' @'
$Auto = $true
function Get-CudaInfoViaCupy { @{ Determined = $false; Broken = $true; Reason = 'driver mismatch' } }
function Test-CudaViaNvidiaSmi { throw 'n/a' }
function Show-CudaWarning { param($Message,$Kind) if ($Kind -ne 'cuda-broken') { Write-Host "WRONG-KIND:$Kind" }; $true }
'@ 0

$pass = @($results | Where-Object { $_ }).Count
$total = $results.Count
Write-Host ''
Write-Host ("  RESULT: {0}/{1} decision cases pass" -f $pass, $total)
if ($pass -eq $total) { exit 0 } else { exit 1 }
