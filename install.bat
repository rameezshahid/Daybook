@echo off
setlocal
title Daybook setup
cd /d "%~dp0"

echo.
echo   Daybook setup
echo   =============
echo.

rem ---- 1. Python -----------------------------------------------------------
where python >nul 2>&1
if errorlevel 1 (
  echo   Python is not installed, or it is not on your PATH.
  echo.
  echo   Install Python 3.10 or newer from https://www.python.org/downloads/
  echo   On the first screen of the installer, tick "Add python.exe to PATH".
  echo   Then run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo   Found Python %PYVER%

rem ---- 2. Virtual environment ----------------------------------------------
if not exist ".venv\Scripts\python.exe" (
  echo   Creating a private Python environment in .venv ...
  python -m venv .venv
  if errorlevel 1 (
    echo   Could not create the environment. Is Python installed correctly?
    pause
    exit /b 1
  )
)

rem ---- 3. Dependencies ------------------------------------------------------
echo   Installing the one dependency ^(yfinance^). This can take a minute...
".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
if errorlevel 1 (
  echo   Installing dependencies failed. Check your internet connection and try again.
  pause
  exit /b 1
)

rem ---- 4. Desktop shortcut --------------------------------------------------
echo   Putting a Daybook shortcut on your desktop...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Daybook.lnk');" ^
  "$s.TargetPath='%~dp0Daybook.bat'; $s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%~dp0static\daybook.ico'; $s.Description='Momentum scanner and trade journal'; $s.Save()" >nul 2>&1

echo.
echo   Done. Start Daybook from the desktop shortcut, or by running Daybook.bat
echo   in this folder. It opens at http://localhost:8765
echo.
pause
