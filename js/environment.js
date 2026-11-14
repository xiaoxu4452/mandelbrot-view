/* ------------------------------------------------------------------
 * environment.js — the reference-orbit "environment": series approximation
 *
 * Ported from the desktop core (B2..B10, 2026-11-14).
 *
 * Let Z_n be the high-precision reference orbit and delta the pixel offset:
 *     eps_n = A_n delta + B_n delta^2 + C_n delta^3 + ...
 *     A_{n+1} = 2 Z_n A_n + 1      (Mandelbrot; Julia has no +1)
 *     B_{n+1} = 2 Z_n B_n + A_n^2
 *     C_{n+1} = 2 Z_n C_n + 2 A_n B_n
 *
 * Desktop rule: the truncation term must be negligible RELATIVE TO THE
 * FIRST TERM, not relative to one pixel of displacement:
 *     log10|A_N| - log10|A_1| + (N-1)*log10(dmax) < -12
 * The series is CLOSED as soon as |Z_n| > 2: past the escape radius the
 * polynomial coefficients no longer describe a convergent expansion.
 * The coefficients depend only on the stored z_n, so they can be replayed
 * afterwards (sa_replay) instead of rebuilding the high-precision orbit.
 * ----------------------------------------------------------------*/

/* Kept for callers that still import it; the desktop criterion below is
 * the one actually used to accept a skip. */
export const SA_TOL = 0.01;
/* Truncation term must stay below 10^-12 of the linear term. */
export const SA_REL_LOG10 = -12;
/* |Z|^2 > 4 closes the series (desktop SaTracker::step). */
export const SA_CLOSED_R2 = 4;
/* Only a guard against skipping literally the whole orbit.  The old hard
 * 0.52 fraction truncated perfectly valid skips on deep views; the relative
 * criterion above is what really decides the limit. */
const SA_MAX_FRACTION = 0.9;
const SA_MIN_SKIP = 12;

/** Complex multiply (ar,ai)*(br,bi) */
function cmul(ar, ai, br, bi) {
  return [ar * br - ai * bi, ar * bi + ai * br];
}

/**
 * Replay the series coefficients over an ALREADY STORED orbit.
 * No high-precision iteration happens here (desktop sa_replay).
 * @param {{re:Float64Array, im:Float64Array, len:number}} orbit
 * @param {number} maxIter
 * @param {boolean} isJulia
 * @param {number} pixelUnit unused by the relative criterion, kept for ABI
 */
export function replaySeries(orbit, maxIter, isJulia, pixelUnit) {
  const len = Math.min(orbit.len, maxIter);
  if (len < SA_MIN_SKIP) return null;

  const Zr = orbit.re, Zi = orbit.im;
  const Ar = new Float64Array(len + 1), Ai = new Float64Array(len + 1);
  const Br = new Float64Array(len + 1), Bi = new Float64Array(len + 1);
  const Cr = new Float64Array(len + 1), Ci = new Float64Array(len + 1);
  const Rad = new Float64Array(len + 1);

  // Julia: eps_0 = delta (the initial z is the pixel itself); Mandelbrot: eps_0 = 0
  let ar = 0, ai = 0, br = 0, bi = 0, cr = 0, ci = 0;
  if (isJulia) ar = 1;

  let ok = 0;
  for (let n = 0; n <= len; n++) {
    Ar[n] = ar; Ai[n] = ai; Br[n] = br; Bi[n] = bi; Cr[n] = cr; Ci[n] = ci;

    const magA = Math.hypot(ar, ai);
    const magB = Math.hypot(br, bi);
    const magC = Math.hypot(cr, ci);
    let rad = Infinity;
    if (magA > 0 && Number.isFinite(magA) &&
        Number.isFinite(magB) && Number.isFinite(magC) && magA < 1e120) {
      /* log10|A_N| - log10|A_1| + (N-1) log10(dmax) < -12
       * => dmax < 10^((-12 - log10(|A_N|/|A_1|)) / (N-1)) */
      const logA = Math.log10(magA);
      const radiusFor = (magN, order) => {
        if (!(magN > 0) || !Number.isFinite(magN)) return Infinity;
        const e = (SA_REL_LOG10 - (Math.log10(magN) - logA)) / (order - 1);
        return e > 300 ? Infinity : Math.pow(10, e);
      };
      rad = Math.min(radiusFor(magB, 2), radiusFor(magC, 3));
      if (!(rad > 0) || !Number.isFinite(rad)) rad = 0;
    } else {
      rad = 0;
    }
    Rad[n] = rad;
    if (rad > 0) ok = n;
    if (n === len) break;

    /* Desktop SaTracker closes at |Z| > 2.  Coefficients integrated past the
     * escape point are not a convergent approximation, so no skip beyond
     * this step may be accepted. */
    const zrn = Zr[n], zin = Zi[n];
    if (zrn * zrn + zin * zin > SA_CLOSED_R2) {
      for (let k = n + 1; k <= len; k++) Rad[k] = 0;
      break;
    }

    // Advance to n+1
    const [tar, tai] = cmul(2 * zrn, 2 * zin, ar, ai);
    const [abr, abi] = cmul(ar, ai, ar, ai);
    const [abr2, abi2] = cmul(ar, ai, br, bi);
    const nar = tar + (isJulia ? 0 : 1);
    const nai = tai;
    const nbr = 2 * (zrn * br - zin * bi) + abr;
    const nbi = 2 * (zrn * bi + zin * br) + abi;
    const ncr = 2 * (zrn * cr - zin * ci) + 2 * abr2;
    const nci = 2 * (zrn * ci + zin * cr) + 2 * abi2;
    ar = nar; ai = nai; br = nbr; bi = nbi; cr = ncr; ci = nci;

    if (!Number.isFinite(ar) || !Number.isFinite(br) || !Number.isFinite(cr) ||
      Math.abs(ar) > 1e120 || Math.abs(br) > 1e120 || Math.abs(cr) > 1e120) {
      for (let k = n + 1; k <= len; k++) Rad[k] = 0;
      break;
    }
  }

  return { Ar, Ai, Br, Bi, Cr, Ci, Rad, len, last: ok };
}

/** Backwards-compatible name used by worker.js / render.js. */
export const buildSeries = replaySeries;

/**
 * Choose the number of skipped steps: the largest s whose validity radius
 * still covers the farthest corner of the view.
 * @param {object} series return value of replaySeries
 * @param {number} viewRadius distance from the reference to the farthest corner
 * @param {number} maxIter
 */
export function chooseSkip(series, viewRadius, maxIter) {
  if (!series || !(viewRadius > 0)) return null;
  const need = viewRadius;
  const limit = Math.min(series.len,
    Math.max(SA_MIN_SKIP, Math.floor(maxIter * SA_MAX_FRACTION)));
  let best = -1;
  for (let n = SA_MIN_SKIP; n <= limit; n++) {
    const r = series.Rad[n];
    if (r >= need) best = n;
    else if (best >= 0 && n > best + 64) break;   // radius has clearly shrunk
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
