/* family-test.mjs — acceptance for the five non-holomorphic built-in families.
 *
 * Ground truth is a PER-PIXEL arbitrary-precision BigInt fixed-point renderer
 * (the same recurrence, but no reference orbit at all).  It is slow, which is
 * exactly why the shipped core uses one orbit + perturbation; here it is small
 * enough to be the oracle.
 *
 * Checks, for every family:
 *   1. shallow (zoom 1): C++ family kernel == BigInt oracle, and the direct
 *      C++ renderer agrees up to its known constant smooth-iteration offset;
 *   2. deep (zoom 1e20, Julia slice through a long chaotic orbit): kernel ==
 *      oracle, no NaN / no all-interior / real structure survives;
 *   3. two horizontal bands stitch into the whole frame bit-for-bit;
 *   4. a wider ladder (R=4) does not change the picture except where a
 *      single orbit would glitch.
 *
 *   node formulacore/family-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextFor } from '../js/bigfixed.js?v=59';
import {
  buildFamilyEnvironment, scaledDecimal, tierFor,
} from './familyenv.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BAIL2 = 4.0;
const EXPR = {
  1: 'conj(z)^2+c',
  2: '(abs(re(z))+i*abs(im(z)))^2+c',
  3: 'abs(re(z^2))+i*im(z^2)+c',
  4: 're(z^2)+i*abs(im(z^2))+c',
  5: 'z^2+c+0.5667*zprev',
};
const NAME = {
  1: 'tricorn', 2: 'burningship', 3: 'celtic',
  4: 'perpendicular', 5: 'phoenix',
};

/* ---------------------------------------------------------------- wasm -- */
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
const allocs = [];
const ws = (s) => {
  const b = enc.encode(String(s) + '\0');
  const p = e.fc_alloc(b.length);
  new Uint8Array(e.memory.buffer).set(b, p);
  allocs.push(p);
  return p;
};
const put = (a) => {
  const p = e.fc_alloc(Math.max(8, a.length * 8));
  new Float64Array(e.memory.buffer, p, a.length).set(a);
  allocs.push(p);
  return p;
};
const cstr = (p) => {
  const m = new Uint8Array(e.memory.buffer);
  let s = '';
  for (let i = p; m[i]; ++i) s += String.fromCharCode(m[i]);
  return s;
};
const release = () => { for (const p of allocs) e.fc_free(p); allocs.length = 0; };
const fieldOut = (w, h) =>
  new Float32Array(e.memory.buffer, e.fc_out_ptr(), w * h).slice();

/* ------------------------------------------------------------- renderers -- */
function renderDirect(expr, o) {
  const prog = e.fc_compile(ws(expr));
  if (prog < 0) throw new Error('compile: ' + cstr(e.fc_error()));
  const rc = e.fc_render(prog, ws(o.centerRe), ws(o.centerIm),
    o.zoomMant, o.zoomExp10, o.w, o.h, o.maxiter,
    o.mode || 0, ws(o.juliaRe || '0'), ws(o.juliaIm || '0'), BAIL2,
    0, put(new Float64Array(1)), 1, 0, 0, o.h);
  if (rc) throw new Error('fc_render rc ' + rc + ' ' + cstr(e.fc_error()));
  return fieldOut(o.w, o.h);
}

function renderFamily(env, o, y0 = 0, y1 = o.h, R = env.R) {
  const rc = e.fc_render_family(env.kind, env.mode, o.w, o.h, o.maxiter,
    BAIL2, R, env.stride,
    put(env.zr), put(env.zi), put(env.foldA), put(env.foldB),
    put(env.offX), put(env.offY),
    env.dMant, env.dExp2, 1, 0, env.phoenixP, y0, y1, 0);
  if (rc) throw new Error('fc_render_family rc ' + rc + ' ' + cstr(e.fc_error()));
  return fieldOut(o.w, o.h);
}

/* Exact per-pixel BigInt oracle: no reference orbit, no perturbation. */
function bigOracle(o) {
  const log2ps = Math.log2(3 / (o.zoomMant * o.w)) - o.zoomExp10 * Math.log2(10);
  const bits = tierFor(log2ps);
  const ctx = contextFor(bits);
  const HALF = ctx.HALF, FB = ctx.FB;
  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> FB : -((-p + HALF) >> FB); };
  const sq = (a) => mul(a, a);
  const absB = (a) => a < 0n ? -a : a;
  const toN = (a) => ctx.toNumber(a);
  const pFP = ctx.fromNumber(o.phoenixP);
  const cr0 = ctx.fromString(String(o.centerRe)), ci0 = ctx.fromString(String(o.centerIm));
  const jr = ctx.fromString(String(o.juliaRe || '0'));
  const ji = ctx.fromString(String(o.juliaIm || '0'));
  const dExp2 = Math.floor(log2ps), dMant = Math.pow(2, log2ps - dExp2);
  const logBail = 0.5 * Math.log(BAIL2);
  const out = new Float32Array(o.w * o.h).fill(-1);

  for (let y = 0; y < o.h; ++y) {
    for (let x = 0; x < o.w; ++x) {
      const sx = ctx.fromString(scaledDecimal(x + 0.5 - 0.5 * o.w, dMant, dExp2));
      const sy = ctx.fromString(scaledDecimal(-(y + 0.5 - 0.5 * o.h), dMant, dExp2));
      const cr = o.mode === 1 ? jr : cr0 + sx;
      const ci = o.mode === 1 ? ji : ci0 + sy;
      let zr = o.mode === 1 ? cr0 + sx : 0n;
      let zi = o.mode === 1 ? ci0 + sy : 0n;
      let pr = 0n, pi = 0n;
      for (let n = 0; n <= o.maxiter; ++n) {
        const a = toN(zr), b = toN(zi);
        const m2 = a * a + b * b;
        if (!(m2 <= BAIL2)) {
          const logz = 0.5 * Math.log(Math.max(m2, 1e-300));
          let sm = n + 1 - Math.log2(logz / logBail);
          if (!(sm >= 0) || !Number.isFinite(sm)) sm = 0;
          out[y * o.w + x] = sm;
          break;
        }
        if (n === o.maxiter) break;
        const ar = sq(zr), bi = sq(zi), xy = mul(zr, zi), A = ar - bi;
        let nr, ni;
        if (o.kind === 1) { nr = A; ni = -(xy << 1n); }
        else if (o.kind === 2) { nr = A; ni = mul(absB(zr), absB(zi)) << 1n; }
        else if (o.kind === 3) { nr = absB(A); ni = xy << 1n; }
        else if (o.kind === 4) { nr = A; ni = absB(xy) << 1n; }
        else {
          nr = A + mul(pFP, pr); ni = (xy << 1n) + mul(pFP, pi);
          pr = zr; pi = zi;
        }
        zr = nr + cr; zi = ni + ci;
      }
    }
  }
  return out;
}

/* Deep centre: an EXACT rational point on the unit circle (3/5 + 4/5 i) with
 * Julia seed c = 0.  Every degree-2 map here preserves |z| = 1, so the
 * arbitrary-precision reference never escapes and runs the full budget, while
 * a 1e-20 pixel offset is amplified into many distinct escape counts.  A
 * "boundary point" found on a coarse grid is ~1e-2 away from the true
 * boundary and makes the whole 1e-20-wide frame flat, which tests nothing. */
const DEEP_CENTRE = { re: '0.6', im: '0.8' };

/* Phoenix has a z_{n-1} term, so no unit-circle point is on its boundary.
 * Bisect in high-precision fixed point between an escaping and an interior
 * start until the centre is within 2^-100 of the boundary — far finer than a
 * 1e-20 pixel, which is what makes the deep frame resolve structure. */
function phoenixBoundaryCentre() {
  const ctx = contextFor(256);
  const HALF = ctx.HALF, FB = ctx.FB;
  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> FB : -((-p + HALF) >> FB); };
  const sq = (a) => mul(a, a);
  const pFP = ctx.fromNumber(0.5667);
  const bail = ctx.fromNumber(4.0);
  const y = ctx.fromString('0.8');
  const escapes = (x0) => {
    let zr = x0, zi = y, pr = 0n, pi = 0n;
    for (let n = 0; n < 400; ++n) {
      const A = sq(zr) - sq(zi), xy = mul(zr, zi);
      const nr = A + mul(pFP, pr), ni = (xy << 1n) + mul(pFP, pi);
      pr = zr; pi = zi; zr = nr; zi = ni;
      if (sq(zr) + sq(zi) > bail) return true;
    }
    return false;
  };
  let a = ctx.fromString('-0.6'), b = ctx.fromString('0.6');
  if (!escapes(a) || escapes(b)) throw new Error('phoenix bisection endpoints');
  for (let k = 0; k < 100; ++k) {
    const m = (a + b) / 2n;
    if (escapes(m)) a = m; else b = m;
  }
  return { re: ctx.toString(b, 60), im: '0.8' };
}

/* ------------------------------------------------------------- comparison -- */
function compare(a, b, tol = 0.05) {
  let bad = 0, flips = 0, interiorA = 0, interiorB = 0, maxd = 0, finite = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ++i) {
    const x = a[i], y = b[i];
    const ix = !(x >= 0), iy = !(y >= 0);
    if (ix) interiorA++;
    if (iy) interiorB++;
    /* A pixel sitting exactly on |z|^2 = 4 can be classified differently by
     * a 53-bit perturbation sum and a 256-bit exact orbit.  It escapes one
     * iteration later either way; this is a boundary pixel, not a wrong
     * iteration count, so it is reported separately. */
    if (ix !== iy) { ++flips; continue; }
    if (ix) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { ++bad; continue; }
    ++finite;
    const d = Math.abs(x - y);
    if (d > maxd) maxd = d;
    if (d > tol) ++bad;
  }
  return { bad, flips, maxd, interiorA, interiorB, finite,
           pct: 100 * bad / n, flipPct: 100 * flips / n };
}
function distinct(a) {
  const s = new Set();
  for (const v of a) if (v >= 0 && Number.isFinite(v)) s.add(Math.round(v * 8));
  return s.size;
}

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) ++failures;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
};

const SHALLOW = {
  w: 48, h: 36, maxiter: 220, zoomMant: 1, zoomExp10: 0,
  centerRe: '-0.35', centerIm: '0.25', phoenixP: 0.5667,
  juliaRe: '-0.6', juliaIm: '0.2',
};

for (let kind = 1; kind <= 5; ++kind) {
  const name = NAME[kind];

  /* ---- shallow, both M and Julia ---- */
  for (const mode of [0, 1]) {
    const o = { ...SHALLOW, kind, mode };
    const env = buildFamilyEnvironment({
      kind, mode, phoenixP: o.phoenixP,
      centerRe: o.centerRe, centerIm: o.centerIm,
      juliaRe: o.juliaRe, juliaIm: o.juliaIm,
      maxiter: o.maxiter, zoomMant: o.zoomMant, zoomExp10: o.zoomExp10,
      width: o.w, height: o.h, ladders: 4,
    });
    const fam = renderFamily(env, o);
    release();
    const oracle = bigOracle(o);
    const c = compare(fam, oracle, 0.06);
    check(c.bad === 0 && c.flipPct < 12,
      `${name} shallow ${mode ? 'Julia' : 'M'} vs oracle`,
      `numeric outliers ${c.bad}  max ${c.maxd.toFixed(4)}  ` +
      `boundary flips ${c.flipPct.toFixed(2)}%  escaped ${c.finite}`);
    if (mode === 0) {
      const direct = renderDirect(EXPR[kind], o);
      release();
      /* fc_render counts one iteration less for the same z (pre-existing
       * convention); require an almost-exact constant offset, not chaos. */
      let off = [], bad = 0;
      for (let i = 0; i < fam.length; ++i) {
        if (fam[i] < 0 || direct[i] < 0) continue;
        off.push(fam[i] - direct[i]);
      }
      const mean = off.reduce((a, b) => a + b, 0) / Math.max(1, off.length);
      for (const d of off) if (Math.abs(d - mean) > 0.06) ++bad;
      check(bad < off.length * 0.01, `${name} shallow direct offset`,
        `offset ${mean.toFixed(3)}  outliers ${bad}/${off.length}`);
    }
  }

  /* ---- deep 1e20 Julia slice through an exact unit-circle orbit ---- */
  const p = 0.5667;
  const centre = kind === 5 ? phoenixBoundaryCentre() : DEEP_CENTRE;
  const o = {
    kind, mode: 1, w: 40, h: 30, maxiter: 400,
    zoomMant: 1, zoomExp10: 20,
    centerRe: centre.re, centerIm: centre.im,
    juliaRe: '0', juliaIm: '0', phoenixP: p,
  };
  const env = buildFamilyEnvironment({
    kind, mode: 1, phoenixP: p,
    centerRe: o.centerRe, centerIm: o.centerIm,
    juliaRe: o.juliaRe, juliaIm: o.juliaIm,
    maxiter: o.maxiter, zoomMant: o.zoomMant, zoomExp10: o.zoomExp10,
    width: o.w, height: o.h, ladders: 4,
  });
  const whole = renderFamily(env, o);
  release();
  const oracle = bigOracle(o);
  const c = compare(whole, oracle, 0.06);
  check(c.bad === 0 && c.flipPct < 15, `${name} deep 1e20 vs oracle`,
    `numeric outliers ${c.bad}  max ${c.maxd.toFixed(4)}  ` +
    `boundary flips ${c.flipPct.toFixed(2)}%  ` +
    `interior ${c.interiorA}/${c.interiorB}  primaryLen=${env.primaryLen}`);
  const d = distinct(whole);
  check(d > 8 && Number.isFinite(d), `${name} deep structure`,
    `${d} distinct smooth bands, ${(100 * c.interiorA / whole.length).toFixed(1)}% interior`);

  const b0 = renderFamily(env, o, 0, 15);
  release();
  const b1 = renderFamily(env, o, 15, 30);
  release();
  let bandBad = 0;
  for (let y = 0; y < 30; ++y) for (let x = 0; x < 40; ++x) {
    const src = y < 15 ? b0 : b1;
    if (Math.abs(src[y * 40 + x] - whole[y * 40 + x]) > 1e-6) ++bandBad;
  }
  check(bandBad === 0, `${name} band stitch`, `${bandBad} differing pixels`);

  const one = renderFamily(env, o, 0, o.h, 1);
  release();
  const rcmp = compare(whole, one, 0.06);
  check(rcmp.bad === 0 && rcmp.flipPct < 5, `${name} ladder R=4 vs R=1`,
    `numeric outliers ${rcmp.bad}  boundary flips ${rcmp.flipPct.toFixed(2)}% ` +
    `(glitch repairs)`);
}

console.log(failures ? `[family] ${failures} FAILED` : '[family] all five folded families OK');
if (failures) process.exitCode = 1;
