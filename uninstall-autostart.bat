@echo off
setlocal
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set STUB=autostart-daily-ledger.vbs

if exist "%STARTUP%\%STUB%" (
  del /F /Q "%STARTUP%\%STUB%" && echo [OK] Removed autostart: %STARTUP%\%STUB%
) else (
  echo [INFO] %STUB% not found in Startup folder. Maybe already removed.
)

if exist "%STARTUP%\%STUB%.path" (
  del /F /Q "%STARTUP%\%STUB%.path" && echo [OK] Removed path file: %STARTUP%\%STUB%.path
)

echo.
echo Note: a running daily-ledger is not stopped by this script.
echo To stop it, double-click stop-silent.vbs.
pause
