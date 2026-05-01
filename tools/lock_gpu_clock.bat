@echo off
REM ============================================================================
REM  lock_gpu_clock.bat — Lock NVIDIA GPU clocks at MAX for deterministic
REM                       performance benchmarks.
REM
REM  REQUIREMENTS:
REM    * Must be run as Administrator (right-click -> "Run as administrator").
REM      The script does NOT auto-elevate by design.
REM    * NVIDIA GPU + recent driver with nvidia-smi on PATH.
REM
REM  USAGE:
REM    Open an Administrator cmd.exe and run:
REM        tools\lock_gpu_clock.bat
REM
REM    To restore default clock behaviour, run the companion script:
REM        tools\unlock_gpu_clock.bat
REM
REM  BENCHMARK PREP:
REM    Pianoid performance tests (PianoidCore/tests/system/test_performance.py)
REM    can show 5-15%% run-to-run variance when the GPU's dynamic boost adjusts
REM    the core clock between runs. Locking gr/mem clocks to their max removes
REM    that source of jitter so before/after comparisons are meaningful.
REM ============================================================================

setlocal EnableDelayedExpansion

REM --- 1. Detect nvidia-smi -----------------------------------------------------
where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [ERROR] nvidia-smi not found on PATH.
    echo         Install the NVIDIA driver or add nvidia-smi to PATH.
    exit /b 1
)

REM --- 2. Query MAX clocks ------------------------------------------------------
for /f "tokens=1,2 delims=," %%a in ('nvidia-smi --query-gpu^=clocks.max.gr^,clocks.max.mem --format^=csv^,noheader^,nounits') do (
    set "MAX_GR=%%a"
    set "MAX_MEM=%%b"
)
REM Strip leading spaces left by the CSV split
set "MAX_GR=!MAX_GR: =!"
set "MAX_MEM=!MAX_MEM: =!"

if "!MAX_GR!"=="" (
    echo [ERROR] Failed to read MAX clocks from nvidia-smi.
    exit /b 1
)

echo === MAX clocks ===
echo   Graphics: !MAX_GR! MHz
echo   Memory  : !MAX_MEM! MHz
echo.

REM --- 3. Print BEFORE state ----------------------------------------------------
echo === BEFORE (current clocks) ===
nvidia-smi --query-gpu=clocks.gr,clocks.mem --format=csv,noheader
echo.

REM --- 4. Lock graphics clock ---------------------------------------------------
echo === Locking graphics clock to !MAX_GR! MHz ===
nvidia-smi -lgc !MAX_GR!,!MAX_GR!
if errorlevel 1 (
    echo [ERROR] Failed to lock graphics clock. You probably need to run this
    echo         script as Administrator.
    exit /b 1
)
echo.

REM --- 5. Lock memory clock (graceful fail if unsupported) ----------------------
echo === Locking memory clock to !MAX_MEM! MHz ===
set "MEM_LOCKED=1"
nvidia-smi -lmc !MAX_MEM!,!MAX_MEM!
if errorlevel 1 (
    set "MEM_LOCKED=0"
    echo [WARN]  Memory clock lock not supported on this GPU/driver combo.
    echo         Graphics clock IS locked — continuing.
    echo.
) else (
    echo.
)

REM --- 6. Print AFTER state -----------------------------------------------------
echo === AFTER (current clocks) ===
nvidia-smi --query-gpu=clocks.gr,clocks.mem --format=csv,noheader
echo.
echo === Lock status ===
echo   Graphics clock: LOCKED at !MAX_GR! MHz
if "!MEM_LOCKED!"=="1" (
    echo   Memory clock  : LOCKED at !MAX_MEM! MHz
) else (
    echo   Memory clock  : NOT LOCKED ^(unsupported on this device^)
)
echo.
echo Run tools\unlock_gpu_clock.bat to restore default clock behaviour.

endlocal
exit /b 0
