@echo off
rem =========================================================================
rem make-shortcut.bat - thin wrapper around make-shortcut.ps1
rem
rem Double-click this (or run it from a terminal) to drop a "Pianoid"
rem shortcut on your Desktop that launches start-pianoid.bat with the
rem no-prompt /auto flag and the Pianoid icon.
rem =========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
    echo Shortcut creation reported an error ^(exit %RC%^). See the messages above.
)
echo Press any key to exit...
pause >nul
exit /b %RC%
