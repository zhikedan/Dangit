@echo off
rem ---------------------------------------------------------------------------
rem  Double-click this file. It hands off to launch.js and closes immediately,
rem  so no black console window stays on screen. The server keeps running in the
rem  background and writes its output to data\server.log.
rem  Use the stop script to shut it down.
rem
rem  A local accelerator (netlayer) is started first, silently. It is torn down
rem  by the stop script together with the server.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ not found. Install from https://nodejs.org and run again.
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

if exist "netlayer\bootstrap.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0netlayer\bootstrap.ps1" >nul 2>&1

node "launch.js" >nul 2>nul
exit
