@echo off
setlocal enabledelayedexpansion

:: =============================================================================
:: PianoidCore CUDA Build Script
:: This script automatically detects system configuration and builds the package
:: =============================================================================

echo.
echo ========================================
echo PianoidCore CUDA Build Script
echo ========================================
echo.

:: Check if existing DLL files can be deleted (try deleting them directly)
echo [0/5] Checking for existing DLL files that need to be replaced...
echo.

:check_dll_deletion
set "DLL_LOCKED=0"
set "LOCKED_FILES="

if exist "pianoid_cuda\*.pyd" (
    echo Found existing DLL files. Attempting to remove them...
    for %%f in (pianoid_cuda\*.pyd) do (
        echo Trying to remove: %%f

        :: First try: simple deletion
        del /q "%%f" >nul 2>&1
        if !errorlevel! neq 0 (
            :: Second try: force deletion with attrib
            attrib -r -h -s "%%f" >nul 2>&1
            del /q /f "%%f" >nul 2>&1
            if !errorlevel! neq 0 (
                echo   FAILED - File is locked: %%f
                set "DLL_LOCKED=1"
                set "LOCKED_FILES=!LOCKED_FILES! %%f"
            ) else (
                echo   SUCCESS - Removed: %%f ^(after attrib reset^)
            )
        ) else (
            echo   SUCCESS - Removed: %%f
        )
    )
) else (
    echo No existing DLL files found.
)

:: Check if DLL files are locked and handle accordingly
if !DLL_LOCKED! equ 1 (
    echo.
    echo ========================================
    echo ERROR: DLL FILES ARE CURRENTLY IN USE
    echo ========================================
    echo.
    echo The following files could not be deleted because they are in use:
    echo !LOCKED_FILES!
    echo.
    echo This means some application is currently using the pianoid_cuda module.
    echo Common causes:
    echo 1. Python script or interactive session has imported pianoid_cuda
    echo 2. PyCharm, VS Code, or other IDE has the module loaded
    echo 3. Jupyter notebook is running with the module imported
    echo 4. Background Python process is using the module
    echo 5. Python REPL or IPython session with module imported
    echo.
    echo IMPORTANT: Close ALL Python processes, IDEs, and command prompts
    echo that might have imported pianoid_cuda at any point!
    echo.
    echo Would you like to:
    echo [R] Retry deletion after closing applications
    echo [F] Force kill Python processes and retry ^(may lose unsaved work!^)
    echo [Q] Quit to manually stop applications
    echo.
    set /p "choice=Enter your choice (R/F/Q): "

    if /i "!choice!"=="Q" (
        echo.
        echo Build cancelled. Please close applications using pianoid_cuda and run this script again.
        pause
        exit /b 1
    )

    if /i "!choice!"=="F" (
        echo.
        echo WARNING: This will forcibly terminate ALL Python processes!
        echo Press Ctrl+C now if you want to cancel.
        timeout /t 5 /nobreak
        echo.
        echo Killing Python processes...
        taskkill /f /im python.exe >nul 2>&1
        taskkill /f /im pythonw.exe >nul 2>&1
        echo Waiting for processes to terminate...
        timeout /t 2 /nobreak >nul
        goto check_dll_deletion
    )

    if /i "!choice!"=="R" (
        echo.
        echo Retrying DLL deletion...
        echo Please ensure ALL applications using pianoid_cuda are closed.
        echo Press any key when ready...
        pause >nul
        goto check_dll_deletion
    )

    echo Invalid choice. Please run the script again.
    pause
    exit /b 1
)

:: If no DLL files were locked, show success message
if !DLL_LOCKED! equ 0 (
    if exist "pianoid_cuda\*.pyd" (
        echo All existing DLL files removed successfully.
    )
)

:: Continue with main script flow

:: Check if we're in the correct directory
if not exist "pianoid_cuda" (
    echo ERROR: pianoid_cuda folder not found!
    echo Please run this script from the project root directory.
    echo Expected structure:
    echo   ProjectRoot/
    echo   ├── pianoid_cuda/        ^(should contain setup.py^)
    echo   ├── build_pianoid_cuda.bat
    echo   └── detect_paths.py
    pause
    exit /b 1
)

:: Check if Python is available
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH!
    echo Please install Python and make sure it's accessible from command line.
    pause
    exit /b 1
)

:: Check if virtual environment is activated
echo [1/5] Checking virtual environment...
python -c "import sys; print('Virtual env:', 'venv' in sys.executable.lower()); exit(0 if 'venv' in sys.executable.lower() else 1)" 2>nul
if %errorlevel% neq 0 (
    echo WARNING: Virtual environment may not be activated!
    echo.
    echo If you encounter issues, activate your virtual environment with:
    echo   .venv\Scripts\activate.bat
    echo.
    echo Continuing with build in 3 seconds...
    timeout /t 3 /nobreak >nul
    echo.
) else (
    echo Virtual environment detected.
)

:: Step 1: Run system detection
echo [2/5] Detecting system configuration...
echo.
python detect_paths.py
if %errorlevel% neq 0 (
    echo ERROR: Failed to detect system configuration!
    echo Please check that all required components are installed:
    echo - Visual Studio 2019/2022 with C++ tools
    echo - CUDA Toolkit
    echo - SDL2 library
    pause
    exit /b 1
)

:: Step 2: Move config to pianoid_cuda folder
echo.
echo [3/5] Moving configuration to pianoid_cuda folder...
if exist "build_config.json" (
    move "build_config.json" "pianoid_cuda\build_config.json"
    if %errorlevel% neq 0 (
        echo ERROR: Failed to move build_config.json to pianoid_cuda folder!
        pause
        exit /b 1
    )
    echo Configuration moved successfully.
) else (
    echo ERROR: build_config.json was not created!
    pause
    exit /b 1
)

:: Step 3: Change to pianoid_cuda directory
echo.
echo [4/5] Changing to pianoid_cuda directory...
cd pianoid_cuda
if %errorlevel% neq 0 (
    echo ERROR: Failed to change to pianoid_cuda directory!
    pause
    exit /b 1
)

:: Step 4: Build and install the package
echo.
echo [5/5] Building and installing PianoidCUDA package...
echo.
echo This may take several minutes...
echo.

:: Clean up previous build artifacts
echo Cleaning up previous build artifacts...
if exist "*.obj" (
    del /q *.obj >nul 2>&1
    if !errorlevel! neq 0 echo Warning: Some .obj files could not be deleted (may be in use)
)

if exist "build" (
    rmdir /s /q build >nul 2>&1
    if !errorlevel! neq 0 (
        echo Warning: Build directory could not be fully removed (files may be in use)
        echo Attempting to continue...
    )
)

if exist "dist" (
    rmdir /s /q dist >nul 2>&1
    if !errorlevel! neq 0 echo Warning: Dist directory could not be fully removed
)

for /d %%d in (*.egg-info) do (
    if exist "%%d" (
        rmdir /s /q "%%d" >nul 2>&1
        if !errorlevel! neq 0 echo Warning: Could not remove %%d directory
    )
)

:: Final check: ensure no .pyd files exist before build
if exist "*.pyd" (
    echo ERROR: .pyd files still exist in the build directory!
    echo This suggests the deletion was not complete.
    for %%f in (*.pyd) do echo   - %%f
    echo.
    echo Please close ALL Python processes and try again.
    pause
    exit /b 1
)

:: Note: DLL files were already removed in the initial check

:: Install the package with verbose output to show detailed compilation logs
set DISTUTILS_DEBUG=1
echo Starting pip install...
python -m pip install -e . --force-reinstall --no-deps --no-build-isolation --verbose 2>&1
set "BUILD_RESULT=%errorlevel%"

:: Check if build succeeded but final copy failed (common issue)
if !BUILD_RESULT! neq 0 (
    echo.
    echo Build process failed. Checking if it was due to file access issues...

    :: Look for newly compiled files in temp directories
    if exist "*.pyd" (
        echo.
        echo ERROR: New DLL files were created but final installation failed.
        echo This suggests the old files are still locked.
        echo.
        echo Available options:
        echo 1. Restart all Python applications and IDEs completely
        echo 2. Restart your computer to clear all file handles
        echo 3. Use a different virtual environment
        echo.
    )

    echo.
    echo ========================================
    echo BUILD FAILED!
    echo ========================================
    echo.
    echo Common solutions:
    echo 1. Make sure Visual Studio 2019/2022 is installed with C++ tools
    echo 2. Verify CUDA Toolkit is properly installed
    echo 3. Check that SDL2 library is available
    echo 4. Ensure you're running from an activated virtual environment
    echo 5. Close ALL applications using the pianoid_cuda module
    echo 6. Restart PyCharm/IDE completely (not just close files)
    echo 7. Kill all python.exe processes and try again
    echo.
    echo For detailed error information, check the output above.
    echo.
    pause
    exit /b 1
)

:: Step 5: Verify installation
echo.
echo [6/6] Verifying installation...
cd ..
python -c "import pianoid_cuda; print('Available functions:', [x for x in dir(pianoid_cuda) if not x.startswith('_')])" 2>nul
if %errorlevel% neq 0 (
    echo WARNING: Package installed but import test failed!
    echo This might be a PyCharm/IDE cache issue.
    echo Try restarting your IDE.
) else (
    echo Import test passed!
)

:: Success message
echo.
echo ========================================
echo BUILD COMPLETED SUCCESSFULLY!
echo ========================================
echo.
echo The PianoidCUDA package has been installed in development mode.
echo.
echo Next steps:
echo 1. If using PyCharm, restart it to refresh the package cache
echo 2. Test import with: python -c "import pianoid_cuda; print(dir(pianoid_cuda))"
echo 3. Check that your IDE recognizes the new package
echo.
echo Configuration file saved at: pianoid_cuda\build_config.json
echo You can edit this file to adjust paths if needed.
echo.

pause