@echo off
REM Stop any Carnival Clicker server, cleanly.
REM Closing the port properly matters: an ESP32 accepts one Bluetooth client at
REM a time, and a server killed mid-connection leaves the board believing the
REM session is still open. It then refuses to reconnect until you reset it.
cd /d "%~dp0"
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name like '%%python%%'\" | Where-Object { $_.CommandLine -match 'server\.py' } | ForEach-Object { Write-Host ('stopping ' + $_.ProcessId); Stop-Process -Id $_.ProcessId }"
echo.
echo If a controller will not reconnect afterwards, tap the EN/reset button
echo on the board - that clears a stale Bluetooth session.
