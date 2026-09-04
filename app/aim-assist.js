// Aim assist — reads the in-game minimap and turns it into distance + a shot table.
//
// The whole thing rests on one fact about this game: the white view box drawn on
// the minimap is always exactly 10 距离 wide. So a target's distance is
//
//     (pixels between the two dots on the minimap) / (pixels across the view box) * 10
//
// Numerator and denominator come out of the same captured image, so window size,
// zoom level, screen scaling and per-map minimap ratios all cancel out. Nothing
// here needs the user to measure anything by hand.
//
// Nothing is ever sent into the game: this module only reads pixels and prints
// numbers. Aiming and firing stay the player's job.
(function () {
  const { ipcRenderer } = require('electron');

  // Two places this file runs: inside the browser window, where the game webview
  // is right there, and in the floating window, where it isn't. Only the three
  // calls that actually touch the game differ — probe the stage, grab pixels, drag
  // a calibration box — so everything else below has exactly one implementation.
  const POPOUT = !!(typeof window !== 'undefined' && window.__AIM_POPOUT__);
  let poppedOut = false;   // owner side: the panel currently lives in its own window

  function rpc(method, args) {
    return ipcRenderer.invoke('aim:rpc', method, args);
  }

  // ---------------------------------------------------------------- ballistics
  // Projectile under linear drag: a = f - r·v, solved per axis. r/wind/gravity
  // are the fitted constants from github.com/tkzt/ddt-sharp-shooter, which were
  // derived from the widely circulated power tables. Re-checked here against the
  // 20/30/50/65 度 tables printed on this server's own game page (80 points):
  // for distances of 3 屏 and up the predicted power lands within 1.2 RMS of the
  // table, worst case 3.8. Refitting on those 80 points changed nothing, so the
  // constants carry over to 怀旧版 as they are.
  const DRAG = 1.05235296;
  const WIND_K = 5.50186622;
  const GRAV = -163.56591668;
  const ANGLES = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];

  // Displacement after time t for one axis: constant force f, drag r, launch v0.
  function axisPos(v0, f, r, t) {
    const tmp = f - r * v0;
    return (tmp * Math.exp(-r * t) + f * r * t - tmp) / (r * r);
  }

  // Time at the top of the arc — past it height falls monotonically, which is the
  // branch we want. A shot that peaks below the target simply cannot reach it.
  function apexTime(vy) {
    if (vy <= 0) return 0;
    const term = GRAV / DRAG;
    const ratio = term / (term - vy);
    if (!(ratio > 0 && ratio < 1)) return 0;
    return -Math.log(ratio) / DRAG;
  }

  // Time at which the shell comes back down to height dy. null = never gets there.
  function flightTime(vy, dy) {
    const lo0 = apexTime(vy);
    if (axisPos(vy, GRAV, DRAG, lo0) < dy) return null; // peaks below the target
    let lo = lo0;
    let hi = Math.max(lo0 * 2, 0.05);
    let guard = 0;
    while (axisPos(vy, GRAV, DRAG, hi) > dy && guard++ < 80) hi *= 1.6;
    if (axisPos(vy, GRAV, DRAG, hi) > dy) return null;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (axisPos(vy, GRAV, DRAG, mid) > dy) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Horizontal reach of a shot, or null when it never comes down to dy.
  function reach(force, deg, wind, dy) {
    const rad = deg * Math.PI / 180;
    const t = flightTime(Math.sin(rad) * force, dy);
    if (t === null) return null;
    return axisPos(Math.cos(rad) * force, WIND_K * wind, DRAG, t);
  }

  // Power needed to land at (dx, dy) at this angle. dx > 0 always: the frame is
  // rotated so the target is downrange, which is why wind is signed by the caller
  // (positive = blowing towards the target). null = out of range at full power.
  // Past 90° the player is shooting backwards over their own shoulder — 反抛 —
  // which the game treats as the mirror of the forward angle: 95 flies like 85,
  // 125 like 55. Only the launch direction differs, and the shell still travels
  // towards the target, so wind keeps the sign the caller gave it. (The reference
  // implementation meant to do this too, but folded the mirror into the wind
  // argument by mistake.)
  function effectiveAngle(deg) {
    return deg > 90 ? 180 - deg : deg;
  }

  function powerFor(rawDeg, wind, dx, dy) {
    const deg = effectiveAngle(rawDeg);
    if (deg <= 0 || deg >= 90) return null;
    const at = (f) => {
      const r = reach(f, deg, wind, dy);
      return r === null ? -1e9 : r - dx;
    };
    if (at(100) < 0) return null;
    let lo = 0.5, hi = 100;
    if (at(lo) > 0) return lo;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------ image analysis
  // Everything below works on the BGRA buffer nativeImage.toBitmap() hands back.
  // Size thresholds are expressed against `u`, the width of the captured minimap
  // divided by the width it had in the reference screenshots, so they survive any
  // window size or display scaling.
  const REF_MAP_W = 144;

  // Player markers are flat palette colours — exactly (255,0,0) and (0,51,204) in
  // every capture — so matching them tightly beats any "reddish / blueish" rule,
  // which would swallow a blue sky or a rust-coloured cliff.
  // A marker's solid fill is always the exact palette colour. Its ring and the
  // turn triangle are drawn thin and come back blended with whatever terrain is
  // behind them, so those get a second, looser rule: strongly one-sided colour
  // that is still too dark to be sky or sand.
  const RED_MARK = [255, 0, 0];
  const BLUE_MARK = [0, 51, 204];
  const MARK_TOL = 70;
  // The view box outline is a solid neutral grey; the shade varies between maps
  // (102 and 153 both turn up) but it is always r == g == b, which map artwork
  // essentially never is.
  function classify(buf, w, h) {
    const n = w * h;
    const red = new Uint8Array(n);
    const blue = new Uint8Array(n);
    const redSoft = new Uint8Array(n);
    const blueSoft = new Uint8Array(n);
    const grey = new Uint8Array(n);
    const t2 = MARK_TOL * MARK_TOL;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const b = buf[o], g = buf[o + 1], r = buf[o + 2];
      let d = (r - RED_MARK[0]) ** 2 + (g - RED_MARK[1]) ** 2 + (b - RED_MARK[2]) ** 2;
      if (d < t2) red[i] = 1;
      d = (r - BLUE_MARK[0]) ** 2 + (g - BLUE_MARK[1]) ** 2 + (b - BLUE_MARK[2]) ** 2;
      if (d < t2) blue[i] = 1;
      if (r - b >= 80 && r >= 150 && g + b <= 240) redSoft[i] = 1;
      if (b - r >= 80 && b >= 150 && r + g <= 240) blueSoft[i] = 1;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn <= 9 && mn >= 78 && mx <= 195) grey[i] = 1;
    }
    return { red, blue, redSoft, blueSoft, grey };
  }

  // Longest uninterrupted run of set pixels in one row / column, with its extent.
  // A contiguous run beats a plain pixel count: a rocky map scatters grey pixels
  // that would otherwise add up to a border that isn't there.
  function bestRun(mask, len, step, start) {
    let best = 0, bestEnd = -1, cur = 0;
    for (let i = 0; i < len; i++) {
      if (mask[start + i * step]) { cur++; if (cur > best) { best = cur; bestEnd = i; } } else cur = 0;
    }
    return { len: best, a: bestEnd - best + 1, b: bestEnd };
  }

  // The view box is found as a whole rectangle, not as loose lines: a top and a
  // bottom border that start and end at the same two columns, the right shape for
  // the game view, and at least one side actually joined up. Anything less is
  // rejected — a missed frame costs nothing because the scale is cached and the
  // box only has to be read cleanly once per map.
  function findViewBox(grey, w, h, viewAspect) {
    const rows = [], cols = [];
    for (let y = 0; y < h; y++) rows.push(bestRun(grey, w, 1, y * w));
    for (let x = 0; x < w; x++) cols.push(bestRun(grey, h, w, x));
    // How far an upright grey line continues from (x, y) in direction dy. Checked
    // with one pixel of horizontal slack because the corner of the box and the end
    // of its horizontal border can sit a pixel apart.
    const span = (x, y, dy) => {
      let best2 = 0;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox;
        if (xx < 0 || xx >= w) continue;
        let n = 0;
        for (let yy = y + dy; yy >= 0 && yy < h && grey[yy * w + xx]; yy += dy) n++;
        if (n > best2) best2 = n;
      }
      return best2;
    };
    const cand = [];
    for (let y = 0; y < h; y++) if (rows[y].len >= w * 0.18) cand.push(y);
    let best = null;
    const slack = Math.max(3, Math.round(w * 0.03));
    // The minimap's own frame is a grey rectangle too, and when the camera sits in
    // a corner the view box shares two of its edges — so "is this line the frame?"
    // cannot be answered by length alone. It is identified instead as the longest
    // horizontal run in the crop: anything with the same two endpoints is the
    // frame, whatever fraction of the calibrated rectangle it happens to fill.
    // Judging it by that fraction is what made this fragile: frame a little more
    // margin when calibrating and the map border slips under the threshold, gets
    // taken for the view box, and every distance comes out at roughly half.
    let frame = null;
    for (const r of rows) if (!frame || r.len > frame.len) frame = r;
    const isFrame = (a, b) => !!frame && frame.len >= w * 0.5 &&
      Math.abs(a - frame.a) <= slack && Math.abs(b - frame.b) <= slack;
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const ya = cand[i], yb = cand[j];
        const ra = rows[ya], rb = rows[yb];
        const height = yb - ya;
        if (height < h * 0.12) continue;
        if (Math.abs(ra.a - rb.a) > slack || Math.abs(ra.b - rb.b) > slack) continue;
        const x0 = Math.round((ra.a + rb.a) / 2), x1 = Math.round((ra.b + rb.b) / 2);
        const width = x1 - x0;
        if (width < w * 0.18) continue;
        if (isFrame(x0, x1)) continue;
        if (width > w * 0.9 || height > h * 0.9) continue;   // backstop
        const ratio = width / height;
        if (ratio < viewAspect * 0.72 || ratio > viewAspect * 1.32) continue;
        // At least one upright side has to run most of the way between the two.
        const side = Math.max(span(x0, ya, 1), span(x1, ya, 1));
        if (side < height * 0.6) continue;
        const score = ra.len + rb.len + side;
        if (!best || score > best.score) best = { x0, x1, width, height, score };
      }
    }
    if (best) return best;
    // Camera pinned against the top or bottom of the map: one border falls on the
    // map's own edge and there is no second line to pair with. A single border
    // still gives the width, as long as an upright side of about the right length
    // hangs off one of its ends.
    for (const y of cand) {
      const r = rows[y];
      if (isFrame(r.a, r.b)) continue;     // the map's own frame, not the view box
      if (r.len > w * 0.92) continue;      // backstop
      if (r.a < 2 || r.b > w - 3) continue; // a real box edge stops short of the crop
      const width = r.len;
      const expect = width / viewAspect;
      if (expect < h * 0.12) continue;
      // Both upright sides must hang off this border, on the same side of it and
      // for about the height the box should have. Without that a stripe of grey
      // terrain would pass for a border, and a wrong scale is far worse than no
      // reading at all.
      const up = Math.min(span(r.a, y, -1), span(r.b, y, -1));
      const down = Math.min(span(r.a, y, 1), span(r.b, y, 1));
      const side = Math.max(up, down);
      if (side < expect * 0.62) continue;
      const score = r.len + side;
      if (!best || score > best.score) {
        best = { x0: r.a, x1: r.b, width, height: Math.round(expect), score, clipped: true };
      }
    }
    return best;
  }

  // Connected components, iterative so a big blob can't blow the stack.
  function blobs(mask, w, h) {
    const seen = new Uint8Array(w * h);
    const out = [];
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || seen[s]) continue;
      stack.length = 0;
      stack.push(s);
      seen[s] = 1;
      let n = 0, sx = 0, sy = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p - px) / w;
        n++; sx += px; sy += py;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
        if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      out.push({ n, cx: sx / n, cy: sy / n, bw, bh, fill: n / (bw * bh) });
    }
    return out;
  }

  // Own team's markers wear a ring around the dot; the enemy's are bare. The ring
  // is a thin stroke whose radius drifts a little with rendering, so several radii
  // are sampled and the best coverage wins.
  function ringScore(mask, w, h, cx, cy, radius) {
    let hit = 0, tot = 0;
    for (let k = 0; k < 48; k++) {
      const th = 2 * Math.PI * k / 48;
      const x = Math.round(cx + radius * Math.cos(th));
      const y = Math.round(cy + radius * Math.sin(th));
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      tot++;
      if (mask[y * w + x]) hit++;
    }
    return tot >= 30 ? hit / tot : 0;
  }
  // A ring only counts when the surrounding area is *not* also team-coloured —
  // one map has a sky saturated enough to read as blue, and without this guard
  // every dot on it would look ringed.
  function hasRing(mask, w, h, cx, cy, coreW) {
    let best = 0;
    for (const f of [0.9, 1.1, 1.3, 1.5]) {
      best = Math.max(best, ringScore(mask, w, h, cx, cy, Math.max(4, coreW * f)));
    }
    // A real marker goes solid core → gap → stroke → nothing. Both the gap and the
    // area outside have to come back empty; if they don't, this is a dot sitting on
    // terrain of its own colour, not a ring. Getting this wrong swaps the sides and
    // mirrors every reading, so it errs towards saying no.
    const gap = ringScore(mask, w, h, cx, cy, Math.max(3, coreW * 0.62));
    const around = ringScore(mask, w, h, cx, cy, Math.max(8, coreW * 2.4));
    return best >= 0.5 && gap < 0.35 && around < 0.35;
  }

  // Whoever is up this turn gets a small triangle floating over their dot in a
  // lighter shade of the team colour. It is looked for as a short *bounded* run of
  // team-coloured pixels centred over the dot: a run that just keeps going is sky,
  // not a marker, which is what makes this survive a blue-sky map.
  function markedByTriangle(mask, w, h, cx, cy, u) {
    const cxr = Math.round(cx);
    for (let dy = Math.round(6 * u); dy <= Math.round(22 * u); dy++) {
      const y = Math.round(cy) - dy;
      if (y < 0) break;
      const row = y * w;
      if (!mask[row + cxr]) continue;
      let a = cxr, b = cxr;
      while (a - 1 >= 0 && mask[row + a - 1]) a--;
      while (b + 1 < w && mask[row + b + 1]) b++;
      const len = b - a + 1;
      if (len < 3 * u || len > 14 * u) continue;
      if (Math.abs((a + b) / 2 - cx) > 5 * u) continue;
      return true;
    }
    return false;
  }

  function findPlayers(strict, soft, w, h, u, team) {
    const cores = blobs(strict, w, h);
    const players = [];
    for (const b of cores) {
      if (!(b.bw >= 4 * u && b.bw <= 13 * u && b.bh >= 4 * u && b.bh <= 13 * u && b.fill >= 0.55)) continue;
      if (players.some(p => Math.hypot(p.x - b.cx, p.y - b.cy) < 6 * u)) continue;
      players.push({
        x: b.cx,
        y: b.cy,
        team,
        ring: hasRing(soft, w, h, b.cx, b.cy, b.bw),
        turn: markedByTriangle(soft, w, h, b.cx, b.cy, u),
      });
    }
    return players;
  }

  function readMinimap(buf, w, h, viewAspect) {
    const u = w / REF_MAP_W;
    const m = classify(buf, w, h);
    const box = findViewBox(m.grey, w, h, viewAspect);
    const players = findPlayers(m.red, m.redSoft, w, h, u, 'red')
      .concat(findPlayers(m.blue, m.blueSoft, w, h, u, 'blue'));
    return { box, players, u };
  }

  // ------------------------------------------------------------------- capture
  // The Flash movie is one element on a normal web page, so its position inside
  // the page is read from the DOM rather than assumed. Everything downstream is
  // expressed as a fraction of that element, which is what makes the reading
  // survive window resizing.
  // Three ways down, because these portals nest the game differently: the plugin
  // element itself when we can reach it, otherwise the frame it lives in (whose
  // box is readable even when the frame is another origin and its contents are
  // not), otherwise the page. Whichever it lands on, the same one comes back every
  // time, which is all a calibration stored as fractions actually needs.
  const STAGE_PROBE = `(function () {
    function plugin(doc, ox, oy, depth, out) {
      var els, i, r;
      try { els = doc.querySelectorAll('embed, object, canvas'); } catch (e) { return; }
      for (i = 0; i < els.length; i++) {
        r = els[i].getBoundingClientRect();
        if (r.width < 320 || r.height < 240) continue;
        if (!out.best || r.width * r.height > out.best.width * out.best.height) {
          out.best = { kind: els[i].tagName.toLowerCase(), x: r.left + ox, y: r.top + oy,
                       width: r.width, height: r.height };
        }
      }
      if (depth > 3) return;
      var frames;
      try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
      for (i = 0; i < frames.length; i++) {
        r = frames[i].getBoundingClientRect();
        if (r.width >= 320 && r.height >= 240 &&
            (!out.frame || r.width * r.height > out.frame.width * out.frame.height)) {
          out.frame = { kind: 'iframe', x: r.left + ox, y: r.top + oy, width: r.width, height: r.height };
        }
        try {
          var d = frames[i].contentDocument;
          if (d) plugin(d, r.left + ox, r.top + oy, depth + 1, out);
        } catch (e) { /* another origin: its box above is all we get */ }
      }
    }
    var out = { best: null, frame: null };
    plugin(document, 0, 0, 0, out);
    var pick = out.best || out.frame || {
      kind: 'page', x: 0, y: 0,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
    // The page's own CSS width lets the host work out the zoom factor, since a
    // capture rectangle is measured on the view, not on the zoomed document.
    pick.innerW = document.documentElement.clientWidth;
    return pick;
  })()`;

  // Returned in view pixels — what capturePage measures in — rather than the
  // page's own CSS pixels, so that zooming a tab doesn't shift the crop.
  async function stageRect(webview) {
    let r = null;
    try { r = await webview.executeJavaScript(STAGE_PROBE, true); } catch (e) { return null; }
    if (!r || !(r.width > 0) || !(r.height > 0)) return null;
    let zoom = 1;
    try {
      const box = webview.getBoundingClientRect();
      if (r.innerW > 0 && box.width > 0) zoom = box.width / r.innerW;
    } catch (e) {}
    if (!(zoom > 0.2 && zoom < 6)) zoom = 1;
    return {
      kind: r.kind,
      x: r.x * zoom,
      y: r.y * zoom,
      width: r.width * zoom,
      height: r.height * zoom,
      zoom,
    };
  }

  function capture(webview, rect) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = (img) => { if (!done) { done = true; img ? resolve(img) : reject(new Error('empty')); } };
      try {
        const maybe = webview.capturePage(rect);
        if (maybe && typeof maybe.then === 'function') { maybe.then(ok, reject); return; }
      } catch (e) { /* older callback form below */ }
      try { webview.capturePage(rect, ok); } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------- module state
  const DEFAULT_STATE = {
    // Where the minimap sits inside the Flash element, as fractions. The defaults
    // match this game's standard HUD; 标定 overwrites them if a skin moves it.
    map: { fx: 0.799, fy: 0.081, fw: 0.185, fh: 0.148 },
    windMag: 0,
    windRight: true,
    angle: null,            // the player's own angle, when they want one worked out
    autoRefresh: true,
    myTeam: null,           // null = work it out from the ring / turn marker
    friendIdx: null,        // which own-side dot to shoot from; null = whoever is up
    // The 风力 banner: tail circle, both digits, the dot between them, the arrow
    // tip. Measured off a clean full-stage capture (1030x654), so these defaults
    // only hold when the probe finds the real Flash element — when it lands on a
    // wrapping iframe instead, both rectangles have to be dragged by hand.
    // The tip matters as much as the digits: which end it points from is the wind
    // direction, and the samples are labelled L/R so that can be read later too.
    wind: { fx: 0.466, fy: 0.058, fw: 0.084, fh: 0.070 },
    collectWind: true,      // save a labelled crop whenever the wind is entered by hand
    windCalibrated: false,  // the wind rectangle above is a guess until the user drags one
    windSamples: 0,
  };
  let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  let myTeam = null;        // resolved side for this session
  let lastMe = null;        // where the player's dot was last seen
  let visible = false;
  let timer = null;
  let busy = false;
  let scaleHistory = [];   // recent view-box widths, median'd for stability
  let pendingScale = [];   // widths that disagree with the cache, awaiting a second opinion
  let lastGoodAt = 0;      // when a full reading last succeeded
  let last = null;         // last successful reading, kept through dud frames
  let stale = false;       // the reading on screen is older than the current frame
  let ui = null;           // the panel's long-lived elements
  let stageInfo = null;    // what the probe found, shown in the panel footer
  let teamFrom = null;     // 'ring' | 'manual' — how the side was decided
  let brightRef = null;    // how bright this map looks while the game is awake
  let focusNo = null;      // when set, only this target is shown
  let windShot = null;     // latest undimmed crop of the wind banner, awaiting a label
  let windShotErr = null;  // why the last wind capture failed, so it can be reported
  let lastSampleSig = null;
  let statusText = '';
  let calibrating = false;

  async function loadState() {
    try {
      const saved = await ipcRenderer.invoke('store:get', 'aim-assist');
      if (saved && typeof saved === 'object') {
        state = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), saved);
        if (!state.map || typeof state.map.fw !== 'number') state.map = Object.assign({}, DEFAULT_STATE.map);
        myTeam = state.myTeam || null;
        windRaw = state.windMag ? String(Math.round(state.windMag * 10)) : '';
        if (windRaw.length === 1) windRaw = '0' + windRaw;
      }
    } catch (e) {}
  }
  function saveState() {
    try { ipcRenderer.invoke('store:set', 'aim-assist', state); } catch (e) {}
  }

  // Typed the way the number is read off the HUD, decimal point optional: "07"
  // and "7" both mean 0.7, "22" means 2.2, "105" means 10.5. Anything with a real
  // decimal point in it is taken at face value.
  let windRaw = '';
  function parseWind(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return 0;
    if (s.indexOf('.') >= 0) return Math.min(99, Math.max(0, Math.abs(Number(s) || 0)));
    const digits = s.replace(/[^0-9]/g, '');
    if (!digits) return 0;
    return Math.min(99, parseInt(digits, 10) / 10);
  }

  // Enough of a fingerprint to tell "the wind changed" from "same turn, same
  // number" so the same banner isn't filed twice.
  function cheapSig(bmp) {
    let a = 5381;
    for (let i = 0; i < bmp.length; i += 37) a = ((a * 33) ^ bmp[i]) >>> 0;
    return a + ':' + bmp.length;
  }

  function meanLuma(bmp, n) {
    let sum = 0;
    const step = n > 20000 ? 3 : 1;      // sampling is plenty for a brightness ratio
    let count = 0;
    for (let i = 0; i < n; i += step) {
      const o = i * 4;
      sum += bmp[o] * 0.11 + bmp[o + 1] * 0.59 + bmp[o + 2] * 0.30;
      count++;
    }
    return count ? sum / count : 0;
  }

  function brighten(bmp, n, k) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      out[i] = Math.min(255, bmp[i] * k);
      out[i + 1] = Math.min(255, bmp[i + 1] * k);
      out[i + 2] = Math.min(255, bmp[i + 2] * k);
      out[i + 3] = 255;
    }
    return out;
  }

  function bgraToRgba(bmp, n) {
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out[o] = bmp[o + 2];
      out[o + 1] = bmp[o + 1];
      out[o + 2] = bmp[o];
      out[o + 3] = 255;
    }
    return out;
  }

  // Digits arrive one at a time: the first starts a fresh number, the second
  // completes it. A third starts over, so a mis-click costs one more click.
  let windEntry = '';
  function pushWindDigit(d) {
    if (windEntry.length >= 2) windEntry = '';
    windEntry += String(d);
    if (windEntry.length === 2) {
      windRaw = windEntry;
      state.windMag = parseWind(windRaw);
      saveState();
      if (ui && document.activeElement !== ui.windInput) ui.windInput.value = windRaw;
      fileWindSample();
    }
    syncControls();
    renderTargets();
  }
  function backWind() {
    if (windEntry.length) windEntry = windEntry.slice(0, -1);
    else { windRaw = windRaw.slice(0, -1); state.windMag = parseWind(windRaw); saveState(); }
    if (ui && document.activeElement !== ui.windInput) ui.windInput.value = windEntry || windRaw;
    syncControls();
    renderTargets();
  }
  // Flips which way the wind blows. That direction is one fact about the board,
  // the same for every target on it, so it is stored as-is and shown as-is; the
  // per-shot question of help or hindrance is settled inside signedWind.
  function flipWind() {
    state.windRight = !state.windRight;
    saveState();
    syncControls();
    renderTargets();
  }

  // The angle commits on every press rather than waiting for a fixed length,
  // because it can be two digits or three (65 and 125 are both ordinary). A press
  // that would push it past 179 starts a new number instead of being swallowed.
  let angleEntry = '';
  function pushAngleDigit(d) {
    let next = (angleEntry.length >= 3 ? '' : angleEntry) + String(d);
    if (next === '0') next = '';
    if (next && parseInt(next, 10) > 179) next = String(d) === '0' ? '' : String(d);
    angleEntry = next;
    const n = parseInt(angleEntry, 10);
    state.angle = (angleEntry && n >= 1 && n <= 179) ? n : null;
    saveState();
    if (ui && document.activeElement !== ui.angleInput) ui.angleInput.value = angleEntry;
    syncControls();
    renderTargets();
  }
  function backAngle() {
    angleEntry = angleEntry.slice(0, -1);
    const n = parseInt(angleEntry, 10);
    state.angle = (angleEntry && n >= 1 && n <= 179) ? n : null;
    saveState();
    if (ui) ui.angleInput.value = angleEntry;
    syncControls();
    renderTargets();
  }
  // 65 ⇄ 115: the same arc thrown over the other shoulder. Terrain often blocks one
  // side, and flipping by hand means clearing three digits and typing three more.
  function mirrorAngle() {
    if (state.angle == null) return;
    const n = 180 - state.angle;
    if (n < 1 || n > 179) return;
    state.angle = n;
    angleEntry = String(n);
    saveState();
    if (ui) ui.angleInput.value = angleEntry;
    syncControls();
    renderTargets();
  }

  // Every hand-entered wind is a labelled example: the crop above, plus the number
  // the player just read off it. Collect a few hundred across normal play and the
  // recogniser can be built and checked against real frames instead of guesses.
  function fileWindSample() {
    if (!state.collectWind) return;
    const digits = String(windRaw || '').replace(/[^0-9]/g, '');
    if (digits.length < 2) return;
    if (!windShot) {
      // Silence here is what hid the broken rectangle for a whole session.
      toast('采样没成功：还没抓到风力那块画面' + (windShotErr ? '（' + windShotErr + '）' : '，把鼠标放回游戏里再填一次'));
      return;
    }
    if (lastSampleSig === windShot.sig) return;
    lastSampleSig = windShot.sig;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = 'w-' + digits + '-' + (state.windRight ? 'R' : 'L') + '-' + stamp + '.png';
    ipcRenderer.invoke('aim:save-sample', windShot.png, name).then((res) => {
      if (res && res.ok) {
        state.windSamples = (state.windSamples || 0) + 1;
        saveState();
        syncControls();
      } else {
        lastSampleSig = null;
        toast('采样没成功：' + ((res && res.error) || '写文件失败'));
      }
    }).catch((e) => {
      lastSampleSig = null;
      toast('采样没成功：主进程没应答，重启一下小竹（' + ((e && e.message) || e) + '）');
    });
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // ------------------------------------------------------------------ the read
  function gameTab() {
    return typeof activeTab === 'function' ? activeTab() : null;
  }

  async function probeStage() {
    if (POPOUT) return await rpc('probe');
    const tab = gameTab();
    if (!tab || !tab.webview) return null;
    return await stageRect(tab.webview);
  }

  // One shape for a grabbed rectangle whichever window asked for it. The PNG is
  // only produced when something is going to be written to disk.
  async function grab(rect, wantPng) {
    if (POPOUT) return await rpc('grab', { rect, wantPng: !!wantPng });
    const tab = gameTab();
    if (!tab || !tab.webview) throw new Error('没有打开的游戏');
    const img = await capture(tab.webview, rect);
    const size = img.getSize();
    return { bmp: img.toBitmap(), w: size.width, h: size.height, png: wantPng ? img.toPNG() : null };
  }

  async function refresh() {
    if (busy || !visible) return;
    if (!POPOUT && poppedOut) return;      // the floating window is driving now
    busy = true;
    try {
      const stage = await probeStage();
      if (!stage) { statusText = '没找到游戏画面，先让游戏加载出来'; render(); return; }
      stageInfo = stage;
      const m = state.map;
      const rect = {
        x: Math.round(stage.x + stage.width * m.fx),
        y: Math.round(stage.y + stage.height * m.fy),
        width: Math.max(24, Math.round(stage.width * m.fw)),
        height: Math.max(24, Math.round(stage.height * m.fh)),
      };
      const shotRaw = await grab(rect, false);
      const size = { width: shotRaw.w, height: shotRaw.h };
      const raw = shotRaw.bmp;
      const pixels = size.width * size.height;

      // The plugin suspends itself and lays a translucent black sheet over the
      // stage whenever the pointer leaves it — which is every single time you
      // reach over to the panel. That is a flat multiply on every channel, so it
      // can simply be divided back out: remember how bright this map looks awake,
      // and scale a dimmed frame back up to that before looking at any colour.
      // Without this the Refresh button could never work, because pressing it
      // requires the very mouse move that puts the game to sleep.
      const luma = meanLuma(raw, pixels);
      // Read the frame as it came first. Undoing the sleep dimming is a rescue for
      // a frame that yielded nothing, not something to apply on suspicion: a map
      // that is simply darker than the last one would otherwise be "corrected"
      // every frame and never read at all.
      let bmp = raw, dimScale = 1;
      let read = readMinimap(raw, size.width, size.height, stage.width / stage.height);
      if (!read.players.length && brightRef && luma > 2 && luma < brightRef * 0.92) {
        dimScale = Math.min(4, brightRef / luma);
        bmp = brighten(raw, pixels, dimScale);
        read = readMinimap(bmp, size.width, size.height, stage.width / stage.height);
      }
      if (read.players.length && dimScale === 1) {
        brightRef = brightRef ? brightRef * 0.7 + luma * 0.3 : luma;
      }

      // Only frames captured while the game is awake are worth keeping as training
      // data — a dimmed one has different colours and would teach the wrong thing.
      if (state.collectWind && dimScale === 1) {
        try {
          const wr = state.wind;
          const wshot = await grab({
            x: Math.round(stage.x + stage.width * wr.fx),
            y: Math.round(stage.y + stage.height * wr.fy),
            width: Math.max(24, Math.round(stage.width * wr.fw)),
            height: Math.max(12, Math.round(stage.height * wr.fh)),
          }, true);
          windShot = {
            png: wshot.png,
            sig: cheapSig(wshot.bmp),
            w: wshot.w,
            h: wshot.h,
            rgba: bgraToRgba(wshot.bmp, wshot.w * wshot.h),
          };
          windShotErr = null;
        } catch (e) { windShotErr = String((e && e.message) || e).slice(0, 60); }
      }
      // Kept so the panel can show the very crop it just measured, with the dots
      // it picked marked on it. A mirrored reading is otherwise invisible until a
      // shot lands nowhere near the target.
      const shot = { w: size.width, h: size.height, rgba: bgraToRgba(bmp, pixels), dimScale };

      // The view box is the same width all through one battle, so a reading that
      // disagrees with the cached one means the map changed — a new round, a new
      // minimap scale. Two disagreeing frames in a row switch the cache over;
      // requiring two keeps a single odd measurement from throwing it away.
      // Without this the panel keeps quoting distances computed with the previous
      // map's scale ruler, which is what made a fresh battle read stale numbers.
      if (read.box) {
        const med = median(scaleHistory);
        if (med && Math.abs(read.box.width - med) > med * 0.08) {
          pendingScale.push(read.box.width);
          if (pendingScale.length >= 2) {
            scaleHistory = pendingScale.slice(-2);
            pendingScale = [];
            lastMe = null;
            focusNo = null;
          }
        } else {
          pendingScale = [];
          scaleHistory.push(read.box.width);
          if (scaleHistory.length > 9) scaleHistory.shift();
        }
      }
      const pxPer10 = median(scaleHistory);

      // Which side is the player's. Only two signals are trusted, in this order:
      //   ring    own team is drawn ringed, so it names the side outright. Checked
      //           every frame and always wins, because team colour changes from
      //           battle to battle and a remembered answer goes stale.
      //   manual  the 蓝/红 buttons, for maps where the thin ring stroke blends
      //           into the terrain and never resolves.
      // Whose turn it is deliberately does NOT feed this. It used to: if the panel
      // happened to take its first reading while an *enemy* was shooting, the
      // enemy's colour became "our" colour and every reading after that came out
      // mirrored — right target read as left, uphill read as downhill, and the
      // power was wrong in a way that still looked plausible. Guessing the side is
      // worse than admitting we don't know it.
      const shooter = read.players.find(p => p.turn) || null;
      const ringed = read.players.filter(p => p.ring);
      const ringTeam = (ringed.length && ringed.every(p => p.team === ringed[0].team))
        ? ringed[0].team : null;
      if (ringTeam) {
        myTeam = ringTeam;
        teamFrom = 'ring';
        // A stale manual pick that disagrees with what is on screen has to go, or
        // it will take over again the moment the ring stops resolving.
        if (state.myTeam && state.myTeam !== ringTeam) { state.myTeam = null; saveState(); }
      } else if (state.myTeam) {
        myTeam = state.myTeam;
        teamFrom = 'manual';
      } else {
        myTeam = null;
        teamFrom = null;
      }

      const friends = myTeam ? read.players.filter(p => p.team === myTeam) : [];
      const foes = myTeam ? read.players.filter(p => p.team !== myTeam) : [];
      // Among our own side the turn triangle picks the shooter — you on your turn,
      // a team mate on theirs. Off-turn, the player has not moved, so the friendly
      // dot nearest to where they were is still them.
      // Own side numbered left to right, same as the targets. Multi-opening puts
      // several of the player's own accounts in one battle and therefore on one
      // minimap, so picking a number here is how one panel serves all of them:
      // every reading is then computed from that character's dot.
      friends.sort((a, b) => a.x - b.x);
      let me = null;
      if (state.friendIdx != null && friends[state.friendIdx - 1]) {
        me = friends[state.friendIdx - 1];
      }
      if (!me && state.friendIdx == null) me = shooter && myTeam && shooter.team === myTeam ? shooter : null;
      if (!me && state.friendIdx == null && lastMe) {
        let bestD = Infinity;
        for (const f of friends) {
          const d = Math.hypot(f.x - lastMe.x, f.y - lastMe.y);
          if (d < bestD) { bestD = d; me = f; }
        }
        if (bestD > read.u * 25) me = null;
      }
      if (!me && state.friendIdx == null && friends.length === 1) me = friends[0];
      if (me) lastMe = { x: me.x, y: me.y };
      // Left to right, so the numbering on the cards, the numbering drawn on the
      // thumbnail and what you see on the actual minimap are the same order. In a
      // 3v3 "the second one from the left" is how you'd say it out loud anyway.
      foes.sort((a, b) => a.x - b.x);

      // The game suspends itself and dims the whole stage the moment the pointer
      // leaves it — which is exactly what happens when you reach over to type the
      // wind. A dimmed frame reads as nothing at all, so it must never wipe what
      // was on screen: the last good numbers stay, marked stale.
      if (!read.players.length) {
        stale = true;
        const cold = last && Date.now() - lastGoodAt > 4000;
        statusText = cold
          ? '已经 ' + Math.round((Date.now() - lastGoodAt) / 1000) + ' 秒没读到画面了，下面是旧数据。换图了或者标定框偏了就点「刷新」，还不行再重新标定'
          : (last
            ? '这一帧没认出光点，保留上一次的结果'
            : '画面上没认出光点。第一次读需要游戏是亮的，把鼠标放回游戏画面上再试');
        return;
      }

      if (!pxPer10) statusText = '还没读到视野白框，等一两秒或者重新标定小地图';
      else if (!myTeam) statusText = '认不出敌我：看一眼小地图，自己是哪个颜色就点上面的 蓝 或 红';
      else if (!me) statusText = '没认出你的光点，轮到你的时候会自动认出来';
      else if (!foes.length) statusText = '小地图上没看到对手';
      else statusText = '';
      if (state.collectWind && !state.windCalibrated) {
        statusText = (statusText ? statusText + '　' : '') + '风力采样还没标定：点右上角「标定」，第二步把风力那一条框一下';
      }

      if (pxPer10 && me && foes.length) {
        stale = false;
        lastGoodAt = Date.now();
        last = {
          pxPer10,
          me,
          foes,
          friends,
          myTurn: !!(shooter && me && shooter === me),
          shooterIsFoe: !!(shooter && myTeam && shooter.team !== myTeam),
          shot,
          at: Date.now(),
        };
      } else {
        stale = !!last;
      }
    } catch (e) {
      statusText = '读取画面失败：' + ((e && e.message) || e);
    } finally {
      busy = false;
      render();
    }
  }

  // Wind as the player reads it off the HUD — a magnitude plus an arrow — becomes
  // a signed number per target, because the same left-blowing wind helps a shot
  // aimed left and fights one aimed right.
  function signedWind(targetIsRight) {
    const mag = Number(state.windMag) || 0;
    return (targetIsRight === !!state.windRight) ? mag : -mag;
  }

  function solutionsFor(dx, dy, wind) {
    const rows = [];
    for (const deg of ANGLES) {
      const p = powerFor(deg, wind, dx, dy);
      if (p === null || p > 100 || p < 5) continue;
      // How much power one degree of aiming error costs — a flat entry is a shot
      // that forgives a slightly mis-set angle.
      const near = powerFor(deg + 1, wind, dx, dy);
      rows.push({ deg, power: p, slope: near === null ? null : Math.abs(near - p) });
    }
    return rows;
  }

  // --------------------------------------------------------------------- panel
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensurePanel() {
    if (document.getElementById('aim-panel')) return;
    const style = el('style');
    style.textContent = `
      #aim-panel { position: fixed; right: 14px; top: 78px; width: 322px; z-index: 60;
        background: var(--hud-bg, rgba(28,22,18,.94)); color: var(--text, #f4ece1);
        border: 1px solid var(--border, rgba(255,255,255,.14)); border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35); font-size: 12px; display: none; }
      #aim-panel.visible { display: block; }
      #aim-panel .aim-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
        border-bottom: 1px solid var(--border, rgba(255,255,255,.14)); cursor: move; }
      #aim-panel .aim-title { font-weight: 600; flex: 1; }
      #aim-panel .aim-x { background: none; border: 0; color: inherit; font-size: 15px;
        cursor: pointer; opacity: .7; padding: 0 2px; }
      #aim-panel .aim-body { padding: 8px 10px 10px; max-height: calc(100vh - 150px); overflow: auto; }
      #aim-panel .aim-wind { display: flex; align-items: center; gap: 5px; margin-bottom: 8px; }
      #aim-panel .aim-wind input { width: 46px; background: var(--field-bg, rgba(0,0,0,.3));
        color: inherit; border: 1px solid var(--border, rgba(255,255,255,.14));
        border-radius: 6px; padding: 3px 5px; font-size: 12px; }
      #aim-panel .aim-gap { margin-left: 6px; }
      #aim-panel .aim-eq { opacity: .75; min-width: 12px; }
      #aim-panel #aim-thumb { cursor: pointer; }
      #aim-panel #aim-thumb, #aim-panel #aim-windthumb { display: block; width: 100%; height: auto;
        border-radius: 6px; image-rendering: pixelated;
        border: 1px solid var(--border, rgba(255,255,255,.14)); }
      #aim-panel #aim-windthumb { margin-bottom: 6px; }
      #aim-panel .aim-thumbnote { opacity: .55; font-size: 11px; margin: 4px 0 6px; line-height: 1.4; }
      #aim-panel .aim-pads { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
      #aim-panel .aim-cap { font-size: 11px; opacity: .8; margin-bottom: 3px; }
      #aim-panel .aim-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; }
      #aim-panel .aim-pad-btn { background: var(--hud-fill, rgba(255,255,255,.08)); color: inherit;
        border: 1px solid var(--border, rgba(255,255,255,.14)); border-radius: 5px;
        padding: 7px 0; cursor: pointer; font-size: 13px; }
      #aim-panel .aim-pad-btn.sub { font-size: 11px; opacity: .75; }
      #aim-panel .aim-pad-btn:hover { background: var(--hud-fill-2, rgba(255,255,255,.16)); }
      #aim-panel .aim-body.stale .aim-target { opacity: .45; }
      #aim-panel .aim-pick { background: var(--accent, #c8783c); border-radius: 6px;
        padding: 5px 8px; margin-bottom: 5px; font-size: 13px; }
      #aim-panel .aim-pick b { font-size: 19px; }
      #aim-panel .aim-pick.bad { background: var(--hud-fill, rgba(255,255,255,.07)); opacity: .8; font-size: 12px; }
      #aim-panel .aim-note { float: right; opacity: .8; font-size: 11px; line-height: 24px; }
      #aim-panel button.aim-btn { background: var(--hud-fill, rgba(255,255,255,.08)); color: inherit;
        border: 1px solid var(--border, rgba(255,255,255,.14)); border-radius: 6px;
        padding: 3px 7px; cursor: pointer; font-size: 12px; }
      #aim-panel button.aim-btn.on { background: var(--accent, #c8783c); border-color: transparent; }
      #aim-panel .aim-status { opacity: .75; line-height: 1.5; margin-bottom: 6px; }
      #aim-panel .aim-target { border-top: 1px solid var(--border, rgba(255,255,255,.12));
        padding-top: 7px; margin-top: 7px; }
      #aim-panel .aim-dist { font-size: 13px; margin-bottom: 4px; }
      #aim-panel .aim-dist b { font-size: 16px; }
      #aim-panel .aim-no { display: inline-block; min-width: 15px; height: 15px; line-height: 15px;
        text-align: center; border-radius: 4px; background: #ff5c5c; color: #2a1410;
        font-size: 11px; font-weight: 700; margin-right: 5px; }
      #aim-panel .aim-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
      #aim-panel .aim-cell { background: var(--hud-fill, rgba(255,255,255,.07)); border-radius: 6px;
        padding: 4px 0; text-align: center; line-height: 1.25; }
      #aim-panel .aim-cell.best { background: var(--accent, #c8783c); }
      #aim-panel .aim-cell .p { font-size: 15px; font-weight: 600; }
      #aim-panel .aim-cell .d { opacity: .8; font-size: 11px; }
      #aim-panel .aim-foot { opacity: .55; margin-top: 8px; line-height: 1.5; }
      #aim-cal { position: fixed; inset: 0; z-index: 61; display: none; cursor: crosshair;
        background: rgba(0,0,0,.35); }
      #aim-cal.visible { display: block; }
      #aim-cal .aim-cal-tip { position: absolute; left: 50%; top: 22px; transform: translateX(-50%);
        background: rgba(0,0,0,.8); color: #fff; padding: 7px 13px; border-radius: 8px; font-size: 13px; }
      #aim-cal .aim-cal-box { position: absolute; border: 2px solid #ffd479; background: rgba(255,212,121,.16); }
    `;
    document.head.appendChild(style);

    const panel = el('div', '');
    panel.id = 'aim-panel';
    const head = el('div', 'aim-head');
    head.appendChild(el('div', 'aim-title', '竞技辅助'));
    const cal = el('button', 'aim-btn', '标定');
    cal.title = '两步：先框小地图，再框风力那一条';
    cal.addEventListener('click', () => startCalibration(0));
    head.appendChild(cal);
    const calWind = el('button', 'aim-btn', '标风力');
    calWind.title = '只重框风力那一条，小地图不动';
    calWind.addEventListener('click', () => startCalibration(1));
    head.appendChild(calWind);
    const dock = el('button', 'aim-btn', POPOUT ? '收回' : '弹出');
    dock.title = POPOUT ? '收回浏览器窗口里' : '变成一个可以拖到窗口外面的浮动小窗';
    dock.addEventListener('click', async () => {
      if (POPOUT) { ipcRenderer.invoke('aim:popin'); return; }
      const res = await ipcRenderer.invoke('aim:popout');
      if (res && res.ok) { poppedOut = true; toggle(false); }
      else toast('弹出失败：' + ((res && res.error) || '未知原因'));
    });
    head.appendChild(dock);
    const close = el('button', 'aim-x', '×');
    close.addEventListener('click', () => {
      if (POPOUT) ipcRenderer.invoke('aim:popin'); else toggle(false);
    });
    head.appendChild(close);
    panel.appendChild(head);

    // The controls are built once and then left alone. They used to be rebuilt on
    // every reading, which tore the text field out from under the caret — you got
    // one keystroke in before the next refresh wiped it.
    const body = el('div', 'aim-body');

    const windRow = el('div', 'aim-wind');
    windRow.appendChild(el('span', '', '风力'));
    const windInput = el('input');
    windInput.type = 'text';
    windInput.inputMode = 'numeric';
    windInput.placeholder = '07';
    windInput.title = '照着游戏里的数字打，小数点可以不打：07 就是 0.7，22 就是 2.2';
    windRow.appendChild(windInput);
    const windEq = el('span', 'aim-eq', '');
    windRow.appendChild(windEq);
    windRow.appendChild(el('span', 'aim-gap', '角度'));
    const angleInput = el('input');
    angleInput.type = 'text';
    angleInput.inputMode = 'numeric';
    angleInput.placeholder = '—';
    angleInput.title = '游戏里显示的角度，1 到 179，超过 90 就是反抛';
    windRow.appendChild(angleInput);
    body.appendChild(windRow);

    const teamRow = el('div', 'aim-wind');
    teamRow.appendChild(el('span', '', '我方'));
    const teamBlue = el('button', 'aim-btn', '蓝');
    const teamRed = el('button', 'aim-btn', '红');
    const teamAuto = el('button', 'aim-btn', '自判');
    teamAuto.title = '交给程序按光环和出手三角判断';
    teamRow.appendChild(teamBlue);
    teamRow.appendChild(teamRed);
    teamRow.appendChild(teamAuto);
    const nowBtn = el('button', 'aim-btn', '刷新');
    nowBtn.title = '换了一局就点它：清掉比例尺等缓存，重新读一次';
    teamRow.appendChild(nowBtn);
    const collectBtn = el('button', 'aim-btn', '采样');
    collectBtn.title = '每次手填风力，就把风力那一块画面连同你填的数字存一张到桌面，攒够了用来做自动识别';
    teamRow.appendChild(collectBtn);
    const autoBtn = el('button', 'aim-btn', '自动读');
    autoBtn.title = '每 0.6 秒重新读一次小地图';
    teamRow.appendChild(autoBtn);
    body.appendChild(teamRow);

    const thumbCap = el('div', 'aim-cap', '小地图');
    body.appendChild(thumbCap);
    const thumb = el('canvas', '');
    thumb.id = 'aim-thumb';
    thumb.title = '点小地图上的光点直接选：点己方就从它起算，点敌方就只看它';
    // Numbers are fine once you have counted the dots, but the thing you actually
    // mean is the dot itself — so clicking it picks it. Works the same in the
    // floating window, which has no game in it but does have this picture.
    thumb.addEventListener('click', (ev) => {
      if (!last || !last.shot) return;
      const box = thumb.getBoundingClientRect();
      if (!box.width || !thumb.width) return;
      const k = thumb.width / box.width;
      const px = (ev.clientX - box.left) * k;
      const py = (ev.clientY - box.top) * k;
      const near = (list) => {
        let best = null, bestD = Infinity;
        (list || []).forEach((d, i) => {
          const dist = Math.hypot(d.x - px, d.y - py);
          if (dist < bestD) { bestD = dist; best = i + 1; }
        });
        return { idx: best, d: bestD };
      };
      const reach = Math.max(10, last.shot.w * 0.08);
      const f = near(last.friends);
      const e2 = near(last.foes);
      if (f.idx && f.d <= e2.d && f.d < reach) {
        state.friendIdx = state.friendIdx === f.idx ? null : f.idx;
        lastMe = null;
        saveState();
        refresh();
      } else if (e2.idx && e2.d < reach) {
        focusNo = focusNo === e2.idx ? null : e2.idx;
        render();
      }
    });
    thumb.title = '程序读到的小地图。黄圈是它认为的你，红框是目标';
    body.appendChild(thumb);
    const thumbNote = el('div', 'aim-thumbnote', '点图上的光点就能选：己方（黄圈）换起算的人，敌方（红框）只看它。敌我认反了点上面的 蓝 / 红');
    body.appendChild(thumbNote);
    // The exact crop the sampler files. Shown for the same reason as the minimap
    // one: a rectangle pointing at the wrong part of the page is invisible until
    // you look at what it actually grabbed.
    const windCapLabel = el('div', 'aim-cap', '风力采样（应该是画面正上方那条箭头旗）');
    body.appendChild(windCapLabel);
    const windThumb = el('canvas', '');
    windThumb.id = 'aim-windthumb';
    windThumb.title = '风力采样截到的画面';
    body.appendChild(windThumb);

    // Two clicks and the wind is in: first digit is the whole part, second the
    // decimal. Typing still works, but mid-battle a click beats reaching for the
    // keyboard, and it never puts a stray keystroke into the game.
    // Two phone-style keypads side by side instead of one ten-wide strip: the
    // strip meant a long mouse run to reach a digit, and mid-turn that run is the
    // whole cost. Everything a shot needs is now inside one small square each.
    const pads = el('div', 'aim-pads');
    const buildPad = (caption, onDigit, extraLabel, onExtra, onBack) => {
      const col = el('div', 'aim-padcol');
      const cap = el('div', 'aim-cap', caption);
      col.appendChild(cap);
      const grid = el('div', 'aim-pad');
      const add = (label, fn, cls) => {
        const b = el('button', 'aim-pad-btn' + (cls ? ' ' + cls : ''), label);
        b.addEventListener('click', fn);
        grid.appendChild(b);
      };
      for (let d = 1; d <= 9; d++) add(String(d), () => onDigit(d));
      add(extraLabel, onExtra, 'sub');
      add('0', () => onDigit(0));
      add('⌫', onBack, 'sub');
      col.appendChild(grid);
      pads.appendChild(col);
      return cap;
    };
    const windCap = buildPad('风力', pushWindDigit, '±', flipWind, backWind);
    const angleCap = buildPad('角度', pushAngleDigit, '反抛', mirrorAngle, backAngle);
    body.appendChild(pads);

    const friendRow = el('div', 'aim-wind');
    friendRow.id = 'aim-friends';
    body.appendChild(friendRow);

    const status = el('div', 'aim-status');
    body.appendChild(status);
    const results = el('div', 'aim-results');
    body.appendChild(results);
    panel.appendChild(body);
    document.body.appendChild(panel);
    makeDraggable(panel, head);

    ui = { panel, body, windInput, windEq, angleInput,
           teamBlue, teamRed, teamAuto, autoBtn, collectBtn, status, results, thumb, thumbNote,
           thumbCap, windThumb, windCapLabel, friendRow,
           windCap, angleCap };

    windInput.value = windRaw;
    angleInput.value = state.angle == null ? '' : String(state.angle);

    windInput.addEventListener('input', () => {
      windEntry = '';
      windRaw = windInput.value;
      // "-05" is a perfectly natural way to type a leftward 0.5, so honour it.
      if (/^\s*-/.test(windRaw)) state.windRight = false;
      else if (/^\s*\+/.test(windRaw)) state.windRight = true;
      state.windMag = parseWind(windRaw);
      windEq.textContent = '= ' + state.windMag.toFixed(1);
      saveState();
      fileWindSample();
      renderTargets();
    });
    angleInput.addEventListener('input', () => {
      const v = angleInput.value.replace(/[^0-9]/g, '');
      if (v !== angleInput.value) angleInput.value = v;
      angleEntry = v.slice(0, 3);
      const n = parseInt(v, 10);
      state.angle = (!v || !isFinite(n) || n < 1 || n > 179) ? null : n;
      saveState();
      renderTargets();
    });
    const pickTeam = (key) => {
      state.myTeam = key;
      myTeam = key;
      lastMe = null;
      saveState();
      syncControls();
      refresh();
    };
    teamBlue.addEventListener('click', () => pickTeam('blue'));
    teamRed.addEventListener('click', () => pickTeam('red'));
    teamAuto.addEventListener('click', () => pickTeam(null));
    // Not just "read one more frame": everything cached about the current map is
    // dropped first — the scale ruler, the brightness baseline, where the player
    // was. That is what you actually want after a new round starts, and it is what
    // re-calibrating happened to do as a side effect.
    nowBtn.addEventListener('click', () => {
      scaleHistory = [];
      pendingScale = [];
      brightRef = null;
      lastMe = null;
      focusNo = null;
      last = null;
      stale = false;
      statusText = '重新读取中…';
      render();
      refresh();
    });
    collectBtn.addEventListener('click', () => {
      state.collectWind = !state.collectWind;
      saveState();
      syncControls();
    });
    autoBtn.addEventListener('click', () => {
      state.autoRefresh = !state.autoRefresh;
      saveState();
      applyTimer();
      syncControls();
    });

    const overlay = el('div', '');
    overlay.id = 'aim-cal';
    overlay.appendChild(el('div', 'aim-cal-tip', '拖一个框把小地图圈住（只圈地图，不要圈上面的标题条）。Esc 取消'));
    document.body.appendChild(overlay);
    wireCalibration(overlay);
  }

  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, sl = 0, st = 0, dragging = false;
    handle.addEventListener('mousedown', (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect();
      dragging = true; sx = ev.clientX; sy = ev.clientY; sl = r.left; st = r.top;
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      panel.style.left = Math.max(4, sl + ev.clientX - sx) + 'px';
      panel.style.top = Math.max(4, st + ev.clientY - sy) + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ---------------------------------------------------------------- calibration
  // Stored as fractions of the Flash element, so it is a one-time job: resizing
  // the window afterwards keeps the same region.
  let calStart = null;
  // Calibration is two drags, not one. The wind banner needs its own rectangle for
  // the same reason the minimap does: the fractions are measured against whatever
  // the stage probe found, and when the game sits in a cross-origin iframe that is
  // the iframe (the whole page area), not the Flash stage. Default fractions taken
  // from a real stage then point somewhere else entirely — which is exactly why the
  // wind sampler was quietly filing nothing.
  let calStep = 0;              // 0 = minimap, 1 = wind banner
  let calResolve = null;        // owner side: settles when the drag finishes
  const CAL_TIPS = [
    '① 拖一个框把小地图圈住（只圈地图，不要圈上面的标题条）。Esc 取消',
    '② 现在框「风力」那一条 —— 在游戏画面正上方、写着「风力」的箭头旗，把箭头、两个数字、尾巴的圆点都框进去。不是小地图。Esc 跳过',
  ];

  // Owner side. Puts the crosshair sheet over the game, waits for one drag, and
  // answers with the rectangle expressed as fractions of the stage — or null if
  // the user pressed Esc or drew something too small to mean anything.
  function dragRect(step) {
    const overlay = document.getElementById('aim-cal');
    if (!overlay) return Promise.resolve(null);
    if (calResolve) { const r = calResolve; calResolve = null; r(null); }
    calStep = step || 0;
    calibrating = true;
    calStart = null;
    const tip = overlay.querySelector('.aim-cal-tip');
    if (tip) tip.textContent = CAL_TIPS[calStep];
    overlay.classList.add('visible');
    return new Promise((resolve) => { calResolve = resolve; });
  }

  function endCalibration(result) {
    calibrating = false;
    calStart = null;
    const overlay = document.getElementById('aim-cal');
    if (overlay) {
      overlay.classList.remove('visible');
      const b = overlay.querySelector('.aim-cal-box');
      if (b) b.remove();
    }
    if (calResolve) { const r = calResolve; calResolve = null; r(result || null); }
  }

  function wireCalibration(overlay) {
    overlay.addEventListener('mousedown', (ev) => {
      calStart = { x: ev.clientX, y: ev.clientY };
      let box = overlay.querySelector('.aim-cal-box');
      if (!box) { box = el('div', 'aim-cal-box'); overlay.appendChild(box); }
      box.style.left = ev.clientX + 'px';
      box.style.top = ev.clientY + 'px';
      box.style.width = '0px';
      box.style.height = '0px';
    });
    overlay.addEventListener('mousemove', (ev) => {
      if (!calStart) return;
      const box = overlay.querySelector('.aim-cal-box');
      if (!box) return;
      box.style.left = Math.min(calStart.x, ev.clientX) + 'px';
      box.style.top = Math.min(calStart.y, ev.clientY) + 'px';
      box.style.width = Math.abs(ev.clientX - calStart.x) + 'px';
      box.style.height = Math.abs(ev.clientY - calStart.y) + 'px';
    });
    overlay.addEventListener('mouseup', async (ev) => {
      if (!calStart) return;
      const x0 = Math.min(calStart.x, ev.clientX), y0 = Math.min(calStart.y, ev.clientY);
      const w = Math.abs(ev.clientX - calStart.x), h = Math.abs(ev.clientY - calStart.y);
      if (w < 20 || h < 10) { endCalibration(null); return; }
      const tab = gameTab();
      const stage = tab && tab.webview ? await stageRect(tab.webview) : null;
      if (!stage) { endCalibration(null); toast('没找到游戏画面'); return; }
      // Screen coordinates -> the webview's own box -> fractions of the stage.
      const wr = tab.webview.getBoundingClientRect();
      endCalibration({
        fx: (x0 - wr.left - stage.x) / stage.width,
        fy: (y0 - wr.top - stage.y) / stage.height,
        fw: w / stage.width,
        fh: h / stage.height,
      });
    });
    window.addEventListener('keydown', (ev) => {
      if (calibrating && ev.key === 'Escape') { endCalibration(null); ev.preventDefault(); }
    }, true);
  }

  // Both modes come through here. The drag itself always happens over the game,
  // in the browser window; only the answer travels.
  async function startCalibration(step) {
    let frac = null;
    try {
      frac = POPOUT ? await rpc('calibrate', step || 0) : await dragRect(step || 0);
    } catch (e) {
      toast('标定失败：' + ((e && e.message) || e));
      return;
    }
    if (!frac) return;
    if ((step || 0) === 0) {
      state.map = frac;
      scaleHistory = [];
      saveState();
      refresh();
      setTimeout(() => startCalibration(1), 260);
      return;
    }
    // Drawn over the minimap again is the one mistake worth catching: both steps
    // look alike, and the result is a sampler that quietly files the wrong picture
    // for days.
    const m = state.map;
    const ox = Math.max(0, Math.min(frac.fx + frac.fw, m.fx + m.fw) - Math.max(frac.fx, m.fx));
    const oy = Math.max(0, Math.min(frac.fy + frac.fh, m.fy + m.fh) - Math.max(frac.fy, m.fy));
    if (ox * oy > 0.45 * frac.fw * frac.fh) {
      toast('这个框跟小地图重在一起了。风力那一条在游戏画面正上方，写着「风力」的箭头旗，重新点「标风力」框一次');
      return;
    }
    state.wind = frac;
    state.windCalibrated = true;
    windShot = null;
    saveState();
    toast('风力已标定，填一次风力看看下面那张预览对不对');
    refresh();
  }

  // Owner side: serve the three things the floating window cannot do itself.
  if (!POPOUT) {
    ipcRenderer.on('aim:rpc', async (_e, id, method, args) => {
      try {
        let out = null;
        if (method === 'probe') {
          const tab = gameTab();
          out = tab && tab.webview ? await stageRect(tab.webview) : null;
        } else if (method === 'grab') {
          out = await grab(args.rect, args.wantPng);
        } else if (method === 'calibrate') {
          out = await dragRect(args || 0);
        }
        ipcRenderer.send('aim:rpc-result', id, true, out);
      } catch (err) {
        ipcRenderer.send('aim:rpc-result', id, false, String((err && err.message) || err));
      }
    });
    ipcRenderer.on('aim:popout-closed', () => {
      poppedOut = false;
      toggle(true);
    });
  }

  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
  }

  // -------------------------------------------------------------------- render
  // The controls are built once, in ensurePanel, and only kept in sync here.
  // Rebuilding them on every reading is what made the fields unusable: twice a
  // second the input was torn out from under the caret, so the second keystroke
  // went nowhere and Delete did nothing. Values are never written back into a
  // field while it has focus, for the same reason.
  function syncControls() {
    if (!ui) return;
    ui.windEq.textContent = windEntry.length === 1
      ? '= ' + windEntry + '._'
      : '= ' + (Number(state.windMag) || 0).toFixed(1);
    ui.teamBlue.classList.toggle('on', myTeam === 'blue');
    ui.teamRed.classList.toggle('on', myTeam === 'red');
    ui.teamAuto.classList.toggle('on', !state.myTeam);
    ui.autoBtn.classList.toggle('on', !!state.autoRefresh);
    ui.collectBtn.classList.toggle('on', !!state.collectWind);
    ui.collectBtn.textContent = state.collectWind ? ('采样 ' + (state.windSamples || 0)) : '采样';
    if (windEntry.length === 1) {
      ui.windCap.textContent = '风力 ' + windEntry + '._';
    } else {
      // The sign is the wind's own direction and nothing else: + blows right,
      // − blows left, exactly what the arrow on the HUD says. Whether that helps
      // or fights a particular shot is the formula's business, not a label's.
      const mag = Number(state.windMag) || 0;
      ui.windCap.textContent = '风力 ' + (state.windRight ? '+' : '−') + mag.toFixed(1) +
        (state.windRight ? ' →' : ' ←');
    }
    ui.angleCap.textContent = '角度 ' + (state.angle == null ? '—' : state.angle + '°');
  }

  function fillInputsFromState() {
    if (!ui) return;
    if (document.activeElement !== ui.windInput) ui.windInput.value = windRaw;
    if (document.activeElement !== ui.angleInput) {
      ui.angleInput.value = state.angle == null ? '' : String(state.angle);
    }
    syncControls();
  }

  // The crop the numbers came from, with the dots the code picked marked on it.
  // One glance says whether it has you and the target the right way round, which
  // is the one mistake that produces confident, plausible, completely wrong power.
  function drawThumb() {
    if (!ui || !ui.thumb) return;
    const t = last && last.shot;
    if (!t) {
      ui.thumb.style.display = 'none';
      ui.thumbNote.style.display = 'none';
      ui.thumbCap.style.display = 'none';
      return;
    }
    ui.thumb.style.display = '';
    ui.thumbNote.style.display = '';
    ui.thumbCap.style.display = '';
    if (ui.thumb.width !== t.w || ui.thumb.height !== t.h) { ui.thumb.width = t.w; ui.thumb.height = t.h; }
    const ctx = ui.thumb.getContext && ui.thumb.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(t.rgba, t.w, t.h), 0, 0);
    ctx.lineWidth = Math.max(1.2, t.w / 110);
    const size = Math.max(9, t.w * 0.075);
    ctx.font = 'bold ' + size.toFixed(0) + 'px sans-serif';
    ctx.textBaseline = 'bottom';
    (last.foes || []).forEach((f, i) => {
      const r = Math.max(4, t.w * 0.035);
      ctx.strokeStyle = '#ff5c5c';
      ctx.strokeRect(f.x - r, f.y - r, r * 2, r * 2);
      if ((last.foes || []).length > 1) {
        const label = String(i + 1);
        ctx.lineWidth = Math.max(2, t.w / 70);
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(label, f.x + r + 1, f.y - r + size * 0.2);
        ctx.fillStyle = '#ff9a9a';
        ctx.fillText(label, f.x + r + 1, f.y - r + size * 0.2);
        ctx.lineWidth = Math.max(1.2, t.w / 110);
      }
    });
    (last.friends || []).forEach((f, i) => {
      const active = last.me && Math.abs(f.x - last.me.x) < 1 && Math.abs(f.y - last.me.y) < 1;
      const r = Math.max(6, t.w * 0.055);
      ctx.strokeStyle = active ? '#ffd479' : 'rgba(255,212,121,.45)';
      ctx.lineWidth = active ? Math.max(1.6, t.w / 90) : Math.max(1, t.w / 150);
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if ((last.friends || []).length > 1) {
        const label = String(i + 1);
        ctx.lineWidth = Math.max(2, t.w / 70);
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(label, f.x + r + 1, f.y - r + size * 0.2);
        ctx.fillStyle = active ? '#ffd479' : 'rgba(255,212,121,.6)';
        ctx.fillText(label, f.x + r + 1, f.y - r + size * 0.2);
      }
    });
    if (last.me && !(last.friends || []).length) {
      ctx.strokeStyle = '#ffd479';
      ctx.beginPath();
      ctx.arc(last.me.x, last.me.y, Math.max(6, t.w * 0.055), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawWindThumb() {
    if (!ui || !ui.windThumb) return;
    const c = ui.windThumb;
    const show = !!(state.collectWind && windShot && windShot.rgba);
    c.style.display = show ? '' : 'none';
    ui.windCapLabel.style.display = show ? '' : 'none';
    if (!show) return;
    if (c.width !== windShot.w || c.height !== windShot.h) { c.width = windShot.w; c.height = windShot.h; }
    const wctx = c.getContext && c.getContext('2d');
    if (wctx) wctx.putImageData(new ImageData(windShot.rgba, windShot.w, windShot.h), 0, 0);
  }

  function render() {
    ensurePanel();
    ui.panel.classList.toggle('visible', visible);
    if (!visible) return;
    syncControls();
    ui.status.textContent = statusText || '';
    ui.status.style.display = statusText ? '' : 'none';
    drawThumb();
    drawWindThumb();
    renderFriends();
    renderTargets();
  }

  function renderFriends() {
    if (!ui || !ui.friendRow) return;
    const row = ui.friendRow;
    row.innerHTML = '';
    const list = (last && last.friends) || [];
    if (list.length < 2 && state.friendIdx == null) { row.style.display = 'none'; return; }
    row.style.display = '';
    row.appendChild(el('span', '', '从'));
    const mk = (label, idx, title) => {
      const b = el('button', 'aim-btn' + (state.friendIdx === idx ? ' on' : ''), label);
      if (title) b.title = title;
      b.addEventListener('click', () => {
        state.friendIdx = idx;
        lastMe = null;
        saveState();
        refresh();
      });
      row.appendChild(b);
    };
    mk('自动', null, '轮到谁就从谁算');
    for (let i = 1; i <= Math.max(list.length, state.friendIdx || 0); i++) {
      mk('己方' + i, i, '从左数第 ' + i + ' 个己方光点起算');
    }
    row.appendChild(el('span', 'aim-foot', '打'));
  }

  function renderTargets() {
    if (!ui) return;
    const out = ui.results;
    out.innerHTML = '';
    ui.body.classList.toggle('stale', !!stale);
    if (!last || !last.pxPer10 || !last.me || !last.foes || !last.foes.length) return;

    const scale = 10 / last.pxPer10;   // 距离 per pixel
    const targets = last.foes.map((f, i) => {
      const dxPx = f.x - last.me.x;
      const dyPx = last.me.y - f.y;            // screen y grows downward
      return { f, no: i + 1, dist: Math.abs(dxPx) * scale, drop: dyPx * scale, right: dxPx > 0 };
    });
    if (focusNo != null && !targets.some(t => t.no === focusNo)) focusNo = null;

    for (const t of targets) {
      if (focusNo != null && t.no !== focusNo) continue;
      const wrap = el('div', 'aim-target');
      const head = el('div', 'aim-dist');
      const w = signedWind(t.right);
      head.innerHTML = '<span class="aim-no">' + t.no + '</span>' +
        (t.right ? '→ ' : '← ') + '距离 <b>' + t.dist.toFixed(1) + '</b> 屏　高差 ' +
        (t.drop >= 0 ? '+' : '') + t.drop.toFixed(1);
      head.title = targets.length > 1 ? '点一下只看这个目标，再点恢复全部' : '';
      if (targets.length > 1 || focusNo != null) {
        head.style.cursor = 'pointer';
        head.addEventListener('click', () => { focusNo = focusNo === t.no ? null : t.no; render(); });
      }
      wrap.appendChild(head);

      const wind = w;
      if (state.angle != null) {
        const p = powerFor(state.angle, wind, t.dist, t.drop);
        const back = state.angle > 90 ? '<span class="aim-note">反抛 · 同 ' + (180 - state.angle) + '°</span>' : '';
        const pick = el('div', 'aim-pick');
        if (p == null || p > 100) {
          pick.classList.add('bad');
          pick.textContent = state.angle + '° 打不到，角度要放平或者抬高一点';
        } else {
          pick.innerHTML = state.angle + '° → 力度 <b>' + p.toFixed(1) + '</b>' + back;
        }
        wrap.appendChild(pick);
      }

      const rows = solutionsFor(t.dist, t.drop, wind);
      if (!rows.length) {
        wrap.appendChild(el('div', 'aim-status', '这个距离满力度也够不着'));
      } else {
        // The flattest entry in a sensible power band is the one a slightly wrong
        // angle hurts least, so it leads — unless the player has set an angle of
        // their own, in which case the answer is the line above and the spread is
        // only there for comparison.
        let best = null;
        if (state.angle == null) {
          for (const r of rows) {
            if (r.power < 25 || r.power > 92) continue;
            if (!best || (r.slope != null && best.slope != null && r.slope < best.slope)) best = r;
          }
        }
        const grid = el('div', 'aim-grid');
        for (const r of rows) {
          const cell = el('div', 'aim-cell' + (r === best ? ' best' : ''));
          cell.appendChild(el('div', 'd', r.deg + '°'));
          cell.appendChild(el('div', 'p', String(Math.round(r.power))));
          grid.appendChild(cell);
        }
        wrap.appendChild(grid);
      }
      out.appendChild(wrap);
    }

    const bits = ['比例尺 ' + last.pxPer10.toFixed(0) + 'px = 10 距离'];
    if (stageInfo) {
      bits.push('画面 ' + Math.round(stageInfo.width) + '×' + Math.round(stageInfo.height) +
        '（' + stageInfo.kind + (Math.abs(stageInfo.zoom - 1) > 0.01 ? ' 缩放' + stageInfo.zoom.toFixed(2) : '') + '）');
    }
    if (myTeam) bits.push('我方' + (myTeam === 'blue' ? '蓝' : '红') + (teamFrom === 'ring' ? '（认出光环）' : '（你指定的）'));
    if (focusNo != null) bits.push('只看目标 ' + focusNo + '，点标题恢复全部');
    if (!last.myTurn) bits.push('现在不是你出手，数字按上面这个己方光点算');
    out.appendChild(el('div', 'aim-foot', bits.join('　')));
  }

  // --------------------------------------------------------------------- timer
  function applyTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (visible && state.autoRefresh) {
      // Inside the browser window a background window shouldn't burn CPU, so the
      // read is gated on focus. The floating window is the opposite case: it is
      // never the focused window — the game is — and gating there would freeze it.
      timer = setInterval(() => { if (POPOUT || document.hasFocus()) refresh(); }, 600);
    }
  }

  function toggle(force) {
    if (!POPOUT && poppedOut && force !== false) {
      ipcRenderer.invoke('aim:popout');   // already out there: just bring it forward
      return;
    }
    ensurePanel();
    visible = typeof force === 'boolean' ? force : !visible;
    if (!visible) endCalibration();
    render();
    applyTimer();
    if (visible) refresh();
  }

  loadState().then(() => { fillInputsFromState(); if (visible) render(); });

  window.AimAssist = {
    toggle,
    refresh,
    // Popped out counts as on: the tools menu tick and the hotkey both mean
    // "is the assist up", not "is it up in this particular window".
    isVisible: () => visible || poppedOut,
    // exposed for calibration work against saved screenshots
    _powerFor: powerFor,
    _readMinimap: readMinimap,
  };
})();
