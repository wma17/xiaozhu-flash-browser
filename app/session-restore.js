// ============================================================================
// session-restore.js — 崩溃恢复 / 会话快照（主进程侧）—— WP3
// ----------------------------------------------------------------------------
// 职责：记住「上次退出（或崩溃）时屏幕上是什么样」，下次启动照着摆回来。
// 记的东西：窗口集合、每个窗口的档案与矩形、每个标签页的 URL 与档案、活动标签页、
//          焦点模式是否开着（布局 strip/sector、条带位置、主槽里是哪个账号）。
//
// 【为什么是单独的 session.json，而不是塞进 layouts.json】
//   layouts 的语义是「每个档案一个矩形」（byProfile）+ lastTile —— 按档案聚合；
//   会话是「每个窗口一份」，同一个档案可以同时有两个窗口。混在一起会互相覆盖。
//   但持久化机制完全沿用 main.js 已有的那一套：readJson/writeJson（由 init 注入，
//   写到 userData/session.json，2 空格缩进）、合并写（这里 1000ms）、
//   before-quit / will-quit / relaunch 时 flush、矩形复用 boundsVisibleOnSomeDisplay。
//
// 【防呆第一】
//   本模块在启动路径上运行，出错就等于「浏览器打不开」。所以：
//   - 每个导出函数自身 try/catch；main.js 那边的 try/catch 是第二层保险。
//   - 快照文件的每个字段都当成敌意输入：缺失 / 截断 / 类型不对 / URL 不是 http(s) /
//     档案已被删除 —— 就地丢弃该字段或该条目。最坏退化成「什么也不恢复」，
//     也就是 1.6.0 今天的行为：开一个空白窗口，用户自己开窗。
//
// 【崩溃循环守卫】
//   恢复本身可能正是崩溃的原因（某个页面一开就崩）。所以盘上记 restoreAttempts：
//   开窗之前先 +1 并**同步落盘**；活过 60 秒（markStable）或干净退出就清零。
//   连着两次没活过 60 秒 → 第三次启动不恢复，把窗口列表挪进 lastSkipped，
//   渲染侧提示「上次恢复没有完成…」并给一个「仍然恢复」的动作（session:restore-skipped）。
// ============================================================================
'use strict';

const SESSION_STORE = 'session';      // → userData/session.json
const SNAPSHOT_VERSION = 1;
const WRITE_COALESCE_MS = 1000;       // 一批窗口的元数据只写一次盘
const MAX_RESTORE_ATTEMPTS = 2;       // 连续 2 次未能活过 60s 就不再重放
const STABLE_AFTER_MS = 60000;
const MAX_WINDOWS = 12;               // 上限只为防止坏文件把 openWindowsSequentially 撑爆
const MAX_TABS_PER_WINDOW = 24;
const MAX_URL_LEN = 2000;
const MAX_TITLE_LEN = 80;
const MIN_W = 320, MIN_H = 240;       // 与 main.js 的 MIN_REMEMBERED_W/H 一致

let deps = null;
let ready = false;
let handlersBound = false;

const byWin = new Map();      // winId -> { profileId, bounds, focused, tabs, activeIndex, focus }
let sawState = false;         // 本次运行是否收到过任何窗口状态
let pendingWindows = null;    // 恢复进行中：在所有窗口上报之前，盘上仍然保留原快照
let pendingCount = 0;
let writeTimer = null;
let stableTimer = null;
let quitting = false;
let cleanQuit = false;
let restoreAttempts = 0;
let lastSkipped = null;       // { windows, at, reason }
let skippedNotice = false;    // 本次启动是否因为守卫而跳过了恢复（渲染侧读一次就清）

function log(msg) {
  try { if (deps && typeof deps.dlog === 'function') deps.dlog('session: ' + msg); } catch (e) {}
}

// ---------------------------------------------------------------- 输入净化
// 下面全部函数的契约：任何输入都不许抛，拿不准就返回 null / 空数组。
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);
}
function str(v, max) {
  return v == null ? '' : String(v).slice(0, max);
}
function sanitizeBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const x = Number(b.x), y = Number(b.y), w = Number(b.width), h = Number(b.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < MIN_W || h < MIN_H) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}
// 显示器可能被拔掉、分辨率可能变。矩形不再落在任何一块屏上就交还给 main：
// createBrowserWindowWithUrl 会退回「该档案记住的矩形」或工作区全屏。
function usableBounds(b) {
  const clean = sanitizeBounds(b);
  if (!clean) return null;
  try {
    if (deps && typeof deps.boundsVisibleOnSomeDisplay === 'function') {
      return deps.boundsVisibleOnSomeDisplay(clean) ? clean : null;
    }
  } catch (e) { log('bounds check failed: ' + (e && e.stack || e)); return null; }
  return clean;
}
function sanitizeTabs(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!isHttpUrl(url)) continue;   // about:blank / data: / file: / 垃圾串一律不进快照
    out.push({
      url: url.slice(0, MAX_URL_LEN),
      profileId: raw.profileId ? str(raw.profileId, 64) : null,
      title: str(raw.title, MAX_TITLE_LEN),
    });
    if (out.length >= MAX_TABS_PER_WINDOW) break;
  }
  return out;
}
function sanitizeFocus(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    active: !!f.active,
    layout: f.layout === 'sector' ? 'sector' : 'strip',
    pos: f.pos === 'right' ? 'right' : 'bottom',
    mainProfileId: f.mainProfileId ? str(f.mainProfileId, 64) : null,
  };
}
function clampIndex(n, len) {
  const i = Math.floor(Number(n));
  if (!Number.isFinite(i) || i < 0) return 0;
  return len ? Math.min(i, len - 1) : 0;
}
function sanitizeWindowRecord(w) {
  if (!w || typeof w !== 'object') return null;
  const tabs = sanitizeTabs(w.tabs);
  if (!tabs.length) return null;                   // 没有可恢复的页面就不是一个窗口
  return {
    profileId: w.profileId ? str(w.profileId, 64) : null,
    bounds: sanitizeBounds(w.bounds),
    focused: !!w.focused,
    tabs: tabs,
    activeIndex: clampIndex(w.activeIndex, tabs.length),
    focus: sanitizeFocus(w.focus),
  };
}
function sanitizeWindowList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const w of list) {
    const clean = sanitizeWindowRecord(w);
    if (clean) out.push(clean);
    if (out.length >= MAX_WINDOWS) break;
  }
  return out;
}
// 整份快照的净化。版本号不认识 / 根本不是对象 / 是数组 —— 全部当作「没有快照」。
function normalizeSnapshot(raw) {
  const out = { version: SNAPSHOT_VERSION, savedAt: 0, cleanQuit: false, restoreAttempts: 0, windows: [], lastSkipped: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (Number(raw.version) !== SNAPSHOT_VERSION) return out;
  out.savedAt = Number(raw.savedAt) || 0;
  out.cleanQuit = !!raw.cleanQuit;
  const attempts = Number(raw.restoreAttempts);
  out.restoreAttempts = Number.isFinite(attempts) ? Math.max(0, Math.min(99, Math.floor(attempts))) : 0;
  out.windows = sanitizeWindowList(raw.windows);
  const skipped = raw.lastSkipped;
  if (skipped && typeof skipped === 'object') {
    const wins = sanitizeWindowList(skipped.windows);
    if (wins.length) out.lastSkipped = { windows: wins, at: Number(skipped.at) || 0, reason: str(skipped.reason, 32) || 'loop' };
  }
  return out;
}

// ---------------------------------------------------------------- 采集与落盘
function profileIdOfWindow(winId) {
  try {
    if (!deps || !deps.windowInfo || typeof deps.windowInfo.get !== 'function') return null;
    const info = deps.windowInfo.get(winId);
    return info && info.profileId ? String(info.profileId) : null;
  } catch (e) { return null; }
}
// 最小化 / 全屏时的几何不是用户摆出来的那个（与 main.js captureWindowBounds 同一判断），
// 这种时候返回 null，调用方沿用上一次记住的矩形。
function readBounds(win) {
  try {
    if (!win || win.isDestroyed()) return null;
    if (win.isMinimized && win.isMinimized()) return null;
    if (win.isFullScreen && win.isFullScreen()) return null;
    return sanitizeBounds(win.getBounds());
  } catch (e) { return null; }
}
function isFocusedWindow(win) {
  try { return !!(win && !win.isDestroyed() && win.isFocused()); } catch (e) { return false; }
}

// 恢复期间盘上应该保留的是**原快照**，而不是「才开出来一个窗口」的半成品：
// 恢复到一半被 kill 时，下次启动才能拿到完整的窗口列表继续（并让守卫计数生效）。
function composeWindows() {
  if (pendingWindows && (!sawState || byWin.size < pendingCount)) return pendingWindows;
  const out = [];
  for (const entry of byWin.values()) {
    if (!entry || !Array.isArray(entry.tabs) || !entry.tabs.length) continue;
    out.push({
      profileId: entry.profileId || null,
      bounds: entry.bounds || null,
      focused: !!entry.focused,
      tabs: entry.tabs,
      activeIndex: clampIndex(entry.activeIndex, entry.tabs.length),
      focus: entry.focus || null,
    });
    if (out.length >= MAX_WINDOWS) break;
  }
  return out;
}
function maybeClearPending() {
  if (pendingWindows && sawState && byWin.size >= pendingCount) pendingWindows = null;
}
function scheduleWrite() {
  if (!ready || writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush('debounce'); }, WRITE_COALESCE_MS);
  if (writeTimer.unref) writeTimer.unref();   // 定时器不应该拖住退出
}
function flush(reason) {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!ready) return false;
  // 用户主动的重启（speed:relaunch / render:relaunch 走 app.exit，不发 before-quit）
  // 不是崩溃：计数必须清零，否则 60 秒内连按两次重启就会误触崩溃循环守卫。
  if (reason === 'relaunch') {
    restoreAttempts = 0;
    cleanQuit = true;
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
  }
  try {
    deps.writeJson(SESSION_STORE, {
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      cleanQuit: !!cleanQuit,
      restoreAttempts: restoreAttempts | 0,
      windows: composeWindows(),
      lastSkipped: lastSkipped,
    });
    return true;
  } catch (e) { log('write failed (' + (reason || '') + '): ' + (e && e.stack || e)); return false; }
}

// 渲染侧把 XZSession.windowState() 塞在 window:set-meta 的 meta.session 里搭便车，
// 于是 activate / navigate / title / close / moveTab（renderer 已有的 300ms 节流）
// 全都覆盖到了，不需要新的 IPC 通道。
function onWindowState(win, state) {
  if (!ready || !win) return false;
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
    if (!state || typeof state !== 'object') return false;
    const winId = win.id;
    const prev = byWin.get(winId) || null;
    const tabs = sanitizeTabs(state.tabs);
    byWin.set(winId, {
      profileId: profileIdOfWindow(winId) || (prev && prev.profileId) || null,
      bounds: readBounds(win) || (prev && prev.bounds) || null,
      focused: isFocusedWindow(win),
      tabs: tabs,
      activeIndex: clampIndex(state.activeIndex, tabs.length),
      focus: sanitizeFocus(state.focus),
    });
    sawState = true;
    maybeClearPending();
    scheduleWrite();
    return true;
  } catch (e) { log('onWindowState failed: ' + (e && e.stack || e)); return false; }
}

// 用户关掉一个窗口 = 它不该再回来。但 ⌘Q 也是逐个关窗，那时候必须原样留着，
// 否则退出过程自己就把快照清空了 —— quitting 标志就是为了区分这两件事。
function onWindowClosed(winId) {
  if (!ready) return false;
  try {
    if (quitting) return false;
    if (!byWin.has(winId)) return false;
    byWin.delete(winId);
    if (pendingCount > 0) pendingCount = Math.max(0, pendingCount - 1);
    maybeClearPending();
    scheduleWrite();
    return true;
  } catch (e) { log('onWindowClosed failed: ' + (e && e.stack || e)); return false; }
}

function onBeforeQuit() {
  if (!ready) return false;
  try {
    quitting = true;
    cleanQuit = true;          // 干净退出：下次启动照常恢复，且计数清零
    restoreAttempts = 0;
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    pendingWindows = null;     // 退出时以内存里的真实窗口为准
    return flush('before-quit');
  } catch (e) { log('onBeforeQuit failed: ' + (e && e.stack || e)); return false; }
}

// ---------------------------------------------------------------- 恢复
function armStableTimer() {
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    restoreAttempts = 0;
    pendingWindows = null;     // 活过 60s，之后以真实窗口状态为准
    flush('stable');
  }, STABLE_AFTER_MS);
  if (stableTimer.unref) stableTimer.unref();
}
function firstUrlOf(w) {
  const tab = w.tabs[clampIndex(w.activeIndex, w.tabs.length)] || w.tabs[0];
  return tab ? tab.url : null;
}
function sameUrl(a, b) { return String(a || '') === String(b || ''); }

// 第 4–5 步：把窗口列表变成 openWindowsSequentially 的 items 并开出去。
// options.init.restore 透传给渲染进程（main.js M5 把它并进 app:init 的返回值），
// 渲染侧 session-client.js 的 restoreWindow(w) 据此建标签页。
// 模块缺席时（session-client.js 被改名）init.initialUrl 仍然是活动标签页的地址，
// 于是至少那一个页面会打开 —— 退化，不是失败。
function beginRestore(windowList, extraUrl) {
  const items = [];
  for (const w of windowList) {
    const url = firstUrlOf(w);
    if (!url) continue;
    items.push({
      url: url,
      profileId: w.profileId || null,
      options: { bounds: usableBounds(w.bounds), init: { restore: w } },
    });
  }
  if (!items.length) return 0;
  // 启动参数带来的地址（open-with / 重启时传回来的 URL）不能丢。
  if (extraUrl && isHttpUrl(extraUrl) && !items.some(it => sameUrl(it.url, extraUrl))) {
    items.push({ url: extraUrl, profileId: null });
  }
  pendingWindows = windowList;
  pendingCount = items.length;
  sawState = false;
  restoreAttempts = (restoreAttempts | 0) + 1;
  cleanQuit = false;
  flush('restore-begin');   // 先落盘再开窗：这次要是又崩了，下次启动才看得到计数
  let opened = false;
  try {
    if (typeof deps.openWindowsSequentially === 'function') {
      Promise.resolve(deps.openWindowsSequentially(items))
        .catch(e => log('sequential restore failed: ' + (e && e.stack || e)));
      opened = true;
    }
  } catch (e) { log('openWindowsSequentially threw: ' + (e && e.stack || e)); opened = false; }
  if (!opened) {
    // 兜底：串行开窗器不可用时直接开，顺序和几何一样，只是没有 window:ready 等待。
    for (const it of items) {
      try { deps.createBrowserWindowWithUrl(it.url, it.profileId, it.options || {}); }
      catch (e) { log('fallback open failed: ' + (e && e.stack || e)); }
    }
  }
  armStableTimer();
  return items.length;
}

// main.js M9：在 app.on('ready') 的菜单之后、开第一个窗口之前调用。
// 返回 true = 已经接管开窗，main.js 不要再 createBrowserWindowWithUrl。
function restoreOnLaunch(initialLaunchUrl) {
  if (!ready) return false;
  try {
    let settings = {};
    try { settings = deps.getSettings() || {}; } catch (e) { settings = {}; }
    let raw = null;
    try { raw = deps.readJson(SESSION_STORE, null); } catch (e) { raw = null; }
    const snap = normalizeSnapshot(raw);   // 空文件 / 截断 / 垃圾 → 空快照
    restoreAttempts = snap.restoreAttempts;
    lastSkipped = snap.lastSkipped;
    cleanQuit = false;                     // 本次运行开始，先假定是脏的
    // 现有开关（设置页「启动时恢复上次的窗口」，默认 true），不新增开关。
    if (settings.restoreSession === false) return false;
    if (!snap.windows.length) return false;
    // 崩溃循环守卫：连着两次没活过 60 秒，就别再重放同一份可能有毒的快照。
    if (snap.restoreAttempts >= MAX_RESTORE_ATTEMPTS) {
      lastSkipped = { windows: snap.windows, at: Date.now(), reason: 'loop' };
      restoreAttempts = 0;
      skippedNotice = true;
      pendingWindows = null;
      flush('loop-guard');
      log('restore skipped after ' + snap.restoreAttempts + ' failed attempts');
      return false;
    }
    const n = beginRestore(snap.windows, initialLaunchUrl);
    if (!n) return false;
    log('restoring ' + n + ' window(s), attempt ' + restoreAttempts);
    return true;
  } catch (e) {
    log('restoreOnLaunch failed: ' + (e && e.stack || e));
    return false;   // 出任何意外都退回今天的行为：main.js 自己开一个窗口
  }
}

// ---------------------------------------------------------------- IPC
// 两个 handler 都由本模块自己注册，集成包不需要在 main.js 里加通道。
function bindIpc() {
  if (handlersBound) return;
  let ipcMain = null;
  try { ipcMain = require('electron').ipcMain; } catch (e) { ipcMain = null; }
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;   // 单元测试里没有 electron
  try {
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler('session:launch-info');
      ipcMain.removeHandler('session:restore-skipped');
    }
    // 渲染侧 boot 时问一次：这次启动是不是因为守卫跳过了恢复？
    // 只回答第一个提问的窗口，避免多窗口重复 toast。
    ipcMain.handle('session:launch-info', () => {
      const notice = skippedNotice;
      skippedNotice = false;
      return {
        skippedNotice: !!notice,
        canRestore: !!(lastSkipped && lastSkipped.windows && lastSkipped.windows.length),
        windows: lastSkipped && lastSkipped.windows ? lastSkipped.windows.length : 0,
      };
    });
    // 「仍然恢复」：用户明确要求重放刚才被跳过的那一份。
    // 同样走 beginRestore，所以计数会 +1，再崩两次照样会被守卫拦下。
    ipcMain.handle('session:restore-skipped', () => {
      try {
        if (!lastSkipped || !lastSkipped.windows || !lastSkipped.windows.length) return { queued: 0 };
        const wins = lastSkipped.windows;
        lastSkipped = null;
        const n = beginRestore(wins, null);
        if (!n) flush('restore-skipped-empty');
        return { queued: n };
      } catch (e) { log('restore-skipped failed: ' + (e && e.stack || e)); return { queued: 0 }; }
    });
    handlersBound = true;
  } catch (e) { log('ipc bind failed: ' + (e && e.stack || e)); }
}

// main.js M8：菜单建好之后、开窗之前调用。缺少 readJson/writeJson 就直接抛，
// main.js 的 try/catch 会把 XZSession 置 null，整个功能静默缺席（= 今天的行为）。
function init(d) {
  const src = d || {};
  if (typeof src.readJson !== 'function' || typeof src.writeJson !== 'function') {
    throw new Error('session-restore: readJson/writeJson are required');
  }
  deps = src;
  ready = true;
  bindIpc();
  return true;
}

module.exports = {
  init: init,
  onWindowState: onWindowState,
  onWindowClosed: onWindowClosed,
  onBeforeQuit: onBeforeQuit,
  flush: flush,
  restoreOnLaunch: restoreOnLaunch,
  // 单元测试 / DevTools 排错用，契约之外：
  _normalizeSnapshot: normalizeSnapshot,
  _state: function () {
    return {
      ready: ready, windows: byWin.size, sawState: sawState, pendingCount: pendingCount,
      pending: pendingWindows ? pendingWindows.length : 0, quitting: quitting,
      cleanQuit: cleanQuit, restoreAttempts: restoreAttempts,
      lastSkipped: lastSkipped ? lastSkipped.windows.length : 0, skippedNotice: skippedNotice,
    };
  },
  _reset: function () {
    byWin.clear();
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
    sawState = false; pendingWindows = null; pendingCount = 0;
    quitting = false; cleanQuit = false; restoreAttempts = 0;
    lastSkipped = null; skippedNotice = false; ready = false; deps = null;
  },
};
