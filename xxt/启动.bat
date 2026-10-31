@echo off
chcp 65001 >nul
cd /d "%~dp0"
title GitHub Downloader
node server.js
pause
