/* bands-test.mjs — N worker threads must reproduce one whole frame exactly.
 *   node formulacore/bands-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildFormulaEnvironment } from './env.js';
import { renderBands } from './bands.mjs';

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
const put = (a) => {
  const p = e.fc_alloc(a.length * 8);
  new Float64Array(e.memory.buffer, p, a.length).set(a);
  return p;
};

const expr = 'z^2+c';
const W = 320, H = 240, MAXITER = 1600, BAIL2 = 1e20;
const prog = e.fc_compile(ws(expr));
const env = buildFormulaEnvironment({
  expr, centerRe: '0', centerIm: '1', maxiter: MAXITER,
  zoomMant: 1, zoomExp10: 100, width: W,
});
console.log(`orbit: ${env.orbitLen} steps, ${env.bits} bits, K=${env.jetOrder}, ` +
            `saSkip=${env.saSkip}, usable=${env.usable}`);

const args = [prog, W, H, MAXITER, 0, BAIL2, env.orbitLen,
  put(env.zr), put(env.zi), put(env.coefA), put(env.coefB),
  env.jetOrder, env.stride, env.dMant, env.dExp2, 1, 0,
  0, H, env.saSkip, put(env.saAt), 1];
const t0 = performance.now();
let rc = e.fc_render_jet(...args);
if (rc) throw new Error('whole frame rc ' + rc);
const whole = new Float32Array(e.memory.buffer, e.fc_out_ptr(), W * H).slice();
const wholeMs = performance.now() - t0;

let failures = 0;
for (const n of [1, 2, 4]) {
  const r = await renderBands({
    expr, env, w: W, h: H, maxiter: MAXITER, workers: n, rebase: 1,
  });
  let bad = 0, max = 0;
  for (let i = 0; i < whole.length; ++i) {
    const d = Math.abs(whole[i] - r.field[i]);
    if (d > 1e-6) ++bad;
    if (d > max) max = d;
  }
  const ok = bad === 0;
  if (!ok) ++failures;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n} worker(s): differing=${bad} max=${max} ` +
    `| spawn ${r.spawnMs.toFixed(0)}ms + render ${r.renderMs.toFixed(0)}ms ` +
    `= ${(r.spawnMs + r.renderMs).toFixed(0)}ms  (single ${wholeMs.toFixed(0)}ms, ` +
    `${(wholeMs / (r.spawnMs + r.renderMs)).toFixed(2)}x)`);
}
console.log(failures ? `[bands] ${failures} FAILED` : '[bands] all bands bit-identical');
if (failures) process.exitCode = 1;
