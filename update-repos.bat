@echo off
setlocal enabledelayedexpansion

rem =========================================================================
rem update-repos.bat - pull latest + rebuild only what changed
rem
rem Pulls each Pianoid repo on its INTEGRATION branch (the same branch
rem check-updates.ps1 compares against), --ff-only:
rem   PianoidInstall -> master   (FIRST: it may update this script itself)
rem   PianoidCore / PianoidBasic / PianoidTunner -> dev
rem A repo checked out on another branch is SKIPPED with a warning (never
rem switched, never pulled). PianoidInstall is also skipped while it has
rem uncommitted changes to tracked files.
rem
rem Then rebuilds ONLY what the pulls changed (PROJECT_CONFIG.md rebuild
rem matrix / BUILD_SYSTEM.md "Post-Merge / Post-Pull Rebuild Gate"):
rem   - PianoidCore .cu/.cpp/.cuh/.h/setup.py/detect_paths.py/build_config.json
rem       ......................................... CUDA heavy build
rem   - PianoidBasic changed any file ............ PianoidBasic build
rem   - PianoidTunner package.json / package-lock (or no node_modules)
rem       ......................................... npm install (PianoidTunner)
rem   - PianoidInstall tools/pianoid-assistant/package.json / package-lock
rem     (or no node_modules) ..................... npm install (assistant)
rem   - pianoid_middleware/*.py only, docs, tests  no build (the middleware
rem     runs from the source tree; the CUDA build does not touch it)
rem
rem Build variant (CUDA):
rem   default     ->  build_pianoid_cuda.bat --heavy --both   (release + debug)
rem   --release   ->  build_pianoid_cuda.bat --heavy --release
rem   --debug     ->  build_pianoid_cuda.bat --heavy --debug
rem   --dry-run   ->  fetch only; print what would be pulled and rebuilt
rem   --help      ->  print usage and exit
rem
rem This script is meant to be run by a human in a foreground terminal. Before
rem any CUDA rebuild it STOPS the process holding the .pyd (a running backend),
rem otherwise the --heavy uninstall fails [WinError 5] and bricks the venv.
rem
rem Self-update: cmd.exe reads a running .bat by byte offset, so a pull that
rem rewrites this file mid-run would corrupt execution. The script therefore
rem runs from a copy in %TEMP% (the original only launches the copy, inside
rem one already-parsed block). When the PianoidInstall pull changed
rem update-repos.bat, the copy hands over to the NEW version with
rem PIANOID_UPDATE_REEXEC=1 and PIANOID_UPDATE_INSTALL_PRE=<pre-pull SHA>;
rem the new version skips the PianoidInstall pull and classifies
rem <pre-pull SHA>..HEAD instead. Keep this handover contract stable.
rem
rem See:
rem   docs/architecture/BUILD_SYSTEM.md  (Post-Merge / Post-Pull Rebuild Gate,
rem                                       Canonical Install / Rebuild)
rem   docs/guides/OPERATIONS_FOR_ASSISTANT.md (Update from git)
rem =========================================================================

rem -------------------------------------------------------------------------
rem Run from a %TEMP% copy (see "Self-update" above). The whole block is
rem parsed before it runs, so the original file is never read again once the
rem copy has started.
rem -------------------------------------------------------------------------
if not defined PIANOID_UPDATE_SELF (
    set "PIANOID_UPDATE_ROOT=%~dp0"
    set "PIANOID_UPDATE_SELF=%TEMP%\pianoid-update-repos-%RANDOM%%RANDOM%.bat"
    copy /y "%~f0" "!PIANOID_UPDATE_SELF!" >nul 2>&1
    if exist "!PIANOID_UPDATE_SELF!" (
        call "!PIANOID_UPDATE_SELF!" %*
        set "SELF_RC=!errorlevel!"
        del "!PIANOID_UPDATE_SELF!" >nul 2>&1
        exit /b !SELF_RC!
    )
    rem Copy failed: run in place, but without the PianoidInstall pull.
    set "PIANOID_UPDATE_SELF="
    set "PIANOID_UPDATE_INPLACE=1"
)

if defined PIANOID_UPDATE_INPLACE (
    set "ROOT_DIR=%~dp0"
) else (
    set "ROOT_DIR=%PIANOID_UPDATE_ROOT%"
)
set "CORE_DIR=%ROOT_DIR%PianoidCore"
set "BASIC_DIR=%ROOT_DIR%PianoidBasic"
set "TUNNER_DIR=%ROOT_DIR%PianoidTunner"
set "ASSISTANT_DIR=%ROOT_DIR%tools\pianoid-assistant"
set "LAUNCHER_URL=http://127.0.0.1:3001/api/stop-backend"
set "ORIG_ARGS=%*"

rem -------------------------------------------------------------------------
rem Parse arguments - default CUDA variant is --both (release + debug)
rem -------------------------------------------------------------------------
set "CUDA_VARIANT=both"
set "DRY_RUN=0"
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--release" set "CUDA_VARIANT=release"
if /I "%~1"=="--debug"   set "CUDA_VARIANT=debug"
if /I "%~1"=="--both"    set "CUDA_VARIANT=both"
if /I "%~1"=="--dry-run" set "DRY_RUN=1"
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
if "%DRY_RUN%"=="1" echo DRY RUN:         fetch only - nothing is pulled, built or installed
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
set "INSTALL_SUMMARY=skipped"
set "CORE_SUMMARY=skipped"
set "BASIC_SUMMARY=skipped"
set "TUNNER_SUMMARY=skipped"
set "BUILD_SUMMARY=nothing to rebuild"

rem Per-repo "what changed" flags (computed by :classify_repo via diff)
set "CORE_CUDA_CHANGED=0"
set "BASIC_CHANGED=0"
set "TUNNER_DEPS_CHANGED=0"
set "ASSISTANT_DEPS_CHANGED=0"
set "SELF_CHANGED=0"

rem -------------------------------------------------------------------------
rem STEP 1: Pull PianoidInstall first, then the three sub-repos
rem -------------------------------------------------------------------------
echo [STEP 1/3] Pulling repositories (integration branch each)...
echo =========================================================================

if defined PIANOID_UPDATE_REEXEC (
    echo.
    echo --- PianoidInstall ---
    echo   Already pulled by the previous version of update-repos.bat.
    for /f "delims=" %%S in ('git -C "%ROOT_DIR%." rev-parse HEAD 2^>nul') do set "INSTALL_POST=%%S"
    set "INSTALL_SUMMARY=master (!PIANOID_UPDATE_INSTALL_PRE:~0,9!..!INSTALL_POST:~0,9!)"
    call :classify_repo "PianoidInstall" "%ROOT_DIR%." "!PIANOID_UPDATE_INSTALL_PRE!" "!INSTALL_POST!"
) else if defined PIANOID_UPDATE_INPLACE (
    echo.
    echo --- PianoidInstall ---
    echo   WARNING: could not copy update-repos.bat to %%TEMP%% - PianoidInstall NOT pulled.
    echo   Pull it by hand: git -C "%ROOT_DIR%." pull --ff-only origin master
    set "INSTALL_SUMMARY=SKIPPED (no %%TEMP%% copy - pull by hand)"
) else (
    call :pull_repo "PianoidInstall" "%ROOT_DIR%." "master"
    if !errorlevel! neq 0 goto :error
)

rem The pull changed update-repos.bat itself -> hand over to the new version
rem and return its exit code (see "Self-update" above). Never from the new
rem version itself: its own diff still lists update-repos.bat.
if "%SELF_CHANGED%"=="1" if "%DRY_RUN%"=="0" if not defined PIANOID_UPDATE_REEXEC (
    echo.
    echo   update-repos.bat was updated by this pull - continuing with the new version...
    echo.
    set "PIANOID_UPDATE_SELF="
    set "PIANOID_UPDATE_REEXEC=1"
    set "PIANOID_UPDATE_INSTALL_PRE=!PRE_SHA!"
    call "%ROOT_DIR%update-repos.bat" %ORIG_ARGS%
    exit /b !errorlevel!
)
if "%SELF_CHANGED%"=="1" if "%DRY_RUN%"=="1" (
    echo   DRY RUN: the pull would update update-repos.bat; a real run continues with the new version.
)

call :pull_repo "PianoidCore"   "%CORE_DIR%"   "dev"
if !errorlevel! neq 0 goto :error
call :pull_repo "PianoidBasic"  "%BASIC_DIR%"  "dev"
if !errorlevel! neq 0 goto :error
call :pull_repo "PianoidTunner" "%TUNNER_DIR%" "dev"
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
set "NEED_NPM_ASSISTANT=0"

rem PianoidBasic changed -> PianoidBasic build only (the CUDA build does not
rem consume PianoidBasic).
if "%BASIC_CHANGED%"=="1" set "NEED_BASIC=1"
rem PianoidCore compiled sources changed -> CUDA rebuild.
if "%CORE_CUDA_CHANGED%"=="1" set "NEED_CUDA=1"
rem npm deps changed, or never installed -> npm install.
if "%TUNNER_DEPS_CHANGED%"=="1" set "NEED_NPM=1"
if not exist "%TUNNER_DIR%\node_modules" set "NEED_NPM=1"
if "%ASSISTANT_DEPS_CHANGED%"=="1" set "NEED_NPM_ASSISTANT=1"
if exist "%ASSISTANT_DIR%\package.json" if not exist "%ASSISTANT_DIR%\node_modules" set "NEED_NPM_ASSISTANT=1"

echo   PianoidCore CUDA sources changed : %CORE_CUDA_CHANGED%
echo   PianoidBasic changed             : %BASIC_CHANGED%
echo   PianoidTunner deps changed       : %TUNNER_DEPS_CHANGED%
echo   Assistant deps changed           : %ASSISTANT_DEPS_CHANGED%
echo.
echo   -^> Rebuild PianoidBasic        : %NEED_BASIC%
echo   -^> Rebuild CUDA                : %NEED_CUDA%
echo   -^> npm install (PianoidTunner) : %NEED_NPM%
echo   -^> npm install (assistant)     : %NEED_NPM_ASSISTANT%
echo.

if "%NEED_CUDA%%NEED_BASIC%%NEED_NPM%%NEED_NPM_ASSISTANT%"=="0000" (
    echo   Nothing relevant changed - no rebuild needed.
    set "BUILD_SUMMARY=nothing to rebuild (idempotent no-op)"
    echo.
    echo   OK  STEP 2 COMPLETED
    goto :summary
)
echo   OK  STEP 2 COMPLETED
echo.

if "%DRY_RUN%"=="1" (
    echo   DRY RUN: skipping STEP 3 ^(no backend stop, no build, no npm install^).
    set "BUILD_SUMMARY=DRY RUN - would run: Basic=%NEED_BASIC% CUDA=%NEED_CUDA% npm-Tunner=%NEED_NPM% npm-assistant=%NEED_NPM_ASSISTANT%"
    echo.
    goto :summary
)

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

rem --- PianoidBasic (before the CUDA build, as in the canonical order) ------
if "%NEED_BASIC%"=="1" (
    echo --- Building PianoidBasic ---
    if not exist "%CORE_DIR%\build_pianoid_basic.bat" (
        echo ERROR: build_pianoid_basic.bat not found in PianoidCore
        goto :error
    )
    pushd "%CORE_DIR%"
    call "%CORE_DIR%\build_pianoid_basic.bat"
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
    call "%CORE_DIR%\build_pianoid_cuda.bat" --heavy --%CUDA_VARIANT%
    set "CUDA_BUILD_EXIT=!errorlevel!"
    popd
    if not !CUDA_BUILD_EXIT! equ 0 (
        echo ERROR: PianoidCuda build failed with exit code !CUDA_BUILD_EXIT!
        echo Check %CORE_DIR%\build.log for details.
        if "!CUDA_BUILD_EXIT!"=="3221225794" (
            echo NOTE: exit 3221225794 = 0xC0000142 STATUS_DLL_INIT_FAILED.
            echo       See BUILD_SYSTEM.md "0xC0000142 Recovery" - do NOT pip install manually.
        )
        goto :error
    )
    echo   OK  PianoidCuda rebuilt [--heavy --%CUDA_VARIANT%]
    set "BUILD_SUMMARY=!BUILD_SUMMARY! PianoidCuda(--heavy --%CUDA_VARIANT%);"
    echo.
)

rem --- npm install (PianoidTunner, assistant) ---------------------------
if "%NEED_NPM%%NEED_NPM_ASSISTANT%" neq "00" (
    node --version >nul 2>&1
    if !errorlevel! neq 0 (
        echo ERROR: Node.js not found on PATH.
        goto :error
    )
)
if "%NEED_NPM%"=="1" (
    call :npm_install "PianoidTunner" "%TUNNER_DIR%"
    if !errorlevel! neq 0 goto :error
)
if "%NEED_NPM_ASSISTANT%"=="1" (
    call :npm_install "assistant" "%ASSISTANT_DIR%"
    if !errorlevel! neq 0 goto :error
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
echo   PianoidInstall : !INSTALL_SUMMARY!
echo   PianoidCore    : !CORE_SUMMARY!
echo   PianoidBasic   : !BASIC_SUMMARY!
echo   PianoidTunner  : !TUNNER_SUMMARY!
echo   Rebuilt        : !BUILD_SUMMARY!
echo.
if "%NEED_CUDA%"=="1" if "%DRY_RUN%"=="0" (
    echo   Verify the CUDA build landed in the correct venv:
    echo     PianoidCore\.venv\Scripts\python -c "import pianoidCuda; print(pianoidCuda.__file__)"
    echo   Then smoke-test: start the backend and POST /load_preset ^(expect 200^).
    echo.
)
echo To start the application:  start-pianoid.bat
echo =========================================================================
goto :end

rem =========================================================================
rem SUBROUTINE :pull_repo  <display-name>  <repo-dir>  <integration-branch>
rem   Skips (exit 0, summary SKIPPED) a repo that is not on its integration
rem   branch, and PianoidInstall while tracked files are modified. Otherwise
rem   pulls origin/<integration> --ff-only (dry run: fetches and compares),
rem   sets PRE_SHA / POST_SHA, fills the summary and calls :classify_repo.
rem   Exit 1 only on a failed pull (diverged / conflict / no remote).
rem =========================================================================
:pull_repo
set "REPO_NAME=%~1"
set "REPO_DIR=%~2"
set "INTEG=%~3"
set "BRANCH="
set "PRE_SHA="
set "POST_SHA="
echo.
echo --- %REPO_NAME% ---
pushd "%REPO_DIR%"

for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH (
    echo ERROR: could not determine current branch in %REPO_DIR%
    popd
    exit /b 1
)
echo   Branch: !BRANCH!
if /I not "!BRANCH!"=="!INTEG!" (
    echo   WARNING: %REPO_NAME% is on '!BRANCH!', not '!INTEG!' - NOT updated.
    echo            To update it: git -C "%REPO_DIR%" checkout !INTEG!   then re-run.
    call :set_repo_summary "%REPO_NAME%" "SKIPPED (on '!BRANCH!', not '!INTEG!')"
    popd
    exit /b 0
)

set "DIRTY=0"
for /f "delims=" %%L in ('git status --porcelain -uno 2^>nul') do set "DIRTY=1"
if "!DIRTY!"=="1" (
    if /I "%REPO_NAME%"=="PianoidInstall" (
        echo   WARNING: PianoidInstall has local changes - NOT updated.
        echo            See them: git -C "%REPO_DIR%" status
        call :set_repo_summary "%REPO_NAME%" "SKIPPED (local changes)"
        popd
        exit /b 0
    )
    echo   NOTE: local changes present - git refuses the pull if they overlap the update.
)

for /f "delims=" %%S in ('git rev-parse HEAD 2^>nul') do set "PRE_SHA=%%S"

if "%DRY_RUN%"=="1" (
    echo   Fetching origin/!INTEG! ^(dry run^)...
    git fetch --quiet origin !INTEG!
    for /f "delims=" %%S in ('git rev-parse origin/!INTEG! 2^>nul') do set "POST_SHA=%%S"
    if not defined POST_SHA (
        echo   ERROR: origin/!INTEG! not found for %REPO_NAME%.
        popd
        exit /b 1
    )
    git merge-base --is-ancestor !POST_SHA! !PRE_SHA! >nul 2>&1
    if !errorlevel! equ 0 set "POST_SHA=!PRE_SHA!"
    if not "!PRE_SHA!"=="!POST_SHA!" (
        git merge-base --is-ancestor !PRE_SHA! !POST_SHA! >nul 2>&1
        if !errorlevel! neq 0 (
            echo   DRY RUN: WOULD FAIL - !INTEG! has diverged from origin/!INTEG!.
            call :set_repo_summary "%REPO_NAME%" "WOULD FAIL (diverged from origin/!INTEG!)"
            popd
            exit /b 0
        )
    )
) else (
    echo   Pulling origin/!INTEG!...
    git pull --ff-only origin !INTEG!
    if !errorlevel! neq 0 (
        echo   ERROR: git pull failed for %REPO_NAME%.
        echo   Resolve manually ^(diverged branch / conflicts / no network^) and re-run.
        popd
        exit /b 1
    )
    for /f "delims=" %%S in ('git rev-parse HEAD 2^>nul') do set "POST_SHA=%%S"
)
popd

if "!PRE_SHA!"=="!POST_SHA!" (
    echo   Already up to date ^(no new commits^).
    call :set_repo_summary "%REPO_NAME%" "!BRANCH! (up to date)"
    exit /b 0
)

set "VERB=Updated"
if "%DRY_RUN%"=="1" set "VERB=DRY RUN: would update"
echo   !VERB!: !PRE_SHA:~0,9! -^> !POST_SHA:~0,9!
call :set_repo_summary "%REPO_NAME%" "!BRANCH! (!PRE_SHA:~0,9!..!POST_SHA:~0,9!)"
call :classify_repo "%REPO_NAME%" "%REPO_DIR%" "!PRE_SHA!" "!POST_SHA!"
exit /b 0

rem =========================================================================
rem SUBROUTINE :classify_repo  <display-name>  <repo-dir>  <pre-sha>  <post-sha>
rem   Sets the per-repo "what changed" flags from the diff pre..post.
rem   (findstr /E /L = literal end-of-line match; NO space before the pipe -
rem   a trailing space would become part of the line and defeat the match.)
rem =========================================================================
:classify_repo
set "C_NAME=%~1"
set "C_FLAG=0"
pushd "%~2"
if /I "%C_NAME%"=="PianoidInstall" (
    for /f "delims=" %%F in ('git diff --name-only %~3 %~4') do (
        echo %%F| findstr /X /L /I /C:"tools/pianoid-assistant/package.json" /C:"tools/pianoid-assistant/package-lock.json" >nul && set "C_FLAG=1"
        if /I "%%F"=="update-repos.bat" set "SELF_CHANGED=1"
    )
    set "ASSISTANT_DEPS_CHANGED=!C_FLAG!"
    if "!C_FLAG!"=="1" (echo   PianoidInstall: assistant deps changed -^> npm install) else (echo   PianoidInstall: no assistant dependency change)
)
if /I "%C_NAME%"=="PianoidCore" (
    for /f "delims=" %%F in ('git diff --name-only %~3 %~4') do (
        echo %%F| findstr /E /L /I ".cu .cpp .cuh .h setup.py detect_paths.py build_config.json" >nul && set "C_FLAG=1"
    )
    set "CORE_CUDA_CHANGED=!C_FLAG!"
    if "!C_FLAG!"=="1" (echo   PianoidCore: compiled sources changed -^> CUDA rebuild) else (echo   PianoidCore: no compiled-source change)
)
if /I "%C_NAME%"=="PianoidBasic" (
    rem ANY change in PianoidBasic triggers a PianoidBasic rebuild.
    set "BASIC_CHANGED=1"
    echo   PianoidBasic: changed -^> PianoidBasic rebuild
)
if /I "%C_NAME%"=="PianoidTunner" (
    for /f "delims=" %%F in ('git diff --name-only %~3 %~4') do (
        echo %%F| findstr /E /L /I "package.json package-lock.json" >nul && set "C_FLAG=1"
    )
    set "TUNNER_DEPS_CHANGED=!C_FLAG!"
    if "!C_FLAG!"=="1" (echo   PianoidTunner: deps changed -^> npm install) else (echo   PianoidTunner: no dependency change)
)
popd
exit /b 0

rem =========================================================================
rem SUBROUTINE :set_repo_summary  <display-name>  <summary-text>
rem =========================================================================
:set_repo_summary
if /I "%~1"=="PianoidInstall" set "INSTALL_SUMMARY=%~2"
if /I "%~1"=="PianoidCore"    set "CORE_SUMMARY=%~2"
if /I "%~1"=="PianoidBasic"   set "BASIC_SUMMARY=%~2"
if /I "%~1"=="PianoidTunner"  set "TUNNER_SUMMARY=%~2"
exit /b 0

rem =========================================================================
rem SUBROUTINE :npm_install  <label>  <dir>
rem   npm is npm.cmd: without CALL, control would never return here.
rem =========================================================================
:npm_install
echo --- Installing %~1 dependencies [npm install] ---
pushd "%~2"
call npm install
set "NPM_EXIT=!errorlevel!"
popd
if not !NPM_EXIT! equ 0 (
    echo ERROR: npm install failed for %~1 with exit code !NPM_EXIT!
    exit /b 1
)
echo   OK  %~1 dependencies installed
set "BUILD_SUMMARY=!BUILD_SUMMARY! npm install(%~1);"
echo.
exit /b 0

rem =========================================================================
rem SUBROUTINE :stop_backend
rem   Stop the process holding the .pyd before a CUDA rebuild.
rem   Prefer the launcher REST (no PID hunt); fall back to a PID-targeted kill
rem   of the listener on port 5000. NEVER taskkill //IM python.exe.
rem =========================================================================
:stop_backend
rem 1) Launcher REST (graceful) - only if curl is available.
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
        echo   Backend still listening on 5000 ^(PID !BACKEND_PID!^) - killing that PID.
        taskkill /F /PID !BACKEND_PID! >nul 2>&1
        ping -n 2 127.0.0.1 >nul
    )
) else (
    echo   No backend listening on 5000.
)
exit /b 0

rem =========================================================================
:usage
echo Usage: update-repos.bat [--release ^| --debug ^| --both] [--dry-run] [--help]
echo.
echo   Pulls PianoidInstall (master) first, then PianoidCore, PianoidBasic,
echo   PianoidTunner (dev), --ff-only, and rebuilds only what the pulls changed.
echo   A repo on another branch is skipped with a warning (never switched);
echo   PianoidInstall is also skipped while tracked files are modified.
echo.
echo   --both      Build BOTH release and debug CUDA variants (DEFAULT).
echo   --release   Build only the release CUDA variant (--heavy --release).
echo   --debug     Build only the debug CUDA variant (--heavy --debug).
echo   --dry-run   Fetch only: print what would be pulled and rebuilt.
echo   --help, -h  Show this help and exit.
echo.
echo   Rebuild rules (BUILD_SYSTEM.md Post-Merge / Post-Pull Rebuild Gate):
echo     PianoidCore .cu/.cpp/.cuh/.h/setup.py/detect_paths.py/build_config.json -^> CUDA heavy build
echo     PianoidBasic changed -^> PianoidBasic build
echo     PianoidTunner package.json / package-lock.json -^> npm install
echo     tools/pianoid-assistant package.json / package-lock.json -^> npm install there
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
