@echo off
REM ===========================================================================
REM  67 Speed (Warm Paper) - quick preview launcher.
REM
REM  DOUBLE-CLICKING index.html DOES NOT WORK. Over file:// the browser refuses
REM  to load ES modules, so the voxel tree never starts and you get the old flat
REM  SVG tree instead. It has to be served over http.
REM
REM  http://127.0.0.1 counts as a secure context, so the webcam works here too -
REM  this runs the whole booth, not just the layout.
REM
REM  For the real event use booth-server.ps1 instead (port 8000): it also serves
REM  config.js and keeps the shared leaderboard. This script is just for looking.
REM ===========================================================================
cd /d "%~dp0"
setlocal

set "PORT=8795"
set "URL=http://127.0.0.1:%PORT%/index.html"

REM --- find a python -------------------------------------------------------
REM  && rather than %errorlevel%: inside a parenthesised block cmd expands
REM  %errorlevel% when it PARSES the block, not when it runs.
set "PY="
if exist "%~dp0..\..\carnival-clicker\.venv\Scripts\python.exe" set "PY=%~dp0..\..\carnival-clicker\.venv\Scripts\python.exe"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY (
  echo.
  echo   No Python found.
  echo   Install Python 3.9+ from https://www.python.org/downloads/ and tick
  echo   "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

REM --- free the port if a previous preview is still holding it -------------
powershell -NoProfile -Command ^
  "$p = Get-CimInstance Win32_Process -Filter \"Name like '%%python%%'\" | Where-Object { $_.CommandLine -match 'http\.server\s+%PORT%' }; if ($p) { $p | ForEach-Object { Write-Host ('  stopping old preview, PID ' + $_.ProcessId); try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 900 }"

start "" "%URL%"

echo.
echo   67 Speed - Warm Paper    %URL%
echo.
echo   The voxel island grows as reps are counted. If you see the old flat
echo   SVG tree instead, the 3D module failed - check the browser console.
echo.
echo   Close this window or press Ctrl+C to stop.
echo.

"%PY%" -m http.server %PORT% --bind 127.0.0.1

endlocal
