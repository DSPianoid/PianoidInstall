@echo off
setlocal enabledelayedexpansion

echo =========================================================================
echo Pianoid Package Installation
echo =========================================================================
echo.

set "ROOT_DIR=%~dp0"
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "BASIC_DIR=%ROOT_DIR%PianoidBasic"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"

echo Root directory:  %ROOT_DIR%
echo PianoidCore:     %CORE_DIR%
echo PianoidBasic:    %BASIC_DIR%
echo PianoidTunner:   %TUNNER_DIR%
echo.

rem =========================================================================
rem Verify directories exist
rem =========================================================================
echo Checking directories...

if not exist "%CORE_DIR%" (
    echo ERROR: PianoidCore directory not found. Run clone-packages.bat first.
    goto :error
)
if not exist "%BASIC_DIR%" (
    echo ERROR: PianoidBasic directory not found. Run clone-packages.bat first.
    goto :error
)
if not exist "%TUNNER_DIR%" (
    echo ERROR: PianoidTunner directory not found. Run clone-packages.bat first.
    goto :error
)
if not exist "%TUNNER_DIR%\package.json" (
    echo ERROR: package.json not found in PianoidTunner.
    goto :error
)

echo   OK  All directories found
echo.

rem =========================================================================
rem STEP 1: Setup Python virtual environment
rem =========================================================================
echo [STEP 1/4] Setting up Python virtual environment...
echo =========================================================================

rem Verify Python version is 3.12.x
python --version 2>nul | findstr /C:"3.12" >nul
if !errorlevel! neq 0 (
    echo ERROR: Python 3.12.x is required but not found on PATH.
    echo Found:
    python --version 2>&1
    echo.
    echo Install Python 3.12 via setup-packages.bat or ensure it is on PATH.
    goto :error
)

echo Python version:
python --version
echo.

set "VENV_DIR=%CORE_DIR%\.venv"

if not exist "%VENV_DIR%" (
    echo Creating virtual environment at %VENV_DIR% ...
    python -m venv "%VENV_DIR%"
    if !errorlevel! neq 0 (
        echo ERROR: Failed to create virtual environment
        goto :error
    )
    echo   OK  Virtual environment created
) else (
    echo   Virtual environment already exists at %VENV_DIR%
)

echo Activating virtual environment...
call "%VENV_DIR%\Scripts\activate.bat"
if !errorlevel! neq 0 (
    echo ERROR: Failed to activate virtual environment
    goto :error
)

echo Upgrading pip and build tools...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel build >nul
if !errorlevel! neq 0 (
    echo ERROR: Failed to upgrade pip/setuptools
    goto :error
)

if exist "%CORE_DIR%\requirements.txt" (
    echo Installing Python requirements...
    "%VENV_DIR%\Scripts\pip.exe" install -r "%CORE_DIR%\requirements.txt"
    if !errorlevel! neq 0 (
        echo ERROR: Failed to install requirements
        goto :error
    )
    echo   OK  Requirements installed
) else (
    echo   Note: No requirements.txt found, skipping
)

echo.
echo   OK  STEP 1 COMPLETED
echo.

rem =========================================================================
rem STEP 2: Build PianoidBasic package
rem =========================================================================
echo [STEP 2/4] Building PianoidBasic package...
echo =========================================================================

if not exist "%CORE_DIR%\build_pianoid_basic.bat" (
    echo ERROR: build_pianoid_basic.bat not found in PianoidCore
    goto :error
)

pushd "%CORE_DIR%"
call build_pianoid_basic.bat
set "BASIC_EXIT=!errorlevel!"
popd

if not !BASIC_EXIT! equ 0 (
    echo ERROR: PianoidBasic build failed with exit code !BASIC_EXIT!
    goto :error
)

echo.
echo   OK  STEP 2 COMPLETED
echo.

rem =========================================================================
rem STEP 3: Build PianoidCuda package (debug + release)
rem =========================================================================
echo [STEP 3/4] Building PianoidCuda package (release + debug)...
echo =========================================================================

if not exist "%CORE_DIR%\build_pianoid_cuda.bat" (
    echo ERROR: build_pianoid_cuda.bat not found in PianoidCore
    goto :error
)

pushd "%CORE_DIR%"
echo Running build_pianoid_cuda.bat --heavy --both ...
call build_pianoid_cuda.bat --heavy --both
set "CUDA_EXIT=!errorlevel!"
popd

if not !CUDA_EXIT! equ 0 (
    echo ERROR: PianoidCuda build failed with exit code !CUDA_EXIT!
    echo Check %CORE_DIR%\build.log for details.
    goto :error
)

echo.
echo   OK  STEP 3 COMPLETED
echo.

rem =========================================================================
rem STEP 4: Install frontend dependencies
rem =========================================================================
echo [STEP 4/4] Installing frontend dependencies...
echo =========================================================================

node --version >nul 2>&1
if !errorlevel! neq 0 (
    echo ERROR: Node.js not found. Install via setup-packages.bat or restart terminal.
    goto :error
)

echo Node.js version:
node --version
echo.

pushd "%TUNNER_DIR%"
echo Running npm install...
npm install
set "NPM_EXIT=!errorlevel!"
popd

if not !NPM_EXIT! equ 0 (
    echo ERROR: npm install failed with exit code !NPM_EXIT!
    goto :error
)

echo.
echo   OK  STEP 4 COMPLETED
echo.

rem =========================================================================
rem SUCCESS
rem =========================================================================
echo =========================================================================
echo   SUCCESS: Pianoid installation completed!
echo =========================================================================
echo.
echo   [1/4]  Python venv and dependencies
echo   [2/4]  PianoidBasic package
echo   [3/4]  PianoidCuda (release + debug)
echo   [4/4]  Frontend dependencies
echo.

if exist "%CORE_DIR%\.venv\Lib\site-packages\pianoidCuda*.pyd" (
    echo   OK  pianoidCuda.pyd found
) else (
    echo   ??  pianoidCuda.pyd not found in site-packages
)
if exist "%TUNNER_DIR%\node_modules" (
    echo   OK  node_modules found
) else (
    echo   ??  node_modules not found
)

echo.
echo To start the application:  start-pianoid.bat
echo =========================================================================
goto :end

:error
echo.
echo =========================================================================
echo   INSTALLATION FAILED
echo =========================================================================
echo See error messages above for details.
echo.
echo Prerequisites:
echo   1. setup-packages.bat (as admin) - install system dependencies
echo   2. clone-packages.bat            - clone sub-repositories
echo.

:end
echo.
echo Press any key to exit...
pause >nul
exit /b 0
