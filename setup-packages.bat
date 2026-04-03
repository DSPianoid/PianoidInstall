@echo off
echo === PianoidCore Development Environment Setup ===
echo.
if exist "setup-config.json" (
    echo Configuration file found: setup-config.json
    echo Versions will be loaded from config file.
) else (
    echo No config file found. Using default versions from setup-dev.ps1.
    echo   Run option 6 to create a sample config file.
)
echo.
echo This script will install/update:
echo   - Python (with pip)
echo   - Visual Studio 2022 Build Tools (C++)
echo   - CUDA Toolkit
echo   - SDL2 and SDL3 (audio libraries)
echo   - Node.js LTS
echo.
echo Available options:
echo   1. Normal install (uses config file if present)
echo   2. Force reinstall Python only
echo   3. Force reinstall CUDA only
echo   4. Force reinstall Node.js only
echo   5. Force reinstall all components
echo   6. Create sample config file
echo.
set /p choice="Choose option (1-6): "

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if "%choice%"=="1" (
    echo Running normal install...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0setup-dev.ps1'"
) else if "%choice%"=="2" (
    echo Force reinstalling Python only...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0setup-dev.ps1' -ForcePython"
) else if "%choice%"=="3" (
    echo Force reinstalling CUDA only...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0setup-dev.ps1' -ForceCUDA"
) else if "%choice%"=="4" (
    echo Force reinstalling Node.js only...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0setup-dev.ps1' -ForceNode"
) else if "%choice%"=="5" (
    echo Force reinstalling all components...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0setup-dev.ps1' -ForceReinstall"
) else if "%choice%"=="6" (
    echo Creating sample config file...
    if exist "setup-config.json" (
        echo setup-config.json already exists. Rename it first to create a new sample.
    ) else (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-sample-config.ps1"
        echo.
        echo Sample configuration file created successfully!
        echo Edit setup-config.json to customize versions and options.
    )
) else (
    echo Invalid choice. Running normal install...
    "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0setup-dev.ps1'"
)

echo.
echo Setup completed. Press any key to exit.
pause >nul