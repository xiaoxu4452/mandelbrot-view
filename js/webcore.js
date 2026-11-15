// webcore.js — the page's render engine: the desktop core, compiled to wasm.
//
// `C:\Users\harve\Desktop\mande\new` (the "Retinamandelbrot" core) is compiled
// to core.wasm by webcore/build.mjs; this module is the thin client.  It hands
// back the *smooth iteration* of every pixel in the encoding the page's own
// field path always used (negative = interior), so the UI shades it with its
// own palette exactly as before.
//
// One frame is rendered by a small pool of wasm instances, each owning a
// horizontal band (adapter.cpp `mb_render_strip`).  wasm is single-threaded —
// GitHub Pages cannot send COOP/COEP, so there is no SharedArrayBuffer and no
// pthreads — but rows are independent, and the only shared piece, the
// reference orbit, is a small part of a frame's cost.  The pool is what makes
// a scalar core use the machine's (or the phone's) cores.

/* Six is where the curve flattens: the shared reference orbit costs ~170 ms per
 * band at 1e600 and every band pays it, so wall time is orbit + pixels/k.  On a
 * 16-core desktop, 1248x804 at 10^600: 1 band 1695 ms, 4 bands 450 ms, 8 bands
 * 249 ms — 6 bands lands within 15% of 8 with less memory per frame. */
const MAX_WORKERS = 6;
/* `?bands=N` pins the split so the choice can be measured instead of guessed. */
const FORCE_BANDS = (() => {
  const n = Number(new URLSearchParams(location.search).get('bands') || 0);
  return Number.isFinite(n) && n > 0 ? Math.min(8, n | 0) : 0;
})();
const poolSize = (() => {
  const hc = (navigator.hardwareConcurrency || 4) | 0;
  /* Leave a core for the UI thread and the compositor. */
  return Math.max(1, Math.min(MAX_WORKERS, hc - 1));
})();

let workers = [];
let booting = null;
let ready = false;
let failed = false;
let seq = 0;
const jobs = new Map();       // id -> { parts, want, resolve, reject, w, h }

function bootOne() {
  const w = new Worker('js/webcore-worker.js?v=58', { type: 'classic' });
  w.ready = false;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') { w.ready = true; return; }
    const job = jobs.get(m.id);
    if (!job) return;                        // a frame nobody is waiting for
    if (m.type === 'error') {
      jobs.delete(m.id);
      job.reject(new Error(m.err || 'core error'));
      return;
    }
    job.parts.push(m);
    if (job.parts.length < job.want) return;
    jobs.delete(m.id);
    job.resolve({
      w: job.w, h: job.h,
      field: assemble(job.parts, job.w, job.h),
      stats: mergeStats(job.parts),
      ms: job.parts.reduce((a, p) => Math.max(a, p.ms), 0),
    });
  };
  w.onerror = (e) => {
    failed = true;
    for (const [, j] of jobs) j.reject(new Error(e.message || 'worker failed'));
    jobs.clear();
  };
  w.postMessage({ cmd: 'boot' });
  return w;
}

function mergeStats(parts) {
  const st = { seconds: 0, pixels: 0, glitches: 0, refLen: 0, precDigits: 0,
               log10Zoom: 0, minEsc: Infinity, maxEsc: -Infinity, bounded: 0 };
  for (const p of parts) {
    const s = p.stats || {};
    st.seconds += s.seconds || 0;
    st.pixels += s.pixels || 0;
    st.glitches += s.glitches || 0;
    st.bounded += s.bounded || 0;
    st.refLen = Math.max(st.refLen, s.refLen || 0);
    st.precDigits = Math.max(st.precDigits, s.precDigits || 0);
    st.log10Zoom = s.log10Zoom || st.log10Zoom;
    if (Number.isFinite(s.minEsc)) st.minEsc = Math.min(st.minEsc, s.minEsc);
    if (Number.isFinite(s.maxEsc)) st.maxEsc = Math.max(st.maxEsc, s.maxEsc);
  }
  if (!Number.isFinite(st.minEsc)) st.minEsc = 0;
  if (!Number.isFinite(st.maxEsc)) st.maxEsc = 0;
  return st;
}

function assemble(parts, w, h) {
  const out = new Float32Array(w * h);
  for (const p of parts) out.set(p.field, (p.y0 | 0) * w);
  return out;
}

function ensure() {
  if (workers.length) return workers;
  workers = Array.from({ length: poolSize }, () => bootOne());
  return workers;
}

export function coreFailed() { return failed; }

/** Resolves once every wasm instance in the pool is loaded. */
export function coreReady() {
  if (ready) return Promise.resolve(true);
  if (failed) return Promise.reject(new Error('core unavailable'));
  ensure();
  if (!booting) {
    booting = new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (workers.every((w) => w.ready)) { ready = true; resolve(true); return; }
        if (Date.now() - t0 > 60000) { reject(new Error('core load timeout')); return; }
        setTimeout(tick, 40);
      };
      tick();
    });
  }
  return booting;
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
 * Render one frame with the pool.
 *   re, im    the centre exactly as the page holds it (a decimal string at
 *             full depth — never rounded through a double here)
 *   span      { m, e } complex width of the *whole* canvas
 *   w, h      pixel size of this frame (a reduced preview passes a smaller w/h
 *             with the same span: the region covered does not change)
 *   maxiter   iteration ceiling
 *
 * Replies with the smooth iteration of every pixel (interior = -1) and the
 * frame's stats; the palette band is the page's business.
 */
export function coreRender({ re, im, span, w, h, maxiter, julia, juliaRe, juliaIm, rot }) {
  ensure();
  const z = zoomFromSpan(span);
  const id = ++seq;
  const base = {
    re: String(re), im: String(im),
    zoomMant: z.mant, zoomExp10: z.exp,
    width: w | 0, height: h | 0, maxiter: maxiter | 0,
    julia: !!julia, juliaRe: String(juliaRe || '0'), juliaIm: String(juliaIm || '0'),
    rotCos: Math.cos(+rot || 0), rotSin: Math.sin(+rot || 0),
  };
  /* One band per worker, but a band has to be tall enough to pay for its own
   * reference orbit (~170 ms at 10^600, and every band builds its own).  Below
   * ~48 rows the orbit is the whole band's work and splitting makes the frame
   * slower, not faster, so the split is capped by height as well. */
  /* The split can never exceed the pool: worker i owns band i.  `?bands=` is
   * clamped too, so a hand-typed number cannot ask for a band no worker owns. */
  const k = Math.max(1, Math.min(FORCE_BANDS || workers.length, workers.length,
                                 Math.floor((h | 0) / 48)));
  return new Promise((resolve, reject) => {
    const job = { parts: [], want: 1, resolve, reject, w: w | 0, h: h | 0 };
    jobs.set(id, job);
    if (k <= 1) {
      workers[0].postMessage({ cmd: 'render', id, job: base });
      return;
    }
    job.want = k;
    for (let i = 0; i < k; i++) {
      const y0 = Math.round((i * h) / k);
      const y1 = Math.round(((i + 1) * h) / k);
      workers[i].postMessage({ cmd: 'strip', id, job: { ...base, y0, y1 } });
    }
  });
}

/** View operations — the core owns the arithmetic, the page only asks. */
export function coreZoom(x, y, factor) {
  ensure();
  workers[0].postMessage({ cmd: 'zoom', x, y, factor });
}
export function corePan(dx, dy) {
  ensure();
  workers[0].postMessage({ cmd: 'pan', dx, dy });
}

/** How many wasm instances a frame is split across (for the HUD and tests). */
export function coreWorkers() { return poolSize; }
