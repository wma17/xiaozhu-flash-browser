const { ipcRenderer } = require('electron');
const i18n = require('./i18n.js');

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
let settings = {
  language: 'zh-CN',
  defaultProfileId: 'main',
  restoreSession: true,
  sidebarCollapsed: false,
  speedProfile: 'native-ddt',
  speedProfileVersion: 5,
  showQuickNote: true,
  globalMuted: false,
};
let speedFactor = 1;
let speedHookEnabled = false;
let currentRoute = 'home';
let pendingSavePrompt = null;
let profileOpenUrl = null;
let windowProfileId = null; // each window is bound to one profile (Chrome-style)
let menuCloseHandler = null;
const preloadPath = 'file://' + document.location.pathname.split('/').slice(0, -1).join('/') + '/webview-preload.js';
const HISTORY_LIMIT = 2000;
const HISTORY_REPEAT_WRITE_MS = 30000;
const LIST_RENDER_LIMIT = 400;
let historySaveTimer = null;
const PROFILE_COLORS = ['#F4A23C', '#C86B2A', '#8B4E2A', '#5B4636', '#E09F3E', '#9E6240', '#4C7A5A', '#486F9E'];

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

// ---------- storage ----------
async function loadStores() {
  const [h, bm, pr, pw, sk, nt, tk, st, hu] = await Promise.all([
    ipcRenderer.invoke('store:get', 'history'),
    ipcRenderer.invoke('store:get', 'bookmarks'),
    ipcRenderer.invoke('store:get', 'profiles'),
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
  if (settings.speedAutoMute != null) {
    delete settings.speedAutoMute;
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
const saveProfiles     = () => ipcRenderer.invoke('store:set', 'profiles', profiles);
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
function domainLetter(url) {
  const h = hostOf(url);
  return (h[0] || '?').toUpperCase();
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function profileById(id) { return profiles.find(p => p.id === id) || profiles[0] || null; }
function defaultProfile() { return profileById(settings.defaultProfileId) || profiles[0] || null; }
function ensureProfiles() {
  let changed = false;
  if (!Array.isArray(profiles)) profiles = [];
  if (!profiles.length) {
    profiles = [
      { id: 'main', name: 'Main', color: '#F4A23C', persistent: true, createdAt: Date.now() },
    ];
    changed = true;
  }
  for (const p of profiles) {
    if (p.persistent !== true) {
      p.persistent = true;
      changed = true;
    }
  }
  if (!settings.defaultProfileId || !profiles.some(p => p.id === settings.defaultProfileId)) {
    settings.defaultProfileId = profiles[0].id;
    saveSettings();
  }
  if (changed) saveProfiles();
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
function applyLanguage() {
  i18n.setLang(settings.language || 'zh-CN');
  i18n.applyI18n();
  applyIdentity();
  renderGreeting();
  refreshProfileChip();
  updateCounts();
  reRenderCurrent();
  updateAudioButtons();
  updateQuickNoteToggle();
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
  else if (currentRoute === 'doctor') renderDoctor();
  else if (currentRoute === 'settings') renderSettings();
  else if (currentRoute === 'notes') renderNotes();
  else if (currentRoute === 'tasks') renderTasks();
  else if (currentRoute === 'library') renderLibrary();
}

// ---------- routing ----------
function setRoute(name) {
  closeAnyMenus();
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
  if (name === 'home') renderHome();
  else if (name === 'favorites') renderFavorites();
  else if (name === 'recent') renderRecent();
  else if (name === 'windows') renderWindows();
  else if (name === 'profiles') renderProfiles();
  else if (name === 'accounts') renderAccounts();
  else if (name === 'doctor') renderDoctor();
  else if (name === 'settings') renderSettings();
  else if (name === 'notes') renderNotes();
  else if (name === 'tasks') renderTasks();
  else if (name === 'library') renderLibrary();
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
$('sidebar-toggle').addEventListener('click', () => {
  const now = !document.body.classList.contains('sidebar-collapsed');
  setSidebar(now);
});
function setGameMode(on) {
  document.body.classList.toggle('game-mode', !!on);
  const btn = $('game-mode-btn');
  if (btn) btn.textContent = on ? '↙' : '⛶';
}
$('game-mode-btn').addEventListener('click', () => setGameMode(!document.body.classList.contains('game-mode')));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('game-mode')) setGameMode(false);
});

// ---------- tab lifecycle ----------
function createTab(url) {
  const id = nextId++;
  // All tabs inherit this window's profile. To use a different profile, open a new window.
  const profile = profileById(windowProfileId) || defaultProfile();
  const tab = {
    id, title: 'Loading…', url: url || homeUrl,
    loading: false, zoom: 1, fit: false,
    ready: false,
    muted: false,
    profileId: profile ? profile.id : null,
    currentHost: null,
  };
  tabs.push(tab);

  const stripEl = document.createElement('div');
  stripEl.className = 'tab';
  stripEl.dataset.id = id;
  stripEl.innerHTML =
    '<span class="spinner"></span>' +
    '<span class="pdot" style="background:' + (profile ? profile.color : '#888') + '"></span>' +
    '<span class="t-title">Loading…</span>' +
    '<span class="detach" title="Move to new window">⧉</span>' +
    '<span class="close" title="Close">✕</span>';
  stripEl.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('close') || e.target.classList.contains('detach')) return;
    if (e.button === 1) { closeTab(id); return; }
    activateTab(id);
  });
  stripEl.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  stripEl.querySelector('.detach').addEventListener('click', (e) => { e.stopPropagation(); detachTab(id); });
  $tabList.appendChild(stripEl);
  tab.stripEl = stripEl;

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

  const applyZoom = () => {
    try {
      if (tab.fit) {
        const w = wv.getBoundingClientRect().width || window.innerWidth;
        tab.zoom = Math.max(0.4, Math.min(3, w / 960));
      }
      wv.setZoomFactor(tab.zoom);
      if (id === activeId) updateZoomIndicator();
    } catch (e) {}
  };
  tab._applyZoom = applyZoom;

  wv.addEventListener('did-start-loading', () => { tab.loading = true; stripEl.classList.add('loading'); if (id === activeId) updateNavButtons(); });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; stripEl.classList.remove('loading'); if (id === activeId) updateNavButtons(); });
  wv.addEventListener('dom-ready', () => {
    tab.ready = true;
    applyZoom();
    if (id === activeId) updateNavButtons();
  });
  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || hostOf(tab.url);
    stripEl.querySelector('.t-title').textContent = tab.title;
    stripEl.title = tab.title;
    if (currentRoute === 'windows') renderWindows();
  });
  wv.addEventListener('did-navigate', (e) => {
    tab.url = e.url;
    if (id === activeId) $topUrl.value = e.url;
    recordHistory(tab);
    updateNavButtons();
    updateBookmarkStar();
    if (currentRoute === 'windows') renderWindows();
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    tab.url = e.url;
    if (id === activeId) $topUrl.value = e.url;
    recordHistory(tab);
    updateNavButtons();
    updateBookmarkStar();
  });
  // Password autofill + save pipeline (via webview preload IPC).
  wv.addEventListener('ipc-message', (e) => {
    try {
      const payload = (e.args && e.args[0]) || {};
      if (e.channel === 'pw:request') {
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

  activateTab(id);
  setRoute('browser');
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
  if (currentRoute === 'browser') $topUrl.value = tab.url;
  updateNavButtons();
  updateBookmarkStar();
  updateZoomIndicator();
  updateAccountIndicator();
  updateAudioButtons();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  tab.stripEl.remove();
  tab.webview.remove();
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    activeId = null;
    updateAudioButtons();
    setRoute('home');
    return;
  }
  if (activeId === id) activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
  if (currentRoute === 'windows') renderWindows();
}

async function detachTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  await ipcRenderer.invoke('window:open', tab.url, tab.profileId);
  closeTab(id);
}

function activeTab() { return tabs.find(t => t.id === activeId); }

function openUrl(url) {
  if (currentRoute === 'browser' && activeTab()) {
    activeTab().webview.loadURL(url);
  } else {
    createTab(url);
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
}

function speedProfileCode() {
  const profile = SPEED_PROFILE_BY_KEY[settings.speedProfile] || SPEED_PROFILES[0];
  return profile.code;
}

function effectiveMuted(tab) {
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
function updateGameToolsButton() {
  const btn = $('game-tools-btn');
  if (!btn) return;
  const custom = settings.showQuickNote === false || !!settings.globalMuted || !!(activeTab() && activeTab().muted);
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
async function screenshotCurrentGame() {
  const tab = activeTab();
  if (!tab) return;
  const image = await captureWebview(tab);
  const saved = await ipcRenderer.invoke('screenshot:save', image.toPNG(), tab.title || hostOf(tab.url));
  if (saved && saved.path) alert(i18n.t('tools.screenshot_saved').replace('{path}', saved.path));
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
    try { t.webview.setZoomFactor(t.zoom); } catch (e) {}
    updateZoomIndicator();
  });
  menu.appendChild(customItem);
  document.body.appendChild(menu);
  armMenuClose();
});
function refreshProfileChip() {
  const p = profileById(windowProfileId) || defaultProfile();
  if (!p) return;
  $('profile-chip').querySelector('.dot').style.background = p.color;
  $('profile-chip-name').textContent = p.name;
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
$('new-tab-btn').addEventListener('click', () => createTab(homeUrl));

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
$('more-btn').addEventListener('click', (ev) => { ev.stopPropagation(); showMoreMenu(ev.currentTarget); });

function showMoreMenu(anchor) {
  closeAnyMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.minWidth = '220px';
  const addItem = (label, opts) => {
    const it = document.createElement('div');
    it.className = 'menu-item' + (opts && opts.check ? ' check' : '');
    if (opts && opts.dot) {
      it.innerHTML = '<span class="dot" style="background:' + opts.dot + '"></span>' + escapeHtml(label);
    } else {
      it.textContent = label;
    }
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
    addItem(label, { dot: p.color, check: p.id === windowProfileId, onClick: () => ipcRenderer.invoke('window:open', null, p.id) });
  }
  addDivider();
  addItem(i18n.t('more.add_current_to_library'), { onClick: () => { const t = activeTab(); if (t) addToLibrary(t.url, t.title); } });
  addItem(i18n.t('more.open_all_profiles'), { onClick: showProfileOpenModal });
  addItem(i18n.t('more.manage_profiles'), { onClick: () => setRoute('profiles') });
  addItem(i18n.t('more.settings'),        { onClick: () => setRoute('settings') });
  addItem(i18n.t('more.shortcuts'),       { onClick: () => setRoute('shortcuts') });
  addItem(i18n.t('more.about'),           { onClick: () => setRoute('about') });
  document.body.appendChild(menu);
  armMenuClose();
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
  t.zoom = Math.max(0.4, Math.min(3, (t.zoom || 1) + delta));
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
  const next = await ipcRenderer.invoke('speed:set', factor, speedProfileCode());
  speedFactor = next || 1;
  updateSpeedIndicator();
}
function showSpeedMenu(anchor) {
  closeAnyMenus();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'menu';
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
  for (const profile of SPEED_PROFILES) {
    const item = document.createElement('div');
    item.className = 'menu-item' + ((settings.speedProfile || 'native-ddt') === profile.key ? ' check' : '');
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
  const presets = [0.8, 1, 1.1, 1.25, 1.5, 2, 3];
  for (const p of presets) {
    const item = document.createElement('div');
    item.className = 'menu-item' + (Math.abs((speedFactor || 1) - p) < 0.01 ? ' check' : '');
    item.textContent = p + 'x';
    item.addEventListener('click', (ev) => { ev.stopPropagation(); setSpeedFactor(p); closeAnyMenus(); });
    menu.appendChild(item);
  }
  const div = document.createElement('div');
  div.style.cssText = 'border-top: 1px solid var(--border); margin: 4px 6px;';
  menu.appendChild(div);
  const customItem = document.createElement('div');
  customItem.className = 'menu-item';
  customItem.textContent = i18n.t('speed.custom');
  customItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const inp = prompt(i18n.t('speed.custom_prompt'), String(speedFactor || 1));
    closeAnyMenus();
    if (inp == null) return;
    const n = parseFloat(inp);
    if (isNaN(n) || n < 0.5 || n > 10) return;
    setSpeedFactor(n);
  });
  menu.appendChild(customItem);
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
    c.innerHTML = '<div class="placeholder" style="grid-column: 1/-1; padding: 20px; height: auto;"><div>' + escapeHtml(i18n.t('home.empty_history')) + '</div></div>';
    return;
  }
  for (const e of items) c.appendChild(cardEl(e, () => openUrl(e.url)));
}
function renderHomeFavorites() {
  const c = $('home-favorites'); c.innerHTML = '';
  const items = bookmarks.filter(b => b.favorite !== false).slice(0, 6);
  if (!items.length) {
    c.innerHTML = '<div class="placeholder" style="grid-column: 1/-1; padding: 20px; height: auto;"><div>' + escapeHtml(i18n.t('home.empty_favorites')) + '</div></div>';
    return;
  }
  for (const e of items) c.appendChild(cardEl(e, () => openUrl(e.url)));
}
function renderHomeWindows() {
  const c = $('home-windows'); c.innerHTML = '';
  if (!tabs.length) {
    c.innerHTML = '<div class="placeholder" style="padding: 20px; height: auto;"><div>' + escapeHtml(i18n.t('home.empty_windows')) + '</div></div>';
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
  for (const e of items.slice(0, LIST_RENDER_LIMIT)) list.appendChild(entryEl(e, 'fav'));
}
function renderRecent() {
  const q = ($('rec-search').value || '').toLowerCase();
  const items = q ? history.filter(h => (h.title || '').toLowerCase().includes(q) || (h.url || '').toLowerCase().includes(q)) : history;
  $('rec-count').textContent = items.length + ' ' + i18n.t(items.length === 1 ? 'common.item' : 'common.items');
  const list = $('rec-list'); list.innerHTML = '';
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
    list.innerHTML = '<div class="placeholder" style="padding: 20px; height: auto;"><div>' + escapeHtml(i18n.t('win.empty')) + '</div></div>';
    return;
  }
  for (const t of tabs) list.appendChild(winrowEl(t));
}
$('win-grid-btn').addEventListener('click', () => ipcRenderer.invoke('window:tile-grid'));

// ---------- Profiles ----------
async function renderProfiles() {
  const list = $('profile-list'); list.innerHTML = '';
  ensureProfiles();
  const pwCounts = new Map();
  for (const pw of passwords) {
    if (!pw.profileId) continue;
    pwCounts.set(pw.profileId, (pwCounts.get(pw.profileId) || 0) + 1);
  }
  for (const p of profiles) {
    const card = document.createElement('div');
    card.className = 'profile-card';
    const isDefault = p.id === settings.defaultProfileId;
    const pwCount = pwCounts.get(p.id) || 0;
    const isEditing = editingProfileId === p.id;
    if (isEditing) card.classList.add('editing');
    const colorChoices = PROFILE_COLORS.map(color =>
      '<button type="button" class="color-choice' + (color === p.color ? ' selected' : '') +
      '" data-color="' + color + '" style="background:' + color + '" title="' + color + '"></button>'
    ).join('');
    card.innerHTML = isEditing
      ? '<div class="swatch" data-preview style="background:' + p.color + '"></div>' +
        '<div class="profile-edit-fields">' +
          '<input data-field="name" value="' + escapeHtml(p.name) + '" placeholder="' + escapeHtml(i18n.t('prof.placeholder')) + '">' +
          '<div class="color-row"><span>' + escapeHtml(i18n.t('prof.color')) + '</span>' + colorChoices + '</div>' +
          '<div class="pc-meta"><span data-stat="cookies">…</span>' + escapeHtml(i18n.t('prof.cookies')) +
            ' · ' + pwCount + ' ' + escapeHtml(i18n.t('prof.passwords_count')) +
          '</div>' +
        '</div>' +
        '<div class="pc-actions">' +
          '<button data-act="save" class="primary">' + escapeHtml(i18n.t('common.save')) + '</button>' +
          '<button data-act="cancel">' + escapeHtml(i18n.t('common.cancel')) + '</button>' +
        '</div>'
      : '<div class="swatch" style="background:' + p.color + '"></div>' +
        '<div>' +
          '<div class="pc-name">' + escapeHtml(p.name) +
            (isDefault ? '<span class="pc-tag default">' + escapeHtml(i18n.t('prof.default')) + '</span>' : '') +
          '</div>' +
          '<div class="pc-meta"><span data-stat="cookies">…</span>' + escapeHtml(i18n.t('prof.cookies')) +
            ' · ' + pwCount + ' ' + escapeHtml(i18n.t('prof.passwords_count')) +
          '</div>' +
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
    if (isEditing) {
      card.querySelectorAll('.color-choice').forEach(btn => {
        btn.addEventListener('click', () => {
          card.querySelectorAll('.color-choice').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          const preview = q('[data-preview]');
          if (preview) preview.style.background = btn.dataset.color;
        });
      });
      q('[data-act="save"]').addEventListener('click', async () => {
        const name = q('[data-field="name"]').value.trim();
        const selected = q('.color-choice.selected');
        if (!name) return;
        p.name = name;
        if (selected && selected.dataset.color) p.color = selected.dataset.color;
        editingProfileId = null;
        await saveProfiles();
        refreshProfileChip();
        renderProfiles();
      });
      q('[data-field="name"]').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') q('[data-act="save"]').click();
        if (e.key === 'Escape') q('[data-act="cancel"]').click();
      });
      q('[data-act="cancel"]').addEventListener('click', () => {
        editingProfileId = null;
        renderProfiles();
      });
      list.appendChild(card);
      setTimeout(() => {
        const input = q('[data-field="name"]');
        if (input) { input.focus(); input.select(); }
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
    q('[data-act="open"]').addEventListener('click', () => ipcRenderer.invoke('window:open', homeUrl, p.id));
    q('[data-act="clone"]').addEventListener('click', () => {
      const t = activeTab();
      ipcRenderer.invoke('window:open', t ? t.url : homeUrl, p.id);
    });
    q('[data-act="rename"]').addEventListener('click', () => {
      editingProfileId = p.id;
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
      const i = profiles.indexOf(p);
      if (i >= 0) profiles.splice(i, 1);
      if (settings.defaultProfileId === p.id) { settings.defaultProfileId = profiles[0] ? profiles[0].id : null; await saveSettings(); refreshProfileChip(); }
      if (windowProfileId === p.id) windowProfileId = settings.defaultProfileId || (profiles[0] && profiles[0].id);
      await saveProfiles();
      refreshProfileChip();
      renderProfiles();
    });
    list.appendChild(card);
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
$('profile-create-btn').addEventListener('click', async () => {
  ensureProfiles();
  const profile = makeProfile(nextProfileName());
  profiles.push(profile);
  editingProfileId = profile.id;
  await saveProfiles();
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
    list.innerHTML = '<div class="placeholder" style="padding: 16px; height: auto;"><div>' + escapeHtml(i18n.t('acct.empty')) + '</div></div>';
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
  // Switches
  setSwitch($('setting-restore-session'), !!settings.restoreSession);
  setSwitch($('setting-sidebar-collapsed'), !!settings.sidebarCollapsed);
  setSwitch($('setting-show-quick-note'), settings.showQuickNote !== false);
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
attachSwitch($('setting-restore-session'), async (v) => { settings.restoreSession = v; await saveSettings(); });
attachSwitch($('setting-sidebar-collapsed'), async (v) => { settings.sidebarCollapsed = v; await saveSettings(); });
attachSwitch($('setting-show-quick-note'), async (v) => {
  await setQuickNoteVisible(v);
});
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
    list.innerHTML = '<div class="placeholder" style="padding: 16px; height: auto;"><div>' + escapeHtml(i18n.t('pw.empty')) + '</div></div>';
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

// ---------- Notes ----------
function renderNotes() {
  const q = ($('notes-search').value || '').toLowerCase();
  const items = q ? notes.filter(n => (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q)) : notes;
  const list = $('notes-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="placeholder" style="padding: 20px; height: auto;"><div>' + escapeHtml(i18n.t('notes.empty_list')) + '</div></div>';
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
    editor.innerHTML = '<div class="notes-empty-editor">' + escapeHtml(i18n.t('notes.empty_editor')) + '</div>';
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
$('profile-open-select-all').addEventListener('click', () => setProfileOpenChecks(true));
$('profile-open-select-none').addEventListener('click', () => setProfileOpenChecks(false));
$('profile-open-cancel').addEventListener('click', hideProfileOpenModal);
$('profile-open-run').addEventListener('click', () => runProfileOpen(false));
$('profile-open-grid').addEventListener('click', () => runProfileOpen(true));
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
    if (emptyable) container.innerHTML = '<div class="placeholder" style="padding: 16px; height: auto;"><div>' + escapeHtml(i18n.t('tasks.empty')) + '</div></div>';
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
    grid.innerHTML = '<div class="placeholder" style="grid-column:1/-1;padding:20px;height:auto;"><div>' + escapeHtml(i18n.t('lib.empty')) + '</div></div>';
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
    case 'new-tab': createTab(arg || homeUrl); break;
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
    case 'new-window': ipcRenderer.invoke('window:open', null, windowProfileId); break;
  }
});

// ---------- boot ----------
(async () => {
  await loadStores();
  applyLanguage();
  refreshProfileChip();
  updateSpeedIndicator();
  updateAudioButtons();
  setSidebar(!!settings.sidebarCollapsed);
  setQuickNoteVisible(settings.showQuickNote !== false, false);
  const init = await ipcRenderer.invoke('app:init');
  windowProfileId = (init && init.profileId) || settings.defaultProfileId || (profiles[0] && profiles[0].id);
  refreshProfileChip();
  if (init && init.initialUrl) createTab(init.initialUrl);
  else setRoute('home');
})();
