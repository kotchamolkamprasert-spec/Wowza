@echo off
REM ===========================================================================
REM  Shared by play.bat / run_kiosk.bat / stop.bat.
REM
REM  Asks any running server to shut down properly first.  That closes the
REM  serial ports, which is what stops an ESP32 believing its Bluetooth session
REM  is still open - a board in that state refuses to reconnect until it is
REM  reset by hand.  Only if it will not answer do we resort to killing it.
REM ===========================================================================
powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8770/api/shutdown' -Method POST -Body '{}' -ContentType 'application/json' -TimeoutSec 4 -UseBasicParsing | Out-Null; Write-Host '  asked the running game to stop'; Start-Sleep -Milliseconds 1600 } catch { }; $p = Get-CimInstance Win32_Process -Filter \"Name like '%%python%%'\" | Where-Object { $_.CommandLine -match 'server\.py' }; if ($p) { $p | ForEach-Object { Write-Host ('  force stopping PID ' + $_.ProcessId); try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 1200 } else { Write-Host '  port is clear' }"
