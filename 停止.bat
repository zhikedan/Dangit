@echo off
rem ---------------------------------------------------------------------------
rem  Stops the hidden server started by the start script
rem  (ports 5210-5219 on localhost) and shuts down the local accelerator.
rem ---------------------------------------------------------------------------
setlocal enabledelayedexpansion
set KILLED=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r "127.0.0.1:521[0-9] " ^| findstr LISTENING') do (
  taskkill /f /pid %%a >nul 2>nul
  if not errorlevel 1 set KILLED=1
)

if exist "netlayer\shutdown.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0netlayer\shutdown.ps1" >nul 2>&1

if "%KILLED%"=="1" (
  echo Server stopped.
) else (
  echo No server was running on ports 5210-5219.
)
timeout /t 2 /nobreak >nul
exit
