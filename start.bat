@echo off
setlocal
cd /d "%~dp0"

rem Some hosts (WorkBuddy, IDE terminals) inject ELECTRON_RUN_AS_NODE,
rem which turns electron.exe into a plain node process and fails with "app is undefined".
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo [1/2] Installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check Node.js and network.
    pause
    exit /b 1
  )
)

if not exist "%ELECTRON%" (
  echo.
  echo [ERROR] electron.exe not found:
  echo   %ELECTRON%
  echo Run "npm install" in this folder and try again.
  pause
  exit /b 1
)

echo [2/2] Starting desktop sticky notes...
start "" "%ELECTRON%" .

rem wait ~2s, then make sure it is really running (a silent crash would look like "nothing happened")
ping -n 3 127.0.0.1 >nul
tasklist /fi "imagename eq electron.exe" /nh | findstr /i "electron.exe" >nul
if errorlevel 1 (
  echo.
  echo [ERROR] Electron did not stay running. Showing its output:
  echo.
  "%ELECTRON%" .
  echo.
  echo Exit code: %errorlevel%
  pause
)
