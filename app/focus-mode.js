// ============================================================================
// focus-mode.js — 焦点模式（Focus Mode，"1+n"）引擎 —— WP1
// ----------------------------------------------------------------------------
// 一个窗口里放 1 个「主视图」+ n 个「缩略图」。缩略图是**真正的、活着的 webview**，
// 只是被画小了；它们和主视图跑在完全一样的帧率上。
//
// 【为什么用 transform: scale() 而不是把 webview 改小】
//   webview 在 Electron 11 里就是一个 OOPIF <iframe>。改它的布局尺寸 = 子帧 relayout
//   = Flash 舞台重新缩放一次（用户明确说不要这个抖动），而 transform 只是让父合成器
//   把子帧已经光栅化好的 Surface 乘一个矩阵再画一遍 —— GPU 级操作，不触发子帧
//   relayout，不改 guest 视口，不重建 compositor。
//   所以：**所有 tab 的 webview 布局尺寸恒等于主槽的 Mw×Mh**，切换时只改
//   left / top / transform，绝不改 width/height，绝不 remove/append/re-parent。
//
// 【transform 验证与 fallback】
//   方案 §1.3 要求先在 DevTools 里手工验证 transform 对 <webview> 合成正确。
//   本文件由无法运行 DevTools 的环境生成，**该验证尚未执行**。因此：
//     - 主路径 = transform（prefs.geometryMode === 'transform'，默认）。
//     - 备用路径 = 「固定布局尺寸 + setZoomFactor」（prefs.geometryMode === 'zoom'）。
//   两条路径都只在唯一的 applySlot() 里实现，切换不需要改动别处。
//   用户手工验证的方法（DevTools Console，任意时刻）：
//     const w = document.querySelector('webview.active');
//     w.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:700px;' +
//                       'transform:scale(.5);transform-origin:0 0';
//     // 预期：游戏以一半大小实时运行，GPU/plugin 进程占用无明显变化
//     w.style.cssText = '';   // 恢复
//   若结果是内容不缩放 / 被裁剪 / 事件错位，则在 Console 里执行：
//     XZFocus.setPrefs({ geometryMode: 'zoom' })
//   即可整体切到备用路径（会持久化到 localStorage）。
//
// 【明确不做的事（用户强制要求，改动前请先问用户）】
//   - 没有任何「回合检测 / 轮到你了 / 高亮 / 自动切换 / 声音提示」。一行都没有。
//     不做像素采样，不用 capturePage 生成缩略图 —— 缩略图就是真 webview 画小。
//   - 不对「对战中」的账号做任何降频 / 暂停 / visibility 变更。焦点模式下所有
//     可见的 webview 都保持 display:flex 且留在视口内，正是为了不被 Chromium 降频。
//     唯一允许消失的是用户主动开启 hideIdle 之后、被标为「挂机」的账号（.fm-hidden）。
//   - 不做每帧同步 IPC（setZoomFactor / setAudioMuted 是 invokeSync，只在切换时调）。
//   - 不用 backdrop-filter（见 index.html 的开发者笔记：它在 webview 上方会静默失效，
//     还会把 webview 拉进 backdrop root 让 Retina 上的游戏变软）。
//
// 运行环境：Electron 11.2.1 / Chromium 87。只用 ES2019 + 可选链 ?. + ??，
// 不用 ??= / ||= / .at() / replaceAll / class fields 之类 Chromium 87 没有的东西。
// 经典 script，靠裸标识符读 renderer.js 的顶层 const/let（同 aim-assist.js）。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 还没加载（或加载失败）时，整个模块安静地不存在，宿主的钩子
  // 都是 if (window.XZFocus) 守卫，行为与没有本文件时完全一致。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZFocus] renderer.js 作用域不可见，焦点模式未启用'); } catch (e) {}
    return;
  }

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  // ------------------------------------------------------------------ 常量
  // 缩略图只做「缩小」采样。1/2 时一个目标像素恰好平均 2×2 个源像素，最干净；
  // 1/3、1/4 可接受；奇怪的分数（0.37）会出现不均匀采样、细线闪烁。所以只用档位。
  // 档位阶梯。1/8、1/10 是为 6–8 个号准备的：滚出视口的缩略图会被 Chromium 降频，
  // 宁可小一点也要全部留在屏幕内。
  var SCALES = [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10];
  var COLLAPSED_SCALE = 1 / 8;   // 折叠：仍然可见、仍然全速，只是很小
  var PAD = 8;                   // 条带内边距
  var GAP = 8;                   // 缩略图间距
  var SWITCH_ANIM_MS = 260;      // 切换动画时长，和 focus-mode.css 里的 transition 保持一致
  var MAX_STRIP_FRAC = 0.32;     // 条带最多吃掉容器的多少（厚度方向）
  var BAR_W_FALLBACK = 180;      // 量不到 #focus-bar 时的保底尺寸
  var BAR_H_FALLBACK = 30;
  var DRAG_THRESHOLD = 6;        // 超过这个位移才算拖动，否则算点击
  var PREFS_KEY = 'xz.focus.prefs';

  // ------------------------------------------------- 分区布局（sector）常量
  // 「分区」= 每个账号固定占容器的一个角 / 一侧，焦点那个占大份，其余占小份。
  // 切换时每个账号都朝「自己那个角」缩 / 涨，格子一步不换 —— 靠位置认号。
  //
  // SECTOR_F = 焦点那一列（行）占内容区的比例，1−F 留给另一列（行）。
  // 0.68：主画面还剩 2/3 强，小格的缩放是 (1−F)/F ≈ 0.47，和条带里常用的
  // 1/2 档差不多大，一眼还看得清对面在干什么。想调就改这一个数。
  var SECTOR_F = 0.68;
  var SECTOR_MAX = 4;            // 分区最多 4 个号；≥5 个时本轮退回条带（不改 prefs）
  var SECTOR_MIN_W = 480;        // 容器小于这个尺寸时分区没意义，静静地用条带
  var SECTOR_MIN_H = 320;
  // 分区模式下控制簇竖条的宽度，必须与 focus-mode.css 的 --fm-rail 一致。
  var SECTOR_RAIL = 28;

  // ------------------------------------------------------------------ 偏好
  var DEFAULT_PREFS = {
    pos: 'bottom',           // 'bottom' | 'right'
    layout: 'strip',         // 'strip'（今天的行为，默认）| 'sector'（分区）
    animate: true,           // 切换时用过渡动画，而不是瞬间跳变
    muteThumbs: false,       // 条带里的账号默认有声：回合音效要听得到
    autoSize: true,          // 自动按账号数量挑档位；按过大小按钮后转为手动
    maxScale: 0.25,          // 手动模式下缩略图允许的最大档位
    collapsed: false,
    hideIdle: false,
    pinnedProfileId: null,
    autoEnter: false,
    geometryMode: 'transform' // 'transform'（默认）| 'zoom'（§1.3 fallback）
  };
  var prefs = loadPrefs();

  function loadPrefs() {
    var out = {};
    for (var k in DEFAULT_PREFS) out[k] = DEFAULT_PREFS[k];
    try {
      var raw = window.localStorage.getItem(PREFS_KEY);
      if (raw) {
        var got = JSON.parse(raw);
        if (got && typeof got === 'object') {
          if (got.pos === 'right' || got.pos === 'bottom') out.pos = got.pos;
          // 老版本的 prefs 里没有 layout：迁移为 'strip'，行为和今天完全一样。
          if (got.layout === 'sector' || got.layout === 'strip') out.layout = got.layout;
          if (typeof got.maxScale === 'number' && got.maxScale > 0) out.maxScale = got.maxScale;
          // 老版本的 prefs 里没有 autoSize：视为自动，别把用户锁在 1/4 上。
          out.autoSize = (typeof got.autoSize === 'boolean') ? got.autoSize : true;
          out.animate = (typeof got.animate === 'boolean') ? got.animate : true;
          out.muteThumbs = (typeof got.muteThumbs === 'boolean') ? got.muteThumbs : false;
          out.collapsed = !!got.collapsed;
          out.hideIdle = !!got.hideIdle;
          out.autoEnter = !!got.autoEnter;
          out.pinnedProfileId = got.pinnedProfileId ? String(got.pinnedProfileId) : null;
          if (got.geometryMode === 'zoom' || got.geometryMode === 'transform') out.geometryMode = got.geometryMode;
        }
      }
    } catch (e) {}
    return out;
  }
  // localStorage 按宿主页面分区，各窗口互不覆盖 —— 不放进 settings，那是整体回写的。
  function savePrefs() {
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  function setPrefs(patch) {
    if (!patch || typeof patch !== 'object') return getPrefs();
    var geomChanged = false;
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, k)) continue;
      if (k === 'geometryMode' && patch[k] !== prefs.geometryMode) geomChanged = true;
      prefs[k] = patch[k];
    }
    if (prefs.pos !== 'right') prefs.pos = 'bottom';
    if (prefs.layout !== 'sector') prefs.layout = 'strip';
    if (prefs.geometryMode !== 'zoom') prefs.geometryMode = 'transform';
    savePrefs();
    // 几何模式变了：先把旧模式留下的 inline 样式/zoom 全清掉，再重新铺一次。
    if (geomChanged && active) { forEachTab(clearSlot); lastMw = 0; lastMh = 0; }
    stripScroll = 0;
    if (active) { applyBodyClasses(); layout(); }
    updateBarState();
    return getPrefs();
  }
  function getPrefs() {
    var out = {};
    for (var k in prefs) out[k] = prefs[k];
    return out;
  }

  // ------------------------------------------------------------------ 会话状态
  // 「是否处于焦点模式」是每窗口的会话状态，不持久化（方案 §2.9）。
  var active = false;
  var listenTabId = null;      // 「听这个账号」：一次只能有一个
  var layoutPending = false;   // rAF 合并同一帧内的多次 layout 请求
  var lastGeom = null;         // 最近一次算出来的几何，拖动落点判定要用
  var lastMw = 0, lastMh = 0;  // 主槽尺寸；只有它变了才需要重算 fit 缩放
  var stripScroll = 0;         // ≥7 个账号时条带滚动偏移（沿条带方向）
  var sectorMaxWarned = false; // 「分区最多 4 个号」的提示每次只说一遍
  var ro = null;               // ResizeObserver
  var thumbMap = {};           // tabId -> .fm-thumb 元素
  var drag = null;             // 拖动排序的临时状态
  var domReady = false;
  var boundBar = false;
  var el = {};                 // 静态浮层元素引用

  // ------------------------------------------------------------------ 安全包装
  // renderer.js 的符号全部按需探测：任何一个缺席都只让对应的功能失效，不炸整个模块。
  function t_(key, fallback) {
    try { if (typeof tOr === 'function') return tOr(key, fallback); } catch (e) {}
    return fallback;
  }
  function toast(text) {
    try { if (typeof showToast === 'function') showToast(text); } catch (e) {}
  }
  function isHex(v) {
    try { if (typeof isHexColor === 'function') return isHexColor(v); } catch (e) {}
    return /^#[0-9a-f]{6}$/i.test(String(v || ''));
  }
  function hostOfSafe(url) {
    try { if (typeof hostOf === 'function') return hostOf(url) || ''; } catch (e) {}
    return '';
  }
  function profileList() {
    try { return Array.isArray(profiles) ? profiles : []; } catch (e) { return []; }
  }
  function findProfile(id) {
    if (!id) return null;
    var list = profileList();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function profileOf(tab) {
    if (!tab) return null;
    try { if (typeof tabProfile === 'function') return tabProfile(tab) || null; } catch (e) {}
    return findProfile(tab.profileId);
  }
  function acctColor(tab) {
    var p = profileOf(tab);
    return (p && isHex(p.color)) ? p.color : '';
  }
  function findTab(id) {
    if (id == null) return null;
    for (var i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].id === id) return tabs[i];
    return null;
  }
  function forEachTab(fn) {
    for (var i = 0; i < tabs.length; i++) { try { fn(tabs[i]); } catch (e) {} }
  }
  function activateSafe(id) {
    try { activateTab(id); } catch (e) {}
  }
  // 焦点模式内部一律走这个：hook #2（activateTab 末尾的 XZFocus.onActivated）
  // 还没落地时自己补一次几何/焦点/音频；落地之后这一步是幂等的。
  function activateAndSync(id) {
    var before = lastMainId;
    activateSafe(id);
    if (!active) return;
    if (lastMainId === before) onActivated(findTab(id));
  }
  function closeTabSafe(id) {
    try { if (typeof closeTab === 'function') closeTab(id); } catch (e) {}
  }
  function container() {
    try { if (typeof $webviews !== 'undefined' && $webviews) return $webviews; } catch (e) {}
    return document.getElementById('webviews-container');
  }
  function currentMain() {
    var m = null;
    try { m = findTab(activeId); } catch (e) { m = null; }
    return m || tabs[0] || null;
  }
  function dpr() {
    var d = window.devicePixelRatio;
    return (typeof d === 'number' && d > 0) ? d : 1;
  }
  // 把位置对齐到整数设备像素：缩略图边缘不会来回半像素抖动。
  function snap(v) {
    var d = dpr();
    return Math.round(v * d) / d;
  }

  // ------------------------------------------------------------------ 浮层 DOM
  // 正常情况下这些节点由 index.html（WP3）静态提供。万一 WP3 的标记还没落地，
  // 这里自己建一份等价结构 + 一份最小样式，模块仍可用（不覆盖 WP3 的样式表）。
  function ensureDom() {
    if (domReady) return !!el.layer;
    var host = container();
    if (!host) return false;
    el.layer = document.getElementById('focus-layer');
    var synthesized = false;
    if (!el.layer) {
      synthesized = true;
      el.layer = document.createElement('div');
      el.layer.id = 'focus-layer';
      el.layer.innerHTML =
        '<div id="focus-main-frame"></div>' +
        '<div id="focus-strip">' +
          '<div id="focus-bar">' +
            '<div class="fm-btn" id="fm-add">＋</div>' +
            '<div class="fm-btn" id="fm-pos">⇅</div>' +
            '<div class="fm-btn" id="fm-size-dn">−</div>' +
            '<div class="fm-btn" id="fm-size-up">+</div>' +
            '<div class="fm-btn" id="fm-hide-idle">挂</div>' +
            '<div class="fm-btn" id="fm-collapse">▾</div>' +
            '<div class="fm-btn" id="fm-exit">✕</div>' +
          '</div>' +
        '</div>' +
        '<div id="focus-thumbs"></div>' +
        '<div id="focus-shield"></div>';
      // 层必须在所有 webview 之前，靠 z-index 盖在上面（webview 是后 append 的）。
      host.insertBefore(el.layer, host.firstChild);
      injectFallbackStyle();
    }
    el.frame = document.getElementById('focus-main-frame');
    el.strip = document.getElementById('focus-strip');
    el.thumbs = document.getElementById('focus-thumbs');
    el.bar = document.getElementById('focus-bar');
    el.shield = document.getElementById('focus-shield');
    el.synthesized = synthesized;
    ensureLayoutBtn();
    bindBar();
    domReady = true;
    return true;
  }

  // #fm-layout（条带 ⇄ 分区）不在 index.html 的静态标记里 —— 那份标记归另一个
  // 工作包。缺了就自己补一个插在 #fm-exit 前面；已经有了就什么都不做，所以将来
  // 静态标记补上这个按钮也不会出现两个。
  function ensureLayoutBtn() {
    if (!el.bar) return;
    if (document.getElementById('fm-layout')) return;
    try {
      var b = document.createElement('div');
      b.className = 'fm-btn';
      b.id = 'fm-layout';
      b.textContent = '\u25A6';                 // ▦
      var exitBtn = document.getElementById('fm-exit');
      if (exitBtn && exitBtn.parentNode === el.bar) el.bar.insertBefore(b, exitBtn);
      else el.bar.appendChild(b);
    } catch (e) {}
  }

  // 只在我们自己造 DOM 时注入（= focus-mode.css 多半也不在）。WP3 落地后永不执行。
  function injectFallbackStyle() {
    if (document.getElementById('fm-fallback-style')) return;
    var s = document.createElement('style');
    s.id = 'fm-fallback-style';
    s.textContent = [
      'body.focus-mode webview{display:flex;inset:auto;transform-origin:0 0;will-change:transform}',
      'body.focus-mode webview.fm-hidden{display:none}',
      '#focus-layer{position:absolute;inset:0;z-index:5;pointer-events:none;display:none}',
      'body.focus-mode #focus-layer{display:block}',
      'body.focus-mode #webviews-container{background:var(--cream-bg-2,#eee);overflow:hidden}',
      // 底色在容器上（所有 webview 之下）。画在 #focus-strip 上会盖住活的缩略图。
      '#focus-strip{position:absolute;background:transparent;pointer-events:auto;',
      'border-top:1px solid var(--border,#ccc)}',
      'body.focus-strip-right #focus-strip{border-top:0;border-left:1px solid var(--border,#ccc)}',
      '#focus-thumbs{position:absolute;inset:0;pointer-events:none}',
      '.fm-thumb{position:absolute;pointer-events:auto;box-sizing:border-box;',
      'border:2px solid var(--acct,var(--border,#999));border-radius:4px;cursor:pointer;overflow:hidden}',
      '.fm-thumb[data-state="idle"]{border-style:dashed;opacity:.85}',
      '.fm-thumb.dragging{opacity:.6;z-index:2;pointer-events:none}',
      '.fm-name{position:absolute;left:2px;top:2px;max-width:60%;overflow:hidden;white-space:nowrap;',
      'text-overflow:ellipsis;padding:0 4px;border-radius:6px;font-size:10px;',
      'background:var(--acct,#666);color:var(--on-primary,#fff)}',
      '.fm-badges{position:absolute;right:2px;top:2px;display:flex;gap:2px;font-size:10px}',
      '.fm-title{position:absolute;left:2px;bottom:2px;right:2px;overflow:hidden;white-space:nowrap;',
      'text-overflow:ellipsis;font-size:9px;color:var(--text-secondary,#666)}',
      '#focus-main-frame{position:absolute;pointer-events:none;box-shadow:inset 0 0 0 2px var(--acct,transparent)}',
      '#focus-shield{position:absolute;inset:0;display:none;pointer-events:auto}',
      '#focus-shield.on{display:block}',
      '#focus-bar{position:absolute;right:8px;top:50%;transform:translateY(-50%);',
      'display:flex;gap:2px;padding:0 3px;z-index:1;pointer-events:auto;',
      'background:var(--cream-bg-2,#eee);border:1px solid var(--border,#ccc);border-radius:4px}',
      'body.focus-strip-right #focus-bar{left:8px;right:8px;top:auto;bottom:8px;',
      'transform:none;flex-wrap:wrap;justify-content:center;padding:3px}',
      '#focus-bar .fm-btn{width:22px;height:22px;display:flex;align-items:center;justify-content:center;',
      'border-radius:4px;font-size:12px;cursor:default;color:var(--text-primary,#222)}',
      '#focus-bar .fm-btn:hover{background:var(--hover-bg,rgba(0,0,0,.08))}',
      '#focus-bar .fm-btn.on{background:var(--main-orange,#F4A23C);color:var(--on-primary,#fff)}',
      '#focus-bar .fm-btn.disabled{opacity:.35}',
      // 分区模式：控制簇竖起来钉在左缘（见 focus-mode.css 同名规则）。
      'body.focus-layout-sector #focus-bar{left:8px;right:auto;top:50%;bottom:auto;',
      'transform:translateY(-50%);flex-direction:column;width:28px;padding:3px 0}',
      'body.focus-layout-sector #focus-bar #fm-pos,body.focus-layout-sector #focus-bar #fm-size-dn,',
      'body.focus-layout-sector #focus-bar #fm-size-up,body.focus-layout-sector #focus-bar #fm-collapse{display:none}',
      'body.focus-layout-sector .fm-thumb[data-current="1"]{pointer-events:none;border-style:solid;background:transparent}'
    ].join('');
    try { document.head.appendChild(s); } catch (e) {}
  }

  // =========================================================== 几何模型（§2.2）
  // 取不大于 v 的偶数整数（至少 min）。见 computeGeometry 里关于半像素的说明。
  function evenSize(v, min) {
    var n = Math.floor(v);
    if (n % 2) n -= 1;
    return Math.max(min, n);
  }
  function nearestScaleIndex(v) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < SCALES.length; i++) {
      var d = Math.abs(SCALES[i] - v);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // #focus-bar 在条带方向上吃掉的长度。量得到就量（内容驱动，折叠时会变窄），
  // 量不到用保底值。layout 不是每帧跑，这点强制回流可以接受。
  var lastScale = 0;              // 上一次实际采用的档位（自动档下 +/- 按钮以它为起点）
  var barCache = null;            // 每次 computeGeometry 只量一次，避免反复强制回流
  function barExtent(pos) {
    if (barCache && barCache.pos === pos) return barCache.v;
    var v = measureBar(pos);
    barCache = { pos: pos, v: v };
    return v;
  }
  function measureBar(pos) {
    try {
      if (el.bar && el.bar.offsetParent !== null) {
        var v = (pos === 'right') ? el.bar.offsetHeight : el.bar.offsetWidth;
        if (v > 0) return v + GAP;
      }
    } catch (e) {}
    return ((pos === 'right') ? BAR_H_FALLBACK : BAR_W_FALLBACK) + GAP;
  }
  // 条带的「厚度」方向上控制簇本身要多高/多宽 —— 缩略图全被隐藏时靠它撑出一条
  // 只放按钮的窄条，否则用户开了 hideIdle 之后就再也点不到那个按钮把它关掉了。
  function barCross(pos) {
    try {
      if (el.bar && el.bar.offsetParent !== null) {
        var v = (pos === 'right') ? el.bar.offsetWidth : el.bar.offsetHeight;
        if (v > 0) return v;
      }
    } catch (e) {}
    return (pos === 'right') ? BAR_W_FALLBACK : BAR_H_FALLBACK;
  }
  function mainSizeFor(s, pos, Cw, Ch) {
    if (pos === 'right') return { Mw: Math.max(160, (Cw - 2 * PAD) / (1 + s)), Mh: Ch };
    return { Mw: Cw, Mh: Math.max(120, (Ch - 2 * PAD) / (1 + s)) };
  }
  function fitsAt(s, n, pos, Cw, Ch) {
    var m = mainSizeFor(s, pos, Cw, Ch);
    // 条带方向：所有缩略图 + 控制簇要排得下。
    var need = 2 * PAD + n * ((pos === 'right' ? s * m.Mh : s * m.Mw) + GAP) - GAP + barExtent(pos);
    if (need > (pos === 'right' ? Ch : Cw)) return false;
    // 厚度方向：条带最多吃掉容器的 MAX_STRIP_FRAC。只开一两个号时，档位会一路涨到
    // 1/2，主画面反而被压掉三分之一 —— 主画面才是在打的那个，不能让给缩略图。
    var thick = (pos === 'right' ? s * m.Mw : s * m.Mh) + 2 * PAD;
    return thick <= MAX_STRIP_FRAC * (pos === 'right' ? Cw : Ch);
  }
  function pickScale(n, pos, Cw, Ch) {
    if (prefs.collapsed) return COLLAPSED_SCALE;
    var cands = [];
    // 自动档：所有档位都能选，fitsAt 会从大到小挑第一个放得下的 —— 开的账号越少，
    // 缩略图越大。手动档（用户按过 +/-）才用 maxScale 封顶。
    var ceil = prefs.autoSize ? SCALES[0] : prefs.maxScale;
    for (var i = 0; i < SCALES.length; i++) if (SCALES[i] <= ceil + 1e-6) cands.push(SCALES[i]);
    if (!cands.length) cands = [SCALES[SCALES.length - 1]];
    for (var j = 0; j < cands.length; j++) if (fitsAt(cands[j], n, pos, Cw, Ch)) return cands[j];
    // 都放不下：用最小档并允许条带滚动。滚出视口的 OOPIF 会被 Chromium 降频，
    // 这只在 ≥7 个账号时发生，是物理限制，接受。
    return cands[cands.length - 1];
  }

  function computeGeometry() {
    barCache = null;
    var host = container();
    if (!host) return null;
    var Cw = host.clientWidth, Ch = host.clientHeight;
    // 路由切走时 .route 是 display:none → 尺寸为 0，直接忽略，不要重排。
    if (!Cw || !Ch) return null;

    var main = currentMain();
    if (!main || !main.webview) return null;

    // 固定槽位：条带里每个账号都有一个恒定的位置，主视图那一格留空（画一个虚线占位
    // 框）。这样切换时其余缩略图一步都不动，肌肉记忆才立得住 —— 打游戏时靠位置认账号，
    // 位置一变就等于每回合重新找一遍。代价是浪费一格，值得。
    var thumbs = [], hidden = [], i, t;
    for (i = 0; i < tabs.length; i++) {
      t = tabs[i];
      if (!t || !t.webview) continue;
      // 只有用户主动开了 hideIdle、且账号被标为「挂机」时才允许它消失（=允许降频）。
      if (t !== main && prefs.hideIdle && t.profileId && getPlayState(t.profileId) === 'idle') hidden.push(t);
      else thumbs.push(t);
    }

    var pos = (prefs.pos === 'right') ? 'right' : 'bottom';
    var g = { pos: pos, main: main, thumbs: thumbs, hidden: hidden, Cw: Cw, Ch: Ch };
    var n = thumbs.length;

    // 本轮实际生效的布局。prefs.layout 说了算，但两种情况会临时退回条带
    // （**不动 prefs**，账号关掉之后自己就回到分区了）：
    //   - n ≥ 5：分区只有 2×2 四个格，第五个号没有地方放；提示一次。
    //   - 容器太小：分区切完每格都不够看，条带反而好用。
    // n ≤ 1 也走条带那条路 —— 它的 n<=1 分支正好是「主视图铺满容器、没有格子」。
    var eff = 'strip';
    if (prefs.layout === 'sector' && n >= 2) {
      if (n > SECTOR_MAX) {
        if (!sectorMaxWarned) {
          sectorMaxWarned = true;
          toast(t_('focus.sector_max', '分区模式最多 4 个账号，已临时按条带排列'));
        }
      } else if (Cw >= SECTOR_MIN_W && Ch >= SECTOR_MIN_H) {
        eff = 'sector';
      }
    }
    if (n <= SECTOR_MAX) sectorMaxWarned = false;
    g.layout = eff;
    // body 类必须在量 #focus-bar 之前落下：控制簇在条带里是横排、在分区里是竖排，
    // 方向不对的话 barExtent() 量出来的长度整个是歪的。
    applyBodyClasses(eff);
    if (eff === 'sector') return sectorGeometry(g, main, thumbs, Cw, Ch);

    if (n <= 1) {
      g.scale = 0; g.scroll = 0; g.maxScroll = 0; g.step = 0;
      if (hidden.length) {
        // 全部缩略图都被 hideIdle 藏起来了：留一条只放控制簇的窄条。
        var thick = barCross(pos) + 2 * PAD;
        if (pos === 'right') {
          g.Mw = evenSize(Cw - thick, 160); g.Mh = evenSize(Ch, 120);
          g.strip = { x: g.Mw, y: 0, w: Math.max(0, Cw - g.Mw), h: Ch };
        } else {
          g.Mw = evenSize(Cw, 160); g.Mh = evenSize(Ch - thick, 120);
          g.strip = { x: 0, y: g.Mh, w: Cw, h: Math.max(0, Ch - g.Mh) };
        }
      } else {
        g.Mw = evenSize(Cw, 160); g.Mh = evenSize(Ch, 120); g.strip = null;
      }
      return g;
    }

    var s = pickScale(n, pos, Cw, Ch);
    lastScale = s;
    var m = mainSizeFor(s, pos, Cw, Ch);
    // 画质：主槽尺寸取偶数整数。webview 的布局尺寸带小数时，Flash 的舞台会落在半像素
    // 上，Retina 屏看着就是"发虚"。偶数是为了 DSF=2 时缩一半仍是整像素。
    var Mw = evenSize(m.Mw, 160), Mh = evenSize(m.Mh, 120);
    // 画质：把档位微调到「缩放后正好是整数个设备像素」。1/3 这种除不尽的档位若不吸附，
    // 缩略图边缘会跨半个物理像素，合成器只能插值，看起来发毛。偏差 < 1/DSF 像素。
    var dpr = window.devicePixelRatio || 1;
    var span = (pos === 'right') ? Mh : Mw;
    var sSnap = Math.max(1, Math.round(s * span * dpr)) / (span * dpr);
    g.scale = sSnap; g.Mw = Mw; g.Mh = Mh;
    g.tw = sSnap * Mw; g.th = sSnap * Mh;

    // 条带矩形
    g.strip = (pos === 'right')
      ? { x: m.Mw, y: 0, w: Math.max(0, Cw - m.Mw), h: Ch }
      : { x: 0, y: m.Mh, w: Cw, h: Math.max(0, Ch - m.Mh) };

    // 滚动范围
    var step = (pos === 'right') ? (g.th + GAP) : (g.tw + GAP);
    var content = 2 * PAD + n * step - GAP + barExtent(pos);
    var avail = (pos === 'right') ? Ch : Cw;
    g.maxScroll = Math.max(0, content - avail);
    if (stripScroll > g.maxScroll) stripScroll = g.maxScroll;
    if (stripScroll < 0) stripScroll = 0;
    g.scroll = stripScroll;
    g.step = step;
    // 居中：控制簇是 CSS 钉在尾端的，所以缩略图在「首端内边距 ~ 控制簇之前」这段里居中。
    // 放不下需要滚动时退回左对齐（否则滚动起点会跑偏）。
    var slack = avail - content;
    g.lead = PAD + (slack > 0 ? slack / 2 : 0);
    return g;
  }

  // ====================================================== 分区几何（sector，§新增）
  // 【格子怎么分】
  //   n=2：一行两列 —— 0 = 左，1 = 右。
  //   n=3 / 4：两行两列 —— 0 = 左上，1 = 右上，2 = 左下，3 = 右下。
  //   序号 = 账号在「可见 tab 稳定次序」（thumbs 数组）里的位置，和条带的固定
  //   槽位用的是同一套次序。这个次序里没有「谁是焦点」这个变量，所以换焦点
  //   不会让任何一个账号换格子 —— 这正是分区模式存在的全部理由。
  //   （唯一会让格子变的是账号数变了：新开 / 关闭 tab，或 hideIdle 把挂机号
  //     从 thumbs 里摘掉。这些都是用户主动做的，和切换焦点无关。）
  //
  // 【尺寸：为什么切换时没有任何页面被 resize】
  //   内容区 W×H = 容器去掉外边距 PAD、再去掉左侧控制簇竖条。列之间、行之间
  //   各留一条 GAP。大格 bigW×bigH = F·(W−GAP) × F·(H−GAP)（n=2 只有一行，
  //   bigH = H）。bigW / bigH 只和 F 与容器有关，**和谁是焦点无关**，所以
  //   Mw×Mh 恒定：切换只改 transform，webview 的布局尺寸一个字节都不动。
  //   焦点视图因此永远是 scale 恰好 1，只有平移。
  //
  // 【非焦点视图】
  //   统一缩放 s = min(smallW/Mw, smallH/Mh)，吸附到整数设备像素（和条带同一套
  //   做法），然后贴着**自己那一侧**摆：第 0 列贴左缘、第 1 列贴右缘；两行时
  //   第 0 行贴上缘、第 1 行贴下缘；只有一行（n=2）时竖直居中 —— 那一侧只有
  //   「自己的边」，没有「自己的角」。
  //   贴边而不是在格子里居中，是为了让 260ms 的过渡看起来是「朝自己那一侧缩
  //   回去」：贴住的那条边在动画首尾坐标相同，而 translate+等比 scale 的矩阵
  //   插值对 (tx, s) 是线性的，x_edge = tx + s·Mw 两端相等 → 中间帧也不动。
  //   若改成居中，缩放中心就会跑到容器中央，看起来像「一起吸向屏幕中心」。
  //   贴边还白送一条很强的性质：第 0 列的 x 恒等于 x0，第 1 列的 x 恒等于
  //   x0+W−vw（因为 colX[1]+colW[1] ≡ x0+W，两列宽之和是常数）；行同理。
  //   也就是说**一个没在焦点上的账号，无论焦点在谁身上，它的小画面都在同一个
  //   像素位置**。每次切换真正动的只有两个 webview：旧主和新主。和条带的固定
  //   槽位是一模一样的性质，applySlot 的脏检查因此几乎不做无用写。
  //
  // 【n=3 空出来的那一格（index 3，右下）】
  //   结论：**不并给邻居，就让它空着**，因为并了也换不来一个像素。证明：
  //   小格和大格是同一组 F /(1−F) 切出来的，宽高比完全相同，所以
  //   s = min(cellW/Mw, cellH/Mh) 里两项在小格上同时取到最小值。空格和它的
  //   两个正交邻居各共享一条边：右上格与它同列（并过来只加高度），左下格与它
  //   同行（并过来只加宽度）—— 加的都是本来就富余的那条边，min() 纹丝不动。
  //   （四种焦点位置逐一验算过，结论一致。）真要变大只能同时加宽和加高，那需要
  //   把空格斜着分掉，矩形铺排做不到。
  //   并格唯一的效果是画出一个包着大片空白的框，反而更难看，所以这里不做。
  //   空着的这一格正好就是「第 4 个账号进来时会落的位置」：加号之后其余三个
  //   一步都不动。
  function sectorGeometry(g, main, thumbs, Cw, Ch) {
    var n = thumbs.length;                    // 调用方保证 2..SECTOR_MAX
    var rows = (n === 2) ? 1 : 2;
    var i, idx = 0;
    for (i = 0; i < thumbs.length; i++) { if (thumbs[i] === main) { idx = i; break; } }

    // 左侧竖条留给控制簇：分区模式没有条带可以装那几个按钮。代价是恒定的
    // SECTOR_RAIL 宽度，换来的是**零遮挡** —— 按钮底下不是游戏画面，永远不会
    // 有一次点击落进游戏里，也不会挡住任何一个号的画面。
    var x0 = PAD + SECTOR_RAIL + GAP;
    var y0 = PAD;
    var W = Cw - x0 - PAD;
    var H = Ch - 2 * PAD;

    var innerW = W - GAP;                                 // 两列之间一条 GAP
    var innerH = (rows === 2) ? (H - GAP) : H;            // 两行之间一条 GAP
    // 取整：列/行的边界必须落在整数 CSS 像素上，主视图的 translate 才是整数，
    // Retina 上游戏画面才不会糊（缩略图靠 snap() 兜底，主视图不能靠运气）。
    var bigW = Math.round(innerW * SECTOR_F);
    var bigH = (rows === 2) ? Math.round(innerH * SECTOR_F) : H;
    var smallW = innerW - bigW;
    var smallH = (rows === 2) ? (innerH - bigH) : H;
    // 画质：和条带一样，主槽（这里是大格）尺寸取偶数整数。
    var Mw = evenSize(bigW, 160), Mh = evenSize(bigH, 120);

    var fc = idx % 2;                                      // 焦点所在列
    var fr = (rows === 2) ? Math.floor(idx / 2) : 0;       // 焦点所在行
    var colW = [0, 0], rowH = [0, 0];
    colW[fc] = bigW; colW[1 - fc] = smallW;
    if (rows === 2) { rowH[fr] = bigH; rowH[1 - fr] = smallH; }
    else { rowH[0] = H; rowH[1] = 0; }
    var colX = [x0, x0 + colW[0] + GAP];
    var rowY = [y0, y0 + rowH[0] + GAP];

    // 非焦点视图的统一缩放，吸附到整数设备像素（同 computeGeometry 里的 sSnap）。
    var d = dpr();
    var sRaw = Math.min(smallW / Mw, smallH / Mh);
    var s = Math.max(1, Math.round(sRaw * Mw * d)) / (Mw * d);
    if (!(s > 0)) s = sRaw;
    if (s > 1) s = 1;

    g.pos = 'bottom';          // 分区没有「条带方向」；留一个合法值给共用代码
    g.scale = s; g.Mw = Mw; g.Mh = Mh;
    g.tw = s * Mw; g.th = s * Mh;
    g.step = 0; g.lead = PAD; g.scroll = 0; g.maxScroll = 0;
    g.rows = rows; g.focusIndex = idx;
    // #focus-strip 在分区模式下只当左侧竖条的底 / 右边框用（CSS 把 border-top
    // 换成 border-right）。它必须留在布局里，因为 #focus-bar 是它的子节点。
    g.strip = { x: 0, y: 0, w: PAD + SECTOR_RAIL + Math.round(GAP / 2), h: Ch };

    g.rects = [];
    for (i = 0; i < n; i++) {
      var c = i % 2;
      var r = (rows === 2) ? Math.floor(i / 2) : 0;
      var isMain = (i === idx);
      var vw = isMain ? Mw : g.tw;
      var vh = isMain ? Mh : g.th;
      var vx = (c === 0) ? colX[0] : (colX[1] + colW[1] - vw);
      var vy;
      if (rows === 1) vy = y0 + (H - vh) / 2;
      else vy = (r === 0) ? rowY[0] : (rowY[1] + rowH[1] - vh);
      g.rects.push({ x: vx, y: vy, w: vw, h: vh });
    }
    return g;
  }

  // 第 i 个缩略图「变换之后」在容器坐标系里的矩形（= 覆盖层 .fm-thumb 的位置）。
  // 分区模式下每一格（含焦点那一格）的矩形在 sectorGeometry 里就算好了。
  function thumbRect(g, i) {
    if (g && g.layout === 'sector') {
      var rc = g.rects && g.rects[i];
      return rc ? { x: rc.x, y: rc.y, w: rc.w, h: rc.h } : { x: 0, y: 0, w: 0, h: 0 };
    }
    var lead = (typeof g.lead === 'number') ? g.lead : PAD;
    if (g.pos === 'right') {
      return { x: g.Mw + PAD, y: lead + i * g.step - g.scroll, w: g.tw, h: g.th };
    }
    return { x: lead + i * g.step - g.scroll, y: g.Mh + PAD, w: g.tw, h: g.th };
  }

  // ============================================== 唯一触碰 webview 几何的地方（§2.4）
  // transform 路径：布局尺寸永远是 Mw×Mh，只改 left/top/transform。
  // zoom 路径（fallback）：真正把元素改小 + setZoomFactor(tab.zoom * scale)。
  function applySlot(tab, slot) {
    if (!tab || !tab.webview || !slot) return;
    // 脏检查：layout() 在每次 resize / 切换 / 重绘都会跑一遍，而绝大多数 webview 的
    // 几何其实没变。重复写同样的 inline style 一样会触发样式重算和合成层更新，白花钱。
    var sig = slot.role + '|' + snap(slot.x) + '|' + snap(slot.y) + '|' +
              Math.round(slot.w) + '|' + Math.round(slot.h) + '|' + slot.scale +
              '|' + prefs.geometryMode;
    if (tab._fmSlotSig === sig) return;
    tab._fmSlotSig = sig;
    var wv = tab.webview;
    try {
      var st = wv.style;
      st.position = 'absolute';
      // 样式表里 webview 是 inset:0，right/bottom 必须显式让位给 width/height。
      st.right = 'auto';
      st.bottom = 'auto';
      if (prefs.geometryMode === 'zoom') {
        st.left = snap(slot.x) + 'px';
        st.top = snap(slot.y) + 'px';
        st.transform = 'none';
        st.width = Math.max(1, Math.round(slot.w * slot.scale)) + 'px';
        st.height = Math.max(1, Math.round(slot.h * slot.scale)) + 'px';
        applyZoomForSlot(tab, slot);
      } else {
        // 位置和缩放都写进同一个 transform：left/top 是布局属性，逐帧改会让宿主页面
        // 反复重排；transform 是纯合成属性，可以直接交给 GPU 做过渡动画。
        st.left = '0px';
        st.top = '0px';
        st.width = Math.round(slot.w) + 'px';
        st.height = Math.round(slot.h) + 'px';
        st.transformOrigin = '0 0';
        var tx = snap(slot.x), ty = snap(slot.y);
        // 主视图停在 transform:none：aim-assist / 测距 / capturePage 全部按 1:1 算坐标。
        st.transform = (slot.scale === 1 && !tx && !ty)
          ? 'none'
          : ('translate3d(' + tx + 'px,' + ty + 'px,0) scale(' + slot.scale + ')');
      }
      wv.classList.toggle('fm-main', slot.role === 'main');
      wv.classList.toggle('fm-thumb-view', slot.role === 'thumb');
      wv.classList.toggle('fm-hidden', slot.role === 'hidden');
    } catch (e) {}
  }
  // setZoomFactor 是同步 IPC：只在目标值真的变了才调，绝不每帧调。
  function applyZoomForSlot(tab, slot) {
    var want = Math.max(0.2, Math.min(5, (tab.zoom || 1) * (slot.scale || 1)));
    if (tab._fmZoomWant === want) return;
    tab._fmZoomWant = want;
    try { tab.webview.setZoomFactor(want); } catch (e) {}
  }

  function clearSlot(tab) {
    if (!tab || !tab.webview) return;
    try {
      tab.webview.style.cssText = '';   // renderer.js 从不给 webview 写 inline style，清空是安全的
      tab.webview.classList.remove('fm-main', 'fm-thumb-view', 'fm-hidden');
      tab._fmSlotSig = null;
    } catch (e) {}
    if (tab._fmZoomWant != null) {
      tab._fmZoomWant = null;
      try { tab.webview.setZoomFactor(tab.zoom || 1); } catch (e) {}
    }
  }

  // ------------------------------------------------------------------ 布局
  function requestLayout() {
    if (!active || layoutPending) return;
    layoutPending = true;
    var run = function () { layoutPending = false; layout(); };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function layout() {
    layoutPending = false;
    if (!active) return;
    if (!ensureDom()) return;
    // computeGeometry() 要量 #focus-bar 才知道条带尾部要留多少，而量不到时只能
    // 用 180px 的保底值。上一轮可能把条带藏了（只剩 1 个 tab，或刚退出过一次），
    // 先把它放回布局里；不该显示时 paintOverlay() 立刻会再藏回去，中间不会绘制。
    if (el.strip && el.strip.style.display === 'none') el.strip.style.display = '';
    var g = computeGeometry();
    if (!g) return;
    lastGeom = g;
    var i;

    if (g.layout === 'sector') {
      // 分区：每个账号（含焦点那个）都有自己的格子，没有「留空的槽位」。
      // 焦点那个 scale 恒为 1，只有 translate —— 见 sectorGeometry 的说明。
      for (i = 0; i < g.thumbs.length; i++) {
        var rc = g.rects && g.rects[i];
        if (!rc) continue;
        var isMain = (g.thumbs[i] === g.main);
        applySlot(g.thumbs[i], {
          x: rc.x, y: rc.y, w: g.Mw, h: g.Mh,
          scale: isMain ? 1 : g.scale,
          role: isMain ? 'main' : 'thumb'
        });
      }
    } else {
      applySlot(g.main, { x: 0, y: 0, w: g.Mw, h: g.Mh, scale: 1, role: 'main' });
      for (i = 0; i < g.thumbs.length; i++) {
        if (g.thumbs[i] === g.main) continue;   // 主视图的槽位留空，只画占位框
        var r = thumbRect(g, i);
        applySlot(g.thumbs[i], { x: r.x, y: r.y, w: g.Mw, h: g.Mh, scale: g.scale, role: 'thumb' });
      }
    }
    // 隐藏（挂机）视图：几何照给，class 让 CSS 把它 display:none 掉。
    for (i = 0; i < g.hidden.length; i++) {
      applySlot(g.hidden[i], { x: 0, y: 0, w: g.Mw, h: g.Mh, scale: g.scale || 0.25, role: 'hidden' });
    }

    paintOverlay(g);

    // 主槽尺寸变了才重算 fit 缩放（等同于今天的窗口 resize），切换本身不触发。
    if (Math.abs(g.Mw - lastMw) > 0.5 || Math.abs(g.Mh - lastMh) > 0.5) {
      lastMw = g.Mw; lastMh = g.Mh;
      for (i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        if (!t || !t.fit || typeof t._applyZoom !== 'function') continue;
        // zoom fallback 下缩略图的 zoom 由我们接管，不能让 fit 把它顶回去。
        if (prefs.geometryMode === 'zoom' && t !== g.main) continue;
        try { t._applyZoom(); } catch (e) {}
      }
    }
  }

  // eff = 本轮**实际生效**的布局（不是 prefs：账号数超过 4 时分区会临时退回条带）。
  // 不传就按 prefs 猜一个，随后 computeGeometry() 会用真值再调一次；两次之间
  // 不会绘制。签名比对是因为 layout() 每次切换都会走到这里，而类几乎从不变。
  var bodyClassSig = null;
  function applyBodyClasses(eff) {
    var lay = (eff === 'sector' || eff === 'strip')
      ? eff
      : ((prefs.layout === 'sector') ? 'sector' : 'strip');
    var sector = active && lay === 'sector';
    var sig = (active ? 1 : 0) + '|' + lay + '|' + prefs.pos + '|' + (prefs.collapsed ? 1 : 0);
    if (bodyClassSig === sig) return;
    bodyClassSig = sig;
    var c = document.body.classList;
    c.toggle('focus-mode', active);
    c.toggle('focus-layout-sector', sector);
    c.toggle('focus-layout-strip', active && !sector);
    // 条带专属的两个类在分区模式下必须撤掉：CSS 里「条带在右侧 / 已折叠」的
    // 规则会去改 #focus-bar 的方向和按钮可见性，套在竖条上就全乱了。
    c.toggle('focus-strip-right', active && !sector && prefs.pos === 'right');
    c.toggle('focus-strip-collapsed', active && !sector && !!prefs.collapsed);
  }

  function paintOverlay(g) {
    // 主槽的账号色内描边（A 项）
    if (el.frame) {
      // 条带模式下主槽永远在 (0,0)；分区模式下主视图在自己那一格里，描边跟过去。
      // （分区里这条描边由 CSS 关掉了 —— 焦点那一格的 .fm-thumb 已经画了同一圈
      //   账号色边框，两条叠在一起会变成 4px。位置照算，方便将来改回来。）
      var mfx = 0, mfy = 0;
      if (g.layout === 'sector' && g.rects && g.rects[g.focusIndex]) {
        mfx = g.rects[g.focusIndex].x;
        mfy = g.rects[g.focusIndex].y;
      }
      var fs = el.frame.style;
      fs.display = '';
      fs.left = snap(mfx) + 'px';
      fs.top = snap(mfy) + 'px';
      fs.width = Math.round(g.Mw) + 'px';
      fs.height = Math.round(g.Mh) + 'px';
      el.frame.style.setProperty('--acct', acctColor(g.main));
      el.frame.dataset.profileId = (g.main && g.main.profileId) || '';
    }
    // 条带
    if (el.strip) {
      if (g.strip) {
        el.strip.style.display = '';
        el.strip.style.left = snap(g.strip.x) + 'px';
        el.strip.style.top = snap(g.strip.y) + 'px';
        el.strip.style.width = Math.round(g.strip.w) + 'px';
        el.strip.style.height = Math.round(g.strip.h) + 'px';
      } else {
        el.strip.style.display = 'none';
      }
    }
    paintThumbs(g);
    updateBarState();
  }

  // .fm-thumb 是 absolute，它的包含块是 #focus-thumbs 最近的 positioned 祖先。
  // WP3 的标记把 #focus-thumbs 放在 #focus-strip 里面，而 #focus-strip 是 absolute，
  // 所以缩略图的 inline 坐标必须先减去这个包含块相对容器的偏移，否则整条会偏移一个
  // 条带的距离。这里在运行时量，两种嵌套方式（层里 / 条带里）都算得对。
  // getBoundingClientRect + getComputedStyle 会强制同步布局。原点只在容器尺寸或条带
  // 位置变化时才可能变，所以按这两个值缓存，切换账号时一次都不用量。
  var originCache = null;
  function thumbOriginCached(g) {
    var key = g.layout + '|' + g.pos + '|' + Math.round(g.Cw) + '|' + Math.round(g.Ch);
    if (originCache && originCache.key === key) return originCache.v;
    var v = thumbOrigin();
    originCache = { key: key, v: v };
    return v;
  }
  function thumbOrigin() {
    var host = container();
    if (!host || !el.thumbs) return { x: 0, y: 0 };
    var base = el.thumbs;
    try {
      var cs = window.getComputedStyle(el.thumbs);
      if (!cs || cs.position === 'static') base = el.thumbs.offsetParent || host;
    } catch (e) { base = el.thumbs.offsetParent || host; }
    if (!base || base === host) return { x: 0, y: 0 };
    try {
      var a = base.getBoundingClientRect(), b = host.getBoundingClientRect();
      var bs = window.getComputedStyle(base);
      // 包含块是祖先的 padding box，所以要把边框宽度加回去。
      var bl = bs ? (parseFloat(bs.borderLeftWidth) || 0) : 0;
      var bt = bs ? (parseFloat(bs.borderTopWidth) || 0) : 0;
      return { x: (a.left - b.left) + bl, y: (a.top - b.top) + bt };
    } catch (e) { return { x: 0, y: 0 }; }
  }

  function paintThumbs(g) {
    if (!el.thumbs) return;
    var org = thumbOriginCached(g);
    var seen = {}, i, id;
    for (i = 0; i < g.thumbs.length; i++) {
      var tab = g.thumbs[i];
      var node = thumbMap[tab.id];
      if (!node) {
        node = buildThumb(tab.id);
        thumbMap[tab.id] = node;
        el.thumbs.appendChild(node);
      }
      seen[tab.id] = 1;
      // DOM 顺序跟着视觉顺序走
      if (el.thumbs.children[i] !== node) el.thumbs.insertBefore(node, el.thumbs.children[i] || null);
      paintThumbData(node, tab);
      if (tab === g.main) node.dataset.current = '1';
      else if (node.dataset.current) delete node.dataset.current;
      var r = thumbRect(g, i);
      var L = snap(r.x - org.x), T = snap(r.y - org.y);
      var W = Math.round(r.w), H = Math.round(r.h);
      var sig = L + '|' + T + '|' + W + '|' + H;
      if (node._fmSig !== sig) {
        node._fmSig = sig;
        node.style.left = L + 'px';
        node.style.top = T + 'px';
        node.style.width = W + 'px';
        node.style.height = H + 'px';
        // 账号名要一眼认得出：字号跟着缩略图宽度走，夹在 12–24px 之间。
        var fs = Math.max(12, Math.min(24, Math.round(W / 11)));
        node.style.setProperty('--fm-name-size', fs + 'px');
        node.style.setProperty('--fm-name-h', Math.round(fs * 1.7) + 'px');
      }
    }
    for (id in thumbMap) {
      if (seen[id]) continue;
      try { if (thumbMap[id].parentNode) thumbMap[id].parentNode.removeChild(thumbMap[id]); } catch (e) {}
      delete thumbMap[id];
    }
  }

  function buildThumb(tabId) {
    var node = document.createElement('div');
    node.className = 'fm-thumb';
    node.dataset.tabId = String(tabId);
    node.innerHTML = '<div class="fm-name"></div><div class="fm-badges"></div><div class="fm-title"></div>';
    node.addEventListener('pointerdown', onThumbPointerDown);
    node.addEventListener('pointermove', onThumbPointerMove);
    node.addEventListener('pointerup', onThumbPointerUp);
    node.addEventListener('pointercancel', onThumbPointerCancel);
    node.addEventListener('contextmenu', onThumbContextMenu);
    // 缩略图上的滚轮/双击/原生 click 一律吞掉：绝不透传给游戏。
    node.addEventListener('wheel', onThumbWheel, { passive: false });
    node.addEventListener('dblclick', swallow);
    node.addEventListener('click', swallow);
    node.addEventListener('auxclick', swallow);
    node.addEventListener('mousedown', function (e) {
      // 右键要留给 contextmenu：macOS 上菜单事件是从 mousedown 生出来的。
      if (e.button === 2) { e.stopPropagation(); return; }
      swallow(e);
    });
    return node;
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  function paintThumbData(node, tab) {
    var p = profileOf(tab);
    var color = (p && isHex(p.color)) ? p.color : '';
    var state = getPlayState(tab.profileId);
    node.dataset.tabId = String(tab.id);
    node.dataset.profileId = (p && p.id) || '';
    node.dataset.state = state;
    if (p && prefs.pinnedProfileId && p.id === prefs.pinnedProfileId) node.dataset.pinned = '1';
    else if (node.dataset.pinned) delete node.dataset.pinned;
    if (listenTabId === tab.id) node.dataset.listen = '1';
    else if (node.dataset.listen) delete node.dataset.listen;
    node.style.setProperty('--acct', color);

    var name = node.querySelector('.fm-name');
    var title = node.querySelector('.fm-title');
    var label = (p && (p.name || p.id)) || hostOfSafe(tab.url) || '';
    if (name && name.textContent !== label) name.textContent = label;
    var pageTitle = tab.title || hostOfSafe(tab.url) || '';
    if (title && title.textContent !== pageTitle) title.textContent = pageTitle;
    node.title = label ? (label + ' ｜ ' + pageTitle) : pageTitle;

    // 徽章：元素在才画，不在就删 —— 用 display 控制会和 WP3 的 CSS 打架。
    setBadge(node, 'state', state === 'battle' ? '\u2694' : '\uD83D\uDCA4', true,
      state === 'battle' ? t_('focus.state_battle', '对战中') : t_('focus.state_idle', '挂机'));
    setBadge(node, 'pin', '\uD83D\uDCCC', !!node.dataset.pinned, t_('focus.pin', '固定为主视图'));
    setBadge(node, 'audio', '\uD83D\uDD0A', !!(prefs.muteThumbs && node.dataset.listen), t_('focus.listen', '听这个账号'));
  }
  function setBadge(node, kind, text, on, title) {
    var box = node.querySelector('.fm-badges');
    if (!box) return;
    var b = box.querySelector('.fm-badge.' + kind);
    if (!on) {
      if (b && b.parentNode) b.parentNode.removeChild(b);
      return;
    }
    if (!b) {
      b = document.createElement('span');
      b.className = 'fm-badge ' + kind;
      box.appendChild(b);
    }
    if (b.textContent !== text) b.textContent = text;
    b.title = title || '';
  }

  // ================================================ 缩略图交互（§2.5）：点击 / 拖动
  // 事件全部由这层宿主 <div> 截获并 preventDefault：鼠标一进入 OOPIF 表面事件就归
  // guest 所有，所以「点缩略图」绝不能变成「在游戏里点了一下」。
  function tabOfNode(node) {
    return findTab(Number(node && node.dataset && node.dataset.tabId));
  }

  function onThumbPointerDown(e) {
    var node = e.currentTarget;
    if (e.button === 2) return;               // 右键交给 contextmenu
    e.preventDefault();                        // 不让焦点落到这个 div，键盘焦点留在游戏里
    e.stopPropagation();
    var tab = tabOfNode(node);
    if (!tab) return;
    if (e.button === 1) { drag = null; closeTabSafe(tab.id); return; }
    if (e.button !== 0) return;
    drag = { id: tab.id, node: node, x0: e.clientX, y0: e.clientY, moved: false, pid: e.pointerId };
    // 三道保险，因为鼠标一进入 OOPIF 表面事件就归 guest 所有：
    //   1) 指针捕获，把后续事件钉回这个 div；
    //   2) document 级监听（捕获阶段），万一 1 失败也收得到；
    //   3) #focus-shield 盖住主视图，让指针根本碰不到 guest。
    try { node.setPointerCapture(e.pointerId); } catch (err) {}
    bindDragDoc(true);
  }
  // 这三个 handler 只读 drag.node，不依赖 currentTarget，所以挂在 document 上
  // 和挂在缩略图上行为完全一样；两边都触发时第二次是 no-op（drag 已被清空）。
  function bindDragDoc(on) {
    var fn = on ? 'addEventListener' : 'removeEventListener';
    try {
      document[fn]('pointermove', onThumbPointerMove, true);
      document[fn]('pointerup', onThumbPointerUp, true);
      document[fn]('pointercancel', onThumbPointerCancel, true);
    } catch (e) {}
  }

  function onThumbPointerMove(e) {
    if (!drag || drag.pid !== e.pointerId) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      showShield(true);
      drag.node.classList.add('dragging');
    }
    e.preventDefault();
    drag.node.style.transform = 'translate(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px)';
    paintDropIndicator(dropSlotFor(e.clientX, e.clientY, drag.id));
  }

  function onThumbPointerUp(e) {
    if (!drag || drag.pid !== e.pointerId) return;
    var d = drag;
    drag = null;
    bindDragDoc(false);
    try { d.node.releasePointerCapture(e.pointerId); } catch (err) {}
    showShield(false);
    d.node.classList.remove('dragging');
    d.node.style.transform = '';
    paintDropIndicator(-1);
    e.preventDefault();
    e.stopPropagation();
    if (!d.moved) { activateAndSync(d.id); return; }
    var to = dropIndexFor(dropSlotFor(e.clientX, e.clientY, d.id), d.id);
    // moveTab 是 renderer.js 的新函数（WP2 hook #8）。它不在就只是不排序，不报错。
    if (to != null && typeof moveTab === 'function') { try { moveTab(d.id, to); } catch (err) {} }
    requestLayout();
  }

  function onThumbPointerCancel(e) {
    if (!drag || drag.pid !== e.pointerId) return;
    var d = drag;
    drag = null;
    bindDragDoc(false);
    try { d.node.releasePointerCapture(e.pointerId); } catch (err) {}
    showShield(false);
    d.node.classList.remove('dragging');
    d.node.style.transform = '';
    paintDropIndicator(-1);
  }

  // 落点在「去掉被拖那个之后」的缩略图序列里的插入位置 k（0..rest.length）
  function dropSlotFor(cx, cy, dragId) {
    var g = lastGeom;
    if (!g || !g.thumbs || !g.thumbs.length) return -1;
    var host = container();
    if (!host) return -1;
    var box = host.getBoundingClientRect();
    if (g.layout === 'sector') {
      // 分区是二维的，没有「插到第几个缝里」这回事：落在哪一格上就要哪一格的
      // 位置。取离指针最近的格心即可（格子不重叠，指针在格内时它一定最近）。
      // 返回的就是目标格序号 k —— dropIndexFor() 把 k 当作「最终可见次序里的
      // 位置」，正好是我们要的语义。
      var best = 0, bd = Infinity, j;
      for (j = 0; j < g.thumbs.length; j++) {
        var rr = thumbRect(g, j);
        var ddx = (cx - box.left) - (rr.x + rr.w / 2);
        var ddy = (cy - box.top) - (rr.y + rr.h / 2);
        var dd = ddx * ddx + ddy * ddy;
        if (dd < bd) { bd = dd; best = j; }
      }
      return best;
    }
    var p = (g.pos === 'right') ? (cy - box.top) : (cx - box.left);
    var k = 0;
    for (var i = 0; i < g.thumbs.length; i++) {
      if (g.thumbs[i].id === dragId) continue;
      var r = thumbRect(g, i);
      var mid = (g.pos === 'right') ? (r.y + r.h / 2) : (r.x + r.w / 2);
      if (p < mid) return k;
      k++;
    }
    return k;
  }
  // 把插入位置换算成 moveTab 需要的 index（moveTab 先 splice 掉再插入，所以按
  // 「移除之后的 tabs」算）。
  function dropIndexFor(k, dragId) {
    if (k < 0 || !lastGeom) return null;
    var rest = [], i;
    for (i = 0; i < lastGeom.thumbs.length; i++) if (lastGeom.thumbs[i].id !== dragId) rest.push(lastGeom.thumbs[i]);
    var after = [];
    for (i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].id !== dragId) after.push(tabs[i]);
    var anchor = rest[k] || null;
    if (!anchor) return after.length;
    var idx = after.indexOf(anchor);
    return idx < 0 ? after.length : idx;
  }
  function paintDropIndicator(k) {
    var g = lastGeom, i;
    for (i in thumbMap) thumbMap[i].classList.remove('drop-before', 'drop-after', 'drop-into');
    if (k < 0 || !g || !drag) return;
    if (g.layout === 'sector') {
      // 分区：没有「缝」，直接把目标格整个高亮。
      var target = g.thumbs[k] && thumbMap[g.thumbs[k].id];
      if (target) target.classList.add('drop-into');
      return;
    }
    var rest = [];
    for (i = 0; i < g.thumbs.length; i++) if (g.thumbs[i].id !== drag.id) rest.push(g.thumbs[i]);
    if (!rest.length) return;
    if (k >= rest.length) {
      var last = thumbMap[rest[rest.length - 1].id];
      if (last) last.classList.add('drop-after');
    } else {
      var node = thumbMap[rest[k].id];
      if (node) node.classList.add('drop-before');
    }
  }
  function showShield(on) {
    if (on) endSwitchAnim();
    if (!el.shield) return;
    el.shield.classList.toggle('on', !!on);
  }

  // 条带放不下时用滚轮平移（≥7 个账号）。滚轮绝不透传给游戏。
  function onThumbWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    var g = lastGeom;
    if (!g || !g.maxScroll) return;
    var d = (Math.abs(e.deltaY) > Math.abs(e.deltaX)) ? e.deltaY : e.deltaX;
    var next = Math.max(0, Math.min(g.maxScroll, stripScroll + d));
    if (next === stripScroll) return;
    stripScroll = next;
    requestLayout();
  }

  // ------------------------------------------------------------ 右键菜单（§4.8）
  function onThumbContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    var tab = tabOfNode(e.currentTarget);
    if (!tab) return;
    showThumbMenu(tab, e.clientX, e.clientY);
  }

  function menuItem(menu, text, fn, checked, disabled) {
    var item = document.createElement('div');
    item.className = 'menu-item' + (checked ? ' check' : '') + (disabled ? ' disabled' : '');
    item.textContent = text;
    if (!disabled) {
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        try { if (typeof closeAnyMenus === 'function') closeAnyMenus(); } catch (e) {}
        try { fn(); } catch (e) {}
      });
    }
    menu.appendChild(item);
    return item;
  }
  function menuSep(menu) {
    var d = document.createElement('div');
    d.className = 'menu-sep';
    menu.appendChild(d);
  }
  // renderer 的 placeMenuUnder 需要一个锚点元素；缩略图菜单跟着鼠标走，所以自己定位。
  function placeMenuAt(menu, x, y) {
    var margin = 8;
    menu.style.left = Math.max(margin, x) + 'px';
    menu.style.top = Math.max(margin, y) + 'px';
    var w = menu.offsetWidth, h = menu.offsetHeight;
    if (x + w > window.innerWidth - margin) menu.style.left = Math.max(margin, window.innerWidth - margin - w) + 'px';
    if (y + h > window.innerHeight - margin) menu.style.top = Math.max(margin, window.innerHeight - margin - h) + 'px';
  }

  function showThumbMenu(tab, x, y) {
    try { if (typeof closeAnyMenus === 'function') closeAnyMenus(); } catch (e) {}
    var p = profileOf(tab);
    var pinned = !!(p && prefs.pinnedProfileId && prefs.pinnedProfileId === p.id);
    var battle = getPlayState(tab.profileId) === 'battle';
    var listening = listenTabId === tab.id;
    var menu = document.createElement('div');
    menu.className = 'menu fm-menu';
    menuItem(menu, t_('focus.switch_to', '切到此账号'), function () { activateAndSync(tab.id); });
    menuItem(menu, pinned ? t_('focus.unpin', '取消固定') : t_('focus.pin', '固定为主视图'),
      function () { pin(pinned ? null : tab.id); }, pinned);
    menuItem(menu, battle ? t_('focus.set_idle', '标为挂机') : t_('focus.set_battle', '标为对战中'),
      function () { setPlayState(tab.profileId, battle ? 'idle' : 'battle'); }, false, !tab.profileId);
    if (prefs.muteThumbs) {
      menuItem(menu, listening ? t_('focus.listen_off', '不听这个账号') : t_('focus.listen', '听这个账号'),
        function () { setListen(listening ? null : tab.id); }, listening);
    }
    menuItem(menu, prefs.muteThumbs ? t_('focus.unmute_thumbs', '取消条带静音') : t_('focus.mute_thumbs', '条带全部静音'),
      function () { setPrefs({ muteThumbs: !prefs.muteThumbs }); audioAll(); }, prefs.muteThumbs);
    menuSep(menu);
    menuItem(menu, t_('focus.detach', '移到新窗口'),
      function () { try { if (typeof detachTab === 'function') detachTab(tab.id); } catch (e) {} });
    menuItem(menu, t_('focus.close', '关闭此标签页'), function () { closeTabSafe(tab.id); });
    document.body.appendChild(menu);
    placeMenuAt(menu, x, y);
    try { if (typeof armMenuClose === 'function') armMenuClose(); } catch (e) {}
  }

  // ------------------------------------------------------------ 条带控制簇
  function bindBar() {
    if (boundBar) return;
    boundBar = true;
    bindBtn('fm-add', function (btn) { showAddMenu(btn); });
    bindBtn('fm-pos', function () { setPrefs({ pos: prefs.pos === 'right' ? 'bottom' : 'right' }); });
    bindBtn('fm-size-dn', function () { stepScale(-1); });
    bindBtn('fm-size-up', function () { stepScale(1); });
    bindBtn('fm-hide-idle', function () { setPrefs({ hideIdle: !prefs.hideIdle }); });
    bindBtn('fm-collapse', function () {
      var next = !prefs.collapsed;
      setPrefs({ collapsed: next });
      // 物理约束：不可见 = 被 Chromium 降频。折叠只能缩到 1/8，不能真的藏起来。
      if (next) toast(t_('focus.collapsed_hint', '折叠后仍保留小预览，游戏不会掉帧'));
    });
    bindBtn('fm-layout', function () { toggleLayout(); });
    bindBtn('fm-exit', function () { exit(); });
  }
  // 条带 ⇄ 分区。不在焦点模式时也允许改：只是把偏好存下来，下次进入就是新布局。
  function toggleLayout() {
    var next = (prefs.layout === 'sector') ? 'strip' : 'sector';
    setPrefs({ layout: next });
    // 不在焦点模式时按 ⌘⇧D 也生效，但屏幕上什么都不会变，得说一声。
    if (!active) {
      toast(next === 'sector'
        ? t_('focus.layout_next_sector', '下次进入焦点模式使用分区布局')
        : t_('focus.layout_next_strip', '下次进入焦点模式使用条带布局'));
    }
  }
  function bindBtn(id, fn) {
    var b = document.getElementById(id);
    if (!b) return;
    // 按钮也在 webview 上方：吞掉 mousedown，别让焦点或点击漏进游戏。
    b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (b.classList.contains('disabled')) return;
      try { fn(b); } catch (err) {}
    });
  }
  function stepScale(dir) {
    // 自动档下第一次按 +/-：从"当前实际用的档位"起步，而不是从上次的 maxScale。
    var base = prefs.autoSize ? (lastScale || prefs.maxScale) : prefs.maxScale;
    var i = nearestScaleIndex(base) - dir;             // dir=+1 → 更大 → index 更小
    i = Math.max(0, Math.min(SCALES.length - 1, i));
    if (!prefs.autoSize && SCALES[i] === prefs.maxScale) return;
    setPrefs({ autoSize: false, maxScale: SCALES[i] });
  }
  var barSig = null;
  function updateBarState() {
    // 每次 layout 都会走到这里，但按钮状态几乎从不变。先比一次签名，省掉 7 次 DOM 写。
    var sigNow = [(lastGeom && lastGeom.layout) || prefs.layout, prefs.layout,
                  prefs.hideIdle, prefs.collapsed, prefs.pos, prefs.autoSize,
                  prefs.maxScale, lastScale, prefs.muteThumbs, prefs.layout,
                  i18nStamp()].join('|');
    if (barSig === sigNow) return;
    barSig = sigNow;
    setBtn('fm-hide-idle', prefs.hideIdle,
      prefs.hideIdle ? t_('focus.show_idle', '显示挂机账号') : t_('focus.hide_idle', '折叠挂机账号'));
    setBtn('fm-collapse', prefs.collapsed,
      prefs.collapsed ? t_('focus.expand', '展开条带') : t_('focus.collapse', '折叠条带'));
    setBtn('fm-pos', prefs.pos === 'right',
      prefs.pos === 'right' ? t_('focus.pos_bottom', '条带放在底部') : t_('focus.pos_right', '条带放在右侧'));
    var effLayout = (lastGeom && lastGeom.layout) ? lastGeom.layout : prefs.layout;
    setBtn('fm-layout', effLayout === 'sector',
      prefs.layout === 'sector'
        ? t_('focus.layout_strip', '切回条带布局')
        : t_('focus.layout_sector', '切到分区布局'));
    setBtn('fm-add', false, t_('focus.add', '在此窗口添加账号'));
    setBtn('fm-exit', false, t_('focus.exit', '退出焦点模式'));
    var i = nearestScaleIndex(prefs.autoSize ? (lastScale || prefs.maxScale) : prefs.maxScale);
    setBtn('fm-size-up', false, t_('focus.size_up', '缩略图更大'), i <= 0);
    setBtn('fm-size-dn', false, t_('focus.size_dn', '缩略图更小'), i >= SCALES.length - 1);
  }
  // 语言变了要让按钮标题重画一次：把当前语言并进签名里。
  function i18nStamp() {
    try { return (typeof i18n === 'object' && i18n && typeof i18n.getLang === 'function') ? i18n.getLang() : ''; } catch (e) { return ''; }
  }
  function setBtn(id, on, title, disabled) {
    var b = document.getElementById(id);
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.classList.toggle('disabled', !!disabled);
    if (title) b.title = title;
  }

  // #fm-add：列出本窗口还没有 tab 的账号 + 「全部」。与 renderer 的批量打开一致，
  // 每 700ms 开一个，全部开完再把主视图还给原来那个账号。
  function showAddMenu(anchor) {
    try { if (typeof closeAnyMenus === 'function') closeAnyMenus(); } catch (e) {}
    var menu = document.createElement('div');
    menu.className = 'menu profile-menu fm-menu';
    var head = document.createElement('div');
    head.className = 'menu-head';
    head.textContent = t_('focus.add', '在此窗口添加账号');
    menu.appendChild(head);

    var have = {}, i;
    for (i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].profileId) have[tabs[i].profileId] = 1;
    var list = profileList(), missing = [];
    for (i = 0; i < list.length; i++) if (list[i] && !have[list[i].id]) missing.push(list[i]);

    if (!missing.length) {
      menuItem(menu, t_('focus.no_more_accounts', '所有账号都已经在这个窗口里了'), function () {}, false, true);
    } else {
      for (i = 0; i < missing.length; i++) {
        (function (p) {
          var item = menuItem(menu, p.name || p.id, function () { openProfiles([p.id]); });
          var dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = isHex(p.color) ? p.color : '#888';
          item.insertBefore(dot, item.firstChild);
        })(missing[i]);
      }
      if (missing.length > 1) {
        menuSep(menu);
        menuItem(menu, t_('focus.add_all', '全部账号'), function () {
          openProfiles(missing.map(function (p) { return p.id; }));
        });
      }
    }
    if (anchor && typeof placeMenuUnder === 'function') {
      try { placeMenuUnder(menu, anchor); } catch (e) { document.body.appendChild(menu); }
    } else {
      document.body.appendChild(menu);
    }
    if (!menu.parentNode) document.body.appendChild(menu);
    try { if (typeof armMenuClose === 'function') armMenuClose(); } catch (e) {}
  }
  // 加号批量开账号：后台创建 + 串行。
  // 旧做法是 i*700 的固定梯子、每个都抢焦点，最后再切回来 —— 一回合只有 5–10 秒，
  // 中途被切走就等于这一局白打。现在每个 tab 都用 background:true 建（createTab 里
  // 已经跑过 XZFocus.onTabCreated → layout()，所以槽位照样有），并且等它自己的
  // did-stop-loading 再开下一个，一次只让一个 webview 在加载。
  var OPEN_STEP_TIMEOUT_MS = 15000;
  function openProfiles(ids) {
    if (typeof createTab !== 'function' || !ids || !ids.length) return;
    var cur = null;
    try { cur = (typeof activeTab === 'function') ? activeTab() : null; } catch (e) {}
    var keepId = cur ? cur.id : null;
    var url = cur ? cur.url : (typeof homeUrl === 'string' ? homeUrl : null);
    var list = ids.slice();

    // did-stop-loading 和 15 秒超时二选一，先到者胜；webview 拿不到就立刻放行。
    function afterLoaded(tab, next) {
      var done = false, timer = null, wv = null;
      function finish() {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { if (wv) wv.removeEventListener('did-stop-loading', finish); } catch (e) {}
        try { next(); } catch (e) {}
      }
      try { wv = tab ? tab.webview : null; } catch (e) { wv = null; }
      if (!wv) { finish(); return; }
      try { wv.addEventListener('did-stop-loading', finish, { once: true }); }
      catch (e) { finish(); return; }
      timer = setTimeout(finish, OPEN_STEP_TIMEOUT_MS);
    }

    function step(i) {
      if (i >= list.length) {
        // 保险：全程不该切走，但万一有别的路径动了主视图就切回来。
        try {
          var now = (typeof activeTab === 'function') ? activeTab() : null;
          if (keepId != null && (!now || now.id !== keepId) && findTab(keepId)) activateAndSync(keepId);
        } catch (e) {}
        return;
      }
      var tab = null;
      try { tab = createTab(url, { profileId: list[i], background: true }); } catch (e) { tab = null; }
      afterLoaded(tab, function () { step(i + 1); });
    }
    step(0);
  }

  // ------------------------------------------------------------ 音频（§2.7）
  // 焦点模式下只有主视图（或用户指定的「听这个账号」）出声。全局静音、单 tab 静音
  // 的原逻辑照常叠加 —— 这个函数只负责「强制静音」这一层。
  // 默认不静音条带里的账号：轮到谁是靠游戏自己的音效听出来的，静音了就等于把
  // 唯一的回合提示掐掉。muteThumbs 打开时才回到「只听主画面（外加一个例外）」。
  // 单个账号想静音，走原来的每标签页静音（右键菜单 / 标签页上的喇叭）即可。
  function forcesMute(tab) {
    if (!active || !tab) return false;
    if (!prefs.muteThumbs) return false;
    var mainId = null;
    try { mainId = activeId; } catch (e) {}
    if (tab.id === mainId) return false;
    if (listenTabId != null && tab.id === listenTabId) return false;
    return true;
  }
  function setListen(tabId) {
    listenTabId = (tabId == null) ? null : tabId;
    try { if (typeof applyAudioMute === 'function') applyAudioMute(); } catch (e) {}
    requestLayout();
  }

  // ------------------------------------------------------------ B 项：对战 / 挂机
  // playState 挂在 profile 上，走 profiles:upsert（Object.assign 合并），
  // 因此会持久化并广播到所有窗口；main.js 的 parkOthers 据此跳过对战中的账号。
  function getPlayState(profileId) {
    var p = findProfile(profileId);
    return (p && p.playState === 'battle') ? 'battle' : 'idle';
  }
  function setPlayState(profileId, state) {
    if (!profileId) return Promise.resolve(null);
    var v = (state === 'battle') ? 'battle' : 'idle';
    var p = findProfile(profileId);
    if (p) p.playState = v;          // 本地先行，广播回来再对齐（幂等）
    requestLayout();
    try {
      if (typeof upsertProfile === 'function') {
        return upsertProfile({ id: profileId, playState: v }).catch(function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }

  // ------------------------------------------------------------ Pin（§2.8）
  function pin(tabId) {
    if (tabId == null) { setPrefs({ pinnedProfileId: null }); return; }
    var tab = findTab(tabId);
    var p = profileOf(tab);
    setPrefs({ pinnedProfileId: p ? p.id : null });
  }
  function pinCurrent() {
    var cur = currentMain();
    if (!cur) return;
    var p = profileOf(cur);
    if (!p) return;
    var already = prefs.pinnedProfileId === p.id;
    setPrefs({ pinnedProfileId: already ? null : p.id });
    toast(already
      ? t_('focus.unpinned_toast', '已取消固定')
      : t_('focus.pinned_toast', '已固定 {name} 为主视图').replace('{name}', p.name || p.id));
  }
  function pinnedTab() {
    if (!prefs.pinnedProfileId) return null;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i] && tabs[i].profileId === prefs.pinnedProfileId) return tabs[i];
    }
    return null;
  }
  // renderer 的 closeTab 钩子：被关掉的 tab 已经从 tabs 里 splice 走了。
  // 返回 null → 宿主沿用原来的「邻居」逻辑。
  // 签名跟 renderer.js hook #4 对齐：它传被关闭 tab 在 splice 前的下标。
  // 这里只靠 pinned 决定，idx 仅供宿主的回落逻辑参考，本函数不用它。
  function pickAfterClose(idx) {   // eslint-disable-line no-unused-vars
    if (!active) return null;
    var t = pinnedTab();
    return t ? t.id : null;
  }

  // ------------------------------------------------------------ 切换（§2.3）
  var lastMainId = null;

  function focusGame(tab) {
    if (!tab || !tab.webview) return;
    // Electron 11 里 webview.focus() 就是 contentWindow.focus()。
    try { tab.webview.focus(); } catch (e) {}
    // 再让 preload 把页面里最大的 embed/object/iframe 也 focus 一下，Flash 才会
    // 直接吃键盘 —— 用户点完缩略图就能按空格/方向键，不必再点一次游戏。
    if (!tab.ready) return;                       // dom-ready 之前 send() 会抛
    try { if (typeof tab.webview.send === 'function') tab.webview.send('xz:focus-game'); } catch (e) {}
  }
  function audioFor(tab) {
    if (!tab) return;
    try { if (typeof applyAudioMute === 'function') applyAudioMute(tab); } catch (e) {}
  }
  function audioAll() {
    try { if (typeof applyAudioMute === 'function') applyAudioMute(); } catch (e) {}
  }

  // ------------------------------------------------------------ 进入 / 退出
  function isActive() { return active; }

  function enter() {
    if (active) return;
    if (!tabs.length) { toast(t_('focus.need_tabs', '先打开至少一个标签页')); return; }
    if (!ensureDom()) { toast(t_('focus.no_dom', '焦点模式的界面元素缺失')); return; }
    active = true;
    stripScroll = 0; lastMw = 0; lastMh = 0;
    sectorMaxWarned = false;
    applyBodyClasses();
    startObserver();
    var curId = null;
    try { curId = activeId; } catch (e) {}
    // pin 只在「进入时」抬一次；之后用户的主动切换永远说了算。
    var target = pinnedTab() || currentMain();
    if (target) {
      // 走 activateTab 而不是自己铺：它会把路由切回 browser（否则容器是 0 尺寸，
      // 什么也算不出来），并在末尾的钩子里回到 onActivated 做几何 / 焦点 / 音频。
      lastMainId = (target.id === curId) ? curId : null;
      activateSafe(target.id);
      if (!active) return;         // activateTab 里出了意外就别往下走
      if (!lastGeom) { layout(); focusGame(currentMain()); }   // hook #2 未落地时兜底
    } else {
      lastMainId = curId;
      layout();
      focusGame(currentMain());
    }
    audioAll();                    // 一次性把所有 tab 的静音状态对齐
    paintStripAccents();
    updateStripButton();
  }

  function exit() {
    if (!active) return;
    active = false;
    endSwitchAnim();
    stopObserver();
    if (drag) {
      showShield(false);
      bindDragDoc(false);
      try { drag.node.classList.remove('dragging'); drag.node.style.transform = ''; } catch (e) {}
      drag = null;
    }
    applyBodyClasses();            // 先撤 body 类，webview 的 display 规则自然回到 .active
    forEachTab(clearSlot);
    clearOverlay();
    listenTabId = null;
    lastGeom = null; lastMainId = null;
    lastMw = 0; lastMh = 0; stripScroll = 0;
    audioAll();
    // 主视图回到整个容器宽度，fit 的 tab 要按新宽度重算
    forEachTab(function (t) {
      if (t && t.fit && typeof t._applyZoom === 'function') { try { t._applyZoom(); } catch (e) {} }
    });
    updateStripButton();
  }

  function toggle() { if (active) exit(); else enter(); }

  function clearOverlay() {
    for (var id in thumbMap) {
      try { if (thumbMap[id].parentNode) thumbMap[id].parentNode.removeChild(thumbMap[id]); } catch (e) {}
      delete thumbMap[id];
    }
    if (el.strip) el.strip.style.display = 'none';
    if (el.frame) el.frame.style.display = 'none';
    showShield(false);
  }

  // ------------------------------------------------------------ 尺寸观察
  function startObserver() {
    if (ro) return;
    var host = container();
    if (!host) return;
    if (typeof window.ResizeObserver === 'function') {
      try {
        ro = new window.ResizeObserver(function () {
          if (!active) return;
          var h = container();
          // 路由切走时 .route 是 display:none → 尺寸 0，直接忽略，不重排。
          if (!h || !h.clientWidth || !h.clientHeight) return;
          requestLayout();
        });
        ro.observe(host);
        return;
      } catch (e) { ro = null; }
    }
    ro = { fallback: true };
    window.addEventListener('resize', onWindowResize);
  }
  function stopObserver() {
    if (!ro) return;
    if (ro.fallback) window.removeEventListener('resize', onWindowResize);
    else { try { ro.disconnect(); } catch (e) {} }
    ro = null;
  }
  function onWindowResize() { if (active) requestLayout(); }

  // ------------------------------------------------------------ A 项：账号色
  // tab strip 上的账号色条。WP2 的 hook #6 在 paintTabLabel 里做同一件事；
  // 这里只是兜底，写的是同一个值，两边同时存在也不会打架。
  function paintStripAccent(tab) {
    if (!tab || !tab.stripEl) return;
    try { tab.stripEl.style.setProperty('--acct', acctColor(tab)); } catch (e) {}
  }
  function paintStripAccents() { forEachTab(paintStripAccent); }

  function updateStripButton() {
    var b = document.getElementById('strip-focus');
    if (!b) return;
    b.classList.toggle('on', active);
    b.title = t_('focus.toggle', '焦点模式 ⌘⇧F');
  }

  // ------------------------------------------------------------ renderer 钩子
  // 全部要求：不在焦点模式时是 O(1) 的 no-op。
  function onTabCreated(tab) {
    paintStripAccent(tab);
    if (!active) {
      if (prefs.autoEnter && tabs.length >= 2) setTimeout(function () { if (!active) enter(); }, 0);
      return;
    }
    // 同步铺一次：新 webview 在被显示之前就拿到 slot，避免一帧的全屏闪现。
    layout();
  }

  function onActivated(tab) {
    if (!active) return;
    var prevId = lastMainId;
    var t = tab || currentMain();
    lastMainId = t ? t.id : null;
    beginSwitchAnim(prevId, t);
    layout();                       // 同步，不能等 rAF：切换必须在同一帧内完成
    focusGame(t);
    // 只有「旧主」和「新主」的静音状态会变，没必要对所有 tab 发同步 IPC。
    var prev = findTab(prevId);
    if (prev && (!t || prev.id !== t.id)) audioFor(prev);
    audioFor(t);
  }

  // 切换时给 webview 的 transform 开一段过渡：小窗放大到主槽、主槽缩回小窗。
  // 只在切换这一下开，resize / 拖动 / 滚动都不带动画（那些场合动画只会显得迟钝）。
  // 键盘焦点在 layout() 之后立刻交出去，动画纯粹是视觉，不拖慢操作。
  var switchAnimTimer = null;
  function beginSwitchAnim(prevId, t) {
    if (!prefs.animate || prefs.geometryMode === 'zoom') return;
    if (!prevId || !t || prevId === t.id) return;   // 首次进入 / 原地不动：不做动画
    try { document.body.classList.add('fm-switching'); } catch (e) {}
    if (switchAnimTimer) clearTimeout(switchAnimTimer);
    switchAnimTimer = setTimeout(endSwitchAnim, SWITCH_ANIM_MS + 60);
  }
  function endSwitchAnim() {
    if (switchAnimTimer) { clearTimeout(switchAnimTimer); switchAnimTimer = null; }
    try { document.body.classList.remove('fm-switching'); } catch (e) {}
  }

  function onTabClosed(tab) {
    endSwitchAnim();
    if (tab) {
      var n = thumbMap[tab.id];
      if (n) {
        try { if (n.parentNode) n.parentNode.removeChild(n); } catch (e) {}
        delete thumbMap[tab.id];
      }
      if (listenTabId === tab.id) listenTabId = null;
      if (lastMainId === tab.id) lastMainId = null;
      clearSlot(tab);
    }
    if (!active) return;
    if (!tabs.length) { clearOverlay(); lastGeom = null; return; }
    requestLayout();
  }

  function onTabsChanged() {
    paintStripAccents();
    if (!active) return;
    requestLayout();
  }

  function onProfilesChanged() {
    paintStripAccents();
    updateStripButton();
    if (!active) return;
    requestLayout();
  }

  // ⌘1–⌘8：焦点模式下且本窗口已有该账号的 tab → 就地切换，不去抢 OS 窗口。
  function switchToProfile(profileId) {
    if (!active || !profileId) return false;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i] && tabs[i].profileId === profileId) {
        activateAndSync(tabs[i].id);
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ 菜单 / 快捷键
  // ⌘⇧F 与 ⌘⇧P 走 main.js 的 View 菜单 accelerator，这里自己收 action，
  // 不去改 renderer.js 的 switch —— 否则会双触发。
  if (ipcRenderer) {
    try {
      ipcRenderer.on('action', function (_e, a) {
        if (a === 'toggle-focus-mode') toggle();
        else if (a === 'focus-pin') pinCurrent();
        // ⌘⇧D（菜单项由另一个工作包加在 main.js 里；⌘⇧L 已被「恢复上次布局」占用）：条带 ⇄ 分区。
        else if (a === 'focus-layout') toggleLayout();
      });
      // hook #9 没落地时也能跟上账号改名/改色（renderer 自己的监听先注册，
      // 所以轮到我们时 profiles 已经是新的了；重复触发是幂等的）。
      ipcRenderer.on('profiles:changed', function () { onProfilesChanged(); });
    } catch (e) {}
  }

  // ------------------------------------------------------------ 启动
  (function boot() {
    var btn = document.getElementById('strip-focus');
    if (btn) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggle(); });
    }
    updateStripButton();
    paintStripAccents();
  })();

  // ------------------------------------------------------------ 公共接口（§3.5）
  window.XZFocus = {
    isActive: isActive,
    enter: enter,
    exit: exit,
    toggle: toggle,
    toggleLayout: toggleLayout,

    onTabCreated: onTabCreated,
    onActivated: onActivated,
    onTabClosed: onTabClosed,
    onTabsChanged: onTabsChanged,
    onProfilesChanged: onProfilesChanged,
    pickAfterClose: pickAfterClose,
    forcesMute: forcesMute,
    switchToProfile: switchToProfile,

    setPlayState: setPlayState,
    getPlayState: getPlayState,
    pin: pin,
    getPrefs: getPrefs,
    setPrefs: setPrefs,

    // 契约之外的小工具，方便在 DevTools 里做 §1.3 的验证与排错。
    _relayout: function () { if (active) layout(); },
    _geometry: function () { return lastGeom; }
  };
})();

// ============================================================================
// 本文件通过 tOr(key, 中文兜底) 引用的 i18n 键。截至写作时，除 focus.no_dom 外
// 全部已在 i18n.js 的 en / zh-CN 字典里（WP2 已落地）。键缺失时显示中文兜底，不会坏。
//
//   focus.toggle          焦点模式 ⌘⇧F                  #strip-focus 的 title
//   focus.exit            退出焦点模式                    #fm-exit
//   focus.add             在此窗口添加账号                 #fm-add / 添加菜单标题
//   focus.add_all         全部账号                        添加菜单
//   focus.no_more_accounts 所有账号都已经在这个窗口里了      添加菜单（无可加账号）
//   focus.pos_bottom      条带放在底部                    #fm-pos（当前在右侧时）
//   focus.pos_right       条带放在右侧                    #fm-pos（当前在底部时）
//   focus.size_up         缩略图更大                      #fm-size-up
//   focus.size_dn         缩略图更小                      #fm-size-dn
//   focus.collapse        折叠条带                        #fm-collapse
//   focus.expand          展开条带                        #fm-collapse（已折叠时）
//   focus.hide_idle       折叠挂机账号                    #fm-hide-idle
//   focus.show_idle       显示挂机账号                    #fm-hide-idle（已开启时）
//   focus.collapsed_hint  折叠后仍保留小预览，游戏不会掉帧   折叠时的 toast
//   focus.need_tabs       先打开至少一个标签页              无 tab 时进入的 toast
//   focus.switch_to       切到此账号                      缩略图右键菜单
//   focus.pin             固定为主视图                    右键菜单 / 徽章 title
//   focus.unpin           取消固定                        右键菜单
//   focus.pinned_toast    已固定 {name} 为主视图            ⌘⇧P（含 {name} 占位符）
//   focus.unpinned_toast  已取消固定                       ⌘⇧P
//   focus.set_battle      标为对战中                      右键菜单
//   focus.set_idle        标为挂机                        右键菜单
//   focus.state_battle    对战中                          缩略图 ⚔ 徽章 title
//   focus.state_idle      挂机                            缩略图 💤 徽章 title
//   focus.listen          听这个账号                      右键菜单 / 🔊 徽章 title
//   focus.listen_off      不听这个账号                     右键菜单（已在听时）
//   focus.detach          移到新窗口                       右键菜单
//   focus.close           关闭此标签页                     右键菜单
//
// 还缺一个键（WP2 补一下，缺了也只是显示中文兜底）：
//   focus.no_dom          焦点模式的界面元素缺失
//                         en: "Focus mode UI is missing from this page"
//                         —— 只在 #focus-layer 既不在 index.html 里、也建不出来时出现。
//
// 分区布局（sector）新增的键，同样缺了只显示中文兜底：
//   focus.layout_sector   切到分区布局                    #fm-layout（当前是条带时）
//                         en: "Switch to sector layout"
//   focus.layout_strip    切回条带布局                    #fm-layout（当前是分区时）
//                         en: "Switch back to strip layout"
//   focus.sector_max      分区模式最多 4 个账号，已临时按条带排列
//                         en: "Sector layout fits at most 4 accounts — using the strip for now"
//                         —— 账号数 ≥5 时提示一次，prefs.layout 不变，关掉几个就自己回去了。
//
// 本文件不引用、但方案 §4 提到的键：focus.enter / focus.mode /
// tools.focus_mode / layout.park_skipped —— 由 WP2 自己使用。
// ============================================================================
