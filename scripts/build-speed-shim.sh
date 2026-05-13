#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="$(plutil -extract productName raw -o - "$ROOT/app/package.json")"
APP_BUNDLE="${APP_BUNDLE:-/Applications/$APP_NAME.app}"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources/app"
SRC_PLUGIN="$APP_RESOURCES/plugins/PepperFlashPlayer.plugin"
DST_PLUGIN="$APP_RESOURCES/plugins/PepperFlashPlayerSpeed.plugin"

if [[ ! -d "$SRC_PLUGIN" ]]; then
  echo "Original PepperFlashPlayer.plugin not found: $SRC_PLUGIN" >&2
  exit 1
fi

rm -rf "$DST_PLUGIN"
cp -R "$SRC_PLUGIN" "$DST_PLUGIN"
mv "$DST_PLUGIN/Contents/MacOS/PepperFlashPlayer" "$DST_PLUGIN/Contents/MacOS/PepperFlashPlayer.real"
clang -arch x86_64 -dynamiclib -O2 -Wall -Wextra -Wno-deprecated-declarations -framework CoreFoundation -framework CoreServices \
  -o "$DST_PLUGIN/Contents/MacOS/libxzspeed.dylib" \
  "$ROOT/app/xzspeed.c"
clang -arch x86_64 -bundle -O2 -Wall -Wextra -framework CoreFoundation \
  -o "$DST_PLUGIN/Contents/MacOS/PepperFlashPlayer" \
  "$ROOT/app/ppapi_speed_shim.c"
chmod +x "$DST_PLUGIN/Contents/MacOS/PepperFlashPlayer" "$DST_PLUGIN/Contents/MacOS/PepperFlashPlayer.real" "$DST_PLUGIN/Contents/MacOS/libxzspeed.dylib"
