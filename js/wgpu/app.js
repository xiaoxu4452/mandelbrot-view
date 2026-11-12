/* ------------------------------------------------------------------
 * app.js — UI controller for webgpu.html.
 * ------------------------------------------------------------------ */
import { DeepRenderer } from './renderer.js';

const canvas = document.getElementById('gpu-canvas');
const hud = {
  depth: document.getElementById('hud-depth'),
  bits: document.getElementById('hud-bits'),
  margin: document.getElementById('hud-margin'),
  ref: document.getElementById('hud-ref'),
  time: document.getElementById('hud-time'),
  glitch: document.getElementById('hud-glitch'),
  bla: document.getElementById('hud-bla'),
  size: document.getElementById('hud-size'),
  format: document.getElementById('hud-format'),
  phase: document.getElementById('hud-phase')
};
const loading = document.getElementById('loading');
const fallback = document.getElementById('fallback');
const fallbackReason = document.getElementById('fallback-reason');
const panel = document.getElementById('controls');

const VIEW0 = {
  centerRe: '-2',
  centerIm: '0',
  spanLog2: -3.5,
  maxIter: 2000,
  mode: 0,
  power: 2,
  useBla: true,
  shadeMode: 0,
  safety: 3,
  palette: { freq: 0.035, phase: 0.08, offset: 0.0, exposure: 1.0 }
};

let renderer = null;
let view = { ...VIEW0, palette: { ...VIEW0.palette } };
let busy = false;
let pending = false;
let wheelTimer = 0;

function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return n.toExponential(2);
  return n.toFixed(digits);
}

function updateHUD(s) {
  if (s.phase === 'orbit') {
    loading.classList.add('on');
    loading.textContent = `计算 MPFR 参考轨道 · ${s.depth || ''}`;
    hud.phase.textContent = '参考轨道重算中';
    return;
  }
  if (s.phase === 'frame' || s.phase === 'ready') loading.classList.remove('on');
  if (s.depth) hud.depth.textContent = s.depth;
  if (s.bits) hud.bits.textContent = `${s.bits} bit / ${fmt(s.digits, 0)} 位十进制`;
  if (s.marginBits !== undefined) hud.margin.textContent = `${s.marginBits} bit`;
  if (s.refLen) hud.ref.textContent = `${s.refLen}${s.escape >= 0 ? ' (esc ' + s.escape + ')' : ''}`;
  if (s.orbitMs !== undefined) hud.time.textContent = `${fmt(s.orbitMs)} ms / ${fmt(s.frameMs)} ms`;
  if (s.glitchRatio !== undefined) {
    hud.glitch.textContent = `${(s.glitchRatio * 100).toFixed(2)}% (${s.total})`;
    hud.glitch.classList.toggle('warn', s.glitchRatio > 0.01);
  }
  if (s.bla !== undefined) hud.bla.textContent = `${s.bla} blocks`;
  if (s.width) hud.size.textContent = `${s.width}×${s.height}`;
  if (s.format) hud.format.textContent = s.format;
  if (s.phase === 'ready') hud.phase.textContent = '就绪';
}

function showFallback(reason) {
  loading.classList.remove('on');
  fallback.hidden = false;
  fallbackReason.textContent = reason;
}

function depthToSpanLog2(e) {
  return e * Math.log2(10);
}

async function applyView() {
  if (!renderer) return;
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  try {
    await renderer.setView(view);
  } catch (err) {
    console.error(err);
    showFallback(String(err.message || err));
  } finally {
    busy = false;
    if (pending) {
      pending = false;
      applyView();
    }
  }
}

function scheduleZoom(factor, clientX, clientY) {
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(async () => {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (canvas.width / rect.width);
    const py = (clientY - rect.top) * (canvas.height / rect.height);
    if (renderer) {
      busy = true;
      try {
        await renderer.zoomAt(px, py, factor);
        view.centerRe = renderer.view.centerRe;
        view.centerIm = renderer.view.centerIm;
        view.spanLog2 = renderer.view.spanLog2;
      } catch (err) {
        showFallback(String(err.message || err));
      } finally {
        busy = false;
      }
    }
  }, 90);
}

async function boot() {
  try {
    renderer = new DeepRenderer(canvas, updateHUD);
    await renderer.init();
    window.__renderer = renderer;
    await renderer.setView(view);
  } catch (err) {
    const msg = String(err.message || err);
    let reason = msg;
    if (msg === 'NO_WEBGPU') reason = '当前浏览器未暴露 navigator.gpu。';
    if (msg === 'NO_ADAPTER') reason = '无法获取 WebGPU 适配器（GPU 被禁用或不受支持）。';
    showFallback(reason);
  }
}

/* ---------------- interaction ---------------- */

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0012);
  scheduleZoom(factor, e.clientX, e.clientY);
}, { passive: false });

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY };
  canvas.classList.add('grabbing');
});
canvas.addEventListener('pointerup', async (e) => {
  canvas.classList.remove('grabbing');
  if (!drag || !renderer) { drag = null; return; }
  const rect = canvas.getBoundingClientRect();
  const dx = (e.clientX - drag.x) * (canvas.width / rect.width);
  const dy = (e.clientY - drag.y) * (canvas.height / rect.height);
  drag = null;
  if (Math.abs(dx) + Math.abs(dy) < 2) return;
  try {
    await renderer.pan(dx, dy);
    view.centerRe = renderer.view.centerRe;
    view.centerIm = renderer.view.centerIm;
  } catch (err) {
    showFallback(String(err.message || err));
  }
});
canvas.addEventListener('pointercancel', () => {
  drag = null;
  canvas.classList.remove('grabbing');
});

document.querySelectorAll('[data-depth]').forEach((btn) => {
  btn.addEventListener('click', () => {
    view.centerRe = '-2';
    view.centerIm = '0';
    view.spanLog2 = depthToSpanLog2(Number(btn.dataset.depth));
    view.maxIter = Math.max(2000, Number(btn.dataset.iter) || 2000);
    if (renderer) renderer.orbit = null;
    applyView();
  });
});

document.getElementById('btn-reset').addEventListener('click', () => {
  view = { ...VIEW0, palette: { ...VIEW0.palette } };
  if (renderer) renderer.orbit = null;
  syncControls();
  applyView();
});

document.getElementById('opt-iter').addEventListener('change', (e) => {
  view.maxIter = Math.max(200, Math.min(30000, Number(e.target.value) || 2000));
  if (renderer) renderer.orbit = null;
  applyView();
});
document.getElementById('opt-bla').addEventListener('change', (e) => {
  view.useBla = e.target.checked;
  if (renderer) renderer.view.useBla = view.useBla;
  applyView();
});
document.getElementById('opt-mode').addEventListener('change', (e) => {
  view.shadeMode = Number(e.target.value);
  applyView();
});
document.getElementById('opt-safety').addEventListener('change', (e) => {
  view.safety = Number(e.target.value);
  if (renderer) renderer.orbit = null;
  applyView();
});
for (const id of ['freq', 'phase', 'offset', 'exposure']) {
  document.getElementById(id).addEventListener('input', (e) => {
    view.palette[id] = Number(e.target.value);
    document.getElementById(`v-${id}`).textContent = Number(e.target.value).toFixed(3);
  });
  document.getElementById(id).addEventListener('change', applyView);
}

function syncControls() {
  document.getElementById('opt-iter').value = view.maxIter;
  document.getElementById('opt-bla').checked = view.useBla;
  document.getElementById('opt-mode').value = String(view.shadeMode);
  document.getElementById('opt-safety').value = String(view.safety);
  for (const id of ['freq', 'phase', 'offset', 'exposure']) {
    document.getElementById(id).value = view.palette[id];
    document.getElementById(`v-${id}`).textContent = Number(view.palette[id]).toFixed(3);
  }
}

syncControls();
boot();
