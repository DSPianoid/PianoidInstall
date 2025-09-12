@echo off
setlocal EnableExtensions

REM ------------------------------------------------------------
REM Pianoid venv setup/repair (portable & robust; no fragile paren blocks)
REM - Keep existing .venv if healthy; rebuild only when missing/broken
REM - Install requirements.lock if present
REM - Always ensure pybind11 is installed
REM - Find Python: py -3-64 -> py -3 -> PowerShell Get-Command -> PATH -> common dirs
REM ------------------------------------------------------------

cd /d "%~dp0"

set "VENVDIR=.venv"
set "VENV_PY=%VENVDIR%\Scripts\python.exe"
set "REQ_FILE=requirements.lock"
set "THRESHOLD=100000"    REM sanity floor for python.exe size (~100 KB)

echo === Pianoid venv setup ===

REM ---- Step 1: decide whether we must rebuild ----
set "NEEDS_REBUILD="
if not exist "%VENV_PY%" goto no_venv

for %%S in ("%VENV_PY%") do set "PY_SIZE=%%~zS"
if "%PY_SIZE%"=="" set "PY_SIZE=0"
if %PY_SIZE% LSS %THRESHOLD% goto corrupt_venv

call :try_py "%VENV_PY%"
if errorlevel 1 goto unrunnable_venv

echo [1/4] Existing venv detected and healthy.
goto deps

:no_venv
echo [1/4] No existing venv -> will create a new one.
set "NEEDS_REBUILD=1"
goto select_base

:corrupt_venv
echo [1/4] Existing venv Python looks corrupt (size %PY_SIZE% bytes) -> will recreate.
set "NEEDS_REBUILD=1"
goto select_base

:unrunnable_venv
echo [1/4] Existing venv Python is not runnable -> will recreate.
set "NEEDS_REBUILD=1"
goto select_base


REM ---- Step 2: create venv only if needed ----
:select_base
if not defined NEEDS_REBUILD goto deps
echo [2/4] Selecting base Python...

set "BASEPYEXE="

REM A) Python launcher (resolved executable path)
call :from_launcher "-3-64" BASEPYEXE
if not errorlevel 1 goto create_venv

call :from_launcher "-3" BASEPYEXE
if not errorlevel 1 goto create_venv

REM B) PowerShell Get-Command python
call :from_powershell BASEPYEXE
if not errorlevel 1 (
  call :try_py "%BASEPYEXE%"
  if not errorlevel 1 goto create_venv
)

REM C) PATH (skip WindowsApps stubs)
call :where_first_non_windowsapps python BASEPYEXE
if not errorlevel 1 (
  call :try_py "%BASEPYEXE%"
  if not errorlevel 1 goto create_venv
)

REM D) Common install folders
call :find_common_python BASEPYEXE
if not errorlevel 1 (
  call :try_py "%BASEPYEXE%"
  if not errorlevel 1 goto create_venv
)

echo   ERROR: No usable base Python found.
goto fail

:create_venv
echo [3/4] Creating virtual environment with: "%BASEPYEXE%"
"%BASEPYEXE%" -m venv "%VENVDIR%"
if errorlevel 1 goto fail


REM ---- Step 3: deps/tooling (no () blocks to prevent parser issues) ----
:deps
echo [4/4] Ensuring tools and dependencies...
"%VENV_PY%" -m pip install -U pip wheel setuptools
if errorlevel 1 goto fail

if exist "%REQ_FILE%" goto do_reqs
echo   -> No requirements.lock found; skipping requirements restore.
goto check_pybind

:do_reqs
echo   -> Installing from "%REQ_FILE%" - pip will skip satisfied packages.
"%VENV_PY%" -m pip install -r "%REQ_FILE%"
if errorlevel 1 goto fail

:check_pybind
echo   -> Ensuring pybind11 is installed...
"%VENV_PY%" -m pip show pybind11 >nul 2>&1
if errorlevel 1 goto install_pybind
echo      pybind11 already present.
goto summary

:install_pybind
"%VENV_PY%" -m pip install pybind11
if errorlevel 1 goto fail

:summary
for /f "usebackq delims=" %%V in (`"%VENV_PY%" -V`) do set "PYVER=%%V"
echo.
echo SUCCESS: venv ready.
echo Python    : %PYVER%
echo Interpreter: %CD%\%VENV_PY%
exit /b 0

:fail
echo.
echo FAILED: venv setup did not complete.
exit /b 1


REM =======================
REM try_py <exePath>  (0 OK, 1 fail)
REM =======================
:try_py
setlocal
set "_EXE=%~1"
if not exist "%_EXE%" ( endlocal & exit /b 1 )
"%_EXE%" -c "import sys; sys.exit(0)" >nul 2>&1
endlocal & exit /b %ERRORLEVEL%


REM =======================
REM from_launcher <flag> <outvar>   (0 on success)
REM Asks the Python launcher to print sys.executable for that flag.
REM =======================
:from_launcher
setlocal
set "_FLAG=%~1"
set "_OUTVAR=%~2"
set "_FOUND="
for /f "usebackq delims=" %%P in (`py %_FLAG% -c "import sys;print(sys.executable)" 2^>nul`) do set "_FOUND=%%P"
if not defined _FOUND ( endlocal & exit /b 1 )
if not exist "%_FOUND%" ( endlocal & exit /b 1 )
endlocal & set "%_OUTVAR%=%_FOUND%" & exit /b 0


REM =======================
REM from_powershell <outvar>  (0 on success)
REM Uses PowerShell to resolve 'python' to a real path.
REM =======================
:from_powershell
setlocal
set "_OUTVAR=%~1"
set "_FOUND="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-Command python -ErrorAction SilentlyContinue).Source" 2^>nul`) do set "_FOUND=%%P"
if not defined _FOUND ( endlocal & exit /b 1 )
if not exist "%_FOUND%" ( endlocal & exit /b 1 )
endlocal & set "%~1=%_FOUND%" & exit /b 0


REM =======================
REM where_first_non_windowsapps <cmd> <outvar>  (0 on success)
REM Filters out WindowsApps stubs that don’t run under cmd.exe.
REM =======================
:where_first_non_windowsapps
setlocal
set "_cmd=%~1"
for /f "delims=" %%P in ('where "%_cmd%" 2^>nul') do (
  echo %%P | findstr /I "\\WindowsApps\\python.exe" >nul
  if errorlevel 1 (
    endlocal & set "%~2=%%P" & exit /b 0
  )
)
endlocal & exit /b 1


REM =======================
REM find_common_python <outvar>  (0 on success)
REM Looks in typical install roots for Python3x and returns the newest found.
REM =======================
:find_common_python
setlocal
set "_ret="
call :pick_from_base "%LOCALAPPDATA%\Programs\Python" _ret
if defined _ret ( endlocal & set "%~1=%_ret%" & exit /b 0 )
call :pick_from_base "%ProgramFiles%\Python" _ret
if defined _ret ( endlocal & set "%~1=%_ret%" & exit /b 0 )
call :pick_from_base "%ProgramFiles(x86)%\Python" _ret
if defined _ret ( endlocal & set "%~1=%_ret%" & exit /b 0 )
call :pick_from_base "C:\Python" _ret
if defined _ret ( endlocal & set "%~1=%_ret%" & exit /b 0 )
endlocal & exit /b 1

REM Helper: scan a base dir for Python3* subfolders (newest first)
:pick_from_base
setlocal
set "_base=%~1"
if not exist "%_base%" ( endlocal & exit /b 1 )
for /f "delims=" %%D in ('dir /b /ad "%_base%\Python3*" 2^>nul ^| sort /r') do (
  if exist "%_base%\%%D\python.exe" (
    endlocal & set "%~2=%_base%\%%D\python.exe" & exit /b 0
  )
)
endlocal & exit /b 1
