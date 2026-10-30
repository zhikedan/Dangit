@echo off
setlocal
cd /d "%~dp0"
title GitHub Trending Report - Web

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ not found. Install from https://nodejs.org and run again.
  pause
  exit /b 1
)

node server.js

pause
