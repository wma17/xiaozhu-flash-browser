// ============================================================================
// page-cleanup.js — 页面净化（Page Cleanup）—— 第三轮 WP4 / 方案 §2.4a
// ----------------------------------------------------------------------------
// 【它做什么】
//   按站点、按用户的明确选择，往 guest 页面里贴一小段 CSS，把游戏**周围**的
//   广告位和页面家具（导航、推荐、评论、右栏…）隐藏掉；center 档再把游戏容器
//   居中到视口中央。三档：off（默认）/ hide / center，每个站点各自记忆。
//
// 【它绝不做什么（用户红线）】
//   - 不隐藏、不缩放、不重排、不 re-parent、不截图游戏本身。center 档只给
//     「舞台容器」写 position/left/top/right/bottom/margin/width/height，
//     尺寸照抄它自己的 offsetWidth/offsetHeight —— 不用 transform（transform 会让
//     插件层做非整数重采样），不改 display，不动 object/embed 一个字节。
//   - 不做任何像素采样、回合检测、自动点击。
//   - 规则表是「窄而明确的选择器」白名单式清单，宁可漏掉一个广告，也不能碰到
//     游戏或它的祖先节点。每条选择器下面都写清楚它是什么、为什么安全。
//
// 【谁负责什么】
//   规则表全在本文件里（一处可审计）；preload 只是个哑执行器：收到什么 CSS 就贴
//   什么，收到 off 就把改过的全部清掉。两个通道（方案 §3.3）：
//       guest → 宿主   'xz:cleanup-query'  { host, path }        DOMContentLoaded + load 各一次
//       宿主 → guest   'xz:cleanup'        { mode, css, stage }  本文件的回答
//
// 运行环境：Electron 11.2.1 / Chromium 87。ES5（var / function，无箭头、无模板串、
// 无 let/const、无解构、无可选链），经典 script，靠裸标识符读 renderer.js 的顶层符号。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 没加载（或加载失败）时安静退出：宿主的接入点全是
  // if (window.XZCleanup)，本对象不存在 = 页面完全不被触碰。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZCleanup] renderer.js 作用域不可见，页面净化未启用'); } catch (e) {}
    return;
  }

  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) { ipcRenderer = null; }

  var MODES = ['off', 'hide', 'center'];
  var QUERY_CHANNEL = 'xz:cleanup-query';   // guest → 宿主
  var APPLY_CHANNEL = 'xz:cleanup';         // 宿主 → guest
  var selectBound = false;

  // ============================================================== 规则表
  // 4399 游戏页（.../flash/1129_1.htm，_1.htm 才是游戏页）的真实结构，方案 §1.4
  // 已从线上页面核实：
  //     #bigdiv.play › #middlediv.game › #gamebox › #swfdiv › center#game
  //                                                   › object#flashgame / embed#flashgame1
  // 下面 hide 里的每一条都是 #gamebox 的**兄弟或更外层的旁支**，没有一条是它的祖先，
  // 也没有一条能选中 object/embed 本身 —— 这是这张表能上线的唯一理由。
  var RULES = [
    {
      name: '4399-game-page',
      host: /(^|\.)4399\.com$/,
      path: /^\/flash\/\d+(_\d+)?\.htm/,
      hide: [
        '#addiv',            // 载入期的广告层（z-index:122）。页面自己的 show_gameload_Func 只往里写图片，不参与 SWF 实例化
        '.ins-ad',           // 正文中的插入式广告位
        '.r-ad',             // 右栏广告位
        '#boxright',         // 右栏整块（.fr.to-right：推荐 + 广告），与 #gamebox 是兄弟
        '#sides',            // 右侧浮动条（分享 / 回顶）
        '.tbar',             // 站点顶栏
        '#dhs',              // 站点导航条（.nav）
        '#gameTop',          // 游戏页顶部的横幅 / 面包屑区
        '#topdiv',           // 舞台下方的推广条
        '#relatedcontent',   // 相关游戏
        '#webgamecontent',   // 网页游戏推荐
        '#hscontent',        // 好玩的 / 合集推荐
        '#cnxhdiv',          // 猜你喜欢
        '#jsrelatedgame',    // 脚本注入的相关游戏位
        '#jswebgame',        // 脚本注入的网页游戏位
        '#PL',               // 评论区
        '#GameKey',          // 关键词 / 标签云
        '#shadow',           // 弹窗用的全屏遮罩（平时就是隐藏的，净化时保持隐藏）
        '.wechat-QR'         // 微信二维码浮层
      ],
      // keep 不生成任何 CSS，只用于 auditRules() 的自检：这些必须永远可见 ——
      // #uplayer 是玩家真的在用的工具条（重玩 / 放大 / 缩小 / 最佳 / 全屏），
      // 其余是游戏容器链上的每一环。
      keep: ['#uplayer', '#bigdiv', '#middlediv', '#gamebox', '#swfdiv', '#game', '#flashgame'],
      stage: '#gamebox',
      // 只有 _1.htm 这种真正的游戏页才有 #gamebox。介绍页（1129.htm）用的是同一套页面家具，
      // 所以 hide 照用，但 center 在那里没有可靠的舞台可居中 —— 与其让 preload 去猜
      // 「最大的 embed」（很可能是一个广告 SWF），不如在这一档自动降级成 hide。
      stagePath: /^\/flash\/\d+_\d+\.htm/
    },
    {
      name: 'generic',
      host: /./,
      path: null,
      // 通用兜底：没有专门规则的站点只隐藏「一眼就是广告」的东西。
      // 三重保险：(1) 只认整词 class token / 明确的广告 id 前后缀；
      //          (2) 全部限定在 div / ins 上 —— Flash 游戏是 object/embed，
      //              页游是 iframe，这些标签永远选不中；
      //          (3) iframe 只按第三方广告域名的 src 精确匹配。
      // 方案 §2.4a 原表里的 [class~="ad"]（裸 "ad" 整词，不限标签）没有采用：
      // 它有可能命中包着游戏的外层容器，属于「可能碰到游戏本体」的规则，不上线。
      hide: [
        'ins.adsbygoogle',                    // Google 广告位的标准标签
        'div.adsbygoogle',                    // 同上（部分站点用 div 承载）
        'iframe[src*="googlesyndication"]',   // Google 广告 iframe
        'iframe[src*="doubleclick.net"]',     // DoubleClick 广告 iframe
        'iframe[src*="googleads"]',           // Google 广告 iframe（另一种域名形态）
        'div[id^="ad_"]',                     // 常见广告容器 id 前缀
        'div[id^="ads_"]',                    // 同上
        'div[id$="_ad"]',                     // 常见广告容器 id 后缀
        'div[class~="ads"]',                  // class 整词 "ads"
        'div[class~="ad-box"]',               // class 整词 "ad-box"
        'div[class~="ad-banner"]',            // class 整词 "ad-banner"
        'div[class~="banner-ad"]'             // class 整词 "banner-ad"
      ],
      keep: [],
      stage: null                             // 没有已知舞台：center 档由 preload 兜底找最大的 embed/object
    }
  ];

  // 「命中」= 选择器里出现了**完整**的 keep 选择器（两端都在 token 边界上）。
  // 只做子串比较会把 #gameTop 误判成 #game，那是把好规则误杀。
  var KEEP_WORD = /[A-Za-z0-9_-]/;
  function hitsKeep(sel, keep) {
    if (sel === keep) return true;
    var at = sel.indexOf(keep);
    while (at >= 0) {
      var before = at > 0 ? sel.charAt(at - 1) : '';
      var after = sel.charAt(at + keep.length);
      if (!KEEP_WORD.test(before) && !(after && KEEP_WORD.test(after))) return true;
      at = sel.indexOf(keep, at + 1);
    }
    return false;
  }
  // 自检：hide 里出现（或包含）任何一条 keep 选择器，就把它剔掉并在控制台喊一声。
  // 规则表是手写的，这一步保证「改表时手滑」不会变成「游戏消失」。
  function auditRules() {
    for (var r = 0; r < RULES.length; r++) {
      var rule = RULES[r];
      if (!rule.keep || !rule.keep.length) continue;
      var kept = [];
      for (var i = 0; i < rule.hide.length; i++) {
        var sel = rule.hide[i], bad = false;
        for (var k = 0; k < rule.keep.length; k++) {
          if (hitsKeep(sel, rule.keep[k])) { bad = true; break; }
        }
        if (bad) { try { console.warn('[XZCleanup] 规则 ' + rule.name + ' 里的 "' + sel + '" 会命中必须保留的元素，已忽略'); } catch (e) {} }
        else kept.push(sel);
      }
      rule.hide = kept;
    }
  }
  try { auditRules(); } catch (e) {}

  // ============================================================== 安全包装
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
  function settingsObj() {
    try { return (typeof settings === 'object' && settings) ? settings : null; } catch (e) { return null; }
  }
  function tabList() {
    try { return Array.isArray(tabs) ? tabs : []; } catch (e) { return []; }
  }

  // ============================================================== URL / host
  // guest 发来的是 location.hostname（带 www），renderer 的 hostOf() 去掉 www。
  // 存储的键与规则匹配都必须用同一种写法，否则「在游戏页开的净化」换个入口就找不到了。
  function normHost(h) {
    var s = String(h == null ? '' : h).toLowerCase().trim();
    var at = s.indexOf('@');
    if (at >= 0) s = s.slice(at + 1);        // 去掉 user:pass@
    s = s.replace(/:\d+$/, '');              // 去掉端口
    s = s.replace(/^www\./, '');
    return s;
  }
  function parseLoc(url) {
    var s = String(url == null ? '' : url);
    var m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/?#]*)([^?#]*)/.exec(s);
    if (!m) return { host: '', path: '/' };
    return { host: normHost(m[1]), path: m[2] || '/' };
  }
  function locOfTab(tab) {
    try { return parseLoc(tab && tab.url); } catch (e) { return { host: '', path: '/' }; }
  }

  // ============================================================== 存储
  // settings.cleanup = { defaultMode: 'off'|'hide'|'center', hosts: { '<host>': mode } }
  // 低频偏好，跟其它设置一样整体回写。settings 还没加载完时给一个只读兜底，
  // 这样脚本顶层/早期事件里读它不会炸。
  function normMode(m) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i] === m) return m;
    return 'off';
  }
  function store() {
    var s = settingsObj();
    if (!s) return { defaultMode: 'off', hosts: {} };
    if (!s.cleanup || typeof s.cleanup !== 'object') s.cleanup = { defaultMode: 'off', hosts: {} };
    if (!s.cleanup.hosts || typeof s.cleanup.hosts !== 'object') s.cleanup.hosts = {};
    s.cleanup.defaultMode = normMode(s.cleanup.defaultMode);
    return s.cleanup;
  }
  function persist() {
    try { if (typeof saveSettings === 'function') saveSettings(); } catch (e) {}
  }
  function modeFor(host) {
    var h = normHost(host);
    if (!h) return 'off';                    // about:blank / data: 之类：永远不动
    var st = store();
    var own = st.hosts[h];
    if (own != null) return normMode(own);
    return normMode(st.defaultMode);
  }
  function setMode(host, mode) {
    var h = normHost(host);
    if (!h) return;
    var st = store();
    var m = normMode(mode);
    // 与默认值相同就不留记录，hosts 表保持干净（用户改了默认值后这些站点自动跟随）。
    if (m === normMode(st.defaultMode)) { delete st.hosts[h]; }
    else st.hosts[h] = m;
    persist();
  }

  // ============================================================== 规则 → spec
  function ruleFor(host, path) {
    var h = normHost(host), p = String(path == null ? '/' : path);
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      try {
        if (!r.host.test(h)) continue;
        if (r.path && !r.path.test(p)) continue;
        return r;
      } catch (e) {}
    }
    return null;
  }
  // 唯一生成 CSS 的地方：一条选择器一条 display:none，外加 center 档的两句页面级样式。
  function cssFor(rule, mode) {
    var out = '';
    for (var i = 0; i < rule.hide.length; i++) out += rule.hide[i] + '{display:none!important}';
    // center：把页面滚动条收掉、底色压黑，让居中的舞台周围是干净的黑边。
    // 只碰 html/body，不碰游戏容器本身（容器的定位由 preload 写 inline 样式，可逆）。
    if (mode === 'center') out += 'html,body{overflow:hidden!important;background:#000!important}';
    return out;
  }
  function specForLoc(host, path, mode) {
    var m = normMode(mode);
    var rule = (m === 'off') ? null : ruleFor(host, path);
    if (!rule) return { mode: 'off', css: '', stage: null };
    // center 但这份文档不是已知的舞台页：本次只按 hide 执行（记忆的模式不变，
    // 回到游戏页就自动恢复居中）。
    if (m === 'center' && rule.stagePath && !rule.stagePath.test(String(path || '/'))) m = 'hide';
    return { mode: m, css: cssFor(rule, m), stage: (m === 'center' ? (rule.stage || null) : null) };
  }
  function specFor(url, mode) {
    var loc = parseLoc(url);
    return specForLoc(loc.host, loc.path, mode);
  }
  function hasOwnRule(host, path) {
    var r = ruleFor(host, path);
    return !!(r && r.name !== 'generic');
  }

  // ============================================================== 发送
  // 只在两种时机发：guest 主动问（新文档就绪）、用户刚改了模式。没有轮询、没有定时器。
  function push(tab) {
    if (!tab || !tab.webview) return;
    var loc = locOfTab(tab);
    if (!loc.host) return;
    try { tab.webview.send(APPLY_CHANNEL, specForLoc(loc.host, loc.path, modeFor(loc.host))); } catch (e) {}
  }
  // 多开时同一个游戏页会在好几个档案里各开一份：改了模式就一起更新，
  // 否则用户会看到「有的窗口净化了、有的没有」。
  function pushHost(host) {
    var h = normHost(host);
    if (!h) return;
    var list = tabList();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && locOfTab(list[i]).host === h) push(list[i]);
    }
  }

  // ============================================================== 三态切换
  function nextMode(m) {
    if (m === 'off') return 'hide';
    if (m === 'hide') return 'center';
    return 'off';
  }
  function modeLabel(mode) {
    if (mode === 'hide') return t_('cleanup.mode_hide', '隐藏广告和杂项');
    if (mode === 'center') return t_('cleanup.mode_center', '隐藏杂项并居中游戏');
    return t_('cleanup.mode_off', '关');
  }
  function cycle(tab) {
    var t = tab || activeTabSafe();
    if (!t) return;
    var loc = locOfTab(t);
    if (!loc.host) return;
    var cur = modeFor(loc.host);
    var nxt = nextMode(cur);
    setMode(loc.host, nxt);
    pushHost(loc.host);

    var msg;
    if (nxt === 'off') {
      msg = t_('cleanup.toast_off', '已关闭 {host} 的页面净化').replace('{host}', loc.host);
    } else {
      msg = t_('cleanup.toast_on', '已对 {host} 启用页面净化：{mode}')
        .replace('{host}', loc.host).replace('{mode}', modeLabel(nxt));
      // 没有专门规则的站点要说清楚「只隐藏通用广告位」，别让用户以为没生效。
      if (!hasOwnRule(loc.host, loc.path)) {
        msg += ' ' + t_('cleanup.no_rules', '{host} 没有专门的净化规则，只隐藏通用广告位。').replace('{host}', loc.host);
      } else if (nxt === 'center') {
        // center 会让插件重排一次（不是重载，音乐不断），但对局中还是别切。
        msg += ' ' + t_('cleanup.relayout_hint', '切换净化会让游戏重排一次，建议在大厅时切换。');
      }
    }
    toast(msg);
  }

  // ============================================================== 工具菜单项
  // 契约里传进来的 addToolAction 只接受 i18n key、不做占位符替换，而这一项要显示
  // 「页面净化：<当前模式>」，所以这里自己按 addToolToggle 的同一套结构建 DOM
  // （.menu-item + <span>标题</span> + <span class="state">状态</span>），
  // 视觉与其它工具项完全一致，文案则能走 t_ 的中文兜底。
  function addMenuItem(menu, tab, addToolActionUnused) {
    try {
      if (!menu) return;
      var t = tab || activeTabSafe();
      var loc = t ? locOfTab(t) : { host: '', path: '/' };
      var enabled = !!(t && loc.host);
      var mode = enabled ? modeFor(loc.host) : 'off';
      var item = document.createElement('div');
      item.className = 'menu-item' + (mode !== 'off' ? ' check' : '') + (enabled ? '' : ' disabled');
      var lab = document.createElement('span');
      lab.textContent = t_('tools.cleanup', '页面净化');
      var state = document.createElement('span');
      state.className = 'state';
      state.textContent = modeLabel(mode);
      item.appendChild(lab);
      item.appendChild(state);
      item.title = t_('set.cleanup_sub', '每个网站单独记住；这里是初始值。只处理游戏周围的页面，不碰游戏本身。');
      if (enabled) {
        item.addEventListener('click', function (ev) {
          ev.stopPropagation();
          try { if (typeof closeAnyMenus === 'function') closeAnyMenus(); } catch (e) {}
          cycle(t);
        });
      }
      menu.appendChild(item);
    } catch (e) {}
  }

  // ============================================================== 设置页
  // renderSettings() 不知道这个下拉的存在，所以自己在 boot 与进入设置页时同步一次。
  function syncSelect() {
    try {
      var el = document.getElementById('setting-cleanup-default');
      if (!el) return;
      el.value = store().defaultMode;
      if (!selectBound) {
        selectBound = true;
        el.addEventListener('change', function () {
          var st = store();
          st.defaultMode = normMode(el.value);
          persist();
          // 默认值变了，所有「没有单独记忆」的站点跟着变：把当前开着的页面都刷新一遍。
          var list = tabList();
          for (var i = 0; i < list.length; i++) push(list[i]);
        });
      }
    } catch (e) {}
  }

  // ============================================================== 事件
  // 每个新 tab 挂一个 ipc-message 监听，专门回答 guest 的净化询问。
  // renderer 自己那个 ipc-message 监听只认它的四个 channel，对未知 channel 什么也不做，
  // 两个监听器互不干扰。
  document.addEventListener('xz:tab-created', function (e) {
    try {
      var tab = e && e.detail;
      if (!tab || !tab.webview || tab._xzCleanupBound) return;
      tab._xzCleanupBound = true;
      tab.webview.addEventListener('ipc-message', function (ev) {
        try {
          if (!ev || ev.channel !== QUERY_CHANNEL) return;
          var p = (ev.args && ev.args[0]) || {};
          var host = normHost(p.host || locOfTab(tab).host);
          var path = String(p.path == null ? locOfTab(tab).path : p.path);
          if (!host) return;
          // 即使是 off 也照样回答：让 guest 的状态永远由宿主一处决定，
          // 关掉净化时它才知道要把之前贴的东西清干净。
          tab.webview.send(APPLY_CHANNEL, specForLoc(host, path, modeFor(host)));
        } catch (err) {}
      });
    } catch (err) {}
  });
  document.addEventListener('xz:boot', function () { syncSelect(); });
  document.addEventListener('xz:route', function (e) {
    if (e && e.detail === 'settings') syncSelect();
  });

  // 主进程 View 菜单的 Clean Up Page：模块自己收 action，不改 renderer 的 switch。
  if (ipcRenderer) {
    try {
      ipcRenderer.on('action', function (_e, a) {
        if (a === 'cycle-cleanup') cycle(null);
      });
    } catch (e) {}
  }

  // ============================================================== 公共接口（方案 §4）
  window.XZCleanup = {
    modeFor: modeFor,
    setMode: setMode,
    cycle: cycle,
    specFor: specFor,
    addMenuItem: addMenuItem
  };
})();

// ============================================================================
// 本文件通过 t_(key, 中文兜底) 引用的 i18n 键（en / zh-CN 两边都要有，见方案 §5）：
//
//   tools.cleanup          Page cleanup                     工具菜单项标题
//   cleanup.mode_off       Off                              状态词 / 下拉项
//   cleanup.mode_hide      Hide ads and page furniture      状态词 / 下拉项
//   cleanup.mode_center    Hide and center the game         状态词 / 下拉项
//   cleanup.toast_on       Page cleanup for {host}: {mode}   切到 hide/center 的 toast
//   cleanup.toast_off      Page cleanup off for {host}       切回 off 的 toast
//   cleanup.no_rules       No dedicated rules for {host}…    只有通用兜底时补一句
//   cleanup.relayout_hint  Switching cleanup re-lays out…    切到 center 时补一句
//   set.cleanup_sub        Each site remembers its own…      工具菜单项的 title
//
// 由 index.html 的 data-i18n 使用、本文件不直接引用：
//   set.cleanup_default、cleanup.menu_label（菜单文案本文件用「标题 + 状态」两段式表达）
//
// 集成侧接入点（方案 §3，全部由 WP6 落地）：
//   R6   xz:tab-created 事件（本文件据此挂 ipc-message 监听）
//   R11  工具菜单：if (window.XZCleanup) XZCleanup.addMenuItem(menu, tab, addToolAction)
//   M7   View 菜单 Clean Up Page → action 'cycle-cleanup'（本文件自己接收）
//   H4   设置页 #setting-cleanup-default（本文件自己绑定）
//   W1   preload：ipcRenderer.on('xz:cleanup', spec) 执行器
//        spec = { mode: 'off'|'hide'|'center', css: string, stage: string|null }
//   W2   preload：DOMContentLoaded 与 load 各发一次
//        ipcRenderer.sendToHost('xz:cleanup-query', { host: location.hostname, path: location.pathname })
// ============================================================================
