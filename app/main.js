const { app, BrowserWindow, globalShortcut, session, ipcMain, Menu, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const configuration = require('./config.json');

// Minimal crash log so silent failures are diagnosable.
const CRASH_LOG = require('os').homedir() + '/ddt-crash.log';
function dlog(msg) {
  try { fs.appendFileSync(CRASH_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
}
process.on('uncaughtException', (err) => dlog('UNCAUGHT: ' + (err && err.stack || err)));
process.on('unhandledRejection', (err) => dlog('UNHANDLED: ' + (err && err.stack || err)));

const homeUrl = configuration.appUrl || 'https://www.4399.com/';
const resizable = configuration.resizable !== false;
const DEFAULT_SPEED_PROFILE_CODE = 5; // 6th UI mode: DDT recommended (Tick + mach)
const speedDisabled = process.argv.includes('--xz-no-speed-mode') || process.env.XZFLASH_DISABLE_SPEED_HOOK === '1';
const speedRequested = process.argv.includes('--xz-speed-mode') || process.env.XZFLASH_ENABLE_SPEED_HOOK === '1';
const speedMode = process.platform === 'darwin' ? !speedDisabled : speedRequested;
let speedHookEnabled = false;
const initialLaunchUrl = firstLaunchUrlArg();

const windows = new Set();
const pendingInit = new WeakMap();
const profileStatsCache = new Map();
const PROFILE_STATS_TTL = 30000;

// Keep Flash games responsive, especially when multi-opening accounts.
const disabledFeatures = [
  'CalculateNativeWinOcclusion',
  'BackForwardCache',
  'IsolateOrigins',
  'site-per-process',
  'AudioServiceOutOfProcess',
  'MediaRouter',
  'OptimizationHints',
  'Translate',
];
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('renderer-process-limit', '6');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-component-extensions-with-background-pages');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-translate');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('disable-hang-monitor');
app.commandLine.appendSwitch('disable-smooth-scrolling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disk-cache-size', String(256 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(128 * 1024 * 1024));

// --- Flash speed control ---
// Official macOS builds use the safe speed shim by default. Launch with
// --xz-no-speed-mode or XZFLASH_DISABLE_SPEED_HOOK=1 to force original Flash.
const LEGACY_SPEED_FILE = path.join(os.homedir(), '.xzflash-speed');
const SPEED_FILE = path.join(os.tmpdir(), 'xzflash-speed-' + (process.getuid ? process.getuid() : 'user'));
const SPEED_DIAG_FILE = path.join(os.tmpdir(), 'xzflash-speed-diag-' + (process.getuid ? process.getuid() : 'user') + '.json');
const SPEED_NOTIFY_NAME = 'com.xiaozhu.flash.speed.' + (process.getuid ? process.getuid() : 'user');
process.env.XZFLASH_SPEED_FILE = SPEED_FILE;
process.env.XZFLASH_SPEED_DIAG_FILE = SPEED_DIAG_FILE;
process.env.XZFLASH_SPEED_NOTIFY_NAME = SPEED_NOTIFY_NAME;
function clampSpeedFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.5, Math.min(10, n));
}
function clampSpeedProfile(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SPEED_PROFILE_CODE;
  return Math.max(0, Math.min(8, Math.round(n)));
}
function writeSpeedState(value, profile = DEFAULT_SPEED_PROFILE_CODE) {
  const factor = clampSpeedFactor(value);
  const mode = clampSpeedProfile(profile);
  try {
    fs.writeFileSync(SPEED_FILE, factor + ' ' + mode, 'utf8');
    return { factor, mode };
  } catch (e) {
    dlog('speed state write failed: ' + (e && e.stack || e));
    return { factor: 1, mode: 0 };
  }
}
function readSpeedFactor() {
  try { return clampSpeedFactor(String(fs.readFileSync(SPEED_FILE, 'utf8')).trim().split(/\s+/)[0]); }
  catch (e) {
    try { return clampSpeedFactor(String(fs.readFileSync(LEGACY_SPEED_FILE, 'utf8')).trim().split(/\s+/)[0]); }
    catch (_e) { return 1; }
  }
}
function readSpeedState() {
  try {
    const parts = String(fs.readFileSync(SPEED_FILE, 'utf8')).trim().split(/\s+/);
    return {
      factor: clampSpeedFactor(parts[0]),
      profile: clampSpeedProfile(parts[1]),
      raw: parts.join(' '),
    };
  } catch (e) {
    return { factor: 1, profile: DEFAULT_SPEED_PROFILE_CODE, raw: '' };
  }
}
function publishSpeedFactor(value, profile = DEFAULT_SPEED_PROFILE_CODE) {
  if (!speedMode) return;
  const speed = Math.round(clampSpeedFactor(value) * 1000);
  const mode = clampSpeedProfile(profile);
  const state = String((mode + 1) * 1000000 + speed);
  execFile('/usr/bin/notifyutil', ['-s', SPEED_NOTIFY_NAME, state, '-p', SPEED_NOTIFY_NAME], () => {});
}
function firstLaunchUrlArg() {
  for (const arg of process.argv.slice(1)) {
    if (/^(https?|file):\/\//i.test(arg)) return arg;
  }
  return null;
}
// Always start at 1x so a previous accelerated session cannot affect login.
writeSpeedState(1, DEFAULT_SPEED_PROFILE_CODE);
process.env.XZFLASH_SPEED_FACTOR = String(readSpeedFactor());
process.env.XZFLASH_SPEED_PROFILE = String(DEFAULT_SPEED_PROFILE_CODE);
publishSpeedFactor(1, DEFAULT_SPEED_PROFILE_CODE);

// --- Flash plugin ---
let pluginName, pluginVersion;
switch (process.platform) {
  case 'win32':
    pluginName = 'pepflashplayer64_24_0_0_186.dll';
    pluginVersion = '24.0.0.186';
    break;
  case 'darwin':
    pluginName = 'PepperFlashPlayer.plugin';
    pluginVersion = '21.0.0.204';
    break;
}
let pluginPath = path.join(__dirname, 'plugins', pluginName);
if (process.platform === 'darwin' && speedMode) {
  const shimPlugin = path.join(__dirname, 'plugins', 'PepperFlashPlayerSpeed.plugin');
  if (fs.existsSync(shimPlugin)) {
    pluginPath = shimPlugin;
    speedHookEnabled = true;
  } else {
    dlog('speed shim missing, falling back to original Flash: ' + shimPlugin);
  }
}
app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
app.commandLine.appendSwitch('ppapi-flash-version', pluginVersion);

// --- JSON persistence ---
const STORE_NAMES = ['history', 'bookmarks', 'settings', 'profiles', 'passwords', 'pw_skipped_sites', 'notes', 'tasks'];
function storePath(name) { return path.join(app.getPath('userData'), name + '.json'); }
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(storePath(name), 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(name, data) {
  try {
    fs.mkdirSync(path.dirname(storePath(name)), { recursive: true });
    const spacing = name === 'history' ? 0 : 2;
    fs.writeFileSync(storePath(name), JSON.stringify(data, null, spacing));
  } catch (e) { console.error('writeJson failed', name, e); }
}

// Defaults
function seedDefaults() {
  if (!fs.existsSync(storePath('settings'))) {
    writeJson('settings', {
      language: 'zh-CN',
      defaultProfileId: 'lucky-orange',
      restoreSession: true,
      sidebarCollapsed: false,
      speedProfile: 'native-ddt',
      speedProfileVersion: 5,
      globalMuted: false,
      showQuickNote: true,
    });
  }
  if (!fs.existsSync(storePath('profiles'))) {
    writeJson('profiles', [
      { id: 'lucky-orange',       name: '好运小橙子', color: '#FF9F1C', persistent: true,  createdAt: Date.now() },
      { id: 'fortune-orange',     name: '发财小橙子', color: '#E66E1A', persistent: true,  createdAt: Date.now() },
      { id: 'super-lucky-orange', name: '超好运橙子', color: '#5FA64A', persistent: true,  createdAt: Date.now() },
    ]);
  }
}

ipcMain.handle('store:get', (_e, name) => {
  if (!STORE_NAMES.includes(name)) return null;
  const defaults = { history: [], bookmarks: [], pw_skipped_sites: [], passwords: [], profiles: [], settings: {}, notes: [], tasks: [] };
  return readJson(name, defaults[name]);
});
ipcMain.handle('store:set', (_e, name, data) => {
  if (!STORE_NAMES.includes(name)) return false;
  writeJson(name, data);
  return true;
});
ipcMain.handle('app:home-url', () => homeUrl);
ipcMain.handle('app:init', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const data = pendingInit.get(win) || {};
  pendingInit.delete(win);
  return data;
});
ipcMain.handle('window:open', (_e, url, profileId) => {
  createBrowserWindowWithUrl(url, profileId);
  return true;
});
ipcMain.handle('window:open-many', (_e, url, profileIds) => {
  const ids = Array.isArray(profileIds) ? profileIds : [];
  const profiles = readJson('profiles', []);
  const allowed = new Set(profiles.map(p => p.id));
  const uniqueIds = [];
  for (const id of ids) {
    if (allowed.has(id) && !uniqueIds.includes(id)) uniqueIds.push(id);
  }
  const targetUrl = url || homeUrl;
  uniqueIds.forEach((id, index) => {
    const open = () => createBrowserWindowWithUrl(targetUrl, id);
    if (index === 0) open();
    else setTimeout(open, Math.min(6000, index * 650));
  });
  return { queued: uniqueIds.length };
});
ipcMain.handle('window:open-accounts-grid', (_e, accounts) => {
  const list = Array.isArray(accounts) ? accounts.filter(a => a && a.profileId) : [];
  const total = list.length;
  list.forEach((account, index) => {
    const open = () => createBrowserWindowWithUrl(account.url || homeUrl, account.profileId, {
      bounds: gridBounds(index, total),
    });
    if (index === 0) open();
    else setTimeout(open, Math.min(8000, index * 700));
  });
  return { queued: total };
});
ipcMain.handle('window:tile-grid', () => {
  const wins = Array.from(windows).filter(w => !w.isDestroyed());
  const total = wins.length;
  wins.forEach((win, index) => {
    try { win.setBounds(gridBounds(index, total), true); } catch (e) {}
  });
  return { tiled: total };
});
ipcMain.handle('audio:set-global-muted', (_e, muted) => {
  const value = !!muted;
  broadcast('audio:global-muted', value);
  return value;
});
ipcMain.handle('screenshot:save', (_e, pngBytes, title) => {
  const rawName = String(title || 'game').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'game';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = '小竹Orange截图-' + rawName.slice(0, 40) + '-' + stamp + '.png';
  const filePath = path.join(app.getPath('desktop'), fileName);
  fs.writeFileSync(filePath, Buffer.from(pngBytes));
  return { path: filePath };
});
ipcMain.handle('speed:get', () => readSpeedFactor());
ipcMain.handle('speed:state', () => readSpeedState());
ipcMain.handle('speed:diag-path', () => SPEED_DIAG_FILE);
ipcMain.handle('speed:hook-enabled', () => speedHookEnabled);
ipcMain.handle('speed:set', (_e, factor, profile) => {
  const next = writeSpeedState(factor, profile);
  process.env.XZFLASH_SPEED_FACTOR = String(next.factor);
  process.env.XZFLASH_SPEED_PROFILE = String(next.mode);
  publishSpeedFactor(next.factor, next.mode);
  broadcast('speed:changed', next.factor);
  return next.factor;
});
ipcMain.handle('speed:relaunch', (_e, enable, currentUrl) => {
  const args = process.argv.slice(1).filter(a =>
    a !== '--xz-speed-mode' &&
    a !== '--xz-no-speed-mode' &&
    !/^(https?|file):\/\//i.test(a)
  );
  if (enable && process.platform !== 'darwin') args.push('--xz-speed-mode');
  if (!enable && process.platform === 'darwin') args.push('--xz-no-speed-mode');
  if (currentUrl && /^(https?|file):\/\//i.test(currentUrl)) args.push(currentUrl);
  app.relaunch({ args });
  app.exit(0);
});

// --- Profiles / session partitions ---
function partitionFor(profile) {
  if (!profile) return null;
  return 'persist:ddt-' + profile.id;
}
ipcMain.handle('profile:partition', (_e, profile) => partitionFor(profile));
ipcMain.handle('profile:stats', async (_e, profile) => {
  const part = partitionFor(profile);
  if (!part) return { cookies: 0 };
  const key = (profile && profile.id) || part;
  const cached = profileStatsCache.get(key);
  if (cached && Date.now() - cached.ts < PROFILE_STATS_TTL) return cached.value;
  try {
    const ses = session.fromPartition(part);
    const cookies = await ses.cookies.get({});
    const value = { cookies: cookies.length };
    profileStatsCache.set(key, { ts: Date.now(), value });
    return value;
  } catch (e) { return { cookies: 0 }; }
});
ipcMain.handle('profile:clear', async (_e, profile) => {
  const part = partitionFor(profile);
  if (!part) return false;
  const ses = session.fromPartition(part);
  await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'] });
  await ses.clearCache();
  if (profile && profile.id) profileStatsCache.delete(profile.id);
  return true;
});

// --- Task reminders (OS notifications) ---
const taskTimers = new Map(); // taskId -> Timeout
function cancelTimer(taskId) {
  const t = taskTimers.get(taskId);
  if (t) { clearTimeout(t); taskTimers.delete(taskId); }
}
function scheduleTask(task) {
  if (!task || !task.id) return;
  cancelTimer(task.id);
  if (task.done || !task.dueAt) return;
  const delay = task.dueAt - Date.now();
  if (delay <= 0) {
    fireReminder(task);
    return;
  }
  // Electron/Node setTimeout caps at ~24.8 days (2^31 ms). Chunk longer waits.
  const CAP = 2000000000;
  const actual = Math.min(delay, CAP);
  const timer = setTimeout(() => {
    if (actual < delay) scheduleTask(task); // reschedule remainder
    else fireReminder(task);
  }, actual);
  taskTimers.set(task.id, timer);
}
function fireReminder(task) {
  try {
    const n = new Notification({
      title: (task.text || 'Task reminder').slice(0, 120),
      body: task.dueAt && task.dueAt < Date.now() - 60000 ? 'Overdue' : 'Due now',
      silent: false,
    });
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); w.webContents.send('action', 'goto-tasks', task.id); }
    });
    n.show();
  } catch (e) {}
  // Let renderer know so it can visually mark the task.
  broadcast('task:fired', task.id);
}
function scheduleAllTasks() {
  const tasks = readJson('tasks', []);
  for (const t of tasks) scheduleTask(t);
}
ipcMain.handle('task:schedule', (_e, task) => { scheduleTask(task); return true; });
ipcMain.handle('task:cancel', (_e, taskId) => { cancelTimer(taskId); return true; });

// --- Clear history/cookies/cache helpers ---
ipcMain.handle('data:clear-cookies-cache-all', async () => {
  profileStatsCache.clear();
  const storages = ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'];
  for (const ses of [session.defaultSession]) {
    await ses.clearStorageData({ storages });
    await ses.clearCache();
  }
  // Also clear each profile's partition
  const profiles = readJson('profiles', []);
  for (const p of profiles) {
    const part = partitionFor(p);
    if (!part) continue;
    try {
      const ses = session.fromPartition(part);
      await ses.clearStorageData({ storages });
      await ses.clearCache();
    } catch (e) {}
  }
  return true;
});

function sendToFocused(...args) {
  const w = BrowserWindow.getFocusedWindow();
  if (w) w.webContents.send(...args);
}
function broadcast(...args) {
  for (const w of windows) w.webContents.send(...args);
}

function gridBounds(index, total) {
  const wa = screen.getPrimaryDisplay().workArea;
  const count = Math.max(1, total || 1);
  const cols = count <= 1 ? 1 : count === 2 ? 2 : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: Math.round(wa.x + col * wa.width / cols),
    y: Math.round(wa.y + row * wa.height / rows),
    width: Math.round(wa.width / cols),
    height: Math.round(wa.height / rows),
  };
}

function createBrowserWindowWithUrl(initialUrl, profileId, options = {}) {
  const wa = screen.getPrimaryDisplay().workArea;
  const bounds = options.bounds || { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    autoHideMenuBar: true,
    resizable,
    fullscreenable: resizable,
    title: '小竹Flash浏览器 Orange Ver',
    backgroundColor: '#F7E8D1',
    webPreferences: {
      plugins: true,
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (initialUrl || profileId) pendingInit.set(win, { initialUrl, profileId });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.on('new-window', (event, url) => {
      event.preventDefault();
      if (url) win.webContents.send('action', 'new-tab', url);
    });
    if (typeof wc.setWindowOpenHandler === 'function') {
      wc.setWindowOpenHandler(({ url }) => {
        if (url) win.webContents.send('action', 'new-tab', url);
        return { action: 'deny' };
      });
    }
  });

  windows.add(win);
  win.on('closed', () => windows.delete(win));
  return win;
}

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (windows.size === 0) createBrowserWindowWithUrl();
});

app.on('ready', function() {
  seedDefaults();
  writeSpeedState(readSpeedFactor(), DEFAULT_SPEED_PROFILE_CODE);
  // Defer reminder scheduling so the window paints first.
  setTimeout(scheduleAllTasks, 200);
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Tab', accelerator: 'F5', click: () => sendToFocused('action', 'reload') },
        { label: 'Hard Reload (clear cache)', accelerator: 'CommandOrControl+Shift+R', click: async () => {
            await session.defaultSession.clearCache();
            sendToFocused('action', 'reload');
        }},
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CommandOrControl+\\', click: () => sendToFocused('action', 'toggle-sidebar') },
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', click: () => sendToFocused('action', 'zoom-in') },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => sendToFocused('action', 'zoom-out') },
        { label: 'Reset Zoom', accelerator: 'CommandOrControl+0', click: () => sendToFocused('action', 'zoom-reset') },
        { label: 'Fit to Window', accelerator: 'CommandOrControl+9', click: () => sendToFocused('action', 'fit-window') },
        { label: 'Game Mode', accelerator: 'CommandOrControl+Shift+G', click: () => sendToFocused('action', 'toggle-game-mode') },
        { type: 'separator' },
        { label: 'Inspect Game Page', accelerator: 'Alt+CommandOrControl+I', click: () => sendToFocused('action', 'inspect-webview') },
        { type: 'separator' },
        { label: 'New Window', accelerator: 'CommandOrControl+N', click: () => sendToFocused('action', 'new-window') },
        { label: 'New Tab', accelerator: 'CommandOrControl+T', click: () => sendToFocused('action', 'new-tab') },
        { label: 'Close Tab', accelerator: 'CommandOrControl+W', click: () => sendToFocused('action', 'close-tab') },
        { label: 'Move Tab to New Window', click: () => sendToFocused('action', 'detach-tab') },
        { label: 'Next Tab', accelerator: 'CommandOrControl+Alt+Right', click: () => sendToFocused('action', 'next-tab') },
        { label: 'Previous Tab', accelerator: 'CommandOrControl+Alt+Left', click: () => sendToFocused('action', 'prev-tab') },
        { type: 'separator' },
        { label: 'History', accelerator: 'CommandOrControl+Y', click: () => sendToFocused('action', 'toggle-history') },
        { label: 'Bookmarks', accelerator: 'CommandOrControl+B', click: () => sendToFocused('action', 'toggle-bookmarks') },
        { label: 'Focus Address Bar', accelerator: 'CommandOrControl+L', click: () => sendToFocused('action', 'focus-url') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  try { createBrowserWindowWithUrl(initialLaunchUrl); }
  catch (e) { dlog('createWin THREW: ' + (e && e.stack || e)); }

  globalShortcut.register('F5', () => sendToFocused('action', 'reload'));
  globalShortcut.register('CommandOrControl+Shift+C', async () => {
    await session.defaultSession.clearCache();
    sendToFocused('action', 'reload');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
