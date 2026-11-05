@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run install_windows.bat first.
  pause
  exit /b 1
)
echo ========================================
echo Afrah Al-Watan web system
 echo Open http://127.0.0.1:8000
 echo Keep this window open while using the website.
echo ========================================
".venv\Scripts\python.exe" -m uvicorn server.main:app --host 127.0.0.1 --port 8000
pause
