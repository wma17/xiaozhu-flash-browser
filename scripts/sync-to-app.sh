#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_VERSION="$(plutil -extract version raw -o - "$ROOT/app/package.json")"
APP_NAME="$(plutil -extract productName raw -o - "$ROOT/app/package.json")"
APP_BUNDLE="${APP_BUNDLE:-/Applications/$APP_NAME.app}"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources/app"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "App bundle not found: $APP_BUNDLE" >&2
  exit 1
fi

APP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")"
APP_INTERNAL_NAME="${APP_INTERNAL_NAME:-$APP_EXECUTABLE}"
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-$APP_NAME}"
APP_ICON_SOURCE="${APP_ICON_SOURCE:-}"
APP_ICON_FILE="${APP_ICON_FILE:-AppIcon}"
APP_BUNDLE_IDENTIFIER="${APP_BUNDLE_IDENTIFIER:-}"
if [[ -z "$APP_ICON_SOURCE" && "$APP_NAME" == *Orange* && -f "$ROOT/app/assets/app_icon_orange.icns" ]]; then
  APP_ICON_SOURCE="$ROOT/app/assets/app_icon_orange.icns"
  APP_ICON_FILE="Orange"
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

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $APP_VERSION" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_INTERNAL_NAME" "$INFO_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_DISPLAY_NAME" "$INFO_PLIST"
if [[ -n "$APP_BUNDLE_IDENTIFIER" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $APP_BUNDLE_IDENTIFIER" "$INFO_PLIST"
fi
if [[ -n "$APP_ICON_SOURCE" && -f "$APP_ICON_SOURCE" ]]; then
  cp "$APP_ICON_SOURCE" "$APP_BUNDLE/Contents/Resources/$APP_ICON_FILE.icns"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $APP_ICON_FILE" "$INFO_PLIST"
fi

codesign --force --deep --sign - "$APP_BUNDLE"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
