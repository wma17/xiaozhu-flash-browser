// Guest preload: detects login forms, offers autofill, reports submissions back.
// Designed to cope with dynamically-injected login modals (MutationObserver) and
// same-origin iframes (like many Chinese gaming portals). Cross-origin iframes
// we can't reach — the host app exposes a manual 🔑 button for that case.
const { ipcRenderer } = require('electron');

const LOGIN_TEXT = /login|log in|sign in|登录|登入|提交|进入|立即登录|马上登录|确定|确认|开始游戏|进入游戏/i;
const UNITY_ERROR_TEXT = /Unity Web Player|Sorry,\s*Chrome can't run this app|NPAPI plugins|无法加载Unity3D游戏|Unity3D/i;
const UNITY_PAGE_MARK = /_gameMark\s*=\s*["']4\|/i;
const UNITY_ASSET_MARK = /\.unity3d\b|UnityObject|Unity Web Player|webplayer/i;
const reportedCompat = new Set();

function findLoginFormIn(doc) {
  try {
    const pwField = doc.querySelector('input[type="password"]');
    if (!pwField) return null;
    const form = pwField.form || pwField.closest('form');
    const inputs = form
      ? Array.from(form.querySelectorAll('input'))
      : Array.from(doc.querySelectorAll('input'));
    const pwIdx = inputs.indexOf(pwField);
    let userField = null;
    for (let i = pwIdx - 1; i >= 0; i--) {
      const t = (inputs[i].type || '').toLowerCase();
      if (['text', 'email', 'tel', '', 'search'].includes(t)) {
        userField = inputs[i];
        break;
      }
    }
    return { form, userField, pwField, doc };
  } catch (e) { return null; }
}

function allDocuments() {
  const docs = [document];
  try {
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const d = iframe.contentDocument;
        if (d) docs.push(d);
      } catch (e) { /* cross-origin: skip */ }
    }
  } catch (e) {}
  return docs;
}

function findAnyLoginForm() {
  for (const d of allDocuments()) {
    const f = findLoginFormIn(d);
    if (f) return f;
  }
  return null;
}

function requestAutofill() {
  try {
    if (!findAnyLoginForm()) return;
    ipcRenderer.sendToHost('pw:request', { host: location.hostname });
  } catch (e) {}
}

function absoluteUrl(value) {
  try { return new URL(value, location.href).href; }
  catch (e) { return null; }
}

function mobileHtml5Url() {
  try {
    const metas = Array.from(document.querySelectorAll('meta'));
    const meta = metas.find(el => String(el.getAttribute('http-equiv') || '').toLowerCase() === 'mobile-agent');
    const content = meta ? (meta.getAttribute('content') || '') : '';
    const match = content.match(/url\s*=\s*([^;,]+)/i);
    if (match) return absoluteUrl(match[1].trim());
  } catch (e) {}
  try {
    const match = location.href.match(/4399\.com\/flash\/(\d+)(?:_\d+)?\.htm/i);
    if (match) return 'https://www.4399.com/html5/' + match[1] + '.htm';
  } catch (e) {}
  return null;
}

function reportCompatibilityIssue(kind, details) {
  const key = kind + '|' + location.href;
  if (reportedCompat.has(key)) return;
  reportedCompat.add(key);
  ipcRenderer.sendToHost('compat:detected', Object.assign({
    kind,
    url: location.href,
    title: document.title || '',
    host: location.hostname,
  }, details || {}));
}

function detectLegacyPluginPage() {
  try {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const text = document.body ? document.body.innerText : '';
    const isUnityWebPlayer =
      UNITY_ERROR_TEXT.test(text) ||
      UNITY_PAGE_MARK.test(html) ||
      (UNITY_ASSET_MARK.test(html) && /Unity Web Player|unity3d/i.test(html + '\n' + text));
    if (!isUnityWebPlayer) return;
    reportCompatibilityIssue('unity-web-player', { html5Url: mobileHtml5Url() });
  } catch (e) {}
}

function fillForm(cred) {
  try {
    const f = findAnyLoginForm();
    if (!f || !cred) return;
    if (f.userField) {
      f.userField.value = cred.username || '';
      f.userField.dispatchEvent(new Event('input', { bubbles: true }));
      f.userField.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (f.pwField) {
      f.pwField.value = cred.password || '';
      f.pwField.dispatchEvent(new Event('input', { bubbles: true }));
      f.pwField.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) {}
}

// Focus mode promotes a thumbnail to the main slot without the user clicking into
// the game, so the plugin surface has to be handed the keyboard focus explicitly.
ipcRenderer.on('xz:focus-game', () => {
  try {
    const els = Array.from(document.querySelectorAll('embed, object, iframe'));
    let best = null, area = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = el; }
    }
    if (best && typeof best.focus === 'function') best.focus();
  } catch (e) {}
});

ipcRenderer.on('pw:fill', (_e, cred) => fillForm(cred));

// Auto sign-in: the host only sends this once it has confirmed the profile opted in.
// One submit per document, no matter how many times the host asks.
let autoSubmitted = false;
ipcRenderer.on('pw:submit-now', (_e, opts) => {
  if (autoSubmitted) return;
  try {
    const f = findAnyLoginForm();
    const want = (opts && opts.username) || '';
    if (!f || !f.pwField || !f.pwField.value || (f.userField && want && f.userField.value !== want)) {
      ipcRenderer.sendToHost('pw:auto-submitted', { ok: false, reason: 'fields' });
      return;
    }
    autoSubmitted = true;
    let method = '';
    const form = f.form;
    let btn = form ? form.querySelector('button[type="submit"], input[type="submit"]') : null;
    if (!btn && form) btn = Array.from(form.querySelectorAll('button, a, [role="button"], input[type="button"]')).find(el => LOGIN_TEXT.test((el.innerText || el.textContent || el.value || '').trim()));
    if (btn) { btn.click(); method = 'click'; }
    else if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); method = 'submit'; }
    else { for (const type of ['keydown', 'keypress', 'keyup']) f.pwField.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); method = 'enter'; }
    ipcRenderer.sendToHost('pw:auto-submitted', { ok: true, method });
  } catch (e) { ipcRenderer.sendToHost('pw:auto-submitted', { ok: false, reason: 'error' }); }
});

// Page cleanup: the host owns the rule table, this end just pastes the CSS it is
// handed and optionally centres the stage. mode 'off' undoes everything it did.
let cleanupStage = null;
ipcRenderer.on('xz:cleanup', (_e, spec) => {
  try {
    const s = spec || {};
    let st = document.getElementById('xz-cleanup');
    if (!st) { st = document.createElement('style'); st.id = 'xz-cleanup'; (document.head || document.documentElement).appendChild(st); }
    st.textContent = s.mode && s.mode !== 'off' ? (s.css || '') : '';
    if (cleanupStage) { cleanupStage.style.cssText = cleanupStage.dataset.xzPrev || ''; delete cleanupStage.dataset.xzPrev; cleanupStage = null; }
    if (s.mode !== 'center') return;
    let el = s.stage ? document.querySelector(s.stage) : null;
    if (!el) { let area = 0; for (const c of document.querySelectorAll('embed, object')) { const r = c.getBoundingClientRect(); if (r.width * r.height > area) { area = r.width * r.height; el = c; } } }
    if (!el) return;
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h) return;
    el.dataset.xzPrev = el.style.cssText;
    // No transform: it would make the plugin layer resample at a non-integer ratio.
    el.style.cssText += ';position:fixed!important;left:0!important;right:0!important;top:0!important;bottom:0!important;margin:auto!important;width:' + w + 'px!important;height:' + h + 'px!important;z-index:2147483000!important';
    cleanupStage = el;
  } catch (e) {}
});
function requestCleanup() { try { ipcRenderer.sendToHost('xz:cleanup-query', { host: location.hostname, path: location.pathname }); } catch (e) {} }

// Manual capture — host asks "grab whatever's currently in the login fields"
ipcRenderer.on('pw:capture-now', () => {
  try {
    const f = findAnyLoginForm();
    if (!f) {
      ipcRenderer.sendToHost('pw:capture-result', { found: false });
      return;
    }
    ipcRenderer.sendToHost('pw:capture-result', {
      found: true,
      host: location.hostname,
      username: f.userField ? f.userField.value : '',
      password: f.pwField ? f.pwField.value : '',
    });
  } catch (e) {
    ipcRenderer.sendToHost('pw:capture-result', { found: false });
  }
});

// Auto-request autofill at several points — pages often load forms late.
window.addEventListener('DOMContentLoaded', requestAutofill);
window.addEventListener('load', requestAutofill);
window.addEventListener('DOMContentLoaded', requestCleanup);
window.addEventListener('load', requestCleanup);
window.addEventListener('DOMContentLoaded', detectLegacyPluginPage);
window.addEventListener('load', detectLegacyPluginPage);
setTimeout(requestAutofill, 800);
setTimeout(requestAutofill, 2000);
setTimeout(detectLegacyPluginPage, 800);
setTimeout(detectLegacyPluginPage, 2000);

// Capture submit events (works for real <form> submissions).
function onSubmit(e) {
  reportCurrentCredentials();
}
document.addEventListener('submit', onSubmit, true);

function reportCurrentCredentials() {
  try {
    const f = findAnyLoginForm();
    if (!f) return;
    const username = f.userField ? f.userField.value : '';
    const password = f.pwField ? f.pwField.value : '';
    if (!password) return;
    ipcRenderer.sendToHost('pw:submit', { host: location.hostname, username, password });
  } catch (e) {}
}

// Capture clicks on anything that looks like a login trigger.
function onClick(e) {
  try {
    const el = e.target.closest(
      'button, input[type="submit"], input[type="button"], [role="button"], a, span, div, li'
    );
    if (!el) return;
    // Only consider elements explicitly labelled as a login action.
    const txt = (el.innerText || el.textContent || el.value || '').trim();
    if (!txt || txt.length > 40) return; // guard: don't match long paragraphs
    if (!LOGIN_TEXT.test(txt)) return;
    reportCurrentCredentials();
  } catch (e) {}
}
document.addEventListener('click', onClick, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') setTimeout(reportCurrentCredentials, 0);
}, true);

// Some dynamic logins: modal pops open long after initial load. Re-request autofill
// when a new password input appears.
let observerTriggered = false;
try {
  const obs = new MutationObserver(() => {
    if (observerTriggered) return;
    detectLegacyPluginPage();
    if (findAnyLoginForm()) {
      observerTriggered = true;
      requestAutofill();
      // Allow future modal re-opens to trigger again after some time.
      setTimeout(() => { observerTriggered = false; }, 3000);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
} catch (e) {}
