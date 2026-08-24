@echo off
REM ===========================================================================
REM  Carnival Clicker - the everyday launcher.
REM
REM  Clears anything already running first, then starts fresh and opens the
REM  game in an ordinary browser window.  Use this one unless you specifically
REM  want the fullscreen booth mode (run_kiosk.bat).
REM ===========================================================================
cd /d "%~dp0"
setlocal

REM Not just "does python.exe exist": a .venv copied from another computer
REM has the file but it points at that machine's Python and cannot run.
if not exist ".venv\Scripts\python.exe" goto firstrun
".venv\Scripts\python.exe" -c "import serial" >nul 2>nul
if not errorlevel 1 goto envready
echo The virtual environment came from another computer - rebuilding it...
rmdir /s /q ".venv"

:firstrun
echo Setting up for this computer - this takes a minute the first time.
call "run.bat" --list-ports >nul 2>nul

:envready
if not exist ".venv\Scripts\python.exe" (
  echo Setup failed. Install Python 3.9+ from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH", then run run.bat once.
  pause
  exit /b 1
)

echo Clearing any server that is already running...

call "%~dp0_clear.bat"


REM Give Windows a moment to release the port and the serial handles.
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500"

set "URL=http://127.0.0.1:8770/"

REM Open a real window rather than a tab buried in an existing browser.
where msedge >nul 2>nul
if %errorlevel%==0 (
  start "" msedge --new-window "%URL%"
) else (
  start "" "%URL%"
)

echo.
echo   Carnival Clicker   %URL%
echo   Close this window or press Ctrl+C to stop the game.
echo.

call ".venv\Scripts\activate.bat"
python server.py --no-browser %*

endlocal
