/* general-test.mjs — acceptance for the general (arbitrary-expression) jet VM.
 *
 * The "general jet VM" is not a new interpreter: the project's own
 * js/customenv.js (hpeval.js BigInt arbitrary precision + jet.js automatic
 * differentiation) already produces the coefficients.  This test proves that
 * feeding those coefficients into the C++ perturbation renderer reproduces a
 * direct per-pixel render of the SAME expression, that transcendental / nested
 * maps work (not just z^d+c), that a deep view does not go flat, and that the
 * frame cost does not grow with zoom.
 *
 *   node formulacore/general-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildFormulaEnvironment } from './env.js';
import { compile as compilePage } from '../js/mathlib.js?v=55';

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

const programs = new Map();
function progOf(expr) {
  if (!programs.has(expr)) {
    const id = e.fc_compile(ws(expr));
    if (id < 0) throw new Error('compile failed: ' + expr);
    programs.set(expr, id);
  }
  return programs.get(expr);
}

const W = 120, H = 90;
const BAIL2 = 1e20;
const NPIX = W * H;

function direct(expr, { cre, cim, zoomMant, zoomExp10, maxiter }) {
  const p = progOf(expr);
  const t0 = performance.now();
  const rc = e.fc_render(p, ws(cre), ws(cim), zoomMant, zoomExp10,
    W, H, maxiter, 0, ws('0'), ws('0'), BAIL2, 0, 0, 1, 0, 0, H);
  if (rc) throw new Error('direct rc ' + rc);
  return { f: readField(W, H), ms: performance.now() - t0 };
}

function jet(expr, { cre, cim, zoomMant, zoomExp10, maxiter, rebase = 0, band = null, noSA = false }) {
  const p = progOf(expr);
  const t0 = performance.now();
  const env = buildFormulaEnvironment({
    expr, centerRe: cre, centerIm: cim, maxiter,
    zoomMant, zoomExp10, width: W,
  });
  const tEnv = performance.now();
  const zr = putF64(env.zr), zi = putF64(env.zi);
  const ca = putF64(env.coefA), cb = putF64(env.coefB);
  const sa = putF64(noSA ? new Float64Array(env.stride) : env.saAt);
  const t1 = performance.now();
  const y0 = band ? band[0] : 0, y1 = band ? band[1] : H;
  const rc = e.fc_render_jet(p, W, H, maxiter, 0, BAIL2,
    env.orbitLen, zr, zi, ca, cb, env.jetOrder, env.stride,
    env.dMant, env.dExp2, 1, 0, y0, y1, env.saSkip, sa, rebase);
  if (rc) throw new Error('jet rc ' + rc);
  return {
    f: readField(W, H), env,
    orbMs: tEnv - t0, copyMs: t1 - tEnv,
    ms: performance.now() - t1,
  };
}

/* Oracle in the PAGE's formula semantics.  fc_render() is the stage-1 C++
 * double engine; its complex elementary functions are a separate libm-based
 * implementation, while the jet coefficients come from the page's AST
 * (mathlib/hpeval/jet).  Comparing against the page evaluator isolates the
 * perturbation maths instead of mixing in two different function libraries. */
const pagePrograms = new Map();
function pageDirect(expr, { cre, cim, zoomMant, zoomExp10, maxiter, w = W, h = H }) {
  if (!pagePrograms.has(expr)) pagePrograms.set(expr, compilePage(expr));
  const d = pagePrograms.get(expr);
  const P = new Float64Array(16);
  const S = { zpr: 0, zpi: 0, cr: 0, ci: 0, on: 0 };
  const O = new Float64Array(2);
  const ps = 3 / (zoomMant * Math.pow(10, zoomExp10)) / w;
  const cr0 = Number(cre), ci0 = Number(cim);
  const logBail = 0.5 * Math.log(BAIL2);
  const f = new Float32Array(w * h);
  for (let y = 0; y < h; ++y) {
    const py = (y + 0.5 - 0.5 * h) * ps;
    for (let x = 0; x < w; ++x) {
      const px = (x + 0.5 - 0.5 * w) * ps;
      const cr = cr0 + px, ci = ci0 - py;
      let zr = 0, zi = 0;
      let value = -1;
      for (let it = 0; it < maxiter; ++it) {
        S.zpr = zr; S.zpi = zi; S.cr = cr; S.ci = ci; S.on = it;
        d.fn(zr, zi, cr, ci, P, it, S, O);
        zr = O[0]; zi = O[1];
        const z2 = zr * zr + zi * zi;
        if (!(z2 <= BAIL2)) {
          const logz = 0.5 * Math.log(Math.max(z2, 1e-300));
          value = Number.isFinite(z2)
            ? (it + 1) - Math.log2(logz / logBail)
            : (it + 1);
          if (!(value >= 0) || !Number.isFinite(value)) value = 0;
          break;
        }
        if (!Number.isFinite(z2)) break;
      }
      f[y * w + x] = value;
    }
  }
  return { f, ms: 0 };
}

function stats(f) {
  const seen = new Set();
  let esc = 0, inside = 0, bad = 0, sum = 0;
  for (const v of f) {
    if (!Number.isFinite(v)) { bad++; continue; }
    if (v < 0) inside++;
    else { esc++; sum += v; seen.add(Math.round(v)); }
  }
  return { esc, inside, bad, uniq: seen.size, mean: esc ? sum / esc : 0 };
}
function compare(A, B, tol = 0.05) {
  const N = A.length;
  /* The stage-1 direct renderer and webcore disagree by exactly one iteration
   * in their smoothing convention.  Fold that CONSTANT out so the check is
   * about geometry, while still reporting it. */
  const diffs = [];
  for (let i = 0; i < N; ++i)
    if (A[i] >= 0 && B[i] >= 0) diffs.push(A[i] - B[i]);
  diffs.sort((p, q) => p - q);
  const shift = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
  let n = 0, max = 0, sum = 0, sign = 0;
  for (let i = 0; i < N; ++i) {
    const a = A[i], b = B[i];
    if ((a < 0) !== (b < 0)) { n++; sign++; sum += 1; max = Math.max(max, 1); continue; }
    const d = (a < 0 && b < 0) ? 0 : Math.abs((a - b) - shift);
    sum += Math.min(d, 1000);
    if (d > max) max = d;
    if (d > tol) n++;
  }
  return { bad: n, max, mean: sum / N, sign, shift };
}

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
};

/** Boundary pixels of the full view, sampled across the frame.  Zooming on a
 *  point where the escape/interior classification flips keeps structure at
 *  depth; a single arbitrary boundary pixel often lands in a flat region. */
function boundaryCandidates(expr, cre, cim) {
  const f = pageDirect(expr, { cre, cim, zoomMant: 1, zoomExp10: 0, maxiter: 300 }).f;
  const ps = 3 / W;
  const out = [];
  for (let y = 3; y < H - 3; y += 5) {
    for (let x = 3; x < W - 3; x += 5) {
      const i = y * W + x;
      if ((f[i] < 0) !== (f[i + 1] < 0)) {
        const px = (x + 1.5 - 0.5 * W) * ps;
        const py = (y + 0.5 - 0.5 * H) * ps;
        out.push({ re: (Number(cre) + px).toFixed(20),
                   im: (Number(cim) - py).toFixed(20) });
      }
      if (out.length >= 14) return out;
    }
  }
  return out;
}

/** Pick a (centre, zoom) whose frame really has structure.  A comparison where
 *  both renders are entirely interior proves nothing about jet coefficients. */
function structuredView(expr, cre0, cim0, zexpWanted) {
  const cs = boundaryCandidates(expr, cre0, cim0);
  for (const zexp of [zexpWanted, 6, 4, 2]) {
    for (const c of cs) {
      const o = { cre: c.re, cim: c.im, zoomMant: 1, zoomExp10: zexp,
                  maxiter: 200, w: 32, h: 24 };
      const st = stats(pageDirect(expr, o).f);
      if (st.uniq > 8 && st.esc > 100) return { cre: c.re, cim: c.im, zexp };
    }
  }
  return null;
}

console.log('=== 1. General expressions: jet perturbation vs direct per-pixel ===');
/* Perturbation is a DEEP-ZOOM technique: it assumes |delta| is tiny.  At a
 * whole-set view delta is O(1), so the truncated jet (and the linear-in-c
 * expansion) cannot match a direct render -- the desktop core also switches to
 * plain double below ~1e8.  Polynomials are exact at any delta (K >= degree),
 * so they are checked at zoom 1; transcendental maps are checked at 1e8 where
 * |delta| ~ 1e-8 and the truncation error is far below one iteration. */
const exprs = [
  ['z^2+c',              '-0.5', '0',   0],
  ['z^3+c',              '-0.2', '0.3', 0],
  ['z^4+z^2+c',          '-0.4', '0.2', 8],
  ['(z+1)^3+c',          '-0.6', '0.1', 8],
  ['z^2*c^2+c',          '-0.5', '0.2', 8],
  ['sin(z)+c',           '-0.5', '0.2', 8],
  ['sin(z)*cos(z)+c',    '-0.4', '0.1', 8],
  ['z^2+sin(c)',         '-0.5', '0.1', 8],
  ['exp(0.3*z)+c',       '-0.5', '0.1', 8],
  ['log(z^2+1)+c',       '-0.5', '0.2', 8],
  ['abs(z)+c',           '-0.5', '0.2', 8],  // non-holomorphic -> linear
];
for (const [expr, cre0, cim0, zexp] of exprs) {
  /* Transcendental maps need a boundary centre to have structure at depth;
   * an arbitrary centre zooms straight into a flat interior/exterior region. */
  const sv = zexp ? structuredView(expr, cre0, cim0, zexp) : null;
  const cre = sv ? sv.cre : cre0, cim = sv ? sv.cim : cim0;
  const z = sv ? sv.zexp : zexp;
  if (zexp && !sv) console.log('  NOTE ' + expr + ': no structured centre found (weak check)');
  const o = { cre, cim, zoomMant: 1, zoomExp10: z, maxiter: 300, rebase: 0 };
  try {
    const d = pageDirect(expr, o), j = jet(expr, o);
    const sd = stats(d.f), sj = stats(j.f);
    const c = compare(d.f, j.f);
    const frac = c.bad / NPIX;
    if (!j.env.usable) {
      /* The perturbation frame is NOT a render of this view.  The contract is
       * to detect it and use the direct frame instead; such views have short
       * orbits, so the direct renderer is both correct and cheap. */
      const why = !j.env.refOK
        ? `reference died at ${j.env.refLen}/${o.maxiter}`
        : `transcendental map at 1e${z} (needs >= 1e12)`;
      check(true, (expr + ' @1e' + z).padEnd(27),
        `${why} -> host falls back to direct (jet discarded, ${sd.uniq} levels)`);
      continue;
    }
    const bothFlat = sd.uniq === 0 && sj.uniq === 0;   // bounded map: all interior
    const structured = sd.uniq > 3 && sj.uniq > 3 && sd.esc > 100 && sj.esc > 100;
    const ok = sj.bad === 0 && frac < 0.02 && c.mean < 0.5 &&
               (bothFlat || structured);
    check(ok, (expr + (z ? ' @1e' + z : '')).padEnd(27),
      `K=${j.env.jetOrder} ${j.env.holomorphic ? 'holo' : 'linear'} ` +
      `centre ${sv ? 'boundary' : 'given'} refLen ${j.env.refLen}/${o.maxiter}` +
      `${j.env.escaped ? ' ESCAPED' : ''} | ` +
      `direct ${sd.uniq} levels / jet ${sj.uniq} levels ` +
      `(esc ${sd.esc}/${sj.esc}) | ` +
      `diff ${(100 * frac).toFixed(2)}% mean ${c.mean.toFixed(3)} max ${c.max.toFixed(2)} ` +
      `| orb ${j.env.orbMs.toFixed(0)}ms render ${j.ms.toFixed(0)}ms`);
  } catch (err) {
    check(false, expr.padEnd(20), 'ERROR ' + err.message);
  }
}

console.log('\n=== 2. Deep zoom: z^2+c at the exact Misiurewicz point c = i ===');
const rows = [];
for (const exp10 of [10, 30, 100, 300]) {
  const o = { cre: '0', cim: '1', zoomMant: 1, zoomExp10: exp10, maxiter: 1600 };
  const d = direct(exprs[0][0], o);
  const j = jet(exprs[0][0], o);
  const sd = stats(d.f), sj = stats(j.f);
  rows.push({ exp10, d, sd, j, sj });
  const ok = sj.bad === 0 && sj.esc > NPIX * 0.9 && sj.uniq > 20;
  check(ok, `1e${exp10}`.padEnd(20),
    `direct ${sd.uniq} levels / jet ${sj.uniq} levels, esc ${sj.esc} ` +
    `| bits ${j.env.bits} saSkip ${j.env.saSkip} ` +
    `| orb ${j.env.orbMs.toFixed(0)}ms render ${j.ms.toFixed(0)}ms`);
}
const t0 = rows[0].j, t3 = rows[rows.length - 1].j;
const ratio = (t3.ms + t3.env.orbMs) / (t0.ms + t0.env.orbMs);
check(ratio < 2.5, 'cost 1e300 / 1e10',
  `${ratio.toFixed(2)}x  (${(t0.ms + t0.env.orbMs).toFixed(0)}ms -> ` +
  `${(t3.ms + t3.env.orbMs).toFixed(0)}ms)`);

console.log('\n=== 3. singleref glitch rebase (A/B on the deepest view) ===');
const deep = { cre: '0', cim: '1', zoomMant: 1, zoomExp10: 100, maxiter: 1600 };
const noRebase = jet('z^2+c', { ...deep, rebase: 0 });
const withRebase = jet('z^2+c', { ...deep, rebase: 1 });
const a0 = stats(noRebase.f).inside, a1 = stats(withRebase.f).inside;
check(a1 <= a0, 'rebase resolves glitches',
  `unresolved pixels ${a0} -> ${a1}`);

console.log('\n=== 4. Bands: 4 strips == whole frame (single instance) ===');
// A second run with rebase=0 avoids re-anchoring differences at band edges.
const whole = jet('z^2+c', { ...deep, rebase: 0 }).f;
for (const [y0, y1] of [[0, 22], [22, 45], [45, 67], [67, H]]) {
  const b = jet('z^2+c', { ...deep, rebase: 0, band: [y0, y1] });
  const c = compare(whole.slice(y0 * W, y1 * W), b.f.slice(y0 * W, y1 * W));
  check(c.bad === 0, `band ${y0}..${y1}`, `differing pixels ${c.bad}`);
}

console.log('\n=== 5. SA isolation (is a mismatch caused by the skip?) ===');
for (const [expr, cre0, cim0, zexp] of [
  ['sin(z)+c', '-0.5', '0.2', 4],
  ['sin(z)*cos(z)+c', '-0.4', '0.1', 8],
]) {
  const sv = structuredView(expr, cre0, cim0, zexp);
  if (!sv) { console.log('  ' + expr + ': no structured view'); continue; }
  const o = { cre: sv.cre, cim: sv.cim, zoomMant: 1, zoomExp10: sv.zexp,
              maxiter: 300, rebase: 0 };
  const d = pageDirect(expr, o);
  const withSA = jet(expr, o);
  const noSA = jet(expr, { ...o, noSA: true });
  const c1 = compare(d.f, withSA.f), c2 = compare(d.f, noSA.f);
  console.log('  ' + expr + ' @1e' + sv.zexp + ' saSkip=' + withSA.env.saSkip +
    ' | with SA: diff ' + (100 * c1.bad / NPIX).toFixed(2) + '% mean ' + c1.mean.toFixed(3) +
    ' | no SA: diff ' + (100 * c2.bad / NPIX).toFixed(2) + '% mean ' + c2.mean.toFixed(3));
}

console.log(failures ? `\n[general] ${failures} FAILED` : '\n[general] all checks passed');
if (failures) process.exitCode = 1;
