#!/usr/bin/env bash
# Build and install T3 Code Dev on a physical iPhone using the owner's paid
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
  -workspace ios/T3CodeDev.xcworkspace \
  -scheme T3CodeDev \
  -configuration Debug \
  -destination "id=${DEVICE}" \
  -derivedDataPath "$DD" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$T3CODE_IOS_APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic
APP=$(find "$DD" -name 'T3CodeDev.app' -path '*iphoneos*' | head -1)
if [[ -z "$APP" ]]; then
  echo "Build finished but T3CodeDev.app was not found under $DD" >&2
  exit 1
fi
xcrun devicectl device install app --device "$DEVICE" "$APP"
