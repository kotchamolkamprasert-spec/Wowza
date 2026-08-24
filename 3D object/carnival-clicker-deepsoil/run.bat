@echo off
REM Carnival Clicker - normal windowed run, for setting up and testing.
cd /d "%~dp0"

REM A .venv copied from another computer still contains python.exe, but that
REM exe points at the Python install path of the machine it was built on and
REM cannot run here. Test it rather than trusting the file to exist.
if not exist ".venv\Scripts\python.exe" goto setup
".venv\Scripts\python.exe" -c "import serial" >nul 2>nul
if not errorlevel 1 goto haveenv
echo The bundled virtual environment was built on another computer - rebuilding...
rmdir /s /q ".venv"

:setup
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
echo Creating virtual environment...
%PY% -m venv .venv || goto fail
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt || goto fail
goto run

:haveenv
call ".venv\Scripts\activate.bat"

:run
python server.py %*
goto :eof

:fail
echo.
echo Setup failed. Install Python 3.9+ from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH".
pause
