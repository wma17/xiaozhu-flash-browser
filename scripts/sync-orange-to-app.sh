#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_APP="${BASE_APP:-/Applications/小竹Flash浏览器.app}"
ORANGE_APP="${ORANGE_APP:-/Applications/小竹Flash浏览器 Orange Ver.app}"

if [[ ! -d "$ORANGE_APP" ]]; then
  if [[ ! -d "$BASE_APP" ]]; then
    echo "Base app not found: $BASE_APP" >&2
    exit 1
  fi
  ditto "$BASE_APP" "$ORANGE_APP"
fi

APP_BUNDLE="$ORANGE_APP" \
APP_DISPLAY_NAME="小竹Flash浏览器 Orange Ver" \
APP_BUNDLE_IDENTIFIER="com.xiaozhu.flash.browser.orange" \
APP_ICON_SOURCE="$ROOT/app/assets/app_icon_orange.icns" \
APP_ICON_FILE="Orange" \
"$ROOT/scripts/sync-to-app.sh"
