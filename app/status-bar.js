// ============================================================================
// status-bar.js — 状态条（Status Bar）—— 第三轮 WP2，window.XZStatus
// ----------------------------------------------------------------------------
// #app 底部的一行 18px：界面帧率 · 负载 · 每个账号的连接状态。
//
// 【为什么它在文档流里，而不是浮在游戏上】
//   #app 是 flex column（index.html 743），子元素依次是 #tab-strip / #topbar /
//   #layout(flex:1)。状态条是第 4 个 flex 子元素，占 18px，#layout → #main →
//   #webviews-container 自动缩小 18px。所以它**永远不会盖住一个游戏像素**，
//   也就不需要挡板、不需要 backdrop-filter、不需要任何合成层。
//   setGameMode()（renderer 974）只收顶栏与侧栏，不动 #app 的其它子元素，
//   所以游戏模式下状态条照常在 —— 打游戏时正是最想看负载的时候。
//
// 【采样成本（这是本模块唯一值得担心的事）】
//   帧率：一个 requestAnimationFrame 循环，回调只做 frames++；每 1000ms 用
//         setInterval 结算一次。只在可见时跑，隐藏立刻 cancelAnimationFrame +
//         clearInterval。成本 = 每帧一次空函数调用。
//   负载：每 2000ms 一次 ipcRenderer.invoke('status:metrics', …)。主进程侧
//         status-metrics.js 把 app.getAppMetrics() 的结果缓存 1500ms，多窗口共用。
//         getWebContentsId() 是同步但极廉价的调用，且只对 dom-ready 之后的 tab 调。
//   连接状态：纯事件驱动（webview 的 did-start-loading / crashed / …），无轮询。
//   DOM 写入：每次只写变化过的文本节点（setText/setTitle 有缓存），账号点只在
//         tab 集合变化时重建。
//
// 【绝不碰 guest】
//   本文件对 <webview> 只做两件事：addEventListener（被动听它自己发的事件）和
//   getWebContentsId（读一个整数 id）。不截图、不向 guest 发消息、不注入脚本、
//   不静音、不节流、不隐藏、不暂停、不 re-parent、不 resize，没有任何像素采样。
//   唯一一次改缩放是用户**显式**开关状态条时对 fit 标签页调一次 renderer 自己的
//   _applyZoom()（方案 §2.2 明确要求，因为容器高度变了）；采样路径里一次都没有。
//   帧率因此只能是**本窗口界面的帧率**：Flash 影片自己的帧率必须在 guest 里跑
//   代码才读得到，那是红线，所以文案（status.fps / status.fps_tip）如实写成
//   「界面帧率」，绝不冒充游戏帧率。
//
// 运行环境：Electron 11.2.1 / Chromium 87。ES5 语法（var / function，无箭头、
// 无模板串、无 let/const、无解构、无可选链），经典 script，靠裸标识符读
// renderer.js 的顶层符号（同 aim-assist.js / focus-mode.js）。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 还没加载（或加载失败）时安静地不存在，宿主的钩子都是
  // if (window.XZStatus) 守卫，行为与没有本文件时完全一致。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZStatus] renderer.js 作用域不可见，状态条未启用'); } catch (e) {}
    return;
  }

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  // ------------------------------------------------------------------ 常量
  var FPS_INTERVAL_MS = 1000;    // 帧率结算周期
  var LOAD_INTERVAL_MS = 2000;   // 负载采样周期（主进程侧还有 1500ms 缓存）
  var BOOT_FALLBACK_MS = 3000;   // xz:boot 缺席时的兜底启动延时

  // 状态 → i18n 键 + 中文兜底。顺序即严重程度，crashed/plugin 最重。
  var STATE_TEXT = {
    loading: ['status.state_loading', '加载中'],
    ok:      ['status.state_ok',      '正常'],
    failed:  ['status.state_failed',  '加载失败'],
    crashed: ['status.state_crashed', '页面已崩溃'],
    plugin:  ['status.state_plugin',  'Flash 已崩溃'],
    hung:    ['status.state_hung',    '无响应']
  };

  // ------------------------------------------------------------------ 状态
  var host = null, elFps = null, elLoad = null, elAcct = null, elClose = null;
  var alive = false;      // DOM 宿主齐全且已初始化；false 时全模块是空操作
  var booted = false;
  var visible = false;
  var hintedOnce = false; // 本窗口本次会话是否已经提示过重排

  var fpsRaf = 0, fpsTimer = 0, loadTimer = 0;
  var frames = 0, fpsMark = 0, fpsValue = 0;
  var loadBusy = false;
  var lastLoad = null;

  // tab → 连接状态。WeakMap 在 Chromium 87 是内置的（这是运行时能力，不是 ES5 语法），
  // 没有它就退回挂在 tab 上的私有属性。
  var states = (typeof WeakMap === 'function') ? new WeakMap() : null;

  var acctNodes = {};     // tabId -> { root, dot, nm }
  var acctSig = '';       // 当前渲染出来的 tab id 序列，变了才重建 DOM

  // ------------------------------------------------------------------ 小工具
  function t_(key, zh) {
    try { return (typeof tOr === 'function') ? tOr(key, zh) : zh; } catch (e) { return zh; }
  }
  function now() {
    try {
      if (window.performance && typeof window.performance.now === 'function') return window.performance.now();
    } catch (e) {}
    return Date.now();
  }
  // 每秒都在跑的写入路径：值没变就一个字节都不动 DOM。
  function setText(el, s) {
    if (!el) return;
    if (el.__xzText === s) return;
    el.__xzText = s;
    try { el.textContent = s; } catch (e) {}
  }
  function setTitle(el, s) {
    if (!el) return;
    if (el.__xzTitle === s) return;
    el.__xzTitle = s;
    try { el.title = s; } catch (e) {}
  }
  function toast(msg) {
    try { if (msg && typeof showToast === 'function') showToast(msg); } catch (e) {}
  }
  // activeId 是 renderer.js 的顶层 let，理论上一直可见；读它也包一层。
  function currentActiveId() {
    try { return activeId; } catch (e) { return -1; }
  }
  function findTab(id) {
    try {
      for (var i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].id === id) return tabs[i];
    } catch (e) {}
    return null;
  }
  // null / undefined / NaN 都显示「—」，绝不拿 0 冒充「测到了」。
  function pct(v) {
    if (v === null || v === undefined) return '—';
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return String(Math.round(n));
  }
  function stateLabel(s) {
    var row = STATE_TEXT[s] || STATE_TEXT.ok;
    return t_(row[0], row[1]);
  }

  // ------------------------------------------------------------ 连接状态跟踪
  function stateFor(tab) {
    if (!tab) return null;
    try {
      if (states) return states.get(tab) || null;
    } catch (e) {}
    return tab._xzState || null;
  }
  function setState(tab, s) {
    if (!tab) return;
    if (stateFor(tab) === s) return;
    try {
      if (states) states.set(tab, s); else tab._xzState = s;
    } catch (e) { tab._xzState = s; }
    if (visible) paintAcct(tab);
  }

  // 只挂被动监听器；一个 tab 只挂一次。
  function watchTab(tab) {
    if (!tab || !tab.webview || tab.__xzWatched) return;
    tab.__xzWatched = true;
    var wv = tab.webview;
    function on(ev, fn) { try { wv.addEventListener(ev, fn); } catch (e) {} }
    // did-fail-load 后 Chromium 还会再发一次 did-stop-loading，直接 setState('ok')
    // 会把刚刚的 failed 盖掉（错误页也算“加完了”）。用一个每次开始
    // 加载时清零的标记拦住那次覆盖。
    on('did-start-loading', function () {
      tab.__xzLoadFailed = false;
      setState(tab, 'loading');
    });
    on('did-stop-loading', function () {
      if (!tab.__xzLoadFailed) setState(tab, 'ok');
    });
    on('did-fail-load', function (e) {
      // 子框架（广告 iframe）失败不算这个页面坏了；errorCode -3 = ERR_ABORTED，
      // 是用户自己停掉 / 被重定向打断，也不算故障。
      if (e && e.isMainFrame === false) return;
      if (e && e.errorCode === -3) return;
      tab.__xzLoadFailed = true;
      setState(tab, 'failed');
    });
    on('crashed', function () { setState(tab, 'crashed'); });
    on('render-process-gone', function () { setState(tab, 'crashed'); });
    on('plugin-crashed', function () { setState(tab, 'plugin'); });   // Flash 挂了
    on('unresponsive', function () { setState(tab, 'hung'); });
    on('responsive', function () { setState(tab, 'ok'); });   // 从“无响应”恢复，与加载结果无关
    on('destroyed', function () { setState(tab, null); });
  }

  // ------------------------------------------------------------------ 帧率
  function fpsTick() {
    frames++;
    if (!visible) { fpsRaf = 0; return; }
    try { fpsRaf = window.requestAnimationFrame(fpsTick); } catch (e) { fpsRaf = 0; }
  }
  function publishFps() {
    var t = now(), dt = t - fpsMark;
    if (dt < 200) return;                       // 定时器抖动，等下一轮
    fpsValue = Math.round(frames * 1000 / dt);  // 用实际经过时间算，窗口被遮挡时自动回落
    frames = 0;
    fpsMark = t;
    paintFps();
  }
  function startFps() {
    if (fpsTimer) return;
    frames = 0;
    fpsMark = now();
    try { fpsRaf = window.requestAnimationFrame(fpsTick); } catch (e) { fpsRaf = 0; }
    try { fpsTimer = window.setInterval(publishFps, FPS_INTERVAL_MS); } catch (e) { fpsTimer = 0; }
  }
  function stopFps() {
    if (fpsRaf) { try { window.cancelAnimationFrame(fpsRaf); } catch (e) {} fpsRaf = 0; }
    if (fpsTimer) { try { window.clearInterval(fpsTimer); } catch (e) {} fpsTimer = 0; }
    frames = 0;
  }
  function paintFps() {
    if (!elFps) return;
    setText(elFps, t_('status.fps', '界面 {n} 帧').replace('{n}', String(fpsValue)));
  }

  // ------------------------------------------------------------------ 负载
  function sampleLoad(force) {
    if (!ipcRenderer || loadBusy) return;
    if (!visible && !force) return;
    var payload = [];
    try {
      for (var i = 0; i < tabs.length; i++) {
        var tb = tabs[i];
        // dom-ready 之前 getWebContentsId() 会抛；renderer 的 tab.ready 正是那个时机。
        if (!tb || !tb.ready || !tb.webview) continue;
        var wcId = 0;
        try { wcId = tb.webview.getWebContentsId(); } catch (e) { wcId = 0; }
        if (wcId) payload.push({ id: tb.id, wcId: wcId });
      }
    } catch (e) { payload = []; }
    loadBusy = true;
    try {
      ipcRenderer.invoke('status:metrics', payload).then(function (r) {
        loadBusy = false;
        lastLoad = r || null;
        if (!alive) return;
        paintLoad();
        paintAllAccts();
      }, function () {
        loadBusy = false;
      });
    } catch (e) {
      loadBusy = false;
    }
  }
  function startLoad() {
    if (loadTimer || !ipcRenderer) return;
    sampleLoad(true);
    try { loadTimer = window.setInterval(sampleLoad, LOAD_INTERVAL_MS); } catch (e) { loadTimer = 0; }
  }
  function stopLoad() {
    if (loadTimer) { try { window.clearInterval(loadTimer); } catch (e) {} loadTimer = 0; }
  }
  function paintLoad() {
    if (!elLoad) return;
    var d = lastLoad;
    var s = t_('status.load', 'CPU {total}% · Flash {plugin}% · GPU进程 {gpu}%');
    s = s.replace('{total}', pct(d ? d.total : null))
         .replace('{plugin}', pct(d ? d.plugin : null))
         .replace('{gpu}', pct(d ? d.gpu : null));
    setText(elLoad, s);
    // GPU 一项必须写清楚是「GPU 进程的 CPU 时间」，Electron 11 拿不到真正的显卡占用。
    setTitle(elLoad, t_('status.load_tip',
      '全部进程的大致 CPU 占用（app.getAppMetrics，每 2 秒采样一次）。GPU 一项是 GPU 进程的 CPU 时间，不是真正的显卡占用。'));
  }

  // ------------------------------------------------------------- 账号连接点
  function tabsSignature() {
    var out = [];
    try {
      for (var i = 0; i < tabs.length; i++) if (tabs[i]) out.push(tabs[i].id);
    } catch (e) {}
    return out.join(',');
  }
  function rebuildAccts() {
    if (!elAcct) return;
    try { while (elAcct.firstChild) elAcct.removeChild(elAcct.firstChild); } catch (e) {}
    acctNodes = {};
    var i, tb;
    for (i = 0; i < tabs.length; i++) {
      tb = tabs[i];
      if (!tb) continue;
      var root = document.createElement('span');
      root.className = 'sb-acct';
      var dot = document.createElement('span');
      dot.className = 'dot';
      var nm = document.createElement('span');
      nm.className = 'nm';
      root.appendChild(dot);
      root.appendChild(nm);
      bindAcctClick(root, tb.id);
      elAcct.appendChild(root);
      acctNodes[tb.id] = { root: root, dot: dot, nm: nm };
    }
    acctSig = tabsSignature();
  }
  // 独立函数而不是循环里的闭包：ES5 里 var 没有块作用域。
  function bindAcctClick(root, id) {
    root.addEventListener('mousedown', function (ev) {
      // 不让状态条抢走游戏的键盘焦点。
      try { ev.preventDefault(); } catch (e) {}
    });
    root.addEventListener('click', function () {
      try { activateTab(id); } catch (e) {}
    });
  }
  function paintAcct(tab) {
    if (!tab) return;
    var n = acctNodes[tab.id];
    if (!n) return;
    var p = null;
    try { p = (typeof tabProfile === 'function') ? tabProfile(tab) : null; } catch (e) { p = null; }
    var name = '';
    try { name = (typeof tabProfileName === 'function' ? tabProfileName(tab) : '') || ''; } catch (e) { name = ''; }
    if (!name) {
      try { name = (typeof hostOf === 'function' ? hostOf(tab.url) : '') || ''; } catch (e) { name = ''; }
    }
    var color = (p && p.color) || '';
    try {
      if (color) n.root.style.setProperty('--acct', color);
      else n.root.style.removeProperty('--acct');
    } catch (e) {}
    setText(n.nm, name);
    var st = stateFor(tab) || (tab.loading ? 'loading' : 'ok');
    try {
      n.root.setAttribute('data-state', st);
      n.root.setAttribute('data-active', tab.id === currentActiveId() ? '1' : '0');
    } catch (e) {}
    var cpu = null, shared = 1;
    if (lastLoad && lastLoad.perTab && lastLoad.perTab[tab.id]) {
      cpu = lastLoad.perTab[tab.id].cpu;
      shared = lastLoad.perTab[tab.id].shared || 1;
    }
    var tip = t_('status.acct_tip', '{name} · {state} · 页面 CPU {cpu}%')
      .replace('{name}', name).replace('{state}', stateLabel(st)).replace('{cpu}', pct(cpu));
    // 同一渲染进程被多个标签页共用时，那个 CPU 数字是进程的、不是这一个页面的。
    if (shared > 1) tip += ' ×' + shared;
    setTitle(n.root, tip);
  }
  function paintAllAccts() {
    if (!visible) return;
    try {
      for (var i = 0; i < tabs.length; i++) paintAcct(tabs[i]);
    } catch (e) {}
  }
  // 隐藏时一个 DOM 节点都不建：状态条关着的时候本模块对开关标签页是零成本的。
  // 重新显示时 setVisible() 会用 force=true 整体重建，acctSig 陈旧也没关系。
  function renderAccounts(force) {
    if (!alive || !elAcct || !visible) return;
    if (force || tabsSignature() !== acctSig) rebuildAccts();
    paintAllAccts();
  }

  // ------------------------------------------------------------------ 显隐
  function persistFlag(on) {
    try {
      if (typeof settings === 'undefined' || !settings) return;
      settings.statusBar = !!on;
      if (typeof saveSettings === 'function') saveSettings();
    } catch (e) {}
  }
  // 状态条占掉 18px，容器高度变了。fit 的标签页要重算一次缩放：窗口尺寸没变，
  // renderer 的 window resize 监听（2558）不会触发。焦点模式有自己的
  // ResizeObserver，会自动 relayout，这里不去碰它。
  function relayoutFitTabs() {
    try {
      // 焦点模式开着时它的 ResizeObserver 会自己重铺（zoom 兜底路径下缩略图的 zoom
      // 归它管，这里再调 _applyZoom 会把缩略图顶回 fit 值）。
      try { if (window.XZFocus && typeof window.XZFocus.isActive === 'function' && window.XZFocus.isActive()) return; } catch (e) {}
      window.setTimeout(function () {
        try {
          for (var i = 0; i < tabs.length; i++) {
            var tb = tabs[i];
            if (tb && tb.fit && typeof tb._applyZoom === 'function') {
              try { tb._applyZoom(); } catch (e) {}
            }
          }
        } catch (e) {}
      }, 0);
    } catch (e) {}
  }
  function setVisible(on, persist, quiet) {
    if (!alive) return;
    on = !!on;
    if (on === visible) { if (persist) persistFlag(on); syncSwitch(); return; }
    visible = on;
    try { host.classList.toggle('on', on); } catch (e) {}
    if (on) {
      renderAccounts(true);
      paintFps();
      paintLoad();
      startFps();
      startLoad();
    } else {
      stopFps();
      stopLoad();
    }
    if (persist) persistFlag(on);
    relayoutFitTabs();
    if (!quiet) {
      if (on) {
        if (!hintedOnce) {
          hintedOnce = true;
          toast(t_('status.relayout_hint',
            '显示状态条会让游戏区域重排一次，建议在大厅时切换。'));
        }
      } else {
        toast(t_('status.toggle_hint',
          '状态条已隐藏。可在「工具」菜单或按 ⌘⇧B 再打开。'));
      }
    }
    syncSwitch();
  }

  // -------------------------------------------------------------- 设置页开关
  function bindSwitch() {
    var el = null;
    try { el = document.getElementById('setting-status-bar'); } catch (e) { el = null; }
    if (!el || el.__xzBound) { syncSwitch(); return; }
    el.__xzBound = true;
    try {
      if (typeof attachSwitch === 'function') {
        attachSwitch(el, function (on) { setVisible(on, true); });
      }
    } catch (e) {}
    syncSwitch();
  }
  function syncSwitch() {
    try {
      var el = document.getElementById('setting-status-bar');
      if (el && typeof setSwitch === 'function') setSwitch(el, visible);
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 语言
  function applyLanguage() {
    if (!alive) return;
    setTitle(elFps, t_('status.fps_tip',
      '本窗口界面的帧率（requestAnimationFrame 计数）。Flash 里游戏自身的帧率无法在不干扰游戏的前提下读取，所以不显示。'));
    if (elClose) setTitle(elClose, t_('status.hide', '隐藏状态条'));
    paintFps();
    paintLoad();
    paintAllAccts();
  }

  // ------------------------------------------------------------------ 启动
  // DOM 宿主（index.html 的 #status-bar，集成钩子 H2）缺席时整个模块是空操作：
  // 不注册任何定时器、不挂任何 webview 监听、也不定义 window.XZStatus，于是
  // renderer 的 if (window.XZStatus) 钩子全部短路，行为与没有本文件时一致。
  function boot() {
    if (booted) return;
    booted = true;
    try {
      host = document.getElementById('status-bar');
      elFps = document.getElementById('sb-fps');
      elLoad = document.getElementById('sb-load');
      elAcct = document.getElementById('sb-accounts');
      elClose = document.getElementById('sb-close');
    } catch (e) { host = null; }
    if (!host || !elFps || !elLoad || !elAcct) {
      host = null;
      try { console.warn('[XZStatus] 缺少 #status-bar 宿主，状态条未启用'); } catch (e) {}
      return;
    }
    alive = true;

    if (elClose) {
      elClose.addEventListener('mousedown', function (ev) { try { ev.preventDefault(); } catch (e) {} });
      elClose.addEventListener('click', function () { setVisible(false, true); });
    }

    applyLanguage();
    bindSwitch();
    try {
      for (var i = 0; i < tabs.length; i++) watchTab(tabs[i]);
    } catch (e) {}

    var want = false;
    try { want = !!(typeof settings !== 'undefined' && settings && settings.statusBar); } catch (e) { want = false; }
    // 启动时按持久化的偏好显示，安静地（不 toast、不提示重排）。
    if (want) setVisible(true, false, true);

    window.XZStatus = api;
  }

  // ------------------------------------------------------------------ 接口
  var api = {
    isVisible: function () { return !!visible; },
    show: function () { setVisible(true, true); },
    hide: function () { setVisible(false, true); },
    toggle: function () { setVisible(!visible, true); },
    // 'loading' | 'ok' | 'failed' | 'crashed' | 'plugin' | 'hung' | null
    stateOf: function (tabId) { return stateFor(findTab(tabId)); },
    // 立即采一次（调试用）；隐藏时也能采。
    sample: function () {
      if (!alive) return null;
      publishFps();
      sampleLoad(true);
      return lastLoad;
    }
  };

  // ------------------------------------------------------------- 事件与钩子
  // 全部在脚本顶层注册：本脚本同步执行于 boot IIFE 之前，一次事件都不会漏。
  document.addEventListener('xz:boot', function () { boot(); });
  document.addEventListener('xz:tab-created', function (e) {
    if (!alive) return;
    var tb = e && e.detail;
    if (!tb) return;
    watchTab(tb);
    renderAccounts(true);
  });
  document.addEventListener('xz:tab-closed', function () { renderAccounts(true); });
  document.addEventListener('xz:tabs-changed', function () { renderAccounts(true); });
  document.addEventListener('xz:activated', function () { paintAllAccts(); });
  document.addEventListener('xz:profiles', function () { paintAllAccts(); });
  document.addEventListener('xz:language', function () { applyLanguage(); });
  document.addEventListener('xz:route', function (e) {
    // 设置页是整体 innerHTML 重绘的；每次进来重新同步一次开关的视觉状态。
    if (alive && e && e.detail === 'settings') bindSwitch();
  });

  // 主进程菜单 ⌘⇧B（集成钩子 M7）。renderer.js 的 switch 对未知 action 什么都不做，
  // 所以模块自己再注册一个监听器，不去改那个 switch —— focus-mode.js 的先例。
  if (ipcRenderer) {
    try {
      ipcRenderer.on('action', function (_e, a) {
        if (a === 'toggle-status-bar') { try { api.toggle(); } catch (err) {} }
      });
    } catch (e) {}
  }

  // 兜底：集成钩子 R22（dispatch xz:boot）如果还没落地，xz:boot 永远不会来。
  // DOM 就绪后再等 3 秒（loadStores 早就完成了）自己启动一次；boot() 是幂等的。
  function armFallback() {
    try { window.setTimeout(boot, BOOT_FALLBACK_MS); } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', armFallback);
  } else {
    armFallback();
  }
})();

// ============================================================================
// 本文件用到的 i18n 键（en / zh-CN 由集成包 WP6 加进 i18n.js，缺了就显示中文兜底）
//   status.fps            界面 {n} 帧                      #sb-fps
//   status.fps_tip        （说明这是界面帧率，不是 Flash 游戏帧率）  #sb-fps 的 title
//   status.load           CPU {total}% · Flash {plugin}% · GPU进程 {gpu}%   #sb-load
//                         （en: GPU proc {gpu}%；GPU 一项是 GPU 进程的 CPU 时间）
//   status.load_tip       （说明 GPU 一项是 GPU 进程的 CPU 时间）      #sb-load 的 title
//   status.state_loading  加载中                           账号点 title
//   status.state_ok       页面已加载                         账号点 title
//   status.state_failed   加载失败                         账号点 title
//   status.state_crashed  页面已崩溃                        账号点 title
//   status.state_plugin   Flash 已崩溃                      账号点 title
//   status.state_hung     无响应                           账号点 title
//   status.acct_tip       {name} · {state} · 页面 CPU {cpu}%  账号点 title
//   status.hide           隐藏状态条                        #sb-close 的 title
//   status.toggle_hint    状态条已隐藏，可在工具菜单或 ⌘⇧B 再打开   隐藏时的 toast
//   status.relayout_hint  显示状态条会让游戏区域重排一次      首次显示时的 toast
//
// 由集成包 / 别的包使用、本文件不引用的相关键：
//   tools.status_bar（工具菜单项 R11）、set.status_bar / set.status_bar_sub
//   （设置页 H4）、palette.act_status（命令面板）。
//
// 依赖的 renderer.js 全局：tabs、activeId、activateTab、tabProfile、
// tabProfileName、hostOf、tOr、showToast、settings、saveSettings、
// setSwitch、attachSwitch，以及 tab 上的 ready / fit / loading / url /
// webview / _applyZoom。全部只读或只调用，不改 renderer 的任何状态。
//
// 依赖的主进程：status-metrics.js 注册的 ipcMain.handle('status:metrics')。
// 那个文件缺席时 invoke 会 reject，本模块把负载显示成「—」，其它照常。
// ============================================================================
