@echo off
setlocal enabledelayedexpansion

echo =========================================================================
echo PianoidCore Package Installation (Pure Batch Version)
echo =========================================================================
echo.

set "ROOT_DIR=%~dp0"
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"

echo Root directory: %ROOT_DIR%
echo PianoidCore: %CORE_DIR%
echo PianoidTunner: %TUNNER_DIR%
echo.

rem =========================================================================
rem STEP 1: Copy batch files to PianoidCore
rem =========================================================================
echo [STEP 1/4] Copying batch files to PianoidCore...
echo =========================================================================

if not exist "%CORE_DIR%" (
    echo ERROR: PianoidCore directory not found
    goto :error
)

echo Copying batch files...

if exist "%ROOT_DIR%build_pianoid_venv.bat" (
    copy "%ROOT_DIR%build_pianoid_venv.bat" "%CORE_DIR%\build_pianoid_venv.bat" >nul
    if !errorlevel! equ 0 (
        echo   ✓ Copied build_pianoid_venv.bat
    ) else (
        echo   ✗ Failed to copy build_pianoid_venv.bat
    )
) else (
    echo   ⚠ build_pianoid_venv.bat not found in root
)

if exist "%ROOT_DIR%build_pianoid_complete.bat" (
    copy "%ROOT_DIR%build_pianoid_complete.bat" "%CORE_DIR%\build_pianoid_complete.bat" >nul
    if !errorlevel! equ 0 (
        echo   ✓ Copied build_pianoid_complete.bat
    ) else (
        echo   ✗ Failed to copy build_pianoid_complete.bat
    )
) else (
    echo   ⚠ build_pianoid_complete.bat not found in root
)

if exist "%ROOT_DIR%build_pianoid_quiet.bat" (
    copy "%ROOT_DIR%build_pianoid_quiet.bat" "%CORE_DIR%\build_pianoid_quiet.bat" >nul
    if !errorlevel! equ 0 (
        echo   ✓ Copied build_pianoid_quiet.bat
    ) else (
        echo   ✗ Failed to copy build_pianoid_quiet.bat
    )
) else (
    echo   ⚠ build_pianoid_quiet.bat not found in root
)

if exist "%ROOT_DIR%build_pianoid_cuda.bat" (
    copy "%ROOT_DIR%build_pianoid_cuda.bat" "%CORE_DIR%\build_pianoid_cuda.bat" >nul
    if !errorlevel! equ 0 (
        echo   ✓ Copied build_pianoid_cuda.bat
    ) else (
        echo   ✗ Failed to copy build_pianoid_cuda.bat
    )
) else (
    echo   ⚠ build_pianoid_cuda.bat not found in root
)

if exist "%ROOT_DIR%build_pianoid_basic.bat" (
    copy "%ROOT_DIR%build_pianoid_basic.bat" "%CORE_DIR%\build_pianoid_basic.bat" >nul
    if !errorlevel! equ 0 (
        echo   ✓ Copied build_pianoid_basic.bat
    ) else (
        echo   ✗ Failed to copy build_pianoid_basic.bat
    )
) else (
    echo   ⚠ build_pianoid_basic.bat not found in root
)

if exist "%ROOT_DIR%detect_paths.py" (
    copy "%ROOT_DIR%detect_paths.py" "%CORE_DIR%\detect_paths.py" >nul
    if !errorlevel! equ 0 (
        echo   ✓ Copied detect_paths.py
    ) else (
        echo   ✗ Failed to copy detect_paths.py
    )
) else (
    echo   ⚠ detect_paths.py not found in root
)



echo ✓ STEP 1 COMPLETED: Batch files copied
echo.

rem =========================================================================
rem STEP 2: Setup Python virtual environment
rem =========================================================================
echo [STEP 2/4] Setting up Python virtual environment...
echo =========================================================================

if not exist "%CORE_DIR%\build_pianoid_venv.bat" (
    echo ERROR: build_pianoid_venv.bat not found in PianoidCore after copy
    goto :error
)

echo Changing to PianoidCore directory...
pushd "%CORE_DIR%"

echo Running build_pianoid_venv.bat...
call build_pianoid_venv.bat
set "VENV_EXIT=!errorlevel!"

popd

if not !VENV_EXIT! equ 0 (
    echo ERROR: Virtual environment setup failed with exit code !VENV_EXIT!
    goto :error
)

echo ✓ STEP 2 COMPLETED: Python virtual environment setup
echo.

rem =========================================================================
rem STEP 3: Build PianoidCore packages  
rem =========================================================================
echo [STEP 3/4] Building PianoidCore packages...
echo =========================================================================

if not exist "%CORE_DIR%\build_pianoid_quiet.bat" (
    echo ERROR: build_pianoid_quiet.bat not found in PianoidCore after copy
    goto :error
)

echo Changing to PianoidCore directory...
pushd "%CORE_DIR%"

echo Running build_pianoid_quiet.bat...
call build_pianoid_quiet.bat
set "BUILD_EXIT=!errorlevel!"

popd

if not !BUILD_EXIT! equ 0 (
    echo ERROR: PianoidCore build failed with exit code !BUILD_EXIT!
    goto :error
)

echo ✓ STEP 3 COMPLETED: PianoidCore packages built
echo.

rem =========================================================================
rem STEP 4: Install frontend dependencies
rem =========================================================================
echo [STEP 4/4] Installing frontend dependencies...
echo =========================================================================

if not exist "%TUNNER_DIR%" (
    echo ERROR: PianoidTunner directory not found
    goto :error
)

if not exist "%TUNNER_DIR%\package.json" (
    echo ERROR: package.json not found in PianoidTunner
    goto :error
)

echo Checking Node.js...
node --version >nul 2>&1
if !errorlevel! neq 0 (
    echo ERROR: Node.js not found. You may need to restart your command prompt.
    goto :error
)

echo Node.js version:
node --version
echo.

echo Changing to PianoidTunner directory...
pushd "%TUNNER_DIR%"

echo Running npm install...
npm install
set "NPM_EXIT=!errorlevel!"

popd

if not !NPM_EXIT! equ 0 (
    echo ERROR: npm install failed with exit code !NPM_EXIT!
    goto :error
)

echo ✓ STEP 4 COMPLETED: Frontend dependencies installed
echo.

rem =========================================================================
rem SUCCESS
rem =========================================================================
echo =========================================================================
echo ✓ SUCCESS: PianoidCore installation completed!
echo =========================================================================
echo.
echo Summary of completed steps:
echo   [1/4] ✓ Batch files copied to PianoidCore
echo   [2/4] ✓ Python virtual environment and dependencies setup
echo   [3/4] ✓ PianoidCore packages built and installed
echo   [4/4] ✓ Frontend dependencies installed
echo.
echo Directory verification:
if exist "%CORE_DIR%\.venv" (
    echo   ✓ Python venv: %CORE_DIR%\.venv
) else (
    echo   ? Python venv: Not found ^(may still work^)
)
if exist "%TUNNER_DIR%\node_modules" (
    echo   ✓ Node modules: %TUNNER_DIR%\node_modules
) else (
    echo   ? Node modules: Not found
)
echo.
echo Your PianoidCore development environment is ready!
echo =========================================================================
goto :end

:error
echo.
echo =========================================================================
echo ✗ INSTALLATION FAILED
echo =========================================================================
echo See error messages above for details.

:end
echo.
echo Press any key to exit...
pause >nul
exit /b 0