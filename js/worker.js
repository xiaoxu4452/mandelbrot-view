/* ------------------------------------------------------------------
 * worker.js — render thread
 *   · WebAssembly kernel (hot paths: direct / perturbation / Newton)
 *   · Pure-JS fallback (custom formulas, environments without WASM)
 *   · High-precision reference orbits (BigInt) are computed and cached on this thread
 * ----------------------------------------------------------------*/

import { KERNEL_B64 } from './kernel-wasm.js?v=28';
import { paletteLUT, registerCustomPalette } from './palettes.js?v=28';
import { resolveBitsFromLog2, requiredBitsFromLog2, contextFor } from './bigfixed.js?v=28';
import { renderTile, _internals } from './render.js?v=28';
import { compile as compileMath } from './mathlib.js?v=28';
import { buildSeries, chooseSkip } from './environment.js?v=28';
import { buildCustomEnvironment } from './customenv.js?v=28';
import { buildReferenceOrbit } from './formulas.js?v=28';

/* ---------- WASM memory layout ---------- */
/* The module is built by zig as `wasm32-freestanding`, so its shadow stack is
 * reserved at the TOP of the module's *initial* linear memory and grows down
 * from there.  That initial size is exactly 1 MiB, which means a 512x512 RGBA
 * tile (also exactly 1 MiB) written at 64 KiB ran straight into the stack: the
 * kernel's own spilled locals were replaced by pixel data, and every row after
 * the collision was computed from a destroyed orbit state.  That is the dark
 * horizontal band that appeared once per 512 px on the CPU path — the solver
 * was not wrong, its workspace was being painted over.
 *
 * The fix is a layout invariant, not a magic constant: the tile slot starts at
 * or above the module's initial memory size, so it can never overlap the stack,
 * whatever the linker picks.  `INIT_BYTES` is read before the first grow. */
let INIT_BYTES = 0;      // wasm initial memory (stack lives below this)
let OUT = 65536;         // tile slot base; raised to INIT_BYTES in initWasm
/* The kernel writes one tile as RGBA into linear memory, so this has to cover
 * the largest tile the page asks for — and that is TILE = 512 (app.js), i.e.
 * 1 MiB, not the 256x256 this used to reserve.  With the smaller buffer the
 * guard below (`job.w * job.h * 4 > OUT_CAP`) was true for *every* tile of a
 * real canvas, so the CPU path silently ran the JS kernel and never touched
 * WebAssembly at all: 1.7 s a frame on a 2560x1600 canvas with the HUD
 * reporting "JS". */
const OUT_CAP = 512 * 513 * 4;   // one spare row: never let a tile write into the LUT
let LUT_PTR = 0;
let PARAMS = 0;
let ROOTS = 0;
let STATS = 0;                        // 3 doubles written by the kernel: nMin, nMax, nMaxExceptCentre
let GLITCH = 0;                       // int32 pairs (x, y) reported by the kernel
const GLITCH_CAP = 8192;
let ORBIT = 0;

/** Lay the buffers out above the module's initial memory (see INIT_BYTES). */
function layoutMemory() {
  OUT = Math.max(65536, INIT_BYTES);
  LUT_PTR = OUT + OUT_CAP;
  PARAMS = LUT_PTR + 2048;
  ROOTS = PARAMS + 512;
  STATS = ROOTS + 256;
  GLITCH = ROOTS + 1024;
  ORBIT = GLITCH + GLITCH_CAP * 8;
}

let wasm = null;         // { render, memory }
let heap = null;         // Uint8Array view
let params = null;       // Float64Array view
let memBytes = 0;
/* Set by the one-shot workspace self-check in processJob (see there). */
let layoutVerified = false;

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
    /* Must be read before the first grow: the module reserves its shadow stack
     * at the top of this initial region, and `layoutMemory` keeps every buffer
     * we own above it. */
    INIT_BYTES = wasm.memory.buffer.byteLength;
    layoutMemory();
    /* Reserve the tile buffer up front; growMem() rounds up to whole pages. */
    growMem(OUT_CAP + 1024 * 1024);
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

/* Identity of a *view*, not of a buffer.
 *
 * The reference orbit belongs to the plane region: same centre, same span, same
 * iteration budget means the same orbit, no matter what resolution the pass is
 * drawn at.  Width and height used to be part of this key, which made every
 * pass of a progressive chain build its own orbit (the skeleton pass runs at
 * 0.16x, the final at 1x) and made a tile dispatched after the next pass had
 * started fall back to electing its own — visible as a seam exactly at that
 * tile's edge, because each reference leaves its own glitch pattern.
 *
 * The reference *pixel* is therefore stored normalised (refU/refV) and scaled
 * to the buffer at use time. */
function viewKey(job, bits) {
  const s = job.spec;
  return [s.mode, s.kind, s.power, s.julia ? s.julia.re + ',' + s.julia.im : '',
    job.center.re, job.center.im, job.span.m, job.span.e,
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

/**
 * Adopt the frame-wide environment computed by `prepareEnv` (see app.js).
 *
 * A deep pass used to be one viewport-sized tile, because every tile elected
 * its own reference point and built its own high-precision orbit: a 512 px
 * split multiplied that cost by the tile count and was slower than the single
 * tile it replaced.  The page now builds the orbit *once* per view and ships
 * the arrays with the job, so tiling is free again and the pool can split a
 * deep frame like any other.
 */
function adoptEnv(job, env) {
  const stride = env.stride;
  const bytes = stride * (env.dd ? 32 : 16) + 64;
  growMem(bytes + 1024);

  const re = env.re instanceof Float64Array ? env.re : new Float64Array(env.re);
  const im = env.im instanceof Float64Array ? env.im : new Float64Array(env.im);
  heap.set(new Uint8Array(re.buffer, re.byteOffset, re.byteLength), ORBIT);
  heap.set(new Uint8Array(im.buffer, im.byteOffset, im.byteLength), ORBIT + stride * 8);
  if (env.dd) {
    const reLo = env.reLo instanceof Float64Array ? env.reLo : new Float64Array(env.reLo);
    const imLo = env.imLo instanceof Float64Array ? env.imLo : new Float64Array(env.imLo);
    heap.set(new Uint8Array(reLo.buffer, reLo.byteOffset, reLo.byteLength), ORBIT + stride * 16);
    heap.set(new Uint8Array(imLo.buffer, imLo.byteOffset, imLo.byteLength), ORBIT + stride * 24);
  }
  return {
    key: env.key, ptr: ORBIT, len: env.len, stride,
    /* Normalised reference position: the same orbit serves every pass and
     * every tile, whatever resolution the pass buffer is. */
    refU: env.refU, refV: env.refV,
    series: env.series, dd: !!env.dd, fromEnv: true,
    src: { re, im, reLo: env.reLo, imLo: env.imLo }
  };
}

function ensureOrbit(job, bits) {
  const key = viewKey(job, bits);
  if (orbitCacheEntry && orbitCacheEntry.key === key) {
    /* Same view, already built (this worker may even be the one that served
     * the `prepare`).  If the page shipped its copy, adopt the flag so the
     * tile reports the same provenance as its neighbours. */
    if (job.env && job.env.key === key) orbitCacheEntry.fromEnv = true;
    return orbitCacheEntry;
  }
  /* Frame-wide environment handed over by the page: no arithmetic needed, the
   * orbit was already elected once for the whole view. */
  if (job.env && job.env.key === key) {
    orbitCacheEntry = adoptEnv(job, job.env);
    orbitCacheEntry.fromEnv = true;
    return orbitCacheEntry;
  }

  self.postMessage({ type: 'stage', stage: 'orbit' });
  const orb = _internals.pickReference(job, bits);
  /* Double-double reference.
   *
   * Below a pixel spacing of ~1e-15 the 53-bit reference orbit is no longer a
   * usable approximation: its per-step rounding (≈1e-16) is amplified by the
   * orbit derivative and swamps the perturbation, which is what makes the
   * picture turn into mosaics past 1e17 zoom.  Rebuilding the elected orbit
   * with (hi, lo) pairs costs one extra high-precision pass (once per view) and
   * lets the kernel run the double-double perturbation instead.
   * Desktop rule: the needed precision is digits = depth10 + 50, so double
   * alone stops being trustworthy near 1e-10 of a pixel — the old -46 gate
   * let three decades of frames ride a truncated reference (black wedges). */
  const dd = bits > 64 && (job.psLog2 == null || job.psLog2 <= -40);
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
    refU: orb.refPx / job.width, refV: orb.refPy / job.height,
    fromEnv: false, series, dd,
    /* Kept so a `prepare` request can hand the arrays to the other workers
     * without a second high-precision pass. */
    src: { re: orbFull.re, im: orbFull.im, reLo: orbFull.reLo, imLo: orbFull.imLo }
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
let lutKey = '';
function setLut(palette, stops, supplied, key) {
  // A user-defined palette travels with its stops: the worker has no
  // localStorage, so the main thread ships the table definition in the job.
  if (stops) registerCustomPalette(palette, stops);
  /* An exact 512x4 table from the page wins: palettes registered only on the
   * main thread (imported additive presets) do not exist in this module's
   * registry, where paletteLUT(id) would silently return Ice.  `key` keeps
   * the upload to once per palette change, not once per tile. */
  let lut;
  if (supplied && supplied.length === 2048) {
    if (key === lutKey && lutBytes) return lutBytes;
    lut = new Uint8Array(supplied);
    lutKey = key || '';
  } else {
    lut = paletteLUT(palette);
    lutKey = '';
  }
  if (lut === lutBytes) return lutBytes;
  heap.set(lut, LUT_PTR);
  lutBytes = lut;
  lutPalette = palette;
  return lut;
}

/* Split a high-precision decimal coordinate into (double, residual).
 *
 * The page stores the centre as a decimal string with up to 40 digits, but
 * parseFloat() keeps only 53 bits.  The C++ double-double kernel (mode 3)
 * needs the dropped digits: without them every deep folded-family view would
 * start from a rounded centre and collapse onto a staircase.  The residual is
 * the exact difference between the fixed-point value of the string and the
 * fixed-point value of its double approximation.  Cached per string because
 * setupParams() runs once per tile. */
const splitCache = new Map();
/* Desktop core (B10): parsing a coordinate truncates at the ACTIVE precision.
 * A fixed 256-bit context dropped 90 bits of a 1e100 centre and made the
 * structure drift.  Width now comes from this frame's pixel scale. */
function splitCoord(str, bits = 256) {
  const width = Math.max(256, Math.min(16384, Math.ceil(bits / 64) * 64));
  const hi = Number(str) || 0;
  if (!Number.isFinite(hi)) return [0, 0];
  const ck = str + '|' + width;
  const cached = splitCache.get(ck);
  if (cached) return cached;
  let lo = 0;
  try {
    const ctx = contextFor(width);
    lo = ctx.toNumber(ctx.sub(ctx.fromString(str), ctx.fromNumber(hi)));
  } catch { /* a non-decimal seed simply has no residual */ }
  const out = [hi, Number.isFinite(lo) ? lo : 0];
  if (splitCache.size > 256) splitCache.clear();
  splitCache.set(ck, out);
  return out;
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
  /* 53 = field mode: emit the colour position instead of RGBA (see kernel.cpp).
   * The page keeps this to re-shade a finished frame when only the palette
   * changes. */
  p[53] = job.asField ? 1 : 0;
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
  /* KF singleref rebase is the kernel's escape hatch for a reference orbit
   * that ends before the pixel does (|Z+dz|^2 < |dz|^2 restarts the local
   * index at the pixel's own z).  It is normally OFF: the JS AddReference
   * repair loop handles isolated glitches and is faster on healthy views.
   * But when the elected orbit cannot survive the iteration budget —
   * example-14 measured 78% glitched pixels and >130 s — that repair loop is
   * asked to fix most of the frame with secondary orbits that are just as
   * short.  Enable rebase for exactly those views, so no pixel is capped by
   * refLen and no glitch storm is generated. */
  const deepPerturb = mode === 1 && extra && extra.orbitLen > 0;
  const shortOrbit = deepPerturb && extra.orbitLen < job.maxIter * 0.9;
  const pixelLog2 = job.psLog2 != null ? job.psLog2
    : Math.log2(Math.max(1e-300, job.pixelSize));
  /* Desktop core (B2): the reference must outlive every pixel.  The old
   * non-rebasing kernel stopped at refLen and flagged EVERY still-unresolved
   * pixel as a glitch; at 10^52 that was 100% of a tile (245760 pixels here),
   * and the 8192-pixel repair cap left the rest as the block mosaic the user
   * reported.  KF singleref rebase restarts the local index from the pixel's
   * own z, so no pixel is ever capped by the orbit length.  A/B on a 1e52
   * view: glitches 245760 -> 0, repair 8192 -> 0. */
  p[52] = (shortOrbit || (deepPerturb && pixelLog2 < -46)) ? 0 : 1;
  /* Double-double low words for the folded-family kernel (mode 3).  The
   * high words live in p[10..14]; keeping the residuals in the same ABI means
   * the C++ kernel never has to parse a decimal string. */
  /* Coordinate parsing must use THIS frame's precision, not a stale
   * 256-bit context (desktop B10 / 1e100 structure drift). */
  const coordBits = resolveBitsFromLog2(job.bits,
    job.psLog2 != null ? job.psLog2 : Math.log2(Math.max(1e-300, job.pixelSize)));
  p[54] = splitCoord(job.center.re, coordBits)[1];
  p[55] = splitCoord(job.center.im, coordBits)[1];
  p[56] = spec.julia ? splitCoord(spec.julia.re, coordBits)[1] : 0;
  p[57] = spec.julia ? splitCoord(spec.julia.im, coordBits)[1] : 0;
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

/**
 * The pure-JS tile renderer, used for everything the kernel cannot express and
 * as the fallback when the kernel faults.
 *
 * The fallback is not decoration: the kernel writes its pixels into a fixed
 * buffer, and a trap inside it used to lose the tile outright — the pass never
 * completed, the page sat on a half-drawn frame, and nothing said why.  A tile
 * that cannot be produced in WebAssembly is now produced in JavaScript, once,
 * and the kernel is retired for the rest of the session.
 */
function renderJsJob(job, bits, psLog2, t0, why) {
  let extraJs = {};
  if (job.spec.mode === 'x') {
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
      engine: 'js', why: why || '', limited: bits < requiredBitsFromLog2(psLog2)
    }
  };
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

  /* Folded families (tricorn / burning ship / celtic / perpendicular / phoenix)
   * cannot share a z^p perturbation orbit — abs() and conjugation make the
   * delta polynomial piecewise — but they DO have a C++ kernel: mode 3
   * iterates in double-double.  Only views deeper than its ~106-bit reach
   * still need the arbitrary-precision JavaScript path.  The old gate sent
   * every one of them to JS past 2^-34, which is 10-100x slower. */
  const foldedFamily = spec.mode !== 'x' && spec.mode !== 'n' &&
    !(spec.kind === 'mandelbrot' || spec.kind === 'multibrot');
  const DD_MIN_LOG2 = -88;              // 106-bit mantissa minus an 18-bit guard

  // JS path: deep zooms without perturbation support / no WASM
  const needJs =
    !wasm ||
    spec.mode === 'x' ||                   // custom formula (shallow: direct double precision)
    psLog2 < -16300 ||                     // beyond the 16384-bit desktop HP tier -> direct high precision
    /* The kernel writes RGBA into one fixed buffer; a tile larger than its
     * capacity would run past the end of linear memory (which is exactly how
     * the old full-frame deep pass used to trap). */
    job.w * job.h * 4 > OUT_CAP ||
    (bits > 64 && foldedFamily && psLog2 < DD_MIN_LOG2);

  if (needJs) return renderJsJob(job, bits, psLog2, t0);

  let mode = 0, extra = null;
  if (spec.mode === 'n') mode = 2;
  /* Perturbation only earns its cost once the centre no longer fits in a
   * double.  `bits > 64` alone was not that test: the tier list now returns 128
   * for a shallow view (because 64 bits of *guard* is the reference's rule),
   * and routing a 800x frame through a 128-bit reference orbit made it both
   * slower and noisier than the plain double loop it replaced.  The threshold is
   * where the direct kernel stops being exact, i.e. where the pixel is smaller
   * than a double's ulp of the centre (~2^-52) — not -45, which was merely
   * where the page used to split its passes.  Between -34 and -52 the direct
   * path still ran a 128-bit integer loop per pixel: 1.6 s for a 1248x704 frame
   * at 2^-42, against 200 ms with one reference orbit and double pixels. */
  else if (bits > 64 && psLog2 <= -34) {
    if (foldedFamily) {
      /* C++ double-double direct: the whole orbit stays in WebAssembly, with
       * the exact centre from p[54..57].  No glitch repair is needed because
       * there is no reference orbit to diverge from. */
      mode = 3;
    } else {
      mode = 1;
      const o = ensureOrbit(job, bits);
      /* The elected reference is stored normalised (see viewKey); the kernel
       * wants it in this pass buffer's pixel grid. */
      extra = { orbitPtr: o.ptr, orbitLen: o.len, refPx: o.refU * job.width, refPy: o.refV * job.height,
                stride: o.stride, series: o.series, dd: o.dd, fromEnv: !!o.fromEnv };
    }
  }

  const lut = setLut(job.palette, job.paletteStops, job.paletteLUT, job.paletteKey);
  /* Workspace self-check, run once per session (and on demand through
   * `job.dbg`): paint the tail of this tile's slot before the render and see
   * how much of the marker survives.  Any surviving byte means the kernel did
   * not write that part of the slot — i.e. the layout invariant above
   * (`OUT >= INIT_BYTES`, `OUT_CAP >= 512x512`) has been broken and pixels are
   * again landing somewhere the solver does not own. */
  const verify = job.dbg || !layoutVerified;
  let tailMark = 0;
  if (verify) {
    tailMark = Math.min(64 * 1024, job.w * job.h * 4);
    heap.fill(0xAB, OUT + job.w * job.h * 4 - tailMark, OUT + job.w * job.h * 4);
  }
  let glitches = 0;
  try {
    glitches = renderWithWasm(job, mode, extra);
  } catch (e) {
    /* A trap in the kernel must not cost the frame.  Retire it and render the
     * tile in JS; the rest of the session keeps the working path. */
    console.warn('wasm render failed, falling back to JS:', e && e.message);
    wasm = null;
    return renderJsJob(job, bits, psLog2, t0, 'wasm-trap');
  }
  let tailKept = -1;
  if (tailMark) {
    let kept = 0;
    for (let i = OUT + job.w * job.h * 4 - tailMark; i < OUT + job.w * job.h * 4; i++)
      if (heap[i] === 0xAB) kept++;
    tailKept = kept;
    if (!layoutVerified) {
      layoutVerified = true;
      /* Written RGBA/field bytes can legitimately equal the 0xAB marker
       * (expect ~tailMark/256 of them).  Only a large surviving run means
       * the kernel never reached the tail of the slot; a few bytes are not
       * a buffer-overlap and must not spam the console on every session. */
      if (kept > tailMark * 0.02) {
        console.error(`[kernel] tile slot not fully written (${kept} bytes of ${tailMark}) — ` +
                      `OUT=0x${OUT.toString(16)} init=0x${INIT_BYTES.toString(16)} ` +
                      `tile=${job.w}x${job.h}; the buffers overlap the wasm stack again`);
      }
    }
  }

  const pixels = job.w * job.h;
  const bytes = pixels * 4;
  /* Field mode returns one float per pixel (the colour position), same bytes
   * as the RGBA it replaces — see kernel.cpp gField and app.js shadeField. */
  const out = job.asField ? new Float32Array(pixels) : new Uint8ClampedArray(bytes);
  const src8 = heap.subarray(OUT, OUT + bytes);
  if (job.asField) new Uint8Array(out.buffer).set(src8);
  else out.set(src8);
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
  /* Glitch repair repaints RGBA; in field mode the buffer holds floats, so the
   * repair pass is skipped and the glitched pixels keep their raw position
   * (they are re-iterated on the next full render anyway). */
  if (mode === 1 && glitches > 0 && !job.asField) {
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
    /* The pass buffer this tile belongs to: the page needs it to place a field
     * tile inside the frame-wide colour-position buffer. */
    width: job.width, height: job.height,
    data: out,
    meta: {
      mode: mode === 0 ? 'direct' : mode === 1 ? 'perturb'
            : mode === 2 ? 'newton' : 'dd-direct',
      bits, ms: performance.now() - t0,
      glitches, glitchFix, refLen: extra ? extra.orbitLen : 0,
      /* 'env' = the frame-wide orbit came from the page; 'own' = this tile
       * elected its own.  A deep frame must be all 'env', or tiles disagree at
       * their boundaries (each reference has its own glitch pattern). */
      refSrc: extra ? (extra.fromEnv ? 'env' : 'own') : '-',
      saSkip: extra && extra.series ? extra.series.skip : 0,
      engine: 'wasm', limited: bits < requiredBitsFromLog2(psLog2),
      /* True when this tile carries colour positions instead of RGBA
       * (kernel.cpp gField): the page shades them and keeps them for re-shading. */
      field: !!job.asField,
      stats, tailKept, tileH: job.h, tileW: job.w
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
  } else if (msg.type === 'prepare') {
    /* Build the reference orbit for a whole frame and hand it back, so every
     * worker that renders a tile of that frame can adopt it instead of paying
     * for its own election.  See adoptEnv(). */
    await ready;
    try {
      const job = msg.job;
      const psLog2 = job.psLog2 != null ? job.psLog2 : Math.log2(job.pixelSize);
      const bits = resolveBitsFromLog2(job.bits, psLog2);
      const o = ensureOrbit(job, bits);
      const s = o.src || {};
      /* Copies, not transfers.  These arrays are render.js's own cached
       * reference orbit; transferring them would detach that cache entry and
       * the next build would throw "Construct on a detached ArrayBuffer". */
      const out = {
        type: 'env', id: msg.id, key: o.key,
        len: o.len, stride: o.stride, refU: o.refU, refV: o.refV,
        dd: !!o.dd, series: o.series || null,
        re: s.re ? s.re.slice() : null,
        im: s.im ? s.im.slice() : null,
        reLo: o.dd && s.reLo ? s.reLo.slice() : null,
        imLo: o.dd && s.imLo ? s.imLo.slice() : null
      };
      self.postMessage(out);
      /* The orbit stays valid in this worker, so the first tile it renders
       * adopts the page's copy and copies it back over live memory — cheap,
       * and it keeps the two paths on exactly the same data. */
    } catch (err) {
      self.postMessage({ type: 'env', id: msg.id, error: String(err && err.message || err) });
    }
  } else if (msg.type === 'resetOrbit') {
    orbitCacheEntry = null;
  }
};
