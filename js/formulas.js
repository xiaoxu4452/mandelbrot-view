/* ------------------------------------------------------------------
 * formulas.js — 分形族定义、高精度参考轨道、复平面辅助
 * ----------------------------------------------------------------*/

import { contextFor } from './bigfixed.js';

/* 逃逸时间族的“多项式核心”（z -> F(z) + c） */
export const KINDS = {
  mandelbrot: {
    id: 'mandelbrot', en: 'Mandelbrot', zh: '曼德勃罗',
    poly: true, pert: true, power: 2, powerRange: [2, 2]
  },
  multibrot: {
    id: 'multibrot', en: 'Multibrot', zh: '多枝曼德勃罗',
    poly: true, pert: true, power: 3, powerRange: [2, 10]
  },
  tricorn: {
    id: 'tricorn', en: 'Tricorn', zh: '三叉戟',
    poly: false, pert: false, power: 2, powerRange: [2, 2]
  },
  burningship: {
    id: 'burningship', en: 'Burning Ship', zh: '燃烧船',
    poly: false, pert: false, power: 2, powerRange: [2, 2]
  },
  celtic: {
    id: 'celtic', en: 'Celtic', zh: '凯尔特',
    poly: false, pert: false, power: 2, powerRange: [2, 2]
  },
  perpendicular: {
    id: 'perpendicular', en: 'Perpendicular', zh: '垂直',
    poly: false, pert: false, power: 2, powerRange: [2, 2]
  },
  phoenix: {
    id: 'phoenix', en: 'Phoenix', zh: '凤凰',
    poly: false, pert: false, power: 2, powerRange: [2, 2], param: 0.5667
  }
};

/* 全集类型（用于 UI 分段控件） */
export const MODES = {
  m: { id: 'm', en: 'Mandelbrot', zh: '曼德勃罗集' },
  j: { id: 'j', en: 'Julia', zh: '朱丽叶集' },
  n: { id: 'n', en: 'Newton', zh: '牛顿集' },
  x: { id: 'x', en: 'Custom', zh: '自定义' }
};

/* ---------- 高精度参考轨道 ---------- */

/**
 * 计算参考轨道（高精度迭代，结果截断为 double 数组）。
 * @param {object} spec  {mode:'m'|'j', kind, power, phoenix, julia:{re,im}}
 * @param {{re:string, im:string}} center 复平面中心（十进制字符串）
 * @param {number} bits 精度位宽
 * @param {number} maxIter 最大迭代
 * @param {number} bail 逃逸半径平方（double，如 1e10）
 * @returns {{re:Float64Array, im:Float64Array, len:number, escaped:boolean, ms:number}}
 */
export function buildReferenceOrbit(spec, center, bits, maxIter, bail) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ctx = contextFor(bits);
  const F = ctx.FB;
  const HALF = ctx.HALF;

  // 用于 double 化的快速转换：value ≈ Number(v >> (F-60)) * 2^-60
  const SH = BigInt(Math.max(0, ctx.F - 60));
  const SHIFT_BACK = Math.pow(2, -60);
  const toN = (v) => Number(v >> SH) * SHIFT_BACK;

  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> F : -((-p + HALF) >> F); };
  const sq = (a) => mul(a, a);

  const kind = spec.kind;
  const p = spec.power | 0;
  const isJulia = spec.mode === 'j';

  // 常数额 c 与初始 z0
  const cr = isJulia ? ctx.fromString(spec.julia.re) : ctx.fromString(center.re);
  const ci = isJulia ? ctx.fromString(spec.julia.im) : ctx.fromString(center.im);
  let zr = 0n, zi = 0n;
  if (isJulia) {
    zr = ctx.fromString(center.re);
    zi = ctx.fromString(center.im);
  }

  const phoenixP = ctx.fromNumber(spec.phoenixP != null ? spec.phoenixP : 0.5667);
  let pr = 0n, pi = 0n;      // phoenix 的上一轮值

  const bailSq = ctx.fromNumber(1e20);  // |z|^2 > 1e20 视为逃逸

  const re = new Float64Array(maxIter + 1);
  const im = new Float64Array(maxIter + 1);
  let len = maxIter;
  let escaped = false;

  for (let n = 0; n <= maxIter; n++) {
    re[n] = toN(zr);
    im[n] = toN(zi);

    const ar = sq(zr), bi = sq(zi);
    if (ar + bi > bailSq) { len = n; escaped = true; break; }

    let nr = 0n, ni = 0n;
    switch (kind) {
      case 'mandelbrot':
      case 'multibrot': {
        // (x+iy)^p
        if (p === 2) { nr = ar - bi; ni = 2n * mul(zr, zi); }
        else if (p === 3) {
          const x2y2 = ar - bi;
          const xy = mul(zr, zi);
          nr = mul(x2y2, zr) - mul(2n * xy, zi);
          ni = mul(x2y2, zi) + mul(2n * xy, zr);
        } else {
          let tr = zr, ti = zi;
          for (let k = 2; k <= p; k++) {
            const r2 = mul(tr, zr) - mul(ti, zi);
            const i2 = mul(tr, zi) + mul(ti, zr);
            tr = r2; ti = i2;
          }
          nr = tr; ni = ti;
        }
        break;
      }
      case 'tricorn': {
        nr = ar - bi;
        ni = -2n * mul(zr, zi);
        break;
      }
      case 'burningship': {
        const x = zr < 0n ? -zr : zr, y = zi < 0n ? -zi : zi;
        nr = mul(x, x) - mul(y, y);
        ni = 2n * mul(x, y);
        break;
      }
      case 'celtic': {
        let t = ar - bi;
        if (t < 0n) t = -t;
        nr = t; ni = 2n * mul(zr, zi);
        break;
      }
      case 'perpendicular': {
        const x = zr < 0n ? -zr : zr, y = zi < 0n ? -zi : zi;
        nr = ar - bi;
        ni = 2n * mul(x, y);
        break;
      }
      case 'phoenix': {
        nr = ar - bi + mul(phoenixP, pr);
        ni = 2n * mul(zr, zi) + mul(phoenixP, pi);
        pr = zr; pi = zi;
        break;
      }
      default: {
        nr = ar - bi; ni = 2n * mul(zr, zi);
      }
    }
    zr = nr + cr;
    zi = ni + ci;
  }

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return { re, im, len: Math.min(len, maxIter), escaped, ms: t1 - t0 };
}

/* ---------- 牛顿法根 ---------- */

export function newtonRoots(degree) {
  const roots = [];
  for (let k = 0; k < degree; k++) {
    const a = (2 * Math.PI * k) / degree;
    roots.push([Math.cos(a), Math.sin(a)]);
  }
  return roots;
}

/* ---------- 缩放尺度 ---------- */

export function pixelSize(span, width) {
  return (span.m * Math.pow(2, span.e)) / width;
}

/** 深度（十进制指数，越大越深） */
export function zoomDepth(span, width) {
  const ps = pixelSize(span, width);
  return -Math.log10(ps);
}

export function formatCoord(v, digits = 18) {
  if (typeof v === 'number') return v.toFixed(digits);
  return v;
}
