#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="${APP_BUNDLE:-/Applications/小竹Flash浏览器.app}"
APP_VERSION="${APP_VERSION:-$(plutil -extract version raw -o - "$ROOT/app/package.json")}"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
DMG_ROOT="$DIST_DIR/dmg-root"
DMG_NAME="XiaozhuFlashBrowser-macOS-v$APP_VERSION.dmg"
DMG_PATH="$DIST_DIR/$DMG_NAME"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

rm -rf "$DMG_ROOT" "$DMG_PATH" "$DMG_PATH.sha256"
mkdir -p "$DMG_ROOT" "$DIST_DIR"

ditto "$APP_BUNDLE" "$DMG_ROOT/$(basename "$APP_BUNDLE")"
ln -s /Applications "$DMG_ROOT/Applications"

hdiutil create \
  -volname "小竹Flash浏览器 $APP_VERSION" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

(cd "$DIST_DIR" && shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256")
rm -rf "$DMG_ROOT"

echo "$DMG_PATH"
cat "$DMG_PATH.sha256"
