@echo off
setlocal enabledelayedexpansion

rem -------------------------------------------------------------------------
rem Parse the launch flag (%1):
rem   /auto, --no-prompt   -> skip the "press any key" pauses; launch straight
rem                           through (used by the desktop shortcut). The
rem                           update-available pop-up may STILL appear.
rem   /auto-noupdate,
rem   /no-update-check     -> /auto AND skip the origin-ahead update check
rem                           (fully unattended).
rem A bare invocation (no flag, terminal run) keeps the current prompts.
rem -------------------------------------------------------------------------
set "NOPROMPT=0"
set "SKIP_UPDATE_CHECK=0"
if /I "%~1"=="/auto"            set "NOPROMPT=1"
if /I "%~1"=="--no-prompt"      set "NOPROMPT=1"
if /I "%~1"=="/auto-noupdate"   ( set "NOPROMPT=1" & set "SKIP_UPDATE_CHECK=1" )
if /I "%~1"=="/no-update-check" ( set "NOPROMPT=1" & set "SKIP_UPDATE_CHECK=1" )

echo =========================================================================
echo Starting Pianoid Application
echo =========================================================================
echo.

set "ROOT_DIR=%~dp0"
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "MIDDLEWARE_DIR=%CORE_DIR%\pianoid_middleware"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"
set "BACKEND_SCRIPT=%MIDDLEWARE_DIR%\backendServer.py"

echo Root directory: %ROOT_DIR%
echo PianoidCore:   %CORE_DIR%
echo PianoidTunner: %TUNNER_DIR%
echo.

rem =========================================================================
rem Verify prerequisites
rem =========================================================================
echo Checking prerequisites...

if not exist "%CORE_DIR%" (
    echo ERROR: PianoidCore directory not found: %CORE_DIR%
    goto :error
)

if not exist "%MIDDLEWARE_DIR%" (
    echo ERROR: pianoid_middleware directory not found: %MIDDLEWARE_DIR%
    goto :error
)

if not exist "%BACKEND_SCRIPT%" (
    echo ERROR: backendServer.py not found: %BACKEND_SCRIPT%
    goto :error
)

if not exist "%TUNNER_DIR%" (
    echo ERROR: PianoidTunner directory not found: %TUNNER_DIR%
    goto :error
)

if not exist "%TUNNER_DIR%\package.json" (
    echo ERROR: package.json not found in PianoidTunner
    goto :error
)

echo   OK  All directories and files found
echo.

rem Check if virtual environment exists.
rem Honour PIANOID_VENV_DIR if set (Linux NTFS-relocation case); default to PianoidCore\.venv on Windows.
if defined PIANOID_VENV_DIR (
    set "VENV_DIR=%PIANOID_VENV_DIR%"
) else (
    set "VENV_DIR=%CORE_DIR%\.venv"
)
if not exist "%VENV_DIR%" (
    echo ERROR: Python virtual environment not found at %VENV_DIR%.
    echo Please run setup-pianoid.bat first.
    goto :error
)

echo   OK  Python virtual environment found at %VENV_DIR%
echo.

rem Check if node_modules exists
if not exist "%TUNNER_DIR%\node_modules" (
    echo ERROR: node_modules not found in PianoidTunner.
    echo Please run setup-pianoid.bat first.
    goto :error
)

echo   OK  Frontend dependencies found
echo.

rem =========================================================================
rem Running-servers check: is a Pianoid stack already up?
rem
rem check-running-servers.ps1 detects LISTENING Pianoid ports (3000/3001/
rem 5000/5001). If a stack is running it offers (pop-up) Kill & restart vs
rem Cancel; Kill is PORT-TARGETED (owning PIDs only, never by image name).
rem Exit codes:
rem   20 -> a stack was up AND the user chose Cancel -> abort the launch.
rem    0 -> proceed (nothing up / killed & restarting / best-effort failure).
rem In /auto it runs non-interactively: warns on console, leaves the running
rem stack untouched, and proceeds (never kills the user's stack unattended).
rem Best-effort: a missing script or PowerShell falls through to launch.
rem =========================================================================
if not exist "%ROOT_DIR%check-running-servers.ps1" goto :after_running_check
where powershell >nul 2>&1
if errorlevel 1 goto :after_running_check

set "RUNNING_AUTO="
if "%NOPROMPT%"=="1" set "RUNNING_AUTO=-Auto"
set "RUNNING_RC=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT_DIR%check-running-servers.ps1" %RUNNING_AUTO%
set "RUNNING_RC=%errorlevel%"
if "%RUNNING_RC%"=="20" (
    echo.
    echo Launch cancelled - a Pianoid stack is already running.
    echo.
    goto :end
)
:after_running_check

rem =========================================================================
rem Best-effort update check (origin ahead?) -> offer to run update-repos.bat
rem
rem check-updates.ps1 fetches each Pianoid repo (short timeout) and, if any
rem origin is ahead, shows a Yes/No pop-up. It is fully self-contained and
rem returns:
rem    10  -> updates available AND the user clicked Yes  -> run update-repos
rem     0  -> anything else (up to date / No / git unreachable / no network /
rem           any failure) -> just launch
rem
rem The entire block is best-effort: if PowerShell or the script is missing,
rem or anything goes wrong, we fall through to the normal launch. It NEVER
rem blocks or errors the launch. Skipped entirely when /auto-noupdate is set.
rem =========================================================================
if "%SKIP_UPDATE_CHECK%"=="1" (
    echo Skipping update check ^(--no-update-check^).
    echo.
    goto :after_update_check
)
if not exist "%ROOT_DIR%check-updates.ps1" goto :after_update_check
where powershell >nul 2>&1
if errorlevel 1 goto :after_update_check

echo Checking for updates on origin ^(best-effort^)...
set "UPDATE_RC=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT_DIR%check-updates.ps1"
set "UPDATE_RC=%errorlevel%"

if "%UPDATE_RC%"=="10" (
    echo Updates accepted - running update-repos.bat ...
    echo.
    if exist "%ROOT_DIR%update-repos.bat" (
        call "%ROOT_DIR%update-repos.bat"
    ) else (
        echo WARNING: update-repos.bat not found - skipping update, proceeding to launch.
    )
    echo.
) else (
    echo   No update selected - proceeding to launch.
    echo.
)
:after_update_check

rem =========================================================================
rem CUDA device check (best-effort, before launch)
rem
rem check-cuda.ps1 queries the GPU via the engine venv + cupy (authoritative
rem SM count; nvidia-smi availability fallback). Pianoid's synthesis engine
rem runs a cooperative kernel whose block count (= strings / 4) must fit the
rem GPU's SM-bounded cooperative budget, so it warns when no CUDA device is
rem found or the device has < 60 SMs (full-keyboard presets may not run).
rem Exit codes:
rem   30 -> a warning was shown AND the user clicked Cancel -> abort the launch.
rem    0 -> proceed (device OK / user clicked Continue / could not determine).
rem In /auto the warnings are printed (informational) and the launch proceeds.
rem Best-effort: a missing script / PowerShell / venv falls through to launch.
rem =========================================================================
if not exist "%ROOT_DIR%check-cuda.ps1" goto :after_cuda_check
where powershell >nul 2>&1
if errorlevel 1 goto :after_cuda_check

set "CUDA_AUTO="
if "%NOPROMPT%"=="1" set "CUDA_AUTO=-Auto"
set "CUDA_RC=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT_DIR%check-cuda.ps1" %CUDA_AUTO%
set "CUDA_RC=%errorlevel%"
if "%CUDA_RC%"=="30" (
    echo.
    echo Launch cancelled at the CUDA check.
    echo.
    goto :end
)
:after_cuda_check

rem =========================================================================
rem Start application
rem =========================================================================
rem The launcher (server/launcher.js) manages the backend lifecycle:
rem   - Starts/stops the Flask backend on demand from the UI
rem   - Monitors backend health
rem   - Handles stale process cleanup
rem
rem "npm run dev" runs both the launcher (port 3001) and React dev server
rem (port 3000) via concurrently.

echo Starting Pianoid...
echo.
echo   Launcher + React dev server will start in a new window.
echo   The browser opens automatically at http://localhost:3000
echo   Click APPLY in the UI to start the backend.
echo.
echo   Services:
echo     Frontend UI:  http://localhost:3000
echo     Launcher WS:  http://localhost:3001
echo     Backend API:  http://localhost:5000  (after APPLY)
echo.
if "%NOPROMPT%"=="1" (
    echo Launching automatically ^(/auto^)...
) else (
    echo Press any key to start...
    pause >nul
)

start "Pianoid" /D "%TUNNER_DIR%" cmd /k "npm run dev"

echo.
echo =========================================================================
echo   OK  Pianoid started in a new window.
echo =========================================================================
echo.
echo To stop: close the Pianoid window or press Ctrl+C in it.
echo.
echo -------------------------------------------------------------------------
echo Manual start (alternative):
echo.
echo   cd %TUNNER_DIR%
echo   npm run dev
echo.
echo Or start backend and frontend separately:
echo.
echo   :: Terminal 1 - Backend
echo   cd %CORE_DIR%
echo   .venv\Scripts\activate.bat
echo   cd pianoid_middleware
echo   python backendServer.py
echo.
echo   :: Terminal 2 - Frontend
echo   cd %TUNNER_DIR%
echo   npm start
echo -------------------------------------------------------------------------

rem Success path: in /auto mode the window must not hang on a keypress after
rem spawning npm (the desktop shortcut launches this). Exit straight away.
if "%NOPROMPT%"=="1" exit /b 0
goto :end

:error
echo.
echo =========================================================================
echo   STARTUP FAILED
echo =========================================================================
echo See error messages above for details.
echo.
echo Make sure you have run the setup scripts first:
echo   1. setup-packages.bat (as admin) - install system dependencies
echo   2. setup-pianoid.bat             - build all packages
echo.
rem NOTE: the error path always pauses (even in /auto) so a shortcut-launched
rem window stays open long enough to read the failure instead of flashing away.

:end
echo.
echo Press any key to exit...
pause >nul
exit /b 0
