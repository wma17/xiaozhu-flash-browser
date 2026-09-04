#!/usr/bin/env bash
#
# build-dmg.sh —— 一次打出两个版本，产物都在 dist/。
#
#   传播版（对外发布，不含竞技辅助与测距）
#     dist/XiaozhuFlashBrowser-macOS-v<版本>.dmg / .zip / 各自的 .sha256
#   原生版（自己用，功能齐全）
#     dist/XiaozhuFlashBrowser-macOS-v<版本>-aim.dmg / .zip / 各自的 .sha256
#
# 用法：
#   scripts/build-dmg.sh          两个都打
#   scripts/build-dmg.sh dist     只打传播版
#   scripts/build-dmg.sh aim      只打原生版
#
# 前置：先跑 scripts/sync-to-app.sh，让 /Applications 里的 app 和仓库 app/ 一致。
# 传播版的裁剪由 scripts/strip-aim.sh 按源码里的 XZ-AIM 标记机械完成，
# 不需要任何手工改动 —— 标记的写法见那个脚本开头的说明。
#
# 流程沿用「打包小竹.command」里验证过的那套：
# 复制 → 清理开发残留 → 传播版裁剪 → xattr -cr → 隐私自检 → 由内向外重签
# → hdiutil 出 DMG → ditto 出 ZIP → 算 SHA256。
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="${APP_BUNDLE:-/Applications/小竹Flash浏览器.app}"
APP_NAME="小竹Flash浏览器"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
WHICH="${1:-all}"

case "$WHICH" in
  all|dist|aim) ;;
  *) echo "✗ 不认识的参数：$WHICH（只能是 all / dist / aim）" >&2; exit 1 ;;
esac

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "✗ 找不到 app：$APP_BUNDLE" >&2
  echo "  先安装或先跑 scripts/sync-to-app.sh。" >&2
  exit 1
fi

if [[ -x /usr/bin/plutil ]]; then
  VERSION="$(plutil -extract version raw -o - "$ROOT/app/package.json")"
else
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/app/package.json" | head -1)"
fi
if [[ -z "${VERSION:-}" ]]; then
  echo "✗ 从 app/package.json 里读不出版本号。" >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/xzpack.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$DIST_DIR"

# ---------------------------------------------------------------------------
# 清掉开发过程留下的东西，不该跟着发出去
clean_stage() {
  local appdir="$1" res="$1/Contents/Resources/app"
  rm -rf "$res"/_backup_* 2>/dev/null || true
  rm -f  "$res"/.write_test "$res"/.xz-* 2>/dev/null || true
  find "$appdir" -name ".DS_Store" -delete 2>/dev/null || true
  xattr -cr "$appdir" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 出厂自检：app 包里本来就不该有任何个人数据。
# 档案、密码、历史、cookie 全部存在
#   ~/Library/Application Support/小竹Flash浏览器/
# 也就是 app 包外面，复制 app 不会带上它们。这里再扫一遍，
# 万一哪天代码改了往包里写东西，能当场发现。
# 判定按「数据的形态」而不是「名字里有没有那个词」——按名字匹配会把
# nav-profiles.svg 这类图标误当成个人数据。
privacy_check() {
  local appdir="$1" leak=0 f d base

  # 1) 白名单之外的 json
  while IFS= read -r f; do
    base="$(basename "$f")"
    case "$base" in
      config.json|package.json|package-lock.json|vk_swiftshader_icd.json) continue ;;
    esac
    echo "  ⚠ 意外的 json：${f#$appdir/}" >&2
    leak=1
  done < <(find "$appdir" -type f -name "*.json" 2>/dev/null)

  # 2) Chromium / Electron 的用户数据目录，出现在包里就是不对的
  while IFS= read -r d; do
    echo "  ⚠ 用户数据目录：${d#$appdir/}" >&2
    leak=1
  done < <(find "$appdir" -type d \( -name "Partitions" -o -name "IndexedDB" \
           -o -name "Local Storage" -o -name "Session Storage" \
           -o -name "Service Worker" -o -name "usage" \) 2>/dev/null)

  # 3) 数据库和 cookie 文件
  while IFS= read -r f; do
    echo "  ⚠ 数据文件：${f#$appdir/}" >&2
    leak=1
  done < <(find "$appdir" -type f \( -name "Cookies" -o -name "Cookies-journal" \
           -o -name "*.sqlite" -o -name "*.sqlite3" -o -name "*.db" -o -name "*.ldb" \) \
           -not -path "*/Electron Framework.framework/*" 2>/dev/null)

  if [[ "$leak" -eq 1 ]]; then
    fail "自检发现 app 包里有疑似个人数据的文件，打包已中止 —— 请把上面列出的内容确认清楚再重试。"
  fi
  step "隐私自检通过：包内无个人数据"
}

# ---------------------------------------------------------------------------
# 顺序很重要：必须从最深的嵌套内容开始签，最后才签外层 app，
# 否则外层签名会被内部的改动作废。
resign() {
  local appdir="$1" item
  while IFS= read -r -d '' item; do
    codesign --force --sign - --timestamp=none "$item" 2>/dev/null || true
  done < <(find "$appdir/Contents" -maxdepth 3 \
           \( -name "*.dylib" -o -name "*.framework" -o -name "*.plugin" -o -name "*.app" \) \
           -print0 2>/dev/null)
  codesign --force --deep --sign - --timestamp=none "$appdir" 2>/dev/null \
    || step "（签名有警告，通常不影响使用）"
  if codesign --verify --deep --strict "$appdir" 2>/dev/null; then
    step "签名校验通过"
  else
    step "签名校验未通过 —— app 仍可用，但别人首次打开需要右键→打开"
  fi
}

sha_of() {
  local file="$1"
  ( cd "$(dirname "$file")" && shasum -a 256 "$(basename "$file")" > "$(basename "$file").sha256" )
}

# ---------------------------------------------------------------------------
# $1 = 变体（dist / aim）
build_variant() {
  local variant="$1" label suffix volname stripit
  case "$variant" in
    dist) label="传播版";              suffix="";     volname="$APP_NAME $VERSION";        stripit=1 ;;
    aim)  label="原生版（含竞技辅助）"; suffix="-aim"; volname="$APP_NAME $VERSION 竞技版"; stripit=0 ;;
  esac

  local base="XiaozhuFlashBrowser-macOS-v${VERSION}${suffix}"
  local dmg="$DIST_DIR/$base.dmg"
  local zip="$DIST_DIR/$base.zip"
  local room="$STAGE/$variant"
  local appdir="$room/$APP_NAME.app"

  say "打包 $label"

  step "[1/6] 复制 app（原版不动）…"
  mkdir -p "$room"
  ditto "$APP_BUNDLE" "$appdir" || fail "复制失败"

  step "[2/6] 清理开发残留…"
  clean_stage "$appdir"

  if [[ "$stripit" -eq 1 ]]; then
    step "[3/6] 按 XZ-AIM 标记裁掉竞技辅助与测距…"
    "$ROOT/scripts/strip-aim.sh" "$appdir/Contents/Resources/app" || fail "裁剪失败"
  else
    step "[3/6] 原生版不裁剪，跳过"
  fi

  step "[4/6] 隐私自检…"
  privacy_check "$appdir"

  step "[5/6] 重新签名（本地 ad-hoc 签名）…"
  resign "$appdir"

  step "[6/6] 生成 DMG 与 ZIP…"
  ln -s /Applications "$room/Applications"
  rm -f "$dmg" "$dmg.sha256" "$zip" "$zip.sha256"
  hdiutil create \
    -volname "$volname" \
    -srcfolder "$room" \
    -fs HFS+ -format UDZO -imagekey zlib-level=9 \
    -ov -quiet "$dmg" || fail "hdiutil 生成 DMG 失败"
  ( cd "$room" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "$zip" ) \
    || fail "ZIP 生成失败"
  sha_of "$dmg"
  sha_of "$zip"

  step "DMG  $(du -h "$dmg" | cut -f1)  ${dmg#$ROOT/}"
  step "ZIP  $(du -h "$zip" | cut -f1)  ${zip#$ROOT/}"
}

say "小竹Flash浏览器 打包 v$VERSION"
echo "  来源：$APP_BUNDLE"
echo "  产物：$DIST_DIR"

if [[ "$WHICH" == "all" || "$WHICH" == "dist" ]]; then build_variant dist; fi
if [[ "$WHICH" == "all" || "$WHICH" == "aim"  ]]; then build_variant aim;  fi

say "完成"
cat <<NOTE
  传播版 = 对外发布的那份，不含竞技辅助与测距，文件名里没有 -aim。
  原生版 = 自己留着用的那份，文件名带 -aim，不要上传到 Release。

  发布：scripts/publish-release.sh（只会上传不带 -aim 的文件）

  发给别人时请一并告诉他：
    这个 app 没有苹果开发者签名，对方首次打开会被拦下。
    正确的打开方式是 —— 右键点图标 → 选「打开」→ 再点「打开」。
    macOS 15 及以上可能还需要去 系统设置 → 隐私与安全性 → 仍要打开。
NOTE
