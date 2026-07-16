@echo off
setlocal
title miura loader
cd /d "%~dp0"

:: Prefer PowerShell 7 if present, else Windows PowerShell
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0miura-loader.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0miura-loader.ps1" %*
)

endlocal
