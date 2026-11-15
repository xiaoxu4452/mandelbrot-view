/* bands.mjs — fan a frame out to N worker threads, one band each.
 *
 * The reference orbit and the jet coefficients are built ONCE by the host
 * (env.js) and copied into each worker's own wasm memory.  That is the whole
 * trick: precision cost is paid once, pixel cost is split N ways, and the
 * result is bit-identical to a single whole-frame render.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'band-worker.mjs');

/**
 * @param {object} o
 * @param {string} o.expr
 * @param {object} o.env      result of buildFormulaEnvironment()
 * @param {number} o.w, o.h, o.maxiter
 * @param {number} [o.workers=4]
 * @param {number} [o.mode=0], [o.bail2=1e20], [o.rebase=1]
 * @returns {Promise<{field:Float32Array, spawnMs:number, renderMs:number, bands:number}>}
 */
export function renderBands({
  expr, env, w, h, maxiter,
  workers = 4, mode = 0, bail2 = 1e20, rebase = 1,
}) {
  const n = Math.max(1, Math.min(workers, h));
  const edges = [];
  for (let i = 0; i < n; ++i) {
    edges.push([Math.floor(i * h / n), Math.floor((i + 1) * h / n)]);
  }
  const common = {
    expr, w, h, maxiter, mode, bail2,
    orbitLen: env.orbitLen,
    zr: env.zr, zi: env.zi, coefA: env.coefA, coefB: env.coefB,
    jetOrder: env.jetOrder, stride: env.stride,
    dMant: env.dMant, dExp2: env.dExp2,
    saSkip: env.saSkip, saAt: env.saAt, rebase,
  };
  const t0 = performance.now();
  const field = new Float32Array(w * h).fill(-1);
  const jobs = edges.map(([y0, y1]) => new Promise((resolve, reject) => {
    const wk = new Worker(WORKER, { workerData: { ...common, y0, y1 } });
    wk.on('message', (msg) => {
      field.set(msg.band, msg.y0 * w);
      wk.terminate().then(() => resolve()).catch(reject);
    });
    wk.on('error', reject);
  }));
  const t1 = performance.now();
  return Promise.all(jobs).then(() => ({
    field, spawnMs: t1 - t0, renderMs: performance.now() - t1, bands: n,
  }));
}
