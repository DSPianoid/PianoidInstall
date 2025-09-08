@echo off
REM Batch script to download and install Git for Windows
REM Run as Administrator for best results

setlocal EnableDelayedExpansion

REM Configuration - Edit these variables as needed
set GIT_VERSION=2.47.0
set INSTALL_ALL_USERS=0
set ADD_TO_PATH=1

echo ==========================================
echo Git Auto-Installer for Windows
echo ==========================================
echo Git Version: %GIT_VERSION%
echo.

REM Check if running as administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Not running as Administrator. For best results, run as Admin.
    echo.
)

REM Create temp directory
set TEMP_DIR=%TEMP%\GitInstaller
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

REM Determine architecture
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
    set ARCH=64-bit
) else if "%PROCESSOR_ARCHITEW6432%"=="AMD64" (
    set ARCH=64-bit
) else (
    set ARCH=32-bit
)

echo Detected architecture: %ARCH%

REM Construct download URL and file path
set DOWNLOAD_URL=https://github.com/git-for-windows/git/releases/download/v%GIT_VERSION%.windows.1/Git-%GIT_VERSION%-%ARCH%.exe
set INSTALLER_PATH=%TEMP_DIR%\Git-%GIT_VERSION%-installer.exe

echo.
echo Downloading Git %GIT_VERSION% for %ARCH%...
echo URL: %DOWNLOAD_URL%
echo Output: %INSTALLER_PATH%
echo.

REM Download Git installer - try curl first, then bitsadmin
curl --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Using curl to download...
    curl -L -o "%INSTALLER_PATH%" "%DOWNLOAD_URL%"
    set DOWNLOAD_RESULT=%errorlevel%
) else (
    echo Using bitsadmin to download...
    bitsadmin /transfer "GitDownload" "%DOWNLOAD_URL%" "%INSTALLER_PATH%"
    set DOWNLOAD_RESULT=%errorlevel%
)

if !DOWNLOAD_RESULT! neq 0 (
    echo ERROR: Download failed.
    echo Please check if version %GIT_VERSION% exists on GitHub releases
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
echo Installing Git %GIT_VERSION%...

REM Prepare installation arguments for silent install
if %INSTALL_ALL_USERS% equ 1 (
    set INSTALL_SCOPE=AllUsers
) else (
    set INSTALL_SCOPE=CurrentUser
)

REM Git for Windows silent install parameters
set INSTALL_ARGS=/VERYSILENT /NORESTART /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="ext,ext\shellhere,ext\guihere,gitlfs,assoc,assoc_sh" /o:PathOption=Cmd

echo Installation scope: %INSTALL_SCOPE%
echo Installation arguments: %INSTALL_ARGS%
echo.

REM Run installer
"%INSTALLER_PATH%" %INSTALL_ARGS%

if %errorlevel% equ 0 (
    echo.
    echo Git installation completed successfully!
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

REM Refresh environment variables
echo.
echo Refreshing environment variables...

for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%B"

set "PATH=%SYS_PATH%;%USER_PATH%"

echo.
echo Verifying installation...

REM Test Git installation
git --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Git installed successfully!
    for /f "delims=" %%i in ('git --version 2^>^&1') do echo   Version: %%i
) else (
    echo Git command not found in current session.
    echo Try opening a new Command Prompt or PowerShell window.
)

REM Test if Git Bash is available
if exist "C:\Program Files\Git\bin\bash.exe" (
    echo Git Bash installed successfully!
) else if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    echo Git Bash installed successfully!
) else (
    echo Git Bash installation could not be verified.
)

echo.
echo ==========================================
echo Installation completed!
echo ==========================================
echo.
echo Git has been installed with these features:
echo   - Git command line tools
echo   - Git Bash (Unix-like shell)
echo   - Git GUI
echo   - Shell integration (right-click context menu)
echo   - File associations for .git files
echo   - Git LFS (Large File Storage)
echo.
echo To verify installation:
echo   1. Open a new Command Prompt or PowerShell
echo   2. Run: git --version
echo   3. Try: git config --global user.name "Your Name"
echo   4. Try: git config --global user.email "your.email@example.com"
echo.
echo You can also access Git Bash from the Start menu.
echo.

pause
exit /b 0