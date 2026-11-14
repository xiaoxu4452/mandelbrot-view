// shell.js — minimal web shell around the desktop core.
//
// One canvas, one engine (the compiled C++ core), no shader/WebGPU/prog-
// ressive passes. Gestures repaint a reduced full frame through the same
// core; the committed frame is always a single full-resolution render.
// Wheel model: commit 07f0583c — 1.522x per notch, snapshot feedback,
// 360 ms debounce, no glide.
//
// The view centre is kept as a DECIMAL STRING at full depth. Every gesture
// applies a small delta (a double, ≤17 significant digits) onto that string
// with BigInt arithmetic, so a 1e-603 pan on a 63-digit centre never loses a
// digit. No code path ever subtracts two large numbers.

'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d', { alpha: false });

// ------------------------------------------------------------------ state
const state = {
  center: { re: '-0.6', im: '0.0' },
  span: { m: 3.0, e: 0 },          // window width = m * 2^e (plane units)
  iter: 0,                          // 0 = automatic
  palette: 'ocean',
  julia: false,
  juliaRe: '-0.7435',
  juliaIm: '0.1314',
};

const LOG10_2 = Math.log10(2);
function spanWidthLog10() { return Math.log10(state.span.m) + state.span.e * LOG10_2; }
function depthLog10() { return -spanWidthLog10(); }

function autoIter() {
  const d = Math.max(0, depthLog10());
  return Math.min(50000, Math.max(250, Math.round(300 + 111 * d)));
}
function effectiveIter() {
  const v = state.iter > 0 ? state.iter : autoIter();
  return Math.min(200000, Math.max(64, v | 0));
}

// Zoom (desktop CLI semantics): zoom = 3 / windowWidth.
function zoomParts() {
  const log10z = Math.log10(3) - spanWidthLog10();
  const exp10 = Math.floor(log10z);
  const mant = Math.pow(10, log10z - exp10);
  return { mant, exp10 };
}

// Pixel size in plane units per canvas DEVICE pixel.
function pixelSize() { return Math.pow(10, spanWidthLog10()) / canvas.width; }

// ------------------------------------------- high-precision decimal helpers
/**
 * Add a small double delta to a decimal string without losing depth.
 * keep = decimals kept in the result (>= significant digits of the centre).
 */
function addDec(str, delta, keep) {
  if (!delta) return str;
  const S = keep + 8;   // working scale in decimals

  const parse = (s) => {
    s = String(s).trim().toLowerCase();
    let sign = 1n;
    if (s[0] === '-') { sign = -1n; s = s.slice(1); }
    else if (s[0] === '+') s = s.slice(1);
    let e = 0;
    const ep = s.indexOf('e');
    if (ep >= 0) { e = parseInt(s.slice(ep + 1), 10) || 0; s = s.slice(0, ep); }
    const dot = s.indexOf('.');
    const intPart = dot >= 0 ? s.slice(0, dot) : s;
    const frac = dot >= 0 ? s.slice(dot + 1) : '';
    const digits = (intPart + frac).replace(/^0+(?=\d)/, '') || '0';
    const len = digits === '0' ? 1 : digits.length;
    // value = sign * digits * 10^exp, exp = exponent of the LAST digit
    const exp = e - frac.length;
    return { sign, digits: BigInt(digits), exp, len };
  };

  const scaled = (p) => {
    // value * 10^S as BigInt
    const shift = p.exp + S;
    if (p.digits === 0n) return 0n;
    if (shift >= 0) return p.sign * p.digits * 10n ** BigInt(shift);
    // keep floor semantics; truncation happens far below the wanted digits
    return p.sign * (p.digits / 10n ** BigInt(-shift));
  };

  const A = parse(str);
  const D = parse(Number(delta).toExponential(17));
  const total = scaled(A) + scaled(D);

  // total / 10^S -> fixed-point string with `keep` decimals
  const neg = total < 0n;
  const mag = neg ? -total : total;
  const s = mag.toString().padStart(S + 1, '0');
  const intPart = s.slice(0, s.length - S) || '0';
  let frac = s.slice(s.length - S, s.length - S + keep);
  frac = frac.replace(/0+$/, '');
  let out = intPart + (frac ? '.' + frac : '');
  if (neg && mag !== 0n) out = '-' + out;
  return out;
}

// -------------------------------------------------------------- rendering
const worker = new Worker('shell-worker.js?v=1');
let frameId = 0;
let pendingKind = null;      // 'final' | 'preview'
let busy = false;
let queued = null;           // latest queued job while busy

function dispatchJob(kind, scale) {
  const { mant, exp10 } = zoomParts();
  const w = Math.max(2, Math.round(canvas.width * scale));
  const h = Math.max(2, Math.round(canvas.height * scale));
  const job = {
    centerRe: state.center.re, centerIm: state.center.im,
    zoomMant: mant, zoomExp10: exp10,
    width: w, height: h,
    maxiter: kind === 'final' ? effectiveIter() : Math.min(effectiveIter(), 2500),
    julia: state.julia,
    juliaRe: state.juliaRe, juliaIm: state.juliaIm,
    palette: state.palette,
  };
  worker.postMessage({ cmd: 'render', id: ++frameId, job });
  busy = true;
  pendingKind = kind;
  if (kind === 'final') splashDone();
}

worker.onmessage = (ev) => {
  const msg = ev.data;
  busy = false;
  if (msg.type === 'error') { note('渲染失败: ' + msg.err); return; }
  if (msg.type !== 'frame') return;
  if (msg.err) note(msg.err);

  const img = new ImageData(new Uint8ClampedArray(msg.rgba), msg.w, msg.h);
  if (msg.w === canvas.width && msg.h === canvas.height) {
    ctx.putImageData(img, 0, 0);
  } else {
    off.width = msg.w; off.height = msg.h;
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }
  if (pendingKind === 'final') {
    hud(msg.stats, msg.ms);
    pushHistory();
  }
  pendingKind = null;

  if (queued) { const q = queued; queued = null; dispatchJob(q.kind, q.scale); }
};

const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

let renderTimer = 0;
function requestFinal(delay = 0) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (busy) { queued = { kind: 'final', scale: 1 }; return; }
    dispatchJob('final', 1);
  }, delay);
}
function requestPreview() {
  if (busy) { queued = { kind: 'preview', scale: 0.36 }; return; }
  dispatchJob('preview', 0.36);
}

// --------------------------------------------------------------- snapshot
// A gesture transforms the last committed frame instantly (pan/zoom of the
// snapshot), while a reduced full frame from the core follows it. This keeps
// movement 1:1 under the finger without any second engine.
const snap = document.createElement('canvas');
const snapCtx = snap.getContext('2d');

function takeSnapshot() {
  snap.width = canvas.width; snap.height = canvas.height;
  snapCtx.drawImage(canvas, 0, 0);
}
function paintSnapshot(px, py, scale) {
  // Plane point under device pixel (px, py) stays under it, zoomed by scale.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(snap, px - px * scale, py - py * scale,
    canvas.width * scale, canvas.height * scale);
}
function paintSnapshotPan(tdx, tdy) {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(snap, tdx, tdy);
}

// ------------------------------------------------------------------ HUD
function fmtZoom(log10z) {
  return `zoom 10^${log10z.toFixed(1)}`;
}
function hud(stats, ms) {
  const c = state.center;
  const half = (s) => {
    s = String(s);
    return s.length > 44 ? s.slice(0, 22) + '…' + s.slice(-20) : s;
  };
  const im = c.im;
  $('hud-coord').textContent =
    `${half(c.re)}  ${im.startsWith('-') ? '-' : '+'} ${half(im.replace(/^-/, ''))}i`;
  $('hud-zoom').textContent = fmtZoom(Math.log10(3) - spanWidthLog10());
  if (stats) {
    $('hud-stat').textContent =
      `iter ${effectiveIter()} · ref ${stats.refLen} · ${stats.precDigits} digits · ` +
      `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms · bigfloat`;
  }
}
let noteTimer = 0;
function note(s) {
  $('note').textContent = s;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { $('note').textContent = ''; }, 4000);
}
function splashDone() { $('splash').classList.add('done'); }

// ---------------------------------------------------------------- gestures
const pointers = new Map();
let gesture = null;   // {kind:'pan'|'pinch', ...}

function commitAfterGesture() {
  gesture = null;
  requestFinal(60);
}

canvas.addEventListener('pointerdown', (ev) => {
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic pointers may reject */ }
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  takeSnapshot();
  const dpr = canvas.width / canvas.clientWidth;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = {
      kind: 'pinch',
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) * dpr,
      span0: { ...state.span },
      center0: { ...state.center },
      mid0: { x: (a.x + b.x) / 2 * dpr, y: (a.y + b.y) / 2 * dpr },
    };
  } else if (pointers.size === 1) {
    gesture = { kind: 'pan', tdx: 0, tdy: 0, center0: { ...state.center } };
  }
});

canvas.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  const dpr = canvas.width / canvas.clientWidth;
  const prev = pointers.get(ev.pointerId);
  const cur = { x: ev.clientX, y: ev.clientY };
  pointers.set(ev.pointerId, cur);

  if (pointers.size === 1 && gesture && gesture.kind === 'pan') {
    const dx = (cur.x - prev.x) * dpr, dy = (cur.y - prev.y) * dpr;
    gesture.tdx += dx; gesture.tdy += dy;
    const ps = pixelSize();
    // centre = centre0 + (-tdx * ps, +tdy * ps)   — string + small delta
    state.center = {
      re: addDec(gesture.center0.re, -gesture.tdx * ps, keepDigits()),
      im: addDec(gesture.center0.im, gesture.tdy * ps, keepDigits()),
    };
    paintSnapshotPan(gesture.tdx, gesture.tdy);
    hud();
    if (!busy) requestPreview(); else queued = { kind: 'preview', scale: 0.36 };
  } else if (pointers.size === 2 && gesture && gesture.kind === 'pinch') {
    const [a, b] = [...pointers.values()];
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) * dpr;
    const f = gesture.d0 / d;                    // new span / old span
    const mid = { x: (a.x + b.x) / 2 * dpr, y: (a.y + b.y) / 2 * dpr };
    state.span = scaleSpan(gesture.span0, f);
    const ps0 = Math.pow(10, spanWidthLog10Of(gesture.span0)) / canvas.width;
    const ps1 = pixelSize();
    // centre' = centre0 + (mid0 - W/2)*ps0 - (mid - W/2)*ps1   (x)
    //          = centre0 + (H/2 - mid0)*ps0 - (H/2 - mid)*ps1  (y, plane y up)
    // The midpoint motion is inside the second term; nothing else is needed.
    const dx = (gesture.mid0.x - canvas.width / 2) * ps0 - (mid.x - canvas.width / 2) * ps1;
    const dy = (canvas.height / 2 - gesture.mid0.y) * ps0 - (canvas.height / 2 - mid.y) * ps1;
    const K = keepDigits();
    state.center = {
      re: addDec(gesture.center0.re, dx, K),
      im: addDec(gesture.center0.im, dy, K),
    };
    paintSnapshot(mid.x, mid.y, f);
    hud();
    if (!busy) requestPreview(); else queued = { kind: 'preview', scale: 0.36 };
  }
});

function keepDigits() { return Math.max(18, Math.ceil(depthLog10()) + 20); }

function spanWidthLog10Of(s) { return Math.log10(s.m) + s.e * LOG10_2; }
function scaleSpan(s, factor) {
  const lw = Math.log10(s.m) + s.e * LOG10_2 + Math.log10(factor);
  const e = Math.floor(lw / LOG10_2);
  return { m: Math.pow(10, lw - e * LOG10_2), e };
}

canvas.addEventListener('pointerup', (ev) => {
  pointers.delete(ev.pointerId);
  if (pointers.size === 0) commitAfterGesture();
});
canvas.addEventListener('pointercancel', (ev) => {
  pointers.delete(ev.pointerId);
  if (pointers.size === 0) commitAfterGesture();
});

// Wheel: 07f0583c — one notch = e^(0.0035*delta) (~1.522x), snapshot + debounce.
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const dpr = canvas.width / canvas.clientWidth;
  const factor = Math.exp(Math.max(-240, Math.min(240, ev.deltaY)) * 0.0035);
  const px = ev.clientX * dpr, py = ev.clientY * dpr;
  takeSnapshot();
  // Zoom about the cursor: centre' = plane@cursor - cursorOffset@newScale.
  // Both offsets are SMALL doubles; the centre stays a deep string.
  const ps0 = pixelSize();
  state.span = scaleSpan(state.span, factor);
  const ps1 = pixelSize();
  const K = keepDigits();
  state.center = {
    re: addDec(state.center.re, (px - canvas.width / 2) * (ps0 - ps1), K),
    im: addDec(state.center.im, (canvas.height / 2 - py) * (ps0 - ps1), K),
  };
  paintSnapshot(px, py, factor);
  hud();
  if (!busy) requestPreview(); else queued = { kind: 'preview', scale: 0.36 };
  requestFinal(360);
}, { passive: false });

// Double-click: zoom in one notch at the cursor.
canvas.addEventListener('dblclick', (ev) => {
  const dpr = canvas.width / canvas.clientWidth;
  const px = ev.clientX * dpr, py = ev.clientY * dpr;
  takeSnapshot();
  const ps0 = pixelSize();
  const factor = 1 / 1.522;
  state.span = scaleSpan(state.span, factor);
  const ps1 = pixelSize();
  const K = keepDigits();
  state.center = {
    re: addDec(state.center.re, (px - canvas.width / 2) * (ps0 - ps1), K),
    im: addDec(state.center.im, (canvas.height / 2 - py) * (ps0 - ps1), K),
  };
  paintSnapshot(px, py, factor);
  requestFinal(120);
});

// ---------------------------------------------------------------- history
let historyPushTimer = 0;
function pushHistory() {
  clearTimeout(historyPushTimer);
  historyPushTimer = setTimeout(() => {
    const h = '#st=' + encodeState();
    if (location.hash !== h) history.replaceState(null, '', h);
  }, 300);
}

// ------------------------------------------------------------ URL state
function encodeState() {
  const obj = {
    v: 2,
    c: [state.center.re, state.center.im],
    w: [state.span.m, state.span.e],
    i: state.iter,
    p: state.palette,
  };
  if (state.julia) obj.j = [state.juliaRe, state.juliaIm];
  const json = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeState(h) {
  try {
    const json = decodeURIComponent(escape(atob(h.replace(/-/g, '+').replace(/_/g, '/'))));
    const o = JSON.parse(json);
    if (o.v === 2) {
      if (Array.isArray(o.c) && o.c.length === 2) state.center = { re: String(o.c[0]), im: String(o.c[1]) };
      if (Array.isArray(o.w) && o.w.length === 2) state.span = { m: Number(o.w[0]) || 3, e: Number(o.w[1]) | 0 };
      state.iter = Number(o.i) | 0;
      if (o.p) state.palette = String(o.p);
      if (Array.isArray(o.j)) { state.julia = true; state.juliaRe = String(o.j[0]); state.juliaIm = String(o.j[1]); }
      return true;
    }
    // legacy format from the previous web engine
    if (o.s && o.c && o.sp) {
      state.center = { re: String(o.c.re), im: String(o.c.im) };
      state.span = { m: Number(o.sp.m) || 3, e: Number(o.sp.e) | 0 };
      state.iter = Number(o.i) | 0;
      if (o.p) state.palette = ({ ice: 'ocean', rainbow: 'rainbow', fire: 'fire' })[o.p] || 'ocean';
      if (o.s.mode === 'j' && o.s.julia) {
        state.julia = true;
        state.juliaRe = String(o.s.julia.re);
        state.juliaIm = String(o.s.julia.im);
      }
      return true;
    }
  } catch { /* malformed link: ignore */ }
  return false;
}

// ---------------------------------------------------------------- panel UI
function syncPanel() {
  $('iter').value = state.iter > 0 ? state.iter : autoIter();
  $('iter-auto').checked = state.iter === 0;
  $('palette').value = state.palette;
  $('julia-on').checked = state.julia;
  $('julia-row').hidden = !state.julia;
}
$('iter').addEventListener('change', () => {
  state.iter = Math.min(200000, Math.max(64, parseInt($('iter').value, 10) || 0));
  if ($('iter-auto').checked) state.iter = 0;
  requestFinal();
});
$('iter-auto').addEventListener('change', () => {
  state.iter = $('iter-auto').checked ? 0 : effectiveIter();
  syncPanel();
  requestFinal();
});
$('palette').addEventListener('change', () => { state.palette = $('palette').value; requestFinal(); });
$('julia-on').addEventListener('change', () => {
  state.julia = $('julia-on').checked;
  $('julia-row').hidden = !state.julia;
  requestFinal();
});
$('julia-re').addEventListener('change', () => { state.juliaRe = $('julia-re').value.trim() || '0'; requestFinal(); });
$('julia-im').addEventListener('change', () => { state.juliaIm = $('julia-im').value.trim() || '0'; requestFinal(); });
$('btn-home').addEventListener('click', () => {
  state.center = { re: '-0.6', im: '0.0' };
  state.span = { m: 3.0, e: 0 };
  hud(); takeSnapshot(); requestPreview(); requestFinal(240);
});
$('btn-copy').addEventListener('click', async () => {
  const link = location.origin + location.pathname + '#st=' + encodeState();
  try {
    await navigator.clipboard.writeText(link);
    note('视点链接已复制');
  } catch {
    window.prompt('复制下面的视点链接', link);
  }
});
$('panel-toggle').addEventListener('click', () => {
  $('panel').classList.remove('hidden');
  $('panel-toggle').classList.remove('visible');
});
function compactPanelOnMobile() {
  if (matchMedia('(max-width: 640px)').matches) {
    $('panel').classList.add('hidden');
    $('panel-toggle').classList.add('visible');
  }
}

// ---------------------------------------------------------------- sizing
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const capPixels = 1_900_000;
  let w = Math.round(canvas.clientWidth * dpr);
  let h = Math.round(canvas.clientHeight * dpr);
  const px = w * h;
  if (px > capPixels) {
    const f = Math.sqrt(capPixels / px);
    w = Math.round(w * f); h = Math.round(h * f);
  }
  const changed = canvas.width !== w || canvas.height !== h;
  canvas.width = w; canvas.height = h;
  return changed;
}
window.addEventListener('resize', () => {
  const changed = resize();
  hud();
  if (changed) requestFinal(200);
});

// ------------------------------------------------------------------- boot
window.__shell = { state, zoomParts, pixelSize, effectiveIter, depthLog10 };
(function boot() {
  resize();
  syncPanel();
  const m = /#st=([A-Za-z0-9\-_+/=]+)/.exec(location.hash);
  if (m) decodeState(m[1]);
  syncPanel();
  hud();
  compactPanelOnMobile();
  dispatchJob('final', 1);
})();
