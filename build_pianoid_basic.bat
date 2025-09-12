@echo off
setlocal ENABLEDELAYEDEXPANSION

rem ---------------------------------------------
rem build_pianoid_basic.bat
rem Location: Keep this file in the PianoidCore folder
rem Purpose : Build PianoidBasic (sibling folder) and install into PianoidCore\.venv
rem ---------------------------------------------

rem Resolve directories
set "CORE_DIR=%~dp0"
set "VENV_DIR=%CORE_DIR%.venv"
set "ACTIVATE_BAT=%VENV_DIR%\Scripts\activate.bat"
set "PYTHON=%VENV_DIR%\Scripts\python.exe"
set "PIP=%VENV_DIR%\Scripts\pip.exe"

echo [1/4] Checking/activating virtual environment at "%VENV_DIR%" ...

if not exist "%PYTHON%" (
  echo ERROR: Expected virtual environment not found at "%VENV_DIR%".
  echo Please create it first, e.g.:  python -m venv ".venv"
  exit /b 1
)

rem If not activated or different venv, activate it
if /i not "%VIRTUAL_ENV%"=="%VENV_DIR%" (
  call "%ACTIVATE_BAT%"
)

rem Verify activation (VIRTUAL_ENV should be set now)
if /i not "%VIRTUAL_ENV%"=="%VENV_DIR%" (
  echo ERROR: Failed to activate virtual environment at "%VENV_DIR%".
  exit /b 1
)

echo   Using Python: "%PYTHON%"
for /f "delims=" %%V in ('"%PYTHON%" --version') do echo   Python version: %%V

rem ---------------------------------------------
rem Locate PianoidBasic (assumed sibling of PianoidCore)
rem ---------------------------------------------
set "BASIC_DIR=%CORE_DIR%..\PianoidBasic"
if not exist "%BASIC_DIR%" (
  echo Trying alternative location...
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

echo [2/4] Found PianoidBasic at: "%BASIC_DIR%"

pushd "%BASIC_DIR%"

rem ---------------------------------------------
rem Clean previous builds
rem ---------------------------------------------
echo [3/4] Cleaning previous builds (build/, dist/, *.egg-info)...

if exist build  rmdir /s /q build
if exist dist   rmdir /s /q dist

for /d %%G in (*.egg-info) do (
  if exist "%%G" rmdir /s /q "%%G"
)

rem ---------------------------------------------
rem Build new distributions
rem ---------------------------------------------
echo Installing/Updating build backend (setuptools/wheel) and frontend (build)...
"%PYTHON%" -m pip install --upgrade pip setuptools wheel build >nul
if errorlevel 1 (
  echo ERROR: Failed to install/upgrade build tools.
  popd
  exit /b 1
)

echo [3/4] Building PianoidBasic (sdist and wheel)...
"%PYTHON%" -m build
if errorlevel 1 (
  echo ERROR: Build failed.
  popd
  exit /b 1
)

rem Find newest wheel in dist\
set "WHEEL="
for /f "delims=" %%W in ('dir /b /a:-d /o:-d "dist\*.whl"') do (
  set "WHEEL=dist\%%W"
  goto :found_wheel
)

:found_wheel
if not defined WHEEL (
  echo ERROR: No wheel file found in "%BASIC_DIR%\dist".
  popd
  exit /b 1
)

echo   Built wheel: "%BASIC_DIR%\%WHEEL%"

rem ---------------------------------------------
rem Install into PianoidCore\.venv
rem ---------------------------------------------
echo [4/4] Installing PianoidBasic into "%VENV_DIR%" ...
"%PIP%" install --no-deps --upgrade --force-reinstall "%BASIC_DIR%\%WHEEL%"
if errorlevel 1 (
  echo ERROR: Installation failed.
  popd
  exit /b 1
)

popd

echo.
echo SUCCESS: PianoidBasic built and installed into PianoidCore\.venv
echo.
exit /b 0
