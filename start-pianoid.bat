@echo off
setlocal enabledelayedexpansion

echo =========================================================================
echo Starting PianoidCore Application
echo =========================================================================
echo.

set "ROOT_DIR=%~dp0"
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "MIDDLEWARE_DIR=%CORE_DIR%\pianoid_middleware"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"
set "BACKEND_SCRIPT=%MIDDLEWARE_DIR%\backendserver.py"

echo Root directory: %ROOT_DIR%
echo Backend script: %BACKEND_SCRIPT%
echo Frontend directory: %TUNNER_DIR%
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

echo ✓ All directories and files found
echo.

rem Check if virtual environment exists
if not exist "%CORE_DIR%\.venv" (
    echo ERROR: Python virtual environment not found.
    echo Please run the setup script first to create the virtual environment.
    goto :error
)

echo ✓ Python virtual environment found
echo.

rem Check if node_modules exists
if not exist "%TUNNER_DIR%\node_modules" (
    echo ERROR: node_modules not found in PianoidTunner.
    echo Please run the setup script first to install frontend dependencies.
    goto :error
)

echo ✓ Frontend dependencies found
echo.

rem =========================================================================
rem Start both processes
rem =========================================================================
echo Starting PianoidCore application...
echo.
echo This will open two windows:
echo   1. Backend Flask server (Python)
echo   2. Frontend development server (npm start)
echo.
echo Press Ctrl+C in either window to stop that process.
echo Close this window to stop both processes.
echo.
echo Press any key to start both servers...
pause >nul

echo Starting backend server...
start "PianoidCore Backend" /D "%CORE_DIR%" cmd /k ".venv\Scripts\activate.bat && cd pianoid_middleware && python backendserver.py"

echo Waiting 3 seconds for backend to start...
timeout /t 3 /nobreak >nul

echo Starting frontend server...
start "PianoidCore Frontend" /D "%TUNNER_DIR%" cmd /k "npm start"

echo.
echo =========================================================================
echo ✓ SUCCESS: Both servers started!
echo =========================================================================
echo.
echo Backend server: Running in PianoidCore Backend window
echo Frontend server: Running in PianoidCore Frontend window
echo.
echo The application should open in your web browser automatically.
echo If not, check the frontend window for the URL (usually http://localhost:3000)
echo.
echo To stop the application:
echo   - Close both server windows, OR
echo   - Press Ctrl+C in each server window, OR
echo   - Close this window (will attempt to stop both)
echo.
echo This window can be closed once both servers are running.
echo =========================================================================

goto :end

:error
echo.
echo =========================================================================
echo ✗ STARTUP FAILED
echo =========================================================================
echo See error messages above for details.
echo.
echo Make sure you have run the setup script first:
echo   1. setup-packages.bat (as admin) - for third-party packages
echo   2. simple-pianoid-setup.bat - for PianoidCore packages
echo.

:end
echo.
echo Press any key to exit...
pause >nul
exit /b 0