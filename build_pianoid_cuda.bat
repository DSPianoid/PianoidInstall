@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem -----------------------------------------------------------
rem Paths
rem -----------------------------------------------------------
set "REPO_ROOT=%~dp0"
set "PROJECT_DIR=%REPO_ROOT%pianoid_cuda"
set "BUILD_LOG=%REPO_ROOT%build.log"
set "BUILD_CFG=%PROJECT_DIR%\build_config.json"

echo === PianoidCore Build ===

rem -----------------------------------------------------------
rem Activate venv if exists, then find Python
rem -----------------------------------------------------------
set "VENV_DIR=%REPO_ROOT%.venv"
if not defined VIRTUAL_ENV (
    if exist "%VENV_DIR%\Scripts\activate.bat" (
        echo Activating virtual environment...
        call "%VENV_DIR%\Scripts\activate.bat"
    )
)

set "PY_EXE="
if defined VIRTUAL_ENV (
    if exist "%VIRTUAL_ENV%\Scripts\python.exe" set "PY_EXE=%VIRTUAL_ENV%\Scripts\python.exe"
)
if not defined PY_EXE (
    for %%I in (python.exe) do (
        for /f "delims=" %%P in ('where %%I 2^>nul') do (
            if not defined PY_EXE set "PY_EXE=%%P"
        )
    )
)
if not defined PY_EXE (
    echo [ERROR] Could not locate python on PATH.
    exit /b 1
)

echo Using Python: %PY_EXE%

rem Ensure project dir exists
if not exist "%PROJECT_DIR%" (
    echo [ERROR] Folder not found: "%PROJECT_DIR%"
    exit /b 1
)

rem Clear build log
echo === PianoidCore Build Log - %date% %time% === > "%BUILD_LOG%"

rem -----------------------------------------------------------
rem Clean stale egg-info
rem -----------------------------------------------------------
echo [1/6] Cleaning build artifacts...
for /d %%G in ("%PROJECT_DIR%\*.egg-info") do (
    rd /s /q "%%~fG" >>"%BUILD_LOG%" 2>&1
    echo Removed %%~nxG >> "%BUILD_LOG%"
)

rem Clean build directory
if exist "%PROJECT_DIR%\build" (
    rd /s /q "%PROJECT_DIR%\build" >>"%BUILD_LOG%" 2>&1
    echo Removed build directory >> "%BUILD_LOG%"
)

rem Clean dist directory
if exist "%PROJECT_DIR%\dist" (
    rd /s /q "%PROJECT_DIR%\dist" >>"%BUILD_LOG%" 2>&1
    echo Removed dist directory >> "%BUILD_LOG%"
)

rem Clean any .pyd files in project directory
del /q "%PROJECT_DIR%\*.pyd" >>"%BUILD_LOG%" 2>&1
del /q "%PROJECT_DIR%\*.obj" >>"%BUILD_LOG%" 2>&1

rem -----------------------------------------------------------
rem Uninstall existing package and clear cache
rem -----------------------------------------------------------
echo [2/6] Uninstalling existing package...
"%PY_EXE%" -m pip uninstall -y pianoidCuda >>"%BUILD_LOG%" 2>&1
echo [3/6] Clearing pip cache...
"%PY_EXE%" -m pip cache purge >>"%BUILD_LOG%" 2>&1

rem -----------------------------------------------------------
rem Detect toolchain and write build_config.json
rem -----------------------------------------------------------
echo [4/6] Detecting toolchain...
"%PY_EXE%" "detect_paths.py" --out "%BUILD_CFG%" --project-root "%PROJECT_DIR%" --quiet >>"%BUILD_LOG%" 2>&1
if errorlevel 1 (
    echo [ERROR] Toolchain detection failed. Check build.log for details.
    exit /b 1
)

rem -----------------------------------------------------------
rem Upgrade build tools
rem -----------------------------------------------------------
echo [5/6] Upgrading build tools...
"%PY_EXE%" -m pip install -q --upgrade pip setuptools wheel >>"%BUILD_LOG%" 2>&1

rem -----------------------------------------------------------
rem Build and install package
rem -----------------------------------------------------------
echo [6/6] Building package...
set "PIANOID_BUILD_CONFIG=%BUILD_CFG%"
"%PY_EXE%" -m pip install --no-cache-dir -v --force-reinstall --no-deps "%PROJECT_DIR%" >>"%BUILD_LOG%" 2>&1
set "INSTALL_EXIT_CODE=%errorlevel%"

if not %INSTALL_EXIT_CODE%==0 (
    echo [ERROR] Build failed. Check build.log for details.
    exit /b %INSTALL_EXIT_CODE%
)

echo [SUCCESS] Package installed successfully.
exit /b 0
