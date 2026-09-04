#!/usr/bin/env bash
#
# strip-aim.sh —— 把「竞技辅助 + 测距」从一份 app 源码副本里机械地摘掉。
#
# 用法：
#   scripts/strip-aim.sh <app 源码目录>
# 目录会被就地修改，所以永远只对副本调用（build-dmg.sh 就是这么用的）。
#
# ---------------------------------------------------------------------------
# 标记约定（源码里写的是注释，全量版运行时完全无感）
#
#   1) 整段删除：BEGIN 行到 END 行，含这两行本身。
#        JS    // XZ-AIM-BEGIN  …  // XZ-AIM-END
#        HTML  <!-- XZ-AIM-BEGIN -->  …  <!-- XZ-AIM-END -->
#        CSS   /* XZ-AIM-BEGIN */  …  /* XZ-AIM-END */
#
#   2) 单行删除：整行删掉。用在数组的一项、菜单的一行、设置里的一行这种
#      「一行就是一个完整语句」的地方，比包三行 BEGIN/END 干净。
#        JS    xxx, // XZ-AIM-LINE
#        HTML  <xxx> <!-- XZ-AIM-LINE -->
#        CSS   xxx /* XZ-AIM-LINE */
#
#   3) 行内片段删除：删掉两个标记之间的内容（含标记本身），可以跨行。
#      用在「要删的东西是一行里的一截」，比如表达式中间的一个或运算项、
#      选择器列表中间的两个选择器。只能用在 JS 和 CSS（含 <style> 里的
#      CSS），因为它借的是 /* */ 注释。
#        /*XZ-AIM-CUT*/ 要删掉的片段 /*XZ-AIM-CUT-END*/
#
# 除此之外还会删掉 aim-assist.js 和 aim-window.html 两个整文件。
# ---------------------------------------------------------------------------
set -euo pipefail
export LC_ALL=C

SRC="${1:-}"
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "用法：$0 <app 源码目录>" >&2
  exit 1
fi

say() { printf '  %s\n' "$*"; }

# ---------- 1. 整文件 ----------
for f in aim-assist.js aim-window.html; do
  if [[ -e "$SRC/$f" ]]; then
    rm -rf "$SRC/$f"
    say "删除文件 $f"
  fi
done

# ---------- 2. 按标记删除 ----------
STRIPPER="$(mktemp "${TMPDIR:-/tmp}/xzstrip.XXXXXX")"
trap 'rm -f "$STRIPPER" "$STRIPPER.out"' EXIT
cat > "$STRIPPER" <<'AWKEOF'
BEGIN { CUTB = "/*XZ-AIM-CUT*/"; CUTE = "/*XZ-AIM-CUT-END*/"; skip = 0; incut = 0; hold = "" }
{
  line = $0
  if (skip) { if (line ~ /XZ-AIM-END/) skip = 0; next }
  if (line ~ /XZ-AIM-BEGIN/) { skip = 1; next }
  if (line ~ /XZ-AIM-LINE/) next
  if (incut) {
    q = index(line, CUTE)
    if (q == 0) next
    line = hold substr(line, q + length(CUTE))
    incut = 0; hold = ""
  }
  while ((p = index(line, CUTB)) > 0) {
    pre = substr(line, 1, p - 1)
    rest = substr(line, p + length(CUTB))
    q = index(rest, CUTE)
    if (q == 0) { hold = pre; incut = 1; break }
    line = pre substr(rest, q + length(CUTE))
  }
  if (incut) next
  print line
}
END {
  if (skip)  { print "XZ-AIM-BEGIN 没有配对的 XZ-AIM-END" > "/dev/stderr"; exit 1 }
  if (incut) { print "XZ-AIM-CUT 没有配对的 XZ-AIM-CUT-END" > "/dev/stderr"; exit 1 }
}
AWKEOF

count=0
while IFS= read -r f; do
  grep -q 'XZ-AIM-' "$f" || continue
  if ! awk -f "$STRIPPER" "$f" > "$STRIPPER.out"; then
    echo "✗ 标记不配对：${f#$SRC/}，已中止。" >&2
    exit 1
  fi
  cat "$STRIPPER.out" > "$f"
  say "剥离标记 ${f#$SRC/}"
  count=$((count + 1))
done < <(find "$SRC" -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \) ! -path '*/plugins/*')

if [[ "$count" -eq 0 ]]; then
  echo "✗ 一个带 XZ-AIM 标记的文件都没找到 —— 源码大概不对，已中止。" >&2
  exit 1
fi

# ---------- 3. 出厂自检 ----------
# 剥完之后不该再有任何活的入口。注释里提到名字没关系（i18n.js 的文案也一样
# 保留：它只是字符串表，留着不会让功能复活），这里查的是真正会执行的引用。
LEFTOVER='AimAssist\.|measuring\.|id="measure-|src="aim-assist|aim:popout|aim:rpc|aim:save-sample|startScaleCalibration|resizeMeasureCanvas|measureCanvas\('
leak=0
for f in "$SRC"/main.js "$SRC"/renderer.js "$SRC"/index.html "$SRC"/command-palette.js "$SRC"/ui-tokens.css; do
  [[ -e "$f" ]] || continue
  if grep -nE "$LEFTOVER" "$f" >/dev/null; then
    echo "  ⚠ ${f#$SRC/} 里还有竞技辅助/测距的残留：" >&2
    grep -nE "$LEFTOVER" "$f" >&2
    leak=1
  fi
done
if [[ -e "$SRC/aim-assist.js" || -e "$SRC/aim-window.html" ]]; then
  echo "  ⚠ aim 相关文件没删干净" >&2
  leak=1
fi
if [[ "$leak" -eq 1 ]]; then
  echo "✗ 传播版自检没过：上面这些地方还引用着已经删掉的功能。" >&2
  exit 1
fi

say "自检通过：传播版里没有竞技辅助与测距"
