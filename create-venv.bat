@echo off
REM Script to create Python virtual environment and install requirements

setlocal EnableDelayedExpansion

REM Configuration
set PROJECT_DIR=PianoidCore
set VENV_NAME=venv
set REQUIREMENTS_FILE=requirements.txt

echo ==========================================
echo Python Virtual Environment Setup
echo ==========================================
echo Project directory: %PROJECT_DIR%
echo Virtual environment: %VENV_NAME%
echo Requirements file: %REQUIREMENTS_FILE%
echo.

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python first and make sure it's added to PATH
    pause
    exit /b 1
)

REM Display Python version
for /f "delims=" %%i in ('python --version 2^>^&1') do echo Found: %%i

REM Check if project directory exists
if not exist "%PROJECT_DIR%" (
    echo ERROR: Project directory '%PROJECT_DIR%' not found
    echo Please make sure the PianoidCore folder exists in the current directory
    pause
    exit /b 1
)

REM Check if requirements.txt exists
if not exist "%PROJECT_DIR%\%REQUIREMENTS_FILE%" (
    echo ERROR: Requirements file '%PROJECT_DIR%\%REQUIREMENTS_FILE%' not found
    echo Please make sure requirements.txt exists in the PianoidCore folder
    pause
    exit /b 1
)

echo.
echo Step 1: Creating virtual environment...
echo.

REM Navigate to project directory
cd /d "%PROJECT_DIR%"

REM Remove existing virtual environment if it exists
if exist "%VENV_NAME%" (
    echo Removing existing virtual environment...
    rmdir /s /q "%VENV_NAME%"
)

REM Create new virtual environment
python -m venv "%VENV_NAME%"

if %errorlevel% neq 0 (
    echo ERROR: Failed to create virtual environment
    pause
    exit /b 1
)

echo Virtual environment created successfully!
echo.

echo Step 2: Activating virtual environment...
echo.

REM Activate virtual environment
call "%VENV_NAME%\Scripts\activate.bat"

if %errorlevel% neq 0 (
    echo ERROR: Failed to activate virtual environment
    pause
    exit /b 1
)

echo Virtual environment activated!
echo.

echo Step 3: Upgrading pip...
echo.

REM Upgrade pip to latest version
python -m pip install --upgrade pip

if %errorlevel% neq 0 (
    echo WARNING: Failed to upgrade pip, continuing anyway...
)

echo.
echo Step 4: Installing requirements...
echo.

REM Install requirements from requirements.txt
pip install -r "%REQUIREMENTS_FILE%"

if %errorlevel% neq 0 (
    echo ERROR: Failed to install requirements
    echo Check the requirements.txt file for any issues
    pause
    exit /b 1
)

echo.
echo ==========================================
echo Setup completed successfully!
echo ==========================================
echo.
echo Virtual environment details:
echo   Location: %CD%\%VENV_NAME%
echo   Python version: 
python --version
echo   Pip version: 
pip --version
echo.
echo Installed packages:
pip list
echo.
echo ==========================================
echo Virtual Environment is now ACTIVE
echo ==========================================
echo.
echo To deactivate later, run: deactivate
echo To activate again, run: %CD%\%VENV_NAME%\Scripts\activate.bat
echo.
echo You can now run your Python scripts in this environment.
echo The command prompt will remain open with the virtual environment active.
echo.

REM Keep the command prompt open with virtual environment active
cmd /k