@echo off
echo Completing the requirements installation...
cd PianoidCore
python3 -m venv .venv
call .venv\Scripts\activate.bat
venv\Scripts\python.exe -m pip install -r requirements.txt
echo.
echo Installation completed!
pause
