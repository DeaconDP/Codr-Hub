#!/usr/bin/env bash
# Build and install Codr-Hub Dev on a physical iPhone using the owner's paid
# Apple team. Unique bundle id so we do not collide with T3 Tools identifiers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null

export PATH="$HOME/.nvm/versions/node/$(node -v)/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export T3CODE_IOS_APPLE_TEAM_ID="${T3CODE_IOS_APPLE_TEAM_ID:-3825NK7CQ8}"
export T3CODE_IOS_PERSONAL_TEAM="${T3CODE_IOS_PERSONAL_TEAM:-1}"
export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID="${T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID:-io.worldbuild.codrhub.dev}"
export APP_VARIANT="${APP_VARIANT:-development}"
export EXPO_NO_GIT_STATUS=1
# Baked into the dev client as its launch URL, so the app opens straight into
# Metro instead of Expo's server picker. Override for Tailscale.
export CODR_HUB_METRO_URL="${CODR_HUB_METRO_URL:-http://$(scutil --get LocalHostName).local:8081}"

DEVICE="${1:-}"
if [[ -z "$DEVICE" ]]; then
  DEVICE="$(python3 - <<'PY'
import json, subprocess
subprocess.run(
    ["xcrun", "devicectl", "list", "devices", "--json-output", "/tmp/codr-ios-devices.json"],
    check=True,
    capture_output=True,
)
d = json.load(open("/tmp/codr-ios-devices.json"))
for dev in d["result"]["devices"]:
    hw = dev.get("properties", {}).get("hardware", {})
    conn = dev.get("properties", {}).get("connection", {})
    if hw.get("reality") != "physical":
        continue
    if conn.get("state") in ("connected", "available"):
        print(hw.get("udid") or "")
        break
PY
)"
fi
if [[ -z "$DEVICE" ]]; then
  echo "No connected physical iPhone. Plug in a data cable, unlock, Trust, then rerun." >&2
  xcrun devicectl list devices >&2 || true
  exit 2
fi

cd "$ROOT/apps/mobile"
npx expo prebuild --platform ios
# expo run:ios waits on `simctl list`, which can hang for minutes. Build with
# xcodebuild and install with CoreDevice instead.
DD="${TMPDIR:-/tmp}codr-ios-derived"
xcodebuild \
  -workspace ios/CodrHubDev.xcworkspace \
  -scheme CodrHubDev \
  -configuration Debug \
  -destination "id=${DEVICE}" \
  -derivedDataPath "$DD" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$T3CODE_IOS_APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic
APP=$(find "$DD" -name 'CodrHubDev.app' -path '*iphoneos*' | head -1)
if [[ -z "$APP" ]]; then
  echo "Build finished but CodrHubDev.app was not found under $DD" >&2
  exit 1
fi
xcrun devicectl device install app --device "$DEVICE" "$APP"

# Open the app pointed at Metro. If Metro is not running yet, the app shows
# Expo's server list until it is.
DEEP_LINK="codrhub-dev://expo-development-client/?url=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$CODR_HUB_METRO_URL")"
xcrun devicectl device process launch --device "$DEVICE" --terminate-existing \
  --payload-url "$DEEP_LINK" "$T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID" || true

cat <<EOF

Installed Codr-Hub Dev. Next step, on this Mac:

  cd apps/mobile && vp run dev:client

Then open Codr-Hub Dev on the iPhone. It connects to $CODR_HUB_METRO_URL
automatically (same Wi-Fi as this Mac). If it ever shows "Searching for
development servers", tap "Enter URL manually" and type that address.
EOF
