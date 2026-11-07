/* ------------------------------------------------------------------
 * app.js — 主控制器：视图状态 / 瓦片调度 / 交互 / 界面
 * ----------------------------------------------------------------*/

import { PRESETS } from './presets-data.js';
import { PALETTE_LIST, paletteGradientCSS } from './palettes.js';
import { setLang, t, getLang } from './i18n.js';
import { contextFor, requiredBits, spanToNumber, resolveBits, resolveBitsFromLog2, requiredBitsFromLog2 } from './bigfixed.js';
import { compile as compileMath, toLatex, EXAMPLES } from './mathlib.js';
import { probeRemote, resetRemote, remoteEnabled, disableRemote, remoteRender, remoteStatus } from './remote.js';
import { openCorePanel } from './corepanel.js';

/* ---------------- 常量 ---------------- */
const TILE = 128;
const MIN_LOG2PS = -3322;       // 最细像素尺度 2^-3322 ≈ 10^-1000
const MAX_SPAN = 8;             // 最宽视野

/* ---------------- 状态 ---------------- */
const state = {
  spec: {
    mode: 'm',
    kind: 'mandelbrot',
    power: 2,
    julia: { re: '-0.7435', im: '0.1314' },
    newtonDegree: 3,
    phoenixP: 0.5667,
    customExpr: 'z^2 + c',
    customParams: { a: 0, b: 0, k: 0 }
  },
  center: { re: '-0.6', im: '0' },
  span: { m: 1.6, e: 1 },
  maxIter: 600,
  autoIter: true,
  bits: 'auto',
  palette: 'ice',
  cycle: 8,
  cycleAuto: true,
  offset: 0,
  hd: false,
  lang: 'zh',
  theme: 'dark',
  presetId: null
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const canvas = $('fractal');
const ctx = canvas.getContext('2d', { alpha: false });
const snap = document.createElement('canvas');
const snapCtx = snap.getContext('2d');
const prevCanvas = document.createElement('canvas');
const prevCtx = prevCanvas.getContext('2d');

/* ---------------- 数值工具 ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function spanNum() {
  const e = Math.max(-1020, state.span.e);
  return state.span.m * Math.pow(2, e);
}

function psPair() {
  const w = canvas.width;
  let m = state.span.m / w, e = state.span.e;
  while (Math.abs(m) >= 2) { m /= 2; e++; }
  while (Math.abs(m) < 1 && m !== 0) { m *= 2; e--; }
  return { m, e };
}

function psLog2Now() {
  const p = psPair();
  return Math.log2(Math.abs(p.m)) + p.e;
}

/** 近似 double 像素尺度（深度超过 1e-300 时为 0，仅用于兼容路径） */
function psNow() {
  const p = psPair();
  return p.e < -1000 ? 0 : p.m * Math.pow(2, p.e);
}

function depthNow() {
  return -psLog2Now() / Math.log2(10);
}

function bitsNow() {
  return resolveBitsFromLog2(state.bits, psLog2Now());
}

function spanFromDecimal(exp) {
  const v = Math.pow(10, exp);
  const e = Math.floor(Math.log2(v));
  return { m: v / Math.pow(2, e), e };
}

function shiftCoord(baseStr, delta, bits) {
  const ctx2 = contextFor(Math.max(128, bits));
  const b = ctx2.fromString(baseStr);
  const d = ctx2.fromNumber(delta);
  return ctx2.toString(b + d, Math.ceil(bits * 0.32) + 10);
}

/** 用 mant×2^exp 标度平移坐标，避免 double 下溢 */
function shiftCoordScaled(baseStr, val, exp, bits) {
  const ctx2 = contextFor(Math.max(128, bits));
  const b = ctx2.fromString(baseStr);
  const d = ctx2.shl(ctx2.fromNumber(val), exp);
  return ctx2.toString(b + d, Math.ceil(bits * 0.32) + 10);
}

/**
 * 自动迭代次数：深层需要的迭代增长远快于浅层（每深入一个数量级，
 * 边界附近的逃逸时间大致再多一两千次），否则深放大只会得到一片"内部色"。
 */
function autoIterFor(depth) {
  const d = Math.max(0, depth);
  const base = 600 + 350 * Math.min(d, 10);
  const extra = d > 10 ? 1200 * (d - 10) : 0;
  return Math.round(clamp(base + extra, 400, 200000));
}

function fmtDepth(d) {
  if (!isFinite(d)) return '—';
  if (d < 2.2) return (Math.pow(10, d)).toFixed(2) + '×';
  return '10^' + d.toFixed(1);
}

function fmtZoomFactor(d) {
  if (d < 0) return '1×';
  if (d < 3) return Math.pow(10, d).toFixed(1) + '×';
  return '10^' + d.toFixed(1);
}

function trimNum(s, n = 14) {
  const str = String(s);
  if (str.length <= n + 2) return str;
  const m = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.exec(str);
  if (!m) return str.slice(0, n) + '…';
  return str.slice(0, n + 2) + '…';
}

/* ---------------- Worker 池 ---------------- */
const workers = [];
let wasmEnabled = null;
const mainQueue = [];
const thumbQueue = [];
let pending = 0;

function initWorkers() {
  const n = clamp((navigator.hardwareConcurrency || 4) - 1, 2, 8);
  for (let i = 0; i < n; i++) {
    const w = new Worker('js/worker.js', { type: 'module' });
    const rec = { w, busy: false, ready: false, id: i };
    w.onmessage = (e) => onWorkerMessage(rec, e.data);
    w.onerror = (e) => console.warn('worker error', e.message);
    w.postMessage({ type: 'ping' });
    workers.push(rec);
  }
}

function idleWorker() {
  return workers.find(w => w.ready && !w.busy);
}

/* ---------------- 本地渲染核心（浏览器之外） ---------------- */
const REMOTE_MAX = 24;
let remoteInflight = 0;
const remoteQueue = [];
const remoteCtl = new Set();

function remoteDispatch(job) {
  if (remoteInflight >= REMOTE_MAX) { remoteQueue.push(job); return true; }
  remoteInflight++;
  const ctl = new AbortController();
  remoteCtl.add(ctl);
  remoteRender(job.payload, ctl.signal)
    .then((msg) => {
      remoteCtl.delete(ctl);
      remoteInflight--;
      if (job.onDone) job.onDone(msg);
      pumpRemote();
    })
    .catch((err) => {
      remoteCtl.delete(ctl);
      remoteInflight--;
      // 视图切换导致的主动取消：不算失败，也不影响后续请求
      if (err && err.name === 'AbortError') { pumpRemote(); return; }
      // 服务没起来 / 中途崩溃：退回浏览器内渲染
      disableRemote();
      dispatchLocal(job);
      updateEngineLabel();
      pumpRemote();
    });
  return true;
}

function pumpRemote() {
  while (remoteInflight < REMOTE_MAX && remoteQueue.length && remoteEnabled()) {
    remoteDispatch(remoteQueue.shift());
  }
  if (!remoteEnabled()) {
    while (remoteQueue.length) dispatchLocal(remoteQueue.shift());
  }
}

function cancelRemote() {
  for (const c of remoteCtl) c.abort();
  remoteCtl.clear();
  remoteInflight = 0;
  remoteQueue.length = 0;
}

function dispatch(job) {
  if (!job.thumb && remoteEnabled()) return remoteDispatch(job);
  return dispatchLocal(job);
}

function dispatchLocal(job) {
  const rec = idleWorker();
  if (!rec) { (job.thumb ? thumbQueue : mainQueue).push(job); return false; }
  rec.busy = true;
  pending++;
  rec.w.postMessage({ type: 'render', job: job.payload });
  rec.job = job;
  return true;
}

function pump() {
  while (mainQueue.length) {
    if (!dispatch(mainQueue.shift())) return;
  }
  while (thumbQueue.length) {
    if (!dispatch(thumbQueue.shift())) return;
  }
}

function onWorkerMessage(rec, msg) {
  if (msg.type === 'ready') {
    rec.ready = true;
    if (wasmEnabled === null) {
      wasmEnabled = msg.wasm;
      updateEngineLabel();
    }
    const readyCount = workers.filter(w => w.ready).length;
    splash.set(0.16 + 0.16 * (readyCount / Math.max(1, workers.length)), 'bootKernel');
    if (readyCount === workers.length) splash.set(0.34, 'bootKernel');
    pump();
    return;
  }
  if (msg.type === 'stage') {
    if (msg.stage === 'orbit') splash.set(0.52, 'bootEnv');
    else if (msg.stage === 'env') splash.set(0.6, 'bootEnv');
    return;
  }
  if (msg.type === 'error') {
    console.warn('渲染错误', msg.message);
    rec.busy = false; pending--; pump(); return;
  }
  if (msg.type === 'tile') {
    rec.busy = false; pending--;
    const job = rec.job;
    rec.job = null;
    if (job && job.onDone) job.onDone(msg);
    pump();
  }
}

/* ---------------- 渲染调度（渐进式多趟） ---------------- */
let viewId = 0;
let tileTotal = 0;
let tileDone = 0;
let lastMeta = null;
let renderTimer = 0;
let quickTimer = 0;
let wheelTimer = 0;
let lastQuickAt = 0;
let currentPass = 0;
let frameStartAt = 0;
let frameMs = 0;

/**
 * 渐进渲染：先粗后细。每一趟用更少的像素与更少的迭代，
 * 画面在所有趟里持续变清晰，而不是每次缩放都清屏重画。
 */
const PASS_PLAN = [
  { scale: 0.13, iter: 1 },
  { scale: 0.38, iter: 1 },
  { scale: 0.68, iter: 1 },
  { scale: 1.0, iter: 1 }
];
/* 缩放过程中的快速趟：只做两趟，够看清结构即可 */
const QUICK_PLAN = [
  { scale: 0.13, iter: 1 },
  { scale: 0.38, iter: 1 }
];
/* 各趟的权重（按像素量估算的完成度占比） */
const PASS_WEIGHT = [0.02, 0.14, 0.46, 1.0];

function passProgress(idx, frac) {
  const a = idx === 0 ? 0 : PASS_WEIGHT[idx - 1];
  const b = PASS_WEIGHT[idx];
  return Math.round((a + (b - a) * frac) * 100);
}

const tileCv = document.createElement('canvas');
const tileCtx = tileCv.getContext('2d');

function cancelAll() {
  mainQueue.length = 0;
  cancelRemote();
  viewId++;
}

function iterForPlan(plan) {
  const total = state.autoIter ? autoIterNow() : state.maxIter;
  if (plan.iter >= 1) return total;
  return Math.max(48, Math.round(total * plan.iter));
}

function buildPayload(rect, W, H, iter) {
  let pm = state.span.m / W, pe = state.span.e;
  while (Math.abs(pm) >= 2) { pm /= 2; pe++; }
  while (Math.abs(pm) < 1) { pm *= 2; pe--; }
  const ps = pe < -1000 ? 0 : pm * Math.pow(2, pe);
  return {
    id: `v${viewId}-${rect.x}-${rect.y}-${W}`,
    viewId,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    width: W, height: H,
    spec: {
      ...state.spec,
      julia: { ...state.spec.julia },
      customExpr: state.spec.customExpr,
      customParams: state.spec.customParams
    },
    center: { ...state.center },
    span: { ...state.span },
    pixelSize: ps,
    psMant: pm,
    psExp: pe,
    psLog2: Math.log2(Math.abs(pm)) + pe,
    maxIter: iter != null ? iter : (state.autoIter ? autoIterNow() : state.maxIter),
    bits: state.bits,
    palette: state.palette,
    cycle: effectiveCycle(),
    offset: state.offset,
    samples: 1
  };
}

function autoIterNow() {
  const it = autoIterFor(depthNow());
  // 自定义公式走 JS 路径（高精度环境 + 级数扰动），迭代贵得多，上限收紧
  if (state.spec.mode === 'x') return Math.min(it, 6000);
  return it;
}

function effectiveCycle() {
  if (!state.cycleAuto) return Math.max(2, state.cycle);
  const it = state.autoIter ? autoIterNow() : state.maxIter;
  return clamp(Math.round(it / 180), 6, 400);
}

/** 把一趟瓦片画到画布：低分辨率趟用平滑放大，避免出现马赛克块 */
function drawTile(msg, scale) {
  if (window.__mbDebug) {
    (window.__mbTiles = window.__mbTiles || []).push({
      x: msg.x, y: msg.y, w: msg.w, h: msg.h, s: scale,
      mode: msg.meta && msg.meta.mode, gl: msg.meta && msg.meta.glitches
    });
  }
  const img = new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h);
  if (scale >= 1) {
    ctx.putImageData(img, msg.x, msg.y);
    return;
  }
  tileCv.width = msg.w;
  tileCv.height = msg.h;
  tileCtx.putImageData(img, 0, 0);
  const x0 = msg.x / scale, y0 = msg.y / scale;
  const x1 = (msg.x + msg.w) / scale, y1 = (msg.y + msg.h) / scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tileCv, 0, 0, msg.w, msg.h, x0, y0, x1 - x0, y1 - y0);
}

function runPass(vId, plan, done, planList) {
  const W = canvas.width, H = canvas.height;
  const s = plan.scale;
  const pw = Math.max(8, Math.round(W * s));
  const ph = Math.max(8, Math.round(H * s));
  const iter = iterForPlan(plan);
  const tw = Math.max(40, Math.round(TILE * Math.max(s, 0.5)));
  const tiles = [];
  for (let y = 0; y < ph; y += tw) {
    for (let x = 0; x < pw; x += tw) {
      tiles.push({ x, y, w: Math.min(tw, pw - x), h: Math.min(tw, ph - y) });
    }
  }
  tiles.sort((a, b) =>
    Math.hypot(a.x + a.w / 2 - pw / 2, a.y + a.h / 2 - ph / 2) -
    Math.hypot(b.x + b.w / 2 - pw / 2, b.y + b.h / 2 - ph / 2));
  const total = tiles.length;
  const idx = planList.indexOf(plan);
  let got = 0;
  const final = plan.scale >= 1;
  currentPass = idx;

  for (const rect of tiles) {
    const payload = buildPayload(rect, pw, ph, iter);
    dispatch({
      payload,
      onDone: (msg) => {
        if (msg.viewId !== vId) return;
        drawTile(msg, s);
        lastMeta = msg.meta;
        got++;
        tileTotal = total;
        tileDone = Math.round(passProgress(idx, got / total) / 100 * total);
        updateHud();
        if (got === total) {
          takeSnapshot();
          if (!splash.finished) {
            if (idx === 0) splash.set(0.68, 'bootFirst');
            else if (idx === 1) splash.finish();
          }
          done();
        }
      }
    });
  }
  if (!final) updateHud();
}

function renderPlan(plan) {
  cancelAll();
  frameStartAt = performance.now();
  const vId = viewId;
  tileDone = 0;
  tileTotal = 0;
  let i = 0;
  const next = () => {
    if (vId !== viewId) return;
    if (i >= plan.length) {
      frameMs = performance.now() - frameStartAt;
      updateHud(true);
      takeSnapshot();
      return;
    }
    runPass(vId, plan[i++], next, plan);
  };
  next();
  updateHud();
}

function renderNow() {
  renderPlan(PASS_PLAN);
}

function scheduleRender(delay = 90) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderNow(), delay);
}

/** 缩放过程中的快速趟：低分辨率 + 完整迭代，保证缩略图不会塌成黑块 */
function quickPreview() {
  renderPlan(QUICK_PLAN);
}

/** 滚轮缩放：即时变换上一帧 + 轻量预览，停止 300ms 后才做完整渐进渲染 */
function scheduleZoomRender() {
  const nowT = performance.now();
  // 连续滚轮时让快速趟每隔 ~110ms 自己触发一次，而不是每次滚轮都把它推迟
  if (!quickTimer) {
    const wait = Math.max(0, 110 - (nowT - lastQuickAt));
    quickTimer = setTimeout(() => {
      quickTimer = 0;
      lastQuickAt = performance.now();
      quickPreview();
    }, wait);
  }
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    if (quickTimer) { clearTimeout(quickTimer); quickTimer = 0; }
    renderNow();
  }, 360);
}

/* ---------------- 画面反馈 ---------------- */
function blitSnapshot(dx, dy, scale = 1, cx = 0, cy = 0) {
  const W = canvas.width, H = canvas.height;
  if (!snap.width) return;
  ctx.save();
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#000';
  ctx.fillRect(0, 0, W, H);
  if (scale !== 1) {
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(snap, dx, dy);
  ctx.restore();
}

function takeSnapshot() {
  snap.width = canvas.width;
  snap.height = canvas.height;
  snapCtx.clearRect(0, 0, snap.width, snap.height);
  snapCtx.drawImage(canvas, 0, 0);
}

/* ---------------- 交互 ---------------- */
let drag = null;

/* Multi-pointer tracking powers two-finger pinch-zoom and pan on touch
 * devices.  A single pointer keeps the original drag-to-pan behaviour. */
const pointers = new Map();
let pinch = null;

const panelQuery = window.matchMedia('(max-width: 900px)');
function isMobileShell() { return panelQuery.matches; }

function pointerPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height)
  };
}

function pinchMetrics() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return null;
  const [a, b] = pts;
  return {
    d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2
  };
}

function startPinch() {
  const m = pinchMetrics();
  if (!m) return;
  drag = null;
  canvas.classList.remove('dragging');
  takeSnapshot();
  pinch = { d0: m.d, cx0: m.cx, cy0: m.cy };
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;

  // A tap on the fractal dismisses the mobile console sheet.
  if (isMobileShell() && document.body.classList.contains('panel-open')) {
    setPanelOpen(false);
  }

  canvas.classList.add('dragging');
  takeSnapshot();
  drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const m = pinchMetrics();
    if (!m) return;
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    const scale = clamp(pinch.d0 / m.d, 0.2, 5);
    const ax = (m.cx - r.left) * sx;
    const ay = (m.cy - r.top) * sy;
    blitSnapshot((m.cx - pinch.cx0) * sx, (m.cy - pinch.cy0) * sy, scale, ax, ay);
    return;
  }

  if (!drag) return;
  const dx = (e.clientX - drag.sx) * (canvas.width / canvas.getBoundingClientRect().width);
  const dy = (e.clientY - drag.sy) * (canvas.height / canvas.getBoundingClientRect().height);
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 1) drag.moved = true;
  blitSnapshot(dx, dy);
});

canvas.addEventListener('pointerup', (e) => {
  const hadPinch = !!pinch;
  const mEnd = hadPinch ? pinchMetrics() : null;
  pointers.delete(e.pointerId);

  if (hadPinch) {
    if (pointers.size <= 1) {
      finishPinch(mEnd);
      if (pointers.size === 1) {
        // One finger is still down: continue as a fresh pan gesture.
        const p = [...pointers.values()][0];
        takeSnapshot();
        drag = { x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false };
      }
    }
    return;
  }

  if (!drag) return;
  canvas.classList.remove('dragging');
  const r = canvas.getBoundingClientRect();
  const dxCss = e.clientX - drag.sx;
  const dyCss = e.clientY - drag.sy;
  const dx = dxCss * (canvas.width / r.width);
  const dy = dyCss * (canvas.height / r.height);
  const wasDrag = drag.moved;
  drag = null;
  if (!wasDrag) return;
  commitPan(dx, dy);
});

canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pinch) { pinch = null; return; }
  drag = null;
  canvas.classList.remove('dragging');
});

/** Finish a pinch: apply the accumulated pan + zoom in one render pass. */
function finishPinch(m) {
  const p0 = pinch;
  pinch = null;
  if (!p0 || !m) return;
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width;
  const sy = canvas.height / r.height;
  const factor = clamp(p0.d0 / Math.max(1, m.d), 0.25, 4);
  const dx = (m.cx - p0.cx0) * sx;
  const dy = (m.cy - p0.cy0) * sy;

  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    const p = psPair();
    const bits = bitsNow() + 40;
    state.center = {
      re: shiftCoordScaled(state.center.re, -dx * p.m, p.e, bits),
      im: shiftCoordScaled(state.center.im, dy * p.m, p.e, bits)
    };
  }
  const ax = (m.cx - r.left) * sx;
  const ay = (m.cy - r.top) * sy;
  zoomAt(ax, ay, factor, false);
}

function commitPan(dx, dy) {
  const p = psPair();
  const bits = bitsNow() + 40;
  state.center = {
    re: shiftCoordScaled(state.center.re, -dx * p.m, p.e, bits),
    im: shiftCoordScaled(state.center.im, dy * p.m, p.e, bits)
  };
  scheduleZoomRender();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { x, y } = pointerPos(e);
  const W = canvas.width, H = canvas.height;
  const factor = Math.exp(clamp(e.deltaY, -240, 240) * 0.0035);
  zoomAt(x, y, factor, true);
}, { passive: false });

canvas.addEventListener('dblclick', (e) => {
  const { x, y } = pointerPos(e);
  zoomAt(x, y, e.shiftKey ? 2.4 : 1 / 2.4, true);
});

function zoomAt(px, py, factor, instant) {
  const W = canvas.width, H = canvas.height;
  const p = psPair();
  const log2New = psLog2Now() + Math.log2(factor);
  if (log2New < MIN_LOG2PS) return;
  if (spanNum() * factor > MAX_SPAN) return;

  const cx = (px - W / 2), cy = (py - H / 2);
  const bits = Math.max(160, requiredBitsFromLog2(log2New) + 40);
  state.center = {
    re: shiftCoordScaled(state.center.re, cx * p.m * (1 - factor), p.e, bits),
    im: shiftCoordScaled(state.center.im, -cy * p.m * (1 - factor), p.e, bits)
  };
  state.span = { m: state.span.m * factor, e: state.span.e };
  normalizeSpan();

  if (instant) {
    // 以光标为锚点缩放上一帧，获得即时手感，随后渐进精修
    if (!snap.width) takeSnapshot();
    blitSnapshot(0, 0, 1 / factor, px, py);
    scheduleZoomRender();
  } else {
    renderNow();
  }
  if (state.autoIter) syncIterUi();
  updateHud();
}

function normalizeSpan() {
  let { m, e } = state.span;
  while (Math.abs(m) >= 2) { m /= 2; e++; }
  while (Math.abs(m) < 1) { m *= 2; e--; }
  state.span = { m, e };
}

/* ---------------- HUD ---------------- */
function updateHud(done = false) {
  const d = depthNow();
  const ps = psNow();
  const bits = bitsNow();
  $('hud-depth').textContent = `${t('zoom')} ${fmtZoomFactor(d)}`;
  const cre = trimNum(state.center.re, 16);
  const cim = state.center.im;
  $('hud-center').textContent = `${cre} ${cim.startsWith('-') ? '−' : '+'} ${trimNum(cim.replace('-', ''), 16)} i`;
  $('chip-precision').textContent = `${bits} bit`;

  const engineName = (e) => e === 'remote' ? 'CORE' : e === 'wasm' ? 'WASM' : e === 'hp' ? 'HP' : e === 'core' ? 'CORE' : 'JS';
  const modeLabel = lastMeta
    ? engineName(lastMeta.engine) + ' · ' + lastMeta.mode
    : (remoteEnabled() ? 'CORE' : (wasmEnabled === null ? '…' : wasmEnabled ? 'WASM' : 'JS'));
  const pct = tileTotal ? Math.round((tileDone / tileTotal) * 100) : 0;
  const ms = done && frameMs > 0 ? frameMs.toFixed(0) + ' ms'
    : (lastMeta ? lastMeta.ms.toFixed(0) + ' ms' : '');
  let limitHint = '';
  if (state.spec.mode === 'x' && d > 13) {
    limitHint = lastMeta && lastMeta.exact === false ? ` · ${t('approxHint')}` : '';
  }
  $('hud-engine').textContent = `${modeLabel} · ${bits} bit` + (lastMeta ? ` · ${t('refLen')} ${lastMeta.refLen}` : '') + limitHint;
  $('hud-progress').textContent = done || pct >= 100
    ? `${t('statusDone')} · ${ms}`
    : `${t('statusRendering')} ${pct}%` + (ms ? ` · ${ms}` : '');

  $('kv-center').textContent = `${trimNum(state.center.re, 22)} , ${trimNum(state.center.im, 22)}`;
  $('kv-zoom').textContent = fmtZoomFactor(d);
}

function updateEngineLabel() {
  updateHud();
}

/* ---------------- 控件 ---------------- */
function syncIterUi() {
  const it = state.autoIter ? autoIterNow() : state.maxIter;
  $('rng-iter').value = clamp(it, 100, 200000);
  $('in-iter').value = it;
}

function fillSelects() {
  const kinds = [
    ['mandelbrot', 'Mandelbrot'], ['multibrot', 'Multibrot'],
    ['burningship', 'Burning Ship'], ['celtic', 'Celtic'],
    ['perpendicular', 'Perpendicular'], ['tricorn', 'Tricorn'],
    ['phoenix', 'Phoenix']
  ];
  $('sel-kind').innerHTML = kinds.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
  $('sel-palette').innerHTML = PALETTE_LIST
    .map(p => `<option value="${p.id}">${getLang() === 'en' ? p.en : p.zh}</option>`).join('');
}

function syncPaletteStrip() {
  $('palette-strip').style.background = paletteGradientCSS(state.palette);
}

function syncModeUi() {
  const m = state.spec.mode;
  document.querySelectorAll('#seg-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('grp-julia').hidden = m !== 'j';
  $('row-kind').hidden = m === 'n' || m === 'x';
  $('row-power').hidden = !(state.spec.kind === 'multibrot');
  $('row-degree').hidden = m !== 'n';
  $('row-phoenix').hidden = state.spec.kind !== 'phoenix';
  $('sel-kind').value = state.spec.kind;
  $('rng-power').value = state.spec.power;
  $('val-power').textContent = state.spec.power;
  $('rng-degree').value = state.spec.newtonDegree;
  $('val-degree').textContent = state.spec.newtonDegree;
}

function applyMode(mode) {
  state.spec.mode = mode;
  if (mode === 'n') {
    state.spec.newtonDegree = state.spec.newtonDegree || 3;
    state.center = { re: '0', im: '0' };
    state.span = { m: 1.75, e: 1 };   // 3.5 单位宽，正好容纳三个根
    state.maxIter = 90; state.autoIter = false; $('chk-autoiter').checked = false;
    state.cycle = 9; state.cycleAuto = false;
    $('rng-cycle').value = 9; $('val-cycle').textContent = 9;
  } else if (mode === 'j') {
    state.center = { re: '0', im: '0' };
    state.span = { m: 1.6, e: 1 };
    state.maxIter = 800; state.autoIter = false; $('chk-autoiter').checked = false;
  } else if (mode === 'm') {
    state.center = { re: '-0.6', im: '0' };
    state.span = { m: 1.6, e: 1 };
    state.maxIter = 600; state.autoIter = true; $('chk-autoiter').checked = true;
  } else {
    state.center = { re: '-0.5', im: '0' };
    state.span = { m: 1.6, e: 1 };
  }
  syncModeUi(); syncIterUi(); renderNow();
}

/* ---------------- 预设窗口 ---------------- */
let modalKind = null;

function openModal(kind, title, sub, bodyHtml, footHtml, cls = '') {
  modalKind = kind;
  const root = $('modal-root');
  root.hidden = false;
  const modal = $('modal');
  modal.className = 'modal glass ' + cls;
  $('modal-title').textContent = title;
  $('modal-sub').textContent = sub || '';
  $('modal-sub').hidden = !sub;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-foot').innerHTML = footHtml || '';
  root.querySelectorAll('[data-close]').forEach(el => el.onclick = closeModal);
}

function closeModal() {
  $('modal-root').hidden = true;
  modalKind = null;
  thumbQueue.length = 0;
}

document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));

function openPresets() {
  const cats = [
    ['all', t('catAll')], ['mandelbrot', t('catM')], ['julia', t('catJ')],
    ['newton', t('catN')], ['exotic', t('catX')], ['custom', t('catC')]
  ];
  const body = `
    <div class="preset-toolbar">
      <input class="ctl" id="preset-search" placeholder="${t('search')}" />
      <div class="cats" id="preset-cats">
        ${cats.map(([k, n]) => `<button data-cat="${k}" class="${k === 'all' ? 'on' : ''}">${n}</button>`).join('')}
      </div>
      <span style="margin-left:auto;color:var(--text-3);font-size:11px" id="preset-count"></span>
    </div>
    <div class="preset-grid" id="preset-grid"></div>`;
  openModal('presets', t('presetTitle'), t('presetSub'), body);

  let cat = 'all', q = '';
  const grid = $('preset-grid');
  const renderList = () => {
    const list = PRESETS.filter(p =>
      (cat === 'all' || p.cat === cat) &&
      (!q || (p.nameZh + p.nameEn + p.cx + p.cy).toLowerCase().includes(q)));
    $('preset-count').textContent = list.length + ' / ' + PRESETS.length;
    grid.innerHTML = list.map(p => `
      <button class="pcard" data-id="${p.id}">
        <canvas class="thumb" data-id="${p.id}" width="158" height="99"></canvas>
        <span class="meta">
          <span class="nm">${getLang() === 'en' ? p.nameEn : p.nameZh}</span>
          <span class="tag">${p.mode.toUpperCase()} · ${p.palette}</span>
        </span>
      </button>`).join('');
    grid.querySelectorAll('.pcard').forEach(el => {
      el.onclick = () => {
        const p = PRESETS.find(x => x.id === el.dataset.id);
        applyPreset(p); closeModal();
      };
    });
    observeThumbs();
  };

  $('preset-search').oninput = (e) => { q = e.target.value.trim().toLowerCase(); renderList(); };
  $('preset-cats').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      cat = b.dataset.cat;
      $('preset-cats').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderList();
    };
  });
  renderList();
}

let thumbObserver = null;
function observeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const c = en.target;
      thumbObserver.unobserve(c);
      enqueueThumb(c);
    }
  }, { root: $('modal-body'), rootMargin: '120px' });
  document.querySelectorAll('.thumb').forEach(c => thumbObserver.observe(c));
}

function enqueueThumb(cv) {
  const p = PRESETS.find(x => x.id === cv.dataset.id);
  if (!p) return;
  const W = 158, H = 99;
  const span = spanFromDecimal(p.spanExp);
  const ps = (span.m * Math.pow(2, span.e)) / W;
  const payload = {
    id: 'th-' + p.id, viewId: 'thumb',
    x: 0, y: 0, w: W, h: H, width: W, height: H,
    spec: {
      mode: p.mode, kind: p.kind, power: p.power, julia: p.julia,
      newtonDegree: p.newtonDegree, customExpr: p.customExpr,
      customParams: p.customParams
    },
    center: { re: p.cx, im: p.cy }, span,
    pixelSize: ps, maxIter: Math.min(p.maxIter, 1200), bits: 'auto',
    palette: p.palette, cycle: p.cycle || 8, offset: p.offset || 0, samples: 1
  };
  if (modalKind !== 'presets') return;
  dispatch({
    payload, thumb: true,
    onDone: (msg) => {
      if (msg.viewId !== 'thumb') return;
      const g = cv.getContext('2d');
      g.putImageData(new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h), 0, 0);
    }
  });
}

function applyPreset(p) {
  state.spec.mode = p.mode;
  state.spec.kind = p.kind || 'mandelbrot';
  state.spec.power = p.power || 2;
  state.spec.newtonDegree = p.newtonDegree || 3;
  if (p.julia) state.spec.julia = { ...p.julia };
  if (p.customExpr) {
    state.spec.customExpr = p.customExpr;
    state.spec.customParams = { ...(p.customParams || { a: 0, b: 0, k: 0 }) };
  }
  state.center = { re: p.cx, im: p.cy };
  state.span = spanFromDecimal(p.spanExp);
  state.maxIter = p.maxIter;
  state.autoIter = false;
  state.palette = p.palette;
  state.cycle = p.cycle || 8; state.cycleAuto = false;
  state.offset = p.offset || 0;
  state.presetId = p.id;
  $('chk-autoiter').checked = false;
  if (p.mode === 'x') { state.autoIter = false; state.maxIter = Math.max(400, p.maxIter); }
  $('sel-palette').value = state.palette;
  $('rng-cycle').value = state.cycle; $('val-cycle').textContent = state.cycle;
  $('rng-offset').value = state.offset; $('val-offset').textContent = state.offset.toFixed(2);
  syncModeUi(); syncPaletteStrip(); syncIterUi(); renderNow();
}

/* ---------------- 公式窗口 ---------------- */
let formulaWorkerJob = null;

function openFormula() {
  const body = `
    <div class="fx-wrap">
      <div class="fx-list" id="fx-list"></div>
      <div class="fx-preview">
        <canvas id="formula-preview" width="720" height="450"></canvas>
        <div class="fx-meta" id="fx-meta"></div>
      </div>
    </div>`;
  const foot = `
    <button class="btn ghost" id="f-copy">LaTeX</button>
    <button class="btn" id="f-save">${t('saveFormula')}</button>
    <button class="btn primary" id="f-apply">${t('apply')}</button>`;
  openModal('formula', t('formulaTitle'), t('formulaSub'), body, foot, 'wide');

  const state2 = {
    expr: state.spec.customExpr || 'z^2 + c',
    vals: { ...state.spec.customParams },
    params: [],
    latex: '',
    ok: false
  };

  const list = $('fx-list');
  const input = document.createElement('textarea');
  input.className = 'fx-expr';
  input.spellcheck = false;
  input.value = state2.expr;

  function buildRows() {
    const texMain = state2.ok ? latexToHtml(state2.latex) : '<span class="fx-err">表达式有误</span>';
    let html = `
      <div class="fx-row fx-main">
        <span class="fx-idx">1</span>
        <div class="fx-cell">
          <div class="fx-tex big">z \u2192 ${texMain}</div>
        </div>
      </div>`;
    state2.params.forEach((name, i) => {
      const v = state2.vals[name] ?? 0;
      html += `
      <div class="fx-row fx-param">
        <span class="fx-idx">${i + 2}</span>
        <div class="fx-cell">
          <div class="fx-tex"><i>${name}</i> = <span class="fx-val">${(v).toFixed(2)}</span></div>
          <div class="fx-slider">
            <span>-3</span>
            <input type="range" data-p="${name}" min="-3" max="3" step="0.01" value="${v}"/>
            <span>3</span>
          </div>
        </div>
      </div>`;
    });
    list.innerHTML = `
      <div class="fx-row fx-input">
        <span class="fx-idx">ƒ</span>
        <div class="fx-cell"><textarea class="fx-expr" id="fx-expr" spellcheck="false">${state2.expr.replace(/</g, '&lt;')}</textarea></div>
      </div>
      <div class="fx-hint">${t('fxHint')}</div>
      ${html}
      <div class="fx-examples" id="fx-examples">
        ${EXAMPLES.map(e => `<button data-expr="${e.expr.replace(/"/g, '&quot;')}">${getLang() === 'en' ? e.en : e.zh}</button>`).join('')}
      </div>`;
    const ta = $('fx-expr');
    ta.addEventListener('input', () => {
      state2.expr = ta.value;
      clearTimeout(ta._tm);
      ta._tm = setTimeout(validate, 220);
    });
    list.querySelectorAll('.fx-slider input').forEach(sl => {
      sl.addEventListener('input', () => {
        const name = sl.dataset.p;
        state2.vals[name] = parseFloat(sl.value);
        const lab = sl.closest('.fx-cell').querySelector('.fx-val');
        if (lab) lab.textContent = state2.vals[name].toFixed(2);
        clearTimeout(sl._tm);
        sl._tm = setTimeout(() => { renderFormulaPreview(state2.expr, state2.vals); }, 150);
      });
    });
    $('fx-examples').querySelectorAll('button').forEach(b => {
      b.onclick = () => { state2.expr = b.dataset.expr; buildRows(); validate(); };
    });
  }

  function validate() {
    try {
      const r = compileMath(state2.expr);
      state2.ok = true;
      state2.latex = r.latex;
      const ps = (r.params || []).filter(n => !['a', 'b', 'k', 'm'].includes(n) || true);
      // 合并：保持已有值，新增默认为 0
      const uniq = [...new Set(ps)];
      state2.params = uniq;
      uniq.forEach(n => { if (!(n in state2.vals)) state2.vals[n] = 0; });
      state2.fn = r.fn;
      buildRows();
      $('fx-meta').className = 'fx-meta ok';
      $('fx-meta').textContent = t('compileOk') + ' · ' + uniq.length + ' ' + t('params');
      renderFormulaPreview(state2.expr, state2.vals);
    } catch (err) {
      state2.ok = false;
      buildRows();
      $('fx-meta').className = 'fx-meta err';
      $('fx-meta').textContent = t('compileErr') + '：' + err.message;
    }
  }

  $('f-apply').onclick = () => {
    if (!state2.ok) return;
    state.spec.customExpr = state2.expr;
    state.spec.customParams = { ...state2.vals };
    state.spec.mode = 'x';
    state.center = { re: '-0.5', im: '0' };
    state.span = { m: 1.6, e: 1 };
    state.maxIter = 600;
    state.autoIter = false;
    $('chk-autoiter').checked = false;
    syncModeUi(); syncIterUi(); renderNow();
    closeModal();
  };
  $('f-save').onclick = () => {
    if (!state2.ok) return;
    const l = loadFormulas();
    l.push({ name: state2.expr.split('\n')[0].slice(0, 40), expr: state2.expr, params: { ...state2.vals }, at: Date.now() });
    saveFormulas(l);
    toast(t('saved'));
  };
  $('f-copy').onclick = () => {
    navigator.clipboard?.writeText(state2.latex).then(() => toast('LaTeX ✓')).catch(() => toast('LaTeX'));
  };

  validate();
}

function compileFormulaLocal(src) {
  const r = compileMath(src);
  return r.latex;
}

function renderFormulaPreview(src, vals) {
  const cv = $('formula-preview');
  if (!cv) return;
  const W = cv.width, H = cv.height;
  const span = { m: 1.6, e: 1 };
  const ps = (span.m * Math.pow(2, span.e)) / W;
  const payload = {
    id: 'fp', viewId: 'formula',
    x: 0, y: 0, w: W, h: H, width: W, height: H,
    spec: {
      mode: 'x', kind: 'mandelbrot', power: 2,
      customExpr: src, customParams: { ...(vals || state.spec.customParams) },
      julia: { ...state.spec.julia }
    },
    center: { re: '-0.5', im: '0' }, span,
    pixelSize: ps, maxIter: 500, bits: 64,
    palette: state.palette, cycle: state.cycle, offset: state.offset, samples: 1
  };
  dispatch({
    payload, thumb: true,
    onDone: (msg) => {
      if (msg.viewId !== 'formula') return;
      const c2 = $('formula-preview');
      if (!c2) return;
      c2.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h), 0, 0);
    }
  });
}

/* ---------------- 自定义预设 ---------------- */
function loadCustom() {
  try { return JSON.parse(localStorage.getItem('mb.custom') || '[]'); } catch { return []; }
}
function saveCustom(list) { localStorage.setItem('mb.custom', JSON.stringify(list)); }
function loadFormulas() {
  try { return JSON.parse(localStorage.getItem('mb.formulas') || '[]'); } catch { return []; }
}
function saveFormulas(list) { localStorage.setItem('mb.formulas', JSON.stringify(list)); }

function openCustom() {
  const list = loadCustom();
  const body = `
    <div class="save-row">
      <input class="ctl" id="cp-name" placeholder="${t('namePlaceholder')}" />
      <button class="btn primary" id="cp-save">${t('saveCurrent')}</button>
      <button class="btn" id="cp-export">${t('exportJson')}</button>
      <button class="btn" id="cp-import">${t('importJson')}</button>
      <input type="file" id="cp-file" accept="application/json" hidden />
    </div>
    <div class="saved-list" id="cp-list"></div>`;
  openModal('custom', t('customTitle'), t('customSub'), body, '', 'mid');

  const renderList = () => {
    const l = loadCustom();
    const box = $('cp-list');
    if (!l.length) { box.innerHTML = `<div style="color:var(--text-3);font-size:12px">${t('empty')}</div>`; return; }
    box.innerHTML = l.map((it, i) => `
      <div class="saved-item">
        <div class="info">
          <div class="nm">${it.name}</div>
          <div class="sub">${it.state.spec.mode.toUpperCase()} · ${it.state.palette} · ${it.state.center.re}, ${it.state.center.im}</div>
        </div>
        <button class="btn" data-apply="${i}">${t('applyPreset')}</button>
        <button class="btn ghost" data-del="${i}">${t('delete')}</button>
      </div>`).join('');
    box.querySelectorAll('[data-apply]').forEach(b => {
      b.onclick = () => {
        const it = loadCustom()[+b.dataset.apply];
        if (!it) return;
        Object.assign(state, JSON.parse(JSON.stringify(it.state)));
        $('chk-autoiter').checked = state.autoIter;
        $('sel-palette').value = state.palette;
        syncModeUi(); syncPaletteStrip(); syncIterUi(); renderNow(); closeModal();
      };
    });
    box.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = () => {
        const l2 = loadCustom();
        l2.splice(+b.dataset.del, 1);
        saveCustom(l2); renderList();
      };
    });
  };

  $('cp-save').onclick = () => {
    const name = $('cp-name').value.trim() || `${t('custom')} ${new Date().toLocaleTimeString()}`;
    const l = loadCustom();
    l.unshift({ name, at: Date.now(), state: JSON.parse(JSON.stringify({
      spec: state.spec, center: state.center, span: state.span,
      maxIter: state.maxIter, autoIter: state.autoIter, bits: state.bits,
      palette: state.palette, cycle: state.cycle, offset: state.offset
    })) });
    saveCustom(l); $('cp-name').value = ''; renderList(); toast(t('saved'));
  };
  $('cp-export').onclick = () => {
    const blob = new Blob([JSON.stringify(loadCustom(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mandelbrot-presets.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('cp-import').onclick = () => $('cp-file').click();
  $('cp-file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const arr = JSON.parse(r.result);
        if (!Array.isArray(arr)) throw new Error('bad');
        saveCustom([...arr, ...loadCustom()]);
        renderList(); toast(t('saved'));
      } catch { toast(t('loadFail')); }
    };
    r.readAsText(f);
  };

  renderList();
}

/* ---------------- 关于 ---------------- */
function openAbout() {
  const body = `
    <div class="about-body">${t('aboutBody')}</div>
    <div class="about-stats">
      <div><b>512</b><span>${t('statPresets')}</span></div>
      <div><b>7</b><span>${t('statSets')}</span></div>
      <div><b>10⁻³⁰⁰</b><span>${t('statDepth')}</span></div>
      <div><b>${wasmEnabled ? 'WASM' : 'JS'}</b><span>${t('engine')}</span></div>
    </div>
    <div style="margin-top:18px;font-size:11px;letter-spacing:.14em;color:var(--text-3);text-transform:uppercase">${t('shortcuts')}</div>
    <div class="shortcut-grid">
      <kbd>${t('scPan')}</kbd><span>${t('scPan')}</span>
      <kbd>Wheel</kbd><span>${t('scZoom')}</span>
      <kbd>2×</kbd><span>${t('scDbl')}</span>
      <kbd>R</kbd><span>${t('scReset')}</span>
      <kbd>P</kbd><span>${t('scPanel')}</span>
      <kbd>F</kbd><span>${t('scFull')}</span>
      <kbd>S</kbd><span>${t('scShot')}</span>
      <kbd>+ / −</kbd><span>${t('scIter')}</span>
    </div>
    <div style="margin-top:18px;font-size:11px;letter-spacing:.14em;color:var(--text-3);text-transform:uppercase">${t('aboutTech')}</div>
    <div class="legend" style="margin-top:6px">${t('aboutTechBody')}</div>`;
  openModal('about', t('aboutTitle'), '', body, '', 'narrow');
}


/* ---------------- LaTeX 简易排版 ---------------- */
const LATEX_SYMBOL = {
  pi: 'π', tau: 'τ', phi: 'φ', infty: '∞', cdot: '·', times: '×',
  ln: 'ln', sin: 'sin', cos: 'cos', tan: 'tan', sinh: 'sinh', cosh: 'cosh',
  tanh: 'tanh', arg: 'arg', sum: '∑', prod: '∏'
};

function latexToHtml(tex) {
  const s = String(tex || '');
  let i = 0;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function skip() { while (i < s.length && s[i] === ' ') i++; }

  function group() {
    skip();
    if (s[i] === '{') {
      i++;
      return seq();
    }
    if (s[i] === '\\') {
      const save = i;
      i++;
      let name = '';
      while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
      if (name) return `<span class="op">${esc(LATEX_SYMBOL[name] || name)}</span>`;
      i = save;
      return esc(s[i++] || '');
    }
    const ch = s[i++] || '';
    if (/[a-zA-Z]/.test(ch)) return `<i>${esc(ch)}</i>`;
    return esc(ch);
  }

  function seq() {
    let out = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === '}') { i++; break; }
      if (ch === ' ') { i++; continue; }
      if (ch === '\\') {
        i++;
        let name = '';
        while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
        if (!name) { out += esc(s[i++] || ''); continue; }
        switch (name) {
          case 'frac': {
            const n = group(), d = group();
            out += `<span class="frac"><span class="num">${n}</span><span class="den">${d}</span></span>`;
            break;
          }
          case 'sqrt': {
            const a = group();
            out += `<span class="sqrt"><span class="radical">√</span><span class="radicand">${a}</span></span>`;
            break;
          }
          case 'left': case 'right': {
            const d = s[i++] || '.';
            if (d !== '.') out += esc(d);
            break;
          }
          case 'overline': out += `<span class="ovl">${group()}</span>`; break;
          case 'operatorname': out += `<span class="op">${group()}</span>`; break;
          case 'sum': case 'prod': {
            const sym = name === 'sum' ? '∑' : '∏';
            let sub = '', sup = '';
            for (;;) {
              skip();
              if (s[i] === '_') { i++; sub = group(); }
              else if (s[i] === '^') { i++; sup = group(); }
              else break;
            }
            out += `<span class="bigop"><span class="op-sym">${sym}</span>`
              + `<span class="op-lim"><span>${sup}</span><span>${sub}</span></span></span>`;
            break;
          }
          case 'begin': {
            const env = group();
            if (env.indexOf('cases') >= 0) {
              const endIdx = s.indexOf('\\end', i);
              const body = s.slice(i, endIdx < 0 ? s.length : endIdx);
              i = endIdx < 0 ? s.length : endIdx;
              const rows = body.split('&').map(x => x.trim()).filter(Boolean);
              out += `<span class="cases">{</span><span class="cases-body">`
                + rows.map(r => `<span>${esc(r)}</span>`).join('') + '</span>';
            }
            break;
          }
          case 'end': group(); break;
          case 'lfloor': out += '⌊'; break;
          case 'rfloor': out += '⌋'; break;
          case 'lceil': out += '⌈'; break;
          case 'rceil': out += '⌉'; break;
          default: out += `<span class="op">${esc(LATEX_SYMBOL[name] || name)}</span>`;
        }
        continue;
      }
      if (ch === '^' || ch === '_') {
        i++;
        const g = group();
        out += ch === '^' ? `<sup>${g}</sup>` : `<sub>${g}</sub>`;
        continue;
      }
      if (ch === '{' || ch === '}') { i++; continue; }
      if (/[a-zA-Z]/.test(ch)) {
        let w = ch; i++;
        while (i < s.length && /[a-zA-Z]/.test(s[i])) w += s[i++];
        out += `<i>${esc(w)}</i>`;
        continue;
      }
      out += esc(ch);
      i++;
    }
    return out;
  }

  try { return seq() || '&nbsp;'; } catch { return '&nbsp;'; }
}

/* ---------------- 提示 ---------------- */
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------------- 顶栏/面板事件 ---------------- */
function bindUi() {
  // 集菜单
  const setsBtn = $('btn-sets'), setsMenu = $('menu-sets');
  setsBtn.onclick = (e) => {
    e.stopPropagation();
    closeMenus(setsMenu);
    setsMenu.hidden = !setsMenu.hidden;
    setsBtn.classList.toggle('open', !setsMenu.hidden);
  };
  setsMenu.querySelectorAll('button').forEach(b => {
    b.onclick = () => { applyMode(b.dataset.mode); setsMenu.hidden = true; setsBtn.classList.remove('open'); };
  });

  const setBtn = $('btn-settings'), setMenu = $('menu-settings');
  setBtn.onclick = (e) => {
    e.stopPropagation();
    closeMenus(setMenu);
    setMenu.hidden = !setMenu.hidden;
    setBtn.classList.toggle('open', !setMenu.hidden);
  };

  // 面板内部的点击不关闭下拉
  ['menu-sets', 'menu-settings'].forEach(id => {
    $(id).addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('click', () => { closeMenus(); });

  $('btn-presets').onclick = openPresets;
  $('btn-formula').onclick = openFormula;
  $('btn-custom').onclick = openCustom;
  $('btn-about').onclick = () => { closeMenus(); openAbout(); };
  $('btn-fullscreen').onclick = () => {
    closeMenus();
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  // 语言 / 主题
  $('seg-lang').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.lang = b.dataset.lang;
      setLang(state.lang);
      $('seg-lang').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      applyI18n(); fillSelects(); syncPaletteStrip();
    };
  });
  $('seg-theme').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.theme = b.dataset.theme;
      document.documentElement.dataset.theme = state.theme;
      $('seg-theme').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    };
  });

  $('chk-hd').onchange = (e) => { state.hd = e.target.checked; resizeCanvas(); };

  // 分段控件
  $('seg-mode').querySelectorAll('button').forEach(b => {
    b.onclick = () => applyMode(b.dataset.mode);
  });

  $('sel-kind').onchange = (e) => {
    state.spec.kind = e.target.value;
    syncModeUi();
    renderNow();
  };
  $('rng-power').oninput = (e) => {
    state.spec.power = +e.target.value;
    $('val-power').textContent = state.spec.power;
  };
  $('rng-power').onchange = () => renderNow();
  $('rng-degree').oninput = (e) => {
    state.spec.newtonDegree = +e.target.value;
    $('val-degree').textContent = state.spec.newtonDegree;
  };
  $('rng-degree').onchange = () => renderNow();
  $('rng-phoenix').oninput = (e) => {
    state.spec.phoenixP = +e.target.value;
    $('val-phoenix').textContent = state.spec.phoenixP.toFixed(2);
  };
  $('rng-phoenix').onchange = () => renderNow();

  $('in-jr').oninput = (e) => { state.spec.julia.re = e.target.value.trim() || '0'; };
  $('in-ji').oninput = (e) => { state.spec.julia.im = e.target.value.trim() || '0'; };
  $('in-jr').onchange = () => renderNow();
  $('in-ji').onchange = () => renderNow();

  $('chk-autoiter').onchange = (e) => {
    state.autoIter = e.target.checked;
    if (state.autoIter) syncIterUi();
    renderNow();
  };
  $('rng-iter').oninput = (e) => {
    state.autoIter = false;
    $('chk-autoiter').checked = false;
    state.maxIter = +e.target.value;
    $('in-iter').value = state.maxIter;
  };
  $('rng-iter').onchange = () => renderNow();
  $('in-iter').onchange = (e) => {
    state.autoIter = false;
    $('chk-autoiter').checked = false;
    state.maxIter = clamp(+e.target.value || 600, 100, 200000);
    $('rng-iter').value = state.maxIter;
    renderNow();
  };

  $('sel-bits').onchange = (e) => { state.bits = e.target.value; renderNow(); };
  $('sel-palette').onchange = (e) => {
    state.palette = e.target.value;
    syncPaletteStrip();
    renderNow();
  };
  $('rng-cycle').oninput = (e) => {
    state.cycleAuto = false;
    state.cycle = +e.target.value;
    $('val-cycle').textContent = state.cycle;
  };
  $('rng-cycle').onchange = () => renderNow();
  $('rng-offset').oninput = (e) => {
    state.offset = +e.target.value;
    $('val-offset').textContent = state.offset.toFixed(2);
  };
  $('rng-offset').onchange = () => renderNow();

  $('btn-reset').onclick = () => applyMode(state.spec.mode);
  $('btn-fit').onclick = () => {
    state.span = state.spec.mode === 'j' ? { m: 1.6, e: 1 } : { m: 1.6, e: 1 };
    state.center = state.spec.mode === 'm' ? { re: '-0.6', im: '0' } : { re: '0', im: '0' };
    if (state.autoIter) syncIterUi();
    renderNow();
  };
  $('btn-link').onclick = () => {
    const s = encodeState();
    location.hash = s;
    navigator.clipboard?.writeText(location.href).then(() => toast(t('copied'))).catch(() => toast(t('copied')));
  };
  $('btn-png').onclick = () => exportPng();

  // 面板拖动（仅桌面；移动端由底部抽屉接管）
  const panel = $('panel');
  const head = $('panel-drag');
  let pd = null;
  head.addEventListener('pointerdown', (e) => {
    if (isMobileShell()) return;
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    pd = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!pd) return;
    panel.style.right = 'auto';
    panel.style.left = clamp(e.clientX - pd.dx, 8, innerWidth - 80) + 'px';
    panel.style.top = clamp(e.clientY - pd.dy, 58, innerHeight - 80) + 'px';
  });
  head.addEventListener('pointerup', () => { pd = null; });

  // 最小化 → 收进顶栏的控制台按钮
  $('btn-panel-collapse').onclick = () => setPanelOpen(false);
  $('btn-console').onclick = () => togglePanel();
  $('btn-panel-reset').onclick = () => {
    panel.style.left = '';
    panel.style.right = '';
    panel.style.top = '';
  };
  $('btn-core').onclick = () => {
    closeMenus();
    openCorePanel({
      t,
      openModal,
      toast,
      reprobe: async () => {
        resetRemote();
        const ok = await probeRemote();
        updateEngineLabel();
        return ok;
      }
    });
  };

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') { closeModal(); closeMenus(); return; }
    if (e.key === 'r' || e.key === 'R') applyMode(state.spec.mode);
    if (e.key === 'p' || e.key === 'P') togglePanel();
    if (e.key === 'f' || e.key === 'F') document.documentElement.requestFullscreen?.();
    if (e.key === 's' || e.key === 'S') exportPng();
    if (e.key === '+' || e.key === '=') {
      state.autoIter = false; $('chk-autoiter').checked = false;
      state.maxIter = clamp(state.maxIter * 1.5 | 0, 100, 200000);
      $('in-iter').value = state.maxIter; $('rng-iter').value = state.maxIter; renderNow();
    }
    if (e.key === '-' || e.key === '_') {
      state.autoIter = false; $('chk-autoiter').checked = false;
      state.maxIter = clamp(state.maxIter / 1.5 | 0, 100, 200000);
      $('in-iter').value = state.maxIter; $('rng-iter').value = state.maxIter; renderNow();
    }
  });
}

function closeMenus(except) {
  ['menu-sets', 'menu-settings'].forEach(id => {
    const el = $(id);
    if (el !== except) {
      el.hidden = true;
      $(id === 'menu-sets' ? 'btn-sets' : 'btn-settings').classList.remove('open');
    }
  });
  if (except === $('menu-sets')) $('btn-sets').classList.add('open');
}

/* ---------------- 控制台开合 ---------------- */
/**
 * Single source of truth for console visibility.  The panel, the top-bar
 * toggle (which also serves as the "minimized" target) and the keyboard
 * shortcut all route through here so their states can never drift apart.
 */
function setPanelOpen(open, persist = true) {
  document.body.classList.toggle('panel-closed', !open);
  document.body.classList.toggle('panel-open', open && isMobileShell());
  const btn = $('btn-console');
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = (open ? t('consoleHide') : t('consoleShow')) + ' · P';
  }
  if (persist) {
    try { localStorage.setItem('mb.panel', open ? '1' : '0'); } catch { /* private mode */ }
  }
}

function togglePanel() {
  setPanelOpen(document.body.classList.contains('panel-closed'));
}

function exportPng() {
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mandelbrot-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

/* ---------------- 状态序列化 ---------------- */
function encodeState() {
  const payload = {
    s: state.spec, c: state.center, sp: state.span, i: state.maxIter,
    a: state.autoIter, b: state.bits, p: state.palette, cy: state.cycle, o: state.offset
  };
  return 'st=' + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodeState() {
  const h = location.hash.replace(/^#/, '');
  if (!h.startsWith('st=')) return false;
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(h.slice(3)))));
    Object.assign(state, {
      spec: o.s, center: o.c, span: o.sp, maxIter: o.i,
      autoIter: o.a, bits: o.b, palette: o.p, cycle: o.cy, offset: o.o
    });
    return true;
  } catch { return false; }
}

/* ---------------- i18n 应用 ---------------- */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.dataset.i18n;
    el.textContent = t(k);
  });
  document.title = 'MANDELBROT · ' + t('appSub');
  fillSelects();
  updateHud();
  setPanelOpen(!document.body.classList.contains('panel-closed'), false);
  if (modalKind === 'presets') openPresets();
}

/* ---------------- 画布尺寸 ---------------- */
function resizeCanvas() {
  const dpr = state.hd ? Math.min(2, window.devicePixelRatio || 1) : 1;
  canvas.width = Math.max(320, Math.round(innerWidth * dpr));
  canvas.height = Math.max(240, Math.round(innerHeight * dpr));
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  renderNow();
}

/* ---------------- 启动加载层 ---------------- */
const splash = {
  p: 0,
  startAt: 0,
  finished: false,
  el: null,
  fill: null,
  status: null,
  pct: null,
  init() {
    this.el = $('boot');
    this.fill = $('boot-fill');
    this.status = $('boot-status');
    this.pct = $('boot-pct');
    this.startAt = performance.now();
    this.set(0.04, 'bootInit');
  },
  set(p, key) {
    if (this.finished) return;
    if (p > this.p) this.p = Math.min(0.995, p);
    if (this.fill) this.fill.style.width = (this.p * 100).toFixed(1) + '%';
    if (this.pct) this.pct.textContent = Math.round(this.p * 100) + '%';
    if (key && this.status) this.status.textContent = t(key);
  },
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.p = 1;
    if (this.fill) this.fill.style.width = '100%';
    if (this.pct) this.pct.textContent = '100%';
    if (this.status) this.status.textContent = t('bootReady');
    const wait = Math.max(0, 820 - (performance.now() - this.startAt));
    setTimeout(() => {
      const el = this.el;
      if (el) el.classList.add('hide');
      document.body.classList.remove('booting');
      setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, 700);
    }, wait);
  }
};

/* ---------------- 启动 ---------------- */
function boot() {
  // Tell the inline bootstrap guard that the module graph loaded fine.
  window.__mbModuleLoaded = true;
  if (window.__mbBootWatch) clearTimeout(window.__mbBootWatch);

  splash.init();
  decodeState();
  setLang(state.lang);
  document.documentElement.dataset.theme = state.theme;
  fillSelects();
  syncModeUi();
  syncPaletteStrip();
  syncIterUi();
  applyI18n();
  bindUi();

  // Panel starts open on desktop, folded into the top-bar button on phones.
  let panelPref = null;
  try { panelPref = localStorage.getItem('mb.panel'); } catch { /* ignore */ }
  setPanelOpen(panelPref === null ? !isMobileShell() : panelPref === '1', false);
  panelQuery.addEventListener('change', () => {
    document.body.classList.toggle('panel-open',
      !document.body.classList.contains('panel-closed') && isMobileShell());
  });

  $('in-jr').value = state.spec.julia.re;
  $('in-ji').value = state.spec.julia.im;
  $('sel-palette').value = state.palette;
  $('rng-cycle').value = state.cycle; $('val-cycle').textContent = state.cycle;
  $('rng-offset').value = state.offset; $('val-offset').textContent = state.offset.toFixed(2);
  $('chk-autoiter').checked = state.autoIter;
  $('sel-bits').value = state.bits;
  splash.set(0.16, 'bootKernel');

  // 兜底：无论发生什么，8 秒后一定进入主界面
  setTimeout(() => { if (!splash.finished) splash.finish(); }, 8000);

  probeRemote().then((ok) => {
    updateEngineLabel();
    splash.set(ok ? 0.44 : 0.4, 'bootCore');
    if (ok) updateHud();
  });
  initWorkers();
  resizeCanvas();

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(resizeCanvas, 180);
  });
  updateHud();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
