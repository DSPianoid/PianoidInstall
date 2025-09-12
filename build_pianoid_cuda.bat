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
rem Find Python (prefer active venv)
rem -----------------------------------------------------------
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
echo [1/4] Cleaning...
for /d %%G in ("%PROJECT_DIR%\*.egg-info") do (
    rd /s /q "%%~fG" >>"%BUILD_LOG%" 2>&1
    echo Removed %%~nxG >> "%BUILD_LOG%"
)

rem Clean build directory
if exist "%PROJECT_DIR%\build" (
    rd /s /q "%PROJECT_DIR%\build" >>"%BUILD_LOG%" 2>&1
    echo Removed build directory >> "%BUILD_LOG%"
)

rem -----------------------------------------------------------
rem Detect toolchain and write build_config.json
rem -----------------------------------------------------------
echo [2/4] Detecting toolchain...
"%PY_EXE%" "detect_paths.py" --out "%BUILD_CFG%" --project-root "%PROJECT_DIR%" --quiet >>"%BUILD_LOG%" 2>&1
if errorlevel 1 (
    echo [ERROR] Toolchain detection failed. Check build.log for details.
    exit /b 1
)

rem -----------------------------------------------------------
rem Upgrade build tools
rem -----------------------------------------------------------
echo [3/4] Upgrading build tools...
"%PY_EXE%" -m pip install -q --upgrade pip setuptools wheel >>"%BUILD_LOG%" 2>&1

rem -----------------------------------------------------------
rem Build and install package
rem -----------------------------------------------------------
echo [4/4] Building package...
set "PIANOID_BUILD_CONFIG=%BUILD_CFG%"
"%PY_EXE%" -m pip install -v "%PROJECT_DIR%" >>"%BUILD_LOG%" 2>&1
set "INSTALL_EXIT_CODE=%errorlevel%"

if not %INSTALL_EXIT_CODE%==0 (
    echo [ERROR] Build failed. Check build.log for details.
    exit /b %INSTALL_EXIT_CODE%
)

echo [SUCCESS] Package installed successfully.
exit /b 0