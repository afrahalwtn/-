@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Please install Python 3.11+ from python.org and enable the Python launcher.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
if errorlevel 1 (echo Failed to create Python environment & pause & exit /b 1)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (echo Failed to install dependencies & pause & exit /b 1)
".venv\Scripts\python.exe" scripts\create_admin.py
if errorlevel 1 (echo Failed to configure administrator & pause & exit /b 1)
echo Setup completed. Run start_windows.bat
pause
