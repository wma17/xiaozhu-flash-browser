// ============================================================================
// onboarding.js — 首启引导与空状态 —— WP5（第三轮功能 7，方案 §2.7）
// ----------------------------------------------------------------------------
// 两件事，共用一个 window.XZOnboard：
//
//   A. 首启引导。第一次启动时，首页上铺一张三步卡片：给第一个档案起名字和挑
//      颜色 → 填游戏地址 → 说明多开与焦点模式。做完（或跳过）在 settings 里
//      记一个 onboarding.doneAt，此后永不再出现。
//
//   B. 空状态的动作。游戏库 / 收藏 / 最近 / 账号 / 首页三块的空状态原本只有
//      一只吉祥物加一行字，是个死胡同。这里给它们补上能点的按钮；档案页永远
//      不空，但只有一个档案时在末尾补一张「再建一个才能多开」的提示卡。
//
// 【怎么接进去的】
//   renderer.js 一行都没改。空状态全部是 innerHTML 整体重绘，重绘时机分散在
//   数据变化 / 路由切换 / 换语言三处，所以这里用 MutationObserver 观察那 8 个
//   容器的 childList：谁重绘了，谁的按钮就补回去。引导靠方案 §3.0 的事件总线
//   （xz:boot / xz:route / xz:language / xz:profiles）驱动。
//
// 【明确不做的事】
//   - 不碰任何 webview：不节流、不隐藏、不暂停、不 re-parent、不 resize、
//     不截图、不采样。引导只在 home 路由显示（那里 #webviews-container 的
//     visibility 已经是 hidden），showGuide() 自己会先把路由切回 home。
//   - 不用 backdrop-filter（index.html 66–80 / 2748–2760）。引导卡片的底是
//     不透明的 --cream-bg。
//   - 不写 animation / transition。
//   - 第一次运行以外的任何时候，本模块都是空操作：老用户升级只在 settings 里
//     静默补一个 doneAt，不弹任何东西；路由里有内容时不追加任何按钮。
//
// 运行环境：Electron 11.2.1 / Chromium 87。**只用 ES5**（var / function，
// 没有箭头函数、模板串、let/const、解构、可选链），与 §4 对新模块的要求一致。
// 经典 script，靠裸标识符读 renderer.js 的顶层 const/let（同 aim-assist.js、
// focus-mode.js）。文案一律 t_('key', '中文兜底')，文件末尾列出全部键。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 还没加载（或加载失败）时整个模块安静地不存在：集成侧只有事件
  // 总线的 dispatchEvent，没有监听者就是空操作，行为与没有本文件时完全一致。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZOnboard] renderer.js 作用域不可见，引导与空状态未启用'); } catch (e) {}
    return;
  }

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  var TOTAL_STEPS = 3;

  // ------------------------------------------------------------------ 小工具
  // 字典里有键就用字典，没有就用中文兜底 —— 集成包补上 i18n 键之前，界面也是
  // 完整的中文，不会出现裸键名。
  function t_(key, zh) {
    try {
      if (typeof tOr === 'function') {
        var v = tOr(key, zh);
        if (v != null && v !== '') return v;
      }
    } catch (e) {}
    return zh;
  }
  function fill(text, key, value) {
    return String(text == null ? '' : text).split('{' + key + '}').join(String(value));
  }
  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function on(node, type, fn) {
    try { if (node) node.addEventListener(type, fn); } catch (e) {}
  }
  function setShown(node, yes) {
    try {
      if (!node) return;
      if (yes) node.classList.remove('ob-off');
      else node.classList.add('ob-off');
    } catch (e) {}
  }
  function later(fn) {
    // 观察者回调是微任务，渲染函数的 innerHTML 赋值也在同一个任务里；用一个
    // 宏任务把补按钮排到「这一轮重绘全部结束之后」，省得和渲染函数抢。
    try { setTimeout(function () { try { fn(); } catch (e) {} }, 0); } catch (e) {}
  }

  // -------------------------------------------------------- 首启判定与落盘
  // fresh = 从来没走过引导（也没被静默标记过）。
  function isFresh() {
    try {
      var ob = (typeof settings !== 'undefined' && settings) ? settings.onboarding : null;
      return !(ob && ob.doneAt);
    } catch (e) { return false; }
  }
  // pristine = 这台机器上确实什么都还没有。老用户升级到本版本时 fresh 也是
  // true（settings 里本来就没有 onboarding 字段），靠 pristine 把他们区分开。
  function isPristine() {
    try {
      var noHistory   = !history   || history.length   === 0;
      var noPasswords = !passwords || passwords.length === 0;
      var noBookmarks = !bookmarks || bookmarks.length === 0;
      // seedDefaults 首次运行会写入 Main / Alt 两个档案，所以 <= 2 才算干净。
      var fewProfiles = !profiles  || profiles.length  <= 2;
      return noHistory && noPasswords && noBookmarks && fewProfiles;
    } catch (e) { return false; }
  }
  function markDone(auto) {
    try {
      if (typeof settings === 'undefined' || !settings) return;
      settings.onboarding = { doneAt: Date.now(), version: 1 };
      if (auto) settings.onboarding.auto = true;   // auto = 老用户升级时静默补的
      if (typeof saveSettings === 'function') saveSettings();
    } catch (e) {}
  }
  // 引导要写的那个档案：默认档案，没有就取第一个。首启时 seedDefaults 刚写完
  // Main/Alt 且 defaultProfileId === 'main'，两者是同一个。
  function targetProfile() {
    try {
      if (typeof defaultProfile === 'function') {
        var p = defaultProfile();
        if (p) return p;
      }
    } catch (e) {}
    try { if (profiles && profiles[0]) return profiles[0]; } catch (e) {}
    return null;
  }
  function defaultAddress() {
    try {
      var raw = (typeof settings !== 'undefined' && settings && settings.newTabUrl)
        ? String(settings.newTabUrl).trim() : '';
      if (raw) return raw;
    } catch (e) {}
    try { if (typeof homeUrl === 'string' && homeUrl) return homeUrl; } catch (e) {}
    return '';
  }

  // ================================================================== 引导
  var root = null;      // #xz-onboard
  var ui = {};          // 卡片里的持久节点
  var step = 0;         // 0 / 1 / 2
  var visible = false;
  var draft = { color: '', url: '' };

  function buildDom() {
    if (root) return root;
    root = el('div');
    root.id = 'xz-onboard';
    root.tabIndex = -1;               // 背景也能拿焦点，Esc 才不会漏

    var card = el('div', 'ob-card');
    ui.stepLabel = el('div', 'ob-step');
    ui.title = el('div', 'ob-title');
    ui.body = el('div', 'ob-body');
    card.appendChild(ui.stepLabel);
    card.appendChild(ui.title);
    card.appendChild(ui.body);

    // 第 1 步：档案名 + 选色。.color-choice 是档案页那一排的类名，直接复用，
    // 于是尺寸、圆角、选中环与档案卡里的逐像素相同。
    ui.field1 = el('div', 'ob-field');
    ui.name = el('input', 'ob-input');
    ui.name.id = 'ob-name';
    ui.name.type = 'text';
    ui.name.setAttribute('autocomplete', 'off');
    ui.name.setAttribute('spellcheck', 'false');
    ui.colors = el('div', 'ob-colors');
    ui.field1.appendChild(ui.name);
    ui.field1.appendChild(ui.colors);
    card.appendChild(ui.field1);

    // 第 2 步：游戏地址。
    ui.field2 = el('div', 'ob-field');
    ui.url = el('input', 'ob-input');
    ui.url.id = 'ob-url';
    ui.url.type = 'text';
    ui.url.setAttribute('autocomplete', 'off');
    ui.url.setAttribute('spellcheck', 'false');
    ui.field2.appendChild(ui.url);
    card.appendChild(ui.field2);

    var foot = el('div', 'ob-foot');
    ui.skip = el('button', 'ob-quiet');
    ui.back = el('button', '');
    ui.altFinish = el('button', '');
    ui.next = el('button', 'primary');
    foot.appendChild(ui.skip);
    foot.appendChild(el('div', 'ob-spacer'));
    foot.appendChild(ui.back);
    foot.appendChild(ui.altFinish);
    foot.appendChild(ui.next);
    card.appendChild(foot);

    root.appendChild(card);
    document.body.appendChild(root);
    wireGuide();
    return root;
  }

  function wireGuide() {
    on(ui.skip, 'click', function () { finishGuide('skip'); });
    on(ui.back, 'click', function () { if (step > 0) { step -= 1; paintGuide(); } });
    on(ui.next, 'click', function () { advance(); });
    on(ui.altFinish, 'click', function () { finishGuide('stay'); });
    // 键盘全部在卡片里处理完：Esc 一定要 stopPropagation，renderer.js 982–984
    // 有一个 window 级的 Escape 监听（退出游戏模式），不拦住会顺带触发它。
    on(root, 'keydown', function (e) {
      if (!e) return;
      if (e.key === 'Escape') {
        try { e.stopPropagation(); e.preventDefault(); } catch (e2) {}
        finishGuide('skip');
        return;
      }
      if (e.key === 'Enter') {
        try { e.stopPropagation(); e.preventDefault(); } catch (e2) {}
        advance();
      }
    });
    // 点卡片外面什么也不发生：引导是一个必须回答的问题，不是一个可以点掉的浮层
    // （出口是「跳过」，它会记 doneAt）。同时把焦点收回当前输入框。
    on(root, 'mousedown', function (e) {
      if (!e || e.target !== root) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (e2) {}
      focusStep();
    });
  }

  function buildSwatch(color) {
    var sw = el('div', 'color-choice');
    sw.setAttribute('data-color', color);
    // 用户自己挑的档案色不属于任何调色板，和 renderer.js 画色块的写法一致。
    sw.style.background = color;
    sw.title = color;
    on(sw, 'click', function () { draft.color = color; paintColors(); });
    ui.colors.appendChild(sw);
  }
  function paintColors() {
    try {
      if (!ui.colors) return;
      if (!ui.colors.childNodes.length) {
        var list = (typeof PROFILE_COLORS !== 'undefined' && PROFILE_COLORS) ? PROFILE_COLORS : [];
        for (var i = 0; i < list.length; i++) buildSwatch(list[i]);
      }
      var kids = ui.colors.childNodes;
      for (var j = 0; j < kids.length; j++) {
        var sw = kids[j];
        var picked = sw.getAttribute && sw.getAttribute('data-color') === draft.color;
        sw.className = picked ? 'color-choice selected' : 'color-choice';
      }
    } catch (e) {}
  }

  function paintGuide() {
    if (!root) return;
    try {
      ui.stepLabel.textContent = t_('onboard.title', '欢迎使用') + ' · ' +
        fill(t_('onboard.step', '第 {n} 步，共 3 步'), 'n', step + 1);
      setShown(ui.field1, step === 0);
      setShown(ui.field2, step === 1);
      setShown(ui.back, step > 0);
      setShown(ui.altFinish, step === TOTAL_STEPS - 1);

      if (step === 0) {
        ui.title.textContent = t_('onboard.s1_title', '给第一个档案起个名字');
        ui.body.textContent = t_('onboard.s1_body',
          '一个档案就是一个游戏账号，有独立的 Cookie 和登录状态。每多建一个档案，就能多开一个账号。');
        ui.name.placeholder = t_('onboard.s1_placeholder', '例如：主号');
        ui.next.textContent = t_('onboard.next', '下一步');
      } else if (step === 1) {
        ui.title.textContent = t_('onboard.s2_title', '游戏在哪里？');
        ui.body.textContent = t_('onboard.s2_body',
          '粘贴游戏页面的网址。新标签页会从这里打开，这个网站也会交给这个档案。');
        ui.next.textContent = t_('onboard.next', '下一步');
      } else {
        ui.title.textContent = t_('onboard.s3_title', '多开与焦点模式');
        ui.body.textContent = t_('onboard.s3_body',
          '⌘1–⌘8 切换档案。焦点模式（⌘⇧F）把所有账号放进一个窗口：一个大画面加几个小画面，全部实时运行。⌘K 打开命令面板。');
        ui.next.textContent = t_('onboard.finish', '打开游戏');
      }
      ui.skip.textContent = t_('onboard.skip', '跳过');
      ui.back.textContent = t_('onboard.back', '上一步');
      ui.altFinish.textContent = t_('onboard.finish_alt', '完成');
      paintColors();
    } catch (e) {
      try { console.warn('[XZOnboard] 引导重绘失败', e); } catch (e2) {}
    }
  }

  function focusStep() {
    try {
      if (!visible) return;
      if (step === 0 && ui.name) ui.name.focus();
      else if (step === 1 && ui.url) ui.url.focus();
      else if (ui.next) ui.next.focus();
    } catch (e) {}
  }

  // 第 1 步落盘：档案名与颜色。名字留空就保持原样（不会把档案改成空名）。
  function commitProfile() {
    try {
      var p = targetProfile();
      if (!p) return;
      var name = String((ui.name && ui.name.value) || '').trim();
      var patch = { id: p.id };
      var changed = false;
      if (name && name !== p.name) { patch.name = name; changed = true; }
      if (draft.color && draft.color !== p.color) { patch.color = draft.color; changed = true; }
      if (!changed) return;
      if (typeof upsertProfile === 'function') upsertProfile(patch);
    } catch (e) {}
  }
  // 第 2 步落盘：新标签页地址 + 站点归属。
  function commitAddress() {
    var url = '';
    try {
      var raw = String((ui.url && ui.url.value) || '').trim();
      url = (typeof normalizeInput === 'function') ? normalizeInput(raw) : raw;
    } catch (e) { url = ''; }
    if (!url) return;
    draft.url = url;
    try {
      if (typeof settings !== 'undefined' && settings) {
        settings.newTabMode = 'custom';
        settings.newTabUrl = url;
        if (typeof saveSettings === 'function') saveSettings();
      }
    } catch (e) {}
    // assignSiteToProfile 自己会 toast 一次「以后用 X 打开」并带撤销。首启时
    // 没有别的档案占着这个站点，所以不会出现「从 Y 改给 X」那条夺取提示。
    try {
      var p = targetProfile();
      var host = (typeof siteHostOf === 'function') ? siteHostOf(url) : '';
      if (p && host && typeof assignSiteToProfile === 'function') assignSiteToProfile(host, p.id);
    } catch (e) {}
  }

  function advance() {
    if (step === 0) { commitProfile(); step = 1; paintGuide(); focusStep(); return; }
    if (step === 1) { commitAddress(); step = 2; paintGuide(); focusStep(); return; }
    finishGuide('open');
  }

  // kind: 'open' 打开游戏 / 'stay' 只是完成 / 'skip' 跳过。三者都记 doneAt。
  function finishGuide(kind) {
    markDone(false);
    hideGuide();
    if (kind !== 'open') return;
    try {
      var url = draft.url || defaultAddress();
      if (url && typeof openUrl === 'function') openUrl(url);
    } catch (e) {}
  }

  function showGuide() {
    try {
      // 引导绝不出现在游戏上方：先把路由切回 home，那里 webview 已经不可见。
      if (typeof currentRoute !== 'undefined' && currentRoute !== 'home') {
        try { if (typeof setRoute === 'function') setRoute('home'); } catch (e) {}
      }
      buildDom();
      var p = targetProfile();
      draft.color = (p && p.color) || '';
      draft.url = '';
      step = 0;
      if (ui.name) ui.name.value = (p && p.name) || '';
      if (ui.url) ui.url.value = defaultAddress();
      visible = true;
      root.classList.add('visible');
      paintGuide();
      focusStep();
    } catch (e) {
      visible = false;
      try { console.warn('[XZOnboard] 引导显示失败', e); } catch (e2) {}
    }
  }
  function hideGuide() {
    visible = false;
    try { if (root) root.classList.remove('visible'); } catch (e) {}
  }

  function onBoot(init) {
    if (!isFresh()) return;                         // 走过引导了
    if (!isPristine()) { markDone(true); return; }  // 老用户升级：静默补一笔，不打扰
    if (init && init.initialUrl) return;            // 这个窗口是为某个地址开的
    if (init && init.restore) return;               // 会话恢复接管了这个窗口
    // xz:boot 在 boot IIFE 里先于 setRoute('home') / createTab 派发，排到下一个
    // 宏任务再判断一次，读到的就是最终状态。
    later(function () {
      if (typeof currentRoute !== 'undefined' && currentRoute !== 'home') return;
      if (tabs && tabs.length) return;
      showGuide();
    });
  }

  // 设置页的「再看一遍」。settings-row 是静态标记（集成包 H4 放进 index.html），
  // renderSettings 只改值不重建，所以绑一次就够；仍然用属性做幂等标记，万一
  // 哪天那一行改成动态生成也不会重复绑定。
  function bindSettingsRow() {
    try {
      var btn = byId('setting-onboarding-replay');
      if (!btn || btn.getAttribute('data-xz-onboard') === '1') return;
      btn.setAttribute('data-xz-onboard', '1');
      on(btn, 'click', function () {
        try {
          if (typeof settings !== 'undefined' && settings) {
            settings.onboarding = null;
            if (typeof saveSettings === 'function') saveSettings();
          }
        } catch (e) {}
        try { if (typeof setRoute === 'function') setRoute('home'); } catch (e) {}
        try {
          if (typeof showToast === 'function') {
            showToast(t_('onboard.replayed', '新手引导已重新显示在首页'));
          }
        } catch (e) {}
        showGuide();
      });
    } catch (e) {}
  }

  // ============================================================== 空状态
  // 每个动作只做一件事，全部走 renderer.js 已有的全局函数。
  var ACTIONS = {
    open_home: {
      key: 'empty.open_home', zh: '打开游戏网站',
      run: function () { try { openUrl(newTabUrl()); } catch (e) {} }
    },
    go_recent: {
      key: 'empty.go_recent', zh: '看看最近页面',
      run: function () { try { setRoute('recent'); } catch (e) {} }
    },
    add_account: {
      key: 'empty.add_account', zh: '添加账号',
      run: function () { try { openAccountEditor(null); } catch (e) {} }
    },
    new_tab: {
      key: 'empty.new_tab', zh: '新建标签页',
      run: function () { try { createTab(newTabUrl()); } catch (e) {} }
    }
  };
  var HINTS = {
    fav_hint: {
      key: 'empty.fav_hint',
      zh: '收藏会出现在首页；打开游戏后点 ♡ 即可。'
    }
  };
  // 容器 id → 补什么。第一个动作是主动作（强调色填充），其余是次要按钮。
  var EMPTY_CONFIG = {
    'lib-grid':       { actions: ['open_home', 'go_recent'], hint: 'fav_hint' },
    'fav-list':       { actions: ['open_home', 'go_recent'], hint: 'fav_hint' },
    'home-favorites': { actions: ['open_home', 'go_recent'], hint: 'fav_hint' },
    'rec-list':       { actions: ['open_home'] },
    'home-continue':  { actions: ['open_home'] },
    'acct-list':      { actions: ['add_account'] },
    'home-windows':   { actions: ['new_tab'] }
  };
  var OBSERVED = [
    'lib-grid', 'fav-list', 'rec-list', 'acct-list',
    'profile-list', 'home-windows', 'home-continue', 'home-favorites'
  ];

  function bindAction(btn, run) {
    on(btn, 'click', function (e) {
      try { if (e) e.stopPropagation(); } catch (e2) {}
      run();
    });
  }

  function decorate(container) {
    if (!container || !container.id) return;
    if (container.id === 'profile-list') { decorateProfiles(container); return; }
    var cfg = EMPTY_CONFIG[container.id];
    if (!cfg) return;
    // 有内容时 .placeholder 根本不存在 —— 这就是「路由非空时完全是空操作」。
    var ph = container.querySelector('.placeholder');
    if (!ph) return;
    if (ph.querySelector('.ph-actions')) return;   // 已经补过
    var row = el('div', 'ph-actions');
    for (var i = 0; i < cfg.actions.length; i++) {
      var a = ACTIONS[cfg.actions[i]];
      if (!a) continue;
      var b = el('button', i === 0 ? 'primary' : '', t_(a.key, a.zh));
      bindAction(b, a.run);
      row.appendChild(b);
    }
    if (!row.childNodes.length) return;
    // 追加到 .placeholder 里面而不是容器里：观察者只看容器的直接子节点
    // （childList，没有 subtree），所以这一步不会再次触发它，没有回环。
    ph.appendChild(row);
    if (cfg.hint && HINTS[cfg.hint]) {
      ph.appendChild(el('div', 'ph-hint', t_(HINTS[cfg.hint].key, HINTS[cfg.hint].zh)));
    }
  }

  // 档案页永远不空，所以它没有 .placeholder；只有一个档案时在列表末尾补一张卡。
  function decorateProfiles(container) {
    var card = container.querySelector('.profile-hint-card');
    var only = false;
    try { only = !!(profiles && profiles.length === 1); } catch (e) { only = false; }
    if (!only) {
      if (card && card.parentNode) card.parentNode.removeChild(card);
      return;
    }
    if (card) {
      // renderProfiles 是 async 的，卡片可能在我们之后再追加；保证提示卡在末尾。
      // appendChild 一个已在场的子节点是「移动」，下一次进来就已经是末尾了，
      // 所以这个分支最多再触发一次观察者，不会循环。
      if (container.lastChild !== card) container.appendChild(card);
      return;
    }
    card = el('div', 'profile-hint-card');
    card.appendChild(el('div', 'ph-card-text', t_('empty.profiles_hint',
      '一个档案就是一个账号，再建一个档案就能多开。')));
    var b = el('button', 'primary', t_('empty.create_profile', '再建一个档案'));
    bindAction(b, function () {
      try {
        var t = byId('profile-create-btn');
        if (t) t.click();
      } catch (e) {}
    });
    card.appendChild(b);
    container.appendChild(card);
  }

  function refreshAll() {
    for (var i = 0; i < OBSERVED.length; i++) {
      try { decorate(byId(OBSERVED[i])); } catch (e) {}
    }
  }
  // 换语言时把补过的东西全部拆掉再补一遍：applyLanguage 只重绘当前路由，
  // 其它路由的 DOM 还留着旧文案。
  function resetEmptyStates() {
    for (var i = 0; i < OBSERVED.length; i++) {
      var c = byId(OBSERVED[i]);
      if (!c) continue;
      try {
        var olds = c.querySelectorAll('.ph-actions, .ph-hint, .profile-hint-card');
        for (var j = 0; j < olds.length; j++) {
          if (olds[j].parentNode) olds[j].parentNode.removeChild(olds[j]);
        }
      } catch (e) {}
    }
    refreshAll();
  }

  var observer = null;
  function startObserving() {
    try {
      if (observer || typeof MutationObserver === 'undefined') return;
      observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          try { decorate(records[i].target); } catch (e) {}
        }
      });
      for (var k = 0; k < OBSERVED.length; k++) {
        var c = byId(OBSERVED[k]);
        if (!c) continue;
        try { observer.observe(c, { childList: true }); } catch (e) {}
      }
    } catch (e) {
      observer = null;
      try { console.warn('[XZOnboard] 空状态观察器未启用', e); } catch (e2) {}
    }
  }

  // ============================================================== 事件总线
  // 脚本顶层就注册，本文件同步执行于 boot 之前，不会漏掉任何一次派发。
  document.addEventListener('xz:boot', function (e) {
    var init = (e && e.detail) || null;
    startObserving();
    bindSettingsRow();
    try { onBoot(init); } catch (err) {
      try { console.warn('[XZOnboard] 首启判定失败', err); } catch (e2) {}
    }
    later(refreshAll);
  });
  document.addEventListener('xz:route', function (e) {
    var name = (e && e.detail) || '';
    // 安全网：引导只属于 home。正常情况下引导铺满窗口，用户点不到导航栏，
    // 这一条只在别的模块主动换路由时起作用。
    if (visible && name !== 'home') hideGuide();
    if (name === 'settings') bindSettingsRow();
    later(refreshAll);
  });
  document.addEventListener('xz:language', function () {
    if (visible) paintGuide();
    later(resetEmptyStates);
  });
  document.addEventListener('xz:profiles', function () {
    later(function () { decorate(byId('profile-list')); });
  });

  // ================================================================== 导出
  window.XZOnboard = {
    show: function () { showGuide(); },
    hide: function () { hideGuide(); },
    isFresh: function () { return isFresh(); },
    refreshEmptyStates: function () { refreshAll(); }
  };
})();

// ============================================================================
// 本文件用到的 i18n 键（方案 §5；集成包 WP6 往 i18n.js 的 en / zh-CN 两边加。
// 缺键时界面显示下面这些中文兜底，不会出现裸键名）：
//
//   onboard.title           欢迎使用                     卡片顶行
//   onboard.step            第 {n} 步，共 3 步            卡片顶行（{n} = 1/2/3）
//   onboard.s1_title        给第一个档案起个名字          第 1 步标题
//   onboard.s1_body         一个档案就是一个游戏账号…      第 1 步正文
//   onboard.s1_placeholder  例如：主号                    第 1 步输入框 placeholder
//   onboard.s2_title        游戏在哪里？                  第 2 步标题
//   onboard.s2_body         粘贴游戏页面的网址…            第 2 步正文
//   onboard.s3_title        多开与焦点模式                第 3 步标题
//   onboard.s3_body         ⌘1–⌘8 切换档案…               第 3 步正文
//   onboard.next            下一步                       第 1/2 步主按钮
//   onboard.back            上一步                       第 2/3 步
//   onboard.skip            跳过                         三步都在
//   onboard.finish          打开游戏                     第 3 步主按钮
//   onboard.finish_alt      完成                         第 3 步次按钮
//   onboard.replayed        新手引导已重新显示在首页       设置页「再看一遍」的 toast
//   empty.open_home         打开游戏网站                 库/收藏/最近/首页两块
//   empty.go_recent         看看最近页面                 库/收藏/首页收藏
//   empty.add_account       添加账号                     账号页
//   empty.new_tab           新建标签页                   首页「窗口」
//   empty.create_profile    再建一个档案                 档案页提示卡
//   empty.profiles_hint     一个档案就是一个账号…          档案页提示卡
//   empty.fav_hint          收藏会出现在首页…              库/收藏/首页收藏的副文案
//
// 本文件不引用、但同属功能 7 的键（由集成包放进 index.html 的 data-i18n）：
//   set.onboarding_replay / set.onboarding_replay_sub / set.onboarding_replay_btn
//
// 依赖的 renderer.js 全局（全部只读或调用，未做任何修改）：
//   tabs / settings / profiles / history / bookmarks / passwords / currentRoute /
//   homeUrl / PROFILE_COLORS / tOr / setRoute / openUrl / newTabUrl / createTab /
//   normalizeInput / siteHostOf / defaultProfile / upsertProfile / saveSettings /
//   assignSiteToProfile / openAccountEditor / showToast / activateTab（守卫用）
// ============================================================================
