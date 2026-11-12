/* ------------------------------------------------------------------
 * ref-orbit.js — MPFR reference orbit + BLA coefficients.
 *
 * The reference orbit is the only arbitrary-precision work in the WebGPU
 * engine.  gmp-wasm wraps GMP/MPFR (C compiled to wasm); the pixel loop never
 * touches it.  The orbit is stored as float32 high/low pairs so the shader can
 * reconstruct ~48 bits of reference precision while δ itself carries the
 * deep exponent.
 *
 * Precision grows with depth.  A 10^1000 frame needs ~3322 bits physically;
 * the default safety factor is 3× (≈10000 bits / 3000 decimal digits), which
 * is the figure requested by the deep-zoom architecture.
 * ------------------------------------------------------------------ */

import { init } from '../../node_modules/gmp-wasm/dist/index.esm.js';

let gmpLibPromise = null;

export async function gmpLib() {
  if (!gmpLibPromise) gmpLibPromise = init();
  return gmpLibPromise;
}

/** Physical bit budget of a frame: coordinate cancellation + iteration drift. */
export function physicalBits(spanLog2, maxIter) {
  const iterBits = Math.ceil(Math.log2(Math.max(2, maxIter))) * 2;
  return Math.ceil(-spanLog2) + 64 + iterBits;
}

/** Bits needed for a frame whose half-span is 2^spanLog2. */
export function precisionForSpan(spanLog2, maxIter, safety = 3) {
  const needed = physicalBits(spanLog2, maxIter);
  return Math.max(384, Math.ceil((needed * safety) / 64) * 64);
}

/** Decimal digits represented by a bit count. */
export function bitsToDigits(bits) {
  return bits / Math.log2(10);
}

const hi = (f) => {
  const v = f.toNumber();
  return Number.isFinite(v) ? v : 0;
};

/**
 * Build one reference orbit.
 * @returns {Promise<{points:Float32Array,length:number,escape:number,ms:number,bits:number}>}
 */
export async function buildReferenceOrbit({
  centerRe,
  centerIm,
  maxIter,
  precisionBits,
  mode = 0,          // 0 = Mandelbrot c-plane, 1 = Julia
  juliaRe = '0',
  juliaIm = '0',
  power = 2
}) {
  const lib = await gmpLib();
  const t0 = performance.now();
  const ctx = lib.getContext({ precisionBits });
  let zr, zi, jr, ji;
  try {
    if (mode === 1) {
      zr = ctx.Float(centerRe);
      zi = ctx.Float(centerIm);
      jr = ctx.Float(juliaRe);
      ji = ctx.Float(juliaIm);
    } else {
      zr = ctx.Float('0');
      zi = ctx.Float('0');
      jr = ctx.Float(centerRe);
      ji = ctx.Float(centerIm);
    }

    const cap = maxIter + 2;
    const out = new Float32Array(cap * 4);
    let len = 0;
    let escape = -1;

    for (let n = 0; n <= maxIter; n++) {
      const hr = hi(zr);
      const hrRes = zr.sub(hr);
      const hiR = hiResToNumber(hrRes);
      const hiI0 = hi(zi);
      const hiI = hiResToNumber(zi.sub(hiI0));

      out[len * 4 + 0] = hr;
      out[len * 4 + 1] = hiR;
      out[len * 4 + 2] = hiI0;
      out[len * 4 + 3] = hiI;
      len++;

      if (n > 0) {
        const m2 = zr.mul(zr).add(zi.mul(zi)).toNumber();
        if (!Number.isFinite(m2) || m2 > 65536) {
          escape = n;
          break;
        }
      }

      if (power === 2) {
        const nr = zr.mul(zr).sub(zi.mul(zi)).add(jr);
        const ni = zr.mul(zi).mul(2).add(ji);
        zr = nr;
        zi = ni;
      } else {
        // Integer power via repeated complex multiplication.
        let pr = ctx.Float('1');
        let pi = ctx.Float('0');
        for (let k = 0; k < power; k++) {
          const tr = pr.mul(zr).sub(pi.mul(zi));
          const ti = pr.mul(zi).add(pi.mul(zr));
          pr = tr;
          pi = ti;
        }
        zr = pr.add(jr);
        zi = pi.add(ji);
      }
    }

    return {
      points: out.subarray(0, len * 4),
      length: len,
      escape,
      ms: performance.now() - t0,
      bits: precisionBits
    };
  } finally {
    ctx.destroy();
  }
}

function hiResToNumber(f) {
  const v = f.toNumber();
  return Number.isFinite(v) ? v : 0;
}

/**
 * Bilinear approximations: δ' = A δ + B dc over a block of reference steps.
 * Layout per block: [A.x, A.y, start, len, B.x, B.y, expA, expB].
 *
 * The block length adapts to the local multiplier: near c = -2 the reference
 * multiplier is 4 per step, so a 64-step block reaches 2^128 and the float32
 * exp2() in the shader would overflow.  For each start we therefore try
 * 64/32/16/8 steps and keep the longest block whose exponents stay inside the
 * shader's accepted range, so no reference step is left uncovered.
 */
export function buildBla(points, length, maxExp = 96) {
  const LENS = [64, 32, 16, 8];
  const out = [];
  let s = 0;
  while (s + 4 <= length) {
    let advanced = false;
    for (const blockLen of LENS) {
      const e = Math.min(length, s + blockLen);
      if (e - s < 4) continue;
      let ar = 1, ai = 0, br = 0, bi = 0;
      let ok = true;
      for (let k = s; k < e; k++) {
        const zr = points[k * 4] + points[k * 4 + 1];
        const zi = points[k * 4 + 2] + points[k * 4 + 3];
        const nbr = 2 * (zr * br - zi * bi) + 1;
        const nbi = 2 * (zr * bi + zi * br);
        br = nbr; bi = nbi;
        const nar = 2 * (zr * ar - zi * ai);
        const nai = 2 * (zr * ai + zi * ar);
        ar = nar; ai = nai;
        if (!Number.isFinite(ar) || !Number.isFinite(ai) ||
            !Number.isFinite(br) || !Number.isFinite(bi)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const ma = Math.max(Math.abs(ar), Math.abs(ai));
      const mb = Math.max(Math.abs(br), Math.abs(bi));
      if (!(ma > 0) || !(mb > 0)) continue;
      const ea = Math.floor(Math.log2(ma));
      const eb = Math.floor(Math.log2(mb));
      if (ea < -96 || ea > maxExp || eb < -96 || eb > maxExp) continue;
      const sa = Math.pow(2, -ea);
      const sb = Math.pow(2, -eb);
      out.push(
        ar * sa, ai * sa, s, e - s,
        br * sb, bi * sb, ea, eb
      );
      s = e;
      advanced = true;
      break;
    }
    if (!advanced) s += LENS[LENS.length - 1];
  }
  return { data: new Float32Array(out), count: out.length / 8 };
}

/** Tiny one-entry orbit cache; the renderer owns the reuse policy. */
export class OrbitCache {
  constructor() {
    this.entry = null;
  }
  get(key) {
    return this.entry && this.entry.key === key ? this.entry.value : null;
  }
  set(key, value) {
    this.entry = { key, value };
    return value;
  }
  clear() {
    this.entry = null;
  }
}
