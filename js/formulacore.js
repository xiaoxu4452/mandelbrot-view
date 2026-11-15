/* formulacore.js — page-side client for the arbitrary-formula C++ core.
 *
 * Mirrors webcore.coreRender()'s contract ({ w, h, field, stats, ms }) so the
 * same coreFrame() path can shade either engine.  wasm is single-threaded on
 * GitHub Pages (no COOP/COEP, no SharedArrayBuffer), so the frame is split
 * into horizontal bands and N workers each own one wasm instance.  Every band
 * builds the SAME deterministic arbitrary-precision reference orbit from the
 * same centre/zoom -- that is what keeps the strips bit-identical to one
 * whole-frame render (see formulacore/bands-test.mjs).
 *
 * An expression the C++ parser cannot compile is blacklisted for the session
 * and falls back to the page's JS kernel -- a formula should never disable the
 * Mandelbrot core for every later view.
 */
const WORKER_URL = 'js/formulacore-worker.js?v=57';
const MAX_WORKERS = 6;
const poolSize = (() => {
  const hc = (navigator.hardwareConcurrency || 4) | 0;
  return Math.max(1, Math.min(MAX_WORKERS, hc - 1));
})();

let workers = [];
let booting = null;
let ready = false;
let failed = false;
let seq = 0;
const jobs = new Map();
const blacklist = new Set();

export function isBlacklisted(expr) { return blacklist.has(String(expr)); }
export function blacklistExpr(expr) { if (expr) blacklist.add(String(expr)); }
export function isReady() { return ready; }
export function poolCount() { return workers.length; }

function bootOne() {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') { w.ready = true; resolve(w); return; }
      if (m.type === 'fatal') { reject(new Error(m.err)); return; }
      const job = jobs.get(m.id);
      if (!job) return;                       // a frame nobody is waiting for
      if (m.type === 'error') {
        jobs.delete(m.id);
        job.reject(new Error(m.err || 'formula core error'));
        return;
      }
      job.parts.push(m);
      if (job.parts.length < job.want) return;
      jobs.delete(m.id);
      job.resolve(assemble(job));
    };
    w.onerror = (ev) => reject(new Error(ev.message || 'formula worker error'));
    w.postMessage({ type: 'init' });
  });
}

function assemble(job) {
  const { w, h } = job;
  const field = new Float32Array(w * h).fill(-1);
  let ms = 0;
  let engine = '';
  for (const p of job.parts) {
    field.set(p.field, p.y0 * w);
    ms = Math.max(ms, p.ms || 0);
    engine = p.engine || engine;
  }
  let lo = Infinity, hi = 0, bounded = 0;
  for (let i = 0; i < field.length; ++i) {
    const v = field[i];
    if (!(v >= 0)) { ++bounded; continue; }
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  /* refLen 0: the deep-Julia short-reference guard belongs to webcore.  This
   * core has its own `useJet` contract and never paints a frame whose
   * reference died early. */
  return { w, h, field, ms, engine,
           stats: { minEsc: lo === Infinity ? 0 : lo, maxEsc: hi,
                    bounded, refLen: 0 } };
}

export function coreReady() {
  if (ready) return Promise.resolve();
  if (failed) return Promise.reject(new Error('formula core unavailable'));
  if (booting) return booting;
  booting = Promise.all(Array.from({ length: poolSize }, () => bootOne()))
    .then((ws) => { workers = ws; ready = true; })
    .catch((err) => { failed = true; workers.forEach((w) => w.terminate()); throw err; });
  return booting;
}

export function coreRender(job) {
  return coreReady().then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    const n = Math.min(workers.length, job.h);
    const edges = [];
    for (let i = 0; i < n; ++i)
      edges.push([Math.floor(i * job.h / n), Math.floor((i + 1) * job.h / n)]);
    jobs.set(id, { parts: [], want: n, resolve, reject, w: job.w, h: job.h });
    edges.forEach(([y0, y1], i) => {
      workers[i].postMessage({ type: 'render', id, job: { ...job, y0, y1 } });
    });
  }));
}
