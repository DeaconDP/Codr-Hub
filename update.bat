@echo off
rem Update this checkout. "update.bat --schedule" registers a nightly 00:00 run in Task Scheduler.
cd /d "%~dp0"
if "%~1"=="--schedule" (schtasks /create /f /sc daily /st 00:00 /tn "Codr-Hub update" /tr "\"%~f0\"" & exit /b)

rem Fast-forward from origin, then merge upstream T3 if it merges cleanly.
rem Offline, diverged, or conflicting updates are skipped and the app starts as-is.
echo Checking for updates...
git pull --ff-only -q 2>nul || echo Skipped origin update.
git fetch -q upstream 2>nul && (git merge --no-edit -q upstream/main 2>nul || (git merge --abort 2>nul & echo Skipped upstream update: merge needs a hand, run "vp run sync:t3".))
