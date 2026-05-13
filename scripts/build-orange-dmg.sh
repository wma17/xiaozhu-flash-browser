#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_VERSION="${APP_VERSION:-$(plutil -extract version raw -o - "$ROOT/app/package.json")}"

APP_BUNDLE="${APP_BUNDLE:-/Applications/小竹Flash浏览器 Orange Ver.app}" \
APP_NAME="${APP_NAME:-小竹Flash浏览器 Orange Ver}" \
DMG_NAME="${DMG_NAME:-XiaozhuFlashBrowser-OrangeVer-macOS-v$APP_VERSION.dmg}" \
"$ROOT/scripts/build-dmg.sh"
