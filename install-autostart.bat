@echo off
setlocal
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set STUB=autostart-daily-ledger.vbs

rem Project folder = the folder this .bat lives in, without the trailing backslash.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo ============================================
echo   daily-ledger autostart installer (no window)
echo   Puts a VBS stub into your Startup folder.
echo   Effect: ~20s after login, service + watchdog
echo   start silently in background. No black box.
echo ============================================
echo.
echo   Project folder: %ROOT%
echo.

if not exist "%~dp0%STUB%" (
  echo [FAILED] %STUB% not found next to this file.
  pause
  exit /b 1
)

copy /Y "%~dp0%STUB%" "%STARTUP%\%STUB%" >nul
if errorlevel 1 (
  echo [FAILED] Copy failed. Check Startup folder permissions.
  pause
  exit /b 1
)

rem The stub runs from the Startup folder, so tell it where the project actually is.
rem Quoted so paths containing ^& or spaces survive.
> "%STARTUP%\%STUB%.path" echo "%ROOT%"

echo [OK] Installed: %STARTUP%\%STUB%
echo [OK] Path file: %STARTUP%\%STUB%.path
echo.
echo Try it now: double-click %STUB% (or start-silent.vbs).
echo To uninstall: run uninstall-autostart.bat.
echo Check status: web admin page (link on the main page).
echo.
pause
