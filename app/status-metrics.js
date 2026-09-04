// ============================================================================
// status-metrics.js — 状态条的主进程采样端（第三轮 WP2）
// ----------------------------------------------------------------------------
// 渲染进程（status-bar.js）每 2 秒 invoke 一次 'status:metrics'，本文件回一份
// 进程负载快照。main.js 里只有一行 require（集成包 M1/M8 负责）：
//     try { XZMetrics = require('./status-metrics.js'); } catch (e) { XZMetrics = null; }
//     XZMetrics.init({ app, dlog });
// 文件缺席时 require 抛错，一切照旧 —— 与渲染侧 if (window.XZThing) 同一精神。
//
// 【只用 Electron 11.2.1 真有的 API（已在 Electron Framework 二进制里核实字符串）】
//   app.getAppMetrics()     → ProcessMetric[]，每条含 pid / type /
//                             cpu.percentCPUUsage / cpu.idleWakeupsPerSecond /
//                             memory.workingSetSize / creationTime。
//                             Electron 11 的 ProcessMetric **没有** name /
//                             serviceName（那是 Electron 12+ 才加的），所以进程
//                             归类只能靠 type 字符串，见 kindOf()。
//   webContents.fromId(id)  → 把渲染侧 <webview>.getWebContentsId() 换成 wc
//   wc.getOSProcessId()     → guest 的系统 pid，再和 getAppMetrics 的 pid 对上
//
//   Electron 11 **没有任何真正的 GPU 利用率 API**。所以返回值里的 gpu 是
//   「GPU 进程的 CPU 时间」，不是显卡占用；文案（status.load_tip）必须这么写。
//
// 【绝不碰 guest】
//   本文件只读进程表，外加对每个已就绪的 guest 读一次系统 pid。不截图、不向
//   guest 发消息、不注入脚本、不静音、不节流、不改缩放、不隐藏、不暂停。
//   游戏永远感觉不到本模块存在。
//
// 【成本】
//   getAppMetrics() 遍历约 8–14 个进程，量级 0.2–0.5ms。结果缓存 1500ms，多个
//   窗口的 2 秒轮询共用同一份快照，所以进程表最多每 1.5 秒读一次。
//   本模块不开任何定时器：没有请求时就是零开销。
// ============================================================================
'use strict';

const electron = require('electron');
const ipcMain = electron.ipcMain;
const webContents = electron.webContents;

const CHANNEL = 'status:metrics';
const CACHE_MS = 1500;   // 进程表缓存：多窗口共用一份，别让 N 个窗口各读一次

let appRef = electron.app;
let dlog = () => {};
let registered = false;
let cache = null;        // { at: number, list: ProcessMetric[] }

// ---------------------------------------------------------------- 进程归类
// Chromium 的 GetProcessTypeNameInEnglish() 给出的字符串：
//   'Browser' | 'Tab'(渲染进程) | 'GPU' | 'Utility' | 'Zygote' |
//   'Pepper Plugin'(= Flash 本体) | 'Pepper Plugin Broker' | 'Unknown'
// 二进制里 'Pepper Plugin' 只作为 'Pepper Plugin Broker' 的前缀出现过一次
// （编译器可能把前缀合并了，也可能这一路真的换了写法），无法只靠静态字符串
// 断定。所以这里不做等值比较，而是宽松匹配：凡是 pepper/ppapi/plug-in/plugin
// 且不是 broker 的，都算 Flash 进程。匹配不到时 plugin 返回 null，界面显示
// 「—」而不是骗人的 0。
function kindOf(type) {
  const s = String(type == null ? '' : type);
  if (s === 'Browser') return 'browser';
  if (s === 'GPU') return 'gpu';
  if (s === 'Tab' || s === 'Renderer') return 'tab';
  if (/broker/i.test(s)) return 'other';
  if (/pepper|ppapi|plug-?in/i.test(s)) return 'plugin';
  return 'other';
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}
function r1(n) {
  return Math.round(num(n) * 10) / 10;
}

// getAppMetrics() 本身可能抛（进程正在退出时），永远给个数组回去。
function metricsNow() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS && now >= cache.at) return cache.list;
  let list = [];
  try {
    const a = appRef || electron.app;
    list = (a && typeof a.getAppMetrics === 'function') ? (a.getAppMetrics() || []) : [];
  } catch (e) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  cache = { at: now, list };
  return list;
}

// tabList = [{ id, wcId }]，由渲染侧从 <webview>.getWebContentsId() 得到；
// 未 dom-ready 的 tab 渲染侧已经跳过了，这里再防一层。
function collect(tabList) {
  const list = metricsNow();
  const out = {
    at: Date.now(),
    procs: list.length,
    total: 0,
    browser: null,
    gpu: null,
    plugin: null,   // null = 没找到 Flash 进程（界面显示「—」）
    tab: null,
    perTab: {},
  };

  const byPid = Object.create(null);
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m) continue;
    const cpu = num(m.cpu && m.cpu.percentCPUUsage);
    out.total += cpu;
    const k = kindOf(m.type);
    if (k === 'browser') out.browser = num(out.browser) + cpu;
    else if (k === 'gpu') out.gpu = num(out.gpu) + cpu;
    else if (k === 'plugin') out.plugin = num(out.plugin) + cpu;
    else if (k === 'tab') out.tab = num(out.tab) + cpu;
    if (m.pid != null) byPid[m.pid] = m;
  }
  out.total = r1(out.total);
  if (out.browser !== null) out.browser = r1(out.browser);
  if (out.gpu !== null) out.gpu = r1(out.gpu);
  if (out.plugin !== null) out.plugin = r1(out.plugin);
  if (out.tab !== null) out.tab = r1(out.tab);

  if (!Array.isArray(tabList) || !tabList.length) return out;

  // 同一档案的多个 tab 可能共用一个渲染进程（同 partition + 同站点），那样它们
  // 会报同一个 pid 的 CPU。shared 把这件事如实说出来，渲染侧的 title 用得上。
  const seen = Object.create(null);
  const rows = [];
  for (let i = 0; i < tabList.length; i++) {
    const t = tabList[i];
    if (!t || t.id == null) continue;
    const wcId = Number(t.wcId);
    if (!isFinite(wcId) || wcId <= 0) continue;
    let wc = null;
    try { wc = webContents.fromId(wcId); } catch (e) { wc = null; }
    if (!wc) continue;
    try { if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) continue; } catch (e) { continue; }
    let pid = 0;
    try { pid = Number(wc.getOSProcessId()) || 0; } catch (e) { pid = 0; }
    if (!pid) continue;
    const m = byPid[pid];
    if (!m) continue;
    seen[pid] = (seen[pid] || 0) + 1;
    rows.push({ id: t.id, pid: pid, m: m });
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    out.perTab[row.id] = {
      pid: row.pid,
      cpu: r1(row.m.cpu && row.m.cpu.percentCPUUsage),
      mem: num(row.m.memory && row.m.memory.workingSetSize),
      shared: seen[row.pid] || 1,
    };
  }
  return out;
}

// ------------------------------------------------------------------- 对外
// init 允许重复调用（主进程只会调一次，但重复调也不该炸）。
function init(deps) {
  if (deps && deps.app) appRef = deps.app;
  if (deps && typeof deps.dlog === 'function') dlog = deps.dlog;
  if (registered) return module.exports;
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    dlog('status-metrics: ipcMain.handle unavailable');
    return module.exports;
  }
  // 同一通道被注册两次会抛；先尽量摘掉旧的（removeHandler 在 Electron 9+ 存在）。
  try { if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(CHANNEL); } catch (e) {}
  try {
    ipcMain.handle(CHANNEL, (_e, tabList) => {
      try {
        return collect(tabList);
      } catch (err) {
        dlog('status-metrics collect failed: ' + (err && err.stack || err));
        return null;   // 渲染侧把 null 显示成「—」，不会抛
      }
    });
    registered = true;
  } catch (e) {
    dlog('status-metrics handle failed: ' + (e && e.stack || e));
  }
  return module.exports;
}

module.exports = {
  init: init,
  // 调试用：主进程 console / dlog 里直接看一眼当前进程表的归类结果。
  sample: (tabList) => {
    try { return collect(tabList); } catch (e) { return null; }
  },
  channel: CHANNEL,
};

// ----------------------------------------------------------------------------
// IPC 契约（集成包与 status-bar.js 共用）：
//   ipcRenderer.invoke('status:metrics', [{ id, wcId }, …])
//     → { at, procs, total, browser, gpu, plugin, tab,
//         perTab: { <tabId>: { pid, cpu, mem, shared } } }
//     total/browser/gpu/plugin/tab 的单位是「一个 CPU 核 = 100%」的百分比，
//     plugin 为 null 表示当前没有认出 Flash 进程（界面显示「—」）。
//     整个返回值可能是 null（采样抛错），渲染侧必须容忍。
// ============================================================================
