const { ipcRenderer } = require('electron');
const i18n = require('./i18n.js');

// ----- Beijing time (UTC+8, no DST). Never use the local timezone for day math:
// the yearly report and the "opened today" marker must agree with the main process. -----
const BJ_OFFSET = 8 * 60 * 60 * 1000;
function beijingDay(ts)   { return new Date((ts || Date.now()) + BJ_OFFSET).toISOString().slice(0, 10); }
function beijingMonth(ts) { return beijingDay(ts).slice(0, 7); }
function beijingHour(ts)  { return new Date((ts || Date.now()) + BJ_OFFSET).getUTCHours(); }

// ----- state -----
const tabs = [];
let activeId = null;
let nextId = 1;
let homeUrl = 'https://www.4399.com/';
let history = [];
let bookmarks = [];
let profiles = [];
let passwords = [];
let skippedSites = [];
let notes = [];
let tasks = [];
let activeNoteId = null;
let editingProfileId = null;
let editingAccountId = null;
let notesSaveTimer = null;
const DEFAULT_SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6, 8, 10];
const DEFAULT_SPEED_SHORTCUTS = {
  prev: 'Alt+BracketLeft',
  next: 'Alt+BracketRight',
  reset: 'Alt+Digit0',
  measure: 'Alt+KeyM',
  screenshot: 'Alt+KeyS',
  aim: 'Alt+KeyA',
};
const DEFAULT_SPEED_HOTKEYS = [
  { factor: 1, shortcut: 'Alt+Digit1' },
  { factor: 2, shortcut: 'Alt+Digit2' },
  { factor: 3, shortcut: 'Alt+Digit3' },
  { factor: 5, shortcut: 'Alt+Digit4' },
];
const DEFAULT_MEASURE = {
  scalePixelsPer10: null,
};
let settings = {
  language: 'zh-CN',
  defaultProfileId: 'main',
  restoreSession: true,
  sidebarCollapsed: false,
  speedProfile: 'native-ddt',
  speedProfileVersion: 5,
  speedPresets: DEFAULT_SPEED_PRESETS.slice(),
  speedShortcuts: Object.assign({}, DEFAULT_SPEED_SHORTCUTS),
  speedHotkeys: DEFAULT_SPEED_HOTKEYS.map(h => Object.assign({}, h)),
  measure: Object.assign({}, DEFAULT_MEASURE),
  theme: 'xiaozhu-native',
  showQuickNote: true,
  globalMuted: false,
  newTabMode: 'current',
  newTabUrl: '',
};
const NEW_TAB_MODES = ['current', 'home', 'custom'];
let appearanceExpanded = false;
let customThemeSaveTimer = null;
let speedFactor = 1;
let speedHookEnabled = false;
let currentRoute = 'home';
let pendingSavePrompt = null;
let profileOpenUrl = null;
let windowProfileId = null; // each window is bound to one profile (Chrome-style)
// Profiles page: view order ('manual' = the real stored order, 'recent' = display-only sort).
let profileOrderView = 'manual';
let profileDragId = null;       // id of the card being dragged, null when idle
let profileRenderPending = false; // a profiles:changed arrived mid-drag; redraw on dragend
let profileEditDraft = null;    // { id, name, color, caret, fresh } — survives broadcast redraws
let runningProfileIds = new Set(); // profiles that currently have a window open
const touchedProfileIds = new Set(); // profiles this window already counted as "opened"
let menuCloseHandler = null;
let shortcutCaptureTarget = null;
let measuring = {
  active: false,
  mode: 'measure',
  origin: null,
  target: null,
  scaleStart: null,
  scaleEnd: null,
  hover: null,
};
const preloadPath = 'file://' + document.location.pathname.split('/').slice(0, -1).join('/') + '/webview-preload.js';
const HISTORY_LIMIT = 2000;
const HISTORY_REPEAT_WRITE_MS = 30000;
const LIST_RENDER_LIMIT = 400;
const FLASHPOINT_URL = 'https://flashpointarchive.org/downloads/';
let historySaveTimer = null;
const PROFILE_COLORS = ['#F4A23C', '#C86B2A', '#8B4E2A', '#5B4636', '#E09F3E', '#9E6240', '#4C7A5A', '#486F9E'];
const THEME_ASSET_BASE = 'assets/themes/';
const DEFAULT_CUSTOM_THEME = {
  colors: {
    background: '#F7EFDE',
    backgroundAlt: '#ECE0C5',
    panel: '#FFF8E9',
    panelAlt: '#FFFCF4',
    soft: '#EFDCA8',
    accent: '#90631C',
    accentDeep: '#6F4718',
    muted: '#7A6647',
    text: '#2C2211',
    subtext: '#715E3F',
  },
  badgeImage: null,
  mascotImage: null,
};
const CUSTOM_COLOR_FIELDS = [
  ['background', 'theme.custom_background'],
  ['backgroundAlt', 'theme.custom_background_alt'],
  ['panel', 'theme.custom_panel'],
  ['soft', 'theme.custom_soft'],
  ['accent', 'theme.custom_accent'],
  ['accentDeep', 'theme.custom_accent_deep'],
  ['muted', 'theme.custom_muted'],
  ['text', 'theme.custom_text'],
  ['subtext', 'theme.custom_subtext'],
];
const CUSTOM_THEME_STYLE_PROPS = [
  '--cream-bg', '--cream-bg-2', '--panel-white', '--panel-white-2', '--soft-wheat',
  '--main-orange', '--deep-orange', '--warm-brown', '--dark-brown', '--text-primary',
  '--text-secondary', '--border', '--border-strong', '--hover-bg', '--warning-bg',
  '--warning-border', '--ambient-a', '--ambient-b', '--brand-badge-image',
  '--footer-art-image', '--home-art-image', '--footer-art-opacity', '--footer-art-filter',
  '--footer-art-blend-mode', '--home-art-opacity', '--home-art-filter', '--home-art-blend-mode',
  '--doctor-repair-image', '--doctor-ok-image', '--doctor-windows-image',
];
const THEMES = [
  {
    id: 'xiaozhu-native',
    nameKey: 'theme.xiaozhu_native',
    descKey: 'theme.xiaozhu_native_desc',
    swatches: ['#F3F0E6', '#12657C', '#A9DCA0'],
  },
  {
    id: 'bamboo-morning',
    nameKey: 'theme.bamboo_morning',
    descKey: 'theme.bamboo_morning_desc',
    swatches: ['#EFF3EA', '#0A5F94', '#A6DFB4'],
  },
  {
    id: 'orange-special',
    nameKey: 'theme.orange_special',
    descKey: 'theme.orange_special_desc',
    swatches: ['#F8EFE1', '#1D5FA8', '#F7C878'],
  },
  {
    id: 'flash-archive',
    nameKey: 'theme.flash_archive',
    descKey: 'theme.flash_archive_desc',
    swatches: ['#F1E9D9', '#1F5E77', '#E2C588'],
  },
  {
    id: 'wolf-wheat',
    nameKey: 'theme.wolf_wheat',
    descKey: 'theme.wolf_wheat_desc',
    swatches: ['#F7EFDE', '#2C6B45', '#E8CE84'],
  },
  {
    id: 'tea-garden',
    nameKey: 'theme.tea_garden',
    descKey: 'theme.tea_garden_desc',
    swatches: ['#F2F0E1', '#A63F22', '#CBD99A'],
  },
  {
    id: 'sakura',
    nameKey: 'theme.sakura',
    descKey: 'theme.sakura_desc',
    swatches: ['#FDF3F6', '#0A69A6', '#CDEBFB'],
  },
  {
    id: 'mist-blue',
    nameKey: 'theme.mist_blue',
    descKey: 'theme.mist_blue_desc',
    swatches: ['#EDF1F3', '#98512E', '#A8CBDD'],
  },
  {
    id: 'moonlight',
    nameKey: 'theme.moonlight',
    descKey: 'theme.moonlight_desc',
    swatches: ['#161D19', '#E0B45F', '#6ECBC4'],
  },
  {
    id: 'arcade-night',
    nameKey: 'theme.arcade_night',
    descKey: 'theme.arcade_night_desc',
    swatches: ['#111726', '#5FC2DE', '#7BE0D8'],
  },
  {
    id: 'graphite',
    nameKey: 'theme.graphite',
    descKey: 'theme.graphite_desc',
    swatches: ['#EDEFF2', '#356697', '#B4C4D6'],
  },
  {
    id: 'custom',
    nameKey: 'theme.custom',
    descKey: 'theme.custom_desc',
    custom: true,
  },
];
const THEME_IDS = THEMES.map(t => t.id);
const EMPTY_ASSETS = {
  library: 'empty-wolf-wheat-library.png',
  favorites: 'mascot-wolf-wheat-sitting.png',
  recent: 'mascot-wolf-wheat-standing.png',
  windows: 'mascot-wolf-wheat-tiny-footer.png',
  notes: 'mascot-wolf-wheat-reading.png',
  tasks: 'doctor-wolf-wheat-ok.png',
  doctorRepair: 'mascot-wolf-wheat-reading.png',
  doctorOk: 'doctor-wolf-wheat-ok.png',
};
const $ = (id) => document.getElementById(id);
const $topUrl = $('url');
const $back = $('back');
const $forward = $('forward');
const $reload = $('reload');
const $bmStar = $('bookmark-star');
const $zoomInd = $('zoom-indicator');
const $tabList = $('tab-list');
const $webviews = $('webviews-container');

const SPEED_PROFILES = [
  { key: 'ppapi-time', code: 0, labelKey: 'speed.profile_ppapi_time', shortKey: 'speed.mode_ppapi_time_short' },
  { key: 'ppapi-schedule', code: 1, labelKey: 'speed.profile_ppapi_schedule', shortKey: 'speed.mode_ppapi_schedule_short' },
  { key: 'native-tick', code: 2, labelKey: 'speed.profile_native_tick', shortKey: 'speed.mode_native_tick_short' },
  { key: 'native-mach', code: 3, labelKey: 'speed.profile_native_mach', shortKey: 'speed.mode_native_mach_short' },
  { key: 'native-combo', code: 4, labelKey: 'speed.profile_native_combo', shortKey: 'speed.mode_native_combo_short' },
  { key: 'native-ddt', code: 5, labelKey: 'speed.profile_native_ddt', shortKey: 'speed.mode_native_ddt_short' },
  { key: 'native-all', code: 6, labelKey: 'speed.profile_native_all', shortKey: 'speed.mode_native_all_short' },
  { key: 'native-all-schedule', code: 7, labelKey: 'speed.profile_native_all_schedule', shortKey: 'speed.mode_native_all_schedule_short' },
];
const SPEED_PROFILE_KEYS = SPEED_PROFILES.map(p => p.key);
const SPEED_PROFILE_BY_KEY = SPEED_PROFILES.reduce((acc, p) => { acc[p.key] = p; return acc; }, {});
const SPEED_PROFILE_MENU_KEYS = ['native-ddt', 'native-combo', 'native-all-schedule'];
const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight',
  'ShiftLeft', 'ShiftRight', 'CapsLock', 'Fn', 'FnLock',
]);

// ---------- storage ----------
async function loadStores() {
  const [h, bm, pr, pw, sk, nt, tk, st, hu] = await Promise.all([
    ipcRenderer.invoke('store:get', 'history'),
    ipcRenderer.invoke('store:get', 'bookmarks'),
    // Profiles live in the main process now: every window used to write the whole
    // array back through store:set and clobber the other windows' edits.
    ipcRenderer.invoke('profiles:list'),
    ipcRenderer.invoke('store:get', 'passwords'),
    ipcRenderer.invoke('store:get', 'pw_skipped_sites'),
    ipcRenderer.invoke('store:get', 'notes'),
    ipcRenderer.invoke('store:get', 'tasks'),
    ipcRenderer.invoke('store:get', 'settings'),
    ipcRenderer.invoke('app:home-url'),
  ]);
  history = h || []; bookmarks = bm || []; profiles = pr || []; passwords = pw || [];
  if (history.length > HISTORY_LIMIT) {
    history.length = HISTORY_LIMIT;
    saveHistory();
  }
  skippedSites = sk || []; notes = nt || []; tasks = tk || [];
  settings = Object.assign(settings, st || {});
  settings.identity = settings.identity || {};
  let settingsChanged = false;
  if (!SPEED_PROFILE_KEYS.includes(settings.speedProfile)) {
    settings.speedProfile = 'native-ddt';
    settingsChanged = true;
  }
  if (settings.speedProfileVersion !== 5) {
    settings.speedProfile = 'native-ddt';
    settings.speedProfileVersion = 5;
    settingsChanged = true;
  }
  if (settings.showQuickNote == null) {
    settings.showQuickNote = true;
    settingsChanged = true;
  }
  if (settings.globalMuted == null) {
    settings.globalMuted = false;
    settingsChanged = true;
  }
  if (!NEW_TAB_MODES.includes(settings.newTabMode)) {
    settings.newTabMode = 'current';
    settingsChanged = true;
  }
  if (typeof settings.newTabUrl !== 'string') {
    settings.newTabUrl = '';
    settingsChanged = true;
  }
  const normalizedCustomTheme = normalizeCustomTheme(settings.customTheme);
  if (JSON.stringify(normalizedCustomTheme) !== JSON.stringify(settings.customTheme || null)) {
    settings.customTheme = normalizedCustomTheme;
    settingsChanged = true;
  }
  if (!THEME_IDS.includes(settings.theme)) {
    settings.theme = 'xiaozhu-native';
    settingsChanged = true;
  }
  if (settings.speedAutoMute != null) {
    delete settings.speedAutoMute;
    settingsChanged = true;
  }
  const normalizedSpeedPresets = normalizeSpeedPresets(settings.speedPresets);
  if (JSON.stringify(normalizedSpeedPresets) !== JSON.stringify(settings.speedPresets || null)) {
    settings.speedPresets = normalizedSpeedPresets;
    settingsChanged = true;
  }
  const normalizedSpeedShortcuts = normalizeSpeedShortcuts(settings.speedShortcuts);
  if (JSON.stringify(normalizedSpeedShortcuts) !== JSON.stringify(settings.speedShortcuts || null)) {
    settings.speedShortcuts = normalizedSpeedShortcuts;
    settingsChanged = true;
  }
  const normalizedSpeedHotkeys = normalizeSpeedHotkeys(settings.speedHotkeys);
  if (JSON.stringify(normalizedSpeedHotkeys) !== JSON.stringify(settings.speedHotkeys || null)) {
    settings.speedHotkeys = normalizedSpeedHotkeys;
    settingsChanged = true;
  }
  const normalizedMeasure = normalizeMeasureSettings(settings.measure);
  if (JSON.stringify(normalizedMeasure) !== JSON.stringify(settings.measure || null)) {
    settings.measure = normalizedMeasure;
    settingsChanged = true;
  }
  if (settingsChanged) await ipcRenderer.invoke('store:set', 'settings', settings);
  [speedFactor, speedHookEnabled] = await Promise.all([
    ipcRenderer.invoke('speed:get'),
    ipcRenderer.invoke('speed:hook-enabled'),
  ]);
  homeUrl = hu || homeUrl;
  ensureProfiles();
}
const saveHistory      = () => ipcRenderer.invoke('store:set', 'history', history);
const saveBookmarks    = () => ipcRenderer.invoke('store:set', 'bookmarks', bookmarks);
// --- Profile mutations: main is the single source of truth. Never store:set the
// whole array; each helper resolves with (and adopts) the authoritative list. ---
function adoptProfiles(list) {
  if (Array.isArray(list)) profiles = list;
  return profiles;
}
function upsertProfile(patch) {
  if (!patch || !patch.id) return Promise.resolve(profiles);
  return ipcRenderer.invoke('profiles:upsert', patch).then(adoptProfiles).catch(() => profiles);
}
function reorderProfiles(ids) {
  return ipcRenderer.invoke('profiles:reorder', ids).then(adoptProfiles).catch(() => profiles);
}
function removeProfile(id) {
  return ipcRenderer.invoke('profiles:remove', id).then(adoptProfiles).catch(() => profiles);
}
function touchProfile(id) {
  if (!id) return Promise.resolve(profiles);
  return ipcRenderer.invoke('profiles:touch', id).then(adoptProfiles).catch(() => profiles);
}
const savePasswords    = () => ipcRenderer.invoke('store:set', 'passwords', passwords);
const saveSkippedSites = () => ipcRenderer.invoke('store:set', 'pw_skipped_sites', skippedSites);
const saveSettings     = () => ipcRenderer.invoke('store:set', 'settings', settings);
const saveNotes        = () => ipcRenderer.invoke('store:set', 'notes', notes);
const saveTasks        = () => ipcRenderer.invoke('store:set', 'tasks', tasks);
function saveHistorySoon() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    saveHistory();
  }, 700);
}
function flushHistorySave() {
  if (!historySaveTimer) return;
  clearTimeout(historySaveTimer);
  historySaveTimer = null;
  saveHistory();
}
window.addEventListener('beforeunload', flushHistorySave);

// ---------- utility ----------
function normalizeInput(input) {
  input = (input || '').trim();
  if (!input) return homeUrl;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return input;
  if (/^[^\s]+\.[^\s]+$/.test(input) || input.startsWith('localhost') || input.startsWith('127.0.0.1')) {
    return 'http://' + input;
  }
  return 'https://www.baidu.com/s?wd=' + encodeURIComponent(input);
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}
// Where a new tab lands when the caller has no destination of its own: the + button,
// the per-account new-tab menu and \u2318T / the New Tab menu item all ask here. Default
// 'current' keeps the user on the game they are already in instead of the 4399 home page;
// anything unusable as a starting address (no tab yet, about:blank, a data: URL) falls
// back to homeUrl so a new tab is never blank.
function newTabUrl() {
  const mode = NEW_TAB_MODES.includes(settings.newTabMode) ? settings.newTabMode : 'current';
  if (mode === 'home') return homeUrl;
  if (mode === 'custom') {
    const raw = String(settings.newTabUrl == null ? '' : settings.newTabUrl).trim();
    return raw ? normalizeInput(raw) : homeUrl;
  }
  const t = activeTab();
  const url = t && t.url ? String(t.url).trim() : '';
  return /^https?:\/\//i.test(url) ? url : homeUrl;
}

// ---------- site rules (profile.sites) ----------
// A profile may claim hosts: opening one of them the "cold" way (address bar, bookmark,
// home tile, plain new tab) starts the tab on that account. Rules live on the profile as
// a plain array of bare hosts — "4399.com" — and every shape the user might type is
// normalised down to that here, so the matcher only ever sees one form.
function normalizeSiteRule(value) {
  let s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');    // scheme
  s = s.replace(/^[^/@]*@/, '');                   // user:pass@
  s = s.split('/')[0].split('?')[0].split('#')[0]; // path / query / hash
  s = s.replace(/:\d+$/, '');                      // port
  s = s.replace(/^www\./, '');
  s = s.replace(/^\.+|\.+$/g, '');                  // stray dots
  if (!s || !/^[a-z0-9.-]+$/.test(s)) return '';
  return s;
}
function normalizeSiteRuleList(values) {
  const out = [];
  const list = Array.isArray(values) ? values : [];
  for (const raw of list) {
    const rule = normalizeSiteRule(raw);
    if (rule && out.indexOf(rule) < 0) out.push(rule);
  }
  return out;
}
// Suffix match on label boundaries only: "4399.com" owns ddt.4399.com but must not own
// my4399.com (no boundary) or 4399.com.evil.com (wrong end).
function hostMatchesRule(host, rule) {
  const h = String(host || '').trim().toLowerCase().replace(/\.+$/, '');
  const r = normalizeSiteRule(rule);
  if (!h || !r) return false;
  return h === r || h.endsWith('.' + r);
}
function siteHostOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const h = new URL(raw).hostname;
    if (h) return h.toLowerCase().replace(/\.+$/, '');
  } catch (e) {}
  return normalizeSiteRule(raw);   // a bare "4399.com/x" typed by hand
}
function profileSites(p) {
  return (p && Array.isArray(p.sites)) ? p.sites : [];
}
// The longest (most specific) matching rule wins, so "ddt.4399.com" beats "4399.com".
// A tie goes to the profile listed first — that array order is the order the user sees.
function profileForUrl(url, list) {
  const source = Array.isArray(list) ? list : profiles;
  const host = siteHostOf(url);
  if (!host) return null;
  let best = null;
  let bestLen = -1;
  for (const p of source) {
    if (!p) continue;
    for (const raw of profileSites(p)) {
      const rule = normalizeSiteRule(raw);
      if (!rule || !hostMatchesRule(host, rule)) continue;
      if (rule.length > bestLen) { bestLen = rule.length; best = p; }
    }
  }
  return best;
}
// A host belongs to exactly one account, so claiming it takes it away from whoever held
// it — an ambiguous rule would make the account a coin flip. Returns the names it took
// the host from, for the toast.
async function writeProfileSites(profileId, rules) {
  const list = normalizeSiteRuleList(rules);
  const taken = [];
  const patches = [];
  for (const other of profiles) {
    if (!other || other.id === profileId) continue;
    const current = normalizeSiteRuleList(profileSites(other));
    const kept = current.filter(r => list.indexOf(r) < 0);
    if (kept.length !== current.length) {
      patches.push({ id: other.id, sites: kept });
      taken.push(other.name || '');
    }
  }
  await upsertProfile({ id: profileId, sites: list });
  for (const patch of patches) await upsertProfile(patch);
  return taken;
}
// Snapshot every account's rule list, so any site change can be put back exactly
// as it was — assigning a host silently takes it off whoever held it, and that
// is not something a user can reconstruct from memory.
function siteRulesSnapshot() {
  return profiles.map(p => ({ id: p.id, sites: normalizeSiteRuleList(profileSites(p)) }));
}
async function restoreSiteRules(snapshot) {
  if (!Array.isArray(snapshot)) return;
  for (const row of snapshot) {
    const p = profiles.find(x => x && x.id === row.id);
    if (!p) continue;
    const now = normalizeSiteRuleList(profileSites(p));
    if (now.join('\n') === row.sites.join('\n')) continue;
    await upsertProfile({ id: row.id, sites: row.sites });
  }
  if (currentRoute === 'profiles') renderProfiles();
}
async function clearSiteRule(host) {
  const rule = normalizeSiteRule(host);
  if (!rule) return [];
  const cleared = [];
  for (const p of profiles) {
    const current = normalizeSiteRuleList(profileSites(p));
    const kept = current.filter(r => r !== rule);
    if (kept.length !== current.length) {
      cleared.push(p.name || '');
      await upsertProfile({ id: p.id, sites: kept });
    }
  }
  if (currentRoute === 'profiles') renderProfiles();
  return cleared;
}
async function assignSiteToProfile(host, profileId) {
  const rule = normalizeSiteRule(host);
  const target = profiles.find(p => p.id === profileId);
  if (!rule || !target) return;
  const before = siteRulesSnapshot();
  const next = normalizeSiteRuleList(profileSites(target).concat([rule]));
  const taken = await writeProfileSites(profileId, next);
  const name = target.name || '';
  const undo = { label: tOr('common.undo', '\u64a4\u9500'), onClick: () => restoreSiteRules(before) };
  if (taken.length) {
    showToast(tOr('sites.moved_toast', '{host} \u5df2\u4ece {from} \u6539\u7ed9 {name}')
      .replace('{host}', rule).replace('{from}', taken.join('\u3001')).replace('{name}', name), undo);
  } else {
    showToast(tOr('sites.assigned_toast', '{host} \u4ee5\u540e\u7528 {name} \u6253\u5f00')
      .replace('{host}', rule).replace('{name}', name), undo);
  }
  if (currentRoute === 'profiles') renderProfiles();
}
async function unassignSite(host) {
  const rule = normalizeSiteRule(host);
  if (!rule) return;
  const before = siteRulesSnapshot();
  const cleared = await clearSiteRule(rule);
  if (!cleared.length) return;
  showToast(tOr('sites.cleared_toast', '{host} \u4e0d\u518d\u6307\u5b9a\u8d26\u53f7')
    .replace('{host}', rule),
    { label: tOr('common.undo', '\u64a4\u9500'), onClick: () => restoreSiteRules(before) });
}
function domainLetter(url) {
  const h = hostOf(url);
  return (h[0] || '?').toUpperCase();
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}
function clampSpeedPreset(value) {
  const n = Number(String(value || '').replace(/x$/i, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(0.5, Math.min(10, n)) * 100) / 100;
}
function normalizeSpeedPresets(value) {
  const source = Array.isArray(value) ? value : DEFAULT_SPEED_PRESETS;
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const n = clampSpeedPreset(item);
    if (n == null) continue;
    const key = n.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  if (!seen.has('1.00')) out.push(1);
  return out.sort((a, b) => a - b);
}
function normalizeSpeedShortcuts(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.assign({}, DEFAULT_SPEED_SHORTCUTS, source);
}
function normalizeSpeedHotkeys(value) {
  const source = Array.isArray(value) ? value : DEFAULT_SPEED_HOTKEYS;
  const out = [];
  for (let i = 0; i < Math.max(DEFAULT_SPEED_HOTKEYS.length, source.length); i++) {
    const base = DEFAULT_SPEED_HOTKEYS[i] || { factor: 1, shortcut: '' };
    const item = source[i] || {};
    out.push({
      factor: clampSpeedPreset(item.factor != null ? item.factor : base.factor) || base.factor,
      shortcut: typeof item.shortcut === 'string' ? item.shortcut : base.shortcut,
    });
  }
  return out.slice(0, 6);
}
function normalizeMeasureSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const scale = Number(source.scalePixelsPer10);
  return {
    scalePixelsPer10: Number.isFinite(scale) && scale > 0 ? scale : null,
  };
}
function normalizeCustomTheme(value) {
  const source = value && typeof value === 'object' ? value : {};
  const colors = Object.assign({}, DEFAULT_CUSTOM_THEME.colors, source.colors || {});
  for (const key of Object.keys(DEFAULT_CUSTOM_THEME.colors)) {
    if (!isHexColor(colors[key])) colors[key] = DEFAULT_CUSTOM_THEME.colors[key];
  }
  return {
    colors,
    badgeImage: typeof source.badgeImage === 'string' ? source.badgeImage : null,
    mascotImage: typeof source.mascotImage === 'string' ? source.mascotImage : null,
  };
}
function customTheme() {
  settings.customTheme = normalizeCustomTheme(settings.customTheme);
  return settings.customTheme;
}
function hexToRgb(hex) {
  const clean = String(hex || '#000000').replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}
function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + alpha + ')';
}
function cssImage(value, fallback) {
  return 'url("' + (value || fallback) + '")';
}
function assetUrl(fileName) {
  return THEME_ASSET_BASE + fileName;
}
function placeholderHtml(message, assetName, style) {
  const image = assetName ? '<div class="ph-asset" style="background-image:url(' + assetUrl(assetName) + ')"></div>' : '';
  return '<div class="placeholder" style="' + (style || '') + '">' +
    image +
    '<div class="ph-text">' + escapeHtml(message) + '</div>' +
    '</div>';
}
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// Fall back to a literal only while the i18n dictionary lacks the key, so the
// strings light up automatically once common.just_now / common.ago / common.yesterday land.
function tOr(key, fallback) {
  const dict = (i18n.dicts && (i18n.dicts[i18n.getLang()] || i18n.dicts.en)) || null;
  if (dict && dict[key] != null) return dict[key];
  return fallback;
}
function isZhLang() { return String(i18n.getLang() || '').toLowerCase().indexOf('zh') === 0; }
// "3 h ago" / "3 小时前" / "yesterday" / "9月1日" — all day math in Beijing time.
function formatRelativeTime(ts) {
  const stamp = Number(ts);
  if (!Number.isFinite(stamp) || stamp <= 0) return '';
  const zh = isZhLang();
  const now = Date.now();
  const diff = Math.max(0, now - stamp);
  const minutes = Math.floor(diff / 60000);
  const ago = (text) => zh ? (text + tOr('common.ago', '前')) : (text + ' ' + tOr('common.ago', 'ago'));
  if (minutes < 1) return tOr('common.just_now', zh ? '刚刚' : 'just now');
  if (minutes < 60) return ago(minutes + ' ' + i18n.t('common.minutes'));
  const today = beijingDay(now);
  const day = beijingDay(stamp);
  if (day === today) return ago(Math.floor(minutes / 60) + ' ' + i18n.t('common.hours'));
  const dayDiff = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000);
  if (dayDiff === 1) return tOr('common.yesterday', zh ? '昨天' : 'yesterday');
  if (dayDiff > 1 && dayDiff < 7) return ago(dayDiff + ' ' + i18n.t('common.days'));
  const d = new Date(stamp + BJ_OFFSET);
  const month = d.getUTCMonth() + 1;
  const date = d.getUTCDate();
  if (zh) return month + '月' + date + '日';
  return day.slice(5).replace('-', '/');
}
// Three states, in priority order: a live window beats "opened today".
function profileDayState(p) {
  if (!p) return 'idle';
  if (runningProfileIds.has(p.id)) return 'running';
  const last = Number(p.lastOpenedAt);
  if (Number.isFinite(last) && last > 0 && beijingDay(last) === beijingDay()) return 'today';
  return 'idle';
}
function profileDayStateLabel(state) {
  if (state === 'running') return i18n.t('prof.running_now');
  if (state === 'today') return i18n.t('prof.opened_today');
  return i18n.t('prof.not_opened_today');
}
// The three-state light is styled as `.profile-card .pc-dot` in index.html, so the
// same classes outside a profile card would render an invisible span. Menus reuse
// the classes (so the markup keeps one vocabulary) and carry the geometry inline,
// always through the theme variables -- never a fixed hex, or the light would stop
// following the palette.
function dayStateDotStyle(state) {
  // The ring is the menu's own background, so it is invisible on a resting row and
  // becomes the outline that keeps the light readable when :hover floods the row
  // with --main-orange (which is exactly the 'running' fill).
  const base = 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;border:1px solid var(--border-strong);'
    + 'box-shadow:0 0 0 1.5px var(--panel-white-2);background:transparent;';
  if (state === 'running') return base + 'background:var(--main-orange);border-color:var(--main-orange);';
  if (state === 'today') return base + 'background:var(--soft-wheat);border-color:var(--main-orange);';
  return base;
}
// Repaint the lights inside an already-open menu when windows:changed lands, so a
// window that opens or closes behind the menu does not leave a stale light on screen.
function repaintMenuDayStates() {
  const dots = document.querySelectorAll('.menu .pc-dot[data-state-for]');
  for (let i = 0; i < dots.length; i++) {
    const dot = dots[i];
    const id = dot.getAttribute('data-state-for');
    const p = profiles.find(x => x && x.id === id);
    if (!p) continue;
    const state = profileDayState(p);
    if (dot.getAttribute('data-day-state') === state) continue;
    dot.setAttribute('data-day-state', state);
    dot.className = 'pc-dot ' + state;
    dot.style.cssText = dayStateDotStyle(state);
    const row = dot.parentNode;
    if (row && row.classList && row.classList.contains('menu-item')) row.title = profileDayStateLabel(state);
  }
}
// The stored array order is the Cmd+1..9 order; 'recent' only reorders the view.
function profilesForView() {
  if (profileOrderView !== 'recent') return profiles.slice();
  return profiles.slice().sort((a, b) => (Number(b.lastOpenedAt) || 0) - (Number(a.lastOpenedAt) || 0));
}
function refreshRunningProfiles() {
  return ipcRenderer.invoke('windows:list').then((list) => {
    applyWindowList(list);
  }).catch(() => {});
}
function applyWindowList(list) {
  const next = new Set();
  if (Array.isArray(list)) {
    for (const w of list) if (w && w.profileId) next.add(String(w.profileId));
  }
  let changed = next.size !== runningProfileIds.size;
  if (!changed) { for (const id of next) if (!runningProfileIds.has(id)) { changed = true; break; } }
  runningProfileIds = next;
  if (!changed) return;
  repaintMenuDayStates();
  if (currentRoute === 'profiles') renderProfiles();
}
function profileById(id) { return profiles.find(p => p.id === id) || profiles[0] || null; }
function defaultProfile() { return profileById(settings.defaultProfileId) || profiles[0] || null; }
function ensureProfiles() {
  if (!Array.isArray(profiles)) profiles = [];
  const dirty = [];
  if (!profiles.length) {
    profiles = [
      { id: 'main', name: 'Main', color: '#F4A23C', persistent: true, createdAt: Date.now() },
    ];
    dirty.push(profiles[0]);
  }
  for (const p of profiles) {
    if (p.persistent !== true) {
      p.persistent = true;
      if (dirty.indexOf(p) < 0) dirty.push(p);
    }
  }
  if (!settings.defaultProfileId || !profiles.some(p => p.id === settings.defaultProfileId)) {
    settings.defaultProfileId = profiles[0].id;
    saveSettings();
  }
  // Push only the rows we actually changed, one at a time — never the whole table.
  for (const p of dirty) upsertProfile({ id: p.id, name: p.name, color: p.color, persistent: true, createdAt: p.createdAt });
}
function makeProfile(name) {
  const id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const cleanName = String(name || '').trim() || nextProfileName();
  return { id, name: cleanName, color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length], persistent: true, createdAt: Date.now() };
}
function nextProfileName() {
  const base = i18n.t('prof.new_profile') || 'Profile';
  const used = new Set(profiles.map(p => p.name));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = base + ' ' + n;
    if (!used.has(candidate)) return candidate;
  }
  return base + ' ' + Date.now().toString(36).slice(-4);
}

// ---------- i18n ----------
function currentTheme() {
  return THEMES.find(t => t.id === settings.theme) || THEMES[0];
}
function clearCustomThemeStyles() {
  for (const prop of CUSTOM_THEME_STYLE_PROPS) document.documentElement.style.removeProperty(prop);
}
function applyCustomThemeStyles() {
  const theme = customTheme();
  const c = theme.colors;
  const fallbackBadge = assetUrl('badge-wolf-wheat-browser.png');
  const fallbackMascot = assetUrl('mascot-wolf-wheat-tiny-footer.png');
  const root = document.documentElement.style;
  root.setProperty('--cream-bg', c.background);
  root.setProperty('--cream-bg-2', c.backgroundAlt);
  root.setProperty('--panel-white', c.panel);
  root.setProperty('--panel-white-2', c.panelAlt);
  root.setProperty('--soft-wheat', c.soft);
  root.setProperty('--main-orange', c.accent);
  root.setProperty('--deep-orange', c.accentDeep);
  root.setProperty('--warm-brown', c.muted);
  root.setProperty('--dark-brown', c.text);
  root.setProperty('--text-primary', c.text);
  root.setProperty('--text-secondary', c.subtext);
  root.setProperty('--border', rgba(c.muted, 0.20));
  root.setProperty('--border-strong', rgba(c.muted, 0.36));
  root.setProperty('--hover-bg', rgba(c.soft, 0.58));
  root.setProperty('--warning-bg', rgba(c.accent, 0.14));
  root.setProperty('--warning-border', rgba(c.accent, 0.42));
  root.setProperty('--ambient-a', rgba(c.soft, 0.52));
  root.setProperty('--ambient-b', rgba(c.accent, 0.12));
  root.setProperty('--brand-badge-image', cssImage(theme.badgeImage, fallbackBadge));
  root.setProperty('--footer-art-image', cssImage(theme.mascotImage, fallbackMascot));
  root.setProperty('--home-art-image', cssImage(theme.mascotImage, assetUrl('mascot-wolf-wheat-reading.png')));
  root.setProperty('--footer-art-opacity', '0.90');
  root.setProperty('--footer-art-filter', 'saturate(0.92)');
  root.setProperty('--footer-art-blend-mode', 'multiply');
  root.setProperty('--home-art-opacity', '0.10');
  root.setProperty('--home-art-filter', 'saturate(0.82)');
  root.setProperty('--home-art-blend-mode', 'multiply');
  root.setProperty('--doctor-repair-image', cssImage(theme.mascotImage, assetUrl('mascot-wolf-wheat-reading.png')));
  root.setProperty('--doctor-ok-image', cssImage(theme.mascotImage, assetUrl('doctor-wolf-wheat-ok.png')));
  root.setProperty('--doctor-windows-image', cssImage(theme.mascotImage, assetUrl('empty-wolf-wheat-library.png')));
}
function applyTheme() {
  const theme = currentTheme();
  document.documentElement.dataset.theme = theme.id;
  if (theme.id === 'custom') applyCustomThemeStyles();
  else clearCustomThemeStyles();
}
async function setTheme(themeId) {
  if (!THEME_IDS.includes(themeId)) return;
  settings.theme = themeId;
  applyTheme();
  await saveSettings();
  renderThemeGrid();
  renderAppearanceSummary();
  reRenderCurrent();
}
function applyLanguage() {
  i18n.setLang(settings.language || 'zh-CN');
  i18n.applyI18n();
  paintLocalStrings();
  repaintAllTabLabels();
  applyTheme();
  applyIdentity();
  renderGreeting();
  refreshProfileChip();
  updateCounts();
  reRenderCurrent();
  updateAudioButtons();
  updateQuickNoteToggle();
  // 焦点模式的按钮标题是 JS 写的，没有 data-i18n-title，换语言时要主动重绘一次。
  if (window.XZFocus) XZFocus.onProfilesChanged();
  document.dispatchEvent(new CustomEvent('xz:language'));
}
function applyIdentity() {
  const id = settings.identity || {};
  const name = id.name || i18n.t('brand.name');
  const sub = id.sub || i18n.t('brand.sub');
  const bubble = id.bubble || i18n.t('sidebar.bubble');
  const homeSub = id.homeSub || i18n.t('home.subtitle');
  document.querySelectorAll('[data-i18n="brand.name"]').forEach(el => el.textContent = name);
  document.querySelectorAll('[data-i18n="brand.sub"]').forEach(el => el.textContent = sub);
  document.querySelectorAll('[data-i18n="sidebar.bubble"]').forEach(el => el.textContent = bubble);
  document.querySelectorAll('[data-i18n="home.subtitle"]').forEach(el => el.textContent = homeSub);
  document.title = name + ' ' + sub;
}
function reRenderCurrent() {
  if (currentRoute === 'home') renderHome();
  else if (currentRoute === 'favorites') renderFavorites();
  else if (currentRoute === 'recent') renderRecent();
  else if (currentRoute === 'windows') renderWindows();
  else if (currentRoute === 'profiles') renderProfiles();
  else if (currentRoute === 'accounts') renderAccounts();
  else if (currentRoute === 'report') renderReport();
  else if (currentRoute === 'doctor') renderDoctor();
  else if (currentRoute === 'settings') renderSettings();
  else if (currentRoute === 'notes') renderNotes();
  else if (currentRoute === 'tasks') renderTasks();
  else if (currentRoute === 'library') renderLibrary();
  updateCompatUI();
}

// ---------- routing ----------
function setRoute(name) {
  closeAnyMenus();
  // The "recently used" view is a transient lens, not a saved preference.
  if (name !== 'profiles' && currentRoute === 'profiles') {
    profileOrderView = 'manual';
    profileDragId = null;
    profileRenderPending = false;
  }
  currentRoute = name;
  document.querySelectorAll('.route').forEach(el => el.classList.toggle('active', el.id === 'route-' + name));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.route === name));
  $webviews.style.visibility = (name === 'browser') ? 'visible' : 'hidden';
  document.body.classList.toggle('in-browser', name === 'browser');
  updateAccountIndicator();
  if (name === 'browser') {
    const t = activeTab();
    $topUrl.value = t ? t.url : '';
  } else {
    $topUrl.value = '';
  }
  updateNavButtons();
  updateBookmarkStar();
  updateCompatUI();
  refreshProfileChip();
  if (name === 'home') renderHome();
  else if (name === 'favorites') renderFavorites();
  else if (name === 'recent') renderRecent();
  else if (name === 'windows') renderWindows();
  else if (name === 'profiles') renderProfiles();
  else if (name === 'accounts') renderAccounts();
  else if (name === 'report') renderReport();
  else if (name === 'doctor') renderDoctor();
  else if (name === 'settings') renderSettings();
  else if (name === 'notes') renderNotes();
  else if (name === 'tasks') renderTasks();
  else if (name === 'library') renderLibrary();
  if (name === 'browser' && measuring.active) setTimeout(resizeMeasureCanvas, 0);
  document.dispatchEvent(new CustomEvent('xz:route', { detail: name }));
}

document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => setRoute(el.dataset.route));
});
document.querySelectorAll('[data-route-link]').forEach(el => {
  el.addEventListener('click', () => setRoute(el.dataset.routeLink));
});
document.querySelectorAll('[data-open]').forEach(el => {
  el.addEventListener('click', () => openUrl(el.dataset.open));
});

// ---------- sidebar toggle ----------
function setSidebar(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
}
// Glass blur pulls the game's compositing surface into a backdrop root that has
// to be rasterised; on a Retina panel that can soften it. Sharpness wins, so
// this defaults off and the user opts into the look.
function setGlass(on) {
  document.body.classList.toggle('glass-off', !on);
}
$('sidebar-toggle').addEventListener('click', () => {
  const now = !document.body.classList.contains('sidebar-collapsed');
  setSidebar(now);
});
// Game mode collapses the toolbar row entirely, so the tool cluster (speed, zoom,
// game tools, the button that leaves game mode) is re-parented into the tab strip
// first. Without this move those controls would vanish with the row.
function parkToolCluster(inStrip) {
  const zc = $('zc-tools');
  const slot = $('zc-strip-slot');
  const bar = $('topbar');
  if (!zc || !slot || !bar) return;
  if (zc.parentNode === (inStrip ? slot : bar)) return;
  if (inStrip) slot.appendChild(zc);
  // The chip lives in row 1 now, so the cluster simply goes back to the end
  // of the toolbar rather than anchoring against it.
  else bar.appendChild(zc);
}
function setGameMode(on) {
  parkToolCluster(!!on);
  document.body.classList.toggle('game-mode', !!on);
  const btn = $('game-mode-btn');
  if (btn) btn.textContent = on ? '↙' : '⛶';
  if (measuring.active) setTimeout(resizeMeasureCanvas, 0);
}
$('game-mode-btn').addEventListener('click', () => setGameMode(!document.body.classList.contains('game-mode')));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('game-mode')) setGameMode(false);
});

// ---------- usage sessions ----------
// One session per (tab, host). In-site navigation must not churn sessions, or the
// yearly report turns into thousands of one-second rows.
const usageOrder = [];            // tabs with a live session, in begin order
let usageResumeCursor = 0;
let usageResumeAt = 0;
function usageHost(url) {
  try { return new URL(url).hostname || ''; } catch (e) { return ''; }
}
function forgetUsageTab(tab) {
  const i = usageOrder.indexOf(tab);
  if (i >= 0) usageOrder.splice(i, 1);
}
function endTabUsage(tab) {
  if (!tab) return;
  forgetUsageTab(tab);
  const id = tab.usageSessionId;
  tab.usageSessionId = null;
  tab.usageHost = null;
  tab.usagePending = null;
  tab.usageToken = (tab.usageToken || 0) + 1;
  if (id) ipcRenderer.invoke('usage:end', id).catch(() => {});
}
async function syncTabUsage(tab) {
  if (!tab || tabs.indexOf(tab) < 0) return;
  const host = usageHost(tab.url);
  if (!host) return;
  // Same site: keep the session. usagePending covers the window between asking main
  // for an id and getting it back — did-navigate and did-stop-loading both land here
  // for one page load, and a second begin would double every session count.
  if (tab.usageHost === host && (tab.usageSessionId || tab.usagePending)) return;
  const previous = tab.usageSessionId;
  tab.usageSessionId = null;
  tab.usageHost = host;
  const token = (tab.usageToken || 0) + 1;
  tab.usageToken = token;
  tab.usagePending = token;
  forgetUsageTab(tab);
  if (previous) ipcRenderer.invoke('usage:end', previous).catch(() => {});
  let id = null;
  try {
    id = await ipcRenderer.invoke('usage:begin', { profileId: tab.profileId, host });
  } catch (e) {
    if (tab.usagePending === token) tab.usagePending = null;
    return;
  }
  if (tab.usagePending === token) tab.usagePending = null;
  if (!id) return;
  // The tab may have closed or moved on while we awaited: don't leak the session.
  if (tabs.indexOf(tab) < 0 || tab.usageToken !== token) {
    ipcRenderer.invoke('usage:end', id).catch(() => {});
    return;
  }
  tab.usageSessionId = id;
  usageOrder.push(tab);
}
// After a sleep main ends every session and hands back fresh ids on wake, one
// 'usage:resumed' per session in the same order they were begun. Keeping the old
// id would make every later usage:end a no-op.
ipcRenderer.on('usage:resumed', (_e, sessionId) => {
  if (!sessionId) return;
  const now = Date.now();
  if (now - usageResumeAt > 1500) usageResumeCursor = 0; // a new wake burst
  usageResumeAt = now;
  const live = usageOrder.filter(t => tabs.indexOf(t) >= 0);
  const tab = live[usageResumeCursor++];
  if (tab) tab.usageSessionId = sessionId;
  else ipcRenderer.invoke('usage:end', sessionId).catch(() => {});
});

// ---------- window meta / ready handshake ----------
let windowReadySent = false;
let windowMetaTimer = null;
// main's sequential opener blocks on this; without it every window burns the
// full 20 s timeout and four accounts take a minute to appear.
function signalWindowReady() {
  if (windowReadySent) return;
  windowReadySent = true;
  ipcRenderer.invoke('window:ready').catch(() => {});
}
function sendWindowMetaNow() {
  const t = activeTab();
  const meta = {
    title: t ? (t.title || hostOf(t.url) || '') : (document.title || ''),
    url: t ? (t.url || '') : '',
    profileId: windowProfileId || (t && t.profileId) || null,
  };
  if (window.XZSession) meta.session = XZSession.windowState();
  ipcRenderer.invoke('window:set-meta', meta).catch(() => {});
}
function pushWindowMeta() {
  if (windowMetaTimer) return;   // throttle: titles can update several times a second
  windowMetaTimer = setTimeout(() => {
    windowMetaTimer = null;
    sendWindowMetaNow();
  }, 300);
}

// ---------- tab labels ----------
// Tabs read "<profile> | <page title>" so four windows of the same game stay tellable
// apart at a glance. The visible text is clipped by CSS; the title attribute keeps the
// full string for the hover tooltip.
function tabProfile(tab) {
  if (!tab || !tab.profileId) return null;
  return profiles.find(x => x.id === tab.profileId) || null;
}
function tabProfileName(tab) {
  const p = tabProfile(tab);
  return p ? (p.name || '') : '';
}
function tabFullLabel(tab) {
  if (!tab) return '';
  const title = tab.title || hostOf(tab.url) || '';
  const name = tabProfileName(tab);
  return name ? (name + ' \uFF5C ' + title) : title;
}
function paintTabLabel(tab) {
  if (!tab || !tab.stripEl) return;
  const p = tabProfile(tab);
  const name = p ? (p.name || '') : '';
  const profEl = tab.stripEl.querySelector('.t-prof');
  const sepEl = tab.stripEl.querySelector('.t-sep');
  const titleEl = tab.stripEl.querySelector('.t-title');
  const dotEl = tab.stripEl.querySelector('.pdot');
  if (profEl) {
    profEl.textContent = name;
    profEl.style.display = name ? '' : 'none';
    // The account colour is user data, not a theme colour: it has to survive theme swaps.
    profEl.style.color = p && p.color ? p.color : '';
  }
  if (dotEl && p && p.color) dotEl.style.background = p.color;
  tab.stripEl.style.setProperty('--acct', p && isHexColor(p.color) ? p.color : '');
  if (sepEl) sepEl.style.display = name ? '' : 'none';
  if (titleEl) titleEl.textContent = tab.title || hostOf(tab.url) || '';
  tab.stripEl.title = tabFullLabel(tab);
}
function repaintAllTabLabels() { for (const t of tabs) paintTabLabel(t); }
// The strip is always mounted now, so it needs its own empty state.
function updateTabStripState() {
  document.body.classList.toggle('no-tabs', tabs.length === 0);
}

// ---------- tab lifecycle ----------
// ---------- new-window de-duplication ----------
// One link click reaches this renderer twice: the <webview> element fires its own
// 'new-window' DOM event, and main.js's guest listener preventDefault()s the same event
// and forwards it as action:'new-tab'. Exactly one of the two may open a tab.
// Each path leaves a ticket that only the *other* path consumes, so the order the two
// messages arrive in does not matter, and two fast clicks on the same link still open
// two tabs (each click leaves its own ticket). A path never eats its own tickets, so a
// build where only one path fires keeps working; unpaired tickets simply expire.
const NEW_WINDOW_TICKET_MS = 5000;
const NEW_WINDOW_GRACE_MS = 150;   // how long the action path waits for the webview one
const newWindowTickets = { link: [], action: [] };
function claimNewWindow(from, url) {
  const now = Date.now();
  const mine = newWindowTickets[from === 'link' ? 'link' : 'action'];
  const other = newWindowTickets[from === 'link' ? 'action' : 'link'];
  for (const list of [mine, other]) {
    while (list.length && now - list[0].at > NEW_WINDOW_TICKET_MS) list.shift();
  }
  const i = other.findIndex(t => t.url === url);
  if (i >= 0) { other.splice(i, 1); return false; }   // the other path already opened it
  mine.push({ url: url, at: now });
  return true;
}

// Where a new tab's account comes from, highest priority first:
//   1. an explicit profileId from the caller ("new tab in <account>")
//   2. opts.sourceTab — the tab the link was clicked in. A link inside account A's game
//      must stay on A, so this deliberately outranks the site rules.
//   3. a site rule, and only for cold starts (address bar, bookmark, home, plain ⌘T)
//   4. opts.fallbackProfileId — the tab the user was last looking at — then the window's
//      own account.
// Second argument stays back-compatible with the old createTab(url, profileId) callers.
function resolveTabProfile(url, opts) {
  const o = (typeof opts === 'string') ? { profileId: opts } : (opts || {});
  // Exact lookup only: profileById() falls back to profiles[0], which would silently
  // open the tab on the wrong account if the requested id no longer exists.
  const exact = (id) => (id ? profiles.find(p => p.id === id) : null) || null;
  const explicit = exact(o.profileId);
  if (explicit) return { profile: explicit, reason: 'explicit' };
  if (o.sourceTab) {
    const inherited = exact(o.sourceTab.profileId);
    if (inherited) return { profile: inherited, reason: 'inherit' };
  } else {
    const ruled = profileForUrl(url);
    if (ruled) return { profile: ruled, reason: 'rule' };
  }
  const fallback = exact(o.fallbackProfileId);
  if (fallback) return { profile: fallback, reason: 'fallback' };
  return { profile: exact(windowProfileId) || defaultProfile(), reason: 'window' };
}
// Tabs default to the window's profile, but an explicit profileId opens the tab on a
// different account: the partition is set per-<webview>, so one window can hold several.
// A tab's profile is fixed at creation — switching it later would cross the sessions.
function createTab(url, opts) {
  const id = nextId++;
  const picked = resolveTabProfile(url || homeUrl, opts);
  const profile = picked.profile;
  const tab = {
    id, title: 'Loading…', url: url || homeUrl,
    loading: false, zoom: 1, fit: false,
    ready: false,
    muted: false,
    compat: null,
    compatDismissed: false,
    profileId: profile ? profile.id : null,
    currentHost: null,
    usageSessionId: null,
    usageHost: null,
    usagePending: null,
    usageToken: 0,
  };
  tabs.push(tab);
  // Count "opened this account" once per profile per window, not per navigation.
  if (tab.profileId && !touchedProfileIds.has(tab.profileId)) {
    touchedProfileIds.add(tab.profileId);
    touchProfile(tab.profileId).then(() => {
      refreshProfileChip();
      if (currentRoute === 'profiles') renderProfiles();
    });
  }

  const stripEl = document.createElement('div');
  stripEl.className = 'tab';
  stripEl.dataset.id = id;
  stripEl.innerHTML =
    '<span class="spinner"></span>' +
    '<span class="pdot" style="background:' + (profile ? profile.color : '#888') + '"></span>' +
    '<span class="t-prof"></span>' +
    '<span class="t-sep">\uFF5C</span>' +
    '<span class="t-title">Loading…</span>' +
    '<span class="detach" title="Move to new window">⧉</span>' +
    '<span class="close" title="Close">✕</span>';
  stripEl.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('close') || e.target.classList.contains('detach')) return;
    if (e.button === 1) { closeTab(id); return; }
    // activateTab() switches the route itself — that round trip through Home was
    // the whole complaint.
    activateTab(id);
  });
  stripEl.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  stripEl.querySelector('.detach').addEventListener('click', (e) => { e.stopPropagation(); detachTab(id); });
  $tabList.appendChild(stripEl);
  tab.stripEl = stripEl;
  paintTabLabel(tab);
  updateTabStripState();

  const wv = document.createElement('webview');
  wv.setAttribute('plugins', '');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'plugins=yes,contextIsolation=no,backgroundThrottling=no');
  wv.setAttribute('preload', preloadPath);
  if (profile) {
    const part = 'persist:ddt-' + profile.id;
    wv.setAttribute('partition', part);
  }
  wv.setAttribute('src', tab.url);
  $webviews.appendChild(wv);
  tab.webview = wv;
  applyAudioMute(tab);
  wv.addEventListener('focus', closeAnyMenus);

  // A link in the page asks for a new window. main.js forwards the same click as
  // action:'new-tab', but only this listener knows which tab it came from — this is the
  // path that carries the account across, so it hands createTab() the source tab.
  wv.addEventListener('new-window', (e) => {
    const target = e && e.url;
    if (!target) return;
    if (!claimNewWindow('link', target)) return;
    createTab(target, { sourceTab: tab });
  });

  const applyZoom = () => {
    try {
      if (tab.fit) {
        const w = wv.offsetWidth || wv.getBoundingClientRect().width || window.innerWidth;
        tab.zoom = Math.max(0.4, Math.min(3, w / 960));
        if (window.XZScale) tab.zoom = XZScale.quantize(tab, tab.zoom, 0);
      }
      wv.setZoomFactor(tab.zoom);
      if (id === activeId) updateZoomIndicator();
    } catch (e) {}
  };
  tab._applyZoom = applyZoom;

  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    tab.compat = null;
    tab.compatDismissed = false;
    stripEl.classList.add('loading');
    if (id === activeId) {
      updateNavButtons();
      updateCompatUI();
    }
  });
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    stripEl.classList.remove('loading');
    if (id === activeId) updateNavButtons();
    signalWindowReady();     // the game webview is up: release main's open queue
    syncTabUsage(tab);
    pushWindowMeta();
  });
  wv.addEventListener('dom-ready', () => {
    tab.ready = true;
    applyZoom();
    if (id === activeId) updateNavButtons();
  });
  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || hostOf(tab.url);
    paintTabLabel(tab);
    if (currentRoute === 'windows') renderWindows();
    if (id === activeId) pushWindowMeta();
  });
  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    if (id === activeId) $topUrl.value = e.url;
    paintTabLabel(tab);   // keeps the hover tooltip in step when only the host changed
    recordHistory(tab);
    updateNavButtons();
    updateBookmarkStar();
    if (currentRoute === 'windows') renderWindows();
    syncTabUsage(tab);   // no-op unless the host actually changed
    if (id === activeId) pushWindowMeta();
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    if (id === activeId) $topUrl.value = e.url;
    recordHistory(tab);
    updateNavButtons();
    updateBookmarkStar();
    if (id === activeId) pushWindowMeta();
  });
  // Password autofill + save pipeline (via webview preload IPC).
  wv.addEventListener('ipc-message', (e) => {
    try {
      const payload = (e.args && e.args[0]) || {};
      if (e.channel === 'compat:detected') {
        tab.compat = normalizeCompatIssue(payload, tab);
        tab.compatDismissed = false;
        if (id === activeId) updateCompatUI();
      } else if (e.channel === 'pw:request') {
        const host = payload.host || '';
        tab.currentHost = host;
        const matches = findAllCredentials(tab.profileId, host);
        if (id === activeId) updateAccountIndicator();
        if (matches.length === 1) {
          const top = matches[0];
          wv.send('pw:fill', { username: top.username, password: top.password });
        } else if (matches.length > 1 && id === activeId) {
          showAccountPicker(tab, host, matches);
        }
        if (window.XZAutoLogin) XZAutoLogin.onLoginForm(tab, host, matches);
      } else if (e.channel === 'pw:submit') {
        const host = payload.host || tab.currentHost || hostOf(tab.url);
        const username = payload.username || '';
        const password = payload.password || '';
        if (!password || isSkipped(tab.profileId, host)) return;
        const existing = passwords.find(p =>
          p.profileId === tab.profileId &&
          hostMatches(p.host, host) &&
          (p.username || '') === username
        );
        if (existing && existing.password === password) return;
        showSavePrompt({ host, username, password, profileId: tab.profileId });
      } else if (e.channel === 'pw:capture-result') {
        if (!payload.found || !payload.password) {
          alert(i18n.t('pw.capture_empty'));
          return;
        }
        showSavePrompt({
          host: payload.host || tab.currentHost || hostOf(tab.url),
          username: payload.username || '',
          password: payload.password,
          profileId: tab.profileId,
        });
      }
    } catch (err) {}
  });

  // Give the new webview its slot geometry before it is shown, or it flashes full-screen for a frame.
  document.dispatchEvent(new CustomEvent('xz:tab-created', { detail: tab }));
  if (window.XZFocus) XZFocus.onTabCreated(tab);
  activateTab(id);
  setRoute('browser');
  // A rule quietly switched accounts on the user; say so, or the chip changing name
  // looks like a bug.
  if (picked.reason === 'rule' && profile) {
    showToast(tOr('sites.opened_with', '\u5df2\u7528 {name} \u8d26\u53f7\u6253\u5f00').replace('{name}', profile.name || ''));
  }
  return tab;
}

function activateTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  activeId = id;
  tabs.forEach(t => {
    t.stripEl.classList.toggle('active', t.id === id);
    t.webview.classList.toggle('active', t.id === id);
  });
  // The strip is global: picking a tab from Profiles/Settings/Notes has to land on the
  // page itself. activeId is set first so setRoute() reads the right tab for the URL bar.
  if (currentRoute !== 'browser') setRoute('browser');
  if (currentRoute === 'browser') $topUrl.value = tab.url;
  updateNavButtons();
  updateBookmarkStar();
  updateZoomIndicator();
  refreshProfileChip();
  updateAccountIndicator();
  updateAudioButtons();
  updateCompatUI();
  pushWindowMeta();
  if (window.XZFocus) XZFocus.onActivated(tab);
  document.dispatchEvent(new CustomEvent('xz:activated', { detail: tab }));
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  tab.stripEl.remove();
  tab.webview.remove();
  tabs.splice(idx, 1);
  endTabUsage(tab);
  updateTabStripState();
  if (window.XZFocus) XZFocus.onTabClosed(tab);
  document.dispatchEvent(new CustomEvent('xz:tab-closed', { detail: tab }));
  if (tabs.length === 0) {
    activeId = null;
    updateAudioButtons();
    updateCompatUI();
    setRoute('home');
    pushWindowMeta();
    return;
  }
  if (activeId === id) activateTab((window.XZFocus && XZFocus.pickAfterClose(idx)) || tabs[Math.min(idx, tabs.length - 1)].id);
  else pushWindowMeta();
  if (currentRoute === 'windows') renderWindows();
}

async function detachTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  await ipcRenderer.invoke('window:open', tab.url, tab.profileId);
  closeTab(id);
}

function activeTab() { return tabs.find(t => t.id === activeId); }

// Reorder a tab inside this window. The strip DOM and `tabs` must stay in the
// same order: Cmd+Alt+Arrow walks the array.
function moveTab(id, toIndex) {
  const from = tabs.findIndex(t => t.id === id);
  if (from < 0) return;
  const [t] = tabs.splice(from, 1);
  const to = Math.max(0, Math.min(tabs.length, toIndex));
  tabs.splice(to, 0, t);
  const next = tabs[to + 1];
  $tabList.insertBefore(t.stripEl, next ? next.stripEl : null);
  pushWindowMeta();              // 顺序变了，主进程那边的窗口元数据要跟上
  if (window.XZFocus) XZFocus.onTabsChanged();
  document.dispatchEvent(new CustomEvent('xz:tabs-changed'));
}

function openUrl(url, opts) {
  const t = activeTab();
  if (currentRoute === 'browser' && t) {
    // Same webview, same partition: navigating here cannot change the account.
    t.webview.loadURL(url);
  } else {
    // A cold start: site rules get to decide, and when no rule claims the host the tab
    // follows whichever tab the user was last looking at instead of snapping back to
    // the window's own account.
    const o = (typeof opts === 'string') ? { profileId: opts } : (opts || {});
    createTab(url, Object.assign({ fallbackProfileId: t ? t.profileId : null }, o));
  }
}

// ---------- top bar ----------
function updateNavButtons() {
  const t = activeTab();
  let canBack = false;
  let canFwd = false;
  if (t && t.ready && currentRoute === 'browser') {
    try { canBack = !!(t.webview.canGoBack && t.webview.canGoBack()); } catch (e) {}
    try { canFwd = !!(t.webview.canGoForward && t.webview.canGoForward()); } catch (e) {}
  }
  $back.classList.toggle('disabled', !canBack);
  $forward.classList.toggle('disabled', !canFwd);
}
function updateBookmarkStar() {
  const t = activeTab();
  const url = (currentRoute === 'browser' && t) ? t.url : null;
  const item = url ? bookmarks.find(b => b.url === url) : null;
  const isFav = item && item.favorite !== false;
  $bmStar.textContent = isFav ? '❤' : '♡';
  $bmStar.classList.toggle('active', !!isFav);
}
function updateZoomIndicator() {
  const t = activeTab();
  if (!t || !$zoomInd) return;
  const pct = Math.round((t.zoom || 1) * 100);
  $zoomInd.textContent = t.fit ? ('⤢ ' + pct + '%') : (pct + '% ▾');
  $zoomInd.title = t.fit ? i18n.t('zoom.auto') : '';
  if (window.XZScale) XZScale.paintIndicator(t, $zoomInd);
}

function speedProfileCode() {
  const profile = SPEED_PROFILE_BY_KEY[settings.speedProfile] || SPEED_PROFILES[0];
  return profile.code;
}

function effectiveMuted(tab) {
  if (window.XZFocus && XZFocus.forcesMute(tab)) return true;
  return !!settings.globalMuted || !!(tab && tab.muted);
}
function applyAudioMute(tab) {
  const targetTabs = tab ? [tab] : tabs;
  for (const t of targetTabs) {
    try {
      if (t.webview && typeof t.webview.setAudioMuted === 'function') t.webview.setAudioMuted(effectiveMuted(t));
    } catch (e) {}
  }
  updateAudioButtons();
}
function updateAudioButtons() {
  for (const t of tabs) {
    if (t.stripEl) t.stripEl.classList.toggle('muted', effectiveMuted(t));
  }
  updateGameToolsButton();
}
async function setGlobalMuted(muted, broadcast = true) {
  settings.globalMuted = !!muted;
  await saveSettings();
  applyAudioMute();
  if (broadcast) ipcRenderer.invoke('audio:set-global-muted', settings.globalMuted).catch(() => {});
}
function setTabMuted(tab, muted) {
  if (!tab) return;
  tab.muted = !!muted;
  applyAudioMute(tab);
}
function html5FallbackUrl(url) {
  try {
    const u = new URL(url || '');
    const match = u.hostname.endsWith('4399.com') && u.pathname.match(/^\/flash\/(\d+)(?:_\d+)?\.htm$/i);
    if (match) return 'https://www.4399.com/html5/' + match[1] + '.htm';
  } catch (e) {}
  return null;
}
function normalizeCompatIssue(payload, tab) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const url = raw.url || (tab && tab.url) || '';
  return {
    kind: raw.kind || 'legacy-plugin',
    url,
    title: raw.title || (tab && tab.title) || '',
    host: raw.host || hostOf(url),
    html5Url: raw.html5Url || html5FallbackUrl(url),
  };
}
function activeCompatIssue() {
  const tab = activeTab();
  return tab && tab.compat ? tab.compat : null;
}
function updateCompatUI() {
  const tab = activeTab();
  const issue = tab && tab.compat ? tab.compat : null;
  const indicator = $('compat-indicator');
  if (indicator) {
    indicator.classList.toggle('on', !!issue);
    indicator.textContent = issue ? i18n.t('compat.indicator') : '';
    indicator.title = issue ? i18n.t('compat.indicator_tip') : i18n.t('compat.indicator_empty');
  }
  const banner = $('compat-banner');
  if (!banner) return;
  const visible = !!issue && currentRoute === 'browser' && !(tab && tab.compatDismissed);
  banner.classList.toggle('visible', visible);
  if (!issue) return;
  const title = $('compat-title');
  const body = $('compat-body');
  if (title) title.textContent = i18n.t(issue.kind === 'unity-web-player' ? 'compat.unity_title' : 'compat.legacy_title');
  if (body) body.textContent = i18n.t(issue.kind === 'unity-web-player' ? 'compat.unity_body' : 'compat.legacy_body');
  const h5 = $('compat-open-h5');
  if (h5) h5.hidden = !issue.html5Url;
}
function showCompatBanner() {
  const tab = activeTab();
  if (!tab || !tab.compat) return;
  tab.compatDismissed = false;
  updateCompatUI();
}
function dismissCompatBanner() {
  const tab = activeTab();
  if (!tab) return;
  tab.compatDismissed = true;
  updateCompatUI();
}
function openCompatHtml5() {
  const issue = activeCompatIssue();
  if (!issue || !issue.html5Url) return;
  openUrl(issue.html5Url);
}
function openCompatExternal() {
  const tab = activeTab();
  const target = (tab && tab.url) || (activeCompatIssue() && activeCompatIssue().url);
  if (target) ipcRenderer.invoke('external:open', target);
}
function openFlashpoint() {
  ipcRenderer.invoke('external:open', FLASHPOINT_URL);
}
function measureCanvas() { return $('measure-canvas'); }
function measureOverlay() { return $('measure-overlay'); }
function measurePointFromEvent(ev) {
  const canvas = measureCanvas();
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, ev.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, ev.clientY - rect.top)),
  };
}
function resizeMeasureCanvas() {
  const canvas = measureCanvas();
  const overlay = measureOverlay();
  if (!canvas || !overlay) return;
  const rect = overlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  drawMeasureOverlay();
}
function setMeasureActive(active, mode) {
  const overlay = measureOverlay();
  if (!overlay) return;
  measuring.active = !!active;
  if (mode) measuring.mode = mode;
  overlay.classList.toggle('visible', measuring.active);
  updateGameToolsButton();
  if (measuring.active) {
    setRoute('browser');
    resizeMeasureCanvas();
  }
  updateMeasureReadout();
}
function toggleMeasureOverlay() {
  const tab = activeTab();
  if (!tab && !measuring.active) return;
  setMeasureActive(!measuring.active, 'measure');
}
function startScaleCalibration() {
  measuring.scaleStart = null;
  measuring.scaleEnd = null;
  setMeasureActive(true, 'scale');
}
function resetMeasurePoints() {
  measuring.origin = null;
  measuring.target = null;
  measuring.hover = null;
  drawMeasureOverlay();
  updateMeasureReadout();
}
async function clearMeasureScale() {
  settings.measure = normalizeMeasureSettings(settings.measure);
  settings.measure.scalePixelsPer10 = null;
  await saveSettings();
  if (currentRoute === 'settings') renderSpeedToolSettings();
  drawMeasureOverlay();
  updateMeasureReadout();
}
function setMeasureTarget(point) {
  if (!measuring.origin) {
    measuring.origin = point;
    measuring.target = null;
  } else {
    measuring.target = point;
  }
  drawMeasureOverlay();
  updateMeasureReadout();
}
async function handleMeasureClick(ev) {
  if (!measuring.active) return;
  if (ev.target && ev.target.closest && ev.target.closest('#measure-panel')) return;
  const point = measurePointFromEvent(ev);
  if (measuring.mode === 'scale') {
    if (!measuring.scaleStart) {
      measuring.scaleStart = point;
    } else {
      measuring.scaleEnd = point;
      const dx = Math.abs(measuring.scaleEnd.x - measuring.scaleStart.x);
      const direct = Math.hypot(measuring.scaleEnd.x - measuring.scaleStart.x, measuring.scaleEnd.y - measuring.scaleStart.y);
      settings.measure = normalizeMeasureSettings(settings.measure);
      settings.measure.scalePixelsPer10 = dx > 2 ? dx : direct;
      await saveSettings();
      measuring.mode = 'measure';
      if (currentRoute === 'settings') renderSpeedToolSettings();
    }
    drawMeasureOverlay();
    updateMeasureReadout();
    return;
  }
  setMeasureTarget(point);
}
function handleMeasureMove(ev) {
  if (!measuring.active) return;
  if (ev.target && ev.target.closest && ev.target.closest('#measure-panel')) return;
  measuring.hover = measurePointFromEvent(ev);
  drawMeasureOverlay();
}
function measureResult() {
  const origin = measuring.origin;
  const target = measuring.target || (measuring.active && measuring.hover && measuring.origin ? measuring.hover : null);
  if (!origin || !target) return null;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
  const scale = normalizeMeasureSettings(settings.measure).scalePixelsPer10;
  const directPx = Math.hypot(dx, dy);
  return {
    angle,
    dx,
    dy,
    directPx,
    scale,
    horizontalUnits: scale ? Math.abs(dx) / scale * 10 : null,
    directUnits: scale ? directPx / scale * 10 : null,
  };
}
function updateMeasureReadout() {
  const modeEl = $('measure-mode');
  const readout = $('measure-readout');
  const scaleEl = $('measure-scale');
  if (!readout || !scaleEl || !modeEl) return;
  modeEl.textContent = measuring.mode === 'scale' ? i18n.t('measure.mode_scale') : i18n.t('measure.mode_measure');
  const scale = normalizeMeasureSettings(settings.measure).scalePixelsPer10;
  scaleEl.textContent = scale
    ? i18n.t('measure.scale_value').replace('{px}', Math.round(scale))
    : i18n.t('measure.scale_empty');
  if (measuring.mode === 'scale') {
    readout.textContent = measuring.scaleStart ? i18n.t('measure.scale_wait_end') : i18n.t('measure.scale_wait_start');
    return;
  }
  const result = measureResult();
  if (!measuring.origin) {
    readout.textContent = i18n.t('measure.wait_origin');
  } else if (!result || !measuring.target) {
    readout.textContent = i18n.t('measure.wait_target');
  } else {
    const angle = Math.round(result.angle * 10) / 10;
    if (result.scale) {
      readout.textContent = i18n.t('measure.result_scaled')
        .replace('{angle}', angle)
        .replace('{horizontal}', Math.round(result.horizontalUnits * 10) / 10)
        .replace('{direct}', Math.round(result.directUnits * 10) / 10);
    } else {
      readout.textContent = i18n.t('measure.result_angle').replace('{angle}', angle);
    }
  }
}
function drawMeasurePoint(ctx, p, color, label) {
  if (!p) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (label) {
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fillText(label, p.x + 9, p.y - 9);
  }
  ctx.restore();
}
function drawMeasureOverlay() {
  const canvas = measureCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!measuring.active) {
    ctx.restore();
    return;
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const origin = measuring.origin;
  const target = measuring.target || (origin ? measuring.hover : null);
  if (origin) {
    ctx.strokeStyle = 'rgba(255, 232, 168, .90)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, origin.y);
    ctx.lineTo(w, origin.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (origin && target) {
    ctx.strokeStyle = 'rgba(77, 157, 186, .95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(target.x, origin.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (measuring.mode === 'scale') {
    const end = measuring.scaleEnd || measuring.hover;
    if (measuring.scaleStart && end) {
      ctx.strokeStyle = 'rgba(111, 149, 100, .95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(measuring.scaleStart.x, measuring.scaleStart.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      drawMeasurePoint(ctx, measuring.scaleStart, 'rgba(111,149,100,.95)', '10');
      drawMeasurePoint(ctx, end, 'rgba(111,149,100,.95)', '');
    }
  }
  drawMeasurePoint(ctx, origin, 'rgba(255, 232, 168, .98)', 'O');
  drawMeasurePoint(ctx, measuring.target, 'rgba(77, 157, 186, .98)', 'T');
  ctx.restore();
}
function updateGameToolsButton() {
  const btn = $('game-tools-btn');
  if (!btn) return;
  const custom = settings.showQuickNote === false || !!settings.globalMuted || measuring.active || !!(activeTab() && activeTab().muted);
  btn.classList.toggle('on', custom);
  btn.textContent = i18n.t('tools.toolbar');
  btn.title = i18n.t('tools.game');
}
function menuState(on) {
  return on ? i18n.t('tools.on') : i18n.t('tools.off');
}
function addToolToggle(menu, labelKey, on, onClick, enabled = true) {
  const item = document.createElement('div');
  item.className = 'menu-item' + (on ? ' check' : '') + (enabled ? '' : ' disabled');
  item.innerHTML = '<span>' + escapeHtml(i18n.t(labelKey)) + '</span><span class="state">' + escapeHtml(menuState(on)) + '</span>';
  if (enabled) {
    item.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await onClick();
      closeAnyMenus();
    });
  }
  menu.appendChild(item);
}
function addToolAction(menu, labelKey, onClick, enabled = true) {
  const item = document.createElement('div');
  item.className = 'menu-item' + (enabled ? '' : ' disabled');
  item.innerHTML = '<span>' + escapeHtml(i18n.t(labelKey)) + '</span>';
  if (enabled) {
    item.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      closeAnyMenus();
      await onClick();
    });
  }
  menu.appendChild(item);
}
function addToolDivider(menu) {
  const div = document.createElement('div');
  div.style.cssText = 'border-top: 1px solid var(--border); margin: 4px 6px;';
  menu.appendChild(div);
}
function captureWebview(tab) {
  return new Promise((resolve, reject) => {
    if (!tab || !tab.webview || typeof tab.webview.capturePage !== 'function') {
      reject(new Error('No active webview'));
      return;
    }
    try {
      const maybe = tab.webview.capturePage();
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(resolve, reject);
        return;
      }
    } catch (e) {
      try {
        tab.webview.capturePage((image) => image ? resolve(image) : reject(new Error('Empty capture')));
        return;
      } catch (err) {
        reject(err);
        return;
      }
    }
    try {
      tab.webview.capturePage((image) => image ? resolve(image) : reject(new Error('Empty capture')));
    } catch (err) {
      reject(err);
    }
  });
}
// Announced with a toast, never a modal: a dialog steals focus from the Flash
// plugin, and the game suspends itself the moment focus leaves it. The whole
// point of the shortcut is to grab a frame mid-battle without touching anything.
async function screenshotCurrentGame() {
  const tab = activeTab();
  if (!tab) return;
  try {
    const image = await captureWebview(tab);
    const saved = await ipcRenderer.invoke('screenshot:save', image.toPNG(), tab.title || hostOf(tab.url));
    if (saved && saved.path) showToast(tOr('tools.screenshot_toast', '截图已保存到桌面'));
    else showToast(tOr('tools.screenshot_failed', '截图失败'));
  } catch (e) {
    showToast(tOr('tools.screenshot_failed', '截图失败'));
  }
}
function openUrlInProfiles(url, grid, profileIds) {
  const ids = (profileIds && profileIds.length ? profileIds : profiles.map(p => p.id));
  if (grid) {
    ipcRenderer.invoke('window:open-accounts-grid', ids.map(profileId => ({ url, profileId })));
  } else {
    ipcRenderer.invoke('window:open-many', url, ids);
  }
}
function selectedProfileOpenIds() {
  return Array.from(document.querySelectorAll('#profile-open-list input[data-profile-id]:checked'))
    .map(input => input.dataset.profileId)
    .filter(id => profiles.some(p => p.id === id));
}
function updateProfileOpenCount() {
  const countEl = $('profile-open-count');
  if (!countEl) return;
  countEl.textContent = i18n.t('profile_open.count')
    .replace('{selected}', selectedProfileOpenIds().length)
    .replace('{total}', profiles.length);
}
function setProfileOpenChecks(checked) {
  document.querySelectorAll('#profile-open-list input[data-profile-id]').forEach(input => {
    input.checked = !!checked;
  });
  updateProfileOpenCount();
}
function showProfileOpenModal() {
  ensureProfiles();
  const tab = activeTab();
  profileOpenUrl = tab ? tab.url : homeUrl;
  $('profile-open-url').textContent = profileOpenUrl;
  const savedIds = Array.isArray(settings.multiOpenProfileIds)
    ? settings.multiOpenProfileIds.filter(id => profiles.some(p => p.id === id))
    : [];
  const selectedIds = savedIds.length ? savedIds : profiles.map(p => p.id);
  const list = $('profile-open-list');
  list.innerHTML = '';
  for (const p of profiles) {
    const row = document.createElement('label');
    row.className = 'profile-open-row';
    const current = p.id === windowProfileId ? i18n.t('profile_open.current') : '';
    row.innerHTML =
      '<input type="checkbox" data-profile-id="' + escapeHtml(p.id) + '"' + (selectedIds.includes(p.id) ? ' checked' : '') + ' />' +
      '<span class="profile-open-swatch" style="background:' + escapeHtml(p.color || '#888') + '"></span>' +
      '<span class="profile-open-main">' +
        '<span class="profile-open-name">' + escapeHtml(p.name || p.id) + '</span>' +
        '<span class="profile-open-meta">' + escapeHtml(current) + '</span>' +
      '</span>';
    row.querySelector('input').addEventListener('change', updateProfileOpenCount);
    list.appendChild(row);
  }
  updateProfileOpenCount();
  $('profile-open-modal').classList.add('visible');
}
function hideProfileOpenModal() {
  $('profile-open-modal').classList.remove('visible');
}
async function runProfileOpen(grid) {
  const ids = selectedProfileOpenIds();
  if (!ids.length) {
    alert(i18n.t('profile_open.empty'));
    return;
  }
  settings.multiOpenProfileIds = ids;
  await saveSettings();
  const url = profileOpenUrl || (activeTab() ? activeTab().url : homeUrl);
  hideProfileOpenModal();
  openUrlInProfiles(url, grid, ids);
}
function showGameToolsMenu(anchor) {
  closeAnyMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu game-tools-menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = Math.max(8, rect.right - 230) + 'px';
  const tab = activeTab();
  addToolAction(menu, 'tools.repair_page', resetDoctorTab, !!tab);
  addToolAction(menu, 'tools.screenshot', screenshotCurrentGame, !!tab);
  addToolAction(menu, 'tools.multi_open', showProfileOpenModal, !!tab);
  addToolAction(menu, 'scatter.menu', scatterTabsAndTile, tabs.length > 1);
  if (window.XZFocus) addToolToggle(menu, 'tools.focus_mode', XZFocus.isActive(), () => XZFocus.toggle(), tabs.length > 0);
  if (window.XZPalette) addToolAction(menu, 'tools.palette', () => XZPalette.open());
  if (window.XZStatus) addToolToggle(menu, 'tools.status_bar', XZStatus.isVisible(), () => XZStatus.toggle());
  if (window.XZCleanup) XZCleanup.addMenuItem(menu, tab, addToolAction);
  addToolToggle(menu, 'tools.measure_overlay', measuring.active, toggleMeasureOverlay, !!tab);
  addToolAction(menu, 'tools.measure_scale', startScaleCalibration, !!tab);
  addToolToggle(menu, 'tools.aim_assist',
    !!(window.AimAssist && window.AimAssist.isVisible()),
    () => { if (window.AimAssist) window.AimAssist.toggle(); }, !!tab);
  addToolDivider(menu);
  addToolToggle(menu, 'tools.quick_note', settings.showQuickNote !== false, () => setQuickNoteVisible(settings.showQuickNote === false));
  addToolToggle(menu, 'tools.global_mute', !!settings.globalMuted, () => setGlobalMuted(!settings.globalMuted));
  addToolToggle(menu, 'tools.tab_mute', !!(tab && tab.muted), () => setTabMuted(tab, !tab.muted), !!tab);
  document.body.appendChild(menu);
  armMenuClose();
}
// Clicking the zoom indicator opens a dropdown with preset values + custom + fit.
$('zoom-indicator').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const t = activeTab();
  if (!t) return;
  closeAnyMenus();
  const rect = ev.currentTarget.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = (rect.right - 160) + 'px';
  menu.style.minWidth = '150px';
  const presets = [50, 75, 90, 100, 110, 125, 150, 200];
  for (const p of presets) {
    const item = document.createElement('div');
    const isCurrent = !t.fit && Math.abs((t.zoom || 1) * 100 - p) < 0.5;
    item.className = 'menu-item' + (isCurrent ? ' check' : '');
    item.textContent = p + '%';
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      t.fit = false;
      t.zoom = p / 100;
      if (window.XZScale) XZScale.setOn(t, false, true);
      try { t.webview.setZoomFactor(t.zoom); } catch (e) {}
      updateZoomIndicator();
      closeAnyMenus();
    });
    menu.appendChild(item);
  }
  // Divider
  const div = document.createElement('div');
  div.style.cssText = 'border-top: 1px solid var(--border); margin: 4px 6px;';
  menu.appendChild(div);
  // Fit
  const fitItem = document.createElement('div');
  fitItem.className = 'menu-item' + (t.fit ? ' check' : '');
  fitItem.textContent = i18n.t('zoom.fit');
  fitItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    t.fit = true;
    t._applyZoom();
    closeAnyMenus();
  });
  menu.appendChild(fitItem);
  if (window.XZScale) XZScale.addMenuItem(menu, t);
  // Custom
  const customItem = document.createElement('div');
  customItem.className = 'menu-item';
  customItem.textContent = i18n.t('zoom.custom');
  customItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const cur = Math.round((t.zoom || 1) * 100);
    const inp = prompt(i18n.t('zoom.custom_prompt'), String(cur));
    closeAnyMenus();
    if (inp == null) return;
    const n = parseFloat(inp);
    if (isNaN(n) || n < 25 || n > 500) return;
    t.fit = false;
    t.zoom = n / 100;
    if (window.XZScale) XZScale.setOn(t, false, true);
    try { t.webview.setZoomFactor(t.zoom); } catch (e) {}
    updateZoomIndicator();
  });
  menu.appendChild(customItem);
  document.body.appendChild(menu);
  armMenuClose();
});
function refreshProfileChip() {
  // A window can now hold tabs from several accounts, so on the browser view the chip
  // follows the tab you are looking at; elsewhere it shows the window's own account.
  const t = currentRoute === 'browser' ? activeTab() : null;
  const p = (t && profiles.find(x => x.id === t.profileId)) || profileById(windowProfileId) || defaultProfile();
  if (!p) return;
  const chip = $('profile-chip');
  chip.querySelector('.dot').style.background = p.color;
  $('profile-chip-name').textContent = p.name;
  // A tab running someone else's account is exactly what the user needs to be sure of,
  // so the chip is marked: without it the name silently changes and looks like a bug.
  const guest = !!(windowProfileId && p.id !== windowProfileId);
  chip.classList.toggle('guest', guest);
  const badge = $('profile-chip-guest');
  if (badge) {
    badge.textContent = guest ? tOr('sites.guest_badge', '\u5ba2\u4eba') : '';
    badge.style.display = guest ? '' : 'none';
  }
  chip.title = guest
    ? tOr('sites.guest_tip', '\u8fd9\u4e2a\u6807\u7b7e\u7528\u7684\u662f\u522b\u7684\u8d26\u53f7\uff0c\u4e0d\u662f\u672c\u7a97\u53e3\u7684\u9ed8\u8ba4\u8d26\u53f7')
    : (i18n.t('topbar.profile_tip') || '');
}

$back.addEventListener('click', () => {
  const t = activeTab();
  if (!t || !t.ready) return;
  try { if (t.webview.canGoBack()) t.webview.goBack(); } catch (e) {}
});
$forward.addEventListener('click', () => {
  const t = activeTab();
  if (!t || !t.ready) return;
  try { if (t.webview.canGoForward()) t.webview.goForward(); } catch (e) {}
});
$reload.addEventListener('click', () => { const t = activeTab(); if (t && t.ready) { try { t.webview.reload(); } catch (e) {} } });
$('go-home').addEventListener('click', () => setRoute('home'));

// The "+" is a segmented button: the left half opens a tab on this window's account,
// the right half (>= 26px, full height) picks another account. Holding the left half
// for 400ms, or right-clicking anywhere on it, opens the same account menu -- the
// caret used to be a few pixels wide and nearly impossible to hit.
const NEW_TAB_HOLD_MS = 400;
const $newTabGroup = $('new-tab-group');
const $newTabMain = $('new-tab-btn');
const $newTabCaret = $('new-tab-caret');
let newTabHoldTimer = null;
let newTabHoldFired = false;

function cancelNewTabHold() {
  if (newTabHoldTimer) { clearTimeout(newTabHoldTimer); newTabHoldTimer = null; }
  if ($newTabGroup) $newTabGroup.classList.remove('pressing');
}
if ($newTabMain) {
  $newTabMain.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    newTabHoldFired = false;
    $newTabGroup.classList.add('pressing');
    newTabHoldTimer = setTimeout(() => {
      newTabHoldTimer = null;
      newTabHoldFired = true;
      cancelNewTabHold();
      showNewTabProfileMenu($newTabGroup);
    }, NEW_TAB_HOLD_MS);
  });
  $newTabMain.addEventListener('mouseup', cancelNewTabHold);
  $newTabMain.addEventListener('mouseleave', cancelNewTabHold);
  $newTabMain.addEventListener('click', (ev) => {
    ev.stopPropagation();
    cancelNewTabHold();
    // The long press already opened the menu; do not also spawn a tab.
    if (newTabHoldFired) { newTabHoldFired = false; return; }
    createTab(newTabUrl());
  });
}
if ($newTabCaret) {
  $newTabCaret.addEventListener('click', (ev) => {
    ev.stopPropagation();
    showNewTabProfileMenu($newTabGroup);
  });
}
if ($newTabGroup) {
  $newTabGroup.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    cancelNewTabHold();
    newTabHoldFired = false;
    showNewTabProfileMenu($newTabGroup);
  });
}

// Drop a menu under its button, left-aligned, flipping to right-aligned when it would
// run past the window edge. Measured after insertion because the width is content-driven.
function placeMenuUnder(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const margin = 8;
  if (rect.left + width > window.innerWidth - margin) {
    menu.style.left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - margin - width)) + 'px';
  }
  const height = menu.offsetHeight;
  if (rect.bottom + 4 + height > window.innerHeight - margin) {
    menu.style.top = Math.max(margin, window.innerHeight - margin - height) + 'px';
  }
}

function showNewTabProfileMenu(anchor) {
  closeAnyMenus();
  const menu = document.createElement('div');
  menu.className = 'menu profile-menu';
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = tOr('tabs.new_in_profile', '\u7528\u54ea\u4e2a\u8d26\u53f7\u65b0\u5efa\u6807\u7b7e');
  menu.appendChild(head);
  for (const p of profiles) {
    const it = document.createElement('div');
    it.className = 'menu-item' + (p.id === windowProfileId ? ' check' : '');
    it.innerHTML = '<span class="dot" style="background:' + (p.color || 'var(--main-orange)') + '"></span>' + escapeHtml(p.name || '');
    it.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeAnyMenus();
      createTab(newTabUrl(), p.id);
    });
    menu.appendChild(it);
  }
  placeMenuUnder(menu, anchor || $newTabGroup);
  if ($newTabGroup) $newTabGroup.classList.add('menu-open');
  armMenuClose();
}

// "Hand this site to <account>": one click turns the page you are on into a rule.
function showAssignSiteMenu(anchor, host) {
  closeAnyMenus();
  const rule = normalizeSiteRule(host);
  if (!rule) return;
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.minWidth = '220px';
  const head = document.createElement('div');
  head.className = 'menu-item';
  head.style.cssText = 'color: var(--text-secondary); font-size: 11px; pointer-events: none;';
  head.textContent = tOr('sites.assign_head', '\u628a {host} \u4ea4\u7ed9\u54ea\u4e2a\u8d26\u53f7').replace('{host}', rule);
  menu.appendChild(head);
  const owner = profileForUrl('http://' + rule);
  for (const p of profiles) {
    const it = document.createElement('div');
    it.className = 'menu-item' + (owner && owner.id === p.id ? ' check' : '');
    it.innerHTML = '<span class="dot" style="background:' + (p.color || 'var(--main-orange)') + '"></span>' + escapeHtml(p.name || '');
    it.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeAnyMenus();
      assignSiteToProfile(rule, p.id);
    });
    menu.appendChild(it);
  }
  // The way back out. Without it, the only exit from a mis-click was to hunt the
  // host down in whichever account's rule box it landed in.
  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  menu.appendChild(sep);
  const none = document.createElement('div');
  none.className = 'menu-item' + (owner ? '' : ' check');
  none.textContent = tOr('sites.assign_none', '\u4e0d\u6307\u5b9a\uff08\u8ddf\u968f\u5f53\u524d\u7a97\u53e3\uff09');
  if (!owner) none.style.opacity = '0.55';
  none.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeAnyMenus();
    if (owner) unassignSite(rule);
  });
  menu.appendChild(none);
  document.body.appendChild(menu);
  armMenuClose();
}

// ---------- window management (main owns the geometry; we only drive it) ----------
let toastTimer = null;
// Never alert(): a modal in a multi-window setup steals focus from the game.
function showToast(text, action) {
  const el = $('toast');
  if (!el || !text) return;
  el.textContent = '';
  const label = document.createElement('span');
  label.textContent = text;
  el.appendChild(label);
  // An action gives the toast a job beyond announcing: anything destructive or
  // hard to reverse by hand hands the user the way back here, while the thing
  // that just happened is still on screen.
  let life = 2200;
  if (action && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideToast();
      try { action.onClick(); } catch (e) {}
    });
    el.appendChild(btn);
    life = 6000; // long enough to read, decide and reach for it
  }
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, life);
}
function hideToast() {
  const el = $('toast');
  if (el) el.classList.remove('visible');
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}
function flashButton(el) {
  if (!el) return;
  el.classList.add('ok');
  setTimeout(() => el.classList.remove('ok'), 420);
}
function layoutHasTile(snapshot) {
  const last = snapshot && snapshot.lastTile;
  return !!(last && last.bounds && Object.keys(last.bounds).length);
}
// "Restore layout" is meaningless until something has been tiled once.
function refreshLayoutButtons() {
  return ipcRenderer.invoke('layouts:get').then((snap) => {
    const has = layoutHasTile(snap);
    const strip = $('strip-restore-tile');
    const home = $('act-restore-tile');
    if (strip) strip.classList.toggle('disabled', !has);
    if (home) home.disabled = !has;
    const forget = $('setting-forget-layouts');
    if (forget) forget.disabled = !has && !(snap && snap.byProfile && Object.keys(snap.byProfile).length);
    return has;
  }).catch(() => false);
}
function fillCount(key, fallback, n) {
  return tOr(key, fallback).replace('{n}', String(n));
}
// All four IPCs take no arguments: main resolves the calling window itself, which is
// exactly why the old renderer-side "find the focused window" park path kept missing.
function runWindowAction(kind, btn) {
  let job;
  if (kind === 'tile') job = ipcRenderer.invoke('windows:tile').then((r) => {
    const n = (r && r.tiled) || 0;
    return n ? fillCount('layout.tiled_toast', '\u5df2\u5e73\u94fa {n} \u4e2a\u7a97\u53e3', n)
             : tOr('layout.nothing', '\u6ca1\u6709\u53ef\u64cd\u4f5c\u7684\u7a97\u53e3');
  });
  else if (kind === 'restore') job = ipcRenderer.invoke('windows:restore-tile').then((r) => {
    if (!r || !r.hasLayout) return tOr('layout.no_layout', '\u8fd8\u6ca1\u6709\u8bb0\u4f4f\u7684\u5e03\u5c40');
    return fillCount('layout.restored_toast', '\u5df2\u6062\u590d {n} \u4e2a\u7a97\u53e3', r.restored || 0);
  });
  else if (kind === 'park') job = ipcRenderer.invoke('windows:park-others').then((n) => (
    n ? fillCount('layout.parked_toast', '\u5df2\u6302\u8d77 {n} \u4e2a\u7a97\u53e3', n)
      : tOr('layout.nothing', '\u6ca1\u6709\u53ef\u64cd\u4f5c\u7684\u7a97\u53e3')
  ));
  else if (kind === 'unpark') job = ipcRenderer.invoke('windows:unpark-all').then((n) => (
    n ? fillCount('layout.unparked_toast', '\u5df2\u8fd8\u539f {n} \u4e2a\u7a97\u53e3', n)
      : tOr('layout.nothing', '\u6ca1\u6709\u53ef\u64cd\u4f5c\u7684\u7a97\u53e3')
  ));
  else return;
  flashButton(btn);
  job.then((msg) => { showToast(msg); refreshLayoutButtons(); })
     .catch(() => showToast(tOr('layout.failed', '\u64cd\u4f5c\u672a\u5b8c\u6210')));
}
// 散开到多窗口并平铺：one click to break this window's other tabs out into
// windows of their own, then tile everything. detachTab() reopens the page in a new
// window, so every account it moves reloads and loses whatever match it was in — that is
// why this asks first and why the menu item carries no accelerator.
const SCATTER_INTERVAL_MS = 700;   // same cadence as the focus-mode multi-open
async function scatterTabsAndTile() {
  const keep = activeTab();
  // Snapshot the ids up front: detachTab() splices `tabs` while we walk it.
  const moving = tabs.filter(t => !keep || t.id !== keep.id).map(t => t.id);
  // tabs.length guard: with a stale activeId `keep` is null and `moving` would hold the
  // only tab, leaving this window empty.
  if (tabs.length < 2 || !moving.length) {
    showToast(tOr('scatter.empty', '这个窗口只有一个标签页，没有可散开的'));
    return;
  }
  const ask = fillCount('scatter.confirm',
    '把这个窗口里另外 {n} 个标签页各自移到新窗口，然后平铺所有窗口？\n\n移动时页面会重新加载，这些账号正在打的那一局会被打断。',
    moving.length);
  if (!confirm(ask)) return;
  showToast(fillCount('scatter.working', '正在散开 {n} 个标签页，每 0.7 秒一个…', moving.length));
  for (let i = 0; i < moving.length; i++) {
    if (i) await new Promise(r => setTimeout(r, SCATTER_INTERVAL_MS));
    try { await detachTab(moving[i]); } catch (e) {}
  }
  // One more beat so the last window has painted before main measures the screen.
  await new Promise(r => setTimeout(r, SCATTER_INTERVAL_MS));
  runWindowAction('tile', null);
}
function wireWindowAction(id, kind) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('click', () => {
    if (el.classList.contains('disabled') || el.disabled) return;
    runWindowAction(kind, el);
  });
}
wireWindowAction('strip-tile', 'tile');
wireWindowAction('strip-restore-tile', 'restore');
wireWindowAction('strip-park-others', 'park');
wireWindowAction('strip-unpark-all', 'unpark');
wireWindowAction('act-tile', 'tile');
wireWindowAction('act-restore-tile', 'restore');
wireWindowAction('act-park-others', 'park');
wireWindowAction('act-unpark-all', 'unpark');
$('setting-forget-layouts').addEventListener('click', () => {
  ipcRenderer.invoke('layouts:forget')
    .then(() => { showToast(tOr('layout.forgotten_toast', '\u5df2\u5fd8\u8bb0\u8bb0\u4f4f\u7684\u7a97\u53e3\u5e03\u5c40')); refreshLayoutButtons(); })
    .catch(() => {});
});

// Strings the dictionary does not carry yet: painted through tOr() so they light up
// on their own once the keys land, instead of showing a raw key like "layout.tile".
function paintLocalStrings() {
  const set = (id, text, tip) => {
    const el = $(id);
    if (!el) return;
    if (text != null) el.textContent = text;
    if (tip != null) el.title = tip;
  };
  const tile = tOr('layout.tile', '\u5e73\u94fa\u7a97\u53e3');
  const restore = tOr('layout.restore', '\u6062\u590d\u5e03\u5c40');
  const park = tOr('bar.park_others', '\u6302\u8d77\u5176\u5b83\u8d26\u53f7');
  const unpark = tOr('layout.unpark_all', '\u5168\u90e8\u8fd8\u539f');
  set('act-tile', tile); set('act-restore-tile', restore);
  set('act-park-others', park); set('act-unpark-all', unpark);
  // Icon buttons keep the words in the tooltip.
  set('strip-tile', null, tile);
  set('strip-restore-tile', null, restore);
  set('strip-park-others', null, park);
  set('strip-unpark-all', null, unpark);
  const newTab = $('new-tab-btn');
  // Own key, not tabs.new_tip: the tooltip has to advertise the long press, and the
  // fallback keeps saying so until the dictionary carries it.
  if (newTab) newTab.title = tOr('tabs.new_tip_hold', '\u65b0\u5efa\u6807\u7b7e\u9875 \u2318T\uff0c\u957f\u6309\u9009\u8d26\u53f7');
  const caret = $('new-tab-caret');
  if (caret) caret.title = tOr('tabs.new_in_profile', '\u7528\u54ea\u4e2a\u8d26\u53f7\u65b0\u5efa\u6807\u7b7e');
  const empty = document.querySelector('#tab-strip .tab-empty');
  if (empty) empty.textContent = tOr('tabs.empty_hint', '\u8fd8\u6ca1\u6709\u6807\u7b7e\u9875\uff0c\u70b9 + \u5f00\u59cb');
  set('set-layout-title', tOr('layout.group', '\u7a97\u53e3\u5e03\u5c40'));
  set('set-forget-layouts-label', tOr('layout.forget', '\u5fd8\u8bb0\u8bb0\u4f4f\u7684\u7a97\u53e3\u5e03\u5c40'));
  set('set-forget-layouts-sub', tOr('layout.forget_desc', '\u6e05\u9664\u5e73\u94fa\u65f6\u8bb0\u4f4f\u7684\u7a97\u53e3\u4f4d\u7f6e'));
  set('setting-forget-layouts', tOr('layout.forget_btn', '\u5fd8\u8bb0'));
  paintReportStrings();
}

$topUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const url = normalizeInput($topUrl.value);
    openUrl(url);
  }
});
$topUrl.addEventListener('focus', () => $topUrl.select());

$bmStar.addEventListener('click', () => {
  const t = activeTab();
  if (!t || currentRoute !== 'browser') return;
  const i = bookmarks.findIndex(b => b.url === t.url);
  if (i >= 0) {
    bookmarks[i].favorite = !(bookmarks[i].favorite !== false);
  } else {
    bookmarks.unshift(makeLibraryItem(t.url, t.title, { favorite: true }));
  }
  saveBookmarks();
  updateBookmarkStar();
  if (currentRoute === 'library') renderLibrary();
  else if (currentRoute === 'favorites') renderFavorites();
  else if (currentRoute === 'home') renderHomeFavorites();
});

// Profile chip click opens the ⋯ menu as a shortcut (same entries).
$('profile-chip').addEventListener('click', (ev) => { ev.stopPropagation(); showMoreMenu(ev.currentTarget); });

function showMoreMenu(anchor) {
  closeAnyMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.minWidth = '220px';
  // opts.state / opts.stateFor are optional. Only the profile rows pass them, so
  // every other caller keeps exactly the markup it had: no state light, no title.
  const addItem = (label, opts) => {
    const it = document.createElement('div');
    it.className = 'menu-item' + (opts && opts.check ? ' check' : '');
    const state = opts && opts.state;
    if (state || (opts && opts.dot)) {
      let html = '';
      // Two different things, in reading order: the day light ("did I open this
      // today?") then the account colour dot ("which account is this?").
      if (state) {
        html += '<span class="pc-dot ' + state + '" data-day-state="' + state + '"' +
          (opts.stateFor ? ' data-state-for="' + escapeHtml(opts.stateFor) + '"' : '') +
          ' style="' + dayStateDotStyle(state) + '"></span>';
      }
      if (opts.dot) html += '<span class="dot" style="background:' + opts.dot + '"></span>';
      it.innerHTML = html + escapeHtml(label);
    } else {
      it.textContent = label;
    }
    if (opts && opts.title) it.title = opts.title;
    it.addEventListener('click', (ev) => { ev.stopPropagation(); closeAnyMenus(); if (opts && opts.onClick) opts.onClick(); });
    menu.appendChild(it);
  };
  const addDivider = () => {
    const d = document.createElement('div');
    d.style.cssText = 'border-top: 1px solid var(--border); margin: 4px 6px;';
    menu.appendChild(d);
  };
  // New window in each profile
  for (const p of profiles) {
    const label = i18n.t('more.new_window_in').replace('{name}', p.name);
    const state = profileDayState(p);
    addItem(label, {
      dot: p.color, state: state, stateFor: p.id, title: profileDayStateLabel(state),
      check: p.id === windowProfileId, onClick: () => ipcRenderer.invoke('window:open', (window.XZAutoLogin && XZAutoLogin.quickUrlFor(p.id)) || null, p.id),
    });
  }
  addDivider();
  addItem(i18n.t('more.add_current_to_library'), { onClick: () => { const t = activeTab(); if (t) addToLibrary(t.url, t.title); } });
  // The handiest place to build a site rule is the page it is about.
  const siteTab = currentRoute === 'browser' ? activeTab() : null;
  const siteHost = siteTab ? normalizeSiteRule(siteHostOf(siteTab.url)) : '';
  if (siteHost) {
    addItem(tOr('sites.assign_current', '\u628a\u5f53\u524d\u7f51\u7ad9\u4ea4\u7ed9\u2026').replace('{host}', siteHost),
      { onClick: () => showAssignSiteMenu(anchor, siteHost) });
  }
  addItem(i18n.t('more.open_all_profiles'), { onClick: showProfileOpenModal });
  addItem(i18n.t('more.manage_profiles'), { onClick: () => setRoute('profiles') });
  addItem(i18n.t('more.appearance'),      { onClick: () => { appearanceExpanded = true; setRoute('settings'); setTimeout(() => $('theme-grid') && $('theme-grid').scrollIntoView({ block: 'start' }), 0); } });
  addItem(i18n.t('more.settings'),        { onClick: () => setRoute('settings') });
  addItem(i18n.t('more.shortcuts'),       { onClick: () => setRoute('shortcuts') });
  addItem(i18n.t('more.about'),           { onClick: () => setRoute('about') });
  document.body.appendChild(menu);
  armMenuClose();
  // Built from the cached set so the menu paints instantly; this pulls the
  // authoritative list and repaintMenuDayStates() fixes the lights in place if it
  // moved on (windows:changed keeps the cache warm the rest of the time).
  refreshRunningProfiles();
}
function armMenuClose() {
  if (menuCloseHandler) {
    document.removeEventListener('mousedown', menuCloseHandler, true);
    document.removeEventListener('keydown', menuCloseHandler, true);
    window.removeEventListener('blur', closeAnyMenus);
  }
  menuCloseHandler = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.target && e.target.closest && e.target.closest('.menu')) return;
    closeAnyMenus();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', menuCloseHandler, true);
    document.addEventListener('keydown', menuCloseHandler, true);
    window.addEventListener('blur', closeAnyMenus);
  }, 0);
}
function closeAnyMenus() {
  document.querySelectorAll('.menu').forEach(m => m.remove());
  const seg = document.getElementById('new-tab-group');
  if (seg) seg.classList.remove('menu-open', 'pressing');
  if (menuCloseHandler) {
    document.removeEventListener('mousedown', menuCloseHandler, true);
    document.removeEventListener('keydown', menuCloseHandler, true);
    window.removeEventListener('blur', closeAnyMenus);
    menuCloseHandler = null;
  }
}

// ---------- zoom ----------
function bumpZoom(delta) {
  const t = activeTab();
  if (!t) return;
  t.fit = false;
  t.zoom = (window.XZScale && XZScale.isOn(t)) ? XZScale.quantize(t, t.zoom || 1, delta > 0 ? 1 : -1) : Math.max(0.4, Math.min(3, (t.zoom || 1) + delta));
  t.webview.setZoomFactor(t.zoom);
  updateZoomIndicator();
}
function resetZoom() { const t = activeTab(); if (!t) return; t.fit = false; t.zoom = 1; t.webview.setZoomFactor(1); updateZoomIndicator(); }
function fitZoom() { const t = activeTab(); if (!t) return; t.fit = true; t._applyZoom(); }
$('zoom-in-btn').addEventListener('click', () => bumpZoom(0.1));
$('zoom-out-btn').addEventListener('click', () => bumpZoom(-0.1));
$('fit-btn').addEventListener('click', fitZoom);
window.addEventListener('resize', () => {
  for (const t of tabs) if (t.fit) t._applyZoom();
  if (measuring.active) resizeMeasureCanvas();
});

// ---------- shortcuts ----------
function inputFromEvent(e) {
  return {
    key: e.key,
    code: e.code,
    alt: !!e.altKey,
    control: !!e.ctrlKey,
    meta: !!e.metaKey,
    shift: !!e.shiftKey,
  };
}
function isEditableTarget(target) {
  if (!target || !target.closest) return false;
  return !!target.closest('input, textarea, select, [contenteditable="true"]');
}
function shortcutCodeLabel(code) {
  if (!code) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const map = {
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Space: 'Space',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
  };
  return map[code] || code.replace(/^Numpad/, 'Num ');
}
function shortcutFromInput(input) {
  const code = input && input.code ? input.code : '';
  if (!code || MODIFIER_CODES.has(code)) return '';
  const parts = [];
  if (input.control) parts.push('Control');
  if (input.meta) parts.push('Meta');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  parts.push(code);
  return parts.join('+');
}
function shortcutDisplay(shortcut) {
  if (!shortcut) return i18n.t('shortcut.none');
  const parts = String(shortcut).split('+').filter(Boolean);
  const code = parts.pop();
  const mods = parts.map(p => ({ Control: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧' }[p] || p));
  return mods.concat(shortcutCodeLabel(code)).join('');
}
function shortcutMatches(input, shortcut) {
  if (!input || !shortcut) return false;
  const parts = String(shortcut).split('+').filter(Boolean);
  const code = parts.pop();
  const mods = new Set(parts);
  return input.code === code &&
    !!input.control === mods.has('Control') &&
    !!input.meta === mods.has('Meta') &&
    !!input.alt === mods.has('Alt') &&
    !!input.shift === mods.has('Shift');
}
function startShortcutCapture(type, key, index, button) {
  clearShortcutCapture();
  shortcutCaptureTarget = { type, key, index, button };
  if (button) {
    button.classList.add('recording');
    button.textContent = i18n.t('shortcut.recording');
  }
}
function clearShortcutCapture() {
  if (shortcutCaptureTarget && shortcutCaptureTarget.button) {
    const target = shortcutCaptureTarget;
    shortcutCaptureTarget.button.classList.remove('recording');
    if (target.type === 'speed-shortcut') {
      shortcutCaptureTarget.button.textContent = shortcutDisplay(settings.speedShortcuts[target.key]);
    } else if (target.type === 'speed-hotkey' && settings.speedHotkeys[target.index]) {
      shortcutCaptureTarget.button.textContent = shortcutDisplay(settings.speedHotkeys[target.index].shortcut);
    }
  }
  shortcutCaptureTarget = null;
}
async function finishShortcutCapture(shortcut) {
  if (!shortcutCaptureTarget) return;
  const target = shortcutCaptureTarget;
  if (target.type === 'speed-shortcut') {
    settings.speedShortcuts[target.key] = shortcut;
  } else if (target.type === 'speed-hotkey' && settings.speedHotkeys[target.index]) {
    settings.speedHotkeys[target.index].shortcut = shortcut;
  }
  clearShortcutCapture();
  await saveSettings();
  renderSpeedToolSettings();
}
function shortcutInputLabel(input) {
  return shortcutDisplay(shortcutFromInput(input));
}
function currentSpeedPresetIndex() {
  const presets = normalizeSpeedPresets(settings.speedPresets);
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < presets.length; i++) {
    const delta = Math.abs(presets[i] - (speedFactor || 1));
    if (delta < bestDelta) {
      best = i;
      bestDelta = delta;
    }
  }
  return best;
}
function cycleSpeedPreset(direction) {
  const presets = normalizeSpeedPresets(settings.speedPresets);
  if (!presets.length) return;
  const current = speedFactor || 1;
  let index = currentSpeedPresetIndex();
  const exact = Math.abs(presets[index] - current) < 0.01;
  if (!exact) {
    if (direction > 0) {
      index = presets.findIndex(p => p > current);
      if (index === -1) index = 0;
    } else {
      index = presets.length - 1;
      for (let i = presets.length - 1; i >= 0; i--) {
        if (presets[i] < current) { index = i; break; }
      }
    }
  } else {
    index = (index + direction + presets.length) % presets.length;
  }
  setSpeedFactor(presets[index]);
}
async function addSpeedPreset(value) {
  const n = clampSpeedPreset(value);
  if (n == null) return false;
  const presets = normalizeSpeedPresets(settings.speedPresets);
  if (!presets.some(p => Math.abs(p - n) < 0.01)) presets.push(n);
  settings.speedPresets = normalizeSpeedPresets(presets);
  await saveSettings();
  renderSpeedToolSettings();
  return true;
}
async function removeSpeedPreset(value) {
  const n = clampSpeedPreset(value);
  const presets = normalizeSpeedPresets(settings.speedPresets).filter(p => Math.abs(p - n) >= 0.01);
  settings.speedPresets = presets.length ? presets : [1];
  await saveSettings();
  renderSpeedToolSettings();
}
async function resetSpeedPresets() {
  settings.speedPresets = DEFAULT_SPEED_PRESETS.slice();
  await saveSettings();
  renderSpeedToolSettings();
}
function handleShortcutInput(input, target) {
  if (shortcutCaptureTarget) {
    if (input.code === 'Escape') {
      clearShortcutCapture();
      renderSpeedToolSettings();
      return true;
    }
    if (input.code === 'Backspace' || input.code === 'Delete') {
      finishShortcutCapture('');
      return true;
    }
    const shortcut = shortcutFromInput(input);
    if (shortcut) finishShortcutCapture(shortcut);
    return !!shortcut;
  }
  if (isEditableTarget(target) && !input.alt && !input.meta && !input.control) return false;
  settings.speedShortcuts = normalizeSpeedShortcuts(settings.speedShortcuts);
  settings.speedHotkeys = normalizeSpeedHotkeys(settings.speedHotkeys);
  if (shortcutMatches(input, settings.speedShortcuts.prev)) {
    cycleSpeedPreset(-1);
    return true;
  }
  if (shortcutMatches(input, settings.speedShortcuts.next)) {
    cycleSpeedPreset(1);
    return true;
  }
  if (shortcutMatches(input, settings.speedShortcuts.reset)) {
    setSpeedFactor(1);
    return true;
  }
  if (shortcutMatches(input, settings.speedShortcuts.measure)) {
    toggleMeasureOverlay();
    return true;
  }
  if (shortcutMatches(input, settings.speedShortcuts.screenshot)) {
    screenshotCurrentGame();
    return true;
  }
  if (shortcutMatches(input, settings.speedShortcuts.aim)) {
    if (window.AimAssist) window.AimAssist.toggle();
    return true;
  }
  for (const hotkey of settings.speedHotkeys) {
    if (shortcutMatches(input, hotkey.shortcut)) {
      setSpeedFactor(hotkey.factor);
      return true;
    }
  }
  return false;
}
window.addEventListener('keydown', (e) => {
  const handled = handleShortcutInput(inputFromEvent(e), e.target);
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
ipcRenderer.on('shortcut:input', (_e, input) => {
  handleShortcutInput(input || {}, null);
});

// ---------- Flash speed ----------
function updateSpeedIndicator() {
  const el = $('speed-indicator');
  if (!el) return;
  el.classList.toggle('sealed', !speedHookEnabled);
  if (!speedHookEnabled) return;
  const rounded = Math.round((speedFactor || 1) * 100) / 100;
  const profile = SPEED_PROFILE_BY_KEY[settings.speedProfile] || SPEED_PROFILES[0];
  const modeText = i18n.t(profile.shortKey);
  el.textContent = speedHookEnabled ? (rounded + 'x ' + modeText + ' ▾') : '1x';
  el.classList.toggle('hot', rounded > 3);
  el.title = speedHookEnabled ? (rounded === 1 ? i18n.t('speed.normal') : i18n.t('speed.tip')) : i18n.t('speed.disabled_hint');
}
async function setSpeedFactor(factor) {
  const requested = clampSpeedPreset(factor) || 1;
  const next = await ipcRenderer.invoke('speed:set', requested, speedProfileCode());
  speedFactor = next || 1;
  updateSpeedIndicator();
  if (currentRoute === 'settings') renderSpeedToolSettings();
  if (currentRoute === 'doctor') renderDoctor();
}
function showSpeedMenu(anchor) {
  closeAnyMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu speed-menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = (rect.right - 260) + 'px';
  menu.style.minWidth = '250px';
  if (!speedHookEnabled) {
    const hint = document.createElement('div');
    hint.style.cssText = 'max-width: 240px; padding: 10px 12px; color: var(--text-secondary); font-size: 11px; line-height: 1.45;';
    hint.textContent = i18n.t('speed.disabled_hint');
    menu.appendChild(hint);
    const item = document.createElement('div');
    item.className = 'menu-item';
    item.textContent = i18n.t('speed.enable_experimental');
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const t = activeTab();
      ipcRenderer.invoke('speed:set', 1, speedProfileCode()).then(() => {
        ipcRenderer.invoke('speed:relaunch', true, t ? t.url : null);
      });
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    armMenuClose();
    return;
  }
  const modeTitle = document.createElement('div');
  modeTitle.style.cssText = 'padding: 8px 10px 4px; color: var(--text-secondary); font-size: 11px;';
  modeTitle.textContent = i18n.t('speed.current_mode');
  menu.appendChild(modeTitle);
  const currentProfile = settings.speedProfile || 'native-ddt';
  const profileMenu = SPEED_PROFILES.filter(p => SPEED_PROFILE_MENU_KEYS.includes(p.key));
  if (!profileMenu.some(p => p.key === currentProfile) && SPEED_PROFILE_BY_KEY[currentProfile]) {
    profileMenu.unshift(SPEED_PROFILE_BY_KEY[currentProfile]);
  }
  for (const profile of profileMenu) {
    const item = document.createElement('div');
    item.className = 'menu-item' + (currentProfile === profile.key ? ' check' : '');
    item.textContent = i18n.t(profile.labelKey);
    item.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      settings.speedProfile = profile.key;
      await saveSettings();
      updateSpeedIndicator();
      setSpeedFactor(speedFactor || 1);
      closeAnyMenus();
    });
    menu.appendChild(item);
  }
  const modeDiv = document.createElement('div');
  modeDiv.style.cssText = 'border-top: 1px solid var(--border); margin: 4px 6px;';
  menu.appendChild(modeDiv);
  const presets = normalizeSpeedPresets(settings.speedPresets);
  for (const p of presets) {
    const item = document.createElement('div');
    item.className = 'menu-item' + (Math.abs((speedFactor || 1) - p) < 0.01 ? ' check' : '');
    item.innerHTML = '<span>' + p + 'x</span><span class="hint">' + shortcutForSpeedPreset(p) + '</span>';
    item.addEventListener('click', (ev) => { ev.stopPropagation(); setSpeedFactor(p); closeAnyMenus(); });
    menu.appendChild(item);
  }
  const div = document.createElement('div');
  div.style.cssText = 'border-top: 1px solid var(--border); margin: 4px 6px;';
  menu.appendChild(div);
  const customItem = document.createElement('div');
  customItem.className = 'menu-item';
  customItem.textContent = i18n.t('speed.custom');
  customItem.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const inp = prompt(i18n.t('speed.custom_prompt'), String(speedFactor || 1));
    closeAnyMenus();
    if (inp == null) return;
    const n = clampSpeedPreset(inp);
    if (n == null) return;
    await setSpeedFactor(n);
    const exists = normalizeSpeedPresets(settings.speedPresets).some(p => Math.abs(p - n) < 0.01);
    if (!exists && confirm(i18n.t('speed.add_custom_confirm').replace('{factor}', n))) {
      await addSpeedPreset(n);
    }
  });
  menu.appendChild(customItem);
  const manageItem = document.createElement('div');
  manageItem.className = 'menu-item';
  manageItem.textContent = i18n.t('speed.manage_presets');
  manageItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeAnyMenus();
    setRoute('settings');
    setTimeout(() => {
      const el = $('speed-tools-group');
      if (el) el.scrollIntoView({ block: 'start' });
    }, 0);
  });
  menu.appendChild(manageItem);
  const hint = document.createElement('div');
  hint.style.cssText = 'max-width: 220px; padding: 8px 10px; color: var(--text-secondary); font-size: 11px; line-height: 1.4;';
  hint.textContent = i18n.t('speed.safe_hint');
  menu.appendChild(hint);
  const stateLine = document.createElement('div');
  stateLine.style.cssText = 'max-width: 240px; padding: 0 10px 8px; color: var(--text-secondary); font-size: 11px; line-height: 1.4;';
  stateLine.textContent = i18n.t('speed.state')
    .replace('{factor}', Math.round((speedFactor || 1) * 100) / 100)
    .replace('{profile}', speedProfileCode());
  menu.appendChild(stateLine);
  ipcRenderer.invoke('speed:state').then((state) => {
    if (!state || !document.body.contains(stateLine)) return;
    stateLine.textContent = i18n.t('speed.state')
      .replace('{factor}', Math.round((state.factor || 1) * 100) / 100)
      .replace('{profile}', state.profile || 0);
  }).catch(() => {});
  document.body.appendChild(menu);
  armMenuClose();
}
function shortcutForSpeedPreset(factor) {
  const hit = normalizeSpeedHotkeys(settings.speedHotkeys).find(h => Math.abs(h.factor - factor) < 0.01 && h.shortcut);
  return hit ? shortcutDisplay(hit.shortcut) : '';
}
$('speed-indicator').addEventListener('click', (ev) => { ev.stopPropagation(); showSpeedMenu(ev.currentTarget); });
ipcRenderer.on('speed:changed', (_e, factor) => {
  speedFactor = factor || 1;
  updateSpeedIndicator();
});
ipcRenderer.on('audio:global-muted', (_e, muted) => {
  settings.globalMuted = !!muted;
  applyAudioMute();
});

// ---------- history ----------
function recordHistory(tab) {
  if (!tab || !tab.url) return;
  if (tab.url.startsWith('about:') || tab.url === 'data:') return;
  const last = history[0];
  const now = Date.now();
  if (last && last.url === tab.url) {
    if (now - (last.visitedAt || 0) > HISTORY_REPEAT_WRITE_MS) {
      last.visitedAt = now;
      saveHistorySoon();
      if (currentRoute === 'home') renderHomeContinue();
      else if (currentRoute === 'recent') renderRecent();
    }
    return;
  }
  history.unshift({ url: tab.url, title: tab.title || tab.url, visitedAt: now, profileId: tab.profileId });
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  saveHistorySoon();
  if (currentRoute === 'home') renderHomeContinue();
  else if (currentRoute === 'recent') renderRecent();
}

// ---------- Home ----------
function renderHome() {
  renderGreeting();
  renderHomeContinue();
  renderHomeFavorites();
  renderHomeWindows();
}
function renderGreeting() {
  const h = new Date().getHours();
  let k = 'greet.evening';
  if (h < 5) k = 'greet.night';
  else if (h < 12) k = 'greet.morning';
  else if (h < 18) k = 'greet.afternoon';
  $('greet-text').textContent = i18n.t(k);
}
function uniqueRecentByHost(max) {
  const seen = new Set();
  const out = [];
  for (const h of history) {
    const host = hostOf(h.url);
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}
function cardEl(entry, onClick) {
  const el = document.createElement('div');
  el.className = 'card';
  const host = hostOf(entry.url);
  el.innerHTML =
    '<div class="cover"><div class="letter">' + domainLetter(entry.url) + '</div></div>' +
    '<div class="title">' + escapeHtml(entry.title || host) + '</div>' +
    '<div class="meta">' + escapeHtml(host) + '</div>';
  el.addEventListener('click', onClick);
  return el;
}
function renderHomeContinue() {
  const c = $('home-continue'); c.innerHTML = '';
  const items = uniqueRecentByHost(6);
  if (!items.length) {
    c.innerHTML = placeholderHtml(i18n.t('home.empty_history'), EMPTY_ASSETS.recent, 'grid-column:1/-1;padding:20px;height:auto;');
    return;
  }
  for (const e of items) c.appendChild(cardEl(e, () => openUrl(e.url)));
}
function renderHomeFavorites() {
  const c = $('home-favorites'); c.innerHTML = '';
  const items = bookmarks.filter(b => b.favorite !== false).slice(0, 6);
  if (!items.length) {
    c.innerHTML = placeholderHtml(i18n.t('home.empty_favorites'), EMPTY_ASSETS.favorites, 'grid-column:1/-1;padding:20px;height:auto;');
    return;
  }
  for (const e of items) c.appendChild(cardEl(e, () => openUrl(e.url)));
}
function renderHomeWindows() {
  const c = $('home-windows'); c.innerHTML = '';
  if (!tabs.length) {
    c.innerHTML = placeholderHtml(i18n.t('home.empty_windows'), EMPTY_ASSETS.windows, 'padding:20px;height:auto;');
    return;
  }
  for (const t of tabs) c.appendChild(winrowEl(t));
}
function winrowEl(t) {
  const profile = profileById(t.profileId);
  const row = document.createElement('div');
  row.className = 'winrow';
  row.innerHTML =
    '<div style="flex: 1; min-width: 0;">' +
      '<div class="w-title">' + escapeHtml(t.title || hostOf(t.url)) + '</div>' +
      '<div class="w-url">' + escapeHtml(hostOf(t.url)) + '</div>' +
    '</div>' +
    '<span class="tag"><span class="dot" style="background:' + (profile ? profile.color : '#888') + '"></span>' + escapeHtml(profile ? profile.name : '-') + '</span>' +
    '<button class="btn" data-act="focus">' + escapeHtml(i18n.t('win.focus')) + '</button>' +
    '<button class="btn" data-act="dup">' + escapeHtml(i18n.t('win.duplicate')) + '</button>' +
    '<button class="btn danger" data-act="close">' + escapeHtml(i18n.t('win.close')) + '</button>';
  row.querySelector('[data-act="focus"]').addEventListener('click', () => { activateTab(t.id); setRoute('browser'); });
  row.querySelector('[data-act="dup"]').addEventListener('click', () => ipcRenderer.invoke('window:open', t.url, t.profileId));
  row.querySelector('[data-act="close"]').addEventListener('click', () => closeTab(t.id));
  return row;
}

// ---------- Favorites / Recent ----------
function renderFavorites() {
  const q = ($('fav-search').value || '').toLowerCase();
  const base = bookmarks.filter(b => b.favorite !== false);
  const items = q ? base.filter(b => (b.title || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q)) : base;
  $('fav-count').textContent = items.length + ' ' + i18n.t(items.length === 1 ? 'common.item' : 'common.items');
  const list = $('fav-list'); list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = placeholderHtml(i18n.t('home.empty_favorites'), EMPTY_ASSETS.favorites, 'padding:24px;height:auto;');
    return;
  }
  for (const e of items.slice(0, LIST_RENDER_LIMIT)) list.appendChild(entryEl(e, 'fav'));
}
function renderRecent() {
  const q = ($('rec-search').value || '').toLowerCase();
  const items = q ? history.filter(h => (h.title || '').toLowerCase().includes(q) || (h.url || '').toLowerCase().includes(q)) : history;
  $('rec-count').textContent = items.length + ' ' + i18n.t(items.length === 1 ? 'common.item' : 'common.items');
  const list = $('rec-list'); list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = placeholderHtml(i18n.t('home.empty_history'), EMPTY_ASSETS.recent, 'padding:24px;height:auto;');
    return;
  }
  for (const e of items.slice(0, LIST_RENDER_LIMIT)) list.appendChild(entryEl(e, 'rec'));
}
function entryEl(e, kind) {
  const el = document.createElement('div');
  el.className = 'entry';
  const host = hostOf(e.url);
  const when = kind === 'rec' ? formatTime(e.visitedAt) : '';
  el.innerHTML =
    '<div class="e-cover">' + domainLetter(e.url) + '</div>' +
    '<div class="e-text">' +
      '<div class="e-title">' + escapeHtml(e.title || host) + '</div>' +
      '<div class="e-url">' + escapeHtml(e.url) + (when ? ' · ' + when : '') + '</div>' +
    '</div>' +
    '<div class="e-actions">' +
      '<button data-act="open">' + escapeHtml(i18n.t('common.open')) + '</button>' +
      '<button data-act="new">' + escapeHtml(i18n.t('common.new_window')) + '</button>' +
      '<button data-act="del">' + escapeHtml(i18n.t('common.remove')) + '</button>' +
    '</div>';
  el.addEventListener('click', (ev) => { if (!ev.target.closest('.e-actions')) openUrl(e.url); });
  el.querySelector('[data-act="open"]').addEventListener('click', (ev) => { ev.stopPropagation(); openUrl(e.url); });
  el.querySelector('[data-act="new"]').addEventListener('click', (ev) => { ev.stopPropagation(); ipcRenderer.invoke('window:open', e.url); });
  el.querySelector('[data-act="del"]').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const arr = kind === 'rec' ? history : bookmarks;
    const i = arr.indexOf(e);
    if (i >= 0) arr.splice(i, 1);
    if (kind === 'rec') saveHistory(); else saveBookmarks();
    if (kind === 'rec') renderRecent(); else renderFavorites();
    updateBookmarkStar();
  });
  return el;
}
$('fav-search').addEventListener('input', renderFavorites);
$('rec-search').addEventListener('input', renderRecent);

// ---------- Windows ----------
function renderWindows() {
  const list = $('win-list'); list.innerHTML = '';
  $('win-count').textContent = tabs.length + ' ' + i18n.t(tabs.length === 1 ? 'common.window' : 'common.windows');
  if (!tabs.length) {
    list.innerHTML = placeholderHtml(i18n.t('win.empty'), EMPTY_ASSETS.windows, 'padding:24px;height:auto;');
    return;
  }
  for (const t of tabs) list.appendChild(winrowEl(t));
}

// ---------- Profiles ----------
// Keep whatever the user has half-typed: profiles:changed fires on our own writes
// too, and a naive redraw would wipe the open editor.
function captureProfileEditDraft() {
  if (!editingProfileId) { profileEditDraft = null; return null; }
  const card = document.querySelector('#profile-list .profile-card.editing');
  if (!card) return profileEditDraft;
  const input = card.querySelector('[data-field="name"]');
  const selected = card.querySelector('.color-choice.selected');
  const draft = profileEditDraft || { id: editingProfileId, fresh: false };
  draft.id = editingProfileId;
  if (input) {
    draft.name = input.value;
    try { draft.caret = input.selectionStart; } catch (e) {}
  }
  if (selected && selected.dataset.color) draft.color = selected.dataset.color;
  const sitesEl = card.querySelector('[data-field="sites"]');
  if (sitesEl) draft.sites = sitesEl.value;
  profileEditDraft = draft;
  return draft;
}
function syncProfileOrderBar() {
  const manualBtn = $('profile-order-manual');
  const recentBtn = $('profile-order-recent');
  const applyBtn = $('profile-apply-order');
  const hint = $('profile-order-hint');
  if (manualBtn) {
    manualBtn.textContent = i18n.t('prof.order_manual');
    manualBtn.classList.toggle('active', profileOrderView === 'manual');
  }
  if (recentBtn) {
    recentBtn.textContent = i18n.t('prof.order_recent');
    recentBtn.classList.toggle('active', profileOrderView === 'recent');
  }
  if (applyBtn) {
    applyBtn.textContent = i18n.t('prof.apply_order');
    applyBtn.style.display = profileOrderView === 'recent' ? '' : 'none';
  }
  if (hint) hint.textContent = i18n.t('prof.order_manual') + ' · ⌘1 – ⌘8';
}
async function renderProfiles() {
  const list = $('profile-list');
  // A redraw mid-drag would drop the pointer target; queue it for dragend instead.
  if (profileDragId != null) { profileRenderPending = true; return; }
  const draft = captureProfileEditDraft();
  list.innerHTML = '';
  ensureProfiles();
  syncProfileOrderBar();
  const pwCounts = new Map();
  for (const pw of passwords) {
    if (!pw.profileId) continue;
    pwCounts.set(pw.profileId, (pwCounts.get(pw.profileId) || 0) + 1);
  }
  const view = profilesForView();
  const manual = profileOrderView === 'manual';
  for (let viewIndex = 0; viewIndex < view.length; viewIndex++) {
    const p = view[viewIndex];
    const card = document.createElement('div');
    card.className = 'profile-card';
    card.dataset.profileId = p.id;
    const isDefault = p.id === settings.defaultProfileId;
    const pwCount = pwCounts.get(p.id) || 0;
    const isEditing = editingProfileId === p.id;
    if (isEditing) card.classList.add('editing');
    const editName = (isEditing && draft && draft.id === p.id && draft.name != null) ? draft.name : p.name;
    const editColor = (isEditing && draft && draft.id === p.id && draft.color) ? draft.color : p.color;
    const siteList = normalizeSiteRuleList(profileSites(p));
    const editSites = (isEditing && draft && draft.id === p.id && draft.sites != null)
      ? draft.sites
      : siteList.join('\n');
    const colorChoices = PROFILE_COLORS.map(color =>
      '<button type="button" class="color-choice' + (color === editColor ? ' selected' : '') +
      '" data-color="' + color + '" style="background:' + color + '" title="' + color + '"></button>'
    ).join('');
    // Rank badge doubles as the Cmd+N legend for the first eight slots.
    const rank = viewIndex + 1;
    const canMove = manual && !isEditing;
    const orderCol =
      '<div class="pc-order">' +
        '<div class="pc-rank' + (rank <= 8 ? ' has-key' : '') + '">' + (rank <= 8 ? '⌘' + rank : rank) + '</div>' +
        '<button type="button" class="pc-move" data-act="move-up" title="' + escapeHtml(i18n.t('prof.move_up')) +
          '" aria-label="' + escapeHtml(i18n.t('prof.move_up')) + '"' + (canMove ? '' : ' disabled') + '>▲</button>' +
        '<button type="button" class="pc-move" data-act="move-down" title="' + escapeHtml(i18n.t('prof.move_down')) +
          '" aria-label="' + escapeHtml(i18n.t('prof.move_down')) + '"' + (canMove ? '' : ' disabled') + '>▼</button>' +
      '</div>';
    const dayState = profileDayState(p);
    const statusRow =
      '<div class="pc-status">' +
        '<span class="pc-dot ' + dayState + '"></span>' +
        '<span class="pc-status-text">' + escapeHtml(profileDayStateLabel(dayState)) + '</span>' +
      '</div>' +
      (p.lastOpenedAt
        ? '<div class="pc-last">' + escapeHtml(i18n.t('prof.last_opened')) + ' · ' + escapeHtml(formatRelativeTime(p.lastOpenedAt)) + '</div>'
        : '');
    card.innerHTML = isEditing
      ? orderCol +
        '<div class="swatch" data-preview style="background:' + editColor + '"></div>' +
        '<div class="profile-edit-fields">' +
          '<input data-field="name" value="' + escapeHtml(editName) + '" placeholder="' + escapeHtml(i18n.t('prof.placeholder')) + '">' +
          '<div class="color-row"><span>' + escapeHtml(i18n.t('prof.color')) + '</span>' + colorChoices + '</div>' +
          '<div class="pc-sites-edit">' +
            '<div class="pc-sites-title">' + escapeHtml(tOr('sites.field_label', '\u8fd9\u4e9b\u7f51\u7ad9\u7528\u6b64\u8d26\u53f7\u6253\u5f00')) + '</div>' +
            '<textarea data-field="sites" rows="3" spellcheck="false" placeholder="' +
              escapeHtml(tOr('sites.field_placeholder', '\u6bcf\u884c\u4e00\u4e2a\u57df\u540d\uff0c\u4f8b\u5982 4399.com')) + '">' +
              escapeHtml(editSites) + '</textarea>' +
            '<div class="pc-sites-hint">' + escapeHtml(tOr('sites.field_hint', '\u53ea\u5f71\u54cd\u65b0\u5f00\u7684\u9875\u9762\uff1b\u5728\u9875\u9762\u91cc\u70b9\u94fe\u63a5\u4ecd\u7136\u7559\u5728\u5f53\u524d\u8d26\u53f7\u3002')) + '</div>' +
          '</div>' +
          '<div class="pc-meta"><span data-stat="cookies">…</span>' + escapeHtml(i18n.t('prof.cookies')) +
            ' · ' + pwCount + ' ' + escapeHtml(i18n.t('prof.passwords_count')) +
          '</div>' +
        '</div>' +
        '<div class="pc-actions">' +
          '<button data-act="save" class="primary">' + escapeHtml(i18n.t('common.save')) + '</button>' +
          '<button data-act="cancel">' + escapeHtml(i18n.t('common.cancel')) + '</button>' +
        '</div>'
      : orderCol +
        '<div class="swatch" style="background:' + p.color + '"></div>' +
        '<div>' +
          '<div class="pc-name">' + escapeHtml(p.name) +
            (isDefault ? '<span class="pc-tag default">' + escapeHtml(i18n.t('prof.default')) + '</span>' : '') +
          '</div>' +
          statusRow +
          '<div class="pc-meta"><span data-stat="cookies">…</span>' + escapeHtml(i18n.t('prof.cookies')) +
            ' · ' + pwCount + ' ' + escapeHtml(i18n.t('prof.passwords_count')) +
          '</div>' +
          (siteList.length
            ? '<div class="pc-sites">' + escapeHtml(tOr('sites.card_prefix', '\u6307\u5b9a\u7f51\u7ad9')) + ' · ' +
              escapeHtml(siteList.join(' \u00b7 ')) + '</div>'
            : '') +
        '</div>' +
        '<div class="pc-actions">' +
          '<button data-act="open">' + escapeHtml(i18n.t('prof.open_window')) + '</button>' +
          '<button data-act="clone">' + escapeHtml(i18n.t('prof.clone_current')) + '</button>' +
          (isDefault ? '' : '<button data-act="default" class="primary">' + escapeHtml(i18n.t('prof.set_default')) + '</button>') +
          '<button data-act="rename">' + escapeHtml(i18n.t('prof.edit')) + '</button>' +
          '<button data-act="clear">' + escapeHtml(i18n.t('prof.clear')) + '</button>' +
          (p.id === 'main' ? '' : '<button data-act="delete" class="danger">' + escapeHtml(i18n.t('prof.delete')) + '</button>') +
        '</div>';
    const q = (sel) => card.querySelector(sel);
    wireProfileOrderControls(card, p, viewIndex, view, canMove);
    if (isEditing) {
      card.querySelectorAll('.color-choice').forEach(btn => {
        btn.addEventListener('click', () => {
          card.querySelectorAll('.color-choice').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          const preview = q('[data-preview]');
          if (preview) preview.style.background = btn.dataset.color;
          if (profileEditDraft && profileEditDraft.id === p.id) profileEditDraft.color = btn.dataset.color;
        });
      });
      q('[data-act="save"]').addEventListener('click', async () => {
        const name = q('[data-field="name"]').value.trim();
        const selected = q('.color-choice.selected');
        if (!name) return;
        const patch = { id: p.id, name };
        if (selected && selected.dataset.color) patch.color = selected.dataset.color;
        const sitesEl = q('[data-field="sites"]');
        // One rule per line, but commas and spaces are tolerated — people paste lists.
        const rules = sitesEl ? normalizeSiteRuleList(String(sitesEl.value || '').split(/[\s,;\u3001\uff0c]+/)) : null;
        editingProfileId = null;
        profileEditDraft = null;
        await upsertProfile(patch);
        const taken = rules ? await writeProfileSites(p.id, rules) : [];
        refreshProfileChip();
        renderProfiles();
        if (taken.length) {
          showToast(tOr('sites.taken_toast', '\u8fd9\u4e9b\u7f51\u7ad9\u5df2\u4ece {from} \u6539\u7ed9 {name}')
            .replace('{from}', taken.join('\u3001')).replace('{name}', name));
        }
      });
      const nameInput = q('[data-field="name"]');
      nameInput.addEventListener('input', () => {
        profileEditDraft = profileEditDraft || { id: p.id };
        profileEditDraft.id = p.id;
        profileEditDraft.name = nameInput.value;
        try { profileEditDraft.caret = nameInput.selectionStart; } catch (e) {}
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') q('[data-act="save"]').click();
        if (e.key === 'Escape') q('[data-act="cancel"]').click();
      });
      q('[data-act="cancel"]').addEventListener('click', () => {
        editingProfileId = null;
        profileEditDraft = null;
        renderProfiles();
      });
      list.appendChild(card);
      // Only steal the selection the first time the editor opens; a broadcast redraw
      // must land the caret back where the user left it.
      const fresh = !draft || draft.id !== p.id || draft.fresh !== false;
      const caret = draft && draft.id === p.id ? draft.caret : null;
      if (profileEditDraft) profileEditDraft.fresh = false;
      setTimeout(() => {
        const input = q('[data-field="name"]');
        if (!input || !document.body.contains(input)) return;
        input.focus();
        if (fresh) input.select();
        else if (caret != null) { try { input.setSelectionRange(caret, caret); } catch (e) {} }
      }, 0);
      ipcRenderer.invoke('profile:stats', p).then((s) => {
        if (!document.body.contains(card)) return;
        const el = card.querySelector('[data-stat="cookies"]');
        if (el) el.textContent = (s && Number.isFinite(s.cookies)) ? s.cookies : 0;
      }).catch(() => {
        const el = card.querySelector('[data-stat="cookies"]');
        if (el) el.textContent = '0';
      });
      continue;
    }
    const bt = q('[data-act="default"]'); if (bt) bt.addEventListener('click', async () => {
      settings.defaultProfileId = p.id; await saveSettings(); refreshProfileChip(); renderProfiles();
    });
    q('[data-act="open"]').addEventListener('click', () => ipcRenderer.invoke('window:open', (window.XZAutoLogin && XZAutoLogin.quickUrlFor(p.id)) || homeUrl, p.id));
    q('[data-act="clone"]').addEventListener('click', () => {
      const t = activeTab();
      ipcRenderer.invoke('window:open', t ? t.url : homeUrl, p.id);
    });
    q('[data-act="rename"]').addEventListener('click', () => {
      editingProfileId = p.id;
      profileEditDraft = { id: p.id, name: p.name, color: p.color, caret: null, fresh: true };
      renderProfiles();
    });
    q('[data-act="clear"]').addEventListener('click', async () => {
      if (!confirm(i18n.t('prof.confirm_clear'))) return;
      await ipcRenderer.invoke('profile:clear', p);
      renderProfiles();
    });
    const db = q('[data-act="delete"]');
    if (db) db.addEventListener('click', async () => {
      if (!confirm(i18n.t('prof.confirm_delete'))) return;
      await ipcRenderer.invoke('profile:clear', p);
      await removeProfile(p.id);
      if (settings.defaultProfileId === p.id) { settings.defaultProfileId = profiles[0] ? profiles[0].id : null; await saveSettings(); }
      if (windowProfileId === p.id) windowProfileId = settings.defaultProfileId || (profiles[0] && profiles[0].id);
      refreshProfileChip();
      updateCounts();
      renderProfiles();
    });
    list.appendChild(card);
    if (window.XZAutoLogin) XZAutoLogin.decorateProfileCard(card, p);
    ipcRenderer.invoke('profile:stats', p).then((s) => {
      if (!document.body.contains(card)) return;
      const el = card.querySelector('[data-stat="cookies"]');
      if (el) el.textContent = (s && Number.isFinite(s.cookies)) ? s.cookies : 0;
    }).catch(() => {
      const el = card.querySelector('[data-stat="cookies"]');
      if (el) el.textContent = '0';
    });
  }
}
// ---- Profile ordering: array order == the Cmd+1..9 order ----
function moveProfile(id, delta) {
  const ids = profiles.map(p => p.id);
  const from = ids.indexOf(id);
  if (from < 0) return Promise.resolve(profiles);
  const to = from + delta;
  if (to < 0 || to >= ids.length) return Promise.resolve(profiles);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  return reorderProfiles(ids).then(() => { renderProfiles(); refreshProfileChip(); });
}
function clearProfileDropHints() {
  document.querySelectorAll('#profile-list .profile-card').forEach(el => {
    el.classList.remove('drop-before', 'drop-after', 'dragging');
  });
}
function wireProfileOrderControls(card, p, viewIndex, view, canMove) {
  const up = card.querySelector('[data-act="move-up"]');
  const down = card.querySelector('[data-act="move-down"]');
  if (up) {
    if (!canMove || viewIndex === 0) up.disabled = true;
    up.addEventListener('click', (e) => { e.stopPropagation(); if (!up.disabled) moveProfile(p.id, -1); });
  }
  if (down) {
    if (!canMove || viewIndex === view.length - 1) down.disabled = true;
    down.addEventListener('click', (e) => { e.stopPropagation(); if (!down.disabled) moveProfile(p.id, 1); });
  }
  // Dragging only makes sense while the view mirrors the stored order.
  if (!canMove) { card.draggable = false; return; }
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    profileDragId = p.id;
    card.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
    } catch (err) {}
  });
  card.addEventListener('dragend', () => {
    profileDragId = null;
    clearProfileDropHints();
    if (profileRenderPending) { profileRenderPending = false; renderProfiles(); }
  });
  card.addEventListener('dragover', (e) => {
    if (profileDragId == null || profileDragId === p.id) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
    const box = card.getBoundingClientRect();
    const after = (e.clientY - box.top) > box.height / 2;
    card.classList.toggle('drop-before', !after);
    card.classList.toggle('drop-after', after);
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const after = card.classList.contains('drop-after');
    const dragId = profileDragId;
    profileDragId = null;
    profileRenderPending = false;
    clearProfileDropHints();
    if (!dragId || dragId === p.id) return;
    const ids = profiles.map(x => x.id);
    const from = ids.indexOf(dragId);
    if (from < 0) return;
    ids.splice(from, 1);
    let target = ids.indexOf(p.id);
    if (target < 0) return;
    if (after) target += 1;
    ids.splice(target, 0, dragId);
    reorderProfiles(ids).then(() => { renderProfiles(); refreshProfileChip(); });
  });
}
function setProfileOrderView(mode) {
  profileOrderView = mode === 'recent' ? 'recent' : 'manual';
  renderProfiles();
}
$('profile-order-manual').addEventListener('click', () => setProfileOrderView('manual'));
$('profile-order-recent').addEventListener('click', () => setProfileOrderView('recent'));
$('profile-apply-order').addEventListener('click', async () => {
  // "Recently used" is display-only until the user commits it.
  const ids = profilesForView().map(p => p.id);
  await reorderProfiles(ids);
  profileOrderView = 'manual';
  refreshProfileChip();
  renderProfiles();
});
$('profile-create-btn').addEventListener('click', async () => {
  ensureProfiles();
  // main's upsert unshifts unknown ids, so a new profile lands on top (= Cmd+1).
  const profile = makeProfile(nextProfileName());
  editingProfileId = profile.id;
  profileEditDraft = { id: profile.id, name: profile.name, color: profile.color, caret: null, fresh: true };
  profileOrderView = 'manual';
  await upsertProfile(profile);
  if (!settings.defaultProfileId) {
    settings.defaultProfileId = profile.id;
    await saveSettings();
  }
  refreshProfileChip();
  updateCounts();
  renderProfiles();
});

// ---------- Accounts ----------
function ensureAccountIds() {
  let changed = false;
  for (const p of passwords) {
    if (!p.id) {
      p.id = 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      changed = true;
    }
  }
  if (changed) savePasswords();
}
function normalizeGameUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return homeUrl;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
  return 'http://' + raw;
}
function hostFromAccountUrl(url) {
  try { return new URL(normalizeGameUrl(url)).hostname.replace(/^www\./, ''); }
  catch (e) { return normalizeHost(url); }
}
function accountTitle(account) {
  return account.gameName || account.title || account.host || account.username || i18n.t('acct.untitled');
}
function accountUrl(account) {
  return normalizeGameUrl(account.gameUrl || account.url || account.host || homeUrl);
}
function accountSpeed(account) {
  const n = Number(account.speedFactor);
  return Number.isFinite(n) && n > 0 ? Math.max(0.5, Math.min(10, n)) : 1;
}
async function applyAccountSpeed(account) {
  const factor = accountSpeed(account);
  const profile = Number.isFinite(Number(account.speedProfile)) ? Number(account.speedProfile) : speedProfileCode();
  const next = await ipcRenderer.invoke('speed:set', factor, profile);
  speedFactor = next || factor;
  updateSpeedIndicator();
}
async function openAccount(account) {
  if (!account) return;
  await applyAccountSpeed(account);
  ipcRenderer.invoke('window:open', accountUrl(account), account.profileId || settings.defaultProfileId);
}
function selectedAccounts() {
  return Array.from(document.querySelectorAll('#acct-list input[data-account-id]:checked'))
    .map(input => passwords.find(p => p.id === input.dataset.accountId))
    .filter(Boolean);
}
async function openSelectedAccounts(grid) {
  const selected = selectedAccounts();
  if (!selected.length) return;
  await applyAccountSpeed(selected[0]);
  const payload = selected.map(account => ({
    url: accountUrl(account),
    profileId: account.profileId || settings.defaultProfileId,
  }));
  if (grid) {
    ipcRenderer.invoke('window:open-accounts-grid', payload);
    return;
  }
  payload.forEach((account, index) => {
    setTimeout(() => ipcRenderer.invoke('window:open', account.url, account.profileId), Math.min(8000, index * 700));
  });
}
function openAccountEditor(account) {
  ensureProfiles();
  editingAccountId = account && account.id ? account.id : null;
  $('acct-game-name').value = account ? (account.gameName || account.title || '') : '';
  $('acct-game-url').value = account ? accountUrl(account) : (activeTab() ? activeTab().url : homeUrl);
  $('acct-username').value = account ? (account.username || '') : '';
  $('acct-password').value = account ? (account.password || '') : '';
  $('acct-note').value = account ? (account.note || '') : '';
  $('acct-speed').value = account ? String(accountSpeed(account)) : String(speedFactor || 1);
  const sel = $('acct-profile');
  sel.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if ((account && account.profileId === p.id) || (!account && p.id === windowProfileId)) opt.selected = true;
    sel.appendChild(opt);
  }
  $('acct-delete').style.display = account ? '' : 'none';
  $('account-edit-modal').style.display = 'block';
  setTimeout(() => $('acct-game-name').focus(), 30);
}
function closeAccountEditor() {
  editingAccountId = null;
  $('account-edit-modal').style.display = 'none';
}
async function saveAccountEditor() {
  const gameUrl = normalizeGameUrl($('acct-game-url').value);
  const host = hostFromAccountUrl(gameUrl);
  const username = $('acct-username').value.trim();
  const password = $('acct-password').value;
  const profileId = $('acct-profile').value || settings.defaultProfileId;
  if (!host || !password) return;
  const existing = editingAccountId ? passwords.find(p => p.id === editingAccountId) : null;
  const idx = existing ? passwords.indexOf(existing) :
    passwords.findIndex(p => normalizeHost(p.host) === normalizeHost(host) && p.profileId === profileId && p.username === username);
  const previous = idx >= 0 ? passwords[idx] : {};
  const entry = Object.assign({}, previous, {
    id: previous.id || editingAccountId || ('acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
    gameName: $('acct-game-name').value.trim() || host,
    gameUrl,
    host,
    username,
    password,
    profileId,
    note: $('acct-note').value.trim(),
    speedFactor: accountSpeed({ speedFactor: $('acct-speed').value }),
    speedProfile: speedProfileCode(),
    updatedAt: Date.now(),
  });
  if (idx >= 0) passwords[idx] = entry;
  else passwords.unshift(entry);
  await savePasswords();
  closeAccountEditor();
  renderAccounts();
  if (currentRoute === 'settings') renderPasswords();
}
function renderAccounts() {
  ensureAccountIds();
  const q = ($('acct-search').value || '').toLowerCase();
  const items = passwords.filter(account => {
    const prof = profileById(account.profileId);
    const text = [accountTitle(account), account.host, account.username, account.note, prof && prof.name].join(' ').toLowerCase();
    return !q || text.includes(q);
  });
  $('acct-count').textContent = items.length + ' ' + i18n.t(items.length === 1 ? 'common.item' : 'common.items');
  const list = $('acct-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = placeholderHtml(i18n.t('acct.empty'), EMPTY_ASSETS.windows, 'padding:24px;height:auto;');
    return;
  }
  for (const account of items.slice(0, LIST_RENDER_LIMIT)) {
    const row = document.createElement('div');
    row.className = 'entry account-row';
    const prof = profileById(account.profileId);
    const title = accountTitle(account);
    row.innerHTML =
      '<div class="check-cell"><input type="checkbox" data-account-id="' + escapeHtml(account.id) + '"></div>' +
      '<div class="e-cover" style="background:' + (prof ? prof.color : '#888') + '">' + escapeHtml((account.username || title || '?')[0].toUpperCase()) + '</div>' +
      '<div class="e-text">' +
        '<div class="e-title">' + escapeHtml(title) + ' <span style="color:var(--text-secondary);font-weight:400;font-size:11px;"> · ' + escapeHtml(account.username || '') + '</span></div>' +
        '<div class="account-meta">' + escapeHtml(prof ? prof.name : '-') + ' · ' + escapeHtml(account.host || hostFromAccountUrl(accountUrl(account))) +
          ' · ' + accountSpeed(account) + 'x' + (account.note ? ' · ' + escapeHtml(account.note) : '') + '</div>' +
      '</div>' +
      '<div class="e-actions">' +
        '<button data-act="open">' + escapeHtml(i18n.t('common.open')) + '</button>' +
        '<button data-act="edit">' + escapeHtml(i18n.t('prof.edit')) + '</button>' +
        '<button data-act="del">' + escapeHtml(i18n.t('pw.delete')) + '</button>' +
      '</div>';
    row.querySelector('[data-act="open"]').addEventListener('click', () => openAccount(account));
    row.querySelector('[data-act="edit"]').addEventListener('click', () => openAccountEditor(account));
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(i18n.t('acct.confirm_delete'))) return;
      const i = passwords.indexOf(account);
      if (i >= 0) passwords.splice(i, 1);
      await savePasswords();
      renderAccounts();
    });
    list.appendChild(row);
  }
}
$('acct-search').addEventListener('input', renderAccounts);
$('acct-add-btn').addEventListener('click', () => openAccountEditor(null));
$('acct-open-selected').addEventListener('click', () => openSelectedAccounts(false));
$('acct-grid-selected').addEventListener('click', () => openSelectedAccounts(true));
$('acct-cancel').addEventListener('click', closeAccountEditor);
$('acct-save').addEventListener('click', saveAccountEditor);
$('acct-delete').addEventListener('click', async () => {
  const account = editingAccountId ? passwords.find(p => p.id === editingAccountId) : null;
  if (!account) return;
  if (!confirm(i18n.t('acct.confirm_delete'))) return;
  const i = passwords.indexOf(account);
  if (i >= 0) passwords.splice(i, 1);
  await savePasswords();
  closeAccountEditor();
  renderAccounts();
});

// ---------- Game Doctor ----------
function doctorProfile() {
  ensureProfiles();
  return profileById(windowProfileId) || profileById(settings.defaultProfileId) || profiles[0] || null;
}
function doctorLog(message) {
  const el = $('doctor-log');
  if (!el) return;
  el.textContent = message ? (new Date().toLocaleTimeString() + ' · ' + message) : '';
}
function renderDoctor() {
  const tab = activeTab();
  const profile = doctorProfile();
  const speed = Math.round((speedFactor || 1) * 100) / 100;
  const url = tab ? (tab.title && tab.title !== tab.url ? tab.title + ' · ' + tab.url : tab.url) : i18n.t('doctor.no_tab');
  $('doctor-current').textContent = (profile ? profile.name : '-') + ' · ' + speed + 'x · ' + url;
}
async function clearDoctorProfile(profile) {
  if (!profile) return false;
  await ipcRenderer.invoke('profile:clear', profile);
  return true;
}
async function resetDoctorTab() {
  await setSpeedFactor(1);
  const tab = activeTab();
  if (tab) {
    tab.fit = false;
    tab.zoom = 1;
    try { tab.webview.setZoomFactor(1); } catch (e) {}
    try {
      if (typeof tab.webview.reloadIgnoringCache === 'function') tab.webview.reloadIgnoringCache();
      else tab.webview.reload();
    } catch (e) {}
  }
  updateZoomIndicator();
  renderDoctor();
}
$('doctor-repair').addEventListener('click', async () => {
  const profile = doctorProfile();
  if (profile && !confirm(i18n.t('doctor.confirm_profile'))) return;
  doctorLog('');
  await clearDoctorProfile(profile);
  await resetDoctorTab();
  doctorLog(i18n.t('doctor.done'));
});
$('doctor-reset-tab').addEventListener('click', async () => {
  doctorLog('');
  await resetDoctorTab();
  doctorLog(i18n.t('doctor.done'));
});
$('doctor-clear-profile').addEventListener('click', async () => {
  const profile = doctorProfile();
  if (!profile || !confirm(i18n.t('doctor.confirm_profile'))) return;
  doctorLog('');
  await clearDoctorProfile(profile);
  doctorLog(i18n.t('doctor.done'));
});
$('doctor-clear-all').addEventListener('click', async () => {
  if (!confirm(i18n.t('doctor.confirm_all'))) return;
  doctorLog('');
  await ipcRenderer.invoke('data:clear-cookies-cache-all');
  doctorLog(i18n.t('doctor.done'));
});
$('doctor-tile-grid').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('window:tile-grid');
  doctorLog(i18n.t('doctor.done') + ' ' + ((result && result.tiled) || 0) + ' ' + i18n.t('common.windows'));
});

// ---------- Settings ----------
function themeSwatches(theme) {
  if (theme && theme.id === 'custom') {
    const c = customTheme().colors;
    return [c.background, c.accent, c.soft];
  }
  return (theme && theme.swatches) || THEMES[0].swatches;
}
function renderAppearanceSummary() {
  const group = $('appearance-group');
  const panel = $('appearance-panel');
  const name = $('appearance-current-name');
  const swatches = $('appearance-current-swatches');
  if (!group || !panel || !name || !swatches) return;
  const theme = currentTheme();
  group.classList.toggle('open', appearanceExpanded);
  panel.hidden = !appearanceExpanded;
  name.textContent = i18n.t(theme.nameKey);
  swatches.innerHTML = themeSwatches(theme).map(color =>
    '<span class="swatch" style="background:' + color + '"></span>'
  ).join('');
}
function renderCustomPreview(preview) {
  const c = customTheme().colors;
  preview.classList.add('custom-preview');
  preview.style.setProperty('--preview-bg', c.background);
  preview.style.setProperty('--preview-panel', c.panel);
  preview.style.setProperty('--preview-soft', rgba(c.soft, 0.7));
  if (customTheme().badgeImage) preview.style.setProperty('--custom-badge-preview', cssImage(customTheme().badgeImage, ''));
  else preview.style.removeProperty('--custom-badge-preview');
  const mark = document.createElement('div');
  mark.className = 'custom-preview-mark';
  preview.appendChild(mark);
}
function renderThemeGrid() {
  const grid = $('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const theme of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-card' + (theme.id === currentTheme().id ? ' active' : '');
    btn.dataset.theme = theme.id;
    const preview = document.createElement('div');
    preview.className = 'theme-preview';
    if (theme.custom) renderCustomPreview(preview);
    else preview.style.backgroundImage = 'url(' + assetUrl('theme-preview-' + theme.id + '.png') + ')';
    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const color of themeSwatches(theme)) {
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = color;
      swatches.appendChild(swatch);
    }
    const title = document.createElement('div');
    title.className = 'theme-title';
    title.textContent = i18n.t(theme.nameKey);
    const desc = document.createElement('div');
    desc.className = 'theme-desc';
    desc.textContent = i18n.t(theme.descKey);
    btn.appendChild(preview);
    btn.appendChild(swatches);
    btn.appendChild(title);
    btn.appendChild(desc);
    btn.addEventListener('click', () => {
      if (theme.custom) appearanceExpanded = true;
      setTheme(theme.id);
    });
    grid.appendChild(btn);
  }
}
function renderCustomThemeEditor() {
  const root = $('custom-theme-editor');
  if (!root) return;
  const theme = customTheme();
  root.innerHTML = '';
  const colorGrid = document.createElement('div');
  colorGrid.className = 'custom-color-grid';
  for (const [key, labelKey] of CUSTOM_COLOR_FIELDS) {
    const field = document.createElement('div');
    field.className = 'custom-color-field';
    const label = document.createElement('label');
    label.textContent = i18n.t(labelKey);
    const input = document.createElement('input');
    input.type = 'color';
    input.value = theme.colors[key];
    input.addEventListener('input', () => updateCustomColor(key, input.value));
    field.appendChild(label);
    field.appendChild(input);
    colorGrid.appendChild(field);
  }
  const assets = document.createElement('div');
  assets.className = 'custom-assets';
  assets.appendChild(makeAssetEditor('badge', i18n.t('theme.custom_badge'), 512, 512));
  assets.appendChild(makeAssetEditor('mascot', i18n.t('theme.custom_mascot'), 1024, 720));
  root.appendChild(colorGrid);
  root.appendChild(assets);
}
function updateCustomColor(key, value) {
  if (!isHexColor(value)) return;
  const theme = customTheme();
  theme.colors[key] = value;
  settings.customTheme = theme;
  if (settings.theme !== 'custom') settings.theme = 'custom';
  applyTheme();
  renderThemeGrid();
  renderAppearanceSummary();
  reRenderCurrent();
  scheduleCustomThemeSave();
}
function scheduleCustomThemeSave() {
  clearTimeout(customThemeSaveTimer);
  customThemeSaveTimer = setTimeout(() => saveSettings(), 220);
}
function makeAssetEditor(kind, title, outW, outH) {
  const editor = document.createElement('div');
  editor.className = 'asset-editor';
  const titleEl = document.createElement('div');
  titleEl.className = 'asset-title';
  titleEl.textContent = title;
  const wrap = document.createElement('div');
  wrap.className = 'asset-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.width = kind === 'badge' ? 160 : 210;
  canvas.height = 150;
  wrap.appendChild(canvas);
  const actions = document.createElement('div');
  actions.className = 'asset-actions';
  const upload = document.createElement('label');
  upload.textContent = i18n.t('theme.custom_upload');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  upload.appendChild(file);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = i18n.t('theme.custom_reset_asset');
  actions.appendChild(upload);
  actions.appendChild(reset);
  const state = {
    kind,
    outW,
    outH,
    scale: 100,
    offsetX: 0,
    offsetY: 0,
    tolerance: 54,
    transparent: true,
    image: null,
    canvas,
  };
  const controls = [
    makeAssetRange(state, 'scale', i18n.t('theme.custom_scale'), 40, 220, 1),
    makeAssetRange(state, 'offsetX', i18n.t('theme.custom_x'), -100, 100, 1),
    makeAssetRange(state, 'offsetY', i18n.t('theme.custom_y'), -100, 100, 1),
    makeAssetRange(state, 'tolerance', i18n.t('theme.custom_tolerance'), 0, 140, 1),
    makeAssetCheck(state, 'transparent', i18n.t('theme.custom_transparent')),
  ];
  file.addEventListener('change', () => {
    const selected = file.files && file.files[0];
    if (selected) loadEditorImage(selected, state);
  });
  reset.addEventListener('click', () => {
    const theme = customTheme();
    if (kind === 'badge') theme.badgeImage = null;
    else theme.mascotImage = null;
    settings.customTheme = theme;
    if (settings.theme === 'custom') applyTheme();
    renderThemeGrid();
    renderAppearanceSummary();
    reRenderCurrent();
    saveSettings();
    renderCustomThemeEditor();
  });
  editor.appendChild(titleEl);
  editor.appendChild(wrap);
  editor.appendChild(actions);
  for (const control of controls) editor.appendChild(control);
  drawExistingAssetPreview(state);
  return editor;
}
function makeAssetRange(state, key, labelText, min, max, step) {
  const row = document.createElement('div');
  row.className = 'asset-control';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(state[key]);
  input.addEventListener('input', () => {
    state[key] = Number(input.value);
    processEditorAsset(state);
  });
  row.appendChild(label);
  row.appendChild(input);
  return row;
}
function makeAssetCheck(state, key, labelText) {
  const row = document.createElement('div');
  row.className = 'asset-control';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!state[key];
  input.addEventListener('change', () => {
    state[key] = input.checked;
    processEditorAsset(state);
  });
  row.appendChild(label);
  row.appendChild(input);
  return row;
}
function drawExistingAssetPreview(state) {
  const theme = customTheme();
  const value = state.kind === 'badge' ? theme.badgeImage : theme.mascotImage;
  const fallback = state.kind === 'badge' ? assetUrl('badge-wolf-wheat-browser.png') : assetUrl('mascot-wolf-wheat-tiny-footer.png');
  const img = new Image();
  img.onload = () => drawImageToPreview(state.canvas, img);
  img.src = value || fallback;
}
function drawImageToPreview(canvas, img) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}
function loadEditorImage(file, state) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      processEditorAsset(state);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
function processEditorAsset(state) {
  if (!state.image) return;
  const out = document.createElement('canvas');
  out.width = state.outW;
  out.height = state.outH;
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, out.width, out.height);
  const baseScale = Math.min(out.width / state.image.width, out.height / state.image.height);
  const scale = baseScale * (state.scale / 100);
  const w = state.image.width * scale;
  const h = state.image.height * scale;
  const x = (out.width - w) / 2 + (state.offsetX / 100) * out.width * 0.35;
  const y = (out.height - h) / 2 + (state.offsetY / 100) * out.height * 0.35;
  ctx.drawImage(state.image, x, y, w, h);
  if (state.transparent) removeEdgeBackground(ctx, out.width, out.height, state.tolerance, {
    x0: Math.max(0, Math.floor(x)),
    y0: Math.max(0, Math.floor(y)),
    x1: Math.min(out.width - 1, Math.ceil(x + w) - 1),
    y1: Math.min(out.height - 1, Math.ceil(y + h) - 1),
  });
  const img = new Image();
  img.onload = () => drawImageToPreview(state.canvas, img);
  const dataUrl = out.toDataURL('image/png');
  img.src = dataUrl;
  const theme = customTheme();
  if (state.kind === 'badge') theme.badgeImage = dataUrl;
  else theme.mascotImage = dataUrl;
  settings.customTheme = theme;
  if (settings.theme !== 'custom') settings.theme = 'custom';
  applyTheme();
  renderThemeGrid();
  renderAppearanceSummary();
  reRenderCurrent();
  scheduleCustomThemeSave();
}
function removeEdgeBackground(ctx, width, height, tolerance, rect) {
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const box = rect || { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  const mx = Math.floor((box.x0 + box.x1) / 2);
  const my = Math.floor((box.y0 + box.y1) / 2);
  const samples = [[box.x0,box.y0], [box.x1,box.y0], [box.x0,box.y1], [box.x1,box.y1], [mx,box.y0], [mx,box.y1], [box.x0,my], [box.x1,my]].map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });
  const seen = new Uint8Array(width * height);
  const queue = [];
  const tol2 = tolerance * tolerance;
  function nearBg(pos) {
    const i = pos * 4;
    for (const s of samples) {
      const dr = data[i] - s[0], dg = data[i + 1] - s[1], db = data[i + 2] - s[2];
      if (dr * dr + dg * dg + db * db <= tol2) return true;
    }
    return false;
  }
  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pos = y * width + x;
    if (seen[pos] || !nearBg(pos)) return;
    seen[pos] = 1;
    queue.push(pos);
  }
  for (let x = box.x0; x <= box.x1; x++) { push(x, box.y0); push(x, box.y1); }
  for (let y = box.y0; y <= box.y1; y++) { push(box.x0, y); push(box.x1, y); }
  for (let q = 0; q < queue.length; q++) {
    const pos = queue[q];
    const x = pos % width;
    const y = Math.floor(pos / width);
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  for (const pos of queue) data[pos * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
}
function makeShortcutCaptureButton(type, key, index, shortcut) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'shortcut-capture';
  btn.textContent = shortcutDisplay(shortcut);
  btn.addEventListener('click', () => startShortcutCapture(type, key, index, btn));
  return btn;
}
function renderSpeedShortcutRows() {
  const root = $('speed-shortcut-list');
  if (!root) return;
  settings.speedShortcuts = normalizeSpeedShortcuts(settings.speedShortcuts);
  root.innerHTML = '';
  const rows = [
    ['prev', 'shortcut.speed_prev'],
    ['next', 'shortcut.speed_next'],
    ['reset', 'shortcut.speed_reset'],
    ['measure', 'shortcut.measure_toggle'],
    ['screenshot', 'shortcut.screenshot'],
    ['aim', 'shortcut.aim'],
  ];
  for (const [key, labelKey] of rows) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    row.innerHTML = '<div><div class="label">' + escapeHtml(i18n.t(labelKey)) + '</div></div>';
    row.appendChild(makeShortcutCaptureButton('speed-shortcut', key, null, settings.speedShortcuts[key]));
    root.appendChild(row);
  }
}
function renderSpeedHotkeyRows() {
  const root = $('speed-hotkey-list');
  if (!root) return;
  settings.speedHotkeys = normalizeSpeedHotkeys(settings.speedHotkeys);
  root.innerHTML = '';
  settings.speedHotkeys.forEach((hotkey, index) => {
    const row = document.createElement('div');
    row.className = 'shortcut-row speed-hotkey-row';
    const label = document.createElement('div');
    label.innerHTML = '<div class="label">' + escapeHtml(i18n.t('shortcut.speed_slot').replace('{n}', index + 1)) + '</div>';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.5';
    input.max = '10';
    input.step = '0.25';
    input.value = String(hotkey.factor);
    input.addEventListener('change', async () => {
      const n = clampSpeedPreset(input.value);
      if (n == null) {
        input.value = String(hotkey.factor);
        return;
      }
      settings.speedHotkeys[index].factor = n;
      await saveSettings();
      renderSpeedToolSettings();
    });
    const action = document.createElement('div');
    action.className = 'shortcut-action';
    action.appendChild(input);
    action.appendChild(makeShortcutCaptureButton('speed-hotkey', null, index, hotkey.shortcut));
    row.appendChild(label);
    row.appendChild(action);
    root.appendChild(row);
  });
}
function renderSpeedPresets() {
  const root = $('speed-preset-list');
  if (!root) return;
  settings.speedPresets = normalizeSpeedPresets(settings.speedPresets);
  root.innerHTML = '';
  for (const preset of settings.speedPresets) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'speed-preset-chip' + (Math.abs((speedFactor || 1) - preset) < 0.01 ? ' active' : '');
    chip.innerHTML = '<span>' + preset + 'x</span><span class="remove">×</span>';
    chip.addEventListener('click', (ev) => {
      if (ev.target && ev.target.classList.contains('remove')) return;
      setSpeedFactor(preset);
    });
    chip.querySelector('.remove').addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeSpeedPreset(preset);
    });
    root.appendChild(chip);
  }
}
function renderMeasureSettings() {
  const el = $('measure-scale-setting');
  if (!el) return;
  const scale = normalizeMeasureSettings(settings.measure).scalePixelsPer10;
  el.textContent = scale
    ? i18n.t('measure.scale_value').replace('{px}', Math.round(scale))
    : i18n.t('measure.scale_empty');
}
function renderSpeedToolSettings() {
  renderSpeedPresets();
  renderSpeedShortcutRows();
  renderSpeedHotkeyRows();
  renderMeasureSettings();
}
// The fixed-address box only means anything in 'custom' mode. Disable and dim it in the
// other two rather than hiding the row, so the settings page does not jump around.
function updateNewTabUrlRow() {
  const row = $('setting-new-tab-url-row');
  const input = $('setting-new-tab-url');
  const on = settings.newTabMode === 'custom';
  if (input) input.disabled = !on;
  if (row) row.style.opacity = on ? '' : '0.45';
}
function renderSettings() {
  // Identity inputs
  const id = settings.identity || {};
  $('id-name').value = id.name || '';
  $('id-sub').value = id.sub || '';
  $('id-bubble').value = id.bubble || '';
  $('id-home-sub').value = id.homeSub || '';
  $('id-name').placeholder = i18n.t('brand.name');
  $('id-sub').placeholder = i18n.t('brand.sub');
  $('id-bubble').placeholder = i18n.t('sidebar.bubble');
  $('id-home-sub').placeholder = i18n.t('home.subtitle');
  // Language select
  const langSel = $('setting-language');
  langSel.value = settings.language || 'zh-CN';
  // Default profile select
  const dpSel = $('setting-default-profile');
  dpSel.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    if (p.id === settings.defaultProfileId) opt.selected = true;
    dpSel.appendChild(opt);
  }
  // New-tab destination
  const ntSel = $('setting-new-tab-mode');
  ntSel.value = NEW_TAB_MODES.includes(settings.newTabMode) ? settings.newTabMode : 'current';
  $('setting-new-tab-url').value = settings.newTabUrl || '';
  updateNewTabUrlRow();
  // Switches
  setSwitch($('setting-glass'), settings.glassEffect !== false);
  setSwitch($('setting-restore-session'), !!settings.restoreSession);
  setSwitch($('setting-sidebar-collapsed'), !!settings.sidebarCollapsed);
  setSwitch($('setting-show-quick-note'), settings.showQuickNote !== false);
  renderAppearanceSummary();
  renderThemeGrid();
  renderCustomThemeEditor();
  renderSpeedToolSettings();
  // Passwords list
  renderPasswords();
}
function setSwitch(el, on) { el.classList.toggle('on', !!on); }
function attachSwitch(el, onChange) {
  el.addEventListener('click', () => {
    const now = !el.classList.contains('on');
    setSwitch(el, now);
    onChange(now);
  });
}
function bindIdentityInput(key, el) {
  let debounce;
  el.addEventListener('input', () => {
    settings.identity = settings.identity || {};
    settings.identity[key] = el.value;
    applyIdentity();
    clearTimeout(debounce);
    debounce = setTimeout(() => saveSettings(), 250);
  });
}
bindIdentityInput('name',    $('id-name'));
bindIdentityInput('sub',     $('id-sub'));
bindIdentityInput('bubble',  $('id-bubble'));
bindIdentityInput('homeSub', $('id-home-sub'));
$('id-reset').addEventListener('click', async () => {
  settings.identity = {};
  await saveSettings();
  applyIdentity();
  renderSettings();
});

$('appearance-toggle').addEventListener('click', () => {
  appearanceExpanded = !appearanceExpanded;
  renderAppearanceSummary();
});
$('setting-language').addEventListener('change', async (e) => {
  settings.language = e.target.value;
  await saveSettings();
  applyLanguage();
});
$('setting-default-profile').addEventListener('change', async (e) => {
  settings.defaultProfileId = e.target.value;
  await saveSettings();
  refreshProfileChip();
});
$('setting-new-tab-mode').addEventListener('change', async (e) => {
  settings.newTabMode = NEW_TAB_MODES.includes(e.target.value) ? e.target.value : 'current';
  updateNewTabUrlRow();
  await saveSettings();
});
let newTabUrlSaveTimer = null;
$('setting-new-tab-url').addEventListener('input', (e) => {
  settings.newTabUrl = e.target.value;
  clearTimeout(newTabUrlSaveTimer);
  newTabUrlSaveTimer = setTimeout(() => { newTabUrlSaveTimer = null; saveSettings(); }, 250);
});
attachSwitch($('setting-restore-session'), async (v) => { settings.restoreSession = v; await saveSettings(); });
attachSwitch($('setting-glass'), async (v) => { settings.glassEffect = v; setGlass(v); await saveSettings(); });
attachSwitch($('setting-sidebar-collapsed'), async (v) => { settings.sidebarCollapsed = v; await saveSettings(); });
attachSwitch($('setting-show-quick-note'), async (v) => {
  await setQuickNoteVisible(v);
});
$('setting-speed-preset-add').addEventListener('click', async () => {
  const input = $('setting-speed-preset-input');
  const ok = await addSpeedPreset(input.value);
  if (ok) input.value = '';
});
$('setting-speed-preset-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const ok = await addSpeedPreset(e.target.value);
  if (ok) e.target.value = '';
});
$('setting-speed-presets-reset').addEventListener('click', resetSpeedPresets);
$('measure-scale-clear').addEventListener('click', clearMeasureScale);
$('setting-clear-history').addEventListener('click', async () => {
  history = []; await saveHistory();
  alert(i18n.t('set.data_cleared'));
  if (currentRoute === 'recent') renderRecent();
  else if (currentRoute === 'home') renderHomeContinue();
});
$('setting-clear-cookies').addEventListener('click', async () => {
  await ipcRenderer.invoke('data:clear-cookies-cache-all');
  alert(i18n.t('set.data_cleared'));
});

// ---------- Passwords ----------
function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}
function hostMatches(savedHost, pageHost) {
  const saved = normalizeHost(savedHost);
  const page = normalizeHost(pageHost);
  return saved === page || page.endsWith('.' + saved) || saved.endsWith('.' + page);
}
function findCredential(profileId, host) {
  return findAllCredentials(profileId, host)[0] || null;
}
function findAllCredentials(profileId, host) {
  return passwords
    .filter(p => p.profileId === profileId && hostMatches(p.host, host))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// ----- Multi-account picker UI -----
function showAccountPicker(tab, host, credentials) {
  $('ap-site').textContent = host;
  const list = $('ap-list');
  list.innerHTML = '';
  const sorted = credentials.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of sorted) {
    const prof = profileById(c.profileId);
    const row = document.createElement('div');
    row.className = 'ap-account';
    const letter = ((c.username || '?')[0] || '?').toUpperCase();
    row.innerHTML =
      '<div class="ap-avatar" style="background:' + (prof ? prof.color : '#888') + '">' + escapeHtml(letter) + '</div>' +
      '<div class="ap-main">' +
        '<div class="ap-user">' + escapeHtml(c.username || i18n.t('pw.no_username')) + '</div>' +
        '<div class="ap-profile">' + escapeHtml(prof ? prof.name : '-') + '</div>' +
      '</div>';
    row.addEventListener('click', () => {
      try { tab.webview.send('pw:fill', { username: c.username, password: c.password }); } catch (e) {}
      hideAccountPicker();
    });
    list.appendChild(row);
  }
  $('account-picker').classList.add('visible');
}
function hideAccountPicker() { $('account-picker').classList.remove('visible'); }
$('ap-close').addEventListener('click', hideAccountPicker);

// Account indicator and manual 🔑 save button were removed from the top bar.
// Kept stub so calls from activateTab/setRoute don't throw.
function updateAccountIndicator() {}
function isSkipped(profileId, host) {
  const h = normalizeHost(host);
  return skippedSites.some(s => normalizeHost(s.host) === h && s.profileId === profileId);
}
function showSavePrompt({ host, username, password, profileId }) {
  pendingSavePrompt = { host, username, password, profileId };
  $('sp-site').textContent = host;
  $('sp-username').value = username || '';
  $('sp-password').value = password || '';
  const p = profileById(profileId); $('sp-profile').value = p ? p.name : '-';
  $('save-prompt').classList.add('visible');
}
function hideSavePrompt() {
  pendingSavePrompt = null;
  $('save-prompt').classList.remove('visible');
}
$('sp-save').addEventListener('click', async () => {
  if (!pendingSavePrompt) return;
  const u = $('sp-username').value;
  const pw = $('sp-password').value;
  const { host, profileId } = pendingSavePrompt;
  const cleanHost = normalizeHost(host);
  const idx = passwords.findIndex(p => normalizeHost(p.host) === cleanHost && p.profileId === profileId && p.username === u);
  const previous = idx >= 0 ? passwords[idx] : {};
  const entry = Object.assign({}, previous, {
    id: previous.id || ('acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
    gameName: previous.gameName || cleanHost,
    gameUrl: previous.gameUrl || normalizeGameUrl(cleanHost),
    host: cleanHost,
    username: u,
    password: pw,
    profileId,
    speedFactor: previous.speedFactor || 1,
    speedProfile: previous.speedProfile == null ? speedProfileCode() : previous.speedProfile,
    updatedAt: Date.now(),
  });
  if (idx >= 0) passwords[idx] = entry; else passwords.unshift(entry);
  await savePasswords();
  hideSavePrompt();
  if (currentRoute === 'settings') renderPasswords();
  else if (currentRoute === 'accounts') renderAccounts();
});
$('sp-not-now').addEventListener('click', () => hideSavePrompt());
$('sp-never').addEventListener('click', async () => {
  if (!pendingSavePrompt) return;
  const { host, profileId } = pendingSavePrompt;
  skippedSites.push({ host, profileId });
  await saveSkippedSites();
  hideSavePrompt();
});

function renderPasswords() {
  const q = ($('pw-search').value || '').toLowerCase();
  const items = q ? passwords.filter(p => (p.host || '').toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q)) : passwords;
  const list = $('pw-list'); list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = placeholderHtml(i18n.t('pw.empty'), EMPTY_ASSETS.notes, 'padding:20px;height:auto;');
    return;
  }
  for (const p of items.slice(0, LIST_RENDER_LIMIT)) {
    const row = document.createElement('div');
    row.className = 'entry';
    const prof = profileById(p.profileId);
    row.innerHTML =
      '<div class="e-cover">' + domainLetter('https://' + p.host) + '</div>' +
      '<div class="e-text">' +
        '<div class="e-title">' + escapeHtml(p.host) + ' <span style="color:var(--text-secondary);font-weight:400;font-size:11px;"> · ' + escapeHtml(p.username || '') + '</span></div>' +
        '<div class="e-url">' + escapeHtml(prof ? prof.name : '-') + ' · <span class="pw-val">••••••••</span></div>' +
      '</div>' +
      '<div class="e-actions">' +
        '<button data-act="reveal">' + escapeHtml(i18n.t('pw.reveal')) + '</button>' +
        '<button data-act="copy">' + escapeHtml(i18n.t('pw.copy')) + '</button>' +
        '<button data-act="del">' + escapeHtml(i18n.t('pw.delete')) + '</button>' +
      '</div>';
    const valSpan = row.querySelector('.pw-val');
    row.querySelector('[data-act="reveal"]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      const showing = valSpan.dataset.shown === '1';
      if (showing) { valSpan.textContent = '••••••••'; valSpan.dataset.shown = '0'; btn.textContent = i18n.t('pw.reveal'); }
      else { valSpan.textContent = p.password; valSpan.dataset.shown = '1'; btn.textContent = i18n.t('pw.hide'); }
    });
    row.querySelector('[data-act="copy"]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(p.password);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const i = passwords.indexOf(p);
      if (i >= 0) passwords.splice(i, 1);
      await savePasswords(); renderPasswords();
    });
    list.appendChild(row);
  }
}
$('pw-search').addEventListener('input', renderPasswords);

// ----- Manual add-password flow -----
function openAddPasswordModal() {
  const t = activeTab();
  const preHost = (t && t.currentHost) ? t.currentHost : (t ? hostOf(t.url) : '');
  $('ap-add-host').value = preHost;
  $('ap-add-user').value = '';
  $('ap-add-pw').value = '';
  // Populate profiles dropdown
  const sel = $('ap-add-profile'); sel.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    if (p.id === settings.defaultProfileId) opt.selected = true;
    sel.appendChild(opt);
  }
  $('add-pw-prompt').style.display = 'block';
  setTimeout(() => $('ap-add-user').focus(), 30);
}
function closeAddPasswordModal() { $('add-pw-prompt').style.display = 'none'; }
$('pw-add-btn').addEventListener('click', openAddPasswordModal);
$('ap-add-cancel').addEventListener('click', closeAddPasswordModal);
$('ap-add-save').addEventListener('click', async () => {
  const host = ($('ap-add-host').value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const username = $('ap-add-user').value;
  const password = $('ap-add-pw').value;
  const profileId = $('ap-add-profile').value;
  if (!host || !password) return;
  const idx = passwords.findIndex(p => p.host === host && p.profileId === profileId && p.username === username);
  const previous = idx >= 0 ? passwords[idx] : {};
  const entry = Object.assign({}, previous, {
    id: previous.id || ('acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
    gameName: previous.gameName || host,
    gameUrl: previous.gameUrl || normalizeGameUrl(host),
    host,
    username,
    password,
    profileId,
    speedFactor: previous.speedFactor || 1,
    speedProfile: previous.speedProfile == null ? speedProfileCode() : previous.speedProfile,
    updatedAt: Date.now(),
  });
  if (idx >= 0) passwords[idx] = entry; else passwords.unshift(entry);
  await savePasswords();
  closeAddPasswordModal();
  renderPasswords();
  if (currentRoute === 'accounts') renderAccounts();
});

function updateCounts() {
  if (currentRoute === 'favorites') renderFavorites();
  else if (currentRoute === 'recent') renderRecent();
  else if (currentRoute === 'windows') renderWindows();
  else if (currentRoute === 'accounts') renderAccounts();
}

// ---------- Report (monthly / yearly play summary) ----------
// main.js does all the aggregation in usageReport(); this route only draws what
// invoke('usage:report') hands back. Charts are plain divs sized by percentage --
// no chart library, nothing Chromium 87 lacks.
let reportScope = 'month';
let reportKey = beijingMonth();
let reportData = null;
let reportMonths = [];   // every 'YYYY-MM' we have ever seen data for, accumulated
let reportReqId = 0;     // guards against a slow reply overwriting a newer one

// "3 小时 20 分钟" / "45 分钟" / "不到 1 分钟"
function formatDurationMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60000) return tOr('report.under_minute', '不到 1 分钟');
  const totalMin = Math.floor(n / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const hUnit = i18n.t('common.hours');
  const mUnit = i18n.t('common.minutes');
  if (hours <= 0) return mins + ' ' + mUnit;
  if (mins <= 0) return hours + ' ' + hUnit;
  return hours + ' ' + hUnit + ' ' + mins + ' ' + mUnit;
}
// Big-number form for the overview tiles: one bold figure plus a small unit.
function statDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n >= 3600000) {
    const hours = n / 3600000;
    const text = hours >= 10 ? String(Math.round(hours)) : String(Math.round(hours * 10) / 10);
    return { value: text, unit: i18n.t('common.hours') };
  }
  return { value: String(Math.round(n / 60000)), unit: i18n.t('common.minutes') };
}
// Profile colours are user-entered data. Only a plain hex value is allowed into an
// inline style; anything else falls back to the theme accent.
function repColor(value, fallback) {
  return isHexColor(value) ? String(value) : (fallback || 'var(--main-orange)');
}
function reportMonthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return String(key || '');
  if (isZhLang()) return m[1] + '年' + Number(m[2]) + '月';
  return m[1] + '-' + m[2];
}
function reportYearLabel(key) {
  const y = String(key || '');
  return isZhLang() ? (y + '年') : y;
}
function reportKeyLabel(scope, key) {
  return scope === 'year' ? reportYearLabel(key) : reportMonthLabel(key);
}
function rememberReportMonths(list) {
  if (!Array.isArray(list)) return;
  for (const m of list) if (m && reportMonths.indexOf(m) < 0) reportMonths.push(m);
  reportMonths.sort();
}
// Newest first: the month or year you most likely want is the first option.
function reportPeriodValues() {
  const nowMonth = beijingMonth();
  const months = reportMonths.slice();
  if (months.indexOf(nowMonth) < 0) months.push(nowMonth);
  if (reportScope === 'month') {
    if (months.indexOf(reportKey) < 0) months.push(reportKey);
    return months.sort().reverse();
  }
  const years = [];
  for (const m of months) {
    const y = m.slice(0, 4);
    if (years.indexOf(y) < 0) years.push(y);
  }
  if (years.indexOf(reportKey) < 0) years.push(reportKey);
  return years.sort().reverse();
}
function paintReportPeriodSelect() {
  const sel = $('report-period');
  if (!sel) return;
  const values = reportPeriodValues();
  sel.innerHTML = '';
  for (const value of values) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = reportKeyLabel(reportScope, value);
    sel.appendChild(opt);
  }
  sel.value = reportKey;
  if (sel.value !== reportKey && values.length) { reportKey = values[0]; sel.value = reportKey; }
}
// Strings live here rather than in data-i18n so a missing key shows Chinese, not "report.title".
function paintReportStrings() {
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('nav-report-label', tOr('report.title', '报告'));
  set('report-title', tOr('report.title', '报告'));
  set('report-scope-month', tOr('report.month', '月报'));
  set('report-scope-year', tOr('report.year', '年报'));
  syncReportExportButton();
}
function setReportScope(scope) {
  const next = scope === 'year' ? 'year' : 'month';
  if (next === reportScope) return;
  if (next === 'year') {
    reportKey = reportKey.slice(0, 4);
  } else {
    const year = reportKey.slice(0, 4);
    const inYear = reportMonths.filter(m => m.slice(0, 4) === year);
    const nowMonth = beijingMonth();
    reportKey = inYear.length ? inYear[inYear.length - 1]
      : (nowMonth.slice(0, 4) === year ? nowMonth : year + '-01');
  }
  reportScope = next;
  renderReport();
}
function renderReport() {
  const month = $('report-scope-month');
  const year = $('report-scope-year');
  if (month) month.classList.toggle('active', reportScope === 'month');
  if (year) year.classList.toggle('active', reportScope === 'year');
  paintReportStrings();
  paintReportPeriodSelect();
  loadReport();
}
async function loadReport() {
  const id = ++reportReqId;
  const scope = reportScope;
  const key = reportKey;
  let data = null;
  try {
    data = await ipcRenderer.invoke('usage:report', { scope, key });
  } catch (e) {
    data = null;
  }
  if (id !== reportReqId) return;   // a newer switch already won the race
  rememberReportMonths(data && data.months);
  reportData = data;
  paintReportPeriodSelect();
  paintReportBody();
}

// A combination row's label: every account in its own colour, joined by plus
// signs. Works for two names or five; the old build could only ever draw two.
function comboLabel(combo, colorOf) {
  const names = Array.isArray(combo.names) ? combo.names : [];
  const colors = Array.isArray(combo.colors) ? combo.colors : [];
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    if (i) parts.push('<span class="rep-pair-plus">+</span>');
    parts.push('<span class="rep-pair-name" style="color:' + colorOf(colors[i], i) + '">' +
      escapeHtml(names[i] || '') + '</span>');
  }
  return parts.join('');
}
// Older reports only carry pairs; reshape them so one drawing path serves both.
function combosOf(data) {
  if (Array.isArray(data.combos) && data.combos.length) {
    return data.combos.filter(c => c && c.overlapMs > 0);
  }
  const pairs = Array.isArray(data.pairs) ? data.pairs.filter(p => p && p.overlapMs > 0) : [];
  return pairs.map(p => ({
    ids: [p.a, p.b],
    names: [p.nameA || p.a || '', p.nameB || p.b || ''],
    colors: [p.colorA, p.colorB],
    size: 2,
    overlapMs: p.overlapMs,
  }));
}

function repSection(title, desc) {
  const sec = document.createElement('div');
  sec.className = 'rep-section';
  const head = document.createElement('div');
  head.className = 'rep-sec-title';
  head.textContent = title;
  sec.appendChild(head);
  if (desc) {
    const d = document.createElement('div');
    d.className = 'rep-sec-desc';
    d.textContent = desc;
    sec.appendChild(d);
  }
  return sec;
}
// One horizontal bar. labelHtml is trusted markup built by the caller (names escaped).
function repBarRow(labelHtml, ratio, valueText, fillStyle, tip) {
  const row = document.createElement('div');
  row.className = 'rep-row';
  if (tip) row.title = tip;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  row.innerHTML =
    '<div class="rep-row-label">' + labelHtml + '</div>' +
    '<div class="rep-track"><div class="rep-fill" style="width:' + pct.toFixed(2) + '%' +
    (fillStyle ? ';' + fillStyle : '') + '"></div></div>' +
    '<div class="rep-row-val">' + escapeHtml(valueText) + '</div>';
  return row;
}
// A column chart plus its own sparse axis; values is an array of ms.
function repColumns(values, tickAt, labelFor, tipFor) {
  const wrap = document.createElement('div');
  const max = Math.max.apply(null, values.concat([1]));
  const bars = document.createElement('div');
  bars.className = 'rep-bars';
  let peak = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[peak]) peak = i;
  const anyData = values[peak] > 0;
  for (let i = 0; i < values.length; i++) {
    const bar = document.createElement('div');
    bar.className = 'rep-bar' + (anyData && i === peak ? ' peak' : '');
    if (tipFor) bar.title = tipFor(i, values[i]);
    const fill = document.createElement('div');
    fill.className = 'rep-bar-fill';
    fill.style.height = Math.max(2, Math.round((values[i] / max) * 100)) + '%';
    bar.appendChild(fill);
    bars.appendChild(bar);
  }
  wrap.appendChild(bars);
  const axis = document.createElement('div');
  axis.className = 'rep-axis';
  for (let i = 0; i < values.length; i++) {
    const tick = document.createElement('div');
    tick.className = 'rep-tick';
    tick.textContent = (!tickAt || tickAt.indexOf(i) >= 0) ? labelFor(i) : '';
    axis.appendChild(tick);
  }
  wrap.appendChild(axis);
  return { node: wrap, peak, anyData };
}

function paintReportBody() {
  const body = $('report-body');
  if (!body) return;
  body.innerHTML = '';
  const range = $('report-range');
  if (range) range.textContent = reportKeyLabel(reportScope, reportKey);
  const data = reportData;
  syncReportExportButton();
  if (!data || !(Number(data.totalMs) > 0)) {
    const empty = document.createElement('div');
    empty.className = 'rep-empty';
    empty.textContent = tOr('report.empty', '这段时间还没有游玩记录。');
    body.appendChild(empty);
    return;
  }

  // 1) Overview: the four numbers worth reading first.
  const stats = document.createElement('div');
  stats.className = 'rep-stats';
  const addStat = (value, unit, label) => {
    const card = document.createElement('div');
    card.className = 'rep-stat';
    card.innerHTML =
      '<div class="rep-stat-num">' + escapeHtml(String(value)) +
      (unit ? '<span class="rep-stat-unit">' + escapeHtml(unit) + '</span>' : '') + '</div>' +
      '<div class="rep-stat-label">' + escapeHtml(label) + '</div>';
    stats.appendChild(card);
  };
  const total = statDuration(data.totalMs);
  const longest = statDuration(data.longestSessionMs);
  addStat(total.value, total.unit, tOr('report.total_time', '总时长'));
  addStat(data.activeDays || 0, i18n.t('common.days'), tOr('report.active_days', '活跃天数'));
  addStat(data.longestStreak || 0, i18n.t('common.days'), tOr('report.streak', '最长连续'));
  addStat(longest.value, longest.unit, tOr('report.longest_session', '单次最长'));
  if ((data.maxConcurrent || 0) >= 2) {
    addStat(data.maxConcurrent, tOr('report.windows_unit', '个'), tOr('report.max_concurrent', '同时最多'));
  }
  body.appendChild(stats);

  // 2) Which accounts were online together — in groups of any size.
  const combos = combosOf(data);
  if (combos.length) {
    const sec = repSection(
      tOr('report.pairs', '常用组合'),
      tOr('report.pairs_hint', '统计的是这几个账号同时在线的时长，每段时间只算给当时正好开着的那一组。') + ' ' +
      tOr('report.pairs_desc', '这些号经常一起在线')
    );
    const rows = document.createElement('div');
    rows.className = 'rep-rows wide combo';
    const max = combos[0].overlapMs || 1;
    const fallback = ['var(--main-orange)', 'var(--deep-orange)'];
    for (const combo of combos) {
      const cols = (combo.colors || []).map((c, i) => repColor(c, fallback[i % 2]));
      const label = comboLabel(combo, (c, i) => cols[i] || fallback[i % 2]);
      const grad = cols.length > 1
        ? 'background: linear-gradient(90deg, ' + cols.join(', ') + ')'
        : 'background: ' + (cols[0] || fallback[0]);
      rows.appendChild(repBarRow(label, combo.overlapMs / max, formatDurationMs(combo.overlapMs), grad));
    }
    sec.appendChild(rows);
    body.appendChild(sec);
  }

  // 3) Per-account time, each bar in that account's own colour.
  const byProfile = Array.isArray(data.byProfile) ? data.byProfile.filter(p => p && p.totalMs > 0) : [];
  if (byProfile.length) {
    const sec = repSection(tOr('report.by_profile', '各账号时长'), '');
    const rows = document.createElement('div');
    rows.className = 'rep-rows';
    const max = byProfile[0].totalMs || 1;
    for (const p of byProfile) {
      const color = repColor(p.color);
      const sessions = String(p.sessions || 0) + ' ' + tOr('report.sessions_count', '次');
      rows.appendChild(repBarRow(
        '<span class="rep-pair-name" style="color:' + color + '">' + escapeHtml(p.name || p.profileId || '') + '</span>',
        p.totalMs / max,
        formatDurationMs(p.totalMs),
        'background:' + color,
        (p.name || '') + ' · ' + formatDurationMs(p.totalMs) + ' · ' + sessions
      ));
    }
    sec.appendChild(rows);
    body.appendChild(sec);
  }

  // 4) Hour of day, peak column highlighted as the "golden hour".
  const byHour = Array.isArray(data.byHour) && data.byHour.length === 24 ? data.byHour.map(Number) : null;
  if (byHour) {
    const sec = repSection(tOr('report.by_hour', '时段分布'), '');
    const chart = repColumns(
      byHour,
      [0, 6, 12, 18, 23],
      (i) => String(i),
      (i, v) => i + ':00 · ' + formatDurationMs(v)
    );
    sec.appendChild(chart.node);
    if (chart.anyData) {
      const golden = document.createElement('div');
      golden.className = 'rep-golden';
      golden.textContent = tOr('report.golden_hour', '黄金时段') + ' ' +
        chart.peak + ':00–' + ((chart.peak + 1) % 24) + ':00 · ' + formatDurationMs(byHour[chart.peak]);
      sec.appendChild(golden);
    }
    body.appendChild(sec);
  }

  // 5) Day of week (index 0 = Sunday, same as main.js).
  const byWeekday = Array.isArray(data.byWeekday) && data.byWeekday.length === 7 ? data.byWeekday.map(Number) : null;
  if (byWeekday) {
    const names = i18n.t('common.weekday_short');
    const nameAt = (i) => (Array.isArray(names) && names[i] != null) ? String(names[i]) : String(i);
    const sec = repSection(tOr('report.by_weekday', '星期分布'), '');
    const chart = repColumns(byWeekday, null, nameAt, (i, v) => nameAt(i) + ' · ' + formatDurationMs(v));
    sec.appendChild(chart.node);
    body.appendChild(sec);
  }
}

// ---------- report export (self-contained HTML) ----------
// Everything below builds a file that has to survive on its own desktop: no theme
// variables (the app's palette lives in index.html and would resolve to nothing),
// no external stylesheet, no image path. Colours are therefore literal here -- the
// one place in this file where that is correct.
const EXPORT_PALETTE = {
  bg: '#FAF6EF', panel: '#FFFFFF', ink: '#3B2E22', muted: '#8B7A67',
  accent: '#C8843C', accent2: '#E4A85F', border: '#ECE0CE', track: '#F3EADB',
};
// Profile colours are user data; only a plain hex is allowed through.
function expColor(value, fallback) {
  return isHexColor(value) ? String(value) : (fallback || EXPORT_PALETTE.accent);
}
function exportStylesheet() {
  const c = EXPORT_PALETTE;
  return [
    '*{box-sizing:border-box}',
    'body{margin:0;padding:32px 18px 48px;background:' + c.bg + ';color:' + c.ink + ';',
    'font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",Segoe UI,Helvetica,Arial,sans-serif;}',
    '.wrap{max-width:760px;margin:0 auto}',
    '.head{margin-bottom:22px}',
    '.head h1{margin:0;font-size:24px;font-weight:700;letter-spacing:.02em}',
    '.head .sub{margin-top:6px;color:' + c.muted + ';font-size:13px}',
    '.card{background:' + c.panel + ';border:1px solid ' + c.border + ';border-radius:14px;padding:18px 20px;margin-bottom:16px}',
    '.sec-title{font-size:15px;font-weight:600;margin:0 0 4px}',
    '.sec-desc{font-size:12px;color:' + c.muted + ';margin:0 0 14px}',
    '.stats{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}',
    '.stat{flex:1 1 150px;background:' + c.panel + ';border:1px solid ' + c.border + ';border-radius:14px;padding:16px 18px}',
    '.stat .num{font-size:28px;font-weight:700;line-height:1.1;color:' + c.accent + '}',
    '.stat .num span{font-size:13px;font-weight:600;margin-left:4px;color:' + c.muted + '}',
    '.stat .cap{margin-top:6px;font-size:12px;color:' + c.muted + '}',
    '.row{display:flex;align-items:center;gap:12px;margin:9px 0}',
    '.row .lbl{width:34%;min-width:120px;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row.combo .lbl{width:42%;white-space:normal;overflow:visible;line-height:1.35}',
    '.row .track{flex:1;height:10px;border-radius:5px;background:' + c.track + ';overflow:hidden}',
    '.row .track i{display:block;height:100%;border-radius:5px}',
    '.row .val{flex:0 0 auto;min-width:104px;text-align:right;font-size:12px;color:' + c.muted + ';white-space:nowrap}',
    '.plus{margin:0 6px;color:' + c.muted + '}',
    '.cols{display:flex;align-items:flex-end;gap:2px;height:120px;margin-top:6px}',
    '.cols .col{flex:1;height:100%;display:flex;align-items:flex-end}',
    '.cols .col i{display:block;width:100%;border-radius:3px 3px 0 0;background:' + c.accent2 + '}',
    '.cols .col.peak i{background:' + c.accent + '}',
    '.axis{display:flex;gap:2px;margin-top:5px}',
    '.axis span{flex:1;text-align:center;font-size:10px;color:' + c.muted + '}',
    '.note{margin-top:10px;font-size:12px;color:' + c.accent + ';font-weight:600}',
    '.foot{margin-top:24px;text-align:center;font-size:11px;color:' + c.muted + ';line-height:1.8}',
  ].join('');
}
function expBarRow(labelHtml, ratio, valueText, fill, extraClass) {
  const pct = Math.max(0, Math.min(100, (Number(ratio) || 0) * 100));
  return '<div class="row' + (extraClass ? ' ' + extraClass : '') + '"><div class="lbl">' + labelHtml + '</div>' +
    '<div class="track"><i style="width:' + pct.toFixed(2) + '%;background:' + fill + '"></i></div>' +
    '<div class="val">' + escapeHtml(valueText) + '</div></div>';
}
function expColumns(values, tickAt, labelFor) {
  const max = Math.max.apply(null, values.concat([1]));
  let peak = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[peak]) peak = i;
  const anyData = values[peak] > 0;
  let cols = '', axis = '';
  for (let i = 0; i < values.length; i++) {
    const h = Math.max(2, Math.round((values[i] / max) * 100));
    cols += '<div class="col' + (anyData && i === peak ? ' peak' : '') + '"><i style="height:' + h + '%"></i></div>';
    axis += '<span>' + escapeHtml((!tickAt || tickAt.indexOf(i) >= 0) ? labelFor(i) : '') + '</span>';
  }
  return { html: '<div class="cols">' + cols + '</div><div class="axis">' + axis + '</div>', peak: peak, anyData: anyData };
}
// Rebuilt from the data rather than cloned from the DOM on purpose: the on-screen
// report is painted with theme variables that mean nothing outside the app.
function buildReportHtml(data, scope, key) {
  const c = EXPORT_PALETTE;
  const heading = tOr('report.export_heading', '小竹使用报告') + ' · ' + reportKeyLabel(scope, key);
  const parts = [];
  parts.push('<div class="head"><h1>' + escapeHtml(heading) + '</h1>' +
    '<div class="sub">' + escapeHtml(tOr(scope === 'year' ? 'report.year' : 'report.month', scope === 'year' ? '年报' : '月报')) +
    '</div></div>');

  if (!data || !(Number(data.totalMs) > 0)) {
    parts.push('<div class="card">' + escapeHtml(tOr('report.empty', '这段时间还没有游玩记录。')) + '</div>');
  } else {
    // 1) Overview
    const total = statDuration(data.totalMs);
    const longest = statDuration(data.longestSessionMs);
    const tiles = [
      [total.value, total.unit, tOr('report.total_time', '总时长')],
      [String(data.activeDays || 0), i18n.t('common.days'), tOr('report.active_days', '活跃天数')],
      [String(data.longestStreak || 0), i18n.t('common.days'), tOr('report.streak', '最长连续')],
      [longest.value, longest.unit, tOr('report.longest_session', '单次最长')],
    ];
    let stats = '';
    for (const t of tiles) {
      stats += '<div class="stat"><div class="num">' + escapeHtml(t[0]) +
        (t[1] ? '<span>' + escapeHtml(t[1]) + '</span>' : '') + '</div>' +
        '<div class="cap">' + escapeHtml(t[2]) + '</div></div>';
    }
    parts.push('<div class="stats">' + stats + '</div>');

    // 2) Which accounts were online together — groups of any size
    const combos = combosOf(data);
    if (combos.length) {
      let rows = '';
      const max = combos[0].overlapMs || 1;
      for (const combo of combos) {
        const cols = (combo.colors || []).map((col, i) => expColor(col, i % 2 ? c.accent2 : c.accent));
        let label = '';
        (combo.names || []).forEach((n, i) => {
          if (i) label += '<span class="plus">+</span>';
          label += '<span style="color:' + (cols[i] || c.accent) + ';font-weight:600">' + escapeHtml(n || '') + '</span>';
        });
        const grad = cols.length > 1 ? 'linear-gradient(90deg, ' + cols.join(', ') + ')' : (cols[0] || c.accent);
        rows += expBarRow(label, combo.overlapMs / max, formatDurationMs(combo.overlapMs), grad, 'combo');
      }
      parts.push('<div class="card"><div class="sec-title">' + escapeHtml(tOr('report.pairs', '常用组合')) + '</div>' +
        '<div class="sec-desc">' + escapeHtml(tOr('report.pairs_desc', '这些号经常一起在线')) + '</div>' + rows + '</div>');
    }

    // 3) Time per account
    const byProfile = Array.isArray(data.byProfile) ? data.byProfile.filter(p => p && p.totalMs > 0) : [];
    if (byProfile.length) {
      let rows = '';
      const max = byProfile[0].totalMs || 1;
      for (const p of byProfile) {
        const color = expColor(p.color, c.accent);
        rows += expBarRow('<span style="color:' + color + ';font-weight:600">' + escapeHtml(p.name || p.profileId || '') + '</span>',
          p.totalMs / max,
          formatDurationMs(p.totalMs) + ' · ' + String(p.sessions || 0) + ' ' + tOr('report.sessions_count', '次'),
          color);
      }
      parts.push('<div class="card"><div class="sec-title">' + escapeHtml(tOr('report.by_profile', '各账号时长')) + '</div>' + rows + '</div>');
    }

    // 4) Hour of day
    const byHour = Array.isArray(data.byHour) && data.byHour.length === 24 ? data.byHour.map(Number) : null;
    if (byHour) {
      const chart = expColumns(byHour, [0, 6, 12, 18, 23], (i) => String(i));
      let note = '';
      if (chart.anyData) {
        note = '<div class="note">' + escapeHtml(tOr('report.golden_hour', '黄金时段') + ' ' +
          chart.peak + ':00–' + ((chart.peak + 1) % 24) + ':00 · ' + formatDurationMs(byHour[chart.peak])) + '</div>';
      }
      parts.push('<div class="card"><div class="sec-title">' + escapeHtml(tOr('report.by_hour', '时段分布')) + '</div>' + chart.html + note + '</div>');
    }

    // 5) Day of week
    const byWeekday = Array.isArray(data.byWeekday) && data.byWeekday.length === 7 ? data.byWeekday.map(Number) : null;
    if (byWeekday) {
      const names = i18n.t('common.weekday_short');
      const nameAt = (i) => (Array.isArray(names) && names[i] != null) ? String(names[i]) : String(i);
      const chart = expColumns(byWeekday, null, nameAt);
      parts.push('<div class="card"><div class="sec-title">' + escapeHtml(tOr('report.by_weekday', '星期分布')) + '</div>' + chart.html + '</div>');
    }
  }

  const stampDay = beijingDay();
  const d = new Date(Date.now() + BJ_OFFSET);
  const hh = ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
  parts.push('<div class="foot">' +
    escapeHtml(tOr('report.export_note', '数据全部来自本机，未上传任何地方。')) + '<br>' +
    escapeHtml(tOr('report.export_stamp', '生成于') + ' ' + stampDay + ' ' + hh + ' (UTC+8)') +
    '</div>');

  return '<!DOCTYPE html>\n<html lang="' + (isZhLang() ? 'zh-CN' : 'en') + '">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(heading) + '</title>\n' +
    '<style>' + exportStylesheet() + '</style>\n' +
    '</head>\n<body>\n<div class="wrap">\n' + parts.join('\n') + '\n</div>\n</body>\n</html>\n';
}

function reportHasData() {
  return !!(reportData && Number(reportData.totalMs) > 0);
}
function syncReportExportButton() {
  const exp = $('report-export');
  if (!exp) return;
  exp.textContent = tOr('report.export', '导出报告');
  exp.disabled = !reportHasData();
  exp.title = exp.disabled
    ? tOr('report.empty', '这段时间还没有游玩记录。')
    : tOr('report.export_tip', '导出成一个 HTML 文件，保存到桌面');
}
let reportExportBusy = false;
async function exportReportHtml() {
  if (reportExportBusy || !reportHasData()) return;
  reportExportBusy = true;
  try {
    const html = buildReportHtml(reportData, reportScope, reportKey);
    const res = await ipcRenderer.invoke('report:export-html', html, reportKey);
    if (res && res.ok) showToast(tOr('report.export_done', '已保存到桌面'));
    else showToast(tOr('report.export_failed', '导出没成功') + (res && res.error ? ' · ' + res.error : ''));
  } catch (e) {
    showToast(tOr('report.export_failed', '导出没成功'));
  } finally {
    reportExportBusy = false;
  }
}
// Kept ready for the day the report grows a picture export. Nothing but the
// alt-click below reaches it yet, so the HTML path stays the plain one-click action.
async function captureReportPng() {
  if (reportExportBusy || !reportHasData()) return;
  reportExportBusy = true;
  try {
    const host = $('report-body');
    const box = host ? host.getBoundingClientRect() : null;
    const rect = box
      ? { x: box.left, y: box.top, width: box.width, height: box.height, name: reportKey }
      : { name: reportKey };
    const res = await ipcRenderer.invoke('report:capture-png', rect);
    if (res && res.ok) showToast(tOr('report.export_done', '已保存到桌面'));
    else showToast(tOr('report.export_failed', '导出没成功') + (res && res.error ? ' · ' + res.error : ''));
  } catch (e) {
    showToast(tOr('report.export_failed', '导出没成功'));
  } finally {
    reportExportBusy = false;
  }
}
if ($('report-export')) {
  $('report-export').addEventListener('click', (ev) => {
    if (ev.altKey) captureReportPng();
    else exportReportHtml();
  });
}

if ($('report-scope')) {
  $('report-scope').addEventListener('click', (ev) => {
    const tab = ev.target && ev.target.closest ? ev.target.closest('.seg-tab') : null;
    if (tab && tab.dataset.scope) setReportScope(tab.dataset.scope);
  });
}
if ($('report-period')) {
  $('report-period').addEventListener('change', (ev) => {
    reportKey = ev.target.value;
    loadReport();
  });
}

// ---------- Notes ----------
function renderNotes() {
  const q = ($('notes-search').value || '').toLowerCase();
  const items = q ? notes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q)) : notes;
  const list = $('notes-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = placeholderHtml(i18n.t('notes.empty_list'), EMPTY_ASSETS.notes, 'padding:20px;height:auto;');
  } else {
    for (const n of items) {
      const item = document.createElement('div');
      item.className = 'note-item' + (n.id === activeNoteId ? ' active' : '');
      item.innerHTML =
        '<div class="n-title">' + escapeHtml(n.title || i18n.t('notes.untitled')) + '</div>' +
        '<div class="n-preview">' + escapeHtml((n.body || '').slice(0, 80)) + '</div>' +
        '<div class="n-date">' + escapeHtml(formatTime(n.updatedAt)) + '</div>';
      item.addEventListener('click', () => { activeNoteId = n.id; renderNotes(); });
      list.appendChild(item);
    }
  }
  renderNoteEditor();
}
function renderNoteEditor() {
  const editor = $('notes-editor');
  const note = notes.find(n => n.id === activeNoteId);
  if (!note) {
    editor.innerHTML = placeholderHtml(i18n.t('notes.empty_editor'), EMPTY_ASSETS.notes, 'height:100%;');
    return;
  }
  editor.innerHTML = '';
  const titleEl = document.createElement('input');
  titleEl.className = 'e-title';
  titleEl.placeholder = i18n.t('notes.placeholder_title');
  titleEl.value = note.title || '';
  const bodyEl = document.createElement('textarea');
  bodyEl.className = 'e-body';
  bodyEl.placeholder = i18n.t('notes.placeholder_body');
  bodyEl.value = note.body || '';
  const footer = document.createElement('div');
  footer.className = 'e-footer';
  const updated = document.createElement('span');
  updated.textContent = formatTime(note.updatedAt);
  const delBtn = document.createElement('button');
  delBtn.textContent = i18n.t('tasks.delete');
  footer.appendChild(updated); footer.appendChild(delBtn);
  editor.appendChild(titleEl); editor.appendChild(bodyEl); editor.appendChild(footer);

  const saveIncremental = () => {
    note.title = titleEl.value;
    note.body = bodyEl.value;
    note.updatedAt = Date.now();
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => {
      saveNotes();
      updated.textContent = formatTime(note.updatedAt);
      const activeItem = $('notes-list').querySelector('.note-item.active');
      if (activeItem) {
        activeItem.querySelector('.n-title').textContent = note.title || i18n.t('notes.untitled');
        activeItem.querySelector('.n-preview').textContent = (note.body || '').slice(0, 80);
        activeItem.querySelector('.n-date').textContent = formatTime(note.updatedAt);
      }
    }, 400);
  };
  titleEl.addEventListener('input', saveIncremental);
  bodyEl.addEventListener('input', saveIncremental);
  delBtn.addEventListener('click', async () => {
    if (!confirm(i18n.t('notes.delete_confirm'))) return;
    notes = notes.filter(n => n.id !== note.id);
    activeNoteId = null;
    await saveNotes();
    renderNotes();
  });
}
$('notes-new-btn').addEventListener('click', async () => {
  const n = { id: 'n_' + Date.now().toString(36), title: '', body: '', updatedAt: Date.now(), createdAt: Date.now() };
  notes.unshift(n);
  activeNoteId = n.id;
  await saveNotes();
  renderNotes();
});
$('notes-search').addEventListener('input', renderNotes);

// ---------- Quick Note FAB ----------
function updateQuickNoteToggle() {
  updateGameToolsButton();
}
async function setQuickNoteVisible(visible, persist = true) {
  settings.showQuickNote = !!visible;
  document.body.classList.toggle('hide-quick-note', !settings.showQuickNote);
  if (!settings.showQuickNote) $('quick-note-popover').classList.remove('visible');
  updateQuickNoteToggle();
  if (currentRoute === 'settings') setSwitch($('setting-show-quick-note'), settings.showQuickNote);
  if (persist) await saveSettings();
}
function openQuickNote() {
  if (settings.showQuickNote === false) setQuickNoteVisible(true);
  $('quick-note-popover').classList.add('visible');
  setTimeout(() => $('qn-title').focus(), 50);
}
$('game-tools-btn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  showGameToolsMenu(ev.currentTarget);
});
$('compat-indicator').addEventListener('click', (ev) => {
  ev.stopPropagation();
  showCompatBanner();
});
$('compat-close').addEventListener('click', dismissCompatBanner);
$('compat-open-h5').addEventListener('click', openCompatHtml5);
$('compat-open-external').addEventListener('click', openCompatExternal);
$('compat-open-flashpoint').addEventListener('click', openFlashpoint);
$('profile-open-select-all').addEventListener('click', () => setProfileOpenChecks(true));
$('profile-open-select-none').addEventListener('click', () => setProfileOpenChecks(false));
$('profile-open-cancel').addEventListener('click', hideProfileOpenModal);
$('profile-open-run').addEventListener('click', () => runProfileOpen(false));
$('profile-open-grid').addEventListener('click', () => runProfileOpen(true));
$('measure-canvas').addEventListener('click', handleMeasureClick);
$('measure-canvas').addEventListener('mousemove', handleMeasureMove);
$('measure-close').addEventListener('click', () => setMeasureActive(false));
$('measure-reset').addEventListener('click', resetMeasurePoints);
$('measure-scale-start').addEventListener('click', startScaleCalibration);
$('measure-scale-clear-inline').addEventListener('click', clearMeasureScale);
$('quick-note-fab').addEventListener('click', openQuickNote);
$('qn-close').addEventListener('click', () => $('quick-note-popover').classList.remove('visible'));
$('qn-save').addEventListener('click', async () => {
  const title = $('qn-title').value.trim();
  const body = $('qn-body').value.trim();
  if (title || body) {
    const n = { id: 'n_' + Date.now().toString(36), title, body, updatedAt: Date.now(), createdAt: Date.now() };
    notes.unshift(n);
    await saveNotes();
    if (currentRoute === 'notes') renderNotes();
  }
  $('qn-title').value = '';
  $('qn-body').value = '';
  $('quick-note-popover').classList.remove('visible');
});
window.addEventListener('keydown', (e) => {
  if (e.metaKey && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    openQuickNote();
  }
});

// ---------- Tasks ----------
function renderTasks() {
  const pending = tasks.filter(t => !t.done).sort((a, b) => {
    if (a.dueAt && !b.dueAt) return -1;
    if (!a.dueAt && b.dueAt) return 1;
    if (a.dueAt && b.dueAt) return a.dueAt - b.dueAt;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  const done = tasks.filter(t => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  renderTaskSection($('tasks-pending'), pending, true);
  renderTaskSection($('tasks-done'), done, false);
}
function renderTaskSection(container, items, emptyable) {
  container.innerHTML = '';
  if (!items.length) {
    if (emptyable) container.innerHTML = placeholderHtml(i18n.t('tasks.empty'), EMPTY_ASSETS.tasks, 'padding:20px;height:auto;');
    return;
  }
  for (const t of items) container.appendChild(taskRowEl(t));
}
function taskRowEl(t) {
  const row = document.createElement('div');
  row.className = 'task-row' + (t.done ? ' done' : '') + (t.fired && !t.done ? ' fired' : '');
  const overdue = t.dueAt && !t.done && t.dueAt < Date.now();
  const dueText = t.dueAt ? formatTime(t.dueAt) : i18n.t('tasks.set_due');
  row.innerHTML =
    '<div class="task-check" data-act="toggle"></div>' +
    '<div class="t-text" data-act="edit">' + escapeHtml(t.text) + '</div>' +
    '<div class="t-due' + (overdue ? ' overdue' : '') + '" data-act="due">' + escapeHtml(dueText) + (overdue ? ' · ' + i18n.t('tasks.overdue') : '') + '</div>' +
    '<div class="t-actions">' +
      '<button data-act="delete">' + escapeHtml(i18n.t('tasks.delete')) + '</button>' +
    '</div>';
  row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    t.fired = false;
    await saveTasks();
    if (t.done) await ipcRenderer.invoke('task:cancel', t.id);
    else if (t.dueAt) await ipcRenderer.invoke('task:schedule', t);
    renderTasks();
  });
  row.querySelector('[data-act="edit"]').addEventListener('click', async () => {
    const nt = prompt(i18n.t('tasks.edit') + ':', t.text);
    if (nt != null && nt.trim()) { t.text = nt.trim(); await saveTasks(); renderTasks(); }
  });
  row.querySelector('[data-act="due"]').addEventListener('click', async () => {
    const cur = t.dueAt ? new Date(t.dueAt) : new Date(Date.now() + 3600000);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const fmt = cur.getFullYear() + '-' + pad(cur.getMonth()+1) + '-' + pad(cur.getDate()) + ' ' + pad(cur.getHours()) + ':' + pad(cur.getMinutes());
    const inp = prompt(i18n.t('tasks.due') + ' (YYYY-MM-DD HH:MM):', fmt);
    if (inp === null) return;
    if (inp.trim() === '') { t.dueAt = null; await saveTasks(); await ipcRenderer.invoke('task:cancel', t.id); renderTasks(); return; }
    const parsed = new Date(inp.replace(' ', 'T'));
    if (!isNaN(parsed.getTime())) {
      t.dueAt = parsed.getTime();
      t.fired = false;
      await saveTasks();
      await ipcRenderer.invoke('task:schedule', t);
      renderTasks();
    }
  });
  row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm(i18n.t('tasks.delete_confirm'))) return;
    tasks = tasks.filter(x => x.id !== t.id);
    await saveTasks();
    await ipcRenderer.invoke('task:cancel', t.id);
    renderTasks();
  });
  return row;
}
$('task-new-text').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const text = e.target.value.trim();
    if (!text) return;
    const t = { id: 't_' + Date.now().toString(36), text, done: false, createdAt: Date.now() };
    tasks.unshift(t);
    await saveTasks();
    e.target.value = '';
    renderTasks();
  }
});
ipcRenderer.on('task:fired', (_e, taskId) => {
  const t = tasks.find(x => x.id === taskId);
  if (t) { t.fired = true; saveTasks(); if (currentRoute === 'tasks') renderTasks(); }
});

// ---------- Library ----------
let libFilter = 'all';
let libSort = 'last_played';

function makeLibraryItem(url, title, extra) {
  return Object.assign({
    id: 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    url, title: title || hostOf(url),
    addedAt: Date.now(),
    favorite: true,
    tags: [],
    notes: '',
    playCount: 0,
    lastPlayedAt: null,
  }, extra || {});
}
function addToLibrary(url, title) {
  if (!url) return;
  const existing = bookmarks.find(b => b.url === url);
  if (existing) return;
  bookmarks.unshift(makeLibraryItem(url, title));
  saveBookmarks();
  updateBookmarkStar();
  if (currentRoute === 'library') renderLibrary();
  else if (currentRoute === 'favorites') renderFavorites();
  else if (currentRoute === 'home') renderHomeFavorites();
}
function playLibraryItem(item) {
  item.playCount = (item.playCount || 0) + 1;
  item.lastPlayedAt = Date.now();
  saveBookmarks();
  openUrl(item.url);
}
function renderLibrary() {
  const q = ($('lib-search').value || '').toLowerCase();
  let items = bookmarks.slice();
  if (libFilter === 'favorites') items = items.filter(b => b.favorite !== false);
  if (q) items = items.filter(b =>
    (b.title || '').toLowerCase().includes(q) ||
    (b.url || '').toLowerCase().includes(q) ||
    (b.tags || []).join(',').toLowerCase().includes(q) ||
    (b.notes || '').toLowerCase().includes(q)
  );
  items.sort((a, b) => {
    if (libSort === 'last_played') return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
    if (libSort === 'most_played') return (b.playCount || 0) - (a.playCount || 0);
    if (libSort === 'added') return (b.addedAt || 0) - (a.addedAt || 0);
    if (libSort === 'title') return (a.title || '').localeCompare(b.title || '');
    return 0;
  });
  $('lib-count').textContent = items.length + ' ' + i18n.t(items.length === 1 ? 'common.item' : 'common.items');
  const grid = $('lib-grid');
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = placeholderHtml(i18n.t('lib.empty'), EMPTY_ASSETS.library, 'grid-column:1/-1;padding:24px;height:auto;');
    return;
  }
  for (const it of items.slice(0, LIST_RENDER_LIMIT)) grid.appendChild(libCardEl(it));
}
function libCardEl(item) {
  const el = document.createElement('div');
  el.className = 'lib-card';
  const host = hostOf(item.url);
  const lastPlayed = item.lastPlayedAt ? formatTime(item.lastPlayedAt) : i18n.t('lib.never_played');
  const plays = item.playCount || 0;
  const isFav = item.favorite !== false;
  const tagsHtml = (item.tags || []).slice(0, 4).map(t => '<span class="lc-tag">' + escapeHtml(t) + '</span>').join('');
  el.innerHTML =
    '<div class="lc-cover">' + domainLetter(item.url) + '</div>' +
    '<div class="lc-fav' + (isFav ? ' on' : '') + '">' + (isFav ? '❤' : '♡') + '</div>' +
    '<div class="lc-title">' + escapeHtml(item.title || host) + '</div>' +
    '<div class="lc-meta">' + escapeHtml(host) + ' · ' + plays + ' ' + escapeHtml(i18n.t('lib.plays')) + ' · ' + escapeHtml(lastPlayed) + '</div>' +
    '<div class="lc-tags">' + tagsHtml + '</div>' +
    '<div class="lc-actions">' +
      '<button data-act="play" class="primary">' + escapeHtml(i18n.t('lib.play')) + '</button>' +
      '<button data-act="edit">' + escapeHtml(i18n.t('lib.edit')) + '</button>' +
    '</div>';
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('.lc-actions') || ev.target.closest('.lc-fav')) return;
    playLibraryItem(item);
  });
  el.querySelector('.lc-fav').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    item.favorite = item.favorite === false;
    await saveBookmarks();
    renderLibrary();
    updateBookmarkStar();
  });
  el.querySelector('[data-act="play"]').addEventListener('click', (ev) => { ev.stopPropagation(); playLibraryItem(item); });
  el.querySelector('[data-act="edit"]').addEventListener('click', (ev) => { ev.stopPropagation(); openLibEditor(item); });
  return el;
}

// Library edit modal
let editingLibItemId = null;
function openLibEditor(item) {
  editingLibItemId = item.id || item.url;
  $('le-title').value = item.title || '';
  $('le-tags').value = (item.tags || []).join(', ');
  $('le-notes').value = item.notes || '';
  $('lib-edit').style.display = 'block';
  setTimeout(() => $('le-title').focus(), 30);
}
function closeLibEditor() { $('lib-edit').style.display = 'none'; editingLibItemId = null; }
$('le-cancel').addEventListener('click', closeLibEditor);
$('le-save').addEventListener('click', async () => {
  if (!editingLibItemId) return;
  const item = bookmarks.find(b => (b.id || b.url) === editingLibItemId);
  if (!item) { closeLibEditor(); return; }
  item.title = $('le-title').value.trim() || item.title;
  item.tags = $('le-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  item.notes = $('le-notes').value;
  await saveBookmarks();
  closeLibEditor();
  renderLibrary();
  if (currentRoute === 'home') renderHomeFavorites();
});
$('le-delete').addEventListener('click', async () => {
  if (!editingLibItemId) return;
  if (!confirm(i18n.t('lib.remove_confirm'))) return;
  bookmarks = bookmarks.filter(b => (b.id || b.url) !== editingLibItemId);
  await saveBookmarks();
  closeLibEditor();
  renderLibrary();
  if (currentRoute === 'home') renderHomeFavorites();
  updateBookmarkStar();
});
$('lib-search').addEventListener('input', renderLibrary);
$('lib-filter').addEventListener('change', (e) => { libFilter = e.target.value; renderLibrary(); });
$('lib-sort').addEventListener('change', (e) => { libSort = e.target.value; renderLibrary(); });

// ---------- menu/shortcut actions ----------
ipcRenderer.on('action', (_e, action, arg) => {
  const t = activeTab();
  switch (action) {
    case 'new-tab': {
      // No URL: the New Tab menu item / \u2318T. A cold start, so site rules apply.
      if (!arg) { createTab(newTabUrl()); break; }
      // With a URL this is main.js forwarding a page's new-window. The webview-level
      // listener in createTab() sees the same click and knows the source tab, so give it
      // a moment to claim the open; this copy only opens anything if that never ran.
      const linkUrl = arg;
      setTimeout(() => {
        if (claimNewWindow('action', linkUrl)) createTab(linkUrl);
      }, NEW_WINDOW_GRACE_MS);
      break;
    }
    case 'close-tab': if (t) closeTab(t.id); break;
    case 'detach-tab': if (t) detachTab(t.id); break;
    case 'next-tab': {
      if (tabs.length < 2) return;
      const i = tabs.findIndex(x => x.id === activeId);
      activateTab(tabs[(i + 1) % tabs.length].id); setRoute('browser'); break;
    }
    case 'prev-tab': {
      if (tabs.length < 2) return;
      const i = tabs.findIndex(x => x.id === activeId);
      activateTab(tabs[(i - 1 + tabs.length) % tabs.length].id); setRoute('browser'); break;
    }
    case 'reload': if (t) t.webview.reload(); break;
    case 'toggle-history': setRoute('recent'); break;
    case 'toggle-bookmarks': setRoute('favorites'); break;
    case 'focus-url': $topUrl.focus(); break;
    case 'zoom-in': bumpZoom(0.1); break;
    case 'zoom-out': bumpZoom(-0.1); break;
    case 'zoom-reset': resetZoom(); break;
    case 'fit-window': fitZoom(); break;
    case 'toggle-sidebar': setSidebar(!document.body.classList.contains('sidebar-collapsed')); break;
    case 'toggle-game-mode': setGameMode(!document.body.classList.contains('game-mode')); break;
    case 'goto-tasks': setRoute('tasks'); break;
    case 'inspect-webview': { if (t) { try { t.webview.openDevTools(); } catch (e) {} } break; }
    case 'new-window': ipcRenderer.invoke('window:open', (window.XZAutoLogin && XZAutoLogin.quickUrlFor(windowProfileId)) || null, windowProfileId); break;
    // Cmd+1..8 follow the profile order the user set on the Profiles page.
    case 'switch-account': switchToAccountSlot(Number(arg)); break;
    case 'park-others': parkOtherWindows(); break;
    case 'scatter-tile': scatterTabsAndTile(); break;
  }
});
async function switchToAccountSlot(slot) {
  if (!Number.isFinite(slot) || slot < 1) return;
  const p = profiles[slot - 1];
  if (!p) return;
  if (window.XZFocus && XZFocus.switchToProfile(p.id)) return;
  let list = [];
  try { list = await ipcRenderer.invoke('windows:list'); } catch (e) {}
  const match = (Array.isArray(list) ? list : []).find(w => w && String(w.profileId) === p.id);
  if (match) ipcRenderer.invoke('windows:focus', match.winId).catch(() => {});
  else ipcRenderer.invoke('window:open', (window.XZAutoLogin && XZAutoLogin.quickUrlFor(p.id)) || homeUrl, p.id).catch(() => {});
}
// Main resolves the calling window from the IPC sender. The old path asked
// windows:list for the `focused` flag, which was routinely stale by the time the
// answer came back — that is why Cmd+Shift+H did nothing.
function parkOtherWindows() {
  runWindowAction('park', $('strip-park-others'));
}

// ---------- cross-window sync ----------
// Fires for our own writes too, so every consumer here has to be idempotent.
ipcRenderer.on('profiles:changed', (_e, list) => {
  if (!Array.isArray(list)) return;
  profiles = list;
  refreshProfileChip();
  updateCounts();
  repaintAllTabLabels();   // "<account> | <page>" has to follow renames and recolours
  if (window.XZFocus) XZFocus.onProfilesChanged();
  document.dispatchEvent(new CustomEvent('xz:profiles', { detail: list }));
  if (currentRoute === 'profiles') renderProfiles();
});
ipcRenderer.on('windows:changed', (_e, list) => {
  applyWindowList(list);
  refreshLayoutButtons();
});

// ---------- boot ----------
(async () => {
  await loadStores();
  applyLanguage();
  refreshProfileChip();
  updateSpeedIndicator();
  updateAudioButtons();
  setGlass(settings.glassEffect !== false);
  setSidebar(!!settings.sidebarCollapsed);
  setQuickNoteVisible(settings.showQuickNote !== false, false);
  const init = await ipcRenderer.invoke('app:init');
  windowProfileId = (init && init.profileId) || settings.defaultProfileId || (profiles[0] && profiles[0].id);
  refreshProfileChip();
  refreshRunningProfiles();
  refreshLayoutButtons();
  paintLocalStrings();
  updateTabStripState();
  sendWindowMetaNow();
  document.dispatchEvent(new CustomEvent('xz:boot', { detail: init || null }));
  // A window opened *for* an account (profile card, ⌘1..8, detach, open-in-all) carries
  // its profileId here: that is an explicit choice and must outrank any site rule, or
  // "open this in B" could land on A.
  if (init && init.restore && window.XZSession && XZSession.restoreWindow(init.restore)) {
    // 会话恢复：标签页由 session-client.js 按快照创建，首个 tab 同步建出以便发出 window:ready。
  } else if (init && init.initialUrl) createTab(init.initialUrl, init.profileId ? { profileId: init.profileId } : null);
  else {
    setRoute('home');
    // No game to wait for in a plain shell window — don't hold up main's open queue.
    signalWindowReady();
  }
})();
