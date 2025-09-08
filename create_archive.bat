@echo off
REM Batch script to create a ZIP archive from current folder

setlocal EnableDelayedExpansion

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0
set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%
for %%i in ("%SCRIPT_DIR%") do set FOLDER_NAME=%%~ni
for %%i in ("%SCRIPT_DIR%") do set PARENT_DIR=%%~dpi

REM Output file will be in parent directory with format: foldername.zip
set OUTPUT_NAME=%FOLDER_NAME%
set OUTPUT_PATH=%PARENT_DIR%%OUTPUT_NAME%.zip

echo ==========================================
echo ZIP Archive Creator
echo ==========================================
echo Script location: %SCRIPT_DIR%
echo Archive name: %OUTPUT_NAME%.zip
echo Output location: %OUTPUT_PATH%
echo.

echo Creating ZIP archive...
echo.

REM Create ZIP file using PowerShell
powershell -Command "Compress-Archive -Path '%SCRIPT_DIR%\*' -DestinationPath '%OUTPUT_PATH%' -CompressionLevel Optimal -Force"

if %errorlevel% equ 0 (
    echo.
    echo ==========================================
    echo Success!
    echo ==========================================
    echo ZIP archive created: %OUTPUT_NAME%.zip
    echo Location: %OUTPUT_PATH%
    echo.
    for %%F in ("%OUTPUT_PATH%") do echo File size: %%~zF bytes
    echo.
    echo To extract:
    echo   - Right-click the ZIP file and select "Extract All..."
    echo   - Or use: powershell -Command "Expand-Archive '%OUTPUT_PATH%' 'destination_folder'"
    echo.
) else (
    echo ERROR: Failed to create ZIP archive
    pause
    exit /b 1
)

echo ==========================================
echo Completed!
echo ==========================================

pause
exit /b 0