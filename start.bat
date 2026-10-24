@echo off
rem Double-click = start the service silently in background (no console window).
rem Check status: open the web admin page, or use Task Manager (look for node.exe).
rem To stop: double-click stop-silent.vbs.
cd /d "%~dp0"
if not exist "start-silent.vbs" (
  echo [daily-ledger] start-silent.vbs not found
  pause
  exit /b 1
)
wscript.exe "%~dp0start-silent.vbs"
