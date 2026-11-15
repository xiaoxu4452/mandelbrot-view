// webcore.js — the page's render engine: the desktop core, compiled to wasm.
//
// `C:\Users\harve\Desktop\mande\new` (the "Retinamandelbrot" core) is compiled
// to core.wasm by webcore/build.mjs; this module is the thin client.  It
// renders a whole frame and hands back the *colour position* of every pixel in
// the same encoding the page's own field path always used (0..1, negative =
// interior), so the UI shades it with its own palette table exactly as before.
//
// The picture therefore comes from the desktop core — reference orbit,
// perturbation, glitch repair, series approximation, arbitrary precision — and
// the page keeps only what it owns: the gestures, the palette, the HUD.

let worker = null;
let seq = 0;
const pending = new Map();
let ready = false;
let failed = false;
let onReady = null;

function ensure() {
  if (worker) return worker;
  worker = new Worker('js/webcore-worker.js?v=3', { type: 'classic' });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') {
      ready = true;
      if (onReady) onReady();
      return;
    }
    const job = pending.get(m.id);
    if (!job) return;
    pending.delete(m.id);
    if (m.type === 'error') job.reject(new Error(m.err || 'core error'));
    else job.resolve(m);
  };
  worker.onerror = (e) => {
    failed = true;
    for (const [, j] of pending) j.reject(new Error(e.message || 'worker failed'));
    pending.clear();
  };
  worker.postMessage({ cmd: 'boot' });
  return worker;
}

export function coreFailed() { return failed; }

/** Resolves once the wasm core is loaded (or rejects after a first failure). */
export function coreReady() {
  if (ready) return Promise.resolve(true);
  if (failed) return Promise.reject(new Error('core unavailable'));
  ensure();
  return new Promise((resolve, reject) => {
    onReady = () => resolve(true);
    setTimeout(() => reject(new Error('core load timeout')), 60000);
  });
}

/* The page's span is the complex width of the frame as m * 2^e.  The core
 * wants a decimal zoom = 3 / span (its `zoom` is "3.0 covers the whole set").
 * Taking the ratio in logs keeps 2^-100000 from underflowing to zero on the
 * way through Math.pow — the double is only used for a decimal mantissa. */
function zoomFromSpan(span) {
  const m = Math.abs(span.m) || 1;
  const log10span = Math.log10(m) + (span.e | 0) * Math.LOG10E * Math.LN2;
  const log10zoom = Math.log10(3) - log10span;
  let exp = Math.floor(log10zoom);
  let mant = Math.pow(10, log10zoom - exp);
  if (!(mant > 0) || !isFinite(mant)) { mant = 1; exp = Math.round(log10zoom); }
  return { mant, exp };
}

/**
 * Render one frame with the core.
 *   re, im    the centre exactly as the page holds it (a decimal string at
 *             full depth — never rounded through a double here)
 *   span      { m, e } complex width of the *whole* canvas
 *   w, h      pixel size of this frame (a reduced preview passes a smaller w/h
 *             with the same span: the region covered does not change)
 *   maxiter   iteration ceiling
 *   cycle     iterations per palette band, `offset` the palette phase
 */
export function coreRender({ re, im, span, w, h, maxiter, cycle, offset,
                             julia, juliaRe, juliaIm }) {
  ensure();
  const z = zoomFromSpan(span);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ cmd: 'render', id, job: {
      re: String(re), im: String(im),
      zoomMant: z.mant, zoomExp10: z.exp,
      width: w | 0, height: h | 0, maxiter: maxiter | 0,
      cycle: Math.max(2, cycle | 0), offset: +offset || 0,
      julia: !!julia, juliaRe: String(juliaRe || '0'), juliaIm: String(juliaIm || '0'),
      field: true,
    } });
  });
}

/** View operations — the core owns the arithmetic, the page only asks. */
export function coreZoom(x, y, factor) {
  ensure();
  worker.postMessage({ cmd: 'zoom', x, y, factor });
}
export function corePan(dx, dy) {
  ensure();
  worker.postMessage({ cmd: 'pan', dx, dy });
}
