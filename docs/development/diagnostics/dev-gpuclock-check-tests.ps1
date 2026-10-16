<#
    dev-gpuclock: tests for the GPU clock-lock launcher gate (check-gpu-clock.ps1) and its shared
    helpers (tools/gpu_clock_state.ps1). Unelevated; never changes GPU clocks; never raises UAC.

    A mock nvidia-smi (.cmd) stands in for the driver via PIANOID_NVIDIA_SMI:
      MOCK_SMI_MODE=ok   -> answers queries from MOCK_LIVE / MOCK_CLOCKS
      MOCK_SMI_MODE=hang -> never answers (sleeps ~15 s)
      MOCK_SMI_MODE=fail -> exits 9
    The lock record is redirected to a temp file, so the real one is never touched.

    Run:  powershell -NoProfile -ExecutionPolicy Bypass -File docs\development\diagnostics\dev-gpuclock-check-tests.ps1
#>
$ErrorActionPreference = 'Stop'
$root  = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$tmp   = Join-Path ([IO.Path]::GetTempPath()) ("gpuclock-tests-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null

$mock = Join-Path $tmp 'nvidia-smi.cmd'
@'
@echo off
if "%MOCK_SMI_MODE%"=="hang" ( ping -n 15 127.0.0.1 >nul & exit /b 0 )
if "%MOCK_SMI_MODE%"=="fail" ( echo NVML error & exit /b 9 )
echo %* | findstr /c:"uuid" >nul && ( echo %MOCK_LIVE%& exit /b 0 )
echo %* | findstr /c:"pstate" >nul && ( echo %MOCK_CLOCKS%& exit /b 0 )
echo 3120
exit /b 0
'@ | Set-Content -Path $mock -Encoding ascii

$env:MOCK_LIVE   = 'GPU-test-uuid, 565.90, 2790, 3120, 0x0000000000000000'
$env:MOCK_CLOCKS = '2790, 3120, 10501, 10501, P0, 0, 80.00'

. (Join-Path $root 'tools\gpu_clock_state.ps1')
$GpuClockStateDir  = $tmp
$GpuLockRecordFile = Join-Path $tmp 'gpu_clock_lock.json'

$script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "PASS  $name" -ForegroundColor Green }
    else     { Write-Host "FAIL  $name  $detail" -ForegroundColor Red; $script:fail++ }
}
function Set-Record($boot, $uuid = 'GPU-test-uuid', $driver = '565.90') {
    [pscustomobject]@{ BootTime = $boot; GpuUuid = $uuid; Driver = $driver; SmTargetMhz = 3120; MemTargetMhz = 10501; AppliedAt = 'x' } |
        ConvertTo-Json | Set-Content -Path $GpuLockRecordFile -Encoding utf8
}
$boot = Get-BootTime

try {
    $env:MOCK_SMI_MODE = 'ok'

    # --- detection ---------------------------------------------------------------------------
    Remove-GpuLockRecord
    $r = Test-GpuClockLocked -Smi $mock
    Check 'no record -> NOT locked (even at 2790/3120)' ($r -and -not $r.Locked -and $r.Reason -match 'no clock lock') "$($r | Out-String)"

    Set-Record $boot
    $r = Test-GpuClockLocked -Smi $mock
    Check 'matching record + idle reason off -> LOCKED at sm=2790 of 3120 (89%)' ($r -and $r.Locked) "$($r | Out-String)"

    Set-Record '2026-01-01T00:00:00.0000000Z'
    $r = Test-GpuClockLocked -Smi $mock
    Check 'record from a previous boot -> NOT locked' ($r -and -not $r.Locked -and $r.Reason -match 'restarted') "$($r | Out-String)"

    Set-Record $boot 'GPU-other'
    $r = Test-GpuClockLocked -Smi $mock
    Check 'record for another GPU -> NOT locked' ($r -and -not $r.Locked -and $r.Reason -match 'different GPU')

    Set-Record $boot 'GPU-test-uuid' '560.00'
    $r = Test-GpuClockLocked -Smi $mock
    Check 'record from another driver version -> NOT locked' ($r -and -not $r.Locked -and $r.Reason -match 'driver has changed')

    Set-Record $boot
    $env:MOCK_LIVE = 'GPU-test-uuid, 565.90, 210, 3120, 0x0000000000000001'
    $r = Test-GpuClockLocked -Smi $mock
    Check 'valid record but gpu_idle reason active -> NOT locked' ($r -and -not $r.Locked -and $r.Reason -match 'idling')
    $env:MOCK_LIVE = 'GPU-test-uuid, 565.90, 2790, 3120, 0x0000000000000000'

    # --- writer round trip -----------------------------------------------------------------
    Remove-GpuLockRecord
    Write-GpuLockRecord -Live (Get-GpuLiveState -Smi $mock) -SmTargetMhz 3120 -MemTargetMhz 10501
    $r = Test-GpuClockLocked -Smi $mock
    Check 'Write-GpuLockRecord -> LOCKED' ($r -and $r.Locked)
    Remove-GpuLockRecord
    $r = Test-GpuClockLocked -Smi $mock
    Check 'Remove-GpuLockRecord -> NOT locked' ($r -and -not $r.Locked)

    # --- nvidia-smi failure modes are bounded and undecidable (-> caller launches) -----------
    $env:MOCK_SMI_MODE = 'fail'
    Check 'nvidia-smi error -> $null' ($null -eq (Test-GpuClockLocked -Smi $mock))

    $env:MOCK_SMI_MODE = 'hang'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Test-GpuClockLocked -Smi $mock -TimeoutMs 2000
    $sw.Stop()
    Check 'nvidia-smi hang -> $null within the timeout' ($null -eq $r -and $sw.Elapsed.TotalSeconds -lt 4) "elapsed=$($sw.Elapsed.TotalSeconds)"

    # --- launcher gate end-to-end (child process, as start-pianoid.bat runs it) --------------
    # Only paths that cannot reach the UAC prompt: missing / erroring / hung nvidia-smi.
    $check = Join-Path $root 'check-gpu-clock.ps1'
    function Run-Check {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $p = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$check`"", '-Auto')
        $done = $p.WaitForExit(30000)
        $sw.Stop()
        [pscustomobject]@{ Done = $done; Code = $(if ($done) { $p.ExitCode } else { $null }); Sec = $sw.Elapsed.TotalSeconds }
    }
    $env:PIANOID_NVIDIA_SMI = Join-Path $tmp 'does-not-exist.exe'
    $x = Run-Check
    Check 'launch gate: nvidia-smi missing -> exit 0, fast' ($x.Done -and $x.Code -eq 0 -and $x.Sec -lt 5) "$($x | Out-String)"

    $env:PIANOID_NVIDIA_SMI = $mock
    $env:MOCK_SMI_MODE = 'fail'
    $x = Run-Check
    Check 'launch gate: nvidia-smi error -> exit 0, fast' ($x.Done -and $x.Code -eq 0 -and $x.Sec -lt 5) "$($x | Out-String)"

    $env:MOCK_SMI_MODE = 'hang'
    $x = Run-Check
    Check 'launch gate: nvidia-smi hung -> exit 0 within ~5 s bound' ($x.Done -and $x.Code -eq 0 -and $x.Sec -lt 9) "$($x | Out-String)"

    # --- the bounded wait the gate uses on the elevated worker (same API, unelevated) --------
    $p = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 10')
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $exited = $p.WaitForExit(1500)
    $sw.Stop()
    Check 'Process.WaitForExit(ms) returns false on a hung worker, on time' (-not $exited -and $sw.Elapsed.TotalSeconds -lt 3)
    try { $p.Kill() } catch { }

    # --- worker -Status under the mock (unelevated, read-only) ------------------------------
    $env:MOCK_SMI_MODE = 'ok'
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\gpu_rt_config.ps1') -Status 2>&1 | Out-String
    Check 'worker -Status runs under the mock and reports via the record test' ($LASTEXITCODE -eq 0 -and $out -match 'Clocks are (LOCKED|NOT locked)') $out

    # --- real driver, read-only -------------------------------------------------------------
    Remove-Item Env:\PIANOID_NVIDIA_SMI
    $real = Get-NvidiaSmi
    if ($real) {
        $live = Get-GpuLiveState -Smi $real
        Check 'real nvidia-smi: live query parses (uuid, driver, clocks, idle bit)' ($live -and $live.Uuid -match '^GPU-' -and $live.SmMaxMhz -gt 0) "$($live | Out-String)"
        Write-Host ("      real: {0} driver {1} sm={2}/{3} gpu_idle={4}" -f $live.Uuid, $live.Driver, $live.SmMhz, $live.SmMaxMhz, $live.IdleActive)
    } else {
        Write-Host 'SKIP  real nvidia-smi not present'
    }
} finally {
    Remove-Item Env:\PIANOID_NVIDIA_SMI, Env:\MOCK_SMI_MODE, Env:\MOCK_LIVE, Env:\MOCK_CLOCKS -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($script:fail) { Write-Host "$script:fail FAILED" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASSED' -ForegroundColor Green
exit 0
