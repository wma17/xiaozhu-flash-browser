#!/usr/bin/env bash
#
# publish-release.sh —— 把传播版发布到 GitHub Release。
#
# 只上传传播版：文件名里带 -aim 的原生版一律拒绝，见下面的 assert_no_aim。
# 原生版是自己用的，含竞技辅助，任何情况下都不该出现在 Release 里。
#
# 用法：
#   scripts/build-dmg.sh          # 先打包
#   scripts/publish-release.sh    # 再发布
#
# 前置：tag v<版本> 已经打好并且推上去了；gh 已登录（gh auth login）。
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
step() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [[ -x /usr/bin/plutil ]]; then
  VERSION="$(plutil -extract version raw -o - "$ROOT/app/package.json")"
else
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/app/package.json" | head -1)"
fi
[[ -n "${VERSION:-}" ]] || fail "从 app/package.json 里读不出版本号。"

TAG="v$VERSION"
NOTES="$ROOT/docs/release-notes-$VERSION.md"
BASE="XiaozhuFlashBrowser-macOS-v$VERSION"

# 上传顺序：DMG 在前（大多数人下这个），ZIP 次之，两个校验值最后。
ASSETS=(
  "$DIST_DIR/$BASE.dmg"
  "$DIST_DIR/$BASE.zip"
  "$DIST_DIR/$BASE.dmg.sha256"
  "$DIST_DIR/$BASE.zip.sha256"
)

# ---------------------------------------------------------------------------
# 硬闸门：带 -aim 的一律不许上传。
# 写成显式检查而不是「列表里刚好没写」，是因为以后有人改这个列表时，
# 忘掉这件事的代价是把竞技辅助发出去。
assert_no_aim() {
  local f bad=0
  for f in "$@"; do
    case "$(basename "$f")" in
      *-aim*|*aim.*|*竞技*|*原生版*)
        printf '\n\033[31m╔════════════════════════════════════════════════════════╗\033[0m\n' >&2
        printf '\033[31m║  拒绝上传：%s\033[0m\n' "$(basename "$f")" >&2
        printf '\033[31m║  这是原生版（含竞技辅助），只能自己留着用。\033[0m\n' >&2
        printf '\033[31m║  Release 里只放传播版，文件名不带 -aim。\033[0m\n' >&2
        printf '\033[31m╚════════════════════════════════════════════════════════╝\033[0m\n' >&2
        bad=1
        ;;
    esac
  done
  [[ "$bad" -eq 0 ]] || fail "发布已中止：上传清单里混进了原生版。"
}

say "小竹Flash浏览器 发布 $TAG"

# ---------- 1. 清单检查 ----------
step "[1/4] 检查上传清单…"
assert_no_aim "${ASSETS[@]}"
missing=0
for f in "${ASSETS[@]}"; do
  if [[ -f "$f" ]]; then
    step "✓ $(basename "$f")  $(du -h "$f" | cut -f1)"
  else
    echo "  ⚠ 缺少 $(basename "$f")" >&2
    missing=1
  fi
done
[[ "$missing" -eq 0 ]] || fail "产物不齐 —— 先跑 scripts/build-dmg.sh。"
[[ -f "$NOTES" ]] || fail "找不到发布说明：${NOTES#$ROOT/}"
# dist/ 里确实有原生版是正常的（自己用），这里只是提醒一句它不会被上传。
if ls "$DIST_DIR"/*-aim.* >/dev/null 2>&1; then
  step "（dist/ 里的 -aim 文件不会被上传，这是对的）"
fi

# ---------- 2. tag ----------
step "[2/4] 检查 tag…"
git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || fail "本地没有 tag $TAG —— 先 git tag -f $TAG。"
if ! git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "远端没有 tag $TAG —— 先 git push origin $TAG（若是移动过的 tag 用 git push -f origin $TAG）。"
fi
LOCAL_TAG="$(git -C "$ROOT" rev-parse "refs/tags/$TAG^{commit}")"
REMOTE_TAG="$(git -C "$ROOT" ls-remote --tags origin "refs/tags/$TAG^{}" | awk '{print $1}')"
if [[ -n "$REMOTE_TAG" && "$LOCAL_TAG" != "$REMOTE_TAG" ]]; then
  fail "本地 tag（$LOCAL_TAG）和远端 tag（$REMOTE_TAG）指向不同的提交 —— 先 git push -f origin $TAG。"
fi
step "✓ $TAG → $LOCAL_TAG"

# ---------- 3. gh ----------
step "[3/4] 检查 gh…"
if ! command -v gh >/dev/null 2>&1; then
  cat >&2 <<MANUAL

✗ 没装 gh，脚本不会做一半就停下 —— 请手动发布：

  1. 打开 https://github.com/wma17/xiaozhu-flash-browser/releases/new?tag=$TAG
  2. 标题填：$TAG
  3. 正文粘贴 ${NOTES#$ROOT/} 的全文
  4. 按这个顺序拖进附件（只有这四个，一个都不要多）：
       $BASE.dmg
       $BASE.zip
       $BASE.dmg.sha256
       $BASE.zip.sha256
     它们都在 ${DIST_DIR#$ROOT/}/ 里。
  5. 千万不要传 ${DIST_DIR#$ROOT/}/ 里带 -aim 的文件，那是含竞技辅助的原生版。
  6. 点 Publish release。

  （想让脚本自动做的话：brew install gh && gh auth login，再跑一次。）

MANUAL
  exit 1
fi
gh auth status >/dev/null 2>&1 || fail "gh 没登录 —— 先跑 gh auth login。"

# ---------- 4. 发布 ----------
step "[4/4] 创建或更新 Release…"
cd "$ROOT"   # gh 从当前目录的 git remote 认仓库
if gh release view "$TAG" >/dev/null 2>&1; then
  step "Release 已存在，覆盖上传附件…"
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
  gh release edit "$TAG" --title "$TAG" --notes-file "$NOTES"
else
  step "新建 Release…"
  gh release create "$TAG" "${ASSETS[@]}" --title "$TAG" --notes-file "$NOTES"
fi

say "完成"
step "https://github.com/wma17/xiaozhu-flash-browser/releases/tag/$TAG"
step "Release 里只有传播版；原生版请留在本地。"
