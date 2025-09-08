@echo off
REM Batch script to download and install Python from python.org
REM Run as Administrator for best results

setlocal EnableDelayedExpansion

REM Configuration - Edit these variables as needed
set PYTHON_VERSION=3.12.0
set ADD_TO_PATH=1
set INSTALL_ALL_USERS=0

echo ==========================================
echo Python Auto-Installer from python.org
echo ==========================================
echo Python Version: %PYTHON_VERSION%
echo.

REM Check if running as administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Not running as Administrator. For best results, run as Admin.
    echo.
)

REM Create temp directory
set TEMP_DIR=%TEMP%\PythonInstaller
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

REM Determine architecture
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
    set ARCH=amd64
) else if "%PROCESSOR_ARCHITEW6432%"=="AMD64" (
    set ARCH=amd64
) else (
    set ARCH=win32
)

echo Detected architecture: %ARCH%

REM Construct download URL and file path
set DOWNLOAD_URL=https://www.python.org/ftp/python/%PYTHON_VERSION%/python-%PYTHON_VERSION%-%ARCH%.exe
set INSTALLER_PATH=%TEMP_DIR%\python-%PYTHON_VERSION%-installer.exe

echo.
echo Downloading Python %PYTHON_VERSION% for %ARCH%...
echo URL: %DOWNLOAD_URL%
echo Output: %INSTALLER_PATH%
echo.

REM Download Python installer - try curl first, then bitsadmin
curl --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Using curl to download...
    curl -L -o "%INSTALLER_PATH%" "%DOWNLOAD_URL%"
    set DOWNLOAD_RESULT=%errorlevel%
) else (
    echo Using bitsadmin to download...
    bitsadmin /transfer "PythonDownload" "%DOWNLOAD_URL%" "%INSTALLER_PATH%"
    set DOWNLOAD_RESULT=%errorlevel%
)

if !DOWNLOAD_RESULT! neq 0 (
    echo ERROR: Download failed.
    echo Please check if version %PYTHON_VERSION% exists at python.org
    echo URL: %DOWNLOAD_URL%
    pause
    exit /b 1
)

REM Verify file was downloaded
if not exist "%INSTALLER_PATH%" (
    echo ERROR: Installer file not found after download.
    pause
    exit /b 1
)

echo Download completed successfully!
echo.
echo Installing Python %PYTHON_VERSION%...

REM Prepare installation arguments
set INSTALL_ARGS=/quiet InstallAllUsers=%INSTALL_ALL_USERS% PrependPath=%ADD_TO_PATH% Include_test=0 Include_pip=1 Include_doc=1 Include_dev=1 Include_launcher=1

echo Installation arguments: %INSTALL_ARGS%
echo.

REM Run installer
"%INSTALLER_PATH%" %INSTALL_ARGS%

if %errorlevel% equ 0 (
    echo.
    echo Python installation completed successfully!
) else (
    echo.
    echo ERROR: Installation failed with exit code %errorlevel%
    pause
    exit /b 1
)

REM Clean up
echo.
echo Cleaning up temporary files...
if exist "%INSTALLER_PATH%" del "%INSTALLER_PATH%"
if exist "%TEMP_DIR%" rmdir "%TEMP_DIR%" 2>nul

REM Refresh environment variables by updating PATH from registry
echo.
echo Refreshing environment variables...

for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%B"

set "PATH=%SYS_PATH%;%USER_PATH%"

echo.
echo Verifying installation...

REM Test Python installation
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Python installed successfully!
    for /f "delims=" %%i in ('python --version 2^>^&1') do echo   Version: %%i
) else (
    echo Python command not found in current session.
    echo Try opening a new Command Prompt or PowerShell window.
)

REM Test pip installation
pip --version >nul 2>&1
if %errorlevel% equ 0 (
    echo pip installed successfully!
    for /f "delims=" %%i in ('pip --version 2^>^&1') do echo   Version: %%i
) else (
    echo pip command not found in current session.
)

echo.
echo ==========================================
echo Installation completed!
echo ==========================================
echo.
echo To verify installation:
echo   1. Open a new Command Prompt or PowerShell
echo   2. Run: python --version
echo   3. Run: pip --version
echo.
echo If Python is not found, you may need to:
echo   - Restart your computer, or
echo   - Manually add Python to your PATH
echo.

pause
exit /b 0