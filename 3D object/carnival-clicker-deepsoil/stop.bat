@echo off

REM Stop the Carnival Clicker server, closing the serial ports properly.

cd /d "%~dp0"

call "%~dp0_clear.bat"

echo.

echo Stopped. If a controller still will not reconnect, tap the EN/reset

echo button on the board - that clears a stale Bluetooth session.

