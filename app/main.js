const { app, BrowserWindow, session, ipcMain, Menu, screen, Notification, shell, powerMonitor } = require('electron');
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
// 可选主进程模块：文件缺席时 require 抛错，一切照旧（与渲染侧 if (window.XZThing) 同一精神）。
let XZSession = null, XZMetrics = null;
try { XZSession = require('./session-restore.js'); } catch (e) { XZSession = null; }
try { XZMetrics = require('./status-metrics.js'); } catch (e) { XZMetrics = null; }
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

// --- Render quality (opt-in only) ---
// The default rendering is deliberately left alone: it is sharp, and blurring it
// would make in-game text unreadable. Only an explicit opt-in drops to a 1x
// device scale factor.
//
// IMPORTANT: this flag comes from argv, never from a settings file. Reading a
// store here would call app.getPath('userData') before the ready event, which
// resolves a DIFFERENT userData directory than the one used after ready — the
// app then reads and writes an empty folder and every profile, bookmark and
// note appears to have vanished. Nothing below this line may touch storePath()
// at module scope. The renderer toggles the setting and relaunches with the
// flag via render:relaunch.
const LOW_RES_GAME_RENDER = process.argv.includes('--xz-low-res');
if (LOW_RES_GAME_RENDER) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

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
// Wire format shared with the C shim: (mode + 1) * 1000000 + round(factor * 1000).
function speedStateCode(value, profile) {
  const speed = Math.round(clampSpeedFactor(value) * 1000);
  const mode = clampSpeedProfile(profile);
  return String((mode + 1) * 1000000 + speed);
}
// notifyutil may be missing or refuse to run; never let that reach the user.
function notifyPublish(name, state) {
  try {
    execFile('/usr/bin/notifyutil', ['-s', name, state, '-p', name], () => {});
    return true;
  } catch (e) {
    dlog('notifyutil publish failed for ' + name + ': ' + (e && e.stack || e));
    return false;
  }
}
function publishSpeedFactor(value, profile = DEFAULT_SPEED_PROFILE_CODE) {
  if (!speedMode) return;
  notifyPublish(SPEED_NOTIFY_NAME, speedStateCode(value, profile));
}
// Per-plugin-process channel: "<global name>.<pid>", file "<global file>.<pid>".
// Writing the file first so a plugin that reads on notify always finds a value.
// CAUTION: once a plugin process sees a valid value here it ignores the global
// channel forever, so this is only ever called from an explicit user action.
function publishSpeedForPid(pid, value, profile) {
  if (!speedMode) return false;
  const factor = clampSpeedFactor(value);
  const mode = clampSpeedProfile(profile);
  try {
    fs.writeFileSync(SPEED_FILE + '.' + pid, factor + ' ' + mode, 'utf8');
  } catch (e) {
    dlog('per-pid speed file write failed for ' + pid + ': ' + (e && e.stack || e));
  }
  return notifyPublish(SPEED_NOTIFY_NAME + '.' + pid, speedStateCode(factor, mode));
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
const STORE_NAMES = ['history', 'bookmarks', 'settings', 'profiles', 'passwords', 'pw_skipped_sites', 'notes', 'tasks', 'layouts'/*XZ-AIM-CUT*/, 'aim-assist'/*XZ-AIM-CUT-END*/];
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
  } catch (e) { dlog('writeJson failed ' + name + ': ' + (e && e.stack || e)); }
}

// Settings are read often (every window focus); cache and drop on write.
let settingsCache = null;
function getSettings() {
  if (!settingsCache) settingsCache = readJson('settings', {}) || {};
  return settingsCache;
}
function invalidateSettings() { settingsCache = null; }

// --- Window layouts (remembered geometry per profile + last tile) ---
// Shape: { byProfile: { <profileId>: {x,y,width,height} },
//          lastTile:  { at: <ts>, bounds: { <profileId>: {x,y,width,height} } } }
// NOTHING here runs at module scope: the first read is lazy, so app.getPath()
// is never touched before the ready event (see the render-quality note above).
const LAYOUT_SAVE_DEBOUNCE_MS = 500; // per window, while the user drags/resizes
const LAYOUT_WRITE_COALESCE_MS = 300; // one disk write for a burst of windows
const MIN_REMEMBERED_W = 320;
const MIN_REMEMBERED_H = 240;
let layoutsCache = null;
let layoutsWriteTimer = null;
const layoutSaveTimers = new Map(); // win.id -> Timeout

function isSaneBounds(b) {
  if (!b || typeof b !== 'object') return false;
  const nums = [b.x, b.y, b.width, b.height].map(Number);
  if (!nums.every(n => Number.isFinite(n))) return false;
  return nums[2] >= MIN_REMEMBERED_W && nums[3] >= MIN_REMEMBERED_H;
}
function cleanBounds(b) {
  return {
    x: Math.round(Number(b.x)),
    y: Math.round(Number(b.y)),
    width: Math.round(Number(b.width)),
    height: Math.round(Number(b.height)),
  };
}
function normalizeLayouts(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const byProfile = {};
  const srcBy = (src.byProfile && typeof src.byProfile === 'object') ? src.byProfile : {};
  for (const key of Object.keys(srcBy)) {
    if (isSaneBounds(srcBy[key])) byProfile[key] = cleanBounds(srcBy[key]);
  }
  let lastTile = null;
  const srcTile = src.lastTile;
  if (srcTile && typeof srcTile === 'object' && srcTile.bounds && typeof srcTile.bounds === 'object') {
    const bounds = {};
    for (const key of Object.keys(srcTile.bounds)) {
      if (isSaneBounds(srcTile.bounds[key])) bounds[key] = cleanBounds(srcTile.bounds[key]);
    }
    if (Object.keys(bounds).length) lastTile = { at: Number(srcTile.at) || 0, bounds };
  }
  return { byProfile, lastTile };
}
function getLayouts() {
  if (!layoutsCache) {
    let raw = null;
    try { raw = readJson('layouts', null); } catch (e) { dlog('layouts read failed: ' + (e && e.stack || e)); }
    layoutsCache = normalizeLayouts(raw);
  }
  return layoutsCache;
}
function snapshotLayouts() {
  const l = getLayouts();
  return JSON.parse(JSON.stringify({ byProfile: l.byProfile, lastTile: l.lastTile }));
}
function flushLayouts() {
  if (layoutsWriteTimer) { clearTimeout(layoutsWriteTimer); layoutsWriteTimer = null; }
  if (!layoutsCache) return;
  try { writeJson('layouts', { byProfile: layoutsCache.byProfile, lastTile: layoutsCache.lastTile }); }
  catch (e) { dlog('layouts write failed: ' + (e && e.stack || e)); }
}
function scheduleLayoutsWrite() {
  if (layoutsWriteTimer) return;
  layoutsWriteTimer = setTimeout(() => { layoutsWriteTimer = null; flushLayouts(); }, LAYOUT_WRITE_COALESCE_MS);
  if (layoutsWriteTimer.unref) layoutsWriteTimer.unref();
}
// A remembered rectangle is only reusable if a real display still covers enough
// of it. Monitors get unplugged and resolutions change; a window restored onto a
// display that no longer exists is invisible and unreachable.
const MIN_VISIBLE_FRACTION = 0.4; // at least 40% of the window's own area
const MIN_VISIBLE_W = 200;        // and a grabbable strip, not a sliver
const MIN_VISIBLE_H = 80;
function boundsVisibleOnSomeDisplay(b) {
  if (!isSaneBounds(b)) return false;
  const r = cleanBounds(b);
  const area = r.width * r.height;
  if (area <= 0) return false;
  let displays = [];
  try { displays = screen.getAllDisplays() || []; } catch (e) { return false; }
  for (const d of displays) {
    const wa = (d && (d.workArea || d.bounds)) || null;
    if (!wa) continue;
    const ix = Math.max(0, Math.min(r.x + r.width, wa.x + wa.width) - Math.max(r.x, wa.x));
    const iy = Math.max(0, Math.min(r.y + r.height, wa.y + wa.height) - Math.max(r.y, wa.y));
    if (ix < MIN_VISIBLE_W || iy < MIN_VISIBLE_H) continue;
    if ((ix * iy) / area >= MIN_VISIBLE_FRACTION) return true;
  }
  return false;
}
function rememberedBoundsFor(profileId) {
  const id = String(profileId || '');
  if (!id) return null;
  const saved = getLayouts().byProfile[id];
  if (!saved) return null;
  if (!boundsVisibleOnSomeDisplay(saved)) return null;
  return cleanBounds(saved);
}
function captureWindowBounds(win) {
  try {
    if (!win || win.isDestroyed()) return;
    // Minimized/fullscreen geometry is not what the user arranged.
    if (win.isMinimized() || (win.isFullScreen && win.isFullScreen())) return;
    const info = windowInfo.get(win.id);
    const profileId = info && info.profileId ? String(info.profileId) : '';
    if (!profileId) return;
    const b = win.getBounds();
    if (!isSaneBounds(b)) return;
    getLayouts().byProfile[profileId] = cleanBounds(b);
    scheduleLayoutsWrite();
  } catch (e) { dlog('capture bounds failed: ' + (e && e.stack || e)); }
}
// Debounced per window: a drag fires move/resize dozens of times a second.
function scheduleBoundsCapture(win) {
  if (!win || win.isDestroyed()) return;
  const id = win.id;
  const existing = layoutSaveTimers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    layoutSaveTimers.delete(id);
    captureWindowBounds(win);
  }, LAYOUT_SAVE_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  layoutSaveTimers.set(id, timer);
}
function cancelBoundsCapture(winId) {
  const t = layoutSaveTimers.get(winId);
  if (t) { clearTimeout(t); layoutSaveTimers.delete(winId); }
}

// --- Beijing time helpers (UTC+8, no DST) ---
const BJ_OFFSET = 8 * 60 * 60 * 1000;
function beijingDay(ts)   { return new Date((ts || Date.now()) + BJ_OFFSET).toISOString().slice(0, 10); }
function beijingMonth(ts) { return beijingDay(ts).slice(0, 7); }
function beijingHour(ts)  { return new Date((ts || Date.now()) + BJ_OFFSET).getUTCHours(); }
function beijingWeekday(ts) { return new Date((ts || Date.now()) + BJ_OFFSET).getUTCDay(); }

// --- Profiles: main process is the single source of truth ---
// Every window used to hold its own copy and write the whole array back, so the
// last writer clobbered the others. All mutations now funnel through here and
// land on disk synchronously (single-threaded main process => serialized).
let profilesCache = null;
function sanitizeProfiles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || !p.id) continue;
    const id = String(p.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(Object.assign({}, p, { id }));
  }
  return out;
}
function getProfiles() {
  if (!profilesCache) profilesCache = sanitizeProfiles(readJson('profiles', []));
  return profilesCache;
}
function snapshotProfiles() {
  return getProfiles().map(p => Object.assign({}, p));
}
function commitProfiles(next) {
  profilesCache = sanitizeProfiles(next);
  const snapshot = snapshotProfiles();
  try { writeJson('profiles', snapshot); } catch (e) { dlog('profiles write failed: ' + (e && e.stack || e)); }
  broadcast('profiles:changed', snapshot);
  return snapshot;
}
function profileMetaMap() {
  const map = new Map();
  for (const p of getProfiles()) map.set(p.id, p);
  return map;
}

ipcMain.handle('profiles:list', () => snapshotProfiles());
ipcMain.handle('profiles:upsert', (_e, profile) => {
  if (!profile || !profile.id) return snapshotProfiles();
  const id = String(profile.id);
  const list = getProfiles().slice();
  const index = list.findIndex(p => p.id === id);
  if (index >= 0) list[index] = Object.assign({}, list[index], profile, { id });
  // New profiles go to the top: array order is the user-visible order.
  else list.unshift(Object.assign({ createdAt: Date.now() }, profile, { id }));
  return commitProfiles(list);
});
ipcMain.handle('profiles:reorder', (_e, order) => {
  const ids = Array.isArray(order) ? order.map(String) : [];
  const current = getProfiles();
  const byId = new Map(current.map(p => [p.id, p]));
  const next = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p && !next.includes(p)) next.push(p);
  }
  // Anything the caller forgot keeps its relative position at the end.
  for (const p of current) if (!next.includes(p)) next.push(p);
  return commitProfiles(next);
});
ipcMain.handle('profiles:remove', (_e, profileId) => {
  const id = String(profileId || '');
  if (!id) return snapshotProfiles();
  return commitProfiles(getProfiles().filter(p => p.id !== id));
});
ipcMain.handle('profiles:touch', (_e, profileId) => {
  const id = String(profileId || '');
  const list = getProfiles().slice();
  const index = list.findIndex(p => p.id === id);
  if (index < 0) return snapshotProfiles();
  list[index] = Object.assign({}, list[index], {
    lastOpenedAt: Date.now(),
    openCount: (Number(list[index].openCount) || 0) + 1,
  });
  return commitProfiles(list);
});

// --- Usage sessions (userData/usage/<YYYY-MM>.json, host only, never full URL) ---
const USAGE_HEARTBEAT_MS = 60000;
const usageCache = new Map();      // 'YYYY-MM' -> rows
const activeSessions = new Map();  // sessionId -> { month, row, winId, profileId, host }
let usageSeq = 0;
let usageHeartbeat = null;
let suspendedSessions = [];

function usageDir() { return path.join(app.getPath('userData'), 'usage'); }
function usagePath(month) { return path.join(usageDir(), month + '.json'); }
function readUsageMonth(month) {
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(month), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}
function writeUsageMonth(month) {
  const rows = usageCache.get(month);
  if (!rows) return;
  try {
    fs.mkdirSync(usageDir(), { recursive: true });
    fs.writeFileSync(usagePath(month), JSON.stringify(rows));
  } catch (e) { dlog('usage write failed ' + month + ': ' + (e && e.stack || e)); }
}
function usageRows(month) {
  if (!usageCache.has(month)) usageCache.set(month, readUsageMonth(month));
  return usageCache.get(month);
}
// Keep only the host: game links routinely carry login tickets.
function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
    return u.hostname || '';
  } catch (e) {
    return raw.split(/[/?#]/)[0].slice(0, 120);
  }
}
function beginUsageSession(profileId, host, winId) {
  const now = Date.now();
  const month = beijingMonth(now);
  const row = {
    id: 'u' + now.toString(36) + (++usageSeq).toString(36),
    profileId: String(profileId || ''),
    host: hostOf(host),
    startedAt: now,
    lastSeenAt: now,
    endedAt: null,
  };
  try {
    usageRows(month).push(row);
    activeSessions.set(row.id, { month, row, winId: winId == null ? null : winId, profileId: row.profileId, host: row.host });
    writeUsageMonth(month);
  } catch (e) { dlog('usage begin failed: ' + (e && e.stack || e)); }
  return row.id;
}
function endUsageSession(sessionId) {
  const entry = activeSessions.get(String(sessionId || ''));
  if (!entry) return false;
  activeSessions.delete(String(sessionId));
  const now = Date.now();
  entry.row.lastSeenAt = Math.max(Number(entry.row.lastSeenAt) || now, now);
  entry.row.endedAt = entry.row.lastSeenAt;
  writeUsageMonth(entry.month);
  return true;
}
function endSessionsForWindow(winId) {
  if (winId == null) return 0;
  let n = 0;
  for (const [id, entry] of Array.from(activeSessions)) {
    if (entry.winId === winId) { endUsageSession(id); n++; }
  }
  return n;
}
function endAllUsageSessions() {
  for (const id of Array.from(activeSessions.keys())) endUsageSession(id);
}
// One shared heartbeat for every open session, not one timer per session.
function usageTick() {
  if (!activeSessions.size) return;
  const now = Date.now();
  const touched = new Set();
  for (const entry of activeSessions.values()) {
    entry.row.lastSeenAt = now;
    touched.add(entry.month);
  }
  for (const month of touched) writeUsageMonth(month);
}
function startUsageHeartbeat() {
  if (usageHeartbeat) return;
  usageHeartbeat = setInterval(usageTick, USAGE_HEARTBEAT_MS);
  if (usageHeartbeat.unref) usageHeartbeat.unref();
}
// Crash recovery: a row left without endedAt would otherwise stretch across days.
function recoverUsageSessions() {
  const now = Date.now();
  const months = [beijingMonth(now), beijingMonth(now - 32 * 24 * 3600000)];
  for (const month of months) {
    let changed = false;
    let rows;
    try { rows = usageRows(month); } catch (e) { continue; }
    for (const row of rows) {
      if (!row || row.endedAt) continue;
      row.endedAt = Number(row.lastSeenAt) || Number(row.startedAt) || now;
      changed = true;
    }
    if (changed) writeUsageMonth(month);
  }
}

ipcMain.handle('usage:begin', (e, payload) => {
  const data = payload || {};
  let winId = null;
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) winId = win.id;
  } catch (err) {}
  return beginUsageSession(data.profileId, data.host || data.url, winId);
});
ipcMain.handle('usage:end', (_e, sessionId) => { endUsageSession(sessionId); return true; });
ipcMain.handle('usage:report', (_e, payload) => {
  const data = payload || {};
  return usageReport(data.scope, data.key);
});

// --- Usage report ---
function reportBounds(scope, key) {
  const raw = String(key || '');
  if (scope === 'year') {
    const y = /^\d{4}$/.test(raw) ? Number(raw) : Number(beijingDay().slice(0, 4));
    return { key: String(y), from: Date.UTC(y, 0, 1) - BJ_OFFSET, to: Date.UTC(y + 1, 0, 1) - BJ_OFFSET };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(raw) || /^(\d{4})-(\d{2})$/.exec(beijingMonth());
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { key: m[1] + '-' + m[2], from: Date.UTC(y, mo, 1) - BJ_OFFSET, to: Date.UTC(y, mo + 1, 1) - BJ_OFFSET };
}
// A session lives in the shard of the month it started in, so look one month back too.
function shardKeysFor(bounds) {
  const keys = [];
  let cursor = bounds.from - 32 * 24 * 3600000;
  let guard = 0;
  while (cursor < bounds.to && guard++ < 500) {
    const m = beijingMonth(cursor);
    if (keys.indexOf(m) < 0) keys.push(m);
    cursor += 24 * 3600000;
  }
  const last = beijingMonth(bounds.to - 1);
  if (keys.indexOf(last) < 0) keys.push(last);
  return keys;
}
function usageMonthsOnDisk() {
  const out = new Set();
  try {
    for (const file of fs.readdirSync(usageDir())) {
      const m = /^(\d{4}-\d{2})\.json$/.exec(file);
      if (m) out.add(m[1]);
    }
  } catch (e) {}
  for (const m of usageCache.keys()) out.add(m);
  return Array.from(out).sort();
}
// Spread a span across Beijing hour buckets; a session can cross hours and days.
function accumulateSpan(from, to, byHour, byWeekday, days) {
  let cursor = from;
  let guard = 0;
  while (cursor < to && guard++ < 200000) {
    const shifted = cursor + BJ_OFFSET;
    const nextBoundary = (Math.floor(shifted / 3600000) + 1) * 3600000 - BJ_OFFSET;
    const stop = Math.min(to, nextBoundary);
    const slice = stop - cursor;
    if (slice <= 0) break;
    byHour[beijingHour(cursor)] += slice;
    byWeekday[beijingWeekday(cursor)] += slice;
    if (days) days.add(beijingDay(cursor));
    cursor = stop;
  }
}
function longestStreakOf(days) {
  const sorted = Array.from(days).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of sorted) {
    const ts = Date.parse(day + 'T00:00:00Z');
    if (prev !== null && ts - prev === 24 * 3600000) run += 1;
    else run = 1;
    prev = ts;
    if (run > best) best = run;
  }
  return best;
}
function usageReport(scope, key) {
  const sc = scope === 'year' ? 'year' : 'month';
  const bounds = reportBounds(sc, key);
  const now = Date.now();
  const spans = [];
  for (const month of shardKeysFor(bounds)) {
    const rows = usageCache.has(month) ? usageCache.get(month) : readUsageMonth(month);
    for (const row of rows) {
      if (!row || !row.startedAt) continue;
      const start = Number(row.startedAt);
      if (!Number.isFinite(start)) continue;
      let end;
      if (row.endedAt) end = Number(row.endedAt);
      else if (activeSessions.has(row.id)) end = now;
      else end = Number(row.lastSeenAt) || start;
      if (!Number.isFinite(end) || end < start) end = start;
      const from = Math.max(start, bounds.from);
      const to = Math.min(end, bounds.to);
      if (!(to > from)) continue;
      spans.push({ profileId: String(row.profileId || ''), from, to });
    }
  }
  spans.sort((a, b) => a.from - b.from);

  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const days = new Set();
  const perProfile = new Map();
  let totalMs = 0;
  let longestSessionMs = 0;
  let firstSeenAt = null;
  let lastSeenAt = null;
  const monthsWithData = new Set();

  for (const span of spans) {
    const ms = span.to - span.from;
    totalMs += ms;
    if (ms > longestSessionMs) longestSessionMs = ms;
    if (firstSeenAt === null || span.from < firstSeenAt) firstSeenAt = span.from;
    if (lastSeenAt === null || span.to > lastSeenAt) lastSeenAt = span.to;
    monthsWithData.add(beijingMonth(span.from));
    accumulateSpan(span.from, span.to, byHour, byWeekday, days);
    const bucket = perProfile.get(span.profileId) || { totalMs: 0, sessions: 0 };
    bucket.totalMs += ms;
    bucket.sessions += 1;
    perProfile.set(span.profileId, bucket);
  }

  const meta = profileMetaMap();
  const byProfile = Array.from(perProfile.entries()).map(([profileId, v]) => {
    const p = meta.get(profileId);
    return {
      profileId,
      name: (p && p.name) || profileId,
      color: (p && p.color) || '#C86B2A',
      totalMs: v.totalMs,
      sessions: v.sessions,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);

  // Which accounts were open at the same time, in groups of any size — not just
  // pairs, since three and four windows at once is normal here. A sweep over every
  // start and end boundary gives, for each stretch of time, the exact set that was
  // online; the time is credited to that set alone. Every instant therefore lands
  // in exactly one row, so a three-way stretch is not also counted under each of
  // its three pairs and the rows can be read as a breakdown rather than overlapping
  // tallies.
  const events = [];
  for (const s2 of spans) {
    events.push([s2.from, 1, s2.profileId]);
    events.push([s2.to, -1, s2.profileId]);
  }
  // Closings before openings at the same instant: two sessions that merely touch
  // are not an overlap.
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const openCount = new Map();
  const comboTotals = new Map();
  let maxConcurrent = 0;
  let prevT = null;
  for (const [t, delta, pid] of events) {
    if (prevT !== null && t > prevT) {
      const active = Array.from(openCount.keys());
      if (active.length > maxConcurrent) maxConcurrent = active.length;
      if (active.length >= 2) {
        const key = active.slice().sort().join('|');
        comboTotals.set(key, (comboTotals.get(key) || 0) + (t - prevT));
      }
    }
    const next = (openCount.get(pid) || 0) + delta;
    if (next > 0) openCount.set(pid, next); else openCount.delete(pid);
    prevT = t;
  }
  const COMBO_FLOOR_MS = 60 * 1000;   // a few seconds of overlap while switching is noise
  const combos = Array.from(comboTotals.entries())
    .filter(([, ms]) => ms >= COMBO_FLOOR_MS)
    .map(([k, overlapMs]) => {
      const ids = k.split('|');
      return {
        ids,
        names: ids.map(id => { const p = meta.get(id); return (p && p.name) || id; }),
        colors: ids.map(id => { const p = meta.get(id); return (p && p.color) || '#C86B2A'; }),
        size: ids.length,
        overlapMs,
      };
    })
    .sort((x, y) => y.overlapMs - x.overlapMs)
    .slice(0, 8);

  // Kept so an older report view still has something to draw.
  const pairTotals = new Map();
  for (const [k, ms] of comboTotals.entries()) {
    const ids = k.split('|');
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key2 = ids[i] + '|' + ids[j];
        pairTotals.set(key2, (pairTotals.get(key2) || 0) + ms);
      }
    }
  }
  const pairs = Array.from(pairTotals.entries()).map(([k, overlapMs]) => {
    const [a, b] = k.split('|');
    const pa = meta.get(a);
    const pb = meta.get(b);
    return {
      a, b,
      nameA: (pa && pa.name) || a,
      nameB: (pb && pb.name) || b,
      colorA: (pa && pa.color) || '#C86B2A',
      colorB: (pb && pb.color) || '#F4A23C',
      overlapMs,
    };
  }).sort((x, y) => y.overlapMs - x.overlapMs).slice(0, 8);

  // Month switcher: every month on disk for month scope, that year's months for year scope.
  const available = usageMonthsOnDisk();
  const months = sc === 'year'
    ? available.filter(m => m.slice(0, 4) === bounds.key)
    : available;
  for (const m of monthsWithData) if (months.indexOf(m) < 0) months.push(m);
  months.sort();

  return {
    scope: sc,
    key: bounds.key,
    totalMs,
    activeDays: days.size,
    longestStreak: longestStreakOf(days),
    longestSessionMs,
    byProfile,
    byHour,
    byWeekday,
    pairs,
    combos,
    maxConcurrent,
    firstSeenAt,
    lastSeenAt,
    months,
  };
}

// --- Window registry / accounts bar ---
const windowInfo = new Map(); // win.id -> { profileId, title, url }
let windowsBroadcastTimer = null;
function windowList() {
  const list = [];
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    const info = windowInfo.get(win.id) || {};
    let title = info.title || '';
    if (!title) { try { title = win.getTitle(); } catch (e) { title = ''; } }
    list.push({
      winId: win.id,
      profileId: info.profileId || null,
      title,
      url: info.url || '',
      minimized: (function () { try { return win.isMinimized(); } catch (e) { return false; } })(),
      focused: (function () { try { return win.isFocused(); } catch (e) { return false; } })(),
    });
  }
  return list;
}
// Coalesce bursts (focus+blur+restore arrive together) into one broadcast.
function broadcastWindows() {
  if (windowsBroadcastTimer) return;
  windowsBroadcastTimer = setTimeout(() => {
    windowsBroadcastTimer = null;
    broadcast('windows:changed', windowList());
  }, 60);
  if (windowsBroadcastTimer.unref) windowsBroadcastTimer.unref();
}
ipcMain.handle('windows:list', () => windowList());
ipcMain.handle('windows:focus', (_e, winId) => {
  const win = findWindowById(winId);
  if (!win) return false;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch (e) { return false; }
  return true;
});
ipcMain.handle('windows:minimize-others', (_e, winId) => {
  const keep = findWindowById(winId);
  let n = 0;
  for (const win of windows) {
    if (!win || win.isDestroyed() || win === keep) continue;
    try { if (!win.isMinimized()) { win.minimize(); n++; } } catch (e) {}
  }
  broadcastWindows();
  return n;
});
// Park = minimize everything except the one window the user is on. Done entirely
// in the main process: the old path went menu -> renderer -> windows:list ->
// windows:minimize-others and depended on the list's `focused` flag being right,
// which it often was not by the time the renderer answered.
function parkOthers(keepWin) {
  let n = 0;
  for (const win of windows) {
    if (!win || win.isDestroyed() || win === keepWin) continue;
    const info = windowInfo.get(win.id);
    const prof = info && info.profileId ? profileMetaMap().get(info.profileId) : null;
    if (prof && prof.playState === 'battle') continue;   // 对战中：永不挂起
    try { if (!win.isMinimized()) { win.minimize(); n++; } } catch (e) {}
  }
  if (n) broadcastWindows();
  return n;
}
function unparkAll() {
  let n = 0;
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    try {
      if (win.isMinimized()) { win.restore(); n++; }
      if (!win.isVisible()) win.show();
    } catch (e) {}
  }
  if (n) broadcastWindows();
  return n;
}
ipcMain.handle('windows:park-others', (e) => {
  let keep = null;
  try { keep = BrowserWindow.fromWebContents(e.sender); } catch (err) {}
  // Never minimize everything: if the sender cannot be resolved, keep the
  // focused window rather than leaving the user staring at an empty desktop.
  if (!keep || keep.isDestroyed()) {
    try { keep = BrowserWindow.getFocusedWindow(); } catch (err) { keep = null; }
  }
  if (!keep || keep.isDestroyed()) return 0;
  return parkOthers(keep);
});
ipcMain.handle('windows:unpark-all', () => unparkAll());
ipcMain.handle('window:set-meta', (e, meta) => {
  const data = meta || {};
  let win = null;
  try { win = BrowserWindow.fromWebContents(e.sender); } catch (err) {}
  if (!win || win.isDestroyed()) return false;
  const info = windowInfo.get(win.id) || {};
  if (typeof data.title === 'string') info.title = data.title.slice(0, 200);
  if (typeof data.url === 'string') info.url = data.url.slice(0, 2000);
  if (data.profileId) info.profileId = String(data.profileId);
  if (XZSession && data.session) { try { XZSession.onWindowState(win, data.session); } catch (err) { dlog('session state failed: ' + (err && err.stack || err)); } }
  windowInfo.set(win.id, info);
  broadcastWindows();
  return true;
});
function findWindowById(winId) {
  const id = Number(winId);
  if (!Number.isFinite(id)) return null;
  for (const win of windows) {
    if (win && !win.isDestroyed() && win.id === id) return win;
  }
  return null;
}

// --- Per-profile speed (TRANSITIONAL) ---
// The speed shim is process-wide: one speed file, one notify channel, so a speed
// set for "one account" really changes every account. Real per-profile isolation
// needs the plugin process to know which profile it belongs to, which is not
// proven yet. Until then we store a speed per profile and re-apply it whenever
// that profile's window takes focus, so whatever account is being played is the
// one whose speed is live. Remove this once the plugin can shard by profile.
function speedFollowsFocus() {
  return getSettings().speedFollowsFocus !== false; // default on
}
function profileSpeedOf(profile) {
  return {
    factor: clampSpeedFactor(profile && profile.speedFactor != null ? profile.speedFactor : 1),
    mode: clampSpeedProfile(profile && profile.speedProfile != null ? profile.speedProfile : DEFAULT_SPEED_PROFILE_CODE),
  };
}
function applySpeedNow(factor, mode) {
  const want = { factor: clampSpeedFactor(factor), mode: clampSpeedProfile(mode) };
  const live = readSpeedState();
  // Skip no-op focus changes: avoids notifyutil chatter and renderer churn.
  if (live.factor === want.factor && live.profile === want.mode) return null;
  const next = writeSpeedState(want.factor, want.mode);
  process.env.XZFLASH_SPEED_FACTOR = String(next.factor);
  process.env.XZFLASH_SPEED_PROFILE = String(next.mode);
  publishSpeedFactor(next.factor, next.mode);
  broadcast('speed:changed', next.factor);
  return next;
}
function applyProfileSpeedOnFocus(profileId) {
  if (!speedFollowsFocus()) return;
  const id = String(profileId || '');
  if (!id) return;
  const profile = profileMetaMap().get(id);
  if (!profile) return;
  const s = profileSpeedOf(profile);
  try { applySpeedNow(s.factor, s.mode); }
  catch (e) { dlog('focus speed apply failed: ' + (e && e.stack || e)); }
}
ipcMain.handle('speed:set-for-profile', (_e, profileId, factor, profile) => {
  const id = String(profileId || '');
  const value = clampSpeedFactor(factor);
  const mode = clampSpeedProfile(profile);
  const list = getProfiles().slice();
  const index = list.findIndex(p => p.id === id);
  if (index < 0) return { factor: value, profile: mode, stored: false, applied: false };
  list[index] = Object.assign({}, list[index], { speedFactor: value, speedProfile: mode });
  commitProfiles(list);
  // An explicit set on the focused account takes effect immediately, whether or
  // not follow-focus is on: the user is acting on the window they are looking at.
  let applied = false;
  try {
    const focused = BrowserWindow.getFocusedWindow();
    const info = focused && !focused.isDestroyed() ? windowInfo.get(focused.id) : null;
    if (info && info.profileId === id) { applySpeedNow(value, mode); applied = true; }
  } catch (e) { dlog('speed:set-for-profile apply failed: ' + (e && e.stack || e)); }
  return { factor: value, profile: mode, stored: true, applied };
});
ipcMain.handle('speed:for-profile', (_e, profileId) => {
  const profile = profileMetaMap().get(String(profileId || ''));
  const s = profileSpeedOf(profile);
  return { factor: s.factor, profile: s.mode, followsFocus: speedFollowsFocus() };
});

// --- Render quality switch (needs a relaunch to take effect) ---
function lowResSettingNow() { return getSettings().lowResGameRender === true; }
ipcMain.handle('render:state', () => ({
  lowResGameRender: lowResSettingNow(),
  active: LOW_RES_GAME_RENDER,
  needsRelaunch: lowResSettingNow() !== LOW_RES_GAME_RENDER,
}));
ipcMain.handle('render:needs-relaunch', () => lowResSettingNow() !== LOW_RES_GAME_RENDER);
ipcMain.handle('render:relaunch', (_e, currentUrl) => {
  // Same shape as speed:relaunch but leaves the speed flags exactly as they are.
  // The low-res choice travels as an argv flag, never as a pre-ready file read.
  const args = process.argv.slice(1).filter(a =>
    a !== '--xz-low-res' && !/^(https?|file):\/\//i.test(a)
  );
  if (lowResSettingNow()) args.push('--xz-low-res');
  if (currentUrl && /^(https?|file):\/\//i.test(currentUrl)) args.push(currentUrl);
  app.relaunch({ args });
  if (XZSession) { try { XZSession.flush('relaunch'); } catch (e) {} }
  app.exit(0);
});

// Defaults
function seedDefaults() {
  if (!fs.existsSync(storePath('settings'))) {
    writeJson('settings', {
      language: 'zh-CN',
      defaultProfileId: 'main',
      restoreSession: true,
      sidebarCollapsed: false,
      speedProfile: 'native-ddt',
      speedProfileVersion: 5,
      globalMuted: false,
      showQuickNote: true,
      speedFollowsFocus: true,
      lowResGameRender: false,
    });
  }
  if (!fs.existsSync(storePath('profiles'))) {
    writeJson('profiles', [
      { id: 'main',      name: 'Main',      color: '#F4A23C', persistent: true,  createdAt: Date.now() },
      { id: 'alt',       name: 'Alt',       color: '#C86B2A', persistent: true,  createdAt: Date.now() },
    ]);
  }
}

ipcMain.handle('store:get', (_e, name) => {
  if (!STORE_NAMES.includes(name)) return null;
  // Profiles always come from the in-memory master copy.
  if (name === 'profiles') return snapshotProfiles();
  // Layouts also have an in-memory master copy (pending debounced writes).
  if (name === 'layouts') return snapshotLayouts();
  const defaults = { history: [], bookmarks: [], pw_skipped_sites: [], passwords: [], settings: {}, notes: [], tasks: [], layouts: { byProfile: {}, lastTile: null } };
  return readJson(name, defaults[name]);
});
ipcMain.handle('store:set', (_e, name, data) => {
  if (!STORE_NAMES.includes(name)) return false;
  // Legacy whole-array writes reuse the same path so there is only one writer.
  if (name === 'profiles') { commitProfiles(data); return true; }
  if (name === 'layouts') { layoutsCache = normalizeLayouts(data); flushLayouts(); return true; }
  writeJson(name, data);
  if (name === 'settings') invalidateSettings();
  return true;
});
ipcMain.handle('app:home-url', () => homeUrl);
ipcMain.handle('external:open', (_e, url) => {
  const target = String(url || '');
  if (!/^(https?|file):\/\//i.test(target)) return false;
  shell.openExternal(target);
  return true;
});
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
  const allowed = new Set(getProfiles().map(p => p.id));
  const uniqueIds = [];
  for (const id of ids) {
    if (allowed.has(id) && !uniqueIds.includes(id)) uniqueIds.push(id);
  }
  const targetUrl = url || homeUrl;
  openWindowsSequentially(uniqueIds.map(id => ({ url: targetUrl, profileId: id })))
    .catch(e => dlog('open-many failed: ' + (e && e.stack || e)));
  return { queued: uniqueIds.length };
});
ipcMain.handle('window:open-accounts-grid', (_e, accounts) => {
  const list = Array.isArray(accounts) ? accounts.filter(a => a && a.profileId) : [];
  const total = list.length;
  openWindowsSequentially(list.map((account, index) => ({
    url: account.url || homeUrl,
    profileId: account.profileId,
    options: { bounds: gridBounds(index, total) },
  }))).catch(e => dlog('open-accounts-grid failed: ' + (e && e.stack || e)));
  return { queued: total };
});
// Same queue as the grid open, minus the tiling: the renderer used to fire one
// window:open per account on a fixed 700ms ladder, which raced the plugin start-up.
ipcMain.handle('window:open-accounts', (_e, accounts) => {
  const list = Array.isArray(accounts) ? accounts.filter(a => a && a.profileId) : [];
  openWindowsSequentially(list.map(account => ({
    url: account.url || homeUrl,
    profileId: account.profileId,
  }))).catch(e => dlog('open-accounts failed: ' + (e && e.stack || e)));
  return { queued: list.length };
});
// Tile every open window, then remember where each one landed so the same
// arrangement can be put back later (including after the user nudges it).
function tileWindows() {
  const wins = Array.from(windows).filter(w => w && !w.isDestroyed());
  const total = wins.length;
  if (!total) return { tiled: 0 };
  const layouts = getLayouts();
  const tileBounds = {};
  wins.forEach((win, index) => {
    const bounds = gridBounds(index, total);
    try {
      if (win.isMinimized()) win.restore();
      if (win.isFullScreen && win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      win.setBounds(bounds, true);
    } catch (e) { dlog('tile setBounds failed: ' + (e && e.stack || e)); }
    try {
      const info = windowInfo.get(win.id);
      const profileId = info && info.profileId ? String(info.profileId) : '';
      if (profileId) {
        tileBounds[profileId] = cleanBounds(bounds);
        layouts.byProfile[profileId] = cleanBounds(bounds);
      }
    } catch (e) {}
  });
  if (Object.keys(tileBounds).length) {
    layouts.lastTile = { at: Date.now(), bounds: tileBounds };
    scheduleLayoutsWrite();
  }
  broadcastWindows();
  return { tiled: total, remembered: Object.keys(tileBounds).length };
}
// Put windows back where the last tile left them, matched by profile id.
// Windows whose profile is not in the record keep whatever geometry they have.
function restoreTileLayout() {
  const layouts = getLayouts();
  const record = layouts.lastTile;
  if (!record || !record.bounds) return { restored: 0, skipped: 0, hasLayout: false };
  let restored = 0;
  let skipped = 0;
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    const info = windowInfo.get(win.id);
    const profileId = info && info.profileId ? String(info.profileId) : '';
    const saved = profileId ? record.bounds[profileId] : null;
    if (!saved || !boundsVisibleOnSomeDisplay(saved)) { skipped++; continue; }
    try {
      if (win.isMinimized()) win.restore();
      if (win.isFullScreen && win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      win.setBounds(cleanBounds(saved), true);
      restored++;
    } catch (e) { skipped++; dlog('restore tile failed: ' + (e && e.stack || e)); }
  }
  if (restored) broadcastWindows();
  return { restored, skipped, hasLayout: true };
}
ipcMain.handle('window:tile-grid', () => tileWindows());
ipcMain.handle('windows:tile', () => tileWindows());
ipcMain.handle('windows:restore-tile', () => restoreTileLayout());
ipcMain.handle('layouts:get', () => snapshotLayouts());
ipcMain.handle('layouts:forget', () => {
  layoutsCache = { byProfile: {}, lastTile: null };
  for (const id of Array.from(layoutSaveTimers.keys())) cancelBoundsCapture(id);
  flushLayouts();
  return snapshotLayouts();
});
ipcMain.handle('audio:set-global-muted', (_e, muted) => {
  const value = !!muted;
  broadcast('audio:global-muted', value);
  return value;
});
ipcMain.handle('screenshot:save', (_e, pngBytes, title) => {
  const rawName = String(title || 'game').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'game';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = '小竹截图-' + rawName.slice(0, 40) + '-' + stamp + '.png';
  const filePath = path.join(app.getPath('desktop'), fileName);
  fs.writeFileSync(filePath, Buffer.from(pngBytes));
  return { path: filePath };
});
// --- Report export (desktop files) ---
// Same naming style as screenshot:save: illegal characters stripped, an ISO
// timestamp appended. Nothing here runs at module scope; app.getPath('desktop')
// is only ever reached from inside a handler, i.e. long after the ready event.
function sanitizeExportName(name, fallback) {
  const raw = String(name == null ? '' : name)
    .replace(/\.(html?|png|pdf)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (raw || fallback).slice(0, 40);
}
function writeToDesktop(baseName, ext, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = '小竹报告-' + baseName + '-' + stamp + ext;
  const filePath = path.join(app.getPath('desktop'), fileName);
  fs.writeFileSync(filePath, data);
  // Highlight it in Finder so the user does not have to go hunting.
  try { shell.showItemInFolder(filePath); } catch (e) { dlog('showItemInFolder failed: ' + (e && e.stack || e)); }
  return filePath;
}
// The renderer builds a fully self-contained HTML string (inline CSS); main
// only writes it. Never throws: the renderer shows ok/error instead.
ipcMain.handle('report:export-html', (_e, html, suggestedName) => {
  try {
    const body = typeof html === 'string' ? html : String(html == null ? '' : html);
    if (!body.trim()) return { ok: false, error: 'empty-html' };
    const filePath = writeToDesktop(sanitizeExportName(suggestedName, '年报'), '.html', Buffer.from(body, 'utf8'));
    return { ok: true, path: filePath };
  } catch (e) {
    dlog('report:export-html failed: ' + (e && e.stack || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});
// Clamp a caller-supplied rect into the window's content box. Returns null for
// "no usable rect", which means capture the whole window.
function clampCaptureRect(win, rect) {
  if (!rect || typeof rect !== 'object') return null;
  const size = win.getContentSize();
  const cw = Math.max(1, Math.round(size[0] || 0));
  const ch = Math.max(1, Math.round(size[1] || 0));
  const nx = Number(rect.x), ny = Number(rect.y);
  const nw = Number(rect.width), nh = Number(rect.height);
  if (!Number.isFinite(nw) || !Number.isFinite(nh)) return null;
  // Clamping the origin to the far edge (not edge-1) makes a rect that sits
  // entirely off-window collapse to zero width/height below, so it falls back
  // to a full-window capture instead of producing a 1x1 pixel PNG.
  const x = Math.max(0, Math.min(cw, Math.round(Number.isFinite(nx) ? nx : 0)));
  const y = Math.max(0, Math.min(ch, Math.round(Number.isFinite(ny) ? ny : 0)));
  const width = Math.min(Math.round(nw), cw - x);
  const height = Math.min(Math.round(nh), ch - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
ipcMain.handle('report:capture-png', async (e, rect) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: 'no-window' };
    const area = clampCaptureRect(win, rect);
    const image = area
      ? await win.webContents.capturePage(area)
      : await win.webContents.capturePage();
    if (!image || image.isEmpty()) return { ok: false, error: 'empty-capture' };
    const filePath = writeToDesktop(sanitizeExportName(rect && rect.name, '年报'), '.png', image.toPNG());
    return { ok: true, path: filePath };
  } catch (err) {
    dlog('report:capture-png failed: ' + (err && err.stack || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
});
// XZ-AIM-BEGIN
// Aim assist: labelled wind-indicator crops, for building the digit recogniser.
// Written to their own Desktop folder rather than mixed in with screenshots, and
// deliberately dumb — the renderer decides what is worth keeping and what to name it.
ipcMain.handle('aim:save-sample', (_e, pngBytes, name) => {
  try {
    const dir = path.join(app.getPath('desktop'), '小竹风力样本');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'sample').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    const filePath = path.join(dir, safe);
    fs.writeFileSync(filePath, Buffer.from(pngBytes));
    return { ok: true, path: filePath };
  } catch (e) {
    dlog('aim:save-sample failed: ' + (e && e.stack || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});
// --- Aim assist pop-out ------------------------------------------------------
// The panel has to be able to leave the window. Multi-opened game windows are
// small, and a panel sitting inside one covers the board it is describing. The
// pop-out holds no logic of its own: it drives the game window it was launched
// from through the RPC pair below, so probing the stage, grabbing pixels and
// dragging a calibration box all still happen in exactly one place.
let aimWindow = null;
let aimOwner = null;                 // webContents of the window holding the game
const aimPending = new Map();
let aimSeq = 0;

function closeAimWindow() {
  if (aimWindow && !aimWindow.isDestroyed()) aimWindow.close();
  aimWindow = null;
}

ipcMain.handle('aim:popout', (e) => {
  try {
    aimOwner = e.sender;
    if (aimWindow && !aimWindow.isDestroyed()) { aimWindow.show(); aimWindow.focus(); return { ok: true }; }
    const owner = BrowserWindow.fromWebContents(e.sender);
    const ob = owner ? owner.getBounds() : { x: 120, y: 120, width: 1200, height: 800 };
    aimWindow = new BrowserWindow({
      width: 346,
      height: Math.min(760, Math.max(520, ob.height)),
      x: Math.round(ob.x + ob.width + 8),
      y: Math.round(ob.y),
      title: '竞技辅助',
      backgroundColor: '#1c1612',
      alwaysOnTop: true,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    // 'floating' keeps it over the game windows without stealing their focus,
    // and staying visible across spaces matters when the games are tiled out.
    aimWindow.setAlwaysOnTop(true, 'floating');
    try { aimWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (err) {}
    aimWindow.loadFile(path.join(__dirname, 'aim-window.html'));
    aimWindow.on('closed', () => {
      aimWindow = null;
      if (aimOwner && !aimOwner.isDestroyed()) aimOwner.send('aim:popout-closed');
    });
    e.sender.once('destroyed', () => closeAimWindow());
    return { ok: true };
  } catch (err) {
    dlog('aim:popout failed: ' + (err && err.stack || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('aim:popin', () => { closeAimWindow(); return true; });

// One call out to the game window, one answer back, correlated by id. Rejections
// carry the reason so the pop-out can say what went wrong instead of going blank.
ipcMain.handle('aim:rpc', (_e, method, args) => new Promise((resolve, reject) => {
  if (!aimOwner || aimOwner.isDestroyed()) { reject(new Error('游戏窗口已经关了')); return; }
  const id = ++aimSeq;
  aimPending.set(id, { resolve, reject });
  aimOwner.send('aim:rpc', id, method, args);
  setTimeout(() => {
    const p = aimPending.get(id);
    if (p) { aimPending.delete(id); p.reject(new Error('游戏窗口没有应答')); }
  }, 12000);
}));
ipcMain.on('aim:rpc-result', (_e, id, ok, payload) => {
  const p = aimPending.get(id);
  if (!p) return;
  aimPending.delete(id);
  if (ok) p.resolve(payload); else p.reject(new Error(String(payload)));
});

// XZ-AIM-END
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
  if (XZSession) { try { XZSession.flush('relaunch'); } catch (e) {} }
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
  const profiles = getProfiles();
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

// Account shortcuts live in the menu so they stay app-scoped, not system-wide.
// Stops at 8: Cmd+9 stays with Fit to Window.
function accountMenuItems() {
  const items = [];
  for (let n = 1; n <= 8; n++) {
    items.push({
      label: 'Account ' + n,
      accelerator: 'CommandOrControl+' + n,
      click: () => sendToFocused('action', 'switch-account', n),
    });
  }
  items.push({ type: 'separator' });
  // These run in the main process. Routing them through the renderer meant the
  // action depended on the renderer correctly identifying the focused window,
  // which is exactly the part that kept failing.
  items.push({
    label: 'Minimize Other Windows',
    accelerator: 'CommandOrControl+Shift+H',
    click: () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win || win.isDestroyed()) return; // nothing focused: do nothing
      parkOthers(win);
    },
  });
  items.push({
    label: 'Restore All Windows',
    accelerator: 'CommandOrControl+Shift+U',
    click: () => unparkAll(),
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Tile Windows',
    accelerator: 'CommandOrControl+Shift+T',
    click: () => tileWindows(),
  });
  items.push({
    label: 'Restore Last Layout',
    accelerator: 'CommandOrControl+Shift+L',
    click: () => restoreTileLayout(),
  });
  return items;
}
function broadcast(...args) {
  for (const w of windows) {
    if (!w || w.isDestroyed()) continue;
    try { w.webContents.send(...args); } catch (e) {}
  }
}

// Serial account opening: one window at a time so the load peak is spread out.
// We wait for the renderer to report the game webview actually finished loading
// (window:ready), not just for the shell page. The timeout is the only guarantee:
// a renderer that never calls window:ready still lets the queue drain.
const OPEN_READY_TIMEOUT = 20000;
const pendingReady = new Map(); // win.id -> finish(reason)

ipcMain.handle('window:ready', (e) => {
  let win = null;
  try { win = BrowserWindow.fromWebContents(e.sender); } catch (err) {}
  if (!win || win.isDestroyed()) return false;
  const finish = pendingReady.get(win.id);
  if (finish) finish('ready');
  return true;
});

function waitForWindowReady(win, timeoutMs) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve('gone'); return; }
    const winId = win.id;
    let shellLoaded = false;
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingReady.delete(winId);
      if (reason === 'timeout') {
        dlog('sequential open timeout for win ' + winId + (shellLoaded ? ' (shell loaded, no window:ready)' : ' (shell never loaded)'));
      }
      resolve(reason);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs || OPEN_READY_TIMEOUT);
    pendingReady.set(winId, finish);
    try {
      // Demoted to diagnostics only: the shell loading says nothing about the game.
      win.webContents.once('did-finish-load', () => { shellLoaded = true; });
      // Nothing left to wait for in these two cases, so don't burn the full timeout.
      win.webContents.on('did-fail-load', (_ev, _code, _desc, _url, isMainFrame) => {
        if (isMainFrame !== false) finish('failed');
      });
      win.once('closed', () => finish('closed'));
    } catch (e) { finish('error'); }
  });
}
async function openWindowsSequentially(items) {
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    let win = null;
    try { win = createBrowserWindowWithUrl(list[i].url, list[i].profileId, list[i].options || {}); }
    catch (e) { dlog('sequential open failed: ' + (e && e.stack || e)); continue; }
    if (i < list.length - 1) await waitForWindowReady(win, OPEN_READY_TIMEOUT);
  }
}

// Edge-aligned cell: computing both edges from the same fraction means adjacent
// cells share an exact border instead of leaving a rounding gap or overlap.
function cellRect(wa, col, row, cols, rows, colSpan, rowSpan) {
  const cs = colSpan || 1;
  const rs = rowSpan || 1;
  const x0 = wa.x + Math.round(col * wa.width / cols);
  const x1 = wa.x + Math.round((col + cs) * wa.width / cols);
  const y0 = wa.y + Math.round(row * wa.height / rows);
  const y1 = wa.y + Math.round((row + rs) * wa.height / rows);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}
function gridBounds(index, total) {
  const wa = screen.getPrimaryDisplay().workArea;
  const count = Math.max(1, total || 1);
  const i = Math.max(0, Math.min(count - 1, Number(index) || 0));
  if (count === 1) return cellRect(wa, 0, 0, 1, 1);
  if (count === 2) return cellRect(wa, i, 0, 2, 1);
  // Three windows: a plain 2x2 grid with the bottom-right cell left empty, so
  // every window is the same size (requested over the old 1-tall + 2-stacked
  // layout, where the left pane was twice the height of the other two).
  const cols = (count === 3 || count === 4) ? 2 : count <= 6 ? 3 : Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return cellRect(wa, i % cols, Math.floor(i / cols), cols, rows);
}

function createBrowserWindowWithUrl(initialUrl, profileId, options = {}) {
  const wa = screen.getPrimaryDisplay().workArea;
  let bounds = options.bounds || null;
  // An explicit bounds (e.g. the accounts grid) always wins; otherwise reuse
  // where this account sat last time, but only if a display still covers it.
  if (!bounds && profileId) {
    try { bounds = rememberedBoundsFor(profileId); }
    catch (e) { dlog('remembered bounds lookup failed: ' + (e && e.stack || e)); bounds = null; }
  }
  if (!bounds) bounds = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  const title = app.getName() || '小竹Flash浏览器';
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    autoHideMenuBar: true,
    resizable,
    fullscreenable: resizable,
    title,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 11 },
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
  const initData = { initialUrl, profileId };
  if (options.init && typeof options.init === 'object') Object.assign(initData, options.init);
  if (initialUrl || profileId || options.init) pendingInit.set(win, initData);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.on('new-window', (event, url) => {
      event.preventDefault();
      if (url) win.webContents.send('action', 'new-tab', url);
    });
    wc.on('before-input-event', (_event, input) => {
      if (!input || input.type !== 'keyDown') return;
      win.webContents.send('shortcut:input', {
        key: input.key,
        code: input.code,
        alt: !!input.alt,
        control: !!input.control,
        meta: !!input.meta,
        shift: !!input.shift,
      });
    });
    if (typeof wc.setWindowOpenHandler === 'function') {
      wc.setWindowOpenHandler(({ url }) => {
        if (url) win.webContents.send('action', 'new-tab', url);
        return { action: 'deny' };
      });
    }
  });

  windows.add(win);
  const winId = win.id;
  windowInfo.set(winId, {
    profileId: profileId ? String(profileId) : null,
    title,
    url: initialUrl || '',
  });
  for (const event of ['minimize', 'restore', 'maximize', 'unmaximize', 'focus', 'blur', 'show', 'hide']) {
    win.on(event, broadcastWindows);
  }
  // Remember geometry the user arranges by hand. Debounced: a drag fires these
  // continuously and writing on every tick would hammer the disk.
  for (const event of ['move', 'resize']) {
    win.on(event, () => scheduleBoundsCapture(win));
  }
  // Second, independent focus listener: whichever account is being played sets
  // the live speed. Separate from broadcastWindows so neither can break the other.
  win.on('focus', () => {
    const info = windowInfo.get(winId);
    if (info && info.profileId) applyProfileSpeedOnFocus(info.profileId);
  });
  win.on('page-title-updated', (_ev, newTitle) => {
    const info = windowInfo.get(winId);
    if (info && typeof newTitle === 'string') { info.title = newTitle.slice(0, 200); broadcastWindows(); }
  });
  // 'close' still has a live window, so this is the last chance to read bounds.
  win.on('close', () => {
    cancelBoundsCapture(winId);
    captureWindowBounds(win);
  });
  win.on('closed', () => {
    cancelBoundsCapture(winId);
    windows.delete(win);
    windowInfo.delete(winId);
    if (XZSession) { try { XZSession.onWindowClosed(winId); } catch (e) {} }
    endSessionsForWindow(winId);
    broadcastWindows();
  });
  broadcastWindows();
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
        // Same action as above; keeps the old Cmd+Shift+C shortcut without a global hook.
        { label: 'Clear Cache and Reload', accelerator: 'CommandOrControl+Shift+C', click: async () => {
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
        { label: 'Focus Mode', accelerator: 'CommandOrControl+Shift+F', click: () => sendToFocused('action', 'toggle-focus-mode') },
        { label: 'Pin Current Account', accelerator: 'CommandOrControl+Shift+P', click: () => sendToFocused('action', 'focus-pin') },
        // ⌘⇧L is already Restore Last Layout in the Accounts menu, so Focus Layout takes ⌘⇧D.
        { label: 'Focus Layout', accelerator: 'CommandOrControl+Shift+D', click: () => sendToFocused('action', 'focus-layout') },
        { label: 'Command Palette', accelerator: 'CommandOrControl+K', click: () => sendToFocused('action', 'command-palette') },
        { label: 'Status Bar', accelerator: 'CommandOrControl+Shift+B', click: () => sendToFocused('action', 'toggle-status-bar') },
        { label: 'Integer Zoom', click: () => sendToFocused('action', 'toggle-zoom-snap') },
        { label: 'Clean Up Page', click: () => sendToFocused('action', 'cycle-cleanup') },
        // Deliberately without an accelerator: it reloads every tab it moves.
        { label: 'Scatter Tabs to Windows & Tile', click: () => sendToFocused('action', 'scatter-tile') },
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
    {
      label: 'Accounts',
      submenu: accountMenuItems(),
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // 可选主进程模块：init 抛错就退回 null，主流程一切照旧。
  if (XZMetrics) { try { XZMetrics.init({ app, dlog }); } catch (e) { dlog('metrics init failed: ' + (e && e.stack || e)); XZMetrics = null; } }
  if (XZSession) { try { XZSession.init({ app, windows, windowInfo, readJson, writeJson, getSettings, createBrowserWindowWithUrl, openWindowsSequentially, boundsVisibleOnSomeDisplay, dlog, homeUrl }); } catch (e) { dlog('session init failed: ' + (e && e.stack || e)); XZSession = null; } }

  // Close out sessions the previous run never got to end.
  try { recoverUsageSessions(); } catch (e) { dlog('usage recovery failed: ' + (e && e.stack || e)); }
  startUsageHeartbeat();

  // Sleep ends every session; waking starts fresh ones for the surviving windows.
  try {
    powerMonitor.on('suspend', () => {
      suspendedSessions = [];
      for (const entry of activeSessions.values()) {
        suspendedSessions.push({ winId: entry.winId, profileId: entry.profileId, host: entry.host });
      }
      endAllUsageSessions();
    });
    powerMonitor.on('resume', () => {
      const pending = suspendedSessions;
      suspendedSessions = [];
      for (const item of pending) {
        const win = findWindowById(item.winId);
        if (!win) continue;
        const id = beginUsageSession(item.profileId, item.host, item.winId);
        // Send the profile/host back too: the renderer must not have to guess
        // which of its tabs a bare session id belongs to.
        try {
          win.webContents.send('usage:resumed', {
            sessionId: id,
            profileId: item.profileId || null,
            host: item.host || '',
          });
        } catch (e) {}
      }
    });
  } catch (e) { dlog('powerMonitor hook failed: ' + (e && e.stack || e)); }

  let restored = false;
  if (XZSession) { try { restored = XZSession.restoreOnLaunch(initialLaunchUrl) === true; } catch (e) { dlog('session restore failed: ' + (e && e.stack || e)); restored = false; } }
  if (!restored) {
    try { createBrowserWindowWithUrl(initialLaunchUrl); }
    catch (e) { dlog('createWin THREW: ' + (e && e.stack || e)); }
  }
});

app.on('before-quit', () => {
  if (XZSession) { try { XZSession.onBeforeQuit(); } catch (e) { dlog('session quit flush failed: ' + (e && e.stack || e)); } }
  try { endAllUsageSessions(); } catch (e) { dlog('quit session flush failed: ' + (e && e.stack || e)); }
  // Debounced layout writes would otherwise be lost when the timers die with us.
  try { flushLayouts(); } catch (e) { dlog('quit layout flush failed: ' + (e && e.stack || e)); }
});
app.on('will-quit', () => {
  if (XZSession) { try { XZSession.flush('will-quit'); } catch (e) {} }
  if (usageHeartbeat) { clearInterval(usageHeartbeat); usageHeartbeat = null; }
  try { endAllUsageSessions(); } catch (e) {}
  try { flushLayouts(); } catch (e) {}
});
