@echo off
echo Completing the requirements installation...
cd PianoidCore
python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo.
echo Installation completed!
pause
