// ============================================================================
// command-palette.js — 命令面板（⌘K）—— 第三轮 WP1
// ----------------------------------------------------------------------------
// 一个居中的浮层：一个输入框 + 一份过滤后的结果列表，覆盖档案、打开的标签页、
// 游戏库与收藏、最近页面、设置路由、以及全部可执行的操作。
//
// 【为什么它可以安全地开在游戏上方】
//   1) 键盘：面板打开时键盘焦点在宿主的 <input> 上。<webview> 是 OOPIF，宿主页面
//      持有焦点时它一个按键也收不到 —— 不需要对 guest 做任何事就已经"隔离"了。
//      面板自己的 keydown 走捕获阶段并 stopPropagation()，所以按键也不会漏到
//      renderer.js 的 window 级监听（Escape 退出游戏模式 982、速度快捷键 2772）。
//   2) 鼠标：`.pal-shield` 是一层铺满窗口的宿主元素，压在 <webview> 之上。
//      点击 / 滚轮命中它，就到不了 guest。和焦点模式的 #focus-shield 同一手法。
//   3) 关闭：Esc / 点击挡板 / 再按 ⌘K / 窗口失焦。关闭后 display:none，
//      面板不再占有焦点，键盘焦点用 webview.focus() + 'xz:focus-game' 还给游戏
//      （preload 124–135 已有这个处理器，会 focus 页面里最大的 embed/object/iframe）。
//
// 【绝不做的事】
//   - 不节流 / 隐藏 / 暂停 / re-parent / resize / 截图任何活着的 <webview>。
//     本文件对 guest 的唯一交互是关闭时的一次 focus() 与一条 'xz:focus-game'。
//   - 没有回合检测、回合提示、自动切换、像素采样。
//   - 没有 backdrop-filter、没有 animation、没有 transition（面板会开在游戏上方）。
//   - 不缓存任何数据源：每次 render 都从 renderer.js 的全局重新枚举，
//     所以标签页/档案/收藏的变化天然是最新的，也不会因为缓存而串号。
//
// 运行环境：Electron 11.2.1 / Chromium 87。**ES5 语法**（var / function，
// 无箭头、无模板串、无 let/const、无解构、无可选链）。经典 script，靠裸标识符
// 读 renderer.js 的顶层 const/let（同 aim-assist.js / focus-mode.js）。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 没加载（或加载失败）时整个模块安静地不存在，宿主的钩子都是
  // if (window.XZPalette) 守卫，行为与没有本文件时完全一致。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZPalette] renderer.js 作用域不可见，命令面板未启用'); } catch (e) {}
    return;
  }

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  // ------------------------------------------------------------------ 常量
  var MAX_ITEMS = 14;          // 一屏最多这么多条，超出的靠继续打字收敛
  var EMPTY_ACTIONS = 6;       // 空查询时列出的高频操作条数
  var HISTORY_SCAN = 200;      // 最近页面只扫历史的前 200 条（history ≤2000）
  var BOOKMARK_SCAN = 400;     // 游戏库同理设个上限，避免超大库拖慢每次按键
  var BLUR_GRACE_MS = 250;     // 刚打开的这一小段时间里忽略 blur，避免自己把自己关掉

  // 分组的显示顺序。'url' 没有标题（它是置顶的单条）。
  var GROUP_ORDER = ['url', 'tabs', 'profiles', 'library', 'recent', 'routes', 'actions'];
  var GROUP_HEAD = {
    tabs: ['palette.group_tabs', '打开的标签页'],
    profiles: ['palette.group_profiles', '档案'],
    library: ['palette.group_library', '游戏库与收藏'],
    recent: ['palette.group_recent', '最近页面'],
    routes: ['palette.group_routes', '页面'],
    actions: ['palette.group_actions', '操作']
  };

  // 输入像网址：带协议，或者「非空白 + 点 + 至少两位后缀」。
  var URL_RE = /^[a-z][a-z0-9+.\-]*:\/\/\S+|^[^\s]+\.[^\s]{2,}$/i;
  // 词首判定用的分隔符（含中文常见分隔符与 tabFullLabel 用的全角竖线）。
  var WORD_BREAK = /[\s·｜|\-_.,/:;()\[\]、。（）]/;

  // 路由清单。report 没有 sidebar.* 键，用 report.title（与 renderer 4551 一致）。
  var ROUTES = [
    ['home', '首页', ['home', 'shouye']],
    ['library', '游戏库', ['library', 'games']],
    ['favorites', '收藏', ['favorites', 'fav', 'star']],
    ['recent', '最近玩过', ['recent', 'history', '历史']],
    ['windows', '窗口', ['windows', 'win']],
    ['profiles', '档案', ['profiles', 'profile', '账号']],
    ['accounts', '账号中心', ['accounts', 'password', '密码', '登录']],
    ['report', '报告', ['report', 'stats', '统计']],
    ['doctor', '游戏医生', ['doctor', 'repair', '诊断', '修复']],
    ['notes', '便签', ['notes', 'note']],
    ['tasks', '待办', ['tasks', 'todo']],
    ['settings', '设置', ['settings', 'preferences', 'config', '偏好']],
    ['shortcuts', '快捷键', ['shortcuts', 'keys', 'hotkey']],
    ['about', '关于', ['about', 'version', '版本']]
  ];

  // 空查询时列出的高频操作，按这个顺序取前 EMPTY_ACTIONS 条可用的。
  var FREQUENT = ['act_focus', 'act_tile', 'act_new_tab', 'act_screenshot',
                  'act_multi_open', 'act_status', 'act_mute_all', 'act_scatter'];

  // ------------------------------------------------------------ 小工具（全部兜底）
  function T(key, zh) { try { return tOr(key, zh); } catch (e) { return zh; } }
  function fill(tpl, map) {
    var out = String(tpl == null ? '' : tpl), k;
    for (k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) out = out.split('{' + k + '}').join(String(map[k]));
    }
    return out;
  }
  function arr(x) { return Object.prototype.toString.call(x) === '[object Array]' ? x : []; }
  function safeHost(u) { try { return hostOf(u) || ''; } catch (e) { return ''; } }
  function rel(ts) { try { return formatRelativeTime(ts) || ''; } catch (e) { return ''; } }
  function actTab() { try { return activeTab() || null; } catch (e) { return null; } }
  function routeName() { try { return currentRoute; } catch (e) { return ''; } }
  function inBrowser() { return routeName() === 'browser'; }
  function bodyHas(cls) { try { return document.body.classList.contains(cls); } catch (e) { return false; } }
  function setng() { try { return settings || {}; } catch (e) { return {}; } }
  function hexOk(c) { try { return !!c && isHexColor(c); } catch (e) { return false; } }
  function resolve(v) {
    if (typeof v === 'function') { try { return !!v(); } catch (e) { return false; } }
    return !!v;
  }
  // 有些 renderer 函数是 async 的；吞掉 rejection，免得在 Console 里刷红字。
  function fire(fn) {
    try {
      var r = fn();
      if (r && typeof r.catch === 'function') r.catch(function () {});
      return r;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ 状态
  var root = null, shield = null, box = null, input = null, list = null, foot = null;
  var paletteOpen = false;
  var restoreTo = null;      // 打开前正在看的那个 tab，Esc 后把焦点还给它
  var openedAt = 0;
  var items = [];            // 当前显示的条目（已按显示顺序展平）
  var sel = 0;
  var rafId = 0;
  var extras = [];           // 别的模块通过 register() 追加的命令

  // ------------------------------------------------------------------ DOM
  function build() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'xz-palette';

    shield = document.createElement('div');
    shield.className = 'pal-shield';

    box = document.createElement('div');
    box.className = 'pal-box';

    input = document.createElement('input');
    input.id = 'pal-input';
    input.setAttribute('type', 'text');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');

    list = document.createElement('div');
    list.id = 'pal-list';

    foot = document.createElement('div');
    foot.className = 'pal-foot';

    box.appendChild(input);
    box.appendChild(list);
    box.appendChild(foot);
    root.appendChild(shield);
    root.appendChild(box);
    document.body.appendChild(root);
    wire();
    return root;
  }

  function wire() {
    // 键盘：捕获阶段挂在 #xz-palette 上。capture 里 stopPropagation() 只是
    // 阻止事件继续传播，不取消默认动作，所以输入框照常收到字符、照常发 'input'。
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('keyup', swallow, true);
    root.addEventListener('keypress', swallow, true);

    // 每次改查询都把选中项拉回第一条，否则旧的下标会指到一条完全不相干的命令上。
    input.addEventListener('input', function () { sel = 0; schedule(); });

    // 挡板：按下即关。用 mousedown 而不是 click，关得更跟手。
    shield.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      close('game');
    });
    // 面板盒子内部的按下不要冒泡到别处（renderer 的 armMenuClose 只认 .menu，
    // 这里只是多一道保险）。
    box.addEventListener('mousedown', function (e) { e.stopPropagation(); });

    // 条目：mousedown 里 preventDefault 保住输入框焦点，click 才执行。
    list.addEventListener('mousedown', function (e) {
      var row = rowOf(e.target);
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
    });
    list.addEventListener('click', function (e) {
      var row = rowOf(e.target);
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      var i = parseInt(row.getAttribute('data-idx'), 10);
      if (i >= 0 && i < items.length) { sel = i; runSelected(); }
    });
    list.addEventListener('mousemove', function (e) {
      var row = rowOf(e.target);
      if (!row) return;
      var i = parseInt(row.getAttribute('data-idx'), 10);
      if (i >= 0 && i !== sel && i < items.length) { sel = i; paintSelection(); }
    });
  }

  function rowOf(el) {
    while (el && el !== list) {
      if (el.className && String(el.className).indexOf('pal-item') >= 0) return el;
      el = el.parentNode;
    }
    return null;
  }

  function swallow(e) { e.stopPropagation(); }

  function onKeyDown(e) {
    // 面板开着的时候，一个按键都不许漏出去：不进 window 级速度快捷键（renderer 2772），
    // 也不进「Escape 退出游戏模式」（renderer 982）。
    e.stopPropagation();
    // 中文输入法正在组字：Enter / 方向键属于候选框，面板一根手指都不能碰。
    if (e.isComposing || e.keyCode === 229) return;
    var k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (k === 'Enter') { e.preventDefault(); runSelected(); }
    else if (k === 'Escape') { e.preventDefault(); close('game'); }
    else if (k === 'Tab') { e.preventDefault(); }
    else if (k === 'Home' && !input.value) { e.preventDefault(); sel = 0; paintSelection(); }
  }

  function onWindowBlur(e) {
    // 捕获阶段能看到内部元素的 blur，只认真正的窗口失焦。
    if (e && e.target && e.target !== window) return;
    if (Date.now() - openedAt < BLUR_GRACE_MS) return;
    close('none');
  }

  // ------------------------------------------------------------------ 匹配
  function termScore(hay, t) {
    var i = hay.indexOf(t);
    if (i < 0) return 0;
    if (i === 0) return 100;
    return WORD_BREAK.test(hay.charAt(i - 1)) ? 60 : 30;
  }
  function matchScore(hay, terms) {
    if (!terms.length) return 1;
    var total = 0, i, s;
    for (i = 0; i < terms.length; i++) {
      s = termScore(hay, terms[i]);
      if (!s) return 0;
      total += s;
    }
    return total / terms.length;
  }

  // ------------------------------------------------------------------ 条目生成
  // 每次 render 都重新枚举，不缓存。
  function buildItems(q) {
    var out = [];
    var raw = String(q == null ? '' : q).trim();
    var qq = raw.toLowerCase();
    var terms = qq ? qq.split(/\s+/) : [];
    var empty = !terms.length;

    function push(it) {
      if (!it) return;
      if (empty && !it.empty) return;
      if (it.enabled != null && !resolve(it.enabled)) return;
      var hay = ((it.label || '') + ' ' + (it.sub || '') + ' ' +
                 (it.keywords ? it.keywords.join(' ') : '')).toLowerCase();
      var s = matchScore(hay, terms);
      if (s <= 0) return;
      it.score = s + (it.weight || 0);
      it.order = out.length;
      it.checked = resolve(it.checked);
      out.push(it);
    }

    // --- 网址（置顶，不参加打分） ---
    if (raw && URL_RE.test(raw)) {
      out.push({
        group: 'url', score: 1e9, order: -1, checked: false,
        label: fill(T('palette.open_url', '打开网址 {url}'), { url: raw }),
        sub: '', focusMode: 'follow',
        run: function () { return fire(function () { return openUrl(normalizeInput(raw)); }); }
      });
    }

    pushTabs(push);
    pushProfiles(push);
    if (!empty) { pushLibrary(push); pushRecent(push); pushRoutes(push); }
    pushActions(push, empty);

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    });
    out = out.slice(0, MAX_ITEMS);

    // 展平成显示顺序：按 GROUP_ORDER 归组，组内保持得分顺序。
    var flat = [];
    for (var g = 0; g < GROUP_ORDER.length; g++) {
      for (var i = 0; i < out.length; i++) {
        if (out[i].group === GROUP_ORDER[g]) flat.push(out[i]);
      }
    }
    return flat;
  }

  function pushTabs(push) {
    var live = arr(tabs), curId = null;
    try { curId = activeId; } catch (e) { curId = null; }
    for (var i = 0; i < live.length; i++) {
      (function (t) {
        if (!t) return;
        var label = '';
        try { label = tabFullLabel(t) || ''; } catch (e) { label = ''; }
        if (!label) label = t.title || safeHost(t.url) || String(t.url || '');
        push({
          group: 'tabs', empty: true, label: label, sub: safeHost(t.url),
          keywords: ['tab', '标签页', String(t.url || '')],
          checked: inBrowser() && t.id === curId,
          weight: 4, focusMode: 'follow',
          run: function () { return fire(function () { return activateTab(t.id); }); }
        });
      })(live[i]);
    }
  }

  function pushProfiles(push) {
    var list2 = arr(typeof profiles === 'undefined' ? null : profiles);
    for (var i = 0; i < list2.length; i++) {
      (function (p, idx) {
        if (!p || !p.id) return;
        var nm = p.name || ('#' + (idx + 1));
        var kw = ['profile', 'account', '档案', '账号', nm];
        var color = hexOk(p.color) ? p.color : null;
        var slot = idx < 8 ? ('⌘' + (idx + 1)) : '';

        push({
          group: 'profiles', empty: true, color: color, weight: 3,
          label: fill(T('palette.switch_to', '切换到 {name}'), { name: nm }),
          sub: slot, keywords: kw, focusMode: 'follow',
          run: function () { return fire(function () { return switchToAccountSlot(idx + 1); }); }
        });
        push({
          group: 'profiles', color: color,
          label: fill(T('palette.open_here', '在本窗口打开 {name}'), { name: nm }),
          sub: '', keywords: kw.concat(['open here', '本窗口', 'tab']), focusMode: 'follow',
          run: function () {
            return fire(function () { return createTab(newTabUrl(), { profileId: p.id }); });
          }
        });
        push({
          group: 'profiles', color: color,
          label: fill(T('palette.open_window', '新窗口打开 {name}'), { name: nm }),
          sub: '', keywords: kw.concat(['new window', '新窗口', 'window']), focusMode: 'none',
          enabled: function () { return !!ipcRenderer; },
          run: function () {
            var quick = null;
            try {
              if (window.XZAutoLogin && XZAutoLogin.quickUrlFor) quick = XZAutoLogin.quickUrlFor(p.id) || null;
            } catch (e) { quick = null; }
            return fire(function () { return ipcRenderer.invoke('window:open', quick, p.id); });
          }
        });
        // 快速进入只在 auto-login 模块在场、且该档案确实记着一个地址时出现。
        var quickUrl = null;
        try {
          if (window.XZAutoLogin && XZAutoLogin.quickUrlFor) quickUrl = XZAutoLogin.quickUrlFor(p.id) || null;
        } catch (e) { quickUrl = null; }
        if (quickUrl) {
          push({
            group: 'profiles', color: color,
            label: fill(T('palette.quick_enter', '用 {name} 快速进入游戏'), { name: nm }),
            sub: safeHost(quickUrl), keywords: kw.concat(['quick', '快速进入', 'jump', 'enter']),
            focusMode: 'none',
            run: function () { return fire(function () { return XZAutoLogin.jump(p.id); }); }
          });
        }
      })(list2[i], i);
    }
  }

  function pushLibrary(push) {
    var bm = arr(typeof bookmarks === 'undefined' ? null : bookmarks).slice(0);
    // 收藏优先，其次按最近玩过。
    bm.sort(function (a, b) {
      var fa = (a && a.favorite !== false) ? 1 : 0;
      var fb = (b && b.favorite !== false) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return ((b && b.lastPlayedAt) || 0) - ((a && a.lastPlayedAt) || 0);
    });
    bm = bm.slice(0, BOOKMARK_SCAN);
    for (var i = 0; i < bm.length; i++) {
      (function (b) {
        if (!b || !b.url) return;
        var host = safeHost(b.url);
        push({
          group: 'library', label: b.title || host || String(b.url),
          sub: host, weight: (b.favorite !== false) ? 5 : 0,
          keywords: ['game', '游戏', 'library', '收藏', String(b.url)].concat(arr(b.tags)),
          focusMode: 'follow',
          run: function () {
            return fire(function () {
              if (typeof playLibraryItem === 'function') return playLibraryItem(b);
              return openUrl(b.url);
            });
          }
        });
      })(bm[i]);
    }
  }

  function pushRecent(push) {
    var hist = arr(typeof history === 'undefined' ? null : history);
    var seen = {}, n = 0;
    for (var i = 0; i < hist.length && i < HISTORY_SCAN; i++) {
      (function (h) {
        if (!h || !h.url) return;
        var key = String(h.url);
        if (seen[key]) return;
        seen[key] = 1;
        n++;
        var host = safeHost(h.url);
        var age = Math.floor(Math.max(0, Date.now() - (Number(h.visitedAt) || 0)) / 86400000);
        push({
          group: 'recent', label: h.title || host || key,
          sub: [host, rel(h.visitedAt)].filter(Boolean).join(' · '),
          weight: Math.max(0, 10 - age),
          keywords: ['recent', '最近', 'history', key],
          focusMode: 'follow',
          run: function () { return fire(function () { return openUrl(h.url); }); }
        });
      })(hist[i]);
    }
  }

  function pushRoutes(push) {
    for (var i = 0; i < ROUTES.length; i++) {
      (function (r) {
        var name = r[0];
        var label = (name === 'report') ? T('report.title', r[1]) : T('sidebar.' + name, r[1]);
        push({
          group: 'routes',
          label: fill(T('palette.route_prefix', '打开 {name} 页面'), { name: label }),
          sub: '', keywords: [name, 'page', '页面', r[1]].concat(r[2]),
          focusMode: 'none',
          run: function () { return fire(function () { return setRoute(name); }); }
        });
      })(ROUTES[i]);
    }
  }

  // ------------------------------------------------------------------ 操作
  // 每条 = { id, label, keywords, run, enabled?, checked?, focusMode? }。
  // 依赖别的模块的条目在对象缺席时直接不生成（不是灰掉，是不列出）。
  function buildActions() {
    var a = [];
    function add(id, key, zh, kw, run, opts) {
      var it = { group: 'actions', id: id, label: T(key, zh), keywords: kw, run: run };
      if (opts) {
        if (opts.enabled != null) it.enabled = opts.enabled;
        if (opts.checked != null) it.checked = opts.checked;
        it.focusMode = opts.focusMode || 'game';
      } else {
        it.focusMode = 'game';
      }
      a.push(it);
    }
    var hasTab = function () { return !!actTab(); };

    add('act_new_tab', 'palette.act_new_tab', '新建标签页',
      ['new tab', '新建标签页', '标签', 'tab'],
      function () { return fire(function () { return createTab(newTabUrl()); }); },
      { focusMode: 'follow' });

    add('act_new_window', 'palette.act_new_window', '新建窗口',
      ['new window', '新建窗口', 'window'],
      function () {
        var pid = null, quick = null;
        try { pid = windowProfileId || null; } catch (e) { pid = null; }
        try {
          if (window.XZAutoLogin && XZAutoLogin.quickUrlFor) quick = XZAutoLogin.quickUrlFor(pid) || null;
        } catch (e) { quick = null; }
        return fire(function () { return ipcRenderer.invoke('window:open', quick, pid); });
      },
      { enabled: function () { return !!ipcRenderer; }, focusMode: 'none' });

    add('act_close_tab', 'palette.act_close_tab', '关闭当前标签页',
      ['close tab', '关闭标签页', '关闭', 'close'],
      function () { var t = actTab(); return t ? fire(function () { return closeTab(t.id); }) : null; },
      { enabled: hasTab, focusMode: 'follow' });

    add('act_detach', 'palette.act_detach', '把标签页移到新窗口',
      ['detach', '移到新窗口', '分离', 'move tab'],
      function () { var t = actTab(); return t ? fire(function () { return detachTab(t.id); }) : null; },
      { enabled: hasTab, focusMode: 'none' });

    add('act_reload', 'palette.act_reload', '重新加载',
      ['reload', 'refresh', '刷新', '重新加载'],
      function () {
        var t = actTab();
        return t ? fire(function () { return t.webview.reload(); }) : null;
      },
      { enabled: hasTab });

    if (window.XZFocus) {
      add('act_focus', 'palette.act_focus', '焦点模式 开/关',
        ['focus mode', '焦点模式', '焦点', '1+n'],
        function () { return fire(function () { return XZFocus.toggle(); }); },
        { checked: function () { return !!XZFocus.isActive(); },
          enabled: function () { return arr(tabs).length > 0 || !!XZFocus.isActive(); } });

      if (typeof XZFocus.toggleLayout === 'function') {
        add('act_focus_layout', 'palette.act_focus_layout', '焦点模式：条带 / 分区布局',
          ['focus layout', '布局', '条带', '分区', 'sector', 'strip'],
          function () { return fire(function () { return XZFocus.toggleLayout(); }); },
          { enabled: function () { return !!XZFocus.isActive(); } });
      }
    }

    add('act_tile', 'palette.act_tile', '平铺窗口',
      ['tile', '平铺', '窗口', 'layout'],
      function () { return fire(function () { return runWindowAction('tile', null); }); },
      { enabled: function () { return !!ipcRenderer; } });

    add('act_restore_tile', 'palette.act_restore_tile', '恢复上次布局',
      ['restore', '恢复布局', '上次布局', 'layout'],
      function () { return fire(function () { return runWindowAction('restore', null); }); },
      { enabled: function () { return !!ipcRenderer; } });

    add('act_park', 'palette.act_park', '挂起其它账号',
      ['park', '挂起', '其它账号', 'minimize'],
      function () { return fire(function () { return runWindowAction('park', null); }); },
      { enabled: function () { return !!ipcRenderer; } });

    add('act_unpark', 'palette.act_unpark', '全部还原',
      ['unpark', '还原', '全部还原', 'restore windows'],
      function () { return fire(function () { return runWindowAction('unpark', null); }); },
      { enabled: function () { return !!ipcRenderer; } });

    add('act_scatter', 'palette.act_scatter', '散开到多窗口并平铺',
      ['scatter', '散开', '多窗口', '平铺'],
      function () { return fire(function () { return scatterTabsAndTile(); }); },
      { enabled: function () { return arr(tabs).length > 1; }, focusMode: 'none' });

    add('act_multi_open', 'palette.act_multi_open', '多开：用多个档案打开本页',
      ['multi open', '多开', '多个档案', 'multi'],
      function () { return fire(function () { return showProfileOpenModal(); }); },
      { enabled: hasTab, focusMode: 'none' });

    add('act_screenshot', 'palette.act_screenshot', '截图',
      ['screenshot', '截图', 'capture', 'shot'],
      function () { return fire(function () { return screenshotCurrentGame(); }); },
      { enabled: hasTab });

    add('act_mute_all', 'palette.act_mute_all', '全局静音 开/关',
      ['mute', '全局静音', '静音', 'sound', 'audio'],
      function () { return fire(function () { return setGlobalMuted(!setng().globalMuted); }); },
      { checked: function () { return !!setng().globalMuted; } });

    add('act_mute_tab', 'palette.act_mute_tab', '本标签页静音 开/关',
      ['mute tab', '本标签页静音', '静音', 'audio'],
      function () {
        var t = actTab();
        return t ? fire(function () { return setTabMuted(t, !t.muted); }) : null;
      },
      { enabled: hasTab, checked: function () { var t = actTab(); return !!(t && t.muted); } });

    add('act_game_mode', 'palette.act_game_mode', '游戏模式 开/关',
      ['game mode', '游戏模式', '全屏', 'fullscreen'],
      function () { return fire(function () { return setGameMode(!bodyHas('game-mode')); }); },
      { checked: function () { return bodyHas('game-mode'); } });

    add('act_sidebar', 'palette.act_sidebar', '侧栏 显示/隐藏',
      ['sidebar', '侧栏', '侧边栏', 'nav'],
      function () { return fire(function () { return setSidebar(!bodyHas('sidebar-collapsed')); }); },
      { checked: function () { return !bodyHas('sidebar-collapsed'); } });

    // XZ-AIM-BEGIN
    add('act_measure', 'palette.act_measure', '测距浮层',
      ['measure', '测距', '距离', 'ruler'],
      function () { return fire(function () { return toggleMeasureOverlay(); }); },
      { enabled: hasTab,
        checked: function () { try { return !!(measuring && measuring.active); } catch (e) { return false; } } });

    if (window.AimAssist) {
      add('act_aim', 'palette.act_aim', '竞技辅助',
        ['aim', '竞技辅助', '瞄准', 'assist'],
        function () { return fire(function () { return AimAssist.toggle(); }); },
        { enabled: hasTab,
          checked: function () { try { return !!AimAssist.isVisible(); } catch (e) { return false; } },
          focusMode: 'none' });
    }

    // XZ-AIM-END
    add('act_zoom_fit', 'palette.act_zoom_fit', '适应窗口',
      ['fit', '适应窗口', '缩放', 'zoom'],
      function () { return fire(function () { return fitZoom(); }); },
      { enabled: hasTab, checked: function () { var t = actTab(); return !!(t && t.fit); } });

    add('act_zoom_reset', 'palette.act_zoom_reset', '重置缩放',
      ['reset zoom', '重置缩放', '100%', 'zoom'],
      function () { return fire(function () { return resetZoom(); }); },
      { enabled: hasTab });

    if (window.XZScale) {
      add('act_zoom_snap', 'palette.act_zoom_snap', '整数倍缩放 开/关',
        ['integer zoom', '整数倍', '缩放', 'snap', 'zoom'],
        function () { return fire(function () { return XZScale.toggle(actTab() || undefined); }); },
        { enabled: hasTab,
          checked: function () { try { return !!XZScale.isOn(actTab()); } catch (e) { return false; } } });
    }

    if (window.XZStatus) {
      add('act_status', 'palette.act_status', '状态条 显示/隐藏',
        ['status bar', '状态条', 'fps', '帧率', 'cpu'],
        function () { return fire(function () { return XZStatus.toggle(); }); },
        { checked: function () { try { return !!XZStatus.isVisible(); } catch (e) { return false; } } });
    }

    if (window.XZCleanup) {
      add('act_cleanup', 'palette.act_cleanup', '页面净化：关 / 隐藏杂项 / 居中',
        ['cleanup', '净化', '清理', '广告', 'clean'],
        function () { return fire(function () { return XZCleanup.cycle(actTab() || undefined); }); },
        { enabled: hasTab });
    }

    add('act_quick_note', 'palette.act_quick_note', '快速便签',
      ['note', '便签', '快速便签', 'quick note'],
      function () {
        return fire(function () { return setQuickNoteVisible(setng().showQuickNote === false); });
      },
      { checked: function () { return setng().showQuickNote !== false; }, focusMode: 'none' });

    if (window.XZOnboard) {
      add('act_onboarding', 'palette.act_onboarding', '重看新手引导',
        ['guide', '引导', '新手', 'welcome', 'onboarding'],
        function () { return fire(function () { return XZOnboard.show(); }); },
        { focusMode: 'none' });
    }

    // 别的模块注册进来的命令排在最后。
    for (var i = 0; i < extras.length; i++) {
      var c = extras[i];
      if (!c || typeof c.run !== 'function') continue;
      a.push({
        group: 'actions', id: c.id || ('ext_' + i), label: String(c.label || c.id || ''),
        sub: c.sub || '', keywords: arr(c.keywords), run: c.run,
        enabled: c.enabled, checked: c.checked, focusMode: c.focusMode || 'game'
      });
    }
    return a;
  }

  function pushActions(push, empty) {
    var acts = buildActions();
    if (empty) {
      // 空查询：只留高频的前几条，按 FREQUENT 的顺序。
      var picked = 0, i, j;
      for (i = 0; i < FREQUENT.length && picked < EMPTY_ACTIONS; i++) {
        for (j = 0; j < acts.length; j++) {
          if (acts[j].id === FREQUENT[i]) {
            if (acts[j].enabled != null && !resolve(acts[j].enabled)) break;
            acts[j].empty = true;
            picked++;
            break;
          }
        }
      }
    }
    for (var k = 0; k < acts.length; k++) push(acts[k]);
  }

  // ------------------------------------------------------------------ 绘制
  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      if (paletteOpen) renderNow(input.value);
    });
  }

  function renderNow(q) {
    items = buildItems(q);
    if (sel >= items.length) sel = 0;
    paint();
  }

  function paint() {
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!items.length) {
      var e = document.createElement('div');
      e.className = 'pal-empty';
      e.textContent = T('palette.empty', '没有匹配项');
      list.appendChild(e);
      return;
    }
    var lastGroup = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        var head = GROUP_HEAD[it.group];
        if (head) {
          var h = document.createElement('div');
          h.className = 'pal-group-head';
          h.textContent = T(head[0], head[1]);
          list.appendChild(h);
        }
      }
      var row = document.createElement('div');
      row.className = 'pal-item' + (i === sel ? ' sel' : '');
      row.setAttribute('data-idx', String(i));
      if (it.color) {
        var dot = document.createElement('span');
        dot.className = 'pal-dot';
        dot.style.background = it.color;
        row.appendChild(dot);
      }
      var lab = document.createElement('span');
      lab.className = 'pal-label';
      lab.textContent = it.label || '';
      row.appendChild(lab);
      if (it.sub) {
        var sb = document.createElement('span');
        sb.className = 'pal-sub';
        sb.textContent = it.sub;
        row.appendChild(sb);
      }
      if (it.checked) {
        var ck = document.createElement('span');
        ck.className = 'pal-check';
        ck.textContent = '✓';
        row.appendChild(ck);
      }
      list.appendChild(row);
    }
    reveal();
  }

  function paintSelection() {
    if (!list) return;
    var rows = list.getElementsByClassName('pal-item');
    for (var i = 0; i < rows.length; i++) {
      var on = String(rows[i].getAttribute('data-idx')) === String(sel);
      rows[i].className = 'pal-item' + (on ? ' sel' : '');
    }
    reveal();
  }

  function reveal() {
    try {
      var el = list.querySelector('.pal-item.sel');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
  }

  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    paintSelection();
  }

  // ------------------------------------------------------------------ 开 / 关
  function focusTab(t) {
    if (!t || !t.webview) return;
    // 对 guest 的唯一动作：一次 focus + 一条消息。没有节流 / 隐藏 / 重排 / 截图。
    try { t.webview.focus(); } catch (e) {}
    try { t.webview.send('xz:focus-game'); } catch (e) {}
  }

  // 'game'   把焦点还给打开面板前正在看的那个 tab（Esc / 点挡板 / 纯开关类命令）
  // 'follow' 命令换了 tab 或开了新页面 → 稍后聚焦新的当前 tab
  // 'none'   命令自己弹了界面（模态框、引导、别的 OS 窗口）→ 一根手指都不动
  function finishFocus(mode) {
    var keep = restoreTo;
    restoreTo = null;
    if (mode === 'none') return;
    if (mode === 'follow') {
      setTimeout(function () {
        if (paletteOpen || !inBrowser()) return;
        focusTab(actTab());
      }, 60);
      return;
    }
    if (keep && arr(tabs).indexOf(keep) >= 0 && inBrowser()) focusTab(keep);
  }

  function hide() {
    if (!paletteOpen) return;
    paletteOpen = false;
    if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
    if (root) root.classList.remove('open');
    try { window.removeEventListener('blur', onWindowBlur, true); } catch (e) {}
    try { input.blur(); } catch (e) {}
    items = [];
    sel = 0;
  }

  function open() {
    if (paletteOpen) return;
    build();
    try { closeAnyMenus(); } catch (e) {}
    restoreTo = (inBrowser() && actTab()) || null;
    paletteOpen = true;
    openedAt = Date.now();
    input.value = '';
    input.placeholder = T('palette.placeholder', '输入命令、档案、标签页或网址…');
    foot.textContent = T('palette.hint', '↑↓ 移动 · Enter 执行 · Esc 关闭');
    root.classList.add('open');
    sel = 0;
    renderNow('');
    try { input.focus(); input.select(); } catch (e) {}
    try { window.addEventListener('blur', onWindowBlur, true); } catch (e) {}
  }

  function close(mode) {
    if (!paletteOpen) return;
    hide();
    finishFocus(mode || 'game');
  }

  function runSelected() {
    var it = items[sel];
    if (!it) return;
    var mode = it.focusMode || 'game';
    hide();                    // 先收起：命令执行时面板已经不在屏幕上，也不再占焦点
    try {
      var r = it.run();
      if (r && typeof r.catch === 'function') r.catch(function () {});
    } catch (e) {
      try { console.warn('[XZPalette] 命令执行失败', e); } catch (e2) {}
    }
    finishFocus(mode);
  }

  function toggle() { if (paletteOpen) close('game'); else open(); }

  // ------------------------------------------------------------------ 外部信号
  // ⌘K 走主进程 View 菜单的 accelerator → sendToFocused('action','command-palette')。
  // 和 focus-mode.js 一样自己收 action，不去改 renderer.js 的 switch（否则会双触发）。
  if (ipcRenderer) {
    try {
      ipcRenderer.on('action', function (_e, a) {
        if (a === 'command-palette') toggle();
      });
    } catch (e) {}
  }

  // 语言 / 档案变了只重绘，不缓存任何东西。
  document.addEventListener('xz:language', function () {
    if (!paletteOpen) return;
    input.placeholder = T('palette.placeholder', '输入命令、档案、标签页或网址…');
    foot.textContent = T('palette.hint', '↑↓ 移动 · Enter 执行 · Esc 关闭');
    renderNow(input.value);
  });
  document.addEventListener('xz:profiles', function () {
    if (paletteOpen) renderNow(input.value);
  });
  // 标签页开关了就重绘；面板关着时是空操作。
  document.addEventListener('xz:tab-created', function () { if (paletteOpen) schedule(); });
  document.addEventListener('xz:tab-closed', function () { if (paletteOpen) schedule(); });

  // ------------------------------------------------------------ 公共接口（§4）
  window.XZPalette = {
    open: open,
    close: function () { close('game'); },
    toggle: toggle,
    isOpen: function () { return paletteOpen; },
    // 给别的模块追加命令：{ id, group:'actions', label, sub?, keywords:[], run(), enabled?(), checked?() }
    register: function (cmd) {
      if (!cmd || typeof cmd.run !== 'function') return;
      for (var i = 0; i < extras.length; i++) {
        if (extras[i] && cmd.id && extras[i].id === cmd.id) { extras[i] = cmd; return; }
      }
      extras.push(cmd);
    }
  };
})();

// ============================================================================
// 本文件通过 tOr(key, 中文兜底) 引用的 i18n 键（方案 §5，集成包 WP6 加进 i18n.js
// 的 en / zh-CN 两个字典）。键缺失时显示中文兜底，不会坏。
//
//   palette.placeholder     输入命令、档案、标签页或网址…   Type a command, profile, tab or address…
//   palette.empty           没有匹配项                     No matches
//   palette.hint            ↑↓ 移动 · Enter 执行 · Esc 关闭  ↑↓ move · Enter run · Esc close
//   palette.group_profiles  档案                           Profiles
//   palette.group_tabs      打开的标签页                    Open tabs
//   palette.group_library   游戏库与收藏                    Library & favorites
//   palette.group_recent    最近页面                       Recent pages
//   palette.group_routes    页面                           Pages
//   palette.group_actions   操作                           Actions
//   palette.switch_to       切换到 {name}                   Switch to {name}
//   palette.open_here       在本窗口打开 {name}              Open {name} in this window
//   palette.open_window     新窗口打开 {name}                Open {name} in a new window
//   palette.quick_enter     用 {name} 快速进入游戏            Jump back into the game as {name}
//   palette.open_url        打开网址 {url}                   Open address {url}
//   palette.route_prefix    打开 {name} 页面                 Go to {name}
//   palette.act_new_tab     新建标签页                      New tab
//   palette.act_new_window  新建窗口                        New window
//   palette.act_close_tab   关闭当前标签页                   Close current tab
//   palette.act_detach      把标签页移到新窗口                Move tab to a new window
//   palette.act_reload      重新加载                        Reload page
//   palette.act_focus       焦点模式 开/关                   Focus mode on / off
//   palette.act_focus_layout 焦点模式：条带 / 分区布局         Focus mode: strip / sector layout
//   palette.act_tile        平铺窗口                        Tile windows
//   palette.act_restore_tile 恢复上次布局                    Restore last layout
//   palette.act_park        挂起其它账号                     Park other accounts
//   palette.act_unpark      全部还原                        Unpark all
//   palette.act_scatter     散开到多窗口并平铺                Scatter tabs to windows & tile
//   palette.act_multi_open  多开：用多个档案打开本页           Open this page in several profiles
//   palette.act_screenshot  截图                           Screenshot the game
//   palette.act_mute_all    全局静音 开/关                   Global mute on / off
//   palette.act_mute_tab    本标签页静音 开/关                Mute this tab on / off
//   palette.act_game_mode   游戏模式 开/关                   Game mode on / off
//   palette.act_sidebar     侧栏 显示/隐藏                   Show / hide sidebar
//   palette.act_measure     测距浮层                        Measure overlay
//   palette.act_aim         竞技辅助                        Aim assist
//   palette.act_zoom_fit    适应窗口                        Fit to window
//   palette.act_zoom_reset  重置缩放                        Reset zoom
//   palette.act_zoom_snap   整数倍缩放 开/关                 Integer zoom on / off
//   palette.act_status      状态条 显示/隐藏                 Status bar show / hide
//   palette.act_cleanup     页面净化：关 / 隐藏杂项 / 居中     Page cleanup: off / hide / center
//   palette.act_quick_note  快速便签                        Quick note
//   palette.act_onboarding  重看新手引导                     Show the welcome guide again
//
// 复用的既有键（已在 i18n.js 里）：
//   report.title            报告 / Report            —— 「打开 报告 页面」的名字
//   sidebar.home / library / favorites / recent / windows / profiles / accounts /
//   doctor / notes / tasks / settings / shortcuts / about  —— 其余路由的名字
//
// 本文件调用的 renderer.js 全局（都在方案 §1.0 的「已核实可直接调用」清单里）：
//   tabs, activeId, profiles, bookmarks, history, settings, currentRoute,
//   windowProfileId, measuring,
//   activateTab, createTab, closeTab, detachTab, activeTab, openUrl, newTabUrl,
//   normalizeInput, hostOf, tabFullLabel, formatRelativeTime, setRoute, setSidebar,
//   setGameMode, tOr, isHexColor, playLibraryItem, runWindowAction, scatterTabsAndTile,
//   showProfileOpenModal, screenshotCurrentGame, toggleMeasureOverlay, setGlobalMuted,
//   setTabMuted, resetZoom, fitZoom, closeAnyMenus, setQuickNoteVisible,
//   switchToAccountSlot
// 可选模块（缺席时对应命令不出现）：XZFocus, XZScale, XZStatus, XZCleanup,
//   XZAutoLogin, XZOnboard, AimAssist
// ============================================================================
