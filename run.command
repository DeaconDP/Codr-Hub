#!/bin/bash
cd "$(dirname "$0")"
ROOT="$(pwd)"
export PATH="$ROOT/node_modules/.bin:$HOME/.nvm/versions/node/v24.14.0/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

WIN="codr-hub"
WEB_PORT=5733
SERVER_PORT=13773
URL="http://localhost:${WEB_PORT}"

fail() {
  echo
  echo "[!] $1"
  echo "Press Enter to close."
  read -r
  exit 1
}

ensure_node() {
  command -v nvm >/dev/null 2>&1 && nvm use 24 >/dev/null 2>&1 || true
  command -v node >/dev/null 2>&1 || fail "Node.js 24 is required. Install from https://nodejs.org or nvm."
  major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$major" -lt 24 ]; then
    command -v nvm >/dev/null 2>&1 && nvm use 24 >/dev/null 2>&1 || true
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  fi
  [ "$major" -ge 24 ] || fail "Node.js 24+ required (found $(node -v))."
}

ensure_vp() {
  if command -v vp >/dev/null 2>&1; then
    return 0
  fi
  echo "[*] Installing vp (Vite+)..."
  curl -fsSL https://vite.plus | bash || fail "Could not install vp. See README: curl -fsSL https://vite.plus | bash"
  export PATH="$HOME/.local/bin:$HOME/.vite-plus/bin:$PATH"
  command -v vp >/dev/null 2>&1 || fail "vp installed but is not on PATH."
}

need_install() {
  [ -d node_modules ] || return 0
  [ -x node_modules/.bin/vp ] || return 0
  if [ -f pnpm-lock.yaml ] && [ pnpm-lock.yaml -nt node_modules ]; then
    return 0
  fi
  return 1
}

port_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
}

repo_owns_port() {
  local pid cwd
  for pid in $(port_pids "$1"); do
    cwd="$(pid_cwd "$pid")"
    case "$cwd" in
      "$ROOT"|"$ROOT"/*) return 0 ;;
    esac
  done
  return 1
}

echo ""
echo "  Codr-Hub launcher"
echo "  UI:     $URL"
echo "  Server: http://127.0.0.1:${SERVER_PORT}"
echo ""

ensure_node
ensure_vp

if need_install; then
  echo "[*] Installing dependencies (vp i)..."
  vp i || fail "vp i failed."
  export PATH="$ROOT/node_modules/.bin:$PATH"
fi

if repo_owns_port "$WEB_PORT"; then
  echo "[*] Codr-Hub already running from this checkout."
  open "$URL"
  dale-tmux-close-launcher 2>/dev/null || true
  exit 0
fi

# Server is up from this checkout but the UI is not — start web only.
# Do not respawn the full stack: that would fight the live server on 13773.
if repo_owns_port "$SERVER_PORT"; then
  echo "[*] Server already on :${SERVER_PORT}; starting the web UI on :${WEB_PORT}."
  START_CMD=(npm run dev:web -- --browser)
else
  START_CMD=(npm run dev -- --browser)
fi

# Do not kill a foreign process. Fail loud so we never take down another T3.
if [ -n "$(port_pids "$WEB_PORT")" ]; then
  fail "Web port ${WEB_PORT} is in use by another process. Stop that PID, then try again."
fi
if ! repo_owns_port "$SERVER_PORT" && [ -n "$(port_pids "$SERVER_PORT")" ]; then
  fail "Server port ${SERVER_PORT} is in use by another process. Stop that PID, then try again."
fi

start_in_terminal() {
  open "$URL"
  "${START_CMD[@]}"
  status=$?
  echo
  if [ $status -ne 0 ]; then
    echo "App failed to start."
  else
    echo "App stopped."
  fi
  echo "Press Enter to close."
  read -r
  exit $status
}

# Do not set VITE_HTTP_URL / VITE_WS_URL — single-origin Vite proxies the server.
if dale-tmux-window -n "$WIN" -c "$ROOT" -- "${START_CMD[@]}"; then
  open "$URL"
  dale-tmux-close-launcher
  exit 0
fi

echo "tmux unavailable; running in this Terminal."
start_in_terminal
