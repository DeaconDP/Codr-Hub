@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Codr-Hub
set "ROOT=%cd%"
set "PATH=%ROOT%\node_modules\.bin;%USERPROFILE%\.local\bin;%PATH%"
set "WEB_PORT=5733"
set "SERVER_PORT=13773"
set "URL=http://localhost:%WEB_PORT%"

echo.
echo   Codr-Hub launcher
echo   UI:     %URL%
echo   Server: http://127.0.0.1:%SERVER_PORT%
echo.

where node >nul 2>&1 || (
  echo [!] Node.js 24 is required. Install from https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=v." %%a in ('node -v') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 24 (
  echo [!] Node.js 24+ required. Found:
  node -v
  pause
  exit /b 1
)

where vp >nul 2>&1
if errorlevel 1 (
  if exist "%ROOT%\node_modules\.bin\vp.cmd" goto :have_vp
  echo [*] Installing vp ^(Vite+^)...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://vite.plus/ps1 | iex"
  if errorlevel 1 (
    echo [!] Could not install vp. See README: irm https://vite.plus/ps1 ^| iex
    pause
    exit /b 1
  )
)
:have_vp

set "NEED_INSTALL=0"
if not exist "node_modules\" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\vp.cmd" if not exist "node_modules\.bin\vp" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="1" (
  echo [*] Installing dependencies ^(vp i^)...
  call vp i
  if errorlevel 1 (
    echo [!] vp i failed.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /R /C:":%WEB_PORT% .*LISTENING" >nul 2>&1
set "WEB_UP=%errorlevel%"
netstat -ano | findstr /R /C:":%SERVER_PORT% .*LISTENING" >nul 2>&1
set "SRV_UP=%errorlevel%"
if "%WEB_UP%"=="0" (
  echo [*] Port %WEB_PORT% already listening — opening the UI.
  start "" "%URL%"
  exit /b 0
)
if "%SRV_UP%"=="0" (
  echo [*] Port %SERVER_PORT% already listening — opening the UI.
  start "" "%URL%"
  exit /b 0
)

echo [*] Starting Codr-Hub...
echo     Do not set VITE_HTTP_URL or VITE_WS_URL.
echo.

start "" cmd /c "timeout /t 4 /nobreak >nul && start "" "%URL%""
call npm run dev -- --browser
if errorlevel 1 (
  echo.
  echo [!] Dev server exited with an error.
)
echo.
pause
endlocal
