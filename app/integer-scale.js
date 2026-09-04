// ============================================================================
// integer-scale.js — 整数倍缩放（Integer Scale）—— 第三轮 WP4 / 方案 §2.4b
// ----------------------------------------------------------------------------
// 【它做什么】
//   把 tab 的缩放倍数吸附到「一个 Flash 舞台像素 = 整数个设备像素」的档位上：
//       k = tab.zoom × window.devicePixelRatio ∈ {1, 2, 3, …}
//   Retina（DPR=2）上就是 50% / 100% / 150% / 200% / 250% / 300%；
//   --xz-low-res 把 DSF 压成 1 时（DPR=1）就只剩 100% / 200% / 300%。
//   矢量在任何倍数下都会重新光栅化，真正会糊的是 SWF 里的位图素材和非整数比例下
//   的重采样 —— 整数比例正好消掉这一部分。
//
// 【它绝不做什么】
//   - 不改 renderer.js 的任何缩放逻辑：本文件缺席时 tab.zoom / tab.fit /
//     _applyZoom / bumpZoom / resetZoom / fitZoom / 缩放菜单 / ⌘+ ⌘− ⌘0 ⌘9
//     的行为与 1.6.0 逐字相同（所有接入点都是 if (window.XZScale) 守卫）。
//   - 不做 CSS transform 缩放，不碰 webview 的几何（那是 focus-mode.js 的地盘）。
//   - 不新增 setZoomFactor 的调用频率：setZoomFactor 是同步 IPC，只在用户
//     真的切换档位时调一次。
//
// 【与 focus-mode.js 的分工（重要）】
//   focus-mode.js 是唯一碰 webview 几何的模块，它有两条路径：
//     transform（默认）—— 它完全不碰 setZoomFactor，webview 的 zoom 就是 tab.zoom，
//                          本模块照常自己调用 setZoomFactor，两边零交集。
//     zoom（fallback，prefs.geometryMode==='zoom'）—— 它把真实 zoom 接管为
//                          tab.zoom × 槽位 scale。这时本模块**只改 tab.zoom
//                          这个逻辑基准值**，绝不自己调 setZoomFactor、也不调
//                          _applyZoom（对缩略图量 offsetWidth 会算出错的 fit），
//                          而是清掉焦点模式的两个脏检查缓存后请它重铺一次。
//   fit 的量化走的是 renderer 里 _applyZoom 的钩子（R4），焦点模式自己调
//   _applyZoom 时同样会经过它 —— 所以不管谁触发 fit，结果都是同一个整数档。
//
// 运行环境：Electron 11.2.1 / Chromium 87。ES5（var / function，无箭头、无模板串、
// 无 let/const、无解构、无可选链），经典 script，靠裸标识符读 renderer.js 的顶层符号。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 没加载（或加载失败）时安静退出：宿主的接入点全是
  // if (window.XZScale)，本对象不存在 = 缩放行为与今天完全一致。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZScale] renderer.js 作用域不可见，整数倍缩放未启用'); } catch (e) {}
    return;
  }

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  // ------------------------------------------------------------------ 常量
  var EPS = 1e-6;
  var ZOOM_MIN = 0.4;          // renderer.js bumpZoom 的下限
  var ZOOM_MAX = 3;            // renderer.js bumpZoom 的上限
  var minHintShown = false;    // 「1 倍屏最小 100%」每个会话只说一次
  var switchBound = false;     // 设置页开关只绑一次

  // ------------------------------------------------------------------ 安全包装
  // renderer.js 的符号全部按需探测：缺一个只让对应的小功能失效，不炸整个模块。
  function t_(key, fallback) {
    try { if (typeof tOr === 'function') return tOr(key, fallback); } catch (e) {}
    return fallback;
  }
  function toast(text) {
    try { if (typeof showToast === 'function') showToast(text); } catch (e) {}
  }
  function activeTabSafe() {
    try { return (typeof activeTab === 'function') ? activeTab() : null; } catch (e) { return null; }
  }
  function repaintIndicator() {
    try { if (typeof updateZoomIndicator === 'function') updateZoomIndicator(); } catch (e) {}
  }
  function settingsObj() {
    try { return (typeof settings === 'object' && settings) ? settings : null; } catch (e) { return null; }
  }
  function stateWord(on) {
    return on ? t_('tools.on', '开') : t_('tools.off', '关');
  }

  // ------------------------------------------------------------------ 档位数学
  // DPR 每次现读：窗口在两块不同缩放的显示器之间拖动、或用 --xz-low-res 重启后，
  // 它会变，缓存下来就会算错档位。
  function dpr() {
    var d = window.devicePixelRatio;
    return (typeof d === 'number' && isFinite(d) && d > 0) ? d : 1;
  }
  // k = 一个舞台像素画成几个设备像素。k/dpr 必须落在 renderer 的 0.4–3 之内，
  // 否则指示器上的数字和 webview 的实际倍数会对不上。
  function minK(d) { return Math.max(1, Math.ceil(ZOOM_MIN * d - EPS)); }
  function maxK(d) { return Math.max(minK(d), Math.floor(ZOOM_MAX * d + EPS)); }

  function isOn(tab) { return !!(tab && tab._snap); }

  // dir: +1 = 下一档（⌘+）；-1 = 上一档（⌘−）；0 = 把当前值向下吸附到本档（fit / 刚开启）。
  // 未开启时原样返回 —— 这一条保证了「开关关着 = 模块不存在」。
  function quantize(tab, zoom, dir) {
    var z = Number(zoom);
    if (!isFinite(z) || z <= 0) z = 1;
    if (!isOn(tab)) return z;
    try {
      var d = dpr();
      var k = z * d;
      if (dir > 0) k = Math.floor(k + EPS) + 1;
      else if (dir < 0) k = Math.ceil(k - EPS) - 1;
      else k = Math.floor(k + EPS);
      var lo = minK(d), hi = maxK(d);
      // 1 倍屏 + 小窗口时，「适应窗口」算出来可能不到 100%，而最小的整数档就是 100%。
      // 这时按 100% 走（会比窗口大一点），并且只提示一次，别每次 resize 都刷屏。
      if (k < lo) { k = lo; if (dir === 0 && d < 1.5) hintMin(); }
      if (k > hi) k = hi;
      return k / d;
    } catch (e) { return z; }
  }

  function hintMin() {
    if (minHintShown) return;
    minHintShown = true;
    toast(t_('zoom.snap_min_hint', '在 1 倍屏上，整数倍缩放最小只能是 100%。'));
  }

  // -------------------------------------------------- 与 focus-mode.js 的边界
  // 焦点模式的 zoom 兜底路径下，webview 的真实 zoom = tab.zoom × 槽位 scale，
  // 由 focus-mode.js 的 applyZoomForSlot 独家写入。那时我们只改 tab.zoom。
  function focusOwnsZoom() {
    try {
      var F = window.XZFocus;
      if (!F || typeof F.isActive !== 'function') return false;
      if (!F.isActive()) return false;
      var p = (typeof F.getPrefs === 'function') ? F.getPrefs() : null;
      return !!(p && p.geometryMode === 'zoom');
    } catch (e) { return false; }
  }
  // 焦点模式的 applySlot 有两级脏检查（_fmSlotSig / _fmZoomWant），槽位几何没变时
  // 会直接 return，新的 tab.zoom 就写不进去。清掉这两个缓存再请它重铺一次即可；
  // 清成 null 与它自己的 clearSlot() 完全同义，不会让它进入奇怪状态。
  function askFocusRelayout(tab) {
    try {
      if (tab) { tab._fmSlotSig = null; tab._fmZoomWant = null; }
      var F = window.XZFocus;
      if (F && typeof F._relayout === 'function') F._relayout();
    } catch (e) {}
  }

  // setZoomFactor 是同步 IPC：只在切换档位时调一次，绝不在循环/动画里调。
  function applyZoom(tab) {
    if (!tab || !tab.webview) return;
    if (focusOwnsZoom()) askFocusRelayout(tab);
    else { try { tab.webview.setZoomFactor(tab.zoom || 1); } catch (e) {} }
    repaintIndicator();
  }

  // ------------------------------------------------------------------ 开关
  // silent（R12 / R14）：用户在缩放菜单里明确选了某个百分比 —— 那就退出整数模式，
  // 但不要重算、不要提示，用户选的百分比必须原样生效。
  function setOn(tab, on, silent) {
    if (!tab) return;
    tab._snap = !!on;
    if (silent) return;
    if (!tab._snap) { repaintIndicator(); return; }   // 关掉只是不再吸附，当前倍数保持不动
    if (tab.fit) {
      if (focusOwnsZoom()) {
        // 焦点模式接管几何时不能量 offsetWidth（缩略图的布局尺寸已经被改小），
        // 只把现有的 fit 值吸附到档位上，剩下的交给它重铺。
        tab.zoom = quantize(tab, tab.zoom || 1, 0);
        askFocusRelayout(tab);
        repaintIndicator();
      } else if (typeof tab._applyZoom === 'function') {
        try { tab._applyZoom(); } catch (e) {}       // fit 分支里的 R4 钩子会调 quantize
      } else {
        tab.zoom = quantize(tab, tab.zoom || 1, 0);
        applyZoom(tab);
      }
    } else {
      tab.zoom = quantize(tab, tab.zoom || 1, 0);
      applyZoom(tab);
    }
  }

  function toggle(tab) {
    var t = tab || activeTabSafe();
    if (!t) return;
    var want = !isOn(t);
    setOn(t, want, false);
    toast(t_('zoom.snap', '整数倍缩放') + ' ' + stateWord(want));
    if (want && dpr() < 1.5) hintMin();
  }

  // ------------------------------------------------------------------ 界面
  // R10：updateZoomIndicator 末尾调用。只在开启时追加 ' ·k×'，不改已有文本的其余部分。
  function paintIndicator(tab, el) {
    try {
      if (!tab || !el || !isOn(tab)) return;
      var d = dpr();
      var k = (tab.zoom || 1) * d;
      var kr = Math.round(k);
      // 还没吸附到位（刚开启、或 fit 正在算）就先什么都不标，别显示一个假的整数。
      if (kr < 1 || Math.abs(k - kr) > 0.02) return;
      el.textContent = (el.textContent || '') + ' ·' + kr + '×';
      var tip = t_('zoom.snap_tip', '缩放对齐到设备像素的整数倍（当前 {k}×），让 Flash 的边缘和像素画保持清晰。')
        .replace('{k}', String(kr));
      el.title = el.title ? (el.title + ' · ' + tip) : tip;
    } catch (e) {}
  }

  // R13：缩放菜单里的勾选项（跟在「适应窗口」后面）。样式沿用现有 .menu-item / .check。
  function addMenuItem(menu, tab) {
    try {
      if (!menu) return;
      var t = tab || activeTabSafe();
      if (!t) return;
      var item = document.createElement('div');
      item.className = 'menu-item' + (isOn(t) ? ' check' : '');
      item.textContent = t_('zoom.snap', '整数倍缩放');
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        try { if (typeof closeAnyMenus === 'function') closeAnyMenus(); } catch (e) {}
        toggle(t);
      });
      menu.appendChild(item);
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 设置页
  // renderSettings() 不知道这个开关的存在，所以自己在 boot 与进入设置页时同步一次。
  function syncSwitch() {
    try {
      var el = document.getElementById('setting-zoom-snap');
      if (!el) return;
      var s = settingsObj();
      if (typeof setSwitch === 'function') setSwitch(el, !!(s && s.zoomSnap === true));
      if (!switchBound && typeof attachSwitch === 'function') {
        switchBound = true;
        attachSwitch(el, function (on) {
          var st = settingsObj();
          if (!st) return;
          st.zoomSnap = !!on;   // 只影响以后新建的标签页，不动已经开着的（文案如此承诺）
          try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) {}
        });
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 事件
  document.addEventListener('xz:tab-created', function (e) {
    try {
      var tab = e && e.detail;
      if (!tab) return;
      var s = settingsObj();
      tab._snap = !!(s && s.zoomSnap === true);   // 默认 false：不改变现有行为
    } catch (err) {}
  });
  document.addEventListener('xz:boot', function () { syncSwitch(); });
  document.addEventListener('xz:route', function (e) {
    if (e && e.detail === 'settings') syncSwitch();
  });

  // 主进程 View 菜单的 Integer Zoom：模块自己收 action，不改 renderer 的 switch
  // （focus-mode.js 的先例；switch 对未知 action 什么也不做，不会双触发）。
  if (ipcRenderer) {
    try {
      ipcRenderer.on('action', function (_e, a) {
        if (a === 'toggle-zoom-snap') toggle(null);
      });
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 公共接口（方案 §4）
  window.XZScale = {
    isOn: isOn,
    setOn: setOn,
    toggle: toggle,
    quantize: quantize,
    paintIndicator: paintIndicator,
    addMenuItem: addMenuItem
  };
})();

// ============================================================================
// 本文件通过 t_(key, 中文兜底) 引用的 i18n 键（en / zh-CN 两边都要有，见方案 §5）：
//
//   zoom.snap           Integer zoom                     缩放菜单项 / toast / 指示器提示
//   zoom.snap_tip       Zoom snaps so each Flash pixel …  指示器 title（含 {k} 占位符）
//   zoom.snap_min_hint  On a 1× display the smallest …    DPR=1 时被抬到 100% 的一次性提示
//   tools.on / tools.off 开 / 关                          toast 里的状态词（已存在）
//
// 由 index.html 的 data-i18n 使用、本文件不直接引用：
//   set.zoom_snap、set.zoom_snap_sub（设置页「体验」组里的 #setting-zoom-snap 一行）
//
// 集成侧接入点（方案 §3.1 / §3.2，全部由 WP6 落地）：
//   R4  _applyZoom 的 fit 分支：tab.zoom = XZScale.quantize(tab, tab.zoom, 0)
//   R10 updateZoomIndicator 末尾：XZScale.paintIndicator(t, $zoomInd)
//   R12/R14 缩放菜单的预设/自定义百分比：XZScale.setOn(t, false, true)
//   R13 缩放菜单「适应窗口」之后：XZScale.addMenuItem(menu, t)
//   R16 bumpZoom：开启时用 XZScale.quantize(tab, tab.zoom, delta > 0 ? 1 : -1)
//   M7  View 菜单 Integer Zoom → action 'toggle-zoom-snap'（本文件自己接收）
//   H4  设置页 #setting-zoom-snap（本文件自己绑定）
// ============================================================================
