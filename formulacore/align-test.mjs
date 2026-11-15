/* align-test.mjs — compare the formula core's z^2+c field with the desktop
 * core.wasm field, pixel by pixel, at the same view / budget.
 *
 * Both emit a single-channel f32 smooth-iteration field (-1 = interior), so
 * the page's shadeSmoothField() can consume either.  This test quantifies any
 * constant offset and any real geometric disagreement before the formula core
 * is wired into the page.
 *
 *   node formulacore/align-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFormulaEnvironment } from './env.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(ROOT, '..', 'webcore', 'core.wasm');

function instantiate(file) {
  const mod = new WebAssembly.Module(fs.readFileSync(file));
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
  return {
    e,
    ws: (s) => {
      const b = enc.encode(String(s) + '\0');
      const p = e.mb_alloc ? e.mb_alloc(b.length) : e.fc_alloc(b.length);
      new Uint8Array(e.memory.buffer).set(b, p);
      return p;
    },
    put: (a) => {
      const p = e.mb_alloc ? e.mb_alloc(a.length * 8) : e.fc_alloc(a.length * 8);
      new Float64Array(e.memory.buffer, p, a.length).set(a);
      return p;
    },
  };
}

const A = instantiate(CORE);
const B = instantiate(path.join(ROOT, 'formulacore.wasm'));
const W = 120, H = 90, MAXITER = 1600;
/* webcore/src/deep.cpp: kEscape2 = 4.0 (|z| > 2). */
const BAIL2 = 4.0;
const CRE = '0', CIM = '1';       // c = i, exact Misiurewicz point
let failures = 0;

for (const exp10 of [0, 10, 30, 100]) {
  /* Desktop core: an empty palette selects the f32 smooth field. */
  const a = A.ws(CRE), b = A.ws(CIM), empty = A.ws('');
  const rc = A.e.mb_render(a, b, 1, exp10, W, H, MAXITER, 0, 0, 0,
    empty, 0, 0, 16, 1, 1, 0, 1, 1, 0, 0);
  if (rc) throw new Error('mb_render rc ' + rc);
  const mode = A.e.mb_out_mode();
  if (mode !== 1) throw new Error('desktop core returned an image, not a field (mode ' + mode + ')');
  const f4 = new Float32Array(A.e.memory.buffer, A.e.mb_out_ptr(), W * H * 4);
  const core = new Float32Array(W * H);
  for (let i = 0; i < W * H; ++i) core[i] = f4[i * 4] >= 0 ? f4[i * 4] : -1;

  /* Formula core: always the jet perturbation path -- that is the engine
   * which will replace the JS fallback.  The stage-1 direct renderer has its
   * own (off-by-one) smoothing convention and is not part of that path. */
  const expr = 'z^2+c';
  const prog = B.e.fc_compile(B.ws(expr));
  const env = buildFormulaEnvironment({
    expr, centerRe: CRE, centerIm: CIM, maxiter: MAXITER,
    zoomMant: 1, zoomExp10: exp10, width: W,
  });
  if (!env.usable) throw new Error('env not usable at 1e' + exp10);
  const r = B.e.fc_render_jet(prog, W, H, MAXITER, 0, BAIL2,
    env.orbitLen, B.put(env.zr), B.put(env.zi), B.put(env.coefA), B.put(env.coefB),
    env.jetOrder, env.stride, env.dMant, env.dExp2, 1, 0,
    0, H, env.saSkip, B.put(env.saAt), 0);
  if (r) throw new Error('fc_render_jet rc ' + r);
  const form = new Float32Array(B.e.memory.buffer, B.e.fc_out_ptr(), W * H).slice();

  /* Best constant offset, and the residual after removing it. */
  let bestOff = 0, bestErr = Infinity;
  for (let off = -4; off <= 4; off += 0.05) {
    let err = 0, n = 0;
    for (let i = 0; i < W * H; ++i) {
      if (core[i] < 0 || form[i] < 0) continue;
      err += Math.abs(core[i] - (form[i] + off)); n++;
    }
    err /= Math.max(1, n);
    if (err < bestErr) { bestErr = err; bestOff = off; }
  }
  let sign = 0, nEsc = 0, residual = 0;
  for (let i = 0; i < W * H; ++i) {
    if ((core[i] < 0) !== (form[i] < 0)) { sign++; continue; }
    if (core[i] < 0) continue;
    nEsc++;
    residual += Math.abs(core[i] - (form[i] + bestOff));
  }
  const mean = nEsc ? residual / nEsc : 0;
  /* A single boundary pixel may fall on the other side of the escape test
   * because the two cores use different SA orders / float-exp roundings. */
  const ok = sign <= 2 && Math.abs(bestOff) < 0.06 && mean < 0.02;
  if (!ok) ++failures;
  console.log(`${ok ? 'PASS' : 'FAIL'} 1e${String(exp10).padEnd(3)} ` +
    `best offset ${bestOff >= 0 ? '+' : ''}${bestOff.toFixed(2)}  ` +
    `residual mean ${mean.toFixed(4)}  interior/exterior disagreements ${sign}`);
}
console.log(failures ? `[align] ${failures} FAILED` :
  '[align] fields agree up to a constant smooth-iteration offset');
if (failures) process.exitCode = 1;
