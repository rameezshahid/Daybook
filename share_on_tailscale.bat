@echo off
rem Starts the scanner and publishes it to your own Tailscale devices.
rem Nothing is exposed to the public internet: only machines signed in to
rem your tailnet can reach it.
cd /d "%~dp0"
set "TS=C:\Program Files\Tailscale\tailscale.exe"

if not exist "%TS%" (
  echo Tailscale is not installed at "%TS%".
  pause
  exit /b 1
)

"%TS%" status >nul 2>&1
if errorlevel 1 (
  echo.
  echo Tailscale is not signed in on this PC yet.
  echo Open the Tailscale app from the Start menu, sign in, then run this again.
  echo.
  pause
  exit /b 1
)

echo Starting the scanner...
start "Daybook" cmd /c python server.py --no-browser

echo Publishing it to your tailnet...
"%TS%" serve --bg --http=8765 http://127.0.0.1:8765
if errorlevel 1 (
  echo.
  echo Could not publish it. The scanner is still running on this PC at
  echo http://localhost:8765
  pause
  exit /b 1
)

echo.
echo Open this address on your phone or any other device signed in to your tailnet:
"%TS%" serve status
echo.
echo To stop sharing later:  tailscale serve --http=8765 off
echo.
pause
