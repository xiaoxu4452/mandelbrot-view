/* ------------------------------------------------------------------
 * bigfixed.js — 任意精度定点数运算（BigInt 实现）
 *
 * 设计：value = m / 2^F ，m 为 BigInt，F = bits + GUARD 位小数位。
 * 精度分级（与 UI 一一对应）：
 *    64  -> 原生 IEEE-754 double（最快）
 *   128  -> 2 limbs
 *   256  -> 4 limbs
 *   512  -> 8 limbs
 *  1024  -> 16 limbs（深度放大自动升级）
 *
 * 该模块同时被主线程与 Worker 使用（ES Module）。
 * ----------------------------------------------------------------*/

const GUARD = 26;

/* ---------------- 基础工具 ---------------- */

function bitLength(a) {
  if (a === 0n) return 0;
  if (a < 0n) a = -a;
  const s = a.toString(16);
  const hi = parseInt(s[0], 16);
  const hiBits = hi.toString(2).length;
  return (s.length - 1) * 4 + hiBits;
}

/* 10^n 缓存 */
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

/* ---------------- 精度上下文 ---------------- */

export class Fixed {
  /**
   * @param {number} bits 有效位宽（64/128/256/512/1024...）
   */
  constructor(bits) {
    this.bits = bits;
    this.F = bits + GUARD;          // 小数位数
    this.FB = BigInt(this.F);
    this.ONE = 1n << this.FB;       // 1.0
    this.HALF = this.ONE >> 1n;
    this.MASK = this.ONE - 1n;
    this.SCALE = Math.pow(2, -this.F);  // 用于 toNumber 的量纲
    this._eps = null;
  }

  /* ---- 构造 ---- */

  zero() { return 0n; }

  fromNumber(x) {
    if (!isFinite(x)) throw new Error('Fixed.fromNumber: 非法数值 ' + x);
    if (x === 0) return 0n;
    const neg = x < 0;
    const a = Math.abs(x);
    // 归一化成 m * 2^exp（m ∈ [1,2)），否则小数会只剩下约 32 位有效位
    let exp = Math.floor(Math.log2(a));
    let m = a / Math.pow(2, exp);
    if (m >= 2) { m /= 2; exp += 1; }
    else if (m < 1) { m *= 2; exp -= 1; }
    let mant = BigInt(Math.round(m * 4503599627370496)); // 53 bit
    let v = (mant << this.FB) >> 52n;
    v = exp >= 0 ? v << BigInt(exp) : v >> BigInt(-exp);
    return neg ? -v : v;
  }

  /** 十进制字符串 -> 定点（支持 "1.2e-30"、"-0.7436"） */
  fromString(str) {
    const s = String(str).trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error('坐标格式无效: ' + str);
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

  /* ---- 基本运算 ---- */

  add(a, b) { return a + b; }
  sub(a, b) { return a - b; }
  neg(a) { return -a; }
  abs(a) { return a < 0n ? -a : a; }

  mul(a, b) {
    const p = a * b;
    // 四舍五入而非截断
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

  /** 乘以 2^k（精确移位） */
  shl(a, k) {
    return k >= 0 ? a << BigInt(k) : a >> BigInt(-k);
  }

  cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  isZero(a) { return a === 0n; }

  MAXV() { return 1n << BigInt(this.bits + 8); }

  /* ---- 转换 ---- */

  /** 定点 -> double（取高 53 位，避免 Number(BigInt) 溢出） */
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

  /** 定点 -> 十进制字符串，digits 为小数位数 */
  toString(a, digits = 24) {
    const neg = a < 0n;
    const v = neg ? -a : a;
    const ip = v >> this.FB;
    const rem = v & this.MASK;
    const d = pow10(digits);
    const frac = ((rem * d + this.HALF) >> this.FB);
    let fs = frac.toString();
    while (fs.length < digits) fs = '0' + fs;
    // 去掉尾部 0
    fs = fs.replace(/0+$/, '');
    const out = fs ? ip.toString() + '.' + fs : ip.toString();
    return (neg && out !== '0' ? '-' : '') + out;
  }

  /** 通用科学计数法显示 */
  toSci(a, sig = 12) {
    const s = this.toString(a, 40);
    return s;
  }
}

/* ---------------- 精度分级与自动选择 ---------------- */

export const PRECISION_TIERS = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

const ctxCache = new Map();

/** 获取（或创建）指定精度的定点上下文 */
export function contextFor(bits) {
  let c = ctxCache.get(bits);
  if (!c) {
    c = new Fixed(bits);
    ctxCache.set(bits, c);
  }
  return c;
}

/**
 * 根据像素尺度（复数平面上的像素边长）推断所需位宽。
 * 需要约 -log2(pixelSize) 位的有效位，外加 8 位安全余量。
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

/** 由像素尺度的 log2 推导位宽（支持 1e-1000 这类无法用 double 表示的尺度） */
export function requiredBitsFromLog2(log2ps) {
  const need = -log2ps + 8;
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

/** 用户选择（'auto' 或具体 tier）-> 实际位宽 */
export function resolveBits(pref, pixelSize) {
  if (pref === 'auto' || pref == null) return requiredBits(pixelSize);
  const v = Number(pref);
  return Number.isFinite(v) ? v : requiredBits(pixelSize);
}

/* ---------------- 尺度（mantissa × 2^exp）---------------- */

/**
 * 缩放尺度以 mantissa×2^exp 表示，可跨越 double 指数范围（10^-300 以上）。
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

/** 该尺度的十进制指数（用于 UI 显示 zoom = 10^n） */
export function spanDecimalExponent(span) {
  if (span.m === 0) return 0;
  return Math.log10(Math.abs(span.m)) + span.e * Math.log10(2);
}
