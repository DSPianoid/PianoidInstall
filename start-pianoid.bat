@echo off
setlocal enabledelayedexpansion

echo =========================================================================
echo Starting Pianoid Application
echo =========================================================================
echo.

set "ROOT_DIR=%~dp0"
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "MIDDLEWARE_DIR=%CORE_DIR%\pianoid_middleware"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"
set "BACKEND_SCRIPT=%MIDDLEWARE_DIR%\backendserver.py"

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
    echo ERROR: backendserver.py not found: %BACKEND_SCRIPT%
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

rem Check if virtual environment exists
if not exist "%CORE_DIR%\.venv" (
    echo ERROR: Python virtual environment not found.
    echo Please run setup-pianoid.bat first.
    goto :error
)

echo   OK  Python virtual environment found
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
echo Press any key to start...
pause >nul

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
echo   python backendserver.py
echo.
echo   :: Terminal 2 - Frontend
echo   cd %TUNNER_DIR%
echo   npm start
echo -------------------------------------------------------------------------

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

:end
echo.
echo Press any key to exit...
pause >nul
exit /b 0
