/* orbit.mjs — ONE arbitrary-precision reference orbit for the formula core.
 *
 * The webcore (Mandelbrot) core builds its orbit inside C++ with BigFloat.
 * Here the iteration map is an arbitrary expression, so the orbit is built in
 * JS with the project's BigInt fixed-point arithmetic (the same representation
 * bigfixed.js / hpeval.js use).  That is the ONLY place arbitrary precision is
 * needed: one orbit, at most `maxiter` steps, independent of the pixel count.
 *
 * Stage 2 part 1 supports z^d + c (integer d), which is enough to prove the
 * architecture and to cross-check against the desktop core's z^2+c.  The jet
 * coefficients are exact for a polynomial:
 *      F(Z + eps, C + eta) = (Z + eps)^d + C + eta
 *      a_k = C(d,k) Z^(d-k),   b_0 = 1,   b_{k>0} = 0
 * For Julia sets c is fixed, so b_0 = 0 (eta is identically zero).
 */

/** Parse a decimal string (possibly scientific) into a fixed-point BigInt
 *  with `D` fractional digits.  No Number is involved anywhere. */
export function parseFixed(text, D) {
  const m = String(text).trim().match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || !(m[2] || m[3])) throw new Error('bad decimal: ' + text);
  const frac = m[3] || '';
  const shift = D + (m[4] ? Number(m[4]) : 0) - frac.length;
  let v = BigInt((m[2] || '0') + frac || '0');
  if (shift >= 0) v *= 10n ** BigInt(shift);
  else v /= 10n ** BigInt(-shift);
  return m[1] === '-' ? -v : v;
}

/** Fixed-point -> double, keeping ~16 significant digits. */
function toDouble(v, D) {
  const shift = Math.max(0, D - 16);
  if (shift === 0) return Number(v) / Math.pow(10, D);
  const q = v / (10n ** BigInt(shift));
  return Number(q) * Math.pow(10, -(D - shift));
}

const mul = (a, b, S) => ({
  re: (a.re * b.re - a.im * b.im) / S,
  im: (a.re * b.im + a.im * b.re) / S,
});
const add = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });

function powC(z, d, S) {
  let out = { re: S, im: 0n };
  for (let k = 0; k < d; ++k) out = mul(out, z, S);
  return out;
}

function cpowD(z, k) {
  let o = { re: 1, im: 0 };
  for (let i = 0; i < k; ++i) {
    const r = o.re * z.re - o.im * z.im;
    o = { re: r, im: o.re * z.im + o.im * z.re };
  }
  return o;
}
function binomial(n, k) {
  let v = 1;
  for (let i = 1; i <= k; ++i) v = v * (n - i + 1) / i;
  return v;
}

/**
 * Build the orbit and the jet coefficients.
 * Returns typed arrays ready to be copied into the wasm instance's memory.
 */
export function buildOrbit({
  centerRe, centerIm,
  juliaRe = '0', juliaIm = '0',
  mode = 'm', power = 2,
  maxiter = 2000,
  zoomMant = 1, zoomExp10 = 0,
  width = 160,
  jetOrder = 4,
}) {
  const decades = Math.log10(zoomMant) + zoomExp10;
  const D = Math.max(80, Math.ceil(decades) + 60);
  const S = 10n ** BigInt(D);
  const isJulia = mode === 'j';
  const P = (s) => parseFixed(s, D);

  // M: c is the view centre, z0 = 0.  Julia: z0 is the view centre, c is fixed.
  const c = isJulia ? { re: P(juliaRe), im: P(juliaIm) }
                    : { re: P(centerRe), im: P(centerIm) };
  let z = isJulia ? { re: P(centerRe), im: P(centerIm) } : { re: 0n, im: 0n };

  const zr = new Float64Array(maxiter);
  const zi = new Float64Array(maxiter);
  const stride = (jetOrder + 1) * 2;
  const coefA = new Float64Array(maxiter * stride);
  const coefB = new Float64Array(maxiter * stride);
  /* Series approximation: delta_n = sum_k s_k(n) delta_c^k.  The s_k depend
   * only on the reference orbit, so they are integrated ONCE here, not per
   * pixel.  Without the skip a 10^-300 offset needs ~690 iterations just to
   * grow to O(1) (measured 11.7 s per frame); with it the frame starts where
   * the offset is already visible and costs the same at any depth. */
  const saCoef = new Float64Array(maxiter * stride);
  const HUGE = 10n ** BigInt(D + 100);
  let escaped = false;

  for (let n = 0; n < maxiter; ++n) {
    const Z = { re: toDouble(z.re, D), im: toDouble(z.im, D) };
    zr[n] = Z.re;
    zi[n] = Z.im;

    const off = n * stride;
    for (let k = 1; k <= Math.min(jetOrder, power); ++k) {
      const p = cpowD(Z, power - k);
      const b = binomial(power, k);
      coefA[off + k * 2] = b * p.re;
      coefA[off + k * 2 + 1] = b * p.im;
    }
    if (!isJulia) coefB[off] = 1;   // dF/dc

    if (!isJulia) {
      /* s_k(n+1) = 2 Z_n s_k(n) + [k=1] + sum_{j=1}^{k-1} s_j(n) s_{k-j}(n)
       * for z^2 + c.  s(0) = 0 because every pixel starts at z0 = 0. */
      const get = (k) => ({ re: saCoef[off + k * 2], im: saCoef[off + k * 2 + 1] });
      const cur = [];
      for (let k = 0; k <= jetOrder; ++k) cur.push(get(k));
      const next = new Array(jetOrder + 1).fill(null).map(() => ({ re: 0, im: 0 }));
      const twoZ = { re: 2 * Z.re, im: 2 * Z.im };
      for (let k = 1; k <= jetOrder; ++k) {
        const lin = {
          re: twoZ.re * cur[k].re - twoZ.im * cur[k].im,
          im: twoZ.re * cur[k].im + twoZ.im * cur[k].re,
        };
        let cr = lin.re + (k === 1 ? 1 : 0), ci = lin.im;
        for (let j = 1; j < k; ++j) {
          const a = cur[j], b = cur[k - j];
          cr += a.re * b.re - a.im * b.im;
          ci += a.re * b.im + a.im * b.re;
        }
        next[k] = { re: cr, im: ci };
      }
      const no = (n + 1) * stride;
      if (no + stride <= saCoef.length) {
        for (let k = 1; k <= jetOrder; ++k) {
          saCoef[no + k * 2] = next[k].re;
          saCoef[no + k * 2 + 1] = next[k].im;
        }
      }
    }

    if (!escaped) {
      z = add(powC(z, power, S), c);
      // Stop before the squaring overflows the fixed-point word, then fill
      // the rest of the orbit with a huge value so every pixel escapes there.
      const lim = 10n ** BigInt(D + 20);
      if (z.re > lim || z.re < -lim || z.im > lim || z.im < -lim) {
        escaped = true;
        z = { re: HUGE, im: 0n };
      }
    }
  }

  // Pixel plane offset = (x - w/2) * 3 / (zoom * w), split into a double
  // mantissa and a binary exponent so 10^-600 never underflows.
  const psLog2 = Math.log2(3 / (zoomMant * width)) - zoomExp10 * Math.log2(10);
  const dExp2 = Math.floor(psLog2);
  const dMant = Math.pow(2, psLog2 - dExp2);

  /* One frame-wide skip, chosen from the largest offset in the frame:
   *   |s_1| dmax < 0.25                      (delta still small)
   *   |s_k| dmax^k < 1e-6 |s_1| dmax        (truncation is negligible)
   * This is the desktop core's radtest rule in log space. */
  const log10dmax = Math.log10(3) - Math.log10(zoomMant) - zoomExp10;
  let saSkip = 0;
  if (!isJulia) {
    for (let n = 1; n < maxiter; ++n) {
      const off = n * stride;
      const a1 = Math.hypot(saCoef[off + 2], saCoef[off + 3]);
      if (!(a1 > 0) || !Number.isFinite(a1)) break;
      /* Linear SA only.  While |delta| << |Z| the delta^2 term of
       * delta' = 2 Z delta + delta^2 + delta_c is negligible, so one term is
       * exact.  Higher s_k overflow a double long before the useful skip is
       * reached (they grow like |2Z|^(k*n)); keeping them in the test cut
       * 10^-300's skip from ~660 down to 207. */
      if (Math.log10(a1) + log10dmax > -3) break;
      saSkip = n;
    }
  }
  const saAt = new Float64Array(stride);
  saAt[2] = saCoef[saSkip * stride + 2];
  saAt[3] = saCoef[saSkip * stride + 3];

  return { zr, zi, coefA, coefB, orbitLen: maxiter, dMant, dExp2,
           digits: D, jetOrder, escaped, saSkip, saAt };
}
