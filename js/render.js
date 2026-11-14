/* ------------------------------------------------------------------
 * render.js — CPU tile renderer core
 *   direct   direct double-precision evaluation (shallow, fastest)
 *   perturb  high-precision reference orbit + double perturbation + glitch-cluster repair (deep, down to 10^-300)
 *   hp       fully high-precision direct evaluation (Newton sets / families without perturbation support)
 * ----------------------------------------------------------------*/

import { paletteLUT } from './palettes.js?v=28';
import { buildReferenceOrbit } from './formulas.js?v=28';
import { ddAdd, ddSub, ddMul } from './dd.js?v=28';
import { contextFor, resolveBits, requiredBits, resolveBitsFromLog2, requiredBitsFromLog2 } from './bigfixed.js?v=28';
import { buildSeries, chooseSkip } from './environment.js?v=28';
import { makeBigContext, compileBig } from './hpeval.js?v=28';
import { compile as compileDouble } from './mathlib.js?v=28';

import { BAIL2, LOG_BAIL, putColor as writeColor, smoothIter as smoothOf } from './drawlib.js?v=28';
const INTERIOR = [5, 6, 9];

const KIND_CODE = {
  mandelbrot: 0, multibrot: 0,
  tricorn: 1, burningship: 2, celtic: 3, perpendicular: 4, phoenix: 5
};

/* ---------------- Reference-orbit cache ---------------- */

const orbitCache = new Map();
const ORBIT_CACHE_MAX = 8;

export function orbitKey(job) {
  const s = job.spec;
  return [
    job.viewId, s.mode, s.kind, s.power, s.phoenixP,
    s.julia ? s.julia.re + '|' + s.julia.im : '',
    job.center.re, job.center.im, job.bits, job.maxIter
  ].join(';');
}

/** Fast double-precision escape time (used when electing reference points) */
function escapeTimeDouble(spec, cr, ci, zr0, zi0, limit) {
  const kind = spec.kind, power = spec.power | 0;
  const isJulia = spec.mode === 'j';
  let zr = zr0, zi = zi0;
  const ph = spec.phoenixP != null ? spec.phoenixP : 0.5667;
  let pr = 0, pi = 0;
  for (let n = 0; n < limit; n++) {
    let nr, ni;
    switch (KIND_CODE[kind] || 0) {
      case 0: {
        if (power === 2) { nr = zr * zr - zi * zi; ni = 2 * zr * zi; }
        else {
          let tr = zr, ti = zi;
          for (let k = 2; k <= power; k++) {
            const r2 = tr * zr - ti * zi, i2 = tr * zi + ti * zr;
            tr = r2; ti = i2;
          }
          nr = tr; ni = ti;
        }
        break;
      }
      case 1: nr = zr * zr - zi * zi; ni = -2 * zr * zi; break;
      case 2: { const ax = Math.abs(zr), ay = Math.abs(zi); nr = ax * ax - ay * ay; ni = 2 * ax * ay; break; }
      case 3: { const t = zr * zr - zi * zi; nr = Math.abs(t); ni = 2 * zr * zi; break; }
      case 4: { nr = zr * zr - zi * zi; ni = 2 * Math.abs(zr) * Math.abs(zi); break; }
      case 5: { nr = zr * zr - zi * zi + ph * pr; ni = 2 * zr * zi + ph * pi; pr = zr; pi = zi; break; }
      default: nr = zr * zr - zi * zi; ni = 2 * zr * zi;
    }
    zr = isJulia ? nr + cr : nr + cr;
    zi = isJulia ? ni + ci : ni + ci;
    if (zr * zr + zi * zi > BAIL2) return n;
  }
  return limit;
}

/**
 * Elect a reference point: sample several candidates in the viewport, measure how long each survives
 * with a high-precision orbit, and take the "longest-lived" one as the reference orbit.
 * High precision is required: at depths below 1e-16, doubles can no longer tell these candidates apart,
 * and a reference orbit that escapes early collapses the whole frame into a single colour (the classic deep-zoom artefact).
 */
function pickReference(job, bits) {
  const { width, height, maxIter } = job;
  const ps = job.pixelSize;
  const spec = job.spec;

  /* Reference-point election.
   *
   * The perturbation recursion is only well conditioned while the reference
   * orbit stays "close" to the pixel orbits.  A reference that escapes early
   * forces the whole view onto the glitch fallback, which is what produced
   * the black blobs and speckle noise of the previous build.  We therefore
   * probe a 5×5 grid (centre first) and keep the longest-lived candidate,
   * preferring a point that never escapes inside the iteration budget.
   *
   * Two stages, because the probe only needs to *rank* the candidates and the
   * ranking is settled long before the budget runs out.  A full high-precision
   * orbit of every candidate cost 25 x maxIter BigInt steps — at 2^-57 with a
   * 20k budget that alone was the tens of seconds, and it happened again in
   * every worker.  Stage 1 runs each candidate for `probeCap` iterations
   * (1k is far past the point where the ordering is fixed) and keeps the top
   * few; stage 2 builds those at the full budget and keeps the winner.  Three
   * full orbits instead of twenty-five, same answer: a candidate that escapes
   * at 1500 and one that never escapes look identical to a 1k probe, so the
   * probe's "best" is not trusted on its own.
   *
   * Stopping the probe at the first non-escaping candidate was worse than it
   * looks: at 2^-46 the centre survives 1k but escapes at 3089 while a corner
   * survives the whole budget, and the early break picked the centre — 19k of
   * 57k pixels came back as perturbation glitches and the frame was a mosaic. */
  /* Desktop core (B2): a short probe can rank a candidate that escapes at
   * 1500 above one that survives the whole budget.  Lift the probe in rounds
   * and re-rank before committing.  The final orbit is ALWAYS built at
   * maxIter — there is no 4096/8192 ref_cap staircase. */
  const round1 = Math.min(maxIter, 1024);
  const round2 = Math.min(maxIter, Math.max(round1, 4096));

  /* Stage 0 — plain-double lifetime probe over a DENSE grid (desktop rule:
   * the reference must outlive every pixel).  A sparse 5x5 grid in a
   * filament field elects a reference that escapes in ~50 steps; a
   * short-lived reference then poisons the whole frame — the black-wedge
   * artefact of the user's 10^12.2 screenshot (refLen=54 against a 2447
   * budget).  Doubles are fine for RANKING: 0.1% position noise cannot
   * re-order "died at 54" vs "never escaped". */
  const GD = 24, GDY = 16;   // the desktop core's own 24x16 probe density
  const cands = [];
  for (let j = 0; j < GDY; j++) {
    for (let i = 0; i < GD; i++) cands.push([(i + 0.5) / GD, (j + 0.5) / GDY]);
  }
  cands.sort((a, b) =>
    Math.hypot(a[0] - 0.5, a[1] - 0.5) - Math.hypot(b[0] - 0.5, b[1] - 0.5));

  const simpleFamily = (spec.kind === 'mandelbrot' || spec.kind === 'multibrot') &&
    (spec.power | 0) === 2;
  const probeLife = (cre, cim) => {
    let zr = 0, zi = 0;
    const isJulia = spec.mode === 'j';
    if (isJulia) { zr = cre; zi = cim; }
    const cr = isJulia ? +spec.julia.re : cre;
    const ci = isJulia ? +spec.julia.im : cim;
    const cap = Math.min(maxIter, 4096);
    for (let n = 1; n <= cap; n++) {
      const a = zr * zr - zi * zi + cr;
      const b = 2 * zr * zi + ci;
      zr = a; zi = b;
      if (!(zr * zr + zi * zi <= BAIL2)) return n;
    }
    return cap + 1;   // never escaped inside the cap: best possible
  };

  const slots = cands.map(([fx, fy]) => {
    const px = fx * width, py = fy * height;
    const ox = (px + 0.5 - width * 0.5) * ps;
    const oy = -(py + 0.5 - height * 0.5) * ps;
    const centerHP = {
      re: offsetCoord(job.center.re, ox, bits),
      im: offsetCoord(job.center.im, oy, bits)
    };
    return {
      px, py, centerHP,
      lifeD: simpleFamily ? probeLife(+centerHP.re, +centerHP.im) : NaN
    };
  });
  /* Only the dense-probe survivors earn a high-precision orbit build; a NaN
   * probe (non-simple families) keeps every candidate, as before. */
  if (simpleFamily) {
    slots.sort((a, b) => (b.lifeD || 0) - (a.lifeD || 0));
    slots.length = Math.min(slots.length, 10);
  }
  /* refPx/refPy live in coordinate space: pixel (px,py) is sampled at
   * px+0.5, exactly where centerHP was placed.  Storing px instead shifted
   * the perturbation layer half a pixel against the direct layer. */
  const measure = (c, cap) => {
    const orb = buildReferenceOrbit(spec, c.centerHP, bits, cap, BAIL2);
    orb.refPx = c.px + 0.5;
    orb.refPy = c.py + 0.5;
    orb.centerHP = c.centerHP;
    orb.slot = c;
    orb.lifetime = orb.escaped ? orb.len : cap;
    orb.probeCap = cap;
    return orb;
  };
  const rank = (list, cap) => list.map(c => measure(c, cap))
    .sort((a, b) => b.lifetime - a.lifetime);

  /* Desktop core (B10): the EXACT view centre is a mandatory candidate.
   * A 5x5 grid samples pixel (px,py) at px+0.5, so even its middle cell is
   * half a pixel off centre — enough to miss an analytically periodic point
   * (c=i, c=-2) and lose the periodic-orbit fast path.  Use the centre
   * string verbatim so no fixed-point offset can truncate it. */
  slots.unshift({
    px: width * 0.5 - 0.5, py: height * 0.5 - 0.5,
    centerHP: { re: job.center.re, im: job.center.im }
  });
  /* Survivors first, then the longest escapes (stable sort keeps the
   * centre-most among equals).  Round 2 re-ranks the top eight at a longer
   * probe — this is where the 1k-only ordering used to pick a reference
   * that escaped early and turned the frame into a mosaic. */
  let probe = rank(slots, round1);
  if (round2 > round1) {
    const take = Math.min(8, probe.length);
    const lifted = rank(probe.slice(0, take).map(o => o.slot), round2);
    probe = lifted.concat(probe.slice(take));
  }
  const finals = probe.slice(0, Math.min(3, probe.length));

  let best = null;
  for (const cand of finals) {
    /* ref_cap = maxIter in one shot; only a candidate already measured at
     * the full budget skips the rebuild. */
    const full = cand.probeCap >= maxIter ? cand : measure(cand.slot, maxIter);
    if (!best || full.lifetime > best.lifetime) best = full;
    // An interior reference is ideal: stop once one survives the whole budget.
    if (!full.escaped || best.lifetime >= maxIter) break;
  }
  if (!best) best = finals[0];
  return best;
}

export function getOrbit(job, bits) {
  const key = orbitKey(job);
  let o = orbitCache.get(key);
  if (o) return o;
  o = pickReference(job, bits || job.resolvedBits || 128);
  if (orbitCache.size >= ORBIT_CACHE_MAX) {
    orbitCache.delete(orbitCache.keys().next().value);
  }
  orbitCache.set(key, o);
  return o;
}

/**
 * Rebuild the elected reference orbit with (hi, lo) low words.
 *
 * pickReference() keeps the cheap double orbit (it probes up to 25 candidates),
 * so the double-double variant is materialised only once per view, from the
 * coordinate strings the election already produced.
 */
export function orbitWithPairs(job, bits) {
  const key = orbitKey(job) + '|dd';
  let o = orbitCache.get(key);
  if (o) return o;
  const base = getOrbit(job, bits);
  const centerHP = base.centerHP || {
    re: job.center.re, im: job.center.im
  };
  o = buildReferenceOrbit(job.spec, centerHP, bits, job.maxIter, BAIL2, true);
  o.refPx = base.refPx;
  o.refPy = base.refPy;
  o.centerHP = centerHP;
  o.lifetime = base.lifetime;
  if (orbitCache.size >= ORBIT_CACHE_MAX) {
    orbitCache.delete(orbitCache.keys().next().value);
  }
  orbitCache.set(key, o);
  return o;
}

/* ---------------- Entry point ---------------- */

export function renderTile(job) {
  const t0 = now();
  const ps = job.pixelSize;
  const log2ps = job.psLog2 != null ? job.psLog2 : Math.log2(ps);
  const bits = resolveBitsFromLog2(job.bits, log2ps);
  const lut = paletteLUT(job.palette);
  const spec = job.spec;

  let result;
  if (spec.mode === 'n') {
    result = bits > 64 ? renderNewtonHP(job, bits, lut) : renderNewton(job, lut);
  } else if (spec.mode === 'x') {
    result = job.customEnv && job.customEnv.deriv
      ? renderCustomPerturb(job, lut)
      : renderCustom(job, lut);
  } else if (bits > 64 && log2ps > -1000 && (spec.kind === 'mandelbrot' || spec.kind === 'multibrot')) {
    result = renderPerturb(job, bits, lut);
  } else if (bits > 64) {
    result = renderHpDirect(job, bits, lut);
  } else {
    result = renderDirect(job, lut);
  }

  result.ms = now() - t0;
  result.bits = bits;
  result.precisionLimited = bits < requiredBitsFromLog2(log2ps);
  return result;
}

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function makeTile(w, h) { return new Uint8ClampedArray(w * h * 4); }

/* Colouring lives in drawlib.js; the solver only produces (n, m2). */
function smoothIter(n, m2, power) {
  return smoothOf(n, m2, 1 / Math.log(power));
}

/* ---------------- Direct double precision ---------------- */

function renderDirect(job, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const cxe = parseFloat(job.center.re), cye = parseFloat(job.center.im);
  const spec = job.spec;
  const kc = KIND_CODE[spec.kind] || 0;
  const power = spec.power | 0;
  const halfW = width * 0.5, halfH = height * 0.5;
  const isJulia = spec.mode === 'j';
  const jr = isJulia ? parseFloat(spec.julia.re) : 0;
  const ji = isJulia ? parseFloat(spec.julia.im) : 0;
  const ph = spec.phoenixP != null ? spec.phoenixP : 0.5667;
  const samples = Math.max(1, job.samples | 0);
  const sq2 = samples * samples;
  const inv = 1 / sq2;
  const step = 1 / (samples + 1);
  let o = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let accR = 0, accG = 0, accB = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const gx = x + px + (samples === 1 ? 0.5 : (sx + 1) * step);
          const gy = y + py + (samples === 1 ? 0.5 : (sy + 1) * step);
          const ox = (gx - halfW) * ps, oy = -(gy - halfH) * ps;
          const cr = isJulia ? jr : cxe + ox;
          const ci = isJulia ? ji : cye + oy;
          let zr = isJulia ? cxe + ox : 0;
          let zi = isJulia ? cye + oy : 0;
          let n = 0, m2 = 0, done = false;
          let pr = 0, pi = 0;
          let chkR = 0, chkI = 0, chkOn = false;

          for (; n < maxIter; n++) {
            let nr, ni;
            switch (kc) {
              case 0: {
                if (power === 2) { nr = zr * zr - zi * zi; ni = 2 * zr * zi; }
                else if (power === 3) {
                  const a = zr * zr - zi * zi, b = 2 * zr * zi;
                  nr = a * zr - b * zi; ni = a * zi + b * zr;
                } else {
                  let tr = zr, ti = zi;
                  for (let k = 2; k <= power; k++) {
                    const r2 = tr * zr - ti * zi, i2 = tr * zi + ti * zr;
                    tr = r2; ti = i2;
                  }
                  nr = tr; ni = ti;
                }
                break;
              }
              case 1: nr = zr * zr - zi * zi; ni = -2 * zr * zi; break;
              case 2: {
                const ax = zr < 0 ? -zr : zr, ay = zi < 0 ? -zi : zi;
                nr = ax * ax - ay * ay; ni = 2 * ax * ay; break;
              }
              case 3: {
                const t = zr * zr - zi * zi;
                nr = t < 0 ? -t : t; ni = 2 * zr * zi; break;
              }
              case 4: {
                const ax = zr < 0 ? -zr : zr, ay = zi < 0 ? -zi : zi;
                nr = zr * zr - zi * zi; ni = 2 * ax * ay; break;
              }
              case 5: {
                nr = zr * zr - zi * zi + ph * pr;
                ni = 2 * zr * zi + ph * pi;
                pr = zr; pi = zi; break;
              }
              default: nr = zr * zr - zi * zi; ni = 2 * zr * zi;
            }
            zr = nr + cr; zi = ni + ci;
            m2 = zr * zr + zi * zi;
            if (m2 > BAIL2) { done = true; break; }

            if (n === 6) { chkR = zr; chkI = zi; chkOn = true; }
            else if (chkOn && (n & 31) === 0) {
              const dx = zr - chkR, dy = zi - chkI;
              if (dx * dx + dy * dy < 1e-30) { break; }  // periodicity -> interior
            }
          }

          let r, g, b;
          if (!done) { r = INTERIOR[0]; g = INTERIOR[1]; b = INTERIOR[2]; }
          else {
            const t = smoothIter(n, m2, power) * bandScale + offset;
            let u = t - Math.floor(t);
            let ix = u * 512; let i0 = ix | 0; if (i0 >= 512) i0 = 511;
            const f = ix - i0, j0 = (i0 + 1) & 511;
            const a4 = i0 * 4, b4 = j0 * 4;
            r = lut[a4] + (lut[b4] - lut[a4]) * f;
            g = lut[a4 + 1] + (lut[b4 + 1] - lut[a4 + 1]) * f;
            b = lut[a4 + 2] + (lut[b4 + 2] - lut[a4 + 2]) * f;
          }
          accR += r; accG += g; accB += b;
        }
      }
      data[o] = accR * inv; data[o + 1] = accG * inv; data[o + 2] = accB * inv; data[o + 3] = 255;
      o += 4;
    }
  }
  return { data, mode: 'direct', glitches: 0, refLen: 0 };
}

/* ---------------- Perturbation rendering (polynomial families) ---------------- */

function renderPerturb(job, bits, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const power = job.spec.power | 0;
  const isJulia = job.spec.mode === 'j';
  const halfW = width * 0.5, halfH = height * 0.5;
  /* Once the pixel spacing is below the 53-bit limit, a double reference
   * orbit is no longer a usable approximation and the perturbation collapses
   * into mosaic blocks (see the kernel ddRef comment).  Switch the JS path to
   * the double-double orbit in exactly the same regime as the WASM kernel. */
  const wantDd = power === 2 && job.noDd !== true &&
    (job.psLog2 != null ? job.psLog2 <= -46 : Math.abs(ps) < 1e-14);
  const orbit = wantDd ? orbitWithPairs(job, bits) : getOrbit(job, bits);
  const Zr = orbit.re, Zi = orbit.im, oLen = orbit.len;
  const ZrL = orbit.reLo, ZiL = orbit.imLo;
  const useDd = !!ZrL;
  const refPx = orbit.refPx, refPy = orbit.refPy;

  // ---- Series approximation: one skip count for the whole view, so tiles cannot seam ----
  // Disabled on the double-double path: the SA coefficients live in plain doubles,
  // so their truncation error (~1e-16 relative) is exactly the error the dd path
  // removes.  Measured at 1e-28: SA on -> 0.5% of pixels off by >8 levels,
  // SA off -> bit-identical to the 256-bit reference; costs ~1.1-1.4x time.
  let sa = null;
  if (power === 2 && !job.noSeries && !useDd) {
    if (!orbit._series || orbit._serIter !== maxIter) {
      orbit._series = buildSeries(orbit, maxIter, isJulia, ps);
      orbit._serIter = maxIter;
    }
    const corners = [
      [0, 0], [width, 0], [0, height], [width, height]
    ];
    let far = 0;
    for (const [cx, cy] of corners) {
      far = Math.max(far, Math.hypot(cx - refPx, cy - refPy));
    }
    sa = chooseSkip(orbit._series, (far + 1) * ps, maxIter);
  }

  const glitchList = [];
  let glitchCount = 0;
  let o = 0;
  // Glitch budget per tile: a deep view can easily produce >10k glitching
  // pixels in a 128x128 tile, so the budget must scale with the tile area.
  const MAXFIX = 60000;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = x + px, gy = y + py;
      const poR = (gx + 0.5 - refPx) * ps;
      const poI = -(gy + 0.5 - refPy) * ps;
      const dcr = isJulia ? 0 : poR;
      const dci = isJulia ? 0 : poI;
      let dr = poR, di = poI;
      let n = 0, m2 = 0, esc = 0, glitch = false;

      // Series approximation: yields the perturbation at step s directly
      if (sa) {
        const d2r = poR * poR - poI * poI;
        const d2i = 2 * poR * poI;
        const d3r = d2r * poR - d2i * poI;
        const d3i = d2r * poI + d2i * poR;
        dr = sa.ar * poR - sa.ai * poI
          + sa.br * d2r - sa.bi * d2i
          + sa.cr * d3r - sa.ci * d3i;
        di = sa.ar * poI + sa.ai * poR
          + sa.br * d2i + sa.bi * d2r
          + sa.cr * d3i + sa.ci * d3r;
        n = sa.skip;
      }

      if (useDd) {
        /* Double-double perturbation: identical recurrence, but δ and the
         * reference multiplier are carried as (hi, lo) so the reference's
         * 1e-16 rounding cannot be amplified into the pixel signal. */
        let drh = dr, drl = 0, dih = di, dil = 0;
        for (; n < maxIter; n++) {
          if (n >= oLen) {
            const zr = Zr[oLen] + drh, zi = Zi[oLen] + dih;
            m2 = zr * zr + zi * zi;
            n = oLen - 1;
            if (m2 > BAIL2) esc = 1; else { esc = 0; glitch = true; }
            break;
          }
          const Zr0 = Zr[n], Zi0 = Zi[n], Zr0L = ZrL[n], Zi0L = ZiL[n];
          const zr = Zr0 + drh, zi = Zi0 + dih;
          m2 = zr * zr + zi * zi;
          if (m2 > BAIL2) { esc = 1; break; }
          /* Collision (|Z+δ| ≈ |δ|) is not a defect: the recursion recovers.
           * Only reference exhaustion is reported (see kernel.cpp). */

          const dz = [drh, drl], dzi = [dih, dil];
          const tz = ddAdd([2 * Zr0, 2 * Zr0L], dz);
          const ti = ddAdd([2 * Zi0, 2 * Zi0L], dzi);
          const nr = ddAdd(ddSub(ddMul(tz, dz), ddMul(ti, dzi)), [dcr, 0]);
          const ni = ddAdd(ddAdd(ddMul(tz, dzi), ddMul(ti, dz)), [dci, 0]);
          drh = nr[0]; drl = nr[1];
          dih = ni[0]; dil = ni[1];
        }
      } else {
        for (; n < maxIter; n++) {
          if (n >= oLen) {
            // The reference orbit has escaped: the pixel escapes with it unless cancellation occurs
            const zr = Zr[oLen] + dr, zi = Zi[oLen] + di;
            m2 = zr * zr + zi * zi;
            n = oLen - 1;
            if (m2 > BAIL2) esc = 1; else { esc = 0; glitch = true; }
            break;
          }
          const Zr0 = Zr[n], Zi0 = Zi[n];
        const zr = Zr0 + dr, zi = Zi0 + di;
        m2 = zr * zr + zi * zi;
        if (m2 > BAIL2) { esc = 1; break; }
        /* Collision is not a defect; only reference exhaustion is (kernel.cpp). */

        if (power === 2) {
          const t = 2 * Zr0 + dr, u = 2 * Zi0 + di;
          const ndr = t * dr - u * di + dcr;
          const ndi = t * di + u * dr + dci;
          dr = ndr; di = ndi;
        } else {
          let zpr = 1, zpi = 0;
          for (let k = 0; k < power - 1; k++) {
            const r2 = zpr * Zr0 - zpi * Zi0, i2 = zpr * Zi0 + zpi * Zr0;
            zpr = r2; zpi = i2;
          }
          let dkr = dr, dki = di;
          let sr = 0, si = 0, binom = 1;
          for (let k = 1; k <= power; k++) {
            binom = (binom * (power - k + 1)) / k;
            sr += binom * (zpr * dkr - zpi * dki);
            si += binom * (zpr * dki + zpi * dkr);
            if (k < power) {
              const r2 = dkr * dr - dki * di, i2 = dkr * di + dki * dr;
              dkr = r2; dki = i2;
              const za = zpr * Zr0 - zpi * Zi0, zb = zpr * Zi0 + zpi * Zr0;
              zpr = za; zpi = zb;
            }
          }
          dr = sr + dcr; di = si + dci;
        }
      }
      }

      if (glitch) {
        glitchCount++;
        if (glitchList.length < MAXFIX * 2) glitchList.push(gx, gy);
      }
      if (job.debugN) { data[o] = n & 255; data[o + 1] = (n >> 8) & 255; data[o + 2] = Math.min(255, Math.log(m2) * 10) | 0; data[o + 3] = 255; }
      else if (esc === 1) {
        writeColor(lut, smoothIter(n, m2, power) * bandScale + offset, data, o);
      } else {
        data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2];
      }
      data[o + 3] = 255;
      o += 4;
    }
  }

  let fixed = 0;
  if (glitchList.length) fixed = fixGlitches(job, bits, lut, data, glitchList);

  return { data, mode: useDd ? 'perturb-dd' : 'perturb', glitches: glitchCount, fixed, refLen: oLen };
}

function fixGlitches(job, bits, lut, data, list, mask, maxClusters, preRefs) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const ps = job.pixelSize;
  const halfW = width * 0.5, halfH = height * 0.5;
  const spec = job.spec, power = spec.power | 0;
  /* Secondary references must run in the same numeric regime as the primary
   * pass.  A double-only repair orbit at 1e-28 reintroduces exactly the
   * 1e-16 truncation the dd path removes, so repaired pixels would stay
   * noisier than their neighbours. */
  const useDd = power === 2 && job.noDd !== true &&
    (job.psLog2 != null ? job.psLog2 <= -46 : Math.abs(ps) < 1e-14);

  const count = list.length / 2;
  const CELL = 12;
  const clusters = new Map();
  for (let i = 0; i < count; i++) {
    const px = list[i * 2], py = list[i * 2 + 1];
    const key = (((px - x) / CELL) | 0) * 4096 + (((py - y) / CELL) | 0);
    const e = clusters.get(key);
    if (e) { e.n++; e.sx += px; e.sy += py; }
    else clusters.set(key, { n: 1, sx: px, sy: py });
  }
  const picks = [...clusters.values()].sort((a, b) => b.n - a.n).slice(0, maxClusters || 4);
  if (!picks.length) return 0;

  const refs = [];
  for (const c of picks) {
    const cxp = c.sx / c.n, cyp = c.sy / c.n;
    const centerHP = {
      re: offsetCoord(job.center.re, (cxp + 0.5 - halfW) * ps, bits),
      im: offsetCoord(job.center.im, -(cyp + 0.5 - halfH) * ps, bits)
    };
    const orb = buildReferenceOrbit(spec, centerHP, bits, maxIter, BAIL2, useDd);
    orb.refPx = cxp + 0.5; orb.refPy = cyp + 0.5;   // see pickReference()
    if (orb.len > 16) refs.push({ orbit: orb, px: cxp + 0.5, py: cyp + 0.5 });
  }
  if (!refs.length) return 0;

  let fixed = 0;
  for (let i = 0; i < count; i++) {
    const px = list[i * 2], py = list[i * 2 + 1];
    for (const ref of refs) {
      const orb = ref.orbit;
      const dcr = (px + 0.5 - ref.px) * ps;
      const dci = -(py + 0.5 - ref.py) * ps;
      let dr = dcr, di = dci, n = 0, m2 = 0, esc = 0;
      if (useDd) {
        let drh = dcr, drl = 0, dih = dci, dil = 0;
        for (; n < maxIter; n++) {
          if (n >= orb.len) { esc = 2; break; }
          const Zr0 = orb.re[n], Zi0 = orb.im[n];
          const Zr0L = orb.reLo[n], Zi0L = orb.imLo[n];
          const zr = Zr0 + drh, zi = Zi0 + dih;
          m2 = zr * zr + zi * zi;
          if (m2 > BAIL2) { esc = 1; break; }
          const dz = [drh, drl], dzi = [dih, dil];
          const tz = ddAdd([2 * Zr0, 2 * Zr0L], dz);
          const ti = ddAdd([2 * Zi0, 2 * Zi0L], dzi);
          const nr = ddAdd(ddSub(ddMul(tz, dz), ddMul(ti, dzi)), [dcr, 0]);
          const ni = ddAdd(ddAdd(ddMul(tz, dzi), ddMul(ti, dz)), [dci, 0]);
          drh = nr[0]; drl = nr[1];
          dih = ni[0]; dil = ni[1];
        }
      } else {
        for (; n < maxIter; n++) {
          if (n >= orb.len) { esc = 2; break; }
          const Zr0 = orb.re[n], Zi0 = orb.im[n];
          const zr = Zr0 + dr, zi = Zi0 + di;
          m2 = zr * zr + zi * zi;
          if (m2 > BAIL2) { esc = 1; break; }
          const t = 2 * Zr0 + dr, u = 2 * Zi0 + di;
          const ndr = t * dr - u * di + dcr;
          const ndi = t * di + u * dr + dci;
          dr = ndr; di = ndi;
        }
      }
      if (esc === 2) continue;   // this secondary orbit escaped before the pixel: try the next one
      if (power !== 2 && esc !== 1) { /* higher powers only accept the repair computed for power 2 */ }
      const oo = ((py - y) * w + (px - x)) * 4;
      if (esc === 0) {
        data[oo] = INTERIOR[0]; data[oo + 1] = INTERIOR[1]; data[oo + 2] = INTERIOR[2];
      } else {
        writeColor(lut, smoothIter(n, m2, power) * bandScale + offset, data, oo);
      }
      fixed++;
      break;
    }
  }
  return fixed;
}

/** Build the fixed-point value (val × 2^exp) so that doubles cannot underflow */
function scaledOffset(ctx, val, exp) {
  return ctx.shl(ctx.fromNumber(val), exp);
}

function offsetCoord(baseStr, delta, bits) {
  const ctx = contextFor(Math.max(bits, 128));
  const b = ctx.fromString(baseStr);
  const d = ctx.fromNumber(delta);
  return ctx.toString(b + d, Math.ceil(bits * 0.32) + 8);
}

/* ---------------- Direct high precision ---------------- */

function renderHpDirect(job, bits, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const ctx = contextFor(bits);
  const F = ctx.FB, HALF = ctx.HALF;
  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> F : -((-p + HALF) >> F); };
  const sq = (a) => mul(a, a);
  const halfW = width * 0.5, halfH = height * 0.5;
  const spec = job.spec, kc = KIND_CODE[spec.kind] || 0;
  const isJulia = spec.mode === 'j';
  const cr0 = ctx.fromString(isJulia ? spec.julia.re : job.center.re);
  const ci0 = ctx.fromString(isJulia ? spec.julia.im : job.center.im);
  const zx0 = ctx.fromString(job.center.re), zy0 = ctx.fromString(job.center.im);
  const bailSq = ctx.fromNumber(BAIL2);
  const psMant = job.psMant != null ? job.psMant : ps;
  const psExp = job.psExp != null ? job.psExp : 0;
  const ph = ctx.fromNumber(spec.phoenixP != null ? spec.phoenixP : 0.5667);
  /* Periodicity tolerance.  The old 1e-13 (squared 1e-26) is far too loose for
   * deep zooms: near a parabolic/minibrot structure an escaping orbit can
   * revisit an earlier state within 1e-13 long before it escapes, which
   * misclassifies boundary pixels as interior (hard black specks).  A true
   * attracting cycle closes to the working precision, so 1e-20 is both safe
   * and still an effective early exit. */
  const perSq = mul(ctx.fromNumber(1e-20), ctx.fromNumber(1e-20));
  let o = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = scaledOffset(ctx, (x + px + 0.5 - halfW) * psMant, psExp);
      const sy = scaledOffset(ctx, (-(y + py + 0.5 - halfH)) * psMant, psExp);
      let cr, ci, zr, zi, pr = 0n, pi = 0n;
      if (isJulia) {
        cr = cr0; ci = ci0;
        zr = ctx.add(zx0, sx); zi = ctx.add(zy0, sy);
      } else {
        cr = ctx.add(cr0, sx); ci = ctx.add(ci0, sy);
        zr = 0n; zi = 0n;
      }
      let n = 0, m2 = 0, done = false;
      /* Periodicity bailout.  Interior pixels are the majority of a deep
       * frame and would otherwise burn the entire iteration budget in BigInt;
       * detecting a recurring orbit returns them early (same rule as the
       * kernel's period check). */
      let chkR = 0n, chkI = 0n, chkOn = false;
      for (; n < maxIter; n++) {
        const ar = sq(zr), bi = sq(zi);
        if (ar + bi > bailSq) { m2 = ctx.toNumber(ar + bi); done = true; break; }
        let nr, ni;
        switch (kc) {
          case 1: nr = ar - bi; ni = -2n * mul(zr, zi); break;
          case 2: {
            const ax = zr < 0n ? -zr : zr, ay = zi < 0n ? -zi : zi;
            nr = mul(ax, ax) - mul(ay, ay); ni = 2n * mul(ax, ay); break;
          }
          case 3: {
            let t = ar - bi; if (t < 0n) t = -t;
            nr = t; ni = 2n * mul(zr, zi); break;
          }
          case 4: {
            const ax = zr < 0n ? -zr : zr, ay = zi < 0n ? -zi : zi;
            nr = ar - bi; ni = 2n * mul(ax, ay); break;
          }
          case 5: {
            nr = ar - bi + mul(ph, pr); ni = 2n * mul(zr, zi) + mul(ph, pi);
            pr = zr; pi = zi; break;
          }
          default: nr = ar - bi; ni = 2n * mul(zr, zi);
        }
        zr = nr + cr; zi = ni + ci;
        if (!chkOn) {
          if (n >= 12) { chkR = zr; chkI = zi; chkOn = true; }
        } else if ((n & 63) === 0) {
          const dx = zr - chkR, dy = zi - chkI;
          if (dx * dx + dy * dy < perSq) { done = false; n = maxIter; break; }
        }
      }
      if (job.debugN) { data[o] = n & 255; data[o + 1] = (n >> 8) & 255; data[o + 2] = Math.min(255, Math.log(m2) * 10) | 0; data[o + 3] = 255; }
      else if (!done) {
        data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2];
      } else {
        writeColor(lut, smoothIter(n, m2, 2) * bandScale + offset, data, o);
      }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { data, mode: 'hp', glitches: 0, refLen: 0 };
}

/* ---------------- Newton sets ---------------- */

function newtonCycle(n, dist, root, bandCount, offset, maxIter) {
  return (n + 1 - Math.log2(Math.max(dist, 1e-15)) / 8) / Math.max(bandCount, 1) + root * 0.173 + offset;
}

function renderNewton(job, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const halfW = width * 0.5, halfH = height * 0.5;
  const d = Math.max(2, job.spec.newtonDegree | 0);
  const cxe = parseFloat(job.center.re), cye = parseFloat(job.center.im);
  const roots = [];
  for (let k = 0; k < d; k++) {
    const a = (2 * Math.PI * k) / d;
    roots.push([Math.cos(a), Math.sin(a)]);
  }
  const EPS = 1e-12;
  let o = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let zr = cxe + (x + px + 0.5 - halfW) * ps;
      let zi = cye - (y + py + 0.5 - halfH) * ps;
      let n = 0, root = -1, dist = 1;
      for (; n < maxIter; n++) {
        let pr = 1, pi = 0;
        for (let k = 0; k < d - 1; k++) {
          const r2 = pr * zr - pi * zi, i2 = pr * zi + pi * zr;
          pr = r2; pi = i2;
        }
        const qr = pr * zr - pi * zi - 1, qi = pr * zi + pi * zr;
        const dr_ = d * pr, di_ = d * pi;
        const den = dr_ * dr_ + di_ * di_;
        if (den < 1e-300) break;
        zr -= (qr * dr_ + qi * di_) / den;
        zi -= (qi * dr_ - qr * di_) / den;
        if (n > 3) {
          for (let k = 0; k < d; k++) {
            const ex = zr - roots[k][0], ey = zi - roots[k][1];
            const dd = ex * ex + ey * ey;
            if (dd < EPS) { root = k; dist = Math.sqrt(dd); break; }
          }
          if (root >= 0) break;
        }
      }
      if (root >= 0) writeColor(lut, newtonCycle(n, dist, root, job.cycle, offset, maxIter), data, o);
      else { data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2]; }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { data, mode: 'newton', glitches: 0, refLen: 0 };
}

function renderNewtonHP(job, bits, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const ctx = contextFor(bits);
  const F = ctx.FB, HALF = ctx.HALF;
  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> F : -((-p + HALF) >> F); };
  const halfW = width * 0.5, halfH = height * 0.5;
  const d = Math.max(2, job.spec.newtonDegree | 0);
  const dBig = BigInt(d);
  const one = ctx.ONE;
  const cxe = ctx.fromString(job.center.re), cye = ctx.fromString(job.center.im);
  const psMant = job.psMant != null ? job.psMant : ps;
  const psExp = job.psExp != null ? job.psExp : 0;
  const eps = ctx.fromNumber(1e-12);
  const roots = [];
  for (let k = 0; k < d; k++) {
    const a = (2 * Math.PI * k) / d;
    roots.push([ctx.fromNumber(Math.cos(a)), ctx.fromNumber(Math.sin(a))]);
  }
  let o = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = scaledOffset(ctx, (x + px + 0.5 - halfW) * psMant, psExp);
      const sy = scaledOffset(ctx, (-(y + py + 0.5 - halfH)) * psMant, psExp);
      let zr = ctx.add(cxe, sx), zi = ctx.add(cye, sy);
      let n = 0, root = -1, dist = 1;
      for (; n < maxIter; n++) {
        let pr = one, pi = 0n;
        for (let k = 0; k < d - 1; k++) {
          const r2 = mul(pr, zr) - mul(pi, zi), i2 = mul(pr, zi) + mul(pi, zr);
          pr = r2; pi = i2;
        }
        const qr = mul(pr, zr) - mul(pi, zi) - one;
        const qi = mul(pr, zi) + mul(pi, zr);
        const dr_ = mul(dBig, pr), di_ = mul(dBig, pi);
        const den = mul(dr_, dr_) + mul(di_, di_);
        if (den === 0n) break;
        const numR = mul(qr, dr_) + mul(qi, di_);
        const numI = mul(qi, dr_) - mul(qr, di_);
        zr -= (numR << F) / den;
        zi -= (numI << F) / den;
        if (n > 3) {
          for (let k = 0; k < d; k++) {
            const ex = zr - roots[k][0], ey = zi - roots[k][1];
            const dd = mul(ex, ex) + mul(ey, ey);
            if (dd < eps) {
              root = k;
              dist = Math.sqrt(Math.max(0, ctx.toNumber(dd)));
              break;
            }
          }
          if (root >= 0) break;
        }
      }
      if (root >= 0) writeColor(lut, newtonCycle(n, dist, root, job.cycle, offset, maxIter), data, o);
      else { data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2]; }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { data, mode: 'newton-hp', glitches: 0, refLen: 0 };
}

/* ---------------- Custom formulas ---------------- */

function renderCustom(job, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const halfW = width * 0.5, halfH = height * 0.5;
  const cxe = parseFloat(job.center.re), cye = parseFloat(job.center.im);
  const spec = job.spec;
  const isJulia = spec.mode === 'j';
  const jr = spec.julia ? parseFloat(spec.julia.re) : 0;
  const ji = spec.julia ? parseFloat(spec.julia.im) : 0;
  const fn = job.customFn;
  if (!fn && !job.customStep) throw new Error('custom formula has not been compiled');
  const step = job.customStep;
  const OUT = job.customOut || (job.customOut = new Float64Array(4));
  const P = job.customParams || new Float64Array(8);
  const S = { zpr: 0, zpi: 0, cr: 0, ci: 0, on: 0 };
  let o = 0;
  /* Escape span over the whole tile: the HUD's "no structure" hint reads this,
   * so it must come from the pixels, not from a placeholder. */
  let escLo = Infinity, escHi = -Infinity, bounded = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const ox = (x + px + 0.5 - halfW) * ps;
      const oy = -(y + py + 0.5 - halfH) * ps;
      const cr = isJulia ? jr : cxe + ox;
      const ci = isJulia ? ji : cye + oy;
      const zr0 = isJulia ? cxe + ox : 0;
      const zi0 = isJulia ? cye + oy : 0;
      let n = 0, m2 = 0, escaped = false;

      if (step) {
        step(zr0, zi0, cr, ci, P, maxIter, S, OUT);
        n = OUT[0] | 0;
        m2 = OUT[1];
        escaped = n < maxIter && m2 >= 0;
      } else {
        let zr = zr0, zi = zi0;
        S.zpr = 0; S.zpi = 0;
        for (; n < maxIter; n++) {
          fn(zr, zi, cr, ci, P, n, S, OUT);
          S.zpr = zr; S.zpi = zi;
          zr = OUT[0]; zi = OUT[1];
          m2 = zr * zr + zi * zi;
          if (!(m2 === m2) || m2 > BAIL2) break;
        }
        escaped = n < maxIter;
      }

      if (!escaped) { data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2]; bounded++; }
      else {
        if (n < escLo) escLo = n;
        if (n > escHi) escHi = n;
        writeColor(lut, smoothIter(n, m2, 2) * bandScale + offset, data, o);
      }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { data, mode: 'custom', glitches: 0, refLen: 0,
    escMin: escLo === Infinity ? 0 : escLo, escMax: escHi === -Infinity ? 0 : escHi, bounded };
}

/* ---------------- Custom formulas · full high-precision direct (reference / fallback) ---------------- */

function renderCustomHpDirect(job, bits, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const spec = job.spec;
  const K = makeBigContext(bits);
  const ctx = K.ctx;
  const dbl = compileDouble(spec.customExpr);
  const evalBig = compileBig(dbl.ast, { bits, ctx: K, params: dbl.params });

  const cp = spec.customParams || {};
  const P = dbl.params.map((name) => {
    const v = Number(cp[name]);
    return [ctx.fromNumber(Number.isFinite(v) ? v : 0), 0n];
  });

  const halfW = width * 0.5, halfH = height * 0.5;
  const c0r = ctx.fromString(job.center.re), c0i = ctx.fromString(job.center.im);
  const psMant = job.psMant != null ? job.psMant : job.pixelSize;
  const psExp = job.psExp != null ? job.psExp : 0;
  const bail = ctx.fromNumber(BAIL2);
  const st = { z: [0n, 0n], c: [0n, 0n], n: 0, zp: [0n, 0n], P, loopVal: 0n };
  let o = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = (x + px + 0.5 - halfW) * psMant;
      const dy = -(y + py + 0.5 - halfH) * psMant;
      st.c = [
        c0r + ctx.shl(ctx.fromNumber(dx), psExp),
        c0i + ctx.shl(ctx.fromNumber(dy), psExp)
      ];
      st.z = [0n, 0n];
      let n = 0, m2 = 0, escaped = false;
      for (; n < maxIter; n++) {
        const zr = st.z[0], zi = st.z[1];
        m2 = ctx.toNumber(K.mul(zr, zr) + K.mul(zi, zi));
        if (m2 > BAIL2) { escaped = true; break; }
        if (n === maxIter - 1) break;
        st.n = n;
        st.zp = st.z;
        st.z = evalBig(st);
      }
      if (escaped) writeColor(lut, smoothIter(n, m2, 2) * bandScale + offset, data, o);
      else { data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2]; }
      data[o + 3] = 255;
      o += 4;
    }
  }
  return { data, mode: 'custom-hp', glitches: 0, refLen: 0, fixed: 0 };
}

/* ---------------- Custom formulas · second-order perturbation ---------------- */

/**
 * For an arbitrary formula F(z, c), write each pixel as reference point + δ:
 *   ε_{n+1} = A ε + B δ + ½C ε² + D εδ + ½E δ²
 * where A..E are the first/second-order partial derivatives along the reference orbit (computed in double precision).
 * For z² + c it degrades automatically to the standard Mandelbrot perturbation.
 */
function renderCustomPerturb(job, lut) {
  const { x, y, w, h, width, height, maxIter, offset } = job;
  const bandScale = 1 / Math.max(job.cycle, 1);
  const data = makeTile(w, h);
  const ps = job.pixelSize;
  const halfW = width * 0.5, halfH = height * 0.5;
  const env = job.customEnv;
  const Zr = env.re, Zi = env.im, oLen = env.len;
  const D = env.deriv;
  const refPx = env.refPx, refPy = env.refPy;

  const isJet = D.kind === 'jet';
  const K = isJet ? D.order : 0;
  const W = D.width;
  const coef = D.coef;

  let glitchCount = 0;
  let o = 0;
  /* Real escape span for the HUD; see renderCustom. */
  let escLo = Infinity, escHi = -Infinity, bounded = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = x + px, gy = y + py;
      const dx = (gx + 0.5 - refPx) * ps;
      const dy = -(gy + 0.5 - refPy) * ps;
      let er = 0, ei = 0;
      let n = 0, m2 = 0, esc = 0, glitch = false;

      for (; n < maxIter; n++) {
        if (n >= oLen) {
          const zr = Zr[oLen] + er, zi = Zi[oLen] + ei;
          m2 = zr * zr + zi * zi;
          n = oLen - 1;
          if (m2 > BAIL2) esc = 1; else glitch = true;
          break;
        }
        const ZR = Zr[n], ZI = Zi[n];
        const zr = ZR + er, zi = ZI + ei;
        m2 = zr * zr + zi * zi;
        if (m2 > BAIL2) { esc = 1; break; }
        const e2 = er * er + ei * ei;
        if (m2 < e2 * 1e-6) glitch = true;
        // Non-polynomial formulas: the truncated series diverges once |ε| grows, so flag it
        if (!D.exact && e2 > 0.36) { glitch = true; break; }

        let ner, nei;
        if (isJet) {
          const base = n * W * 2;
          // p(ε) = p1 + p2 ε + … + pK ε^{K-1}
          let pr = 0, pi = 0;
          for (let k = K; k >= 1; k--) {
            const off = base + (k - 1) * 2;
            const cr = coef[off], ci = coef[off + 1];
            const nr = pr * er - pi * ei + cr;
            const ni = pr * ei + pi * er + ci;
            pr = nr; pi = ni;
          }
          // q(ε) = q0 + q1 ε + … + qK ε^K
          let qr = 0, qi = 0;
          for (let k = K; k >= 0; k--) {
            const off = base + K * 2 + k * 2;
            const cr = coef[off], ci = coef[off + 1];
            const nr = qr * er - qi * ei + cr;
            const ni = qr * ei + qi * er + ci;
            qr = nr; qi = ni;
          }
          ner = (er * pr - ei * pi) + (dx * qr - dy * qi);
          nei = (er * pi + ei * pr) + (dx * qi + dy * qr);
        } else {
          // Linear: ε' = A ε + B δ
          const off = n * 4;
          const Ar = coef[off], Ai = coef[off + 1], Br = coef[off + 2], Bi = coef[off + 3];
          ner = (Ar * er - Ai * ei) + (Br * dx - Bi * dy);
          nei = (Ar * ei + Ai * er) + (Br * dy + Bi * dx);
        }
        er = ner; ei = nei;
        if (!Number.isFinite(er) || !Number.isFinite(ei)) { glitch = true; break; }
      }

      if (glitch) glitchCount++;
      if (esc === 1) {
        writeColor(lut, smoothIter(n, m2, 2) * bandScale + offset, data, o);
        if (n < escLo) escLo = n;
        if (n > escHi) escHi = n;
      } else { data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2]; bounded++; }
      data[o + 3] = 255;
      o += 4;
    }
  }

  return {
    data, mode: isJet ? 'custom-jet' : 'custom-linear',
    glitches: glitchCount, refLen: oLen, fixed: 0,
    escMin: escLo === Infinity ? 0 : escLo, escMax: escHi === -Infinity ? 0 : escHi, bounded
  };
}

// Test exports (not used by the runtime logic)
export const _internals = { renderDirect, renderPerturb, renderHpDirect, pickReference, orbitWithPairs, fixGlitches, renderCustomHpDirect, renderCustomPerturb };
