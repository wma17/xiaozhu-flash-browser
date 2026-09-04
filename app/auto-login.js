// ============================================================================
// auto-login.js — 自动登录 / 快速进入游戏（第三轮 §2.5，WP4-P5）
// ----------------------------------------------------------------------------
// 这个模块只做两件事，两件都发生在**页面 DOM 层**：
//   1) 自动登录：档案（profile）自己打开开关之后，遇到 preload 能摸到的登录表单时，
//      用**已有的密码管线**（passwords 表 → pw:fill → 新增的 pw:submit-now）填好并提交
//      一次。密码不经过本模块的任何存储，只是从 renderer 已经持有的凭据对象里读出来，
//      通过既有的 IPC 通道原样转交给 guest。
//   2) 快速进入：记住每个档案「上次所在的游戏地址」（挂在 profile 上，走 profiles:upsert
//      持久化），让新窗口 / 新标签页 / 命令面板可以直接回到那个地址。
//
// 【它做不到什么（诚实说明，不要给用户错觉）】
//   - Flash 影片内部的一切都碰不到：选服、进房、点「开始游戏」、读战斗状态。PPAPI 插件
//     的内容对 DOM 完全不可见，没有任何脚本能点到影片里的按钮。所以「自动进入某个房间」
//     这种事在本浏览器里不存在，本模块只能把你送到**页面**，剩下的要自己点。
//   - 跨域 iframe 里的登录框（4399 通行证 passport/ptlogin 常常如此）也摸不到：
//     webview-preload 只在 guest 主框架和同源 iframe 里运行，跨域子框架需要
//     nodeIntegrationInSubFrames，那会把 node 能力开进广告 iframe —— 本轮明确不做。
//     这种页面上流程根本不会启动，只会提示一次 autologin.cross_origin。
//   - 登录成功与否无法可靠判断：我们只知道「表单提交动作发出去了」。所以失败（表单字段
//     对不上）会被记为失败并**停止**对该标签页该 host 的自动尝试，绝不反复重试。
//
// 【安全边界】
//   - 逐档案 opt-in，默认关（profile.autoLogin !== true 时整条链路是空操作）。
//   - 只在「这个档案自己的游戏/登录站点」上填写与提交（见 hostBelongsToProfile）。
//   - 每个文档最多提交一次（preload 侧还有一次性标志），同一标签页同一 host 20 秒内
//     只尝试一次、最多 2 次；一旦收到失败回执就锁死，等用户自己动手。
//   - 不新增任何密码存储：没有 localStorage、没有新 store、没有把密码写进 profile。
//
// 运行环境：Electron 11.2.1 / Chromium 87。本文件是 ES5（var / function，无箭头、无模板
// 串、无 let/const、无解构、无可选链），经典 script，靠裸标识符读 renderer.js 的顶层符号。
// 模块缺席时 renderer 的钩子都是 if (window.XZAutoLogin) 守卫，行为与本文件不存在时一致。
// ============================================================================
(function () {
  'use strict';

  // renderer.js 的作用域不可见（加载失败 / 顺序变了）时安静退出，什么都不注册。
  if (typeof tabs === 'undefined' || typeof activateTab !== 'function') {
    try { console.warn('[XZAutoLogin] renderer.js 作用域不可见，自动登录未启用'); } catch (e) {}
    return;
  }

  // ------------------------------------------------------------------ 常量
  var ATTEMPT_COOLDOWN_MS = 20000;  // 同一标签页同一 host 两次尝试之间的最小间隔
  var MAX_ATTEMPTS_PER_HOST = 2;    // 同一标签页同一 host 的尝试上限（防环）
  var FILL_TO_SUBMIT_MS = 350;      // 填完到提交之间留给页面 input/change 处理的时间
  var LAST_URL_DEBOUNCE_MS = 2000;  // 「上次游戏地址」写盘去抖（导航会连着来好几次）
  var CROSS_ORIGIN_WAIT_MS = 20000; // 等这么久还没收到 pw:request 就认为登录框在跨域框架里
  // 登录 / 通行证类地址：既用来判断「该不该提示跨域」，也用来把它排除出「上次游戏地址」
  // （回到登录页没有意义；真需要登录时，打开游戏地址自然会被重定向过去）。
  var LOGIN_PATH_RE = /(^|[\/._?&=-])(login|logon|signin|sign-in|passport|ptlogin|register|reg)\b/i;
  // 4399 的游戏页模板（`_1.htm` 才是游戏页，`.htm` 是介绍页）——用于在没有站点规则时
  // 也能认出「这是个游戏页」。
  var GAME_URL_RE = /4399\.com\/flash\/\d+(_\d+)?\.htm/i;

  // ------------------------------------------------------------------ 模块状态
  // 都是「会话内」的临时状态，不持久化；持久化的只有 profile 上的几个字段。
  var lastUrlTimers = {};    // profileId -> timer（上次游戏地址的去抖）
  var crossTimers = {};      // tabId -> timer（跨域提示的等待）
  var crossNotified = {};    // tabId|host -> true（跨域提示每标签页每 host 只提示一次）

  // ------------------------------------------------------------------ 小工具
  function t_(key, zh) {
    try { return (typeof tOr === 'function') ? tOr(key, zh) : zh; } catch (e) { return zh; }
  }
  function toast(text, action) {
    try { if (text && typeof showToast === 'function') showToast(text, action); } catch (e) {}
  }
  function fill1(text, token, value) {
    return String(text == null ? '' : text).replace(token, String(value == null ? '' : value));
  }
  // profileById() 找不到时会退回 profiles[0]，那会让「某档案的上次地址」张冠李戴，
  // 所以这里一律用严格查找。
  function profileOf(id) {
    try {
      if (!id || typeof profiles === 'undefined' || !profiles) return null;
      for (var i = 0; i < profiles.length; i++) {
        if (profiles[i] && profiles[i].id === id) return profiles[i];
      }
    } catch (e) {}
    return null;
  }
  function tabById(id) {
    try {
      for (var i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].id === id) return tabs[i];
    } catch (e) {}
    return null;
  }
  function profileOfTab(tab) {
    try {
      if (typeof tabProfile === 'function') return tabProfile(tab);
      return tab ? profileOf(tab.profileId) : null;
    } catch (e) { return null; }
  }
  function urlHost(url) {
    try {
      var h = new URL(String(url)).hostname;
      return h ? h.toLowerCase().replace(/^www\./, '') : '';
    } catch (e) { return ''; }
  }
  function hostsMatch(a, b) {
    var x = String(a || '').toLowerCase().replace(/^www\./, '');
    var y = String(b || '').toLowerCase().replace(/^www\./, '');
    if (!x || !y) return false;
    try {
      // renderer 的 hostMatches 已经实现了「同域 / 父域 / 子域都算数」的既有语义，
      // 密码匹配用的就是它，这里必须与之一致。
      if (typeof hostMatches === 'function') return hostMatches(x, y);
    } catch (e) {}
    return x === y ||
      x.slice(-(y.length + 1)) === ('.' + y) ||
      y.slice(-(x.length + 1)) === ('.' + x);
  }
  function credentialsFor(profileId, host) {
    try {
      if (typeof findAllCredentials === 'function') return findAllCredentials(profileId, host) || [];
    } catch (e) {}
    return [];
  }
  function profileCredentials(profileId) {
    var out = [];
    try {
      if (typeof passwords === 'undefined' || !passwords) return out;
      for (var i = 0; i < passwords.length; i++) {
        if (passwords[i] && passwords[i].profileId === profileId) out.push(passwords[i]);
      }
      out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    } catch (e) {}
    return out;
  }

  // 每标签页的尝试状态。挂在 tab 对象上，tab 消失时自然一起消失。
  function stateFor(tab) {
    if (!tab._xzAutoLogin) {
      tab._xzAutoLogin = { host: '', at: 0, tries: 0, blocked: false, sawRequest: false };
    }
    return tab._xzAutoLogin;
  }
  function resetState(st, host) {
    st.host = host || '';
    st.at = 0;
    st.tries = 0;
    st.blocked = false;
    st.sawRequest = false;
  }

  // ------------------------------------------------------- 「这是本档案的站点吗」
  // 自动填写/提交只允许发生在这个档案自己的游戏/登录站点上。四条来源，任一命中即可：
  //   1) 档案的站点规则（profile.sites，profileForUrl 的既有语义）；
  //   2) 这个档案已保存的某条账号的 host（凭据本来就是按 host 存的）；
  //   3) 这个档案某条账号的游戏地址 gameUrl 的 host；
  //   4) 这个档案记住的上次游戏地址的 host。
  // 另外还要求 guest 报上来的 host 与标签页当前真实 URL 的 host 一致，避免用一个陈旧
  // 或对不上的 payload 在别人的页面上填密码。
  function hostBelongsToProfile(p, tab, host) {
    if (!p || !host) return false;
    var pageHost = urlHost(tab && tab.url);
    if (pageHost && !hostsMatch(pageHost, host)) return false;
    try {
      if (typeof profileForUrl === 'function' && tab && tab.url) {
        var ruled = profileForUrl(tab.url);
        if (ruled && ruled.id === p.id) return true;
      }
    } catch (e) {}
    var creds = profileCredentials(p.id);
    for (var i = 0; i < creds.length; i++) {
      if (hostsMatch(creds[i].host, host)) return true;
      if (creds[i].gameUrl && hostsMatch(urlHost(creds[i].gameUrl), host)) return true;
    }
    if (p.lastGameUrl && hostsMatch(urlHost(p.lastGameUrl), host)) return true;
    return false;
  }

  // 多条凭据时用档案上指定的那条；没指定就不动手（renderer 已经弹了账号选择器，
  // 让用户自己选比替他猜安全）。
  function pickCredential(p, list) {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    if (!p.autoLoginAccountId) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === p.autoLoginAccountId) return list[i];
    }
    return null;
  }

  // ------------------------------------------------------------------ 自动登录
  // renderer 的 pw:request 分支处理完（唯一凭据已 pw:fill / 多条已弹选择器）之后调用。
  function onLoginForm(tab, host, matches) {
    try {
      if (!tab || !tab.webview || !host) return;
      var p = profileOfTab(tab);
      if (!p || p.autoLogin !== true) return;              // 严格 opt-in：默认什么都不做
      if (!hostBelongsToProfile(p, tab, host)) return;     // 不是本档案的站点，绝不填也不交

      var list = (matches && matches.length) ? matches : credentialsFor(p.id, host);
      var cred = pickCredential(p, list);
      if (!cred || !cred.password) return;

      var st = stateFor(tab);
      if (st.host !== host) resetState(st, host);          // 换了站点，重新计
      if (st.blocked) return;                              // 上一次提交失败 → 不自动重试
      var now = Date.now();
      if (st.at && (now - st.at) < ATTEMPT_COOLDOWN_MS) return;
      if (st.tries >= MAX_ATTEMPTS_PER_HOST) return;
      st.at = now;
      st.tries += 1;

      // renderer 只在「恰好一条凭据」时替我们发过 pw:fill；多条时它弹的是选择器，
      // 所以这里要自己把选中的那条填进去。密码只在这一步经手，不留副本。
      var needFill = list.length !== 1;
      var username = cred.username || '';
      if (needFill) {
        try { tab.webview.send('pw:fill', { username: username, password: cred.password }); } catch (e) {}
      }
      cred = null;
      list = null;

      var tabId = tab.id;
      setTimeout(function () {
        try {
          var live = tabById(tabId);
          if (!live || !live.webview) return;
          var s2 = stateFor(live);
          if (s2.host !== host) return;                    // 期间已经跳到别的站点
          var p2 = profileOfTab(live);
          if (!p2 || p2.autoLogin !== true) return;        // 期间开关被关掉了
          if (!hostBelongsToProfile(p2, live, host)) return;
          // preload 端还会再核一遍字段（密码非空、用户名一致）并且每个文档只提交一次。
          live.webview.send('pw:submit-now', { username: username });
        } catch (e) {}
      }, FILL_TO_SUBMIT_MS);
    } catch (e) {}
  }

  // preload 的回执。ok=false 一律视为失败并锁死这个标签页 + host 的自动尝试。
  function onAutoSubmitted(tab, payload) {
    try {
      var st = stateFor(tab);
      var p = profileOfTab(tab);
      var name = p ? (p.name || '') : '';
      if (payload && payload.ok) {
        toast(fill1(t_('autologin.submitted_toast', '已为 {name} 自动登录'), '{name}', name));
      } else {
        st.blocked = true;
        toast(fill1(t_('autologin.failed_toast', '未能为 {name} 提交登录表单'), '{name}', name));
      }
    } catch (e) {}
  }

  // 跨域 iframe 的登录框：preload 根本发不出 pw:request，流程不会启动。这时候沉默会像
  // 「开关坏了」，所以在明显是登录页、且这个档案确实有该 host 的凭据时提示一次。
  function scheduleCrossOriginNotice(tab, url) {
    try {
      if (crossTimers[tab.id]) { clearTimeout(crossTimers[tab.id]); delete crossTimers[tab.id]; }
      var p = profileOfTab(tab);
      if (!p || p.autoLogin !== true) return;
      if (!/^https?:/i.test(String(url)) || !LOGIN_PATH_RE.test(String(url))) return;
      var host = urlHost(url);
      if (!host) return;
      var key = tab.id + '|' + host;
      if (crossNotified[key]) return;
      if (!credentialsFor(p.id, host).length) return;
      var tabId = tab.id;
      crossTimers[tabId] = setTimeout(function () {
        delete crossTimers[tabId];
        try {
          var live = tabById(tabId);
          if (!live) return;
          var st = stateFor(live);
          if (st.sawRequest) return;                 // preload 摸得到表单，不是跨域情况
          if (urlHost(live.url) !== host) return;    // 已经走了
          crossNotified[key] = true;
          toast(t_('autologin.cross_origin',
            '这个页面的登录框在另一个站点的框架里，浏览器无法自动填写。'));
        } catch (e) {}
      }, CROSS_ORIGIN_WAIT_MS);
    } catch (e) {}
  }

  // ------------------------------------------------------------ 上次游戏地址
  function isGameUrl(url, p) {
    if (!/^https?:/i.test(String(url))) return false;
    if (GAME_URL_RE.test(String(url))) return true;
    try {
      if (typeof profileForUrl === 'function') {
        var ruled = profileForUrl(url);
        if (ruled && p && ruled.id === p.id) return true;
      }
    } catch (e) {}
    var host = urlHost(url);
    if (!host || !p) return false;
    var creds = profileCredentials(p.id);
    for (var i = 0; i < creds.length; i++) {
      if (creds[i].gameUrl && hostsMatch(urlHost(creds[i].gameUrl), host)) return true;
      if (hostsMatch(creds[i].host, host)) return true;
    }
    return false;
  }

  function rememberGameUrl(tab, url) {
    try {
      var p = profileOfTab(tab);
      if (!p || !url) return;
      if (LOGIN_PATH_RE.test(String(url))) return;    // 登录页不是「上次游戏地址」
      if (!isGameUrl(url, p)) return;
      if (p.lastGameUrl === url) return;
      var pid = p.id;
      var target = String(url);
      if (lastUrlTimers[pid]) clearTimeout(lastUrlTimers[pid]);
      lastUrlTimers[pid] = setTimeout(function () {
        delete lastUrlTimers[pid];
        try {
          var fresh = profileOf(pid);
          if (!fresh || fresh.lastGameUrl === target) return;
          // profiles:upsert 是 Object.assign 合并 + 广播，任意字段都能持久化。
          if (typeof upsertProfile === 'function') {
            upsertProfile({ id: pid, lastGameUrl: target, lastGameAt: Date.now() });
          }
        } catch (e) {}
      }, LAST_URL_DEBOUNCE_MS);
    } catch (e) {}
  }

  // 「快速进入」的目标地址：上次游戏地址优先，否则退回这个档案最近更新的账号的游戏地址。
  // quickEnter === false 时返回 null，四个「新窗口」钩子就会退回原来的行为。
  function quickUrlFor(profileId) {
    try {
      var p = profileOf(profileId);
      if (!p || p.quickEnter === false) return null;
      if (p.lastGameUrl && /^https?:/i.test(String(p.lastGameUrl))) return String(p.lastGameUrl);
      var creds = profileCredentials(profileId);
      for (var i = 0; i < creds.length; i++) {
        var raw = creds[i].gameUrl;
        if (!raw) continue;
        var url = raw;
        try { if (typeof normalizeGameUrl === 'function') url = normalizeGameUrl(raw); } catch (e) {}
        if (/^https?:/i.test(String(url))) return String(url);
      }
    } catch (e) {}
    return null;
  }

  // 本窗口已经有这个档案的标签页 → 就地导航；否则新建一个（分区随档案走）。
  function jump(profileId) {
    try {
      var url = quickUrlFor(profileId);
      if (!url) {
        toast(t_('autologin.no_last_url', '还没有记住游戏地址'));
        return;
      }
      var found = null;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i] && tabs[i].profileId === profileId) { found = tabs[i]; break; }
      }
      if (found) {
        activateTab(found.id);
        try { if (typeof setRoute === 'function') setRoute('browser'); } catch (e) {}
        if (found.url !== url) {
          try { found.webview.loadURL(url); } catch (e) {}
        }
      } else if (typeof createTab === 'function') {
        createTab(url, { profileId: profileId });
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 档案卡 UI
  function span(text, cls) {
    var el = document.createElement('span');
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }
  function stopBubble(e) { try { e.stopPropagation(); } catch (err) {} }

  // renderProfiles 的非编辑分支每次重绘都会调用（R18），所以必须幂等。
  function decorateProfileCard(card, p) {
    try {
      if (!card || !p || card.querySelector('.pc-xz-row')) return;
      var meta = card.querySelector('.pc-meta');
      if (!meta || !meta.parentNode) return;

      var creds = profileCredentials(p.id);
      var on = p.autoLogin === true;
      var tip = t_('autologin.tip',
        '这个档案遇到登录框时，自动填入已保存的密码并提交。' +
        '只对页面里的登录框有效，游戏内部的选服和进房无法自动化。');

      var row = document.createElement('div');
      row.className = 'pc-xz-row';
      // 只用 index.html 已有的 token，不写字面量颜色/圆角；本包不拥有任何 CSS 文件，
      // 所以这一行的样式只能内联。
      row.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:var(--s-2);' +
        'margin-top:var(--s-2);font-size:var(--fs-caption);color:var(--text-secondary)';
      // 档案卡本身可拖拽排序，开关上的按下不能冒泡上去。
      row.addEventListener('mousedown', stopBubble);

      var label = span('⚡ ' + t_('autologin.label', '自动登录'));
      label.title = tip;
      row.appendChild(label);

      var sw = document.createElement('div');
      sw.className = 'switch' + (on ? ' on' : '');
      sw.title = tip;
      row.appendChild(sw);

      var stateText = span(on ? t_('autologin.on', '开') : t_('autologin.off', '关'));
      row.appendChild(stateText);

      // 同一档案在同一站点有多条账号时，必须指明用哪一条，否则自动登录不动手。
      var sel = null;
      if (creds.length > 1) {
        sel = document.createElement('select');
        sel.title = t_('autologin.pick_account', '自动登录用的账号');
        for (var i = 0; i < creds.length; i++) {
          var opt = document.createElement('option');
          opt.value = creds[i].id || '';
          opt.textContent = (creds[i].username || creds[i].host || '?') +
            (creds[i].host ? ' · ' + creds[i].host : '');
          sel.appendChild(opt);
        }
        try { sel.value = p.autoLoginAccountId || (creds[0] && creds[0].id) || ''; } catch (e) {}
        sel.addEventListener('mousedown', stopBubble);
        sel.addEventListener('click', stopBubble);
        sel.addEventListener('change', function () {
          setAutoLogin(p.id, sw.classList.contains('on'), sel.value);
        });
        row.appendChild(sel);
      }

      sw.addEventListener('click', function (e) {
        stopBubble(e);
        var now = !sw.classList.contains('on');
        sw.classList.toggle('on', now);
        stateText.textContent = now ? t_('autologin.on', '开') : t_('autologin.off', '关');
        setAutoLogin(p.id, now, sel ? sel.value : undefined);
        // 打开时把能力边界当场说清楚，免得用户以为它会替他选服进房。
        if (now) toast(tip);
      });

      if (!creds.length) {
        var hint = span(t_('autologin.no_password',
          '这个档案还没有保存密码。先登录一次并选择保存。'));
        hint.style.cssText = 'opacity:.75';
        row.appendChild(hint);
      }

      // 快速进入：只是打开上次那个**页面**，进游戏之后的事情要自己点。
      var url = quickUrlFor(p.id);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = t_('autologin.quick_enter', '快速进入');
      btn.title = url
        ? t_('autologin.quick_enter_tip', '打开这个档案上次所在的游戏地址')
        : t_('autologin.no_last_url', '还没有记住游戏地址');
      if (!url) btn.disabled = true;
      btn.addEventListener('mousedown', stopBubble);
      btn.addEventListener('click', function (e) { stopBubble(e); jump(p.id); });
      row.appendChild(btn);

      if (p.lastGameUrl) {
        var last = span('↩ ' + t_('autologin.last_url', '上次游戏地址') +
          ' · ' + (urlHost(p.lastGameUrl) || p.lastGameUrl));
        last.title = String(p.lastGameUrl);
        last.style.cssText = 'opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px';
        row.appendChild(last);
      }

      meta.parentNode.insertBefore(row, meta.nextSibling);
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 开关写入
  function setAutoLogin(profileId, on, accountId) {
    try {
      var p = profileOf(profileId);
      if (!p) return Promise.resolve(null);
      var patch = { id: profileId, autoLogin: !!on };
      if (typeof accountId !== 'undefined') {
        patch.autoLoginAccountId = accountId || null;
      } else if (on && !p.autoLoginAccountId) {
        // 只有一条凭据时不必让用户再选一次。
        var creds = profileCredentials(profileId);
        patch.autoLoginAccountId = (creds.length === 1 && creds[0].id) ? creds[0].id : null;
      }
      if (!on) forgetAttempts(profileId);   // 关掉时把尝试状态清干净，下次开启从头来
      if (typeof upsertProfile !== 'function') return Promise.resolve(null);
      return upsertProfile(patch);
    } catch (e) { return Promise.resolve(null); }
  }

  // 「快速进入」的开关没有独立的界面入口（本轮没有对应的 i18n 键），留给命令面板 /
  // DevTools 用；quickEnter === false 时 quickUrlFor 返回 null，四个新窗口钩子退回原行为。
  function setQuickEnter(profileId, on) {
    try {
      if (!profileOf(profileId) || typeof upsertProfile !== 'function') return Promise.resolve(null);
      return upsertProfile({ id: profileId, quickEnter: !!on });
    } catch (e) { return Promise.resolve(null); }
  }

  function forgetAttempts(profileId) {
    try {
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        if (!t || (profileId && t.profileId !== profileId)) continue;
        if (t._xzAutoLogin) resetState(t._xzAutoLogin, '');
      }
    } catch (e) {}
  }

  function isEnabled(profileId) {
    var p = profileOf(profileId);
    return !!(p && p.autoLogin === true);
  }

  // ------------------------------------------------------------------ 标签页接线
  function wire(tab) {
    try {
      if (!tab || !tab.webview || tab._xzAutoLoginWired) return;
      tab._xzAutoLoginWired = true;
      var wv = tab.webview;

      // 与 renderer 自己的 ipc-message 监听器并存：webview 允许多个监听器，renderer 的
      // 那个先注册也先跑，所以 pw:request 分支（含 R5 的 onLoginForm 调用）不受影响。
      wv.addEventListener('ipc-message', function (ev) {
        try {
          if (!ev) return;
          if (ev.channel === 'pw:request') {
            // 收到过 = preload 摸得到这个页面的登录表单，不是跨域框架的情况。
            stateFor(tab).sawRequest = true;
          } else if (ev.channel === 'pw:auto-submitted') {
            onAutoSubmitted(tab, (ev.args && ev.args[0]) || {});
          }
        } catch (e) {}
      });

      wv.addEventListener('did-navigate', function (ev) {
        try {
          var url = (ev && ev.url) || tab.url;
          var host = urlHost(url);
          var st = stateFor(tab);
          // 换了 host 就是新的一段旅程：解除锁定、重新计数（登录成功后跳走也走这一条）。
          if (st.host && !hostsMatch(st.host, host)) resetState(st, '');
          st.sawRequest = false;
          rememberGameUrl(tab, url);
          scheduleCrossOriginNotice(tab, url);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function unwire(tab) {
    try {
      if (!tab) return;
      if (crossTimers[tab.id]) { clearTimeout(crossTimers[tab.id]); delete crossTimers[tab.id]; }
      for (var key in crossNotified) {
        if (Object.prototype.hasOwnProperty.call(crossNotified, key) &&
            key.indexOf(tab.id + '|') === 0) delete crossNotified[key];
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 事件总线
  document.addEventListener('xz:tab-created', function (e) { wire(e && e.detail); });
  document.addEventListener('xz:tab-closed', function (e) { unwire(e && e.detail); });
  document.addEventListener('xz:boot', function () {
    // 正常情况下 boot 时还没有 tab；万一有（顺序变了），补挂一次。
    try { for (var i = 0; i < tabs.length; i++) wire(tabs[i]); } catch (err) {}
  });
  document.addEventListener('xz:profiles', function () {
    // 别的窗口把某个档案的自动登录关掉了：本窗口对应标签页的尝试状态一并清掉。
    try {
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        if (t && t._xzAutoLogin && !isEnabled(t.profileId)) resetState(t._xzAutoLogin, '');
      }
    } catch (err) {}
  });

  // ------------------------------------------------------------ 公共接口（§4）
  window.XZAutoLogin = {
    onLoginForm: onLoginForm,           // R5：renderer 的 pw:request 分支之后
    quickUrlFor: quickUrlFor,           // R15 / R17 / R19 / R20：新窗口的地址来源
    jump: jump,                         // 档案卡「快速进入」/ 命令面板
    decorateProfileCard: decorateProfileCard,  // R18：档案卡上的那一行
    setAutoLogin: setAutoLogin,         // 返回 upsertProfile 的 Promise

    // 契约之外的小工具（命令面板 / DevTools 排错用）
    setQuickEnter: setQuickEnter,
    isEnabled: isEnabled,
    _state: function (tab) { return tab ? tab._xzAutoLogin || null : null; }
  };
})();

// ============================================================================
// 本文件通过 tOr(key, 中文兜底) 引用的 i18n 键（WP6 按方案 §5 落到 en / zh-CN）：
//
//   autologin.label          自动登录 / Auto sign-in                档案卡开关标题
//   autologin.on             开 / On                                开关旁的状态字
//   autologin.off            关 / Off                               同上
//   autologin.tip            这个档案遇到登录框时，自动填入已保存的密码并提交。只对页面里的
//                            登录框有效，游戏内部的选服和进房无法自动化。
//                            （开关 title + 打开时的 toast）
//   autologin.pick_account   自动登录用的账号 / Account for auto sign-in   多凭据时的 <select>
//   autologin.no_password    这个档案还没有保存密码。先登录一次并选择保存。   无凭据时的说明
//   autologin.submitted_toast 已为 {name} 自动登录                    提交成功回执
//   autologin.failed_toast   未能为 {name} 提交登录表单                提交失败回执（之后不再自动重试）
//   autologin.cross_origin   这个页面的登录框在另一个站点的框架里，浏览器无法自动填写。
//                            （每标签页每 host 只提示一次）
//   autologin.quick_enter    快速进入 / Quick enter                   档案卡按钮
//   autologin.quick_enter_tip 打开这个档案上次所在的游戏地址            按钮 title
//   autologin.last_url       上次游戏地址 / Last game address          档案卡上的地址行
//   autologin.no_last_url    还没有记住游戏地址                        无地址时的 title / toast
//
// 依赖的宿主符号（全部是 renderer.js 的顶层声明，缺任何一个都只会走 try/catch 的空操作）：
//   tabs / profiles / passwords / activateTab / createTab / setRoute / tabProfile /
//   profileForUrl / findAllCredentials / hostMatches / normalizeGameUrl / upsertProfile /
//   showToast / tOr
//
// 依赖的 IPC 通道（都是既有管线，本文件不新增任何通道）：
//   宿主 → guest：pw:fill（既有）、pw:submit-now（webview-preload.js 的 W1，集成包落地）
//   guest → 宿主：pw:request（既有）、pw:auto-submitted（W1 的回执）
//
// 持久化字段（挂在 profile 上，走既有的 profiles:upsert 合并 + 广播）：
//   autoLogin: boolean          默认 undefined（视为 false），只有用户在档案卡上打开才为 true
//   autoLoginAccountId: string|null  同 host 多条凭据时用哪一条
//   lastGameUrl: string         上次所在的游戏页地址（导航后 2s 去抖写入）
//   lastGameAt: number          上次写入时间
//   quickEnter: boolean         默认 undefined（视为 true）；false 时 quickUrlFor 返回 null
// 密码本身**没有**任何新的存储位置：只从 passwords 表读，经既有通道原样交给 guest。
// ============================================================================
