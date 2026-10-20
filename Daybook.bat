@echo off
rem Start Daybook. Uses the private environment made by install.bat when it
rem exists, and falls back to whatever Python is on your PATH.
title Daybook
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" server.py %*
) else (
  where python >nul 2>&1
  if errorlevel 1 (
    echo Python was not found. Run install.bat first.
    pause
    exit /b 1
  )
  python server.py %*
)

if errorlevel 1 pause
