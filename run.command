#!/bin/bash
# One-click setup and run for T3 Code desktop dev on macOS. Double-click in Finder.
cd "$(dirname "$0")" || exit 1

pause_exit() { echo "$1"; read -n 1 -s -r -p "Press any key to close..."; exit 1; }

command -v node >/dev/null || pause_exit "Node.js 24 is required: https://nodejs.org"

export PATH="$HOME/.vite-plus/bin:$PATH"
if ! command -v vp >/dev/null; then
  echo "Installing Vite+ (vp)..."
  curl -fsSL https://vite.plus | bash || pause_exit "Failed to install vp."
fi
command -v vp >/dev/null || pause_exit "vp installed but not found on PATH. Open a new terminal and run run.command again."

# Always install: a no-op when up to date, and picks up changes after a pull.
echo "Installing dependencies..."
vp i || pause_exit "Dependency install failed."

# State goes in this checkout's gitignored .t3, never the live ~/.t3 install.
vp run dev:desktop --home-dir "$PWD/.t3" || pause_exit "Dev app exited with an error."
