@echo off
echo === NVIDIA Driver Installer ===
echo.
echo Options:
echo   1. Standard installation
echo   2. Clean installation (recommended)
echo   3. Install without reboot
echo.
set /p choice="Choose option (1-3): "

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if "%choice%"=="1" (
    echo Standard installation...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0install-nvidia-driver.ps1'"
) else if "%choice%"=="2" (
    echo Clean installation...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0install-nvidia-driver.ps1' -CleanInstall"
) else if "%choice%"=="3" (
    echo Installing without reboot...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0install-nvidia-driver.ps1' -NoReboot"
) else (
    echo Invalid choice. Using standard installation...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0install-nvidia-driver.ps1'"
)

echo.
pause