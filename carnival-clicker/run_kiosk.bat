@echo off
REM ===========================================================================
REM  Carnival Clicker - event mode.  Fullscreen Edge, no browser chrome.
REM  Clears any server already running first, so a stale one cannot serve an
REM  old build or sit on the controller port.
REM  Alt+F4 closes the kiosk, then Ctrl+C in this window stops the game.
REM ===========================================================================
cd /d "%~dp0"
setlocal

if not exist ".venv\Scripts\python.exe" (
  echo Run run.bat once first to set things up.
  pause
  exit /b 1
)

echo Clearing any server that is already running...
powershell -NoProfile -Command ^
  "$p = Get-CimInstance Win32_Process -Filter \"Name like '%%python%%'\" | Where-Object { $_.CommandLine -match 'server\.py' }; if ($p) { $p | ForEach-Object { Write-Host ('  stopped PID ' + $_.ProcessId); try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} } } else { Write-Host '  nothing was running' }"
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500"

call ".venv\Scripts\activate.bat"

start "" msedge --kiosk "http://127.0.0.1:8770/" --edge-kiosk-type=fullscreen ^
  --no-first-run --disable-features=TranslateUI --overscroll-history-navigation=0

python server.py --no-browser %*

endlocal
