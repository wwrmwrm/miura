@echo off
cd /d "%~dp0"
title miura
echo Starting miura...
npm run dev
if errorlevel 1 (
  echo.
  echo Failed to start. Is Node.js installed?
  pause
)
