// ============================================================================
// session-client.js — 崩溃恢复（渲染进程侧）—— WP3
// ----------------------------------------------------------------------------
// 两件事，别的都不做：
//   1. windowState()   —— 把「本窗口现在是什么样」压成一个小对象。集成钩子 R3 把它
//      塞进 window:set-meta 的 meta.session 里搭便车，于是 activateTab / did-navigate /
//      page-title-updated / closeTab / moveTab 这些已有的 pushWindowMeta() 调用点
//      （renderer 自带 300ms 节流）就是采集点，不需要新的 IPC 通道。
//   2. restoreWindow(w) —— 启动时按主进程给的快照把标签页建回来。
//
// 【为什么第一个标签页必须同步建出来】
//   main.js 的串行开窗器等的是 window:ready，而它由「首个 webview 的 did-stop-loading」
//   触发。restoreWindow 是在 boot IIFE 里被调用的，第一个 createTab 如果拖到定时器里，
//   这个窗口 20 秒内不会 ready，后面几个窗口就得排队等超时。
//   其余标签页每 700ms（SCATTER_INTERVAL_MS，和散开/多开同一个节奏）建一个，
//   让 Flash 的加载峰值错开。
//
// 【防呆】
//   快照是主进程给的，但主进程读的是磁盘文件 —— 一样当敌意输入处理。任何一步出错都
//   返回 false，renderer 的 R23 分支会退回 init.initialUrl（至少开出活动标签页那一个）
//   或者今天的空白首页行为。这里绝不 throw。
//
// 【不碰游戏】
//   不截图、不采样、不节流、不隐藏、不 re-parent、不 resize 任何 webview。
//   恢复 = 重新加载页面，进行中的对局不保留（设置页副文案已写明）。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 的顶层符号在同一个 document 的经典 script 里以裸标识符可见。
  // 任何一个缺席都说明宿主不是我们认识的那个 renderer —— 整个模块静默退出。
  if (typeof tabs === 'undefined' || typeof createTab !== 'function' || typeof activateTab !== 'function') return;

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  var MAX_URL_LEN = 2000;
  var MAX_TITLE_LEN = 80;
  var FOCUS_CLASSES = ['focus-mode', 'focus-layout-sector', 'focus-layout-strip', 'focus-strip-right'];

  // ------------------------------------------------------------ 安全包装
  function t_(key, fallback) {
    try { if (typeof tOr === 'function') return tOr(key, fallback); } catch (e) {}
    return fallback;
  }
  function toast(text, action) {
    try { if (typeof showToast === 'function') showToast(text, action); } catch (e) {}
  }
  function fillN(key, fallback, n) {
    return String(t_(key, fallback)).replace('{n}', String(n));
  }
  function scatterMs() {
    try { if (typeof SCATTER_INTERVAL_MS === 'number' && SCATTER_INTERVAL_MS > 0) return SCATTER_INTERVAL_MS; } catch (e) {}
    return 700;
  }
  function isHttp(u) {
    return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);
  }
  function cut(v, max) {
    return v == null ? '' : String(v).slice(0, max);
  }
  function pushMeta() {
    try { if (typeof pushWindowMeta === 'function') pushWindowMeta(); } catch (e) {}
  }

  // ------------------------------------------------------------ 采集
  // 焦点模式是每窗口的会话态（不持久化在它自己那边），所以这里顺手记下来：
  // 开着没有、什么布局、条带在哪、主槽里是哪个账号。
  function focusState() {
    try {
      if (!window.XZFocus) return null;
      var active = false, prefs = {};
      try { active = !!window.XZFocus.isActive(); } catch (e) { active = false; }
      try { prefs = window.XZFocus.getPrefs() || {}; } catch (e) { prefs = {}; }
      var mainProfileId = null;
      if (active) {
        var t = null;
        try { t = activeTab(); } catch (e) { t = null; }
        if (t && t.profileId) mainProfileId = t.profileId;
      }
      return {
        active: active,
        layout: prefs.layout === 'sector' ? 'sector' : 'strip',
        pos: prefs.pos === 'right' ? 'right' : 'bottom',
        mainProfileId: mainProfileId
      };
    } catch (e) { return null; }
  }

  // 同步、O(tabs)。只收 http(s)：about:blank / data: / 设置页这些恢复了也没意义，
  // 而且 data: 串可能很长，不该进快照。
  function windowState() {
    var out = { tabs: [], activeIndex: 0, focus: null };
    try {
      var list = (typeof tabs !== 'undefined' && tabs && tabs.length) ? tabs : [];
      var activeIdx = -1;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t || !isHttp(t.url)) continue;
        var here = out.tabs.length;
        try { if (typeof activeId !== 'undefined' && t.id === activeId) activeIdx = here; } catch (e) {}
        out.tabs.push({
          url: cut(t.url, MAX_URL_LEN),
          profileId: t.profileId || null,
          title: cut(t.title, MAX_TITLE_LEN)
        });
      }
      out.activeIndex = activeIdx >= 0 ? activeIdx : 0;
      out.focus = focusState();
    } catch (e) { return { tabs: [], activeIndex: 0, focus: null }; }
    return out;
  }

  // ------------------------------------------------------------ 恢复
  function sanitize(w) {
    if (!w || typeof w !== 'object') return null;
    var src = (w.tabs && w.tabs.length) ? w.tabs : [];
    var list = [];
    for (var i = 0; i < src.length; i++) {
      var t = src[i];
      if (!t || typeof t !== 'object' || !isHttp(t.url)) continue;
      list.push({ url: cut(t.url, MAX_URL_LEN), profileId: t.profileId ? String(t.profileId) : null });
      if (list.length >= 24) break;
    }
    if (!list.length) return null;
    var idx = Math.floor(Number(w.activeIndex));
    if (!isFinite(idx) || idx < 0) idx = 0;
    if (idx > list.length - 1) idx = list.length - 1;
    var f = null;
    if (w.focus && typeof w.focus === 'object') {
      f = {
        active: !!w.focus.active,
        layout: w.focus.layout === 'sector' ? 'sector' : 'strip',
        pos: w.focus.pos === 'right' ? 'right' : 'bottom',
        mainProfileId: w.focus.mainProfileId ? String(w.focus.mainProfileId) : null
      };
    }
    return { tabs: list, activeIndex: idx, focus: f };
  }

  // 档案可能已经被删掉了：createTab 的 resolveTabProfile 只做精确匹配，找不到就退回
  // 本窗口的档案 —— 页面照样开出来，只是跟着窗口的账号走。这正是我们要的降级。
  function makeTab(entry) {
    try { return createTab(entry.url, entry.profileId ? { profileId: entry.profileId } : null) || null; }
    catch (e) { return null; }
  }
  function tabForProfile(list, profileId) {
    if (!profileId) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].profileId === profileId) return list[i];
    return null;
  }
  function activateSafe(tab) {
    if (!tab) return;
    try { activateTab(tab.id); } catch (e) {}
  }

  function finishRestore(plan, created) {
    try {
      if (!created.length) return;
      var idx = plan.activeIndex < created.length ? plan.activeIndex : created.length - 1;
      activateSafe(created[idx]);
      var f = plan.focus;
      if (f && f.active && window.XZFocus) {
        try { window.XZFocus.setPrefs({ layout: f.layout, pos: f.pos }); } catch (e) {}
        // 主槽 = 进入焦点模式时的活动标签页，所以先把那个账号切上来再 enter()。
        // 同一个档案可能有好几个标签页：活动那个本来就是它就别再换，否则会切错页。
        var main = (created[idx] && created[idx].profileId === f.mainProfileId)
          ? created[idx]
          : tabForProfile(created, f.mainProfileId);
        if (main) activateSafe(main);
        try { window.XZFocus.enter(); } catch (e) {}
      }
      toast(fillN('session.restored_toast', '已恢复上次的 {n} 个标签页', created.length));
      pushMeta();
    } catch (e) {}
  }

  // 返回 true = 本模块已经接管建标签页，renderer 的 boot 分支不要再走 initialUrl。
  function restoreWindow(w) {
    try {
      var plan = sanitize(w);
      if (!plan) return false;
      var created = [];
      var first = makeTab(plan.tabs[0]);   // 同步：window:ready 靠它
      if (!first) return false;
      created.push(first);
      if (plan.tabs.length === 1) { finishRestore(plan, created); return true; }
      var i = 1;
      var gap = scatterMs();
      var step = function () {
        try {
          if (i >= plan.tabs.length) { finishRestore(plan, created); return; }
          var t = makeTab(plan.tabs[i]);
          if (t) created.push(t);
          i++;
          window.setTimeout(step, gap);   // 错峰加载：一次开五个 Flash 会把机器压死
        } catch (e) {}
      };
      window.setTimeout(step, gap);
      return true;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------ 焦点模式的变化
  // 进出焦点模式 / 换布局没有现成的钩子（focus-mode.js 不归本包管），但它一定会改
  // <body> 上那几个类。观察 class 属性的变化就够了，比在 renderer 里加钩子稳。
  function focusSignature() {
    try {
      var c = document.body.classList, sig = '', i;
      for (i = 0; i < FOCUS_CLASSES.length; i++) sig += c.contains(FOCUS_CLASSES[i]) ? '1' : '0';
      return sig;
    } catch (e) { return ''; }
  }
  function watchFocusClasses() {
    try {
      if (typeof MutationObserver !== 'function' || !document.body) return;
      var last = focusSignature();
      var mo = new MutationObserver(function () {
        var now = focusSignature();
        if (now === last) return;
        last = now;
        pushMeta();   // 300ms 节流的那个，主进程 1000ms 再合并一次写盘
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
  }

  // ------------------------------------------------------------ 启动提示
  // 守卫跳过了恢复时给一次 toast + 「仍然恢复」。主进程只回答第一个提问的窗口。
  function askLaunchInfo() {
    if (!ipcRenderer) return;
    var p = null;
    try { p = ipcRenderer.invoke('session:launch-info'); } catch (e) { return; }
    if (!p || typeof p.then !== 'function') return;
    p.then(function (info) {
      if (!info || !info.skippedNotice) return;
      var action = null;
      if (info.canRestore) {
        action = {
          label: t_('session.restore_now', '仍然恢复'),
          onClick: function () {
            try {
              ipcRenderer.invoke('session:restore-skipped').then(function (r) {
                if (!r || !r.queued) toast(t_('session.nothing', '没有可恢复的会话'));
              }).catch(function () {});
            } catch (e) {}
          }
        };
      }
      toast(t_('session.loop_skipped', '上次恢复没有完成，这次已从空白启动。'), action);
    }).catch(function () {});
  }

  document.addEventListener('xz:boot', function () {
    watchFocusClasses();
    askLaunchInfo();
  });

  window.XZSession = {
    windowState: windowState,
    restoreWindow: restoreWindow
  };
})();

// ============================================================================
// 本文件通过 t_(key, 中文兜底) 引用的 i18n 键（en / zh-CN 由 WP6 加进 i18n.js；
// 键缺失时只显示中文兜底，功能不受影响）：
//
//   session.restored_toast  已恢复上次的 {n} 个标签页
//                           en: "Restored {n} tabs from last time"
//   session.loop_skipped    上次恢复没有完成，这次已从空白启动。
//                           en: "The last launch did not finish restoring, so this one started clean."
//   session.restore_now     仍然恢复
//                           en: "Restore anyway"
//   session.nothing         没有可恢复的会话
//                           en: "Nothing to restore"
//
// 另外两个键由 WP6 直接用在 index.html / 设置页，本文件不引用：
//   set.restore_session（已有）、set.restore_session_sub（新增副文案）。
// ============================================================================
