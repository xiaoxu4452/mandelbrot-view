/* Double-double arithmetic (Knuth/Dekker, no FMA required).
 *
 * Used by the JavaScript solver fallback and by the precision test tools.
 * The WebAssembly kernel has its own SIMD copy of exactly these formulas.
 *
 * A value is carried as [hi, lo] with hi + lo representing it to ~106 bits;
 * that is enough to keep the perturbation recursion meaningful when the pixel
 * spacing is far below the 53-bit limit of a plain double.
 */

export const SPLIT = 134217729.0;  // 2^27 + 1

export const DD_ZERO = [0, 0];

export function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  const e = (a - (s - bb)) + (b - bb);
  return [s, e];
}

export function quickTwoSum(a, b) {
  const s = a + b;
  return [s, b - (s - a)];
}

export function ddAdd(a, b) {
  const s = a[0] + b[0];
  const bb = s - a[0];
  const e = (a[0] - (s - bb)) + (b[0] - bb) + a[1] + b[1];
  return quickTwoSum(s, e);
}

export function ddSub(a, b) {
  return ddAdd(a, [-b[0], -b[1]]);
}

export function ddMul(a, b) {
  const ah = a[0], al = a[1], bh = b[0], bl = b[1];
  const p = ah * bh;
  const ta = SPLIT * ah;
  const ahh = ta - (ta - ah);
  const all = ah - ahh;
  const tb = SPLIT * bh;
  const bhh = tb - (tb - bh);
  const bll = bh - bhh;
  // Dekker: p + e == ah*bh exactly.  The residual is (ah*bh - p), not
  // (ahh*bhh + (p - ahh*bhh)) — the latter collapses back to p and doubles
  // the product.
  let e = (ahh * bhh - p) + ahh * bll + all * bhh;
  e += all * bll;
  e += ah * bl + al * bh;
  return quickTwoSum(p, e);
}
