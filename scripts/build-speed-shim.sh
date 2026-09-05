#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="${APP_BUNDLE:-/Applications/小竹Flash浏览器.app}"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources/app"
SRC_PLUGIN="$APP_RESOURCES/plugins/PepperFlashPlayer.plugin"
DST_PLUGIN="$APP_RESOURCES/plugins/PepperFlashPlayerSpeed.plugin"

if [[ ! -d "$SRC_PLUGIN" ]]; then
  echo "Original PepperFlashPlayer.plugin not found: $SRC_PLUGIN" >&2
  exit 1
fi

BACKUP_PLUGIN=""
restore_plugin() {
  local status=$?
  if [[ $status -ne 0 && -n "$BACKUP_PLUGIN" && -d "$BACKUP_PLUGIN" ]]; then
    rm -rf "$DST_PLUGIN"
    cp -R "$BACKUP_PLUGIN" "$DST_PLUGIN"
    echo "编译失败，已恢复原插件: $DST_PLUGIN (来自 $BACKUP_PLUGIN)" >&2
  fi
  return $status
}
trap restore_plugin EXIT

if [[ -d "$DST_PLUGIN" ]]; then
  BACKUP_PLUGIN="${DST_PLUGIN}.bak-$(date +%Y%m%d_%H%M%S)"
  cp -R "$DST_PLUGIN" "$BACKUP_PLUGIN"
  echo "已备份原插件到: $BACKUP_PLUGIN"
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

if [[ -n "$BACKUP_PLUGIN" ]]; then
  echo "构建成功。原插件备份保留在: $BACKUP_PLUGIN (确认无误后可自行删除)"
fi
