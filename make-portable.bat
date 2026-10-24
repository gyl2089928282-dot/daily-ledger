@echo off
setlocal
rem ============================================================
rem  make-portable.bat - bundle a node.exe into runtime\
rem  After this, the folder runs on any Windows PC even if that
rem  PC has no Node.js installed (start-silent.vbs prefers
rem  runtime\node.exe over the system one).
rem  Copying the node.exe costs about 90 MB of disk.
rem ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "DEST=%ROOT%\runtime"
set "TMPF=%TEMP%\daily-ledger-node.txt"

echo ============================================
echo   daily-ledger - make this folder portable
echo ============================================
echo.
echo   Project folder : %ROOT%
echo   Target runtime : %DEST%\node.exe
echo.

if not exist "%DEST%" mkdir "%DEST%"
if errorlevel 1 (
  echo [FAILED] Cannot create %DEST%
  pause
  exit /b 1
)

where node > "%TMPF%" 2>nul
set "NODEEXE="
if exist "%TMPF%" set /p NODEEXE=<"%TMPF%"
if exist "%TMPF%" del /F /Q "%TMPF%" >nul

if not defined NODEEXE (
  echo [FAILED] node.exe was not found on PATH.
  echo          Install Node.js 18+ from https://nodejs.org first,
  echo          then run this script again.
  pause
  exit /b 1
)

if not exist "%NODEEXE%" (
  echo [FAILED] PATH points at a node.exe that does not exist:
  echo          %NODEEXE%
  pause
  exit /b 1
)

echo   Found node    : %NODEEXE%
echo.
echo   Copying... this takes a few seconds.
copy /Y "%NODEEXE%" "%DEST%\node.exe" >nul
if errorlevel 1 (
  echo [FAILED] Copy failed.
  pause
  exit /b 1
)

if not exist "%DEST%\node.exe" (
  echo [FAILED] runtime\node.exe was not created.
  pause
  exit /b 1
)

"%DEST%\node.exe" --version
echo.
echo [OK] runtime\node.exe is in place.
echo.
echo   The folder is now portable: zip the whole daily-ledger folder
echo   and hand it to anyone. They unzip and double-click start.bat
echo   - no Node.js install needed on their machine.
echo.
echo   Note: runtime\node.exe is gitignored, it never goes into a repo.
echo   To go back to the system node, just delete runtime\node.exe.
echo.
pause
