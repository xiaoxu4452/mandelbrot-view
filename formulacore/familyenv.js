/* familyenv.js — arbitrary-precision reference LADDER for the five folded
 * built-in families (tricorn / burning ship / celtic / perpendicular / phoenix).
 *
 * Stage-2's generic jet cannot serve these maps: they are not holomorphic in z,
 * so jet.js only has a central-difference first derivative, and that derivative
 * is wrong exactly at a fold boundary.  Stage 3 replaces the derivative with an
 * EXACT real-coordinate perturbation (see core.cpp), which needs three things
 * from the high-precision orbit:
 *
 *   Z_n            the reference point (double truncation of the BigInt orbit)
 *   A_n = X^2-Y^2  the celtic fold argument, as an exact high-precision value
 *   B_n = 2XY      the burning-ship / perpendicular fold argument
 *
 * A and B must be formed from the BigInt fixed-point values, not by subtracting
 * two doubles: at a sign crossing A (or B) is O(delta) and a double subtraction
 * would wipe it out.  They are converted to double only AFTER the subtraction.
 *
 * A *ladder* of R orbits is built from centres spread over the frame.  A pixel
 * whose Z+d cancels can re-anchor at the same iteration index onto whichever
 * orbit is closest (the C++ kernel does the choosing).  All orbits are padded
 * to maxiter+1 steps so no band ever runs off the end of an orbit.
 *
 * Every orbit uses the SAME c scale: for Mandelbrot the candidate's c is
 * centre + offset, for Julia its z0 is centre + offset and c is the fixed Julia
 * seed.  The host therefore only has to recompute delta_c after a re-anchor.
 */
import { contextFor, PRECISION_TIERS } from '../js/bigfixed.js?v=62';

export const FAMILY_KIND = {
  tricorn: 1, burningship: 2, celtic: 3, perpendicular: 4, phoenix: 5,
};

/** state.span is m * 2^e (BINARY exponent); the core takes a decimal zoom. */
export function spanToZoom(span) {
  const log10z = Math.log10(3) - Math.log10(span.m) - span.e * Math.log10(2);
  const exp10 = Math.floor(log10z);
  return { zoomMant: Math.pow(10, log10z - exp10), zoomExp10: exp10 };
}

export function tierFor(log2ps, extra = 64) {
  const need = -log2ps + extra;
  return PRECISION_TIERS.find((t) => t >= need) ||
         PRECISION_TIERS[PRECISION_TIERS.length - 1];
}

/** k * dMant * 2^dExp2 as a decimal scientific string.  17 significant digits
 *  of the offset are plenty: the offset itself is O(pixel scale), so its
 *  absolute error stays ~1e-17 times smaller than a pixel. */
export function scaledDecimal(k, dMant, dExp2) {
  if (k === 0) return '0';
  const log10v = Math.log10(Math.abs(k)) + Math.log10(dMant) +
                 dExp2 * 0.3010299956639812;
  const e10 = Math.floor(log10v);
  const m10 = Math.pow(10, log10v - e10);
  return (k < 0 ? '-' : '') + m10.toPrecision(17) + 'e' + e10;
}

function candidateOffsets(width, height, count) {
  const sx = Math.max(1, width * 0.30), sy = Math.max(1, height * 0.30);
  const all = [
    [0, 0], [-sx, -sy], [sx, -sy], [-sx, sy], [sx, sy],
    [-sx, 0], [sx, 0], [0, -sy], [0, sy],
  ];
  return all.slice(0, Math.max(1, Math.min(count, all.length)));
}

/**
 * @param {object} o
 * @param {number} o.kind        1..5 (FAMILY_KIND)
 * @param {number} o.mode        0 = Mandelbrot, 1 = Julia
 * @param {string} o.centerRe/o.centerIm   high-precision decimal centre
 * @param {string} o.juliaRe/o.juliaIm     fixed Julia seed (mode 1)
 * @param {number} o.phoenixP
 * @param {number} o.maxiter
 * @param {number} o.zoomMant/o.zoomExp10
 * @param {number} o.width/o.height
 * @param {number} [o.ladders=4] number of reference orbits
 */
export function buildFamilyEnvironment({
  kind = 1, mode = 0, phoenixP = 0.5667,
  centerRe = '0', centerIm = '0', juliaRe = '0', juliaIm = '0',
  maxiter = 1600, zoomMant = 1, zoomExp10 = 0,
  width = 160, height = 120, ladders = 4,
}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const log2ps = Math.log2(3 / (zoomMant * width)) - zoomExp10 * Math.log2(10);
  const bits = tierFor(log2ps);
  const dExp2 = Math.floor(log2ps);
  const dMant = Math.pow(2, log2ps - dExp2);

  const ctx = contextFor(bits);
  const HALF = ctx.HALF, FB = ctx.FB;
  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> FB : -((-p + HALF) >> FB); };
  const sq = (a) => mul(a, a);
  const absB = (a) => a < 0n ? -a : a;
  const toN = (a) => ctx.toNumber(a);
  const bailSq = ctx.fromNumber(1e20);
  const pFP = ctx.fromNumber(Number(phoenixP) || 0.5667);

  const cr0 = ctx.fromString(String(centerRe));
  const ci0 = ctx.fromString(String(centerIm));
  const jr = mode === 1 ? ctx.fromString(String(juliaRe)) : cr0;
  const ji = mode === 1 ? ctx.fromString(String(juliaIm)) : ci0;

  const pts = candidateOffsets(width, height, ladders);
  const R = pts.length;
  const stride = maxiter + 1;
  const orbits = [];

  for (const [ox, oy] of pts) {
    const dr = ctx.fromString(scaledDecimal(ox, dMant, dExp2));
    const di = ctx.fromString(scaledDecimal(oy, dMant, dExp2));
    /* Mandelbrot: z0 = 0, c = centre + offset.
     * Julia:      z0 = centre + offset, c = the fixed Julia seed. */
    const cr = mode === 1 ? jr : cr0 + dr;
    const ci = mode === 1 ? ji : ci0 + di;
    let zr = mode === 1 ? cr0 + dr : 0n;
    let zi = mode === 1 ? ci0 + di : 0n;
    let pr = 0n, pi = 0n;                       // phoenix z_{n-1}

    const zre = new Float64Array(stride);
    const zim = new Float64Array(stride);
    const fa = new Float64Array(stride);
    const fb = new Float64Array(stride);
    let trueLen = stride;

    for (let n = 0; n <= maxiter; ++n) {
      const ar = sq(zr), bi = sq(zi), xy = mul(zr, zi);
      const A = ar - bi;                        // exact fixed-point difference
      const B = xy << 1n;                      // 2XY, exact
      zre[n] = toN(zr); zim[n] = toN(zi);
      fa[n] = toN(A);   fb[n] = toN(B);

      if (ar + bi > bailSq && n < maxiter) { trueLen = n + 1; break; }
      if (n === maxiter) break;

      let nr = 0n, ni = 0n;
      if (kind === 1) {                        // tricorn: conj(z)^2 + c
        nr = A; ni = -(xy << 1n);
      } else if (kind === 2) {                // burning ship: (|x|+i|y|)^2 + c
        const ax = absB(zr), ay = absB(zi);
        nr = A; ni = mul(ax, ay) << 1n;
      } else if (kind === 3) {                // celtic: |x^2-y^2| + i 2xy + c
        nr = absB(A); ni = xy << 1n;
      } else if (kind === 4) {                // perpendicular: x^2-y^2 + i|2xy| + c
        nr = A; ni = absB(xy) << 1n;
      } else {                                // phoenix: z^2 + c + p z_{n-1}
        nr = A + mul(pFP, pr); ni = (xy << 1n) + mul(pFP, pi);
        pr = zr; pi = zi;
      }
      zr = nr + cr;
      zi = ni + ci;
    }

    /* Pad the tail with the last real orbit value.  Once the reference itself
     * has escaped, every pixel (whose delta is still tiny) escapes at that
     * same step, so no pixel ever needs a later Z_n. */
    if (trueLen < stride) {
      const n0 = trueLen - 1;
      for (let n = trueLen; n < stride; ++n) {
        zre[n] = zre[n0]; zim[n] = zim[n0];
        fa[n] = fa[n0];   fb[n] = fb[n0];
      }
    }
    orbits.push({ ox, oy, zre, zim, fa, fb, trueLen });
  }

  /* The longest-lived orbit drives the frame.  Ties keep the centre first. */
  orbits.sort((a, b) => b.trueLen - a.trueLen);

  const zr = new Float64Array(R * stride);
  const zi = new Float64Array(R * stride);
  const foldA = new Float64Array(R * stride);
  const foldB = new Float64Array(R * stride);
  const offX = new Float64Array(R), offY = new Float64Array(R);
  const lengths = new Int32Array(R);
  orbits.forEach((o, k) => {
    zr.set(o.zre, k * stride); zi.set(o.zim, k * stride);
    foldA.set(o.fa, k * stride); foldB.set(o.fb, k * stride);
    offX[k] = o.ox; offY[k] = o.oy; lengths[k] = o.trueLen;
  });

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    kind, mode, R, stride, zr, zi, foldA, foldB, offX, offY, lengths,
    dMant, dExp2, bits, phoenixP,
    primaryLen: lengths[0],
    /* Iron law #1: the reference must outlive every pixel.  A short primary
     * orbit at depth cannot be trusted, so the host falls back instead of
     * painting a black frame. */
    refOK: lengths[0] >= maxiter * 0.9,
    orbMs: t1 - t0,
  };
}
