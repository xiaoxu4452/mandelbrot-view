/* ------------------------------------------------------------------
 * environment.js — the reference-orbit "environment": series approximation + reuse decision
 *
 * Series approximation (SA)
 * -------------------------
 * Let the reference point be c0 with orbit Z_n; a pixel is c = c0 + δ (δ being dc).
 * Writing z_n = Z_n + ε_n, ε_n expands as a power series in δ:
 *
 *     ε_n ≈ A_n δ + B_n δ² + C_n δ³ + …
 *
 * For z -> z^p + c (p = 2):
 *     A_{n+1} = 2 Z_n A_n + 1,   A_0 = 0
 *     B_{n+1} = 2 Z_n B_n + A_n²,  B_0 = 0
 *     C_{n+1} = 2 Z_n C_n + 2 A_n B_n,  C_0 = 0
 *
 * So when iterating from step s, start directly with
 *     ε_s = A_s δ + B_s δ² + C_s δ³
 * as the initial perturbation, skipping the first s iterations (each of which costs a complex perturbation step).
 * The deeper the view, the more steps can be skipped — this is the main source of speed-up at depth.
 *
 * Validity: |δ| must stay below the "series validity radius" r_s. Take
 *     r_s = min( sqrt(tol·|A_s|/|B_s|), cbrt(tol·|A_s|/|C_s|) )
 * so that the quadratic and cubic terms stay below tol relative to the linear one.
 * ----------------------------------------------------------------*/

/* Truncation-error budget: allowed ratio of the quadratic/cubic terms to the displacement of one pixel */
export const SA_TOL = 0.01;
/* Upper bound on the fraction of maxIter that may be skipped */
const SA_MAX_FRACTION = 0.52;
const SA_MIN_SKIP = 12;

/** Complex multiply (ar,ai)*(br,bi) */
function cmul(ar, ai, br, bi) {
  return [ar * br - ai * bi, ar * bi + ai * br];
}

/**
 * Compute the series coefficients (double). Only the p = 2 polynomial family is handled; returns null otherwise.
 * @param {{re:Float64Array, im:Float64Array, len:number}} orbit
 * @param {number} maxIter
 * @param {boolean} isJulia
 * @param {number} pixelUnit length in the complex plane covered by one pixel
 */
export function buildSeries(orbit, maxIter, isJulia, pixelUnit) {
  const len = Math.min(orbit.len, maxIter);
  if (len < SA_MIN_SKIP) return null;

  const Zr = orbit.re, Zi = orbit.im;
  const Ar = new Float64Array(len + 1), Ai = new Float64Array(len + 1);
  const Br = new Float64Array(len + 1), Bi = new Float64Array(len + 1);
  const Cr = new Float64Array(len + 1), Ci = new Float64Array(len + 1);
  const Rad = new Float64Array(len + 1);

  // Julia: ε_0 = δ (the initial z is the pixel itself); Mandelbrot: ε_0 = 0
  let ar = 0, ai = 0, br = 0, bi = 0, cr = 0, ci = 0;
  if (isJulia) ar = 1;

  let ok = 0;
  for (let n = 0; n <= len; n++) {
    Ar[n] = ar; Ai[n] = ai; Br[n] = br; Bi[n] = bi; Cr[n] = cr; Ci[n] = ci;

    const magA = Math.hypot(ar, ai);
    const magB = Math.hypot(br, bi);
    const magC = Math.hypot(cr, ci);
    let rad = Infinity;
    if (magA > 1e-14 && Number.isFinite(magA) && magA < 1e100) {
      // The truncation error must stay below tol × "the displacement produced by one pixel"
      const budget = SA_TOL * magA * pixelUnit;
      if (magB > 0) rad = Math.min(rad, Math.sqrt(budget / magB));
      if (magC > 0) rad = Math.min(rad, Math.cbrt(budget / magC));
      if (!(rad > 0) || !Number.isFinite(magB) || !Number.isFinite(magC)) rad = 0;
    } else {
      rad = 0;
    }
    Rad[n] = rad;
    if (rad > 0) ok = n;
    if (n === len) break;

    // Advance to n+1
    const zr = Zr[n], zi = Zi[n];
    const [tar, tai] = cmul(2 * zr, 2 * zi, ar, ai);
    const [abr, abi] = cmul(ar, ai, ar, ai);
    const [abr2, abi2] = cmul(ar, ai, br, bi);
    const nar = tar + (isJulia ? 0 : 1);
    const nai = tai;
    const nbr = 2 * (zr * br - zi * bi) + abr;
    const nbi = 2 * (zr * bi + zi * br) + abi;
    const ncr = 2 * (zr * cr - zi * ci) + 2 * abr2;
    const nci = 2 * (zr * ci + zi * cr) + 2 * abi2;
    ar = nar; ai = nai; br = nbr; bi = nbi; cr = ncr; ci = nci;

    if (!Number.isFinite(ar) || !Number.isFinite(br) || !Number.isFinite(cr) ||
      Math.abs(ar) > 1e120 || Math.abs(br) > 1e120 || Math.abs(cr) > 1e120) {
      // Overflow/divergence: nothing past this point is usable
      for (let k = n + 1; k <= len; k++) Rad[k] = 0;
      break;
    }
  }

  return { Ar, Ai, Br, Bi, Cr, Ci, Rad, len, last: ok };
}

/**
 * Choose the number of skipped steps: the largest s with "validity radius ≥ margin × view radius".
 * @param {object} series return value of buildSeries
 * @param {number} viewRadius distance from the reference point to the farthest view corner (complex-plane units)
 * @param {number} maxIter
 */
export function chooseSkip(series, viewRadius, maxIter) {
  if (!series || !(viewRadius > 0)) return null;
  const need = viewRadius;
  const limit = Math.min(series.len, Math.floor(maxIter * SA_MAX_FRACTION));
  let best = -1;
  for (let n = SA_MIN_SKIP; n <= limit; n++) {
    const r = series.Rad[n];
    if (r >= need) best = n;
    else if (best >= 0 && n > best + 64) break;   // Radius has clearly shrunk; stop looking back
  }
  if (best < SA_MIN_SKIP) return null;
  return {
    skip: best,
    ar: series.Ar[best], ai: series.Ai[best],
    br: series.Br[best], bi: series.Bi[best],
    cr: series.Cr[best], ci: series.Ci[best],
    radius: series.Rad[best]
  };
}
