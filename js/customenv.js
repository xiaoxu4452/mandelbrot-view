/* ------------------------------------------------------------------
 * customenv.js — the "high-precision environment" for custom formulas
 *
 *  1. Iterate the reference orbit at arbitrary precision with the BigInt fixed-point evaluator (hpeval.js);
 *  2. In double precision, follow the reference orbit to obtain ∂F/∂z, ∂F/∂c, ∂²F/∂z², ∂²F/∂z∂c, ∂²F/∂c²;
 *  3. Each pixel then needs only a second-order Taylor perturbation in double precision:
 *
 *       ε' = A ε + B δ + ½C ε² + D εδ + ½E δ²
 *
 *     For z² + c this is the standard perturbation recurrence (A=2Z, B=1, C=2, D=E=0).
 *     — so any custom formula can zoom deep while every pixel stays double precision.
 * ----------------------------------------------------------------*/

import { contextFor } from './bigfixed.js';
import { compileBig, makeBigContext } from './hpeval.js';
import { compile as compileDouble } from './mathlib.js';
import { compileJet, JET_ORDER } from './jet.js';

const BAIL2 = 1e20;

/** First-order derivatives (central differences): non-holomorphic formulas only allow a linear perturbation */
function linearDerivatives(fn, zr, zi, cr, ci, P, n, h) {
  const O = new Float64Array(2);
  const S = { zpr: 0, zpi: 0, cr: 0, ci: 0, on: 0 };
  const call = (az, ay, ac, ad) => { fn(az, ay, ac, ad, P, n, S, O); return [O[0], O[1]]; };
  const zp = call(zr + h, zi, cr, ci);
  const zm = call(zr - h, zi, cr, ci);
  const cp = call(zr, zi, cr + h, ci);
  const cm = call(zr, zi, cr - h, ci);
  const hh = 1 / (2 * h);
  return {
    Ar: (zp[0] - zm[0]) * hh, Ai: (zp[1] - zm[1]) * hh,
    Br: (cp[0] - cm[0]) * hh, Bi: (cp[1] - cm[1]) * hh
  };
}

/** Estimate the degree of a polynomial (returns null when not a polynomial) */
export function polynomialDegree(ast) {
  let bad = false;
  const NONPOLY = new Set(['sin', 'cos', 'tan', 'exp', 'log', 'ln', 'sqrt', 'sinh', 'cosh',
    'tanh', 'arg', 'pow']);
  const walk = (n) => {
    if (bad || !n) return 0;
    switch (n.k) {
      case 'num': return Number.isInteger(n.v) ? 1 : (Number.isFinite(n.v) ? 1 : 1);
      case 'var': return n.name === 'z' ? 1 : 0;
      case 'bin': {
        const a = walk(n.a), b = walk(n.b);
        if (n.op === '*') return a + b;
        if (n.op === '/') { if (b > 0) bad = true; return Math.max(1, a); }
        return Math.max(a, b);
      }
      case 'pow': {
        const a = walk(n.a);
        if (n.b.k === 'num' && Number.isInteger(n.b.v) && n.b.v >= 0) return a * n.b.v;
        bad = true; return 0;
      }
      case 'call': {
        if (NONPOLY.has(n.name)) { bad = true; return 0; }
        n.args.forEach(walk);
        return 0;
      }
      case 'sum': case 'prod': { walk(n.body); return 4; }
      case 'piecewise': { n.args.forEach(walk); return 4; }
      default: return 0;
    }
  };
  const d = walk(ast);
  return bad ? null : Math.max(1, d);
}

/** Whether the formula is holomorphic (no non-analytic operations such as conj / abs / arg / re / im) */
export function isHolomorphic(ast) {
  let ok = true;
  const NON = new Set(['conj', 'abs', 'abs2', 'norm', 'arg', 're', 'im', 'cabs']);
  const walk = (n) => {
    if (!ok || !n) return;
    if (n.k === 'call' && NON.has(n.name)) { ok = false; return; }
    for (const key of ['a', 'b', 'from', 'to', 'body']) if (n[key]) walk(n[key]);
    if (n.args) n.args.forEach(walk);
  };
  walk(ast);
  return ok;
}

/**
 * Build the custom-formula environment
 * @param {object} spec { customExpr, customParams }
 * @param {{re:string, im:string}} center
 * @param {number} bits
 * @param {number} maxIter
 * @returns {{re:Float64Array, im:Float64Array, len:number, escaped:boolean, deriv:object|null, ms:number}}
 */
export function buildCustomEnvironment(spec, center, bits, maxIter) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const src = String(spec.customExpr || '').trim();
  if (!src) throw new Error('custom formula is empty');

  const dbl = compileDouble(src);
  const K = makeBigContext(bits);
  const ctx = K.ctx;
  const evalBig = compileBig(dbl.ast, { bits, ctx: K, params: dbl.params });

  const cp = spec.customParams || {};
  const Pbig = dbl.params.map((name) => {
    const v = Number(cp[name]);
    return [ctx.fromNumber(Number.isFinite(v) ? v : 0), 0n];
  });
  const Pdbl = new Float64Array(16);
  dbl.params.forEach((name, i) => {
    const v = Number(cp[name]);
    Pdbl[i] = Number.isFinite(v) ? v : 0;
  });

  const re = new Float64Array(maxIter + 1);
  const im = new Float64Array(maxIter + 1);
  const bail = ctx.fromNumber(BAIL2);

  const st = {
    z: [0n, 0n],
    c: [ctx.fromString(center.re), ctx.fromString(center.im)],
    n: 0, zp: [0n, 0n], P: Pbig, loopVal: 0n
  };

  let len = maxIter, escaped = false;
  for (let n = 0; n <= maxIter; n++) {
    const zr = st.z[0], zi = st.z[1];
    re[n] = ctx.toNumber(zr);
    im[n] = ctx.toNumber(zi);

    const m2 = K.cAbs2(st.z);
    if (m2 > bail) { len = n; escaped = true; break; }
    if (n === maxIter) break;

    st.n = n;
    st.zp = [zr, zi];
    const next = evalBig(st);
    if (!Number.isFinite(ctx.toNumber(next[0])) || !Number.isFinite(ctx.toNumber(next[1]))) {
      len = n; escaped = true; break;
    }
    st.z = next;
  }

  // Series coefficients (one set per reference point)
  let deriv = null;
  const holy = isHolomorphic(dbl.ast);
  const deg = polynomialDegree(dbl.ast);
  if (holy) {
    const K = deg != null ? Math.min(10, Math.max(4, deg)) : JET_ORDER;
    const N = Math.min(len, maxIter);
    const W = 2 * K + 1;                    // p1..pK + q0..qK
    const coef = new Float64Array((N + 1) * W * 2);
    try {
      const { fn: jetFn } = compileJet(dbl.ast, { order: K, params: dbl.params });
      const c0r = parseFloat(center.re), c0i = parseFloat(center.im);
      const Pj = Array.from(Pdbl);
      for (let n = 0; n <= N; n++) {
        const j = jetFn({
          zr: re[n], zi: im[n], cr: c0r, ci: c0i,
          n, zpr: n > 0 ? re[n - 1] : 0, zpi: n > 0 ? im[n - 1] : 0,
          P: Pj, loopVal: 0
        });
        const base = n * W * 2;
        for (let k = 1; k <= K; k++) {
          coef[base + (k - 1) * 2] = j.r[k];
          coef[base + (k - 1) * 2 + 1] = j.i[k];
        }
        for (let k = 0; k <= K; k++) {
          const off = base + K * 2 + k * 2;
          coef[off] = j.dr[k];
          coef[off + 1] = j.di[k];
        }
      }
      deriv = { kind: 'jet', order: K, coef, width: W, exact: deg != null && deg <= K };
    } catch {
      deriv = null;
    }
  }
  if (!deriv) {
    // Non-holomorphic (abs / conj …): only a linear perturbation is possible, so precision is capped by ε²
    try {
      const N = Math.min(len, maxIter);
      const coef = new Float64Array((N + 1) * 4);
      const c0r = parseFloat(center.re), c0i = parseFloat(center.im);
      for (let n = 0; n <= N; n++) {
        const d = linearDerivatives(dbl.fn, re[n], im[n], c0r, c0i, Pdbl, n, 1e-3);
        coef[n * 4] = d.Ar; coef[n * 4 + 1] = d.Ai;
        coef[n * 4 + 2] = d.Br; coef[n * 4 + 3] = d.Bi;
      }
      deriv = { kind: 'linear', coef, width: 2 };
    } catch {
      deriv = null;
    }
  }

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    re, im, len: Math.min(len, maxIter), escaped, deriv, params: Pdbl, ms: t1 - t0,
    holomorphic: holy, degree: deg,
    // Polynomials: the series stays exact at any depth; everything else is only reliable at shallow-to-moderate depth
    perturbMaxDepth: (deg != null && deg <= (deriv ? deriv.order : 6)) ? 1e1000 : 1e-12
  };
}
