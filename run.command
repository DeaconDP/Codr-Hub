#!/usr/bin/env bash
# Codr-Hub launcher for macOS and Linux. Double-click it in Finder, or run
# `./run.command` from a terminal. Starts server + web on the sticky ports and
# lets the server open its one-time pairing URL, so a new browser is signed in.
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
export PATH="$ROOT/node_modules/.bin:$HOME/.local/bin:$HOME/.vite-plus/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
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

open_url() {
  if [ "$(uname -s)" = "Darwin" ]; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1
  else
    echo "[*] Open $1 in your browser."
  fi
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

# nvm if present, otherwise whatever node is on PATH.
ensure_node() {
  if command -v nvm >/dev/null 2>&1; then
    nvm use 24 >/dev/null 2>&1 || nvm install 24 || true
  fi
  command -v node >/dev/null 2>&1 \
    || fail "Node.js 24 is required. Install it from https://nodejs.org, or with nvm: nvm install 24"
  [ "$(node_major)" -ge 24 ] \
    || fail "Node.js 24+ is required (found $(node -v)). Install it from https://nodejs.org, or with nvm: nvm install 24"
}

ensure_vp() {
  command -v vp >/dev/null 2>&1 && return 0
  echo "[*] Installing vp (Vite+)..."
  curl -fsSL https://vite.plus | bash || fail "Could not install vp. Run: curl -fsSL https://vite.plus | bash"
  command -v vp >/dev/null 2>&1 || fail "vp installed but is not on PATH. Open a new terminal and try again."
}

need_install() {
  [ -d node_modules ] || return 0
  [ -x node_modules/.bin/vp ] || return 0
  [ -f pnpm-lock.yaml ] && [ pnpm-lock.yaml -nt node_modules ] && return 0
  return 1
}

port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -H -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}

pid_cwd() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
  fi
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

# Something listens but we cannot see its PID (e.g. ss without permission).
port_busy() {
  [ -n "$(port_pids "$1")" ] && return 0
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
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
  # vp i leaves node_modules' mtime alone when nothing changed; mark it fresh.
  touch node_modules
fi

# A browser that already signed in here keeps its session cookie, so the bare
# origin is enough. A new browser needs the pairing URL from the first start.
if repo_owns_port "$WEB_PORT"; then
  echo "[*] Codr-Hub already running from this checkout."
  echo "    If the page asks you to pair, use the Pairing URL in the Codr-Hub"
  echo "    terminal window, or quit it (Ctrl+C) and run this launcher again."
  open_url "$URL"
  dale-tmux-close-launcher 2>/dev/null || true
  exit 0
fi

# Server is up from this checkout but the UI is not: start web only. Do not
# respawn the full stack, that would fight the live server. The server already
# opened its pairing URL when it started, so open the bare origin ourselves.
if repo_owns_port "$SERVER_PORT"; then
  echo "[*] Server already on :${SERVER_PORT}; starting the web UI on :${WEB_PORT}."
  START_CMD=(npm run dev:web)
  OPEN_LATER=1
else
  # --browser: the server opens its startup pairing URL once it is ready.
  # Same data directory as the fleet parent (npm run codr:always-on).
  START_CMD=(npm run dev -- --browser --home-dir "$ROOT/.t3")
  OPEN_LATER=0
fi

# Never kill or reuse a foreign process. Fail loud so we never take down
# another T3 Code, and never sign this browser into someone else's server.
if port_busy "$WEB_PORT"; then
  fail "Web port ${WEB_PORT} is in use by another process (PID: $(port_pids "$WEB_PORT" | tr '\n' ' ')). Stop it, then try again."
fi
if ! repo_owns_port "$SERVER_PORT" && port_busy "$SERVER_PORT"; then
  fail "Server port ${SERVER_PORT} is in use by another process (PID: $(port_pids "$SERVER_PORT" | tr '\n' ' ')). Stop it, then try again."
fi

[ "$OPEN_LATER" = 1 ] && (sleep 4 && open_url "$URL") &

# Do not set VITE_HTTP_URL / VITE_WS_URL. Single-origin Vite proxies the server.
# dale-tmux-window is an optional owner helper; without it run in this terminal.
if command -v dale-tmux-window >/dev/null 2>&1 \
  && dale-tmux-window -n "$WIN" -c "$ROOT" -- "${START_CMD[@]}"; then
  dale-tmux-close-launcher 2>/dev/null || true
  exit 0
fi

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
