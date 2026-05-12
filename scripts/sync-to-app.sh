#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="${APP_BUNDLE:-/Applications/小竹Flash浏览器.app}"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources/app"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

rsync -a --delete \
  --exclude='plugins/PepperFlashPlayer.plugin' \
  --exclude='plugins/PepperFlashPlayerSpeed.plugin' \
  "$ROOT/app/" "$APP_RESOURCES/"

if [[ "${BUILD_SPEED_SHIM:-1}" == "1" ]]; then
  "$ROOT/scripts/build-speed-shim.sh"
else
  rm -rf "$APP_RESOURCES/plugins/PepperFlashPlayerSpeed.plugin"
fi
codesign --force --deep --sign - "$APP_BUNDLE"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
