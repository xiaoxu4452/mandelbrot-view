/* perturb-test.mjs — stage-2 acceptance checks.
 *
 *   1. At shallow zoom, perturbation reproduces the direct per-pixel render.
 *   2. c = i is an exact Misiurewicz point: it has self-similar structure at
 *      ANY depth, so it is the honest "does not go flat at 10^300" probe.
 *      Direct double iteration loses the pixel offset there; perturbation
 *      keeps it in float-exp form.
 *   3. Per-pixel cost must not grow with zoom: one orbit, N pixels.
 *
 *   node formulacore/perturb-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildOrbit } from './orbit.mjs';

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
const readField = (w, h) =>
  new Float32Array(e.memory.buffer, e.fc_out_ptr(), w * h).slice();

const prog = e.fc_compile(ws('z^2+c'));
if (prog < 0) throw new Error('compile failed');
const JK = e.fc_jet_order();
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};
function fieldStats(f) {
  let esc = 0, inside = 0, bad = 0;
  const uniq = new Set();
  for (const v of f) {
    if (!Number.isFinite(v)) { bad++; continue; }
    if (v >= 0) { esc++; uniq.add(Math.round(v * 4)); } else inside++;
  }
  return { esc, inside, uniq: uniq.size, bad };
}

const W = 120, H = 90, MAXIT = 1600, BAIL2 = 1e20;

function direct(re, im, m, exp10) {
  const t0 = performance.now();
  const rc = e.fc_render(prog, ws(re), ws(im), m, exp10, W, H, MAXIT,
    0, ws('0'), ws('0'), BAIL2, 0, 0, 1, 0);
  if (rc) throw new Error('direct rc ' + rc);
  return { f: readField(W, H), ms: performance.now() - t0 };
}
function perturb(re, im, m, exp10) {
  const orb = buildOrbit({ centerRe: re, centerIm: im, mode: 'm', power: 2,
    maxiter: MAXIT, zoomMant: m, zoomExp10: exp10, width: W, jetOrder: JK });
  const t0 = performance.now();
  const rc = e.fc_render_perturb(prog, W, H, MAXIT, 0, BAIL2,
    orb.orbitLen,
    putF64(orb.zr), putF64(orb.zi), putF64(orb.coefA), putF64(orb.coefB),
    orb.dMant, orb.dExp2, 1, 0, 0, H,
    orb.saSkip, putF64(orb.saAt));
  if (rc) throw new Error('perturb rc ' + rc);
  return { f: readField(W, H), ms: performance.now() - t0, orb };
}

// ---------------------------------------------------------------- 1. shallow --
{
  const a = direct('-0.6', '0', 1, 2);
  const b = perturb('-0.6', '0', 1, 2);
  let diff = 0, worst = 0;
  for (let i = 0; i < a.f.length; ++i) {
    const x = a.f[i], y = b.f[i];
    if ((x < 0) !== (y < 0)) { diff++; continue; }
    if (x >= 0) { const d = Math.abs(x - y); if (d > worst) worst = d; if (d > 2e-3) diff++; }
  }
  check('shallow: perturbation == direct per-pixel', diff === 0,
    `differing=${diff} worst=${worst.toExponential(2)} ` +
    `direct ${a.ms.toFixed(1)}ms / perturb ${b.ms.toFixed(1)}ms`);
}

// ------------------------------------------------------------------ 2. deep --
const rows = [];
for (const exp10 of [10, 30, 100, 300]) {
  let d = null, p = null, err = '';
  try {
    d = direct('0', '1', 1, exp10);
    p = perturb('0', '1', 1, exp10);
  } catch (ex) { err = ex.message; }
  if (err) { check(`1e${exp10}: renders`, false, err); continue; }
  const sd = fieldStats(d.f), sp = fieldStats(p.f);
  rows.push({ exp10, pMs: p.ms, pUniq: sp.uniq, pEsc: sp.esc, saSkip: p.orb.saSkip });
  check(`1e${exp10}: perturbation keeps structure (direct goes flat)`,
    sp.uniq >= sd.uniq && sp.uniq > 1 && sp.bad === 0,
    `direct uniq=${sd.uniq} esc=${sd.esc} | perturb uniq=${sp.uniq} esc=${sp.esc} ` +
    `bad=${sp.bad} | ${p.ms.toFixed(1)}ms digits=${p.orb.digits} saSkip=${p.orb.saSkip}`);
}

// ------------------------------------------------------------------ 3. cost --
if (rows.length >= 2) {
  const first = rows[0], last = rows[rows.length - 1];
  const ratio = last.pMs / Math.max(0.001, first.pMs);
  check('per-pixel cost does not grow with zoom', ratio < 2.5,
    `1e${first.exp10} ${first.pMs.toFixed(1)}ms -> 1e${last.exp10} ${last.pMs.toFixed(1)}ms ` +
    `(x${ratio.toFixed(2)})`);
}

console.log(failures ? `[formulacore/perturb] ${failures} FAILED`
                     : '[formulacore/perturb] all checks passed');
if (failures) process.exitCode = 1;
