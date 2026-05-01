@echo off
REM ============================================================================
REM  unlock_gpu_clock.bat — Reset NVIDIA GPU clocks to default (dynamic boost).
REM
REM  REQUIREMENTS:
REM    * Must be run as Administrator (right-click -> "Run as administrator").
REM      The script does NOT auto-elevate by design.
REM    * NVIDIA GPU + recent driver with nvidia-smi on PATH.
REM
REM  USAGE:
REM    Open an Administrator cmd.exe and run:
REM        tools\unlock_gpu_clock.bat
REM
REM  See tools\lock_gpu_clock.bat for the companion lock script and rationale.
REM ============================================================================

setlocal EnableDelayedExpansion

REM --- 1. Detect nvidia-smi -----------------------------------------------------
where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [ERROR] nvidia-smi not found on PATH.
    echo         Install the NVIDIA driver or add nvidia-smi to PATH.
    exit /b 1
)

REM --- 2. Print BEFORE state ----------------------------------------------------
echo === BEFORE (current clocks) ===
nvidia-smi --query-gpu=clocks.gr,clocks.mem --format=csv,noheader
echo.

REM --- 3. Reset graphics clock --------------------------------------------------
echo === Resetting graphics clock to default ===
nvidia-smi -rgc
if errorlevel 1 (
    echo [ERROR] Failed to reset graphics clock. You probably need to run this
    echo         script as Administrator.
    exit /b 1
)
echo.

REM --- 4. Reset memory clock (graceful fail if unsupported) ---------------------
echo === Resetting memory clock to default ===
nvidia-smi -rmc
if errorlevel 1 (
    echo [WARN]  Memory clock reset not supported on this GPU/driver combo.
    echo         Graphics clock IS reset — continuing.
    echo.
) else (
    echo.
)

REM --- 5. Print AFTER state -----------------------------------------------------
echo === AFTER (current clocks) ===
nvidia-smi --query-gpu=clocks.gr,clocks.mem --format=csv,noheader
echo.
echo GPU clocks restored to default dynamic-boost behaviour.

endlocal
exit /b 0
