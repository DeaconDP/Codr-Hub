@echo off
rem One-click setup and run for T3 Code dev (server + web). Double-click or run from a terminal.
cd /d "%~dp0"

where node >nul 2>&1 || (echo Node.js 24 is required: https://nodejs.org & pause & exit /b 1)

rem The installer uses %LOCALAPPDATA%\vite-plus\bin, or the legacy %USERPROFILE%\.vite-plus\bin if present.
rem It only updates the user PATH, which this window never sees, so add both here.
set "PATH=%LOCALAPPDATA%\vite-plus\bin;%USERPROFILE%\.vite-plus\bin;%PATH%"
where vp >nul 2>&1 || (
  echo Installing Vite+ ^(vp^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://vite.plus/ps1 | iex" || (echo Failed to install vp. & pause & exit /b 1)
)
where vp >nul 2>&1 || (echo vp installed but not found on PATH. Open a new terminal and run run.bat again. & pause & exit /b 1)

rem Always install: a no-op when up to date, and picks up changes after a pull.
echo Installing dependencies...
call vp i || (echo Dependency install failed. & pause & exit /b 1)

rem Opens the T3 Code desktop (Electron) app; it builds and runs the server itself.
rem State goes in this checkout's gitignored .t3, never the live ~/.t3 install.
call vp run dev:desktop --home-dir "%~dp0.t3"
if errorlevel 1 (echo Dev server exited with an error. & pause & exit /b 1)
