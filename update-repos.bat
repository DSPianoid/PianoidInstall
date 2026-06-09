@echo off
setlocal enabledelayedexpansion

rem =========================================================================
rem update-repos.bat — pull latest + rebuild only what changed
rem
rem Pulls each sub-repo (PianoidCore, PianoidTunner, PianoidBasic) on its
rem CURRENT branch (does NOT force-switch branches), then rebuilds ONLY what
rem the pulls changed, following the BUILD_SYSTEM.md "Post-Merge / Post-Pull
rem Rebuild Gate":
rem   - PianoidCore pull touched .cu/.cpp/.cuh/.h/setup.py/detect_paths.py,
rem     OR PianoidBasic changed .................. CUDA rebuild (build_pianoid_cuda.bat)
rem   - PianoidBasic pull changed any file ....... PianoidBasic rebuild (build_pianoid_basic.bat)
rem   - PianoidTunner package.json / package-lock changed ... npm ci
rem   - nothing relevant ......................... skip (idempotent no-op)
rem
rem Build variant (CUDA):
rem   default     ->  build_pianoid_cuda.bat --heavy --both   (release + debug)
rem   --release   ->  build_pianoid_cuda.bat --heavy --release
rem   --debug     ->  build_pianoid_cuda.bat --heavy --debug
rem   --help      ->  print usage and exit
rem
rem This script is meant to be run by a human in a foreground terminal. Before
rem any CUDA rebuild it STOPS the process holding the .pyd (a running backend),
rem otherwise the --heavy uninstall fails [WinError 5] and bricks the venv.
rem
rem Mirrors setup-pianoid.bat's structure/idioms. See:
rem   docs/architecture/BUILD_SYSTEM.md  (Post-Merge / Post-Pull Rebuild Gate,
rem                                       Canonical Install / Rebuild)
rem   docs/guides/QUICK_START.md         (Launcher API: stop-backend)
rem =========================================================================

set "ROOT_DIR=%~dp0"
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "BASIC_DIR=%ROOT_DIR%PianoidBasic"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"
set "LAUNCHER_URL=http://127.0.0.1:3001/api/stop-backend"

rem -------------------------------------------------------------------------
rem Parse arguments — default CUDA variant is --both (release + debug)
rem -------------------------------------------------------------------------
set "CUDA_VARIANT=both"
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--release" set "CUDA_VARIANT=release"
if /I "%~1"=="--debug"   set "CUDA_VARIANT=debug"
if /I "%~1"=="--both"    set "CUDA_VARIANT=both"
if /I "%~1"=="--help"    goto :usage
if /I "%~1"=="-h"        goto :usage
if /I "%~1"=="/?"        goto :usage
shift
goto :parse_args
:args_done

echo =========================================================================
echo Pianoid Repo Update  (pull + rebuild what changed)
echo =========================================================================
echo Root directory:  %ROOT_DIR%
echo CUDA variant:    --heavy --%CUDA_VARIANT%
echo.

rem -------------------------------------------------------------------------
rem Verify prerequisites: git on PATH + the three sub-repos exist
rem -------------------------------------------------------------------------
git --version >nul 2>&1
if !errorlevel! neq 0 (
    echo ERROR: git not found on PATH.
    goto :error
)
for %%D in ("%CORE_DIR%" "%BASIC_DIR%" "%TUNNER_DIR%") do (
    if not exist "%%~D" (
        echo ERROR: required directory missing: %%~D
        echo Run clone-packages.bat first.
        goto :error
    )
    if not exist "%%~D\.git" (
        echo ERROR: not a git repository: %%~D
        goto :error
    )
)

rem Result accumulators (filled per repo, printed in the final summary)
set "CORE_SUMMARY=skipped"
set "BASIC_SUMMARY=skipped"
set "TUNNER_SUMMARY=skipped"
set "BUILD_SUMMARY=nothing to rebuild"

rem Per-repo "what changed" flags (computed by :pull_repo via diff)
set "CORE_CUDA_CHANGED=0"
set "BASIC_CHANGED=0"
set "TUNNER_DEPS_CHANGED=0"

rem -------------------------------------------------------------------------
rem STEP 1: Pull each sub-repo on its CURRENT branch
rem -------------------------------------------------------------------------
echo [STEP 1/3] Pulling repositories (current branch each)...
echo =========================================================================

call :pull_repo "PianoidCore"   "%CORE_DIR%"
if !errorlevel! neq 0 goto :error
call :pull_repo "PianoidBasic"  "%BASIC_DIR%"
if !errorlevel! neq 0 goto :error
call :pull_repo "PianoidTunner" "%TUNNER_DIR%"
if !errorlevel! neq 0 goto :error

echo.
echo   OK  STEP 1 COMPLETED
echo.

rem -------------------------------------------------------------------------
rem STEP 2: Decide what to rebuild (Post-Merge / Post-Pull Rebuild Gate)
rem -------------------------------------------------------------------------
echo [STEP 2/3] Deciding what to rebuild...
echo =========================================================================

set "NEED_CUDA=0"
set "NEED_BASIC=0"
set "NEED_NPM=0"

rem PianoidBasic changed -> rebuild PianoidBasic AND (it's consumed by the
rem engine) the CUDA extension.
if "%BASIC_CHANGED%"=="1" (
    set "NEED_BASIC=1"
    set "NEED_CUDA=1"
)
rem PianoidCore compiled sources changed -> CUDA rebuild.
if "%CORE_CUDA_CHANGED%"=="1" set "NEED_CUDA=1"
rem PianoidTunner deps changed -> npm ci.
if "%TUNNER_DEPS_CHANGED%"=="1" set "NEED_NPM=1"

echo   PianoidCore CUDA sources changed : %CORE_CUDA_CHANGED%
echo   PianoidBasic changed             : %BASIC_CHANGED%
echo   PianoidTunner deps changed       : %TUNNER_DEPS_CHANGED%
echo.
echo   -^> Rebuild PianoidBasic : %NEED_BASIC%
echo   -^> Rebuild CUDA         : %NEED_CUDA%
echo   -^> npm ci (frontend)    : %NEED_NPM%
echo.

if "%NEED_CUDA%%NEED_BASIC%%NEED_NPM%"=="000" (
    echo   Nothing relevant changed — no rebuild needed.
    set "BUILD_SUMMARY=nothing to rebuild (idempotent no-op)"
    echo.
    echo   OK  STEP 2 COMPLETED
    goto :summary
)
echo   OK  STEP 2 COMPLETED
echo.

rem -------------------------------------------------------------------------
rem STEP 3: Rebuild
rem -------------------------------------------------------------------------
echo [STEP 3/3] Rebuilding...
echo =========================================================================

set "BUILD_SUMMARY="

rem --- Stop the .pyd holder BEFORE any CUDA rebuild -----------------------
rem A running backend holding pianoidCuda*.pyd makes the --heavy pip-uninstall
rem fail [WinError 5] and bricks the venv. Stop it first (launcher REST if a
rem launcher is up on 3001, else a PID-targeted kill of the listener on 5000).
if "%NEED_CUDA%"=="1" (
    echo Stopping any running backend that may hold the .pyd ...
    call :stop_backend
    echo.
)

rem --- PianoidBasic (must precede the CUDA build that consumes it) --------
if "%NEED_BASIC%"=="1" (
    echo --- Building PianoidBasic ---
    if not exist "%CORE_DIR%\build_pianoid_basic.bat" (
        echo ERROR: build_pianoid_basic.bat not found in PianoidCore
        goto :error
    )
    pushd "%CORE_DIR%"
    call build_pianoid_basic.bat
    set "BASIC_BUILD_EXIT=!errorlevel!"
    popd
    if not !BASIC_BUILD_EXIT! equ 0 (
        echo ERROR: PianoidBasic build failed with exit code !BASIC_BUILD_EXIT!
        goto :error
    )
    echo   OK  PianoidBasic rebuilt
    set "BUILD_SUMMARY=!BUILD_SUMMARY! PianoidBasic;"
    echo.
)

rem --- PianoidCuda -------------------------------------------------------
if "%NEED_CUDA%"=="1" (
    echo --- Building PianoidCuda [--heavy --%CUDA_VARIANT%] ---
    if not exist "%CORE_DIR%\build_pianoid_cuda.bat" (
        echo ERROR: build_pianoid_cuda.bat not found in PianoidCore
        goto :error
    )
    rem Set VIRTUAL_ENV EXPLICITLY to PianoidCore\.venv so the install lands in
    rem the correct venv (per BUILD_SYSTEM.md Canonical Install / Rebuild).
    pushd "%CORE_DIR%"
    set "VIRTUAL_ENV=%CORE_DIR%\.venv"
    call build_pianoid_cuda.bat --heavy --%CUDA_VARIANT%
    set "CUDA_BUILD_EXIT=!errorlevel!"
    popd
    if not !CUDA_BUILD_EXIT! equ 0 (
        echo ERROR: PianoidCuda build failed with exit code !CUDA_BUILD_EXIT!
        echo Check %CORE_DIR%\build.log for details.
        if "!CUDA_BUILD_EXIT!"=="3221225794" (
            echo NOTE: exit 3221225794 = 0xC0000142 STATUS_DLL_INIT_FAILED.
            echo       See BUILD_SYSTEM.md "0xC0000142 Recovery" — do NOT pip install manually.
        )
        goto :error
    )
    echo   OK  PianoidCuda rebuilt [--heavy --%CUDA_VARIANT%]
    set "BUILD_SUMMARY=!BUILD_SUMMARY! PianoidCuda(--heavy --%CUDA_VARIANT%);"
    echo.
)

rem --- Frontend npm ci ---------------------------------------------------
if "%NEED_NPM%"=="1" (
    echo --- Installing frontend dependencies [npm ci] ---
    node --version >nul 2>&1
    if !errorlevel! neq 0 (
        echo ERROR: Node.js not found on PATH.
        goto :error
    )
    pushd "%TUNNER_DIR%"
    npm ci
    set "NPM_EXIT=!errorlevel!"
    popd
    if not !NPM_EXIT! equ 0 (
        echo ERROR: npm ci failed with exit code !NPM_EXIT!
        goto :error
    )
    echo   OK  Frontend dependencies reinstalled
    set "BUILD_SUMMARY=!BUILD_SUMMARY! npm ci(PianoidTunner);"
    echo.
)

echo   OK  STEP 3 COMPLETED
echo.

rem -------------------------------------------------------------------------
rem Summary
rem -------------------------------------------------------------------------
:summary
echo =========================================================================
echo   UPDATE SUMMARY
echo =========================================================================
echo   PianoidCore    : !CORE_SUMMARY!
echo   PianoidBasic   : !BASIC_SUMMARY!
echo   PianoidTunner  : !TUNNER_SUMMARY!
echo   Rebuilt        : !BUILD_SUMMARY!
echo.
if "%NEED_CUDA%"=="1" (
    echo   Verify the CUDA build landed in the correct venv:
    echo     PianoidCore\.venv\Scripts\python -c "import pianoidCuda; print(pianoidCuda.__file__)"
    echo   Then smoke-test: start the backend and POST /load_preset (expect 200).
    echo.
)
echo To start the application:  start-pianoid.bat
echo =========================================================================
goto :end

rem =========================================================================
rem SUBROUTINE :pull_repo  <display-name>  <repo-dir>
rem   Records current branch + pre-pull SHA, pulls the current branch's
rem   upstream, records post-pull SHA, WARNs if not on dev, computes the
rem   changed-file flags via diff, and fills the per-repo summary variable.
rem =========================================================================
:pull_repo
set "REPO_NAME=%~1"
set "REPO_DIR=%~2"
echo.
echo --- %REPO_NAME% ---
pushd "%REPO_DIR%"

rem Current branch
for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH (
    echo ERROR: could not determine current branch in %REPO_DIR%
    popd
    exit /b 1
)
echo   Branch: !BRANCH!
if /I not "!BRANCH!"=="dev" (
    echo   WARNING: %REPO_NAME% is NOT on 'dev' ^(on '!BRANCH!'^) — pulling its current branch anyway.
)

rem Pre-pull SHA
for /f "delims=" %%S in ('git rev-parse HEAD 2^>nul') do set "PRE_SHA=%%S"

rem Pull the current branch's upstream
echo   Pulling...
git pull --ff-only
set "PULL_EXIT=!errorlevel!"
if not !PULL_EXIT! equ 0 (
    echo   ERROR: git pull failed for %REPO_NAME% ^(exit !PULL_EXIT!^).
    echo   Resolve manually ^(diverged branch / no upstream / conflicts^) and re-run.
    popd
    exit /b 1
)

rem Post-pull SHA
for /f "delims=" %%S in ('git rev-parse HEAD 2^>nul') do set "POST_SHA=%%S"

if "!PRE_SHA!"=="!POST_SHA!" (
    echo   Already up to date ^(no new commits^).
    call :set_repo_summary "%REPO_NAME%" "!BRANCH! (up to date)"
    popd
    exit /b 0
)

echo   Updated: !PRE_SHA:~0,9! -^> !POST_SHA:~0,9!
call :set_repo_summary "%REPO_NAME%" "!BRANCH! (!PRE_SHA:~0,9!..!POST_SHA:~0,9!)"

rem -- classify the incoming diff per repo --------------------------------
if /I "%REPO_NAME%"=="PianoidCore" (
    rem CUDA-relevant: .cu .cpp .cuh .h setup.py detect_paths.py
    rem (findstr /E /L = literal end-of-line match; NO space before the pipe —
    rem a trailing space would become part of the line and defeat the match.)
    set "CC=0"
    for /f "delims=" %%F in ('git diff --name-only !PRE_SHA! !POST_SHA!') do (
        echo %%F| findstr /E /L /I ".cu .cpp .cuh .h setup.py detect_paths.py" >nul && set "CC=1"
    )
    set "CORE_CUDA_CHANGED=!CC!"
    if "!CC!"=="1" (echo   PianoidCore: compiled sources changed -^> CUDA rebuild) else (echo   PianoidCore: no compiled-source change)
)
if /I "%REPO_NAME%"=="PianoidBasic" (
    rem ANY change in PianoidBasic triggers a PianoidBasic rebuild.
    set "BASIC_CHANGED=1"
    echo   PianoidBasic: changed -^> PianoidBasic rebuild ^(+ CUDA, it is consumed by the engine^)
)
if /I "%REPO_NAME%"=="PianoidTunner" (
    rem (findstr /E /L = literal end-of-line; NO space before the pipe.)
    set "TC=0"
    for /f "delims=" %%F in ('git diff --name-only !PRE_SHA! !POST_SHA!') do (
        echo %%F| findstr /E /L /I "package.json package-lock.json" >nul && set "TC=1"
    )
    set "TUNNER_DEPS_CHANGED=!TC!"
    if "!TC!"=="1" (echo   PianoidTunner: deps changed -^> npm ci) else (echo   PianoidTunner: no dependency change ^(no npm ci^))
)

popd
exit /b 0

rem =========================================================================
rem SUBROUTINE :set_repo_summary  <display-name>  <summary-text>
rem =========================================================================
:set_repo_summary
if /I "%~1"=="PianoidCore"   set "CORE_SUMMARY=%~2"
if /I "%~1"=="PianoidBasic"  set "BASIC_SUMMARY=%~2"
if /I "%~1"=="PianoidTunner" set "TUNNER_SUMMARY=%~2"
exit /b 0

rem =========================================================================
rem SUBROUTINE :stop_backend
rem   Stop the process holding the .pyd before a CUDA rebuild.
rem   Prefer the launcher REST (no PID hunt); fall back to a PID-targeted kill
rem   of the listener on port 5000. NEVER taskkill //IM python.exe.
rem =========================================================================
:stop_backend
rem 1) Launcher REST (graceful) — only if curl is available.
where curl >nul 2>&1
if !errorlevel! equ 0 (
    echo   Asking the launcher to stop the backend ^(%LAUNCHER_URL%^) ...
    curl -s -X POST "%LAUNCHER_URL%" >nul 2>&1
    rem Give the backend a moment to release the .pyd.
    ping -n 3 127.0.0.1 >nul
)

rem 2) Fall back to a PID-targeted kill of whatever still LISTENs on 5000.
set "BACKEND_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":5000 .*LISTENING" 2^>nul') do (
    if not defined BACKEND_PID set "BACKEND_PID=%%P"
)
if defined BACKEND_PID (
    if not "!BACKEND_PID!"=="0" (
        echo   Backend still listening on 5000 ^(PID !BACKEND_PID!^) — killing that PID.
        taskkill /F /PID !BACKEND_PID! >nul 2>&1
        ping -n 2 127.0.0.1 >nul
    )
) else (
    echo   No backend listening on 5000.
)
exit /b 0

rem =========================================================================
:usage
echo Usage: update-repos.bat [--release ^| --debug ^| --both] [--help]
echo.
echo   Pulls PianoidCore, PianoidTunner, PianoidBasic on their CURRENT branch
echo   (does not switch branches), then rebuilds only what the pulls changed.
echo.
echo   --both      Build BOTH release and debug CUDA variants (DEFAULT).
echo   --release   Build only the release CUDA variant (--heavy --release).
echo   --debug     Build only the debug CUDA variant (--heavy --debug).
echo   --help, -h  Show this help and exit.
echo.
echo   Rebuild rules (BUILD_SYSTEM.md Post-Merge / Post-Pull Rebuild Gate):
echo     PianoidCore .cu/.cpp/.cuh/.h/setup.py/detect_paths.py changed -^> CUDA rebuild
echo     PianoidBasic changed -^> PianoidBasic rebuild (+ CUDA, consumed by engine)
echo     PianoidTunner package.json / package-lock.json changed -^> npm ci
echo     nothing relevant -^> skip (no-op)
echo.
echo   Before any CUDA rebuild the running backend (holding the .pyd) is stopped
echo   via the launcher REST, else a PID-targeted kill of the listener on 5000.
exit /b 0

rem =========================================================================
:error
echo.
echo =========================================================================
echo   UPDATE FAILED
echo =========================================================================
echo See error messages above for details.
echo.
exit /b 1

:end
endlocal
exit /b 0
