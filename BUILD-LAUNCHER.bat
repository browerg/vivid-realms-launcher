@echo off
setlocal
title Build Vivid Realms Launcher

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to build the launcher.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

cd /d "%~dp0"
echo Installing launcher build dependencies...
call npm.cmd install
if errorlevel 1 goto :fail

echo.
echo Building Windows installer...
call npm.cmd run dist
if errorlevel 1 goto :fail

echo.
echo Build complete:
echo %~dp0dist
pause
exit /b 0

:fail
echo.
echo Launcher build failed.
pause
exit /b 1
