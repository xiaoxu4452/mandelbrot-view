/* ------------------------------------------------------------------
 * bigfixed.js — arbitrary-precision fixed-point arithmetic (BigInt implementation)
 *
 * Design: value = m / 2^F, where m is a BigInt and F = bits + GUARD fractional bits.
 * Precision tiers (mirroring the UI one-to-one):
 *    64  -> native IEEE-754 double (fastest)
 *   128  -> 2 limbs
 *   256  -> 4 limbs
 *   512  -> 8 limbs
 *  1024  -> 16 limbs (auto-upgraded as the zoom deepens)
 *
 * This module is shared by the main thread and the worker (ES module).
 * ----------------------------------------------------------------*/

const GUARD = 26;

/* ---------------- Basic helpers ---------------- */

function bitLength(a) {
  if (a === 0n) return 0;
  if (a < 0n) a = -a;
  const s = a.toString(16);
  const hi = parseInt(s[0], 16);
  const hiBits = hi.toString(2).length;
  return (s.length - 1) * 4 + hiBits;
}

/* Cache of 10^n */
const POW10 = [1n];
function pow10(n) {
  if (n < POW10.length) return POW10[n];
  let v = POW10[POW10.length - 1];
  for (let i = POW10.length; i <= n; i++) {
    v *= 10n;
    POW10[i] = v;
  }
  return POW10[n];
}

/* ---------------- Precision context ---------------- */

export class Fixed {
  /**
   * @param {number} bits effective width in bits (64/128/256/512/1024...)
   */
  constructor(bits) {
    this.bits = bits;
    this.F = bits + GUARD;          // number of fractional bits
    this.FB = BigInt(this.F);
    this.ONE = 1n << this.FB;       // 1.0
    this.HALF = this.ONE >> 1n;
    this.MASK = this.ONE - 1n;
    this.SCALE = Math.pow(2, -this.F);  // scale factor for toNumber
    this._eps = null;
  }

  /* ---- Construction ---- */

  zero() { return 0n; }

  fromNumber(x) {
    if (!isFinite(x)) throw new Error('Fixed.fromNumber: invalid value ' + x);
    if (x === 0) return 0n;
    const neg = x < 0;
    const a = Math.abs(x);
    // Normalise to m * 2^exp (m ∈ [1,2)), otherwise only ~32 significant bits survive
    let exp = Math.floor(Math.log2(a));
    let m = a / Math.pow(2, exp);
    if (m >= 2) { m /= 2; exp += 1; }
    else if (m < 1) { m *= 2; exp -= 1; }
    let mant = BigInt(Math.round(m * 4503599627370496)); // 53 bit
    let v = (mant << this.FB) >> 52n;
    v = exp >= 0 ? v << BigInt(exp) : v >> BigInt(-exp);
    return neg ? -v : v;
  }

  /** Decimal string -> fixed point (accepts "1.2e-30", "-0.7436") */
  fromString(str) {
    const s = String(str).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error('invalid coordinate format: ' + str);
    const [, sgn, ip, fp = '', ex] = m;
    if (!ip && !fp) return 0n;
    const digits = BigInt((ip || '0') + fp);
    const decExp = (ex ? parseInt(ex, 10) : 0) - fp.length;
    let v;
    if (decExp >= 0) {
      v = (digits * pow10(decExp) << this.FB);
    } else {
      const d = pow10(-decExp);
      v = ((digits << this.FB) + (d >> 1n)) / d;
    }
    return sgn === '-' ? -v : v;
  }

  /* ---- Basic arithmetic ---- */

  add(a, b) { return a + b; }
  sub(a, b) { return a - b; }
  neg(a) { return -a; }
  abs(a) { return a < 0n ? -a : a; }

  mul(a, b) {
    const p = a * b;
    // Round to nearest instead of truncating
    return p >= 0n ? (p + this.HALF) >> this.FB : -((-p + this.HALF) >> this.FB);
  }

  sq(a) { return this.mul(a, a); }

  div(a, b) {
    if (b === 0n) return a >= 0n ? this.MAXV() : -this.MAXV();
    const num = a << this.FB;
    const q = num / b;
    return q;
  }

  mulDouble(a, d) {
    return this.mul(a, this.fromNumber(d));
  }

  /** Multiply by 2^k (exact shift) */
  shl(a, k) {
    return k >= 0 ? a << BigInt(k) : a >> BigInt(-k);
  }

  cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  isZero(a) { return a === 0n; }

  MAXV() { return 1n << BigInt(this.bits + 8); }

  /* ---- Conversion ---- */

  /** Fixed point -> double (keep the top 53 bits so Number(BigInt) cannot overflow) */
  toNumber(a) {
    if (a === 0n) return 0;
    const neg = a < 0n;
    const v = neg ? -a : a;
    const L = bitLength(v);
    let n;
    if (L <= 62) {
      n = Number(v) * Math.pow(2, -this.F);
    } else {
      const shift = L - 62;
      const top = Number(v >> BigInt(shift));
      n = top * Math.pow(2, shift - this.F);
    }
    return neg ? -n : n;
  }

  /**
   * Fixed point -> double-double pair [hi, lo] (≈106 bits of significance).
   *
   * The plain toNumber() cast leaves 53 bits, which is below the pixel scale
   * once the zoom passes ~1e16; the perturbation recursion then mixes a 1e-16
   * absolute error into a 1e-20 perturbation and the image collapses.  Splitting
   * the value into a hi/lo pair keeps enough reference precision to feed the
   * double-double perturbation kernel.
   */
  toPair(a) {
    if (a === 0n) return [0, 0];
    const neg = a < 0n;
    const v = neg ? -a : a;
    const L = v.toString(2).length;
    const SH = Math.max(0, L - 53);
    const shb = BigInt(SH);
    const m = v >> shb;                       // exactly 53 significant bits
    const md = Number(m);                     // exact: integer below 2^53
    const hi = (neg ? -md : md) * Math.pow(2, SH - this.F);
    if (SH === 0) return [hi, 0];             // everything already in hi
    const rem = neg ? -(v - (m << shb)) : v - (m << shb);
    return [hi, rem === 0n ? 0 : this.toNumber(rem)];
  }

  /** Fixed point -> decimal string, digits being the number of fractional digits */
  toString(a, digits = 24) {
    const neg = a < 0n;
    const v = neg ? -a : a;
    const ip = v >> this.FB;
    const rem = v & this.MASK;
    const d = pow10(digits);
    const frac = ((rem * d + this.HALF) >> this.FB);
    let fs = frac.toString();
    while (fs.length < digits) fs = '0' + fs;
    // Strip trailing zeros
    fs = fs.replace(/0+$/, '');
    const out = fs ? ip.toString() + '.' + fs : ip.toString();
    return (neg && out !== '0' ? '-' : '') + out;
  }

  /** Generic scientific-notation display */
  toSci(a, sig = 12) {
    const s = this.toString(a, 40);
    return s;
  }
}

/* ---------------- Precision tiers and auto-selection ---------------- */

/* Mirrors mbc::hp tiers in the C++ core (mb_hp.h): 16384 bits is the desktop
 * ceiling, ~4930 decimal decades, so every preset can be zoomed past 1e300
 * without the reference orbit losing the pixel scale. */
export const PRECISION_TIERS = [256, 512, 1024, 2048, 4096, 8192, 16384];

const ctxCache = new Map();

/** Get (or create) the fixed-point context for a given precision */
export function contextFor(bits) {
  let c = ctxCache.get(bits);
  if (!c) {
    c = new Fixed(bits);
    ctxCache.set(bits, c);
  }
  return c;
}

/**
 * Infer the required width in bits from the pixel scale (pixel edge length in the complex plane).
 * Roughly -log2(pixelSize) significant bits are needed, plus an 8-bit safety margin.
 */
export function requiredBits(pixelSize) {
  if (!(pixelSize > 0)) return 64;
  const need = -Math.log2(pixelSize) + 8;
  if (need <= 53) return 64;
  for (let i = 1; i < PRECISION_TIERS.length; i++) {
    if (PRECISION_TIERS[i] >= need) return PRECISION_TIERS[i];
  }
  return PRECISION_TIERS[PRECISION_TIERS.length - 1];
}

/** Derive the width from the log2 of the pixel scale (supports scales such as 1e-1000 that a double cannot represent) */
export function requiredBitsFromLog2(log2ps) {
  /* `depth + 0x40`: initcanvas_hfloat (0044e970.c:97-149) sizes the number
   * type from the zoom depth plus a 64-bit guard.  The old `+ 8` here was the
   * ghost: it returned 64 bits for every scale down to 2^-45, so the "auto"
   * entry in the precision menu never changed anything and the HUD reported a
   * width the renderer was not using. */
  const need = -log2ps + 64;
  if (need <= 53) return 64;
  for (let i = 1; i < PRECISION_TIERS.length; i++) {
    if (PRECISION_TIERS[i] >= need) return PRECISION_TIERS[i];
  }
  return PRECISION_TIERS[PRECISION_TIERS.length - 1];
}

export function resolveBitsFromLog2(pref, log2ps) {
  if (pref === 'auto' || pref == null) return requiredBitsFromLog2(log2ps);
  const v = Number(pref);
  return Number.isFinite(v) ? v : requiredBitsFromLog2(log2ps);
}

/** User choice ('auto' or a concrete tier) -> actual width in bits */
export function resolveBits(pref, pixelSize) {
  if (pref === 'auto' || pref == null) return requiredBits(pixelSize);
  const v = Number(pref);
  return Number.isFinite(v) ? v : requiredBits(pixelSize);
}

/* ---------------- Scale (mantissa × 2^exp) ---------------- */

/**
 * The zoom scale is expressed as mantissa×2^exp so it can span the double exponent range (beyond 10^-300).
 */
export function makeSpan(mant, exp) {
  return { m: mant, e: exp };
}

export function spanToNumber(span) {
  return span.m * Math.pow(2, span.e);
}

export function spanMul(span, k) {
  let m = span.m * k;
  let e = span.e;
  while (Math.abs(m) >= 2) { m /= 2; e += 1; }
  while (Math.abs(m) < 1 && m !== 0) { m *= 2; e -= 1; }
  return { m, e };
}

export function spanScaleExp(span, k) { return { m: span.m, e: span.e + k }; }

/** Decimal exponent of the scale (used by the UI to display zoom = 10^n) */
export function spanDecimalExponent(span) {
  if (span.m === 0) return 0;
  return Math.log10(Math.abs(span.m)) + span.e * Math.log10(2);
}
