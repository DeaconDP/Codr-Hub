@echo off
rem One-click setup and run for T3 Code dev (server + web). Double-click or run from a terminal.
cd /d "%~dp0"

where node >nul 2>&1 || (echo Node.js 24 is required: https://nodejs.org & pause & exit /b 1)

set "PATH=%USERPROFILE%\.vite-plus\bin;%PATH%"
where vp >nul 2>&1 || (
  echo Installing Vite+ ^(vp^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://vite.plus/ps1 | iex" || (echo Failed to install vp. & pause & exit /b 1)
)

if not exist node_modules (
  echo Installing dependencies...
  call vp i || (echo Dependency install failed. & pause & exit /b 1)
)

rem dev-runner picks the ports and opens the right URL itself.
rem State goes in this checkout's gitignored .t3, never the live ~/.t3 install.
call vp run dev --browser --home-dir "%~dp0.t3"
if errorlevel 1 (echo Dev server exited with an error. & pause & exit /b 1)
