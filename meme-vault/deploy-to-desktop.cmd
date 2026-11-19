@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-desktop.ps1"
if errorlevel 1 (
  echo.
  echo Deploy failed. Check that F: is available and the app is not running.
  pause
  exit /b 1
)
echo.
pause
