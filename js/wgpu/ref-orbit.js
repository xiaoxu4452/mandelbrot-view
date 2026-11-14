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

/* The bundle is vendored under js/vendor so the static site does not depend on
 * node_modules/ (which is not published).  It is imported lazily: browsers
 * without WebGPU never pay for the 380 KiB wasm payload. */
let gmpLibPromise = null;

export async function gmpLib() {
  if (!gmpLibPromise) {
    gmpLibPromise = import('../vendor/gmp-wasm.esm.min.js?v=28').then((m) => m.init());
  }
  return gmpLibPromise;
}

/** Physical bit budget of a frame: coordinate cancellation + iteration drift. */
/**
 * Bits needed for a frame whose half-span is 2^spanLog2.
 *
 * This is the recovered program's own rule, not an estimate:
 * `mset plan --zoom 1e12 / e38 / e74 / 1e800000` reports
 * 62 / 88 / 124 / 800050 decimal digits — that is exactly
 * `zoom_exponent + 50`, and it already carries the iteration error (50 digits
 * = 166 bits, while the whole budget we allow costs at most 34 bits of it).
 * Expressing the same rule in bits keeps this side and the desktop core on one
 * number instead of two guesses.
 */
export function physicalBits(spanLog2, maxIter) {
  const depth10 = -spanLog2 / Math.log2(10);
  const digits = Math.max(0, depth10) + 50;
  return Math.ceil((digits * Math.log2(10)) / 64) * 64;
}

/** Bits needed for a frame whose half-span is 2^spanLog2. */
export function precisionForSpan(spanLog2, maxIter, safety = 1) {
  /* An ACTIVE width, not a tier: physicalBits() is already the recovered
   * program's `digits = depth10 + 50` rule.  The old code multiplied that by
   * 3 and rounded up, asking for 512 bits where 256 are enough — and MPFR
   * cost grows super-linearly with the width, so every deep frame paid for
   * the extra limbs.  The result is still a multiple of 64 because that is how
   * the limbs are stored; the *decision* is the active number.
   *
   * 32768 is the ceiling the product promises; a deeper view is clamped
   * instead of asking for a limb count the allocator cannot serve. */
  /* 1.2 Mbit is the working width the desktop core runs at now; the old
   * 32768-bit clamp (~9860 digits) was the point where a deep frame stopped
   * being arbitrary-precision and started rounding the reference instead. */
  const needed = physicalBits(spanLog2, maxIter) * safety;
  return Math.min(1200000, Math.max(96, Math.ceil(needed / 64) * 64));
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
 * Family indices shared with the compute shader (see FAMILY_STEP in wgsl.js).
 * `mandelbrot` and `multibrot` are the same polynomial family and differ only
 * by `power`, which is why kind 0 covers both.
 */
export const FAMILY = {
  poly: 0,
  tricorn: 1,
  burningship: 2,
  celtic: 3,
  perpendicular: 4,
  phoenix: 5
};

export function familyIndex(kind) {
  return FAMILY[kind] != null ? FAMILY[kind] : 0;
}

/** True when the family is a plain z^p (the only one BLA is valid for). */
export function isPolynomialFamily(kind) {
  return familyIndex(kind) === 0;
}

/**
 * Yield to the event loop without relying on a single scheduler.
 *
 * The orbit loop used to `await new Promise(r => setTimeout(r, 0))` every 256
 * steps.  A backgrounded tab clamps that timer to one second, so a 4000-step
 * orbit spent 15 s almost entirely inside the timer rather than in MPFR — which
 * is what "it loads again and again and stutters" looked like.
 *
 * `scheduler.yield()` is the documented API for this and is deliberately not
 * used: in a hidden tab it stays pending until the page is visible again, so
 * the orbit never finished.  A MessageChannel task is not timer-throttled, but
 * a frozen page stops delivering those too, hence the timer race below: one of
 * the two always lands, whichever is available.
 */
const yieldToUi = () => new Promise((resolve) => {
  let done = false;
  const fin = () => { if (!done) { done = true; resolve(); } };
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); fin(); };
  ch.port2.postMessage(null);
  setTimeout(fin, 0);
});

/* Only yield when the loop has actually been running long enough to matter. */
const YIELD_MS = 12;

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
  power = 2,
  kind = 0,          // see FAMILY above
  phoenixP = 0.5667,
  /* Called between chunks; a newer view makes this build pointless, and at
   * 1e-1000 the loop is long enough that finishing it would stall the page. */
  isCancelled = null,
  /* Optional collector for the Boost <-> MPFR bridge: two decimal strings
   * per step (Re(z_n), Im(z_n)), starting with z_0 = 0.  The desktop's
   * core/mb_bridge.cpp consumes exactly this shape via bridgeCheckJson(). */
  decimalOrbit = null
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

    /* Callers may pass either the family id from formulas.js or the numeric
     * index the shader uses.  `kind | 0` would silently turn 'phoenix' into 0
     * and build a polynomial orbit for every family, so resolve by name. */
    const fam = typeof kind === 'number' ? (kind | 0) : familyIndex(kind);
    const p = Math.max(2, power | 0 || 2);
    const phx = ctx.Float(String(phoenixP != null ? phoenixP : 0.5667));
    /* Phoenix remembers the previous iterate; the reference starts it at 0,
     * exactly as formulas.js does, so both engines walk the same orbit. */
    let prevR = ctx.Float('0');
    let prevI = ctx.Float('0');

    const cap = maxIter + 2;
    const out = new Float32Array(cap * 4);
    let len = 0;
    let escape = -1;
    let lastYield = t0;

    for (let n = 0; n <= maxIter; n++) {
      /* Deep views can need thousands of MPFR steps; hand the frame back often
       * enough that the loading pill keeps painting and the page stays
       * interactive, but not so often that the handover dominates. */
      if (n && (n & 127) === 0 && performance.now() - lastYield > YIELD_MS) {
        await yieldToUi();
        lastYield = performance.now();
        if (isCancelled && isCancelled()) return null;
      }
      /* Two float32 limbs, 48 bits total.  The low word has to be the residual
       * of the *float32-rounded* high word: taking it against the 53-bit
       * double (the old code did) leaves a pair whose low limb describes a
       * value the shader never sees, so the reconstruction was only good to
       * 24 bits while the comment claimed 48. */
      const hrD = hi(zr);
      const hiI0 = hi(zi);
      const hr = Math.fround(hrD);
      const hiI = Math.fround(hiI0);

      out[len * 4 + 0] = hr;
      out[len * 4 + 1] = Math.fround(hrD - hr);
      out[len * 4 + 2] = hiI;
      out[len * 4 + 3] = Math.fround(hiI0 - hiI);
      len++;
      /* Full-precision decimal export, before the escape test so the bridge
       * sees the same z_n sequence the Boost side recomputes. */
      if (decimalOrbit) {
        decimalOrbit.push(zr.toString(10), zi.toString(10));
      }

      if (n > 0) {
        const m2 = zr.mul(zr).add(zi.mul(zi)).toNumber();
        /* Same bailout the shader's pixels use.  Stopping the reference at a
         * small radius (|z| > 256) used to hand every remaining step to the
         * float32 "direct finish", which is only accurate once |z| is large
         * enough that the extra iterations are few; at 256 they are not, and
         * a shallow Julia view came out several iterations off. */
        if (!Number.isFinite(m2) || m2 > 1e20) {
          escape = n;
          break;
        }
      }

      let nr, ni;
      if (fam === 1) {
        /* Tricorn: conj(z)^2 = (x²-y²) - 2xy i */
        nr = zr.mul(zr).sub(zi.mul(zi));
        ni = zr.mul(zi).mul(-2);
      } else if (fam === 2 || fam === 4) {
        /* Burning Ship / Perpendicular: (|x| + i|y|)^2 */
        const x = zr.abs();
        const y = zi.abs();
        nr = x.mul(x).sub(y.mul(y));
        ni = x.mul(y).mul(2);
      } else if (fam === 3) {
        /* Celtic: |Re z^2| + i Im z^2 */
        nr = zr.mul(zr).sub(zi.mul(zi)).abs();
        ni = zr.mul(zi).mul(2);
      } else if (fam === 5) {
        /* Phoenix: z^2 + p z_{n-1} + c */
        nr = zr.mul(zr).sub(zi.mul(zi)).add(prevR.mul(phx));
        ni = zr.mul(zi).mul(2).add(prevI.mul(phx));
        prevR = zr;
        prevI = zi;
      } else if (p === 2) {
        nr = zr.mul(zr).sub(zi.mul(zi));
        ni = zr.mul(zi).mul(2);
      } else {
        // Integer power via repeated complex multiplication.
        let pr = ctx.Float('1');
        let pi = ctx.Float('0');
        for (let k = 0; k < p; k++) {
          const tr = pr.mul(zr).sub(pi.mul(zi));
          const ti = pr.mul(zi).add(pi.mul(zr));
          pr = tr;
          pi = ti;
        }
        nr = pr;
        ni = pi;
      }
      zr = nr.add(jr);
      zi = ni.add(ji);
    }

    return {
      points: out.subarray(0, len * 4),
      length: len,
      escape,
      ms: performance.now() - t0,
      bits: precisionBits,
      kind: fam,
      power: p
    };
  } finally {
    ctx.destroy();
  }
}

/**
 * Export a real MPFR (gmp-wasm) reference orbit in the desktop bridge's JSON
 * contract.  Used by tools/bridge-crosscheck.mjs: the desktop recomputes the
 * same orbit with Boost.Multiprecision and reports the step-by-step relative
 * error, so the two high-precision backends are checked against each other
 * rather than each being trusted on its own.
 *
 * Only the quadratic Mandelbrot map is exported: the Boost referee in
 * core/mb_bridge.cpp iterates z^2 + c from z = 0.
 */
export async function exportReferenceOrbitJson({
  centerRe,
  centerIm,
  maxIter = 64,
  precisionBits = 512,
  digits = 40
}) {
  const orbit = [];
  const built = await buildReferenceOrbit({
    centerRe,
    centerIm,
    maxIter,
    precisionBits,
    mode: 0,
    kind: 'mandelbrot',
    power: 2,
    decimalOrbit: orbit
  });
  if (!built) throw new Error('reference orbit cancelled');
  /* The bridge's maxIter is a STEP COUNT: maxIter=8 means z_0..z_7, i.e. 16
   * decimal strings.  buildReferenceOrbit writes the (maxIter+1)-th z_n as
   * well, so trim that last pair or the referee sees a length mismatch (it
   * compares 10^-40 relative errors but still refuses an unequal prefix). */
  const nSteps = Number(built.escape) >= 0 ? built.escape : maxIter;
  const want = Math.min(orbit.length, nSteps * 2);
  return JSON.stringify({
    centerRe,
    centerIm,
    maxIter: want / 2,
    digits,
    orbit: orbit.slice(0, want)
  });
}

/**
 * Scan a coarse grid of the view in plain double and return the point whose
 * orbit survives longest.  Cheap (N²·maxIter flops) and only used on shallow
 * views, where a double is far more precise than one pixel.
 *
 * A reference that dies early is the one thing perturbation cannot repair:
 * every pixel that outlives it falls back to float32 and loses the zoom.  The
 * best surviving point in the frame is the natural replacement.
 */
export function pickSurvivor({
  centerRe, centerIm, spanLog2, maxIter, mode = 0, juliaRe = '0', juliaIm = '0',
  power = 2, kind = 0, phoenixP = 0.5667, grid = 40
}) {
  const span = Math.pow(2, spanLog2);
  const cx = Number(centerRe);
  const cy = Number(centerIm);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(span)) return null;
  const fam = typeof kind === 'number' ? (kind | 0) : familyIndex(kind);
  const p = Math.max(2, power | 0 || 2);
  const jr = Number(juliaRe) || 0;
  const ji = Number(juliaIm) || 0;
  const phx = phoenixP != null ? phoenixP : 0.5667;
  const bail = 1e20;

  const run = (x, y) => {
    let zr = mode === 1 ? x : 0;
    let zi = mode === 1 ? y : 0;
    let pr = 0, pi = 0;
    const cr = mode === 1 ? jr : x;
    const ci = mode === 1 ? ji : y;
    for (let n = 1; n <= maxIter; n++) {
      let nr, ni;
      switch (fam) {
        case 1: nr = zr * zr - zi * zi; ni = -2 * zr * zi; break;
        case 2: case 4: {
          const ax = Math.abs(zr), ay = Math.abs(zi);
          nr = ax * ax - ay * ay; ni = 2 * ax * ay;
          break;
        }
        case 3: nr = Math.abs(zr * zr - zi * zi); ni = 2 * zr * zi; break;
        case 5: {
          nr = zr * zr - zi * zi + phx * pr;
          ni = 2 * zr * zi + phx * pi;
          pr = zr; pi = zi;
          break;
        }
        default: {
          if (p === 2) { nr = zr * zr - zi * zi; ni = 2 * zr * zi; }
          else {
            let tr = 1, ti = 0;
            for (let k = 0; k < p; k++) {
              const r2 = tr * zr - ti * zi;
              ti = tr * zi + ti * zr;
              tr = r2;
            }
            nr = tr; ni = ti;
          }
        }
      }
      zr = nr + cr;
      zi = ni + ci;
      const m2 = zr * zr + zi * zi;
      if (!Number.isFinite(m2)) return n;
      if (m2 > bail) return n;
    }
    return maxIter;
  };

  /* Keep the candidate as an OFFSET from the centre, never an absolute
   * coordinate.  At 10^17 the frame is ~1e-15 wide while the centre is ~0.8:
   * `cx + offset` collapses onto the double grid, and a 40x40 scan degenerates
   * into a handful of identical points.  The offset itself is exact in double
   * and can be added to the centre later in MPFR. */
  let best = -1, bx = 0, by = 0;
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const ox = ((i + 0.5) / grid - 0.5) * span;
      const oy = (0.5 - (j + 0.5) / grid) * span;
      const x = cx + ox;
      const y = cy + oy;
      const n = run(x, y);
      if (n > best) { best = n; bx = ox; by = oy; }
      if (best >= maxIter) return { dx: bx, dy: by, len: best };
    }
  }
  return { dx: bx, dy: by, len: best };
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
