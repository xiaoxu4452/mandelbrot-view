/* band-worker.mjs — one worker, one wasm instance, one horizontal band.
 *
 * GitHub Pages cannot send COOP/COEP, so there is no SharedArrayBuffer and the
 * wasm core is single-threaded.  The page instead runs N independent wasm
 * instances (N workers); each receives the SAME arbitrary-precision reference
 * orbit and jet coefficients and renders a disjoint band.  Sharing the orbit
 * is what keeps the bands bit-identical to a single-frame render.
 */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'formulacore.wasm')));
let e = null;
const dv = () => new DataView(e.memory.buffer);
const stub = (name) => (...a) => {
  if (name === 'environ_sizes_get' || name === 'args_sizes_get') {
    const d = dv();
    if (a[0]) d.setUint32(a[0], 0, true);
    if (a[1]) d.setUint32(a[1], 0, true);
    return 0;
  }
  if (name === 'clock_time_get') {
    const d = dv();
    if (a[2]) d.setBigUint64(a[2], BigInt(Date.now() * 1000000), true);
    return 0;
  }
  if (name === 'fd_write') { const d = dv(); if (a[3]) d.setUint32(a[3], 0, true); return 0; }
  if (name === 'proc_exit') throw new Error('proc_exit ' + a[0]);
  return 0;
};
const imports = {};
for (const imp of WebAssembly.Module.imports(mod)) {
  imports[imp.module] ||= {};
  imports[imp.module][imp.name] = imp.kind === 'function' ? stub(imp.name) : 0;
}
e = new WebAssembly.Instance(mod, imports).exports;

const enc = new TextEncoder();
const ws = (s) => {
  const b = enc.encode(String(s) + '\0');
  const p = e.fc_alloc(b.length);
  new Uint8Array(e.memory.buffer).set(b, p);
  return p;
};
const putF64 = (arr) => {
  const p = e.fc_alloc(arr.length * 8);
  new Float64Array(e.memory.buffer, p, arr.length).set(arr);
  return p;
};

const j = workerData;
const prog = e.fc_compile(ws(j.expr));
if (prog < 0) throw new Error('compile failed: ' + j.expr);
const zr = putF64(new Float64Array(j.zr));
const zi = putF64(new Float64Array(j.zi));
const ca = putF64(new Float64Array(j.coefA));
const cb = putF64(new Float64Array(j.coefB));
const sa = putF64(new Float64Array(j.saAt));

const rc = e.fc_render_jet(prog, j.w, j.h, j.maxiter, j.mode, j.bail2,
  j.orbitLen, zr, zi, ca, cb, j.jetOrder, j.stride,
  j.dMant, j.dExp2, 1, 0, j.y0, j.y1, j.saSkip, sa, j.rebase);
if (rc) throw new Error('fc_render_jet rc ' + rc);

const all = new Float32Array(e.memory.buffer, e.fc_out_ptr(), j.w * j.h);
const band = all.slice(j.y0 * j.w, j.y1 * j.w);
parentPort.postMessage({ y0: j.y0, y1: j.y1, band }, [band.buffer]);
