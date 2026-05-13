#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_VERSION="${APP_VERSION:-$(plutil -extract version raw -o - "$ROOT/app/package.json")}"
APP_NAME="${APP_NAME:-$(plutil -extract productName raw -o - "$ROOT/app/package.json")}"
APP_BUNDLE="${APP_BUNDLE:-/Applications/$APP_NAME.app}"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
DMG_BACKGROUND="${DMG_BACKGROUND:-$APP_BUNDLE/Contents/Resources/app/assets/optional/dmg_background.png}"
DMG_ROOT="$DIST_DIR/dmg-root"
DMG_NAME="${DMG_NAME:-XiaozhuFlashBrowser-OrangeVer-macOS-v$APP_VERSION.dmg}"
DMG_PATH="$DIST_DIR/$DMG_NAME"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

rm -rf "$DMG_ROOT" "$DMG_PATH" "$DMG_PATH.sha256"
mkdir -p "$DMG_ROOT" "$DIST_DIR"

ditto "$APP_BUNDLE" "$DMG_ROOT/$(basename "$APP_BUNDLE")"
ln -s /Applications "$DMG_ROOT/Applications"
if [[ -f "$DMG_BACKGROUND" ]]; then
  mkdir -p "$DMG_ROOT/.background"
  cp "$DMG_BACKGROUND" "$DMG_ROOT/.background/background.png"
fi

hdiutil create \
  -volname "$APP_NAME $APP_VERSION" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

(cd "$DIST_DIR" && shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256")
rm -rf "$DMG_ROOT"

echo "$DMG_PATH"
cat "$DMG_PATH.sha256"
