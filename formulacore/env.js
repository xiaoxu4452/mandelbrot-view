/* env.mjs — bridge between the page's high-precision formula environment and
 * the C++ perturbation renderer.
 *
 * js/customenv.js already does the two expensive things ONCE per frame:
 *   1. iterate ONE reference orbit with hpeval.js BigInt fixed-point
 *      arbitrary-precision arithmetic (any expression, any depth);
 *   2. derive the jet / Taylor coefficients along that orbit with jet.js
 *      automatic differentiation (holomorphic maps) or a central-difference
 *      linear derivative (non-holomorphic maps such as abs / conj).
 *
 * This module reshapes those coefficients into the layout fc_render_jet()
 * consumes (coefA = a_1..a_K, coefB = b_0..b_K), integrates the linear
 * series-approximation coefficient s_1, and returns everything as typed
 * arrays ready to be copied into wasm memory.
 *
 * The key identity that makes SA general (not just z^2+c):
 *     delta_{n+1} = a_1(n) delta_n + b_0(n) delta_c + O(delta^2)
 *     delta_n     = s_1(n) delta_c
 *  => s_1(n+1)   = a_1(n) s_1(n) + b_0(n),   s_1(0) = 0
 * While |delta| is tiny the quadratic term is negligible, so a frame-wide
 * skip is valid for sin/exp/log/pow/... as well.  Higher s_k overflow a
 * double long before the useful skip is reached, which is why the desktop
 * core's radtest collapses to this linear rule here.
 */

import { buildCustomEnvironment } from '../js/customenv.js?v=62';
import { PRECISION_TIERS } from '../js/bigfixed.js?v=62';
import { compile as compilePage } from '../js/mathlib.js?v=62';

const JET_MAX = 10;

/* jet.js keeps the delta_c direction to FIRST order only.  A map such as
 * z^2*c^2+c therefore has an O(delta_c^2) error that no jet order removes;
 * it must take the shallow/direct branch.  `polynomialDegree()` only counts
 * powers of z, so check the c side separately on the page's AST. */
function cIsLinear(expr) {
  let count = 0, nonlinear = false;
  const walk = (node, inNonlinear) => {
    if (!node || typeof node !== 'object') return;
    if (node.k === 'var' && node.name === 'c') {
      ++count;
      if (inNonlinear) nonlinear = true;
      return;
    }
    const bad = inNonlinear || node.k === 'call' || node.k === 'pow' ||
                (node.k === 'bin' && (node.op === '*' || node.op === '/' || node.op === '^'));
    for (const key of ['a', 'b', 'x', 'args', 'body', 'from', 'to', 'cond', 'then', 'else']) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((x) => walk(x, bad));
      else if (v && typeof v === 'object') walk(v, bad);
    }
  };
  try { walk(compilePage(expr).ast, false); } catch { return false; }
  return count <= 1 && !nonlinear;
}



function tierFor(log2ps, extra = 64) {
  const need = -log2ps + extra;
  return PRECISION_TIERS.find((t) => t >= need) ||
         PRECISION_TIERS[PRECISION_TIERS.length - 1];
}

/**
 * @param {object} o
 * @param {string} o.expr          iteration map, e.g. 'sin(z)+c'
 * @param {string} o.centerRe      high-precision decimal c (Mandelbrot mode)
 * @param {string} o.centerIm
 * @param {number} o.maxiter
 * @param {number} o.zoomMant      zoom = zoomMant * 10^zoomExp10
 * @param {number} o.zoomExp10
 * @param {number} o.width         frame width in pixels (pixel scale = 3/zoom/w)
 * @param {object} [o.customParams]
 * @returns {{zr:Float64Array, zi:Float64Array, coefA:Float64Array,
 *           coefB:Float64Array, jetOrder:number, stride:number,
 *           saAt:Float64Array, saSkip:number, dMant:number, dExp2:number,
 *           orbitLen:number, bits:number, holomorphic:boolean,
 *           degree:number|null, orbMs:number}}
 */
export function buildFormulaEnvironment({
  expr,
  centerRe = '0', centerIm = '0',
  maxiter = 1600,
  zoomMant = 1, zoomExp10 = 0,
  width = 160,
  customParams = {},
}) {
  const log2ps = Math.log2(3 / (zoomMant * width)) - zoomExp10 * Math.log2(10);
  const decades = Math.log10(zoomMant) + zoomExp10;
  const bits = tierFor(log2ps);

  const env = buildCustomEnvironment(
    { customExpr: expr, customParams },
    { re: String(centerRe), im: String(centerIm) },
    bits, maxiter,
  );

  if (!env.deriv) throw new Error('no jet coefficients for: ' + expr);

  /* Effective sample count.  customenv fills re/im up to len (inclusive). */
  const orbitLen = Math.min(maxiter + 1, env.len + 1);
  const zr = env.re.slice(0, orbitLen);
  const zi = env.im.slice(0, orbitLen);

  const srcK = env.deriv.kind === 'jet' ? env.deriv.order : 1;
  const K = Math.max(1, Math.min(JET_MAX, srcK));
  const stride = (K + 1) * 2;
  const coefA = new Float64Array(orbitLen * stride);
  const coefB = new Float64Array(orbitLen * stride);

  if (env.deriv.kind === 'jet') {
    const W = env.deriv.width;               // 2 * srcK + 1
    const src = env.deriv.coef;              // [n][W][2]
    for (let n = 0; n < orbitLen; ++n) {
      const from = n * W * 2, to = n * stride;
      for (let k = 1; k <= K; ++k) {         // p_k  -> a_k
        const j = from + (k - 1) * 2;
        coefA[to + k * 2] = src[j];
        coefA[to + k * 2 + 1] = src[j + 1];
      }
      const q = from + srcK * 2;
      for (let k = 0; k <= K; ++k) {         // q_k  -> b_k
        const j = q + k * 2;
        coefB[to + k * 2] = src[j];
        coefB[to + k * 2 + 1] = src[j + 1];
      }
    }
  } else {
    /* Non-holomorphic: only a linear perturbation is well defined.  The
     * central-difference derivative gives exactly a_1 and b_0. */
    const src = env.deriv.coef;              // [n][Ar,Ai,Br,Bi]
    for (let n = 0; n < orbitLen; ++n) {
      const from = n * 4, to = n * stride;
      coefA[to + 2] = src[from];
      coefA[to + 3] = src[from + 1];
      coefB[to] = src[from + 2];
      coefB[to + 1] = src[from + 3];
    }
  }

  /* Frame-wide linear SA.  s_1 is a complex number; no high-order coefficient
   * is needed, so this cannot overflow even for exp/sinh maps. */
  const s1 = new Float64Array((orbitLen + 1) * 2);   // s_1(n)
  const log10dmax = Math.log10(3) - Math.log10(zoomMant) - zoomExp10;
  let saSkip = 0;
  let sr = 0, si = 0;                                  // s_1(0) = 0
  for (let n = 0; n < orbitLen; ++n) {
    s1[n * 2] = sr; s1[n * 2 + 1] = si;
    if (n > 0) {
      const a = Math.hypot(sr, si);
      if (!(a > 0) || !Number.isFinite(a) ||
          Math.log10(a) + log10dmax > -3) break;
      saSkip = n;                                     // delta_n is still tiny
    }
    const to = n * stride;
    const ar = coefA[to + 2], ai = coefA[to + 3];     // a_1(n)
    const br = coefB[to], bi = coefB[to + 1];         // b_0(n)
    const nr = ar * sr - ai * si + br;
    const ni = ar * si + ai * sr + bi;
    sr = nr; si = ni;                                 // s_1(n+1)
  }
  const saAt = new Float64Array(stride);
  saAt[2] = s1[saSkip * 2];
  saAt[3] = s1[saSkip * 2 + 1];

  const dExp2 = Math.floor(log2ps);
  const dMant = Math.pow(2, log2ps - dExp2);

  return {
    zr, zi, coefA, coefB, jetOrder: K, stride,
    saAt, saSkip, dMant, dExp2,
    orbitLen, bits,
    /* Contract for the host: a reference that dies before the frame's maximum
     * escape iteration cannot drive perturbation -- there is no Z_n left for
     * the remaining pixels.  The desktop core solves this with a reference
     * ladder / multiple candidates; here the host must either pick a centre
     * whose orbit survives maxiter or fall back to direct double rendering. */
    escaped: env.escaped, refLen: env.len,
    /* A host MUST NOT paint a perturbed frame when this is false.
     *
     * Two independent reasons, both from the desktop core's rulebook:
     *  - a reference that dies before the frame's maximum escape iteration
     *    leaves no Z_n for the remaining pixels (iron law #1);
     *  - a truncated Taylor series is exact for polynomials but not for
     *    entire functions once |delta| is O(1), so shallow / medium views
     *    must render directly in double precision.  The desktop core does
     *    exactly that below ~1e8.  Both kinds of view have short orbits,
     *    so the direct renderer is also the fast one there. */
    /* Polynomials have a FINITE Taylor series, so the jet is exact at any
     * delta and perturbation is valid at any zoom.  Transcendental maps need
     * |delta| to stay far below 1 for the whole orbit, which only holds deep
     * enough (>= 1e12 here, conservatively) and with a surviving reference. */
    usable: (!env.escaped || env.len >= maxiter * 0.9) &&
            ((env.degree != null && env.degree <= K && cIsLinear(expr)) ||
             decades >= 12),
    /* `usable` says the jet frame would be CORRECT.  `useJet` says it is also
     * the FAST choice: at shallow zoom a direct double render is both exact
     * and far cheaper than advancing a tiny delta for hundreds of iterations.
     * This is the desktop core's own shallow-view rule. */
    useJet: (!env.escaped || env.len >= maxiter * 0.9) &&
            ((env.degree != null && env.degree <= K && cIsLinear(expr))
              ? decades >= 8 : decades >= 12),
    refOK: !env.escaped || env.len >= maxiter * 0.9,
    polyExact: env.degree != null && env.degree <= K && cIsLinear(expr),
    deepEnough: decades >= 12,
    holomorphic: env.holomorphic, degree: env.degree,
    orbMs: env.ms,
  };
}
