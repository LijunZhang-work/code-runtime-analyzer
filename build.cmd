@echo off
setlocal
set "CRA_TARGET=%~1"
if "%CRA_TARGET%"=="" set "CRA_TARGET=all"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" "%CRA_TARGET%"
set "CRA_EXIT=%ERRORLEVEL%"
echo.
if not "%CRA_EXIT%"=="0" echo Build failed. Read the message above for the missing tool or failed step.
pause
exit /b %CRA_EXIT%
