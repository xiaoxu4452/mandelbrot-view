/* ------------------------------------------------------------------
 * worker.js — render thread
 *   · WebAssembly kernel (hot paths: direct / perturbation / Newton)
 *   · Pure-JS fallback (custom formulas, environments without WASM)
 *   · High-precision reference orbits (BigInt) are computed and cached on this thread
 * ----------------------------------------------------------------*/

import { KERNEL_B64 } from './kernel-wasm.js';
import { paletteLUT, registerCustomPalette } from './palettes.js';
import { resolveBitsFromLog2, requiredBitsFromLog2, contextFor } from './bigfixed.js';
import { renderTile, _internals } from './render.js';
import { compile as compileMath } from './mathlib.js';
import { buildSeries, chooseSkip } from './environment.js';
import { buildCustomEnvironment } from './customenv.js';
import { buildReferenceOrbit } from './formulas.js';

/* ---------- WASM memory layout ---------- */
const OUT = 65536;
const OUT_CAP = 256 * 256 * 4;
const LUT_PTR = OUT + OUT_CAP;
const PARAMS = LUT_PTR + 2048;
const ROOTS = PARAMS + 512;
const STATS = ROOTS + 256;            // 3 doubles written by the kernel: nMin, nMax, nMaxExceptCentre
const GLITCH = ROOTS + 1024;          // int32 pairs (x, y) reported by the kernel
const GLITCH_CAP = 8192;
const ORBIT = GLITCH + GLITCH_CAP * 8;

let wasm = null;         // { render, memory }
let heap = null;         // Uint8Array view
let params = null;       // Float64Array view
let memBytes = 0;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function initWasm() {
  try {
    const bytes = b64ToBytes(KERNEL_B64);
    const mod = await WebAssembly.compile(bytes);
    const inst = await WebAssembly.instantiate(mod, { env: { abort() { throw new Error('wasm abort'); } } });
    wasm = inst.exports;
    growMem(1024 * 1024);
    return true;
  } catch (e) {
    console.warn('WASM unavailable, falling back to JS rendering', e);
    wasm = null;
    return false;
  }
}

function growMem(bytes) {
  const mem = wasm.memory;
  const need = Math.ceil((ORBIT + bytes) / 65536) * 65536;
  if (mem.buffer.byteLength < need) {
    mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
  }
  memBytes = need;
  heap = new Uint8Array(mem.buffer);
  params = new Float64Array(mem.buffer, PARAMS, 64);
}

/* ---------- Reference-orbit cache ---------- */
let orbitCacheEntry = null;   // { key, ptr, len, stride, refPx, refPy }

function viewKey(job, bits) {
  const s = job.spec;
  return [s.mode, s.kind, s.power, s.julia ? s.julia.re + ',' + s.julia.im : '',
    job.center.re, job.center.im, job.span.m, job.span.e, job.width, job.height,
    job.maxIter, bits, s.phoenixP, s.newtonDegree].join('|');
}

/**
 * Build the "environment" for this view: high-precision reference orbit + series-approximation coefficients.
 * This is the most expensive part of any deep render, so it is cached per view and shared by every tile.
 */
/**
 * Elect a reference point **inside the tile**.
 *
 * A single view-wide reference is fine for shallow zooms, but at 10^14+ the
 * distance from the reference to the far corner of the frame spans thousands
 * of pixels, which makes the perturbation recursion lose precision for ~10% of
 * the pixels (the black blobs of the previous build).  Electing one orbit per
 * tile keeps every pixel within ~90 px of its reference: the glitch rate drops
 * by an order of magnitude and the repair pass becomes almost free.
 *
 * Stopping at the first interior point is safe — an interior reference never
 * escapes, which is the best possible orbit for perturbation.
 */
function pickTileReference(job, bits) {
  const ps = job.pixelSize;
  const W = job.width, H = job.height;
  const G = 3;
  const cands = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) cands.push([(i + 0.5) / G, (j + 0.5) / G]);
  cands.sort((a, b) => Math.hypot(a[0] - 0.5, a[1] - 0.5) - Math.hypot(b[0] - 0.5, b[1] - 0.5));

  let best = null;
  for (const [fx, fy] of cands) {
    const px = job.x + fx * job.w, py = job.y + fy * job.h;
    const ox = (px + 0.5 - W * 0.5) * ps;
    const oy = -(py + 0.5 - H * 0.5) * ps;
    const c = {
      re: shiftCoordHP(job.center.re, ox, bits),
      im: shiftCoordHP(job.center.im, oy, bits)
    };
    const orb = buildReferenceOrbit(job.spec, c, bits, job.maxIter, 1e20);
    orb.refPx = px + 0.5;       // pixel (px) is sampled at px + 0.5
    orb.refPy = py + 0.5;
    orb.lifetime = orb.escaped ? orb.len : job.maxIter;
    if (!best || orb.lifetime > best.lifetime) best = orb;
    if (!orb.escaped) break;
  }
  return best;
}

function ensureOrbit(job, bits) {
  const key = viewKey(job, bits);
  if (orbitCacheEntry && orbitCacheEntry.key === key) return orbitCacheEntry;

  self.postMessage({ type: 'stage', stage: 'orbit' });
  const orb = _internals.pickReference(job, bits);
  /* Double-double reference.
   *
   * Below a pixel spacing of ~1e-15 the 53-bit reference orbit is no longer a
   * usable approximation: its per-step rounding (≈1e-16) is amplified by the
   * orbit derivative and swamps the perturbation, which is what makes the
   * picture turn into mosaics past 1e17 zoom.  Rebuilding the elected orbit
   * with (hi, lo) pairs costs one extra high-precision pass (once per view) and
   * lets the kernel run the double-double perturbation instead. */
  const dd = bits > 64 && (job.psLog2 == null || job.psLog2 <= -46);
  const orbFull = dd ? _internals.orbitWithPairs(job, bits) : orb;
  const stride = job.maxIter + 1;
  const bytes = stride * (dd ? 32 : 16) + 64;
  growMem(bytes + 1024);

  heap.set(new Uint8Array(orbFull.re.buffer, orbFull.re.byteOffset, orbFull.re.byteLength), ORBIT);
  heap.set(new Uint8Array(orbFull.im.buffer, orbFull.im.byteOffset, orbFull.im.byteLength), ORBIT + stride * 8);
  if (dd) {
    heap.set(new Uint8Array(orbFull.reLo.buffer, orbFull.reLo.byteOffset, orbFull.reLo.byteLength), ORBIT + stride * 16);
    heap.set(new Uint8Array(orbFull.imLo.buffer, orbFull.imLo.byteOffset, orbFull.imLo.byteLength), ORBIT + stride * 24);
  }

  // ---- Series approximation (only valid for z -> z^2 + c) ----
  // Skipped on the double-double path: the SA coefficients are plain doubles,
  // so they reintroduce exactly the 1e-16 truncation the dd pass removes.
  let series = null;
  if ((job.spec.power | 0) === 2 && !dd) {
    self.postMessage({ type: 'stage', stage: 'env' });
    const built = buildSeries(orb, job.maxIter, job.spec.mode === 'j', job.pixelSize);
    const ps = job.pixelSize;
    const far = Math.max(
      Math.hypot(orb.refPx, orb.refPy),
      Math.hypot(job.width - orb.refPx, orb.refPy),
      Math.hypot(orb.refPx, job.height - orb.refPy),
      Math.hypot(job.width - orb.refPx, job.height - orb.refPy)
    );
    series = chooseSkip(built, (far + 1) * ps, job.maxIter);
  }

  orbitCacheEntry = {
    key, ptr: ORBIT, len: orb.len, stride,
    refPx: orb.refPx, refPy: orb.refPy, series, dd
  };
  return orbitCacheEntry;
}

/* ---------- High-precision environment for custom formulas ---------- */
let customEnvEntry = null;

/* ---------- Secondary references for glitch repair ---------- *
 *
 * Repairing a glitched pixel means re-running it against a reference orbit
 * that sits close to it.  Building such an orbit costs a full high-precision
 * pass, so a small set of view-level references is shared by every tile of
 * the frame; per-pixel repair then only re-runs the perturbation recursion.
 */
let glitchRefsEntry = null;

function ensureGlitchRefs(job, bits) {
  const key = viewKey(job, bits) + '|glitch';
  if (glitchRefsEntry && glitchRefsEntry.key === key) return glitchRefsEntry.refs;

  const ps = job.pixelSize;
  const W = job.width, H = job.height;
  const spots = [[0.5, 0.5], [0.17, 0.17], [0.83, 0.17], [0.17, 0.83], [0.83, 0.83]];
  const refs = [];
  for (const [fx, fy] of spots) {
    const px = fx * W, py = fy * H;
    const c = {
      re: shiftCoordHP(job.center.re, (px + 0.5 - W * 0.5) * ps, bits),
      im: shiftCoordHP(job.center.im, -(py + 0.5 - H * 0.5) * ps, bits)
    };
    const orb = buildReferenceOrbit(job.spec, c, bits, job.maxIter, 1e20);
    orb.refPx = px + 0.5;       // pixel (px) is sampled at px + 0.5
    orb.refPy = py + 0.5;
    if (orb.len > 16) refs.push({ orbit: orb, px: px + 0.5, py: py + 0.5 });
  }
  glitchRefsEntry = { key, refs };
  return refs;
}

function customEnvKey(job, bits) {
  const sp = job.spec;
  const cp = sp.customParams || {};
  const key = Object.keys(cp).sort().map(k => k + '=' + cp[k]).join(',');
  return [sp.customExpr, sp.mode, key, job.center.re, job.center.im,
    job.span.m, job.span.e, job.width, job.height, job.maxIter, bits].join('|');
}

/**
 * Pick the point that "lives longest" inside the viewport as the reference point:
 * a custom formula offers no analytic structure, so the high-precision orbits of a few candidates are measured.
 */
function ensureCustomEnv(job, bits) {
  const key = customEnvKey(job, bits);
  if (customEnvEntry && customEnvEntry.key === key) return customEnvEntry;

  self.postMessage({ type: 'stage', stage: 'orbit' });
  const ps = job.pixelSize;
  const cands = [[0.5, 0.5], [0.3, 0.35], [0.7, 0.35], [0.3, 0.7], [0.7, 0.7]];
  let best = null, bestPx = job.width / 2, bestPy = job.height / 2;
  for (const [fx, fy] of cands) {
    const px = fx * job.width, py = fy * job.height;
    const ox = (px + 0.5 - job.width * 0.5) * ps;
    const oy = -(py + 0.5 - job.height * 0.5) * ps;
    const c = {
      re: shiftCoordHP(job.center.re, ox, bits),
      im: shiftCoordHP(job.center.im, oy, bits)
    };
    const env = buildCustomEnvironment(job.spec, c, bits, job.maxIter);
    if (!best || env.len > best.len) { best = env; bestPx = px; bestPy = py; }
    if (!env.escaped) break;
    if (best.len > job.maxIter * 0.9) break;
  }
  best.refPx = bestPx + 0.5;    // pixel (px) is sampled at px + 0.5
  best.refPy = bestPy + 0.5;
  customEnvEntry = { key, env: best };
  return customEnvEntry;
}

/** High-precision shift of a coordinate by a double offset. */
function shiftCoordHP(base, delta, bits) {
  const ctx = contextFor(Math.max(bits, 128));
  const b = ctx.fromString(base);
  const d = ctx.fromNumber(delta);
  return ctx.toString(b + d, Math.ceil(bits * 0.3) + 12);
}

/* ---------- Custom-formula cache ---------- */
const formulaCache = new Map();
function customFnFor(job) {
  const src = (job.spec.customExpr || '').trim();
  if (!src) throw new Error('custom formula is empty');
  let entry = formulaCache.get(src);
  if (!entry) {
    const r = compileMath(src);
    entry = { fn: r.fn, step: r.step, params: r.params || [] };
    if (formulaCache.size > 40) formulaCache.delete(formulaCache.keys().next().value);
    formulaCache.set(src, entry);
  }
  const cp = job.spec.customParams || {};
  const P = new Float64Array(16);
  entry.params.forEach((name, i) => {
    const v = Number(cp[name]);
    P[i] = Number.isFinite(v) ? v : 0;
  });
  return { fn: entry.fn, step: entry.step, P };
}

/* ---------- Job handling ---------- */

let lutPalette = null;
let lutBytes = null;

/** Upload the palette LUT into the kernel heap and cache it for JS repair. */
function setLut(palette, stops) {
  // A user-defined palette travels with its stops: the worker has no
  // localStorage, so the main thread ships the table definition in the job.
  if (stops) registerCustomPalette(palette, stops);
  const lut = paletteLUT(palette);
  if (lut === lutBytes) return lutBytes;
  heap.set(lut, LUT_PTR);
  lutBytes = lut;
  lutPalette = palette;
  return lut;
}

function setupParams(job, mode, extra) {
  const spec = job.spec;
  const p = params;
  p[0] = mode;
  p[1] = spec.kind === 'mandelbrot' || spec.kind === 'multibrot' ? 0 :
    spec.kind === 'tricorn' ? 1 :
      spec.kind === 'burningship' ? 2 :
        spec.kind === 'celtic' ? 3 :
          spec.kind === 'perpendicular' ? 4 : 5;
  p[2] = spec.power || 2;
  p[3] = spec.mode === 'j' ? 1 : 0;
  p[4] = job.x; p[5] = job.y; p[6] = job.w; p[7] = job.h;
  p[8] = job.width; p[9] = job.height;
  p[10] = parseFloat(job.center.re);
  p[11] = parseFloat(job.center.im);
  p[12] = job.pixelSize;
  p[13] = spec.julia ? parseFloat(spec.julia.re) : 0;
  p[14] = spec.julia ? parseFloat(spec.julia.im) : 0;
  p[15] = job.maxIter;
  p[16] = job.cycle;
  p[17] = job.offset;
  p[18] = OUT;
  p[19] = LUT_PTR;
  p[20] = extra ? extra.orbitPtr : 0;
  p[21] = extra ? extra.orbitLen : 0;
  p[22] = extra ? extra.refPx : 0;
  p[23] = extra ? extra.refPy : 0;
  p[24] = spec.phoenixP != null ? spec.phoenixP : 0.5667;
  p[25] = 1;
  p[26] = spec.newtonDegree || 3;
  p[27] = ROOTS;
  p[28] = extra ? extra.stride : 1;
  // Series approximation
  const sa = extra && extra.series;
  p[29] = sa ? sa.skip : 0;
  p[30] = sa ? sa.ar : 0; p[31] = sa ? sa.ai : 0;
  p[32] = sa ? sa.br : 0; p[33] = sa ? sa.bi : 0;
  p[34] = sa ? sa.cr : 0; p[35] = sa ? sa.ci : 0;
  p[36] = sa ? sa.radius : 0;
  p[37] = sa ? 1 : 0;
  p[38] = GLITCH;
  p[39] = GLITCH_CAP;
  p[40] = extra && extra.dd ? 1 : 0;
  // Distance-estimate rim (see dePixels in kernel.cpp): on unless disabled.
  const de = job.de || {};
  p[41] = de.on === false ? 0 : 1;
  p[42] = de.width > 0 ? de.width : 1.0;
  p[43] = de.strength != null ? de.strength : 0.85;
  // Colour scheme (0 = palette bands, 1 = reference "Distance": black field,
  // one-pixel white rim).  Mirrors the native kernel's Request::scheme.
  p[44] = job.scheme === 1 ? 1 : 0;
  /* KF colour pipeline (kernel.cpp Shade/putColor):
     45 statistics sink, 46/47 Stretched interval from the previous pass,
     48 enable Stretched, 49 palette loops across the interval (KF iterDiv 0.1 => 10),
     50 8x8 ordered dither. */
  p[45] = STATS;
  const st = job.stretch;
  p[46] = st ? st.lo : 0;
  p[47] = st ? st.hi : 0;
  p[48] = st ? 1 : 0;
  p[49] = 10;
  p[50] = job.dither === false ? 0 : 1;
  p[51] = 0;   // legacy |z'|² spacing (measurement only)
  /* Singleref rebase (KF glitch center method 3) is opt-in for measurement only:
     on deep views it diverges from the reference-repair result and costs ~2.7x,
     while emitting no glitches for the AddReference path.  KF's default method 0
     (detect glitch, add a reference) is what the worker's repair loop implements,
     so the kernel is left in "stop at orbit end + report glitch" mode. */
  p[52] = 1;
}

function renderWithWasm(job, mode, extra) {
  setupParams(job, mode, extra);
  if (mode === 2) {
    const deg = job.spec.newtonDegree || 3;
    const rv = new Float64Array(wasm.memory.buffer, ROOTS, deg * 2);
    for (let k = 0; k < deg; k++) {
      const a = (2 * Math.PI * k) / deg;
      rv[k * 2] = Math.cos(a);
      rv[k * 2 + 1] = Math.sin(a);
    }
  }
  return wasm.render(PARAMS);
}

/**
 * Last-resort repair: glitch pixels that no secondary reference orbit could
 * resolve are filled from their nearest healthy neighbours.  Isolated defects
 * vanish completely; larger holes fade into a smooth patch instead of showing
 * up as black speckle.
 */
function inpaintLeftovers(data, job, list, mask, count) {
  const w = job.w, h = job.h;
  const bad = new Set();
  for (let i = 0; i < count; i++) {
    if (mask[i]) continue;
    bad.add((list[i * 2] - job.x) + (list[i * 2 + 1] - job.y) * w);
  }
  if (!bad.size) return;

  const src = new Uint8ClampedArray(data);
  for (const idx of bad) {
    const x = idx % w, y = (idx / w) | 0;
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (bad.has(ni)) continue;
        const o = ni * 4;
        r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
      }
    }
    if (!n) continue;
    const o = idx * 4;
    data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = 255;
  }
}

function processJob(job) {
  const t0 = performance.now();
  const ps = job.pixelSize;
  const psLog2 = job.psLog2 != null ? job.psLog2 : Math.log2(ps);
  const bits = resolveBitsFromLog2(job.bits, psLog2);
  const spec = job.spec;

  // Custom formulas: deep views go through the "high-precision environment + second-order perturbation"
  const customDeep = spec.mode === 'x' && (bits > 64 || psLog2 < -13);
  if (customDeep) {
    const entry = ensureCustomEnv(job, bits);
    const r = renderTile({ ...job, resolvedBits: bits, customEnv: entry.env });
    return {
      type: 'tile', id: job.id, viewId: job.viewId,
      x: job.x, y: job.y, w: job.w, h: job.h,
      data: r.data,
      meta: {
        mode: r.mode, bits, ms: performance.now() - t0,
        glitches: r.glitches || 0, refLen: r.refLen || 0,
        escMin: r.escMin, escMax: r.escMax, bounded: r.bounded,
        engine: r.mode === 'custom-hp' ? 'hp' : 'core',
        limited: bits < requiredBitsFromLog2(psLog2),
        exact: !!(entry.env.deriv && entry.env.deriv.exact)
      }
    };
  }

  // JS path: deep zooms without perturbation support / no WASM
  const needJs =
    !wasm ||
    spec.mode === 'x' ||                   // custom formula (shallow: direct double precision)
    psLog2 < -16300 ||                     // beyond the 16384-bit desktop HP tier -> direct high precision
    (bits > 64 && !(spec.kind === 'mandelbrot' || spec.kind === 'multibrot') && spec.mode !== 'n');

  if (needJs) {
    let extraJs = {};
    if (spec.mode === 'x') {
      const { fn, step, P } = customFnFor(job);
      extraJs = { customFn: fn, customStep: step, customParams: P };
    }
    const r = renderTile({ ...job, resolvedBits: bits, ...extraJs });
    return {
      type: 'tile', id: job.id, viewId: job.viewId,
      x: job.x, y: job.y, w: job.w, h: job.h,
      data: r.data,
      meta: {
        mode: r.mode, bits, ms: performance.now() - t0,
        glitches: r.glitches || 0, refLen: r.refLen || 0,
        escMin: r.escMin, escMax: r.escMax, bounded: r.bounded,
        engine: 'js', limited: bits < requiredBitsFromLog2(psLog2)
      }
    };
  }

  let mode = 0, extra = null;
  if (spec.mode === 'n') mode = 2;
  else if (bits > 64) {
    mode = 1;
    const o = ensureOrbit(job, bits);
    extra = { orbitPtr: o.ptr, orbitLen: o.len, refPx: o.refPx, refPy: o.refPy, stride: o.stride, series: o.series, dd: o.dd };
  }

  const lut = setLut(job.palette, job.paletteStops);
  const glitches = renderWithWasm(job, mode, extra);

  const pixels = job.w * job.h;
  const bytes = pixels * 4;
  const out = new Uint8ClampedArray(bytes);
  out.set(heap.subarray(OUT, OUT + bytes));
  /* KF frame statistics: nMin/nMax/nMaxExceptCentre of this tile, sampled
     from the escaped pixels.  The host aggregates them per pass and feeds the
     result back as the next pass's Stretched interval. */
  const sv = new Float64Array(wasm.memory.buffer, STATS, 3);
  const stats = { nMin: sv[0], nMax: sv[1], nMaxNC: sv[2] };

  /* Glitch repair.
   *
   * The SIMD kernel reports the exact coordinates of the pixels whose
   * perturbation recursion broke down.  Repairing only those pixels with
   * secondary reference orbits keeps the frame clean without re-rendering
   * whole tiles in JavaScript (which used to cost an order of magnitude
   * and still left speckle noise behind). */
  let glitchFix = 0;
  if (mode === 1 && glitches > 0) {
    const n = Math.min(glitches, GLITCH_CAP);
    const list = new Int32Array(wasm.memory.buffer, GLITCH, n * 2);
    const dataView = new Uint8ClampedArray(wasm.memory.buffer, OUT, bytes);
    const mask = new Uint8Array(n);
    if (_internals.fixGlitches) {
      glitchFix = _internals.fixGlitches(
        { ...job, resolvedBits: bits }, bits, lut, dataView, list, mask, 6);
    }
    // Pixels that no secondary orbit can resolve keep their original colour:
    // inpainting them would paint over genuine interior regions.
    out.set(dataView);
  }

  return {
    type: 'tile', id: job.id, viewId: job.viewId,
    x: job.x, y: job.y, w: job.w, h: job.h,
    data: out,
    meta: {
      mode: mode === 0 ? 'direct' : mode === 1 ? 'perturb' : 'newton',
      bits, ms: performance.now() - t0,
      glitches, glitchFix, refLen: extra ? extra.orbitLen : 0,
      saSkip: extra && extra.series ? extra.series.skip : 0,
      engine: 'wasm', limited: bits < requiredBitsFromLog2(psLog2),
      stats
    }
  };
}

/* ---------- Message loop ---------- */

const ready = initWasm().then(ok => {
  self.postMessage({ type: 'ready', wasm: ok });
  return ok;
});

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'render') {
    await ready;
    try {
      const res = processJob(msg.job);
      self.postMessage(res, [res.data.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.job.id, message: String(err && err.stack || err) });
    }
  } else if (msg.type === 'resetOrbit') {
    orbitCacheEntry = null;
  }
};
