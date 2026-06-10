@echo off
echo === NVIDIA DISPLAY-DRIVER (re)install ===
echo.
echo Reinstalls the NVIDIA DISPLAY DRIVER (NOT the CUDA toolkit). Fixes
echo "NVML not found" / "driver/library version mismatch" that a setup-packages
echo (CUDA toolkit) reinstall cannot fix. Downloads + installs automatically.
echo A reboot is required afterwards. Run this elevated (Administrator).
echo.
echo Options:
echo   1. Reinstall latest driver
echo   2. Clean reinstall (wipes driver settings/profiles - recommended if broken)
echo   3. Reinstall but do NOT reboot automatically
echo   4. Dry run (resolve the latest driver only - no download, no install)
echo.
set /p choice="Choose option (1-4): "

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if "%choice%"=="1" (
    echo Reinstalling latest driver...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nvidia-driver.ps1"
) else if "%choice%"=="2" (
    echo Clean reinstall...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nvidia-driver.ps1" -Clean
) else if "%choice%"=="3" (
    echo Reinstalling without reboot...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nvidia-driver.ps1" -NoReboot
) else if "%choice%"=="4" (
    echo Dry run...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nvidia-driver.ps1" -DryRun
) else (
    echo Invalid choice. Reinstalling latest driver...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-nvidia-driver.ps1"
)

echo.
pause