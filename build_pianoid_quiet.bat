@echo off
setlocal ENABLEDELAYEDEXPANSION

rem =============================================================================
rem build_pianoid_full.bat
rem Location: Keep this file in the PianoidCore folder
rem Purpose : Complete end-to-end build: venv setup + PianoidBasic + PianoidCuda
rem =============================================================================

echo === PianoidCore Full Build Process ===
echo.

rem ---------------------------------------------
rem STEP 1: Virtual Environment Setup
rem ---------------------------------------------
echo [STEP 1/3] Setting up virtual environment...

set "CORE_DIR=%~dp0"
set "VENV_DIR=%CORE_DIR%.venv"
set "ACTIVATE_BAT=%VENV_DIR%\Scripts\activate.bat"
set "PYTHON=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"

echo   Creating virtual environment at: "%VENV_DIR%"
if not exist "%VENV_DIR%" (
    python -m venv .venv
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment.
        exit /b 1
    )
)

echo   Activating virtual environment...
call "%ACTIVATE_BAT%"
if /i not "%VIRTUAL_ENV%"=="%VENV_DIR%" (
    echo ERROR: Failed to activate virtual environment.
    exit /b 1
)

echo   Upgrading pip and installing requirements...
"%PYTHON%" -m pip install --upgrade pip
if exist requirements.txt (
    "%PYTHON%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: Failed to install requirements.
        exit /b 1
    )
) else (
    echo   Note: No requirements.txt found, skipping requirements installation.
)

echo   ✓ Virtual environment setup completed!
echo.

rem ---------------------------------------------
rem STEP 2: Build and Install PianoidBasic
rem ---------------------------------------------
echo [STEP 2/3] Building and installing PianoidBasic...

rem Locate PianoidBasic (assumed sibling of PianoidCore)
set "BASIC_DIR=%CORE_DIR%..\PianoidBasic"
if not exist "%BASIC_DIR%" (
    echo   Trying alternative location...
    set "BASIC_DIR=%CORE_DIR%PianoidBasic"
)

if not exist "%BASIC_DIR%" (
    echo ERROR: Could not locate the PianoidBasic folder.
    echo Expected at: "..\PianoidBasic" next to PianoidCore.
    exit /b 1
)

if not exist "%BASIC_DIR%\pyproject.toml" if not exist "%BASIC_DIR%\setup.py" (
    echo ERROR: PianoidBasic does not appear to contain a pyproject.toml or setup.py.
    echo   Checked folder: "%BASIC_DIR%"
    exit /b 1
)

echo   Found PianoidBasic at: "%BASIC_DIR%"

pushd "%BASIC_DIR%"

echo   Cleaning previous builds...
if exist build  rmdir /s /q build
if exist dist   rmdir /s /q dist
for /d %%G in (*.egg-info) do (
    if exist "%%G" rmdir /s /q "%%G"
)

echo   Installing/Updating build tools...
"%PYTHON%" -m pip install --upgrade pip setuptools wheel build >nul
if errorlevel 1 (
    echo ERROR: Failed to install/upgrade build tools.
    popd
    exit /b 1
)

echo   Building PianoidBasic (sdist and wheel)...
"%PYTHON%" -m build
if errorlevel 1 (
    echo ERROR: PianoidBasic build failed.
    popd
    exit /b 1
)

rem Find newest wheel in dist\
set "WHEEL="
for /f "delims=" %%W in ('dir /b /a:-d /o:-d "dist\*.whl" 2^>nul') do (
    set "WHEEL=dist\%%W"
    goto :found_wheel
)

:found_wheel
if not defined WHEEL (
    echo ERROR: No wheel file found in "%BASIC_DIR%\dist".
    popd
    exit /b 1
)

echo   Installing PianoidBasic wheel: "%WHEEL%"
"%PIP%" install --no-deps --upgrade --force-reinstall "%BASIC_DIR%\%WHEEL%"
if errorlevel 1 (
    echo ERROR: PianoidBasic installation failed.
    popd
    exit /b 1
)

popd

echo   ✓ PianoidBasic build and installation completed!
echo.

rem ---------------------------------------------
rem STEP 3: Build and Install PianoidCuda
rem ---------------------------------------------
echo [STEP 3/3] Building and installing PianoidCuda...

set "PROJECT_DIR=%CORE_DIR%pianoid_cuda"
set "BUILD_LOG=%CORE_DIR%build.log"
set "BUILD_CFG=%PROJECT_DIR%\build_config.json"

rem Ensure project dir exists
if not exist "%PROJECT_DIR%" (
    echo ERROR: Folder not found: "%PROJECT_DIR%"
    exit /b 1
)

rem Clear build log
echo === PianoidCuda Build Log - %date% %time% === > "%BUILD_LOG%"

echo   Cleaning PianoidCuda build artifacts...
for /d %%G in ("%PROJECT_DIR%\*.egg-info") do (
    rd /s /q "%%~fG" >>"%BUILD_LOG%" 2>&1
    echo Removed %%~nxG >> "%BUILD_LOG%"
)

if exist "%PROJECT_DIR%\build" (
    rd /s /q "%PROJECT_DIR%\build" >>"%BUILD_LOG%" 2>&1
    echo Removed build directory >> "%BUILD_LOG%"
)

echo   Detecting toolchain...
if exist "detect_paths.py" (
    "%PYTHON%" "detect_paths.py" --out "%BUILD_CFG%" --project-root "%PROJECT_DIR%" --quiet >>"%BUILD_LOG%" 2>&1
    if errorlevel 1 (
        echo ERROR: Toolchain detection failed. Check build.log for details.
        exit /b 1
    )
) else (
    echo   Note: detect_paths.py not found, proceeding without build config.
)

echo   Upgrading build tools for CUDA build...
"%PYTHON%" -m pip install -q --upgrade pip setuptools wheel >>"%BUILD_LOG%" 2>&1

echo   Building and installing PianoidCuda package...
if exist "%BUILD_CFG%" (
    set "PIANOID_BUILD_CONFIG=%BUILD_CFG%"
)
"%PYTHON%" -m pip install -v "%PROJECT_DIR%" >>"%BUILD_LOG%" 2>&1
set "INSTALL_EXIT_CODE=!errorlevel!"

if not !INSTALL_EXIT_CODE!==0 (
    echo ERROR: PianoidCuda build failed. Check build.log for details.
    exit /b !INSTALL_EXIT_CODE!
)

echo   ✓ PianoidCuda build and installation completed!
echo.

rem ---------------------------------------------
rem Success Summary
rem ---------------------------------------------
echo =============================================================================
echo ✓ SUCCESS: Complete PianoidCore build process finished!
echo.
echo Summary of completed steps:
echo   [1/3] Virtual environment setup and requirements installation
echo   [2/3] PianoidBasic package built and installed
echo   [3/3] PianoidCuda package built and installed
echo.
echo Virtual environment location: "%VENV_DIR%"
echo Build log available at: "%BUILD_LOG%"
echo.
echo The environment is ready for use. You can now run your PianoidCore applications.
echo =============================================================================
