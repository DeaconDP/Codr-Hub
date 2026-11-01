@echo off
rem Codr-Hub launcher for Windows. Double-click it. Starts server + web on the
rem sticky ports and lets the server open its one-time pairing URL, so a new
rem browser is signed in.
setlocal EnableExtensions
cd /d "%~dp0"
title Codr-Hub
set "ROOT=%cd%"
set "PATH=%ROOT%\node_modules\.bin;%USERPROFILE%\.local\bin;%USERPROFILE%\.vite-plus\bin;%PATH%"
set "WEB_PORT=5733"
set "SERVER_PORT=13773"
set "URL=http://localhost:%WEB_PORT%"

echo.
echo   Codr-Hub launcher
echo   UI:     %URL%
echo   Server: http://127.0.0.1:%SERVER_PORT%
echo.

where node >nul 2>&1 || (
  echo [!] Node.js 24 is required. Install it from https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 24 (
  echo [!] Node.js 24+ is required. Install it from https://nodejs.org. Found:
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
    echo [!] Could not install vp. Run in PowerShell: irm https://vite.plus/ps1 ^| iex
    pause
    exit /b 1
  )
  where vp >nul 2>&1 || (
    echo [!] vp installed but is not on PATH. Open a new window and try again.
    pause
    exit /b 1
  )
)
:have_vp

set "NEED_INSTALL=0"
if not exist "node_modules\" set "NEED_INSTALL=1"
if not exist "node_modules\.bin\vp.cmd" if not exist "node_modules\.bin\vp" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="0" if exist "pnpm-lock.yaml" (
  powershell.exe -NoProfile -Command "if ((Get-Item 'pnpm-lock.yaml').LastWriteTime -gt (Get-Item 'node_modules').LastWriteTime) { exit 0 } else { exit 1 }"
  if not errorlevel 1 set "NEED_INSTALL=1"
)
if "%NEED_INSTALL%"=="1" (
  echo [*] Installing dependencies ^(vp i^)...
  call vp i
  if errorlevel 1 (
    echo [!] vp i failed.
    pause
    exit /b 1
  )
  rem vp i leaves node_modules' mtime alone when nothing changed; mark it fresh.
  powershell.exe -NoProfile -Command "(Get-Item 'node_modules').LastWriteTime = Get-Date"
)

call :port_state %WEB_PORT%
set "WEB_STATE=%errorlevel%"
call :port_state %SERVER_PORT%
set "SRV_STATE=%errorlevel%"

rem 0 = owned by this checkout, 1 = free, 2 = another process.
rem A browser that already signed in here keeps its session cookie, so the
rem bare origin is enough.
if "%WEB_STATE%"=="0" (
  echo [*] Codr-Hub already running from this checkout.
  echo     If the page asks you to pair, use the Pairing URL in the Codr-Hub
  echo     window, or close it and run this launcher again.
  start "" "%URL%"
  exit /b 0
)
if "%WEB_STATE%"=="2" (
  echo [!] Web port %WEB_PORT% is in use by another process. Stop it, then try again.
  pause
  exit /b 1
)
if "%SRV_STATE%"=="2" (
  echo [!] Server port %SERVER_PORT% is in use by another process. Stop it, then try again.
  pause
  exit /b 1
)

echo [*] Starting Codr-Hub...
echo.
rem Do not set VITE_HTTP_URL or VITE_WS_URL. Single-origin Vite proxies the server.
if "%SRV_STATE%"=="0" (
  rem Server already up from this checkout: start web only, then open the UI.
  start "" cmd /c "timeout /t 4 /nobreak >nul && start "" "%URL%""
  call npm run dev:web
) else (
  rem --browser: the server opens its startup pairing URL once it is ready.
  rem Same data directory as the fleet parent (npm run codr:always-on).
  call npm run dev -- --browser --home-dir "%ROOT%\.t3"
)
if errorlevel 1 (
  echo.
  echo [!] Dev server exited with an error.
)
echo.
pause
endlocal
exit /b 0

rem Exit 0 when a process from this checkout (or one of its parents) listens
rem on the port, 1 when nothing listens, 2 when someone else does.
:port_state
set "CH_PORT=%~1"
powershell.exe -NoProfile -Command ^
  "$c = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:CH_PORT) -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "if (-not $c) { exit 1 };" ^
  "$root = $env:ROOT.ToLower(); $id = $c.OwningProcess;" ^
  "for ($i = 0; $i -lt 8 -and $id; $i++) {" ^
  "  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id);" ^
  "  if (-not $p) { break };" ^
  "  if (('' + $p.CommandLine + ' ' + $p.ExecutablePath).ToLower().Contains($root)) { exit 0 };" ^
  "  $id = $p.ParentProcessId" ^
  "};" ^
  "Write-Host ('    Port ' + $env:CH_PORT + ' is held by PID ' + $c.OwningProcess + ', not this checkout.'); exit 2"
exit /b %errorlevel%
