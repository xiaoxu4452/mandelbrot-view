/* ------------------------------------------------------------------
 * app.js — main controller: view state / tile scheduling / interaction / UI
 * ----------------------------------------------------------------*/

import { PALETTE_LIST, paletteGradientCSS, paletteStops, paletteStopList, stopListGradientCSS, sampleStopList, resampleStops, registerCustomPalette, registerAdditivePalette, isCustomPalette, customPaletteStops, paletteColors, paletteRaw, paletteCycle, shaderTerms, REF_DEFAULT_LOG_FREQ, paletteLUT } from './palettes.js?v=28';
import { SCHEME_LIB, findScheme } from './schemes-data.js?v=28';
import { REFERENCE_COLORSCHEMES } from './colorschemes-data.js?v=28';
import { setLang, t, getLang } from './i18n.js?v=28';
import { contextFor, requiredBits, spanToNumber, resolveBits, resolveBitsFromLog2, requiredBitsFromLog2 } from './bigfixed.js?v=28';
import { compile as compileMath, toLatex, EXAMPLES } from './mathlib.js?v=28';
import { probeRemote, resetRemote, remoteEnabled, disableRemote, remoteRender, remoteStatus } from './remote.js?v=28';
import { openCorePanel } from './corepanel.js?v=28';
import { initGlassSelects } from './glass-select.js?v=28';
import { composeTile } from './drawlib.js?v=28';
import { SceneRenderer } from './glscene.js?v=28';
import { MainGPU } from './wgpu/main.js?v=28';
import { NATIVE, nativeUsable, nativeCapable, nativeRender, nativeCancel, nativeSetPaused, nativeThreads, nativeFrameReady, nativeFrameBegin, nativeFrameFlush, nativeCanvasMode, nativeCanvasPreview, nativeCanvasSetPreview, nativeCanvasExport, nativeGLOwned, nativeGLPresented, nativeSurfaceLive, nativeCanvasOwns, nativePreviewTarget, nativeLog, nativeField, nativePaletteTerms, nativeImportPreset, nativeExportPreset, nativeConfig, viewOp } from './native.js?v=28';
import { FieldRenderer, BUILTIN as GLSL_BUILTIN, CHANNEL, inferChannels,
         readColorschemes, writeColorschemes, newColorscheme } from './gpu.js?v=28';
import { initJuliaView } from './juliaview.js?v=28';
import { PRESET_THUMBS } from './preset-thumbs.js?v=28';
import { importRefPreset, glslToHlsl, classifyRefJson, readRefSettings,
         REF_MAX_PARAM } from './refpreset.js?v=28';
import { KINDS } from './formulas.js?v=28';
import { LIB, onLibrary, loadPatch, patchOf, thumbPalette,
         savePreset, deletePreset, buildObject, sampleAnimation } from './presetlib.js?v=28';

/* Any uncaught exception inside a pass callback aborts the progressive chain
 * silently: the canvas keeps showing the coarse pass and never reaches the
 * final one.  Surface it in the shell log instead of failing invisible. */
window.addEventListener('error', (e) => {
  try { nativeLog(`[js-error] ${e.message} @${e.filename}:${e.lineno}:${e.colno}`); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { nativeLog(`[js-reject] ${e.reason && e.reason.message ? e.reason.message : e.reason}`); } catch (_) {}
});

/* ---------------- Constants ---------------- */
/* Tile size.  Each tile is one render call, and a call has to pay a
 * thread-pool dispatch; at 128px a tile is only 16k pixels, so a 190-tile
 * frame spent more time in dispatch than in pixels (measured 1.7ms per tile
 * against 0.57ms of work).  256px quarters the number of dispatches and the
 * pass gets correspondingly cheaper. */
const TILE = 512;
/* Finest pixel scale the interaction layer will accept, 2^-1 190 000 ≈ 10^-358 000.
 *
 * This used to be -3322 (10^-1000) while the renderer and the desktop core can
 * both go far past it.  Past that wall `applyZoomAt` simply returned false: the
 * wheel stopped changing the view, the picture stayed at its old scale, and the
 * next pan then moved that stale picture — which is exactly the "huge
 * deviation" that shows up at very high magnification.  The limit is now the
 * precision budget itself (1.2 Mbit working width in the core), not an
 * arbitrary constant. */
const MIN_LOG2PS = -1190000;
const MAX_SPAN = 8;             // widest field of view

/* ---------------- State ---------------- */
const state = {
  spec: {
    mode: 'm',
    kind: 'mandelbrot',
    power: 2,
    julia: { re: '-0.7435', im: '0.1314' },
    newtonDegree: 3,
    phoenixP: 0.5667,
    customExpr: 'z^2 + c',
    customParams: { a: 0, b: 0, k: 0 }
  },
  center: { re: '-0.6', im: '0' },
  span: { m: 1.6, e: 1 },
  /* Rotation, in radians, exactly as the reference stores it.  It is carried
   * through import/export even before the kernel can render it, so a preset
   * that arrives rotated does not silently lose the angle on the way back. */
  rotation: 0,
  /* Which library file the view came from, and what it was called.  Both are
   * what "save" writes back into, so opening a preset and saving it again
   * updates that file instead of piling up near-duplicates. */
  presetFile: '',
  presetName: '',
  /* `parameters.inverse` inverts the palette (white minus colour). */
  inverse: false,
  /* Keyframes, when the open preset carries them (see presetlib.sampleAnimation). */
  animation: null,
  maxIter: 600,
  autoIter: true,
  autoRank: 100,        // percent of the automatic iteration budget (1..100)
  bits: 'auto',
  /* The reference colours by the raw iteration count through a fixed-period
   * palette (its `pal(smoothiter)` with a frequency in radians per
   * iteration), so a slow ramp period is what makes the colours keep moving
   * as the view zooms instead of the same bands being rescaled to the frame.
   * 140 iterations per cycle is its 0.045 rad/iteration. */
  /* Ice blue is the front door: it is the scheme this renderer was tuned
   * against, and a violet default made every new session look "wrong" before
   * the user had touched anything.  Presets still carry their own palettes. */
  palette: 'ice',
  scheme: 'bands',      // 'bands' = smooth palette bands (vivid, default); 'distance' = rim-only
  /* A GLSL `vec4 color(Data)` body imported from a reference preset's
   * `parameters.colorscheme.codegl`.  When set it replaces the built-in
   * schemes on the GPU path — that is the only way to reproduce the presets
   * whose look is a shader (Amethyst Crown, Nebula Bloom, Rainbow Veins, ...). */
  glsl: null,
  /* An embedded official GLSL scheme (see schemes-data.js).  `glsl` is the
   * shader that actually runs; these fields carry the rest of the recipe the
   * reference stores alongside it: its UniformsColor table, the neutral
   * values of its `params.param[]` sliders, its brightness pair and samples.
   * Keeping them together is what makes a scheme switch reversible and a
   * link shareable. */
  schemeId: null,
  schemeFollowView: true,   // an official scheme was authored at its own view
  schemeMeta: null,         // { nparam, paramLabels, samples, name } — also for imports
  schemeParams: [],
  schemeColors: [],
  schemeBri: { finite: 1, infinite: 1, factor: 1 },
  /* Shade the iteration field on the GPU.  Off falls back to the CPU
   * palette path, which is what the browser build and old drivers get. */
  gpu: true,
  shade: 0,             // band-density policy: 0 legacy / 1 stretched / 2 multi-cycle / 3 dense+dither
  bands: 0,             // 0 = authored frequency (the reference has no band-fit control)
  detail: 3,            // 0..3: smallest feature the renderer resolves (3 = one pixel)
  /* Fixed period, like the reference's per-iteration frequencies: the palette
   * is a function of the iteration count, not of the frame, so zooming slides
   * the colours instead of re-fitting the same bands to the new view. */
  cycleAuto: false,     // fit the cycle to the frame (false = use `cycle`)
  cycle: 140,           // explicit iterations per palette cycle
  offset: 0,
  /* A gradient the user edited.  null = follow the selected palette; once the
   * handles have been touched this table is the colour set, and it is what the
   * renderer receives instead of a palette name. */
  stops: null,
  /* Tone stage.  Identity values reproduce the palette exactly, so the
   * default view is untouched by any of this. */
  tone: { bri: 1, gr: 1, gg: 1, gb: 1 },
  /* Render resolution as a multiple of CSS pixels, independent of the device's
   * own scale factor: 1 = CSS (fastest), 1.5, 2 = device pixels on this screen.
   * The gesture cadence already renders well below this (livePlan), so a lower
   * setting only trims the final frame, never the preview. */
  renderScale: 1,
  /* Measurement only: 1 disables the field cache (and therefore the copy that
   * keeping a field requires), so the copy's cost can be measured on the same
   * view instead of being guessed from its byte count. */
  noFieldCache: false,
  /* Measurement only: 1 restores the old unconditional field copy, so the copy
   * that was removed can be timed on the same view. */
  forceCopy: false,
  /* Measurement only: work-dispatch tile upper bound, in pass pixels.  The
   * reference uploads each canvas node as a 2^canvassize texture (128 px by
   * default), which is a different layer; this knob only answers "would our
   * dispatch granularity change the frame time on the same view?".  Capped at
   * 512 by the shell's 1 MB shared slot. */
  tilePx: 512,
  aa: 3,          // supersampling factor for the final pass (1 = off, 4 = maximum)
  lang: 'zh',
  theme: 'dark',
  /* Orbit trap, 0 = off, 1../4 = point / line / circle / TIA.  A trap colours
   * by where the orbit travelled rather than how long it took to escape, which
   * is what draws filigree that survives a deep zoom (Ctx::wantTrap). */
  traps: 0,
  /* Trap density.  Both live only in the fragment shader, so they repaint the
   * cached field instead of re-iterating anything. */
  trapGain: 0.45,
  trapRings: 0.40,
  presetId: null
};

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const canvas = $('fractal');
const ctx = canvas.getContext('2d', { alpha: false });
const snap = document.createElement('canvas');
const snapCtx = snap.getContext('2d');
/* Scale applied to the committed snapshot by the 2D feedback path.  Reset
 * whenever a real frame is committed (takeSnapshot). */
let previewScale = 1;
const prevCanvas = document.createElement('canvas');
const prevCtx = prevCanvas.getContext('2d');

/* ---------------- GPU shading surface ----------------
 *
 * The core sends the iteration field; this surface turns it into pixels with
 * the reference program's own GLSL.  It is a separate canvas rather than a
 * second context on `#fractal` because the 2D context is how the CPU path,
 * the snapshot and the export all work — drawing through WebGL into the same
 * element would break every one of them.
 *
 * Exactly one of the two surfaces is visible at a time (`html.gl-surface`).
 */
const glCanvas = document.createElement('canvas');
glCanvas.id = 'glfractal';
canvas.parentNode.insertBefore(glCanvas, canvas.nextSibling);
/* WebGPU surface.  Same contract as the shader layer: fixed under #fractal,
 * never receives input, and only one of the three layers owns the picture. */
const wgpuCanvas = document.createElement('canvas');
wgpuCanvas.id = 'wgpu-fractal';
canvas.parentNode.insertBefore(wgpuCanvas, glCanvas.nextSibling);
const mainGPU = new MainGPU(wgpuCanvas, {
  onFrame: onGpuFrame, onDecline: onGpuDecline,
  /* A frame threw.  Nothing will ever land on this surface, so drop it and
   * repaint through the CPU pipeline instead of leaving the user staring at
   * the remains of an interrupted pass. */
  onFail: () => {
    if (wgpuSurface) setWgpuSurface(false);
    wgpuCanvas.style.transform = '';
    renderNow();
  }
});
let wgpuSurface = false;
/* View signature the engine has already turned down once; without it the
 * fallback repaint would immediately ask for the same impossible frame. */
let wgpuDeclineKey = '';
/* Per-pixel scale (log2) above which the direct fragment shader is the better
 * engine: it carries double-float coordinates, and at 1e-5 of a pixel float32
 * perturbation is still exact but has to spend a shared exponent on a δ that
 * is not small yet.  Below this the perturbation engine takes over.
 *
 * Set to a value no pixel scale can reach, which means "always decline": the
 * C++ core owns the frame.  Measured at one 1e5 view (same centre string, same
 * span, verified identical): the two engines draw visibly different pictures —
 * the CPU frame is clean filigree, the GPU frame carries black contour arcs and
 * puts ~5 % of its pixels in the interior class — and they cost the same
 * (213 ms vs 225 ms).  A second engine that is neither faster nor right is
 * exactly the "architectures fighting each other" this project is trying to
 * end, so WebGPU is now opt-in: `?wgpu=1` in the URL, or `__mb.wgpuForce(-16)`
 * at runtime, restores it for an A/B. */
let wgpuMinPixelLog2 = /[?&]wgpu=1/.test(location.search) ? -16 : -1e6;
/* Why the last wgpuView() declined, for the diagnostics hook. */
let wgpuWhy = '';
const gpu = new FieldRenderer(glCanvas);
let gpuOk = !!(gpu.ok && NATIVE);
let glSurface = false;
/* The last Params/color set the main GPU pass used.  The Julia preview is a
 * second viewport of the same program, so it must be shaded by the very same
 * shader and uniform values rather than a second colour implementation. */
let lastDraw = null;
let juliaView = null;
/* The one shader source that failed to compile, if any. */
let badSchemeSrc = '';

/* ---------------- scene renderer (whole fractal in a fragment shader) ----------------
 *
 * Everything above this line is the *field* pipeline: a CPU kernel produces
 * smooth iteration / distance / escape count and a shader colours them.  The
 * scene renderer is the benchmark-style route — the orbit itself is evaluated
 * per pixel on the GPU, so a frame costs one draw call and no CPU work at all.
 *
 * It owns the same canvas as the field renderer (a canvas has exactly one
 * WebGL context; two `getContext` calls return the same object), and it hands
 * the surface back to the 2D canvas whenever the view needs something a
 * fragment shader cannot do: a custom formula, a Newton set, an orbit trap,
 * the distance scheme, or a zoom past double-float precision.
 *
 * Division of labour, and why:
 *   - Live frames (pan / wheel / pinch) always use the scene: 60 fps beats
 *     exactness for a picture that is about to be replaced anyway.
 *   - The committed frame uses the scene only above MIN_PIXEL, where its
 *     coordinates are exact to ~1e-9 of a pixel; below that the CPU kernel
 *     (reference orbit + series approximation) owns the pixels.
 */
const scene = new SceneRenderer(gpu.ok ? gpu.gl : null);
const SCENE_KIND = {
  mandelbrot: 0, multibrot: 0, tricorn: 1, burningship: 2,
  celtic: 3, perpendicular: 4, phoenix: 5
};
/* Reach of the two fragment programs.
 *
 * `fast` iterates in float32, `df64` in double-float (24+24-bit Dekker pairs).
 * df64 is only exact while the driver does not fuse its products into FMAs:
 * every `a*b` in the split-and-residual dance is a mad() candidate, and a fused
 * one silently breaks the error term.  Measured on a Radeon 780M the shader
 * still resolves 58 distinct iteration counts at 1e-9 but collapses to *three*
 * from 1e-11 down — every pixel gets the same orbit and the frame is one flat
 * colour.  The page used to accept it all the way to 1.2e-14, so every deep
 * view was painted as a solid block.
 *
 * The gate is now where the program was measured correct.  Deeper than that the
 * CPU path owns the frame: it iterates in 64-512 bit integers, which is what
 * the reference does, at the cost of a second or two per committed frame — and
 * the live gesture still gets a low-resolution pass so a pinch stays attached
 * to the fingers. */
/* The committed frame belongs to the WASM perturbation core (the same rules
 * as the desktop build: full-length reference, relative SA, glitch repair,
 * adaptive iteration budget).  The old fragment-shader iterator carries only
 * 24/48-bit coordinates and was still being picked for deep views, producing
 * the large block mosaics.  It is now opt-in for A/B via ?scene=1; live
 * gesture previews may still use it, but only above 1e-4 pixel scale where
 * float32/df64 coordinates are exact. */
const SCENE_FINAL_ENABLED = /[?&]scene=1/.test(location.search);
const SCENE_MIN_PIXEL = 1.0e-4;
/* Two limits, because a paint is not the same budget as a gesture:
 *
 *   · pixels x iterations — what one fragment pass actually costs.  A deep
 *     view is happy to spend a couple of seconds on a committed frame, but a
 *     pointer event that spends that per move drops the gesture entirely.
 *   · maxIter — the kernel's own loop cap; past it the SA/perturbation path
 *     on the CPU is the only one that finishes.
 *
 * Both are scaled by the device class.  A phone at 390x844 has ~0.33 Mpx and a
 * mobile GPU; letting it take the same budget as a desktop would freeze the
 * page.  The earlier single set of numbers was tuned on a software rasteriser
 * and rejected everything past ~4000 iterations, which pushed every palette or
 * fractal switch on a real machine back onto the CPU (seconds of stutter). */
const SCENE_MAX_ITER = 20000;
const SCENE_IS_SMALL = Math.min(window.innerWidth || 999, window.innerHeight || 999) < 700;
/* Touch-first devices get a tighter budget than a small desktop window: fewer
 * workers, a smaller field cache and a capped backing-store scale.  Detected
 * once at boot; a hybrid laptop with a touch screen still counts as coarse. */
const TOUCH_UI = (() => {
  try {
    return matchMedia('(pointer: coarse)').matches ||
      (navigator.maxTouchPoints > 0 && SCENE_IS_SMALL);
  } catch (_) {
    return SCENE_IS_SMALL;
  }
})();
const SCENE_MAX_COST = (SCENE_IS_SMALL ? 8.0e9 : 6.0e10);   // committed frame
const SCENE_LIVE_COST = (SCENE_IS_SMALL ? 1.2e9 : 6.0e9);   // one gesture draw
let sceneLast = null;            // last view the scene drew
let sceneResult = null;          // { program, ms } of the last scene draw
let sceneFail = '';              // why the shader last declined
let sceneDrawAt = 0;

/** True when the current view is one the fragment shader can draw exactly. */
function sceneView() {
  if (!scene.ok || !state.gpu) return null;
  /* The desktop host has its own C++ field renderer and a native D3D/GL
   * surface.  The page's fragment shader is a web-only shortcut: it iterates
   * in 24-bit float, so on the desktop it would replace a 192-bit core frame
   * with a coarse one; worse, when it declines a deep view it toggles the
   * `gl-surface` layer and hides the field that the host just uploaded.
   * `state.gpu` stays on here because the desktop field shader (gpuPass) uses
   * it — only the "iterate in the fragment shader" path is web-only. */
  if (NATIVE) return null;
  if (nativeCanvasMode()) return null;
  const spec = state.spec;
  /* Only the polynomial families live in the shader; formulas, Newton sets
   * and anything the colour stage post-processes stay on the CPU side. */
  if (spec.mode !== 'm' && spec.mode !== 'j') return null;
  if (state.traps > 0 || state.inverse) return null;
  if (state.scheme === 'distance') return null;
  /* A gradient ramp is *not* a reason to refuse the shader.  It used to be one:
   * the shader took only `paletteLUT(state.palette)`, which ignores the ramp, so
   * a ramp would have been silently dropped.  The page hands the shader the
   * same table the CPU path uses (`currentLut()`, which registers the ramp
   * first), so the two agree — and the shader stops being skipped for every
   * default view, which is why a default page still burned 1.2 s of WASM per
   * frame and every palette or fractal switch went through a full CPU pass. */
  const p = psPair();
  if (p.e < -1000) return null;
  const pixel = p.m * Math.pow(2, p.e);
  if (!(pixel > 0)) return null;
  const julia = spec.mode === 'j';
  return {
    centerRe: Number(state.center.re) || 0,
    centerIm: Number(state.center.im) || 0,
    pixel,
    rot: state.rotation || 0,
    width: canvas.width, height: canvas.height,
    maxIter: effectiveIterTotal(),
    power: spec.power | 0 || 2,
    kind: SCENE_KIND[spec.kind] == null ? 0 : SCENE_KIND[spec.kind],
    julia,
    seedRe: julia ? Number(spec.julia.re) || 0 : 0,
    seedIm: julia ? Number(spec.julia.im) || 0 : 0,
    cycle: effectiveCycle(),
    offset: state.offset || 0,
    phoenix: spec.phoenixP == null ? 0.5667 : spec.phoenixP,
    samples: 1
  };
}

/** Palette table for the shader.  The key is what the LUT cache compares. */
function scenePaletteKey() {
  /* The ramp's *contents* matter, not just how many handles it has: dragging a
   * handle keeps the count and used to leave the shader on the old table. */
  const st = state.stops;
  const fp = st && st.length
    ? st.map(s => (s[0] | 0) + '.' + s[1] + '.' + s[2] + '.' + s[3]).join(',')
    : '';
  return String(state.palette) + '|' + fp;
}

/** Can the fragment shader draw this view at this quality?  Pure predicate, so
 * a gesture can ask *before* choosing a path instead of discovering the refusal
 * after it has already committed to the shader. */
function sceneCanDraw(v, final) {
  if (!v) return false;
  if (v.pixel < SCENE_MIN_PIXEL) { sceneFail = 'depth'; return false; }
  if (v.maxIter > SCENE_MAX_ITER) { sceneFail = 'iter'; return false; }
  const cost = Math.max(1, v.width | 0) * Math.max(1, v.height | 0) * (v.maxIter | 0);
  if (cost > (final ? SCENE_MAX_COST : SCENE_LIVE_COST)) {
    sceneFail = final ? 'cost' : 'cost-live';
    return false;
  }
  return true;
}

/** The page's own shader may only own the picture while the page canvas is
 * what the user sees.  After the shell's GL canvas has presented, a draw here
 * lands in a hidden layer — and, worse, it satisfies every "the shader already
 * painted this frame" check, so the shell never renders the real one. */
function pageShaderOwns() {
  /* Never when the shell's canvas owns the picture: a page-side shader would
   * paint into a layer nobody sees, and — worse — satisfy every "already
   * painted" check, so the native surface would never receive a pass at all. */
  if (nativeCanvasOwns()) return false;
  return !nativeSurfaceLive();
}

/** Draw the current view with the shader.  Returns true when it painted. */
function sceneDraw(v, opts = {}) {
  if (!v) return false;
  if (!sceneCanDraw(v, !!opts.final)) return false;
  glCanvas.width = v.width;
  glCanvas.height = v.height;
  /* The same table the CPU path shades with, ramp and additive terms included.
   * `paletteLUT(state.palette)` alone ignores `state.stops`, so a gradient edit
   * moved the CPU picture and left the shader on the previous ramp. */
  scene.setPalette(currentLut(), scenePaletteKey());
  const r = scene.draw(v);
  if (!r.ok) { sceneFail = r.why; setGlSurface(false); return false; }
  sceneFail = '';
  sceneLast = v;
  sceneResult = r;
  sceneDrawAt = performance.now();
  setGlSurface(true);
  return true;
}

/** Committed frame through the shader, or false to let the CPU pass run. */
function scenePass() {
  if (!SCENE_FINAL_ENABLED) {
    /* Hand the surface back to the 2D/field layer: leaving the old shader
     * frame on top would hide the WASM frame that follows. */
    setGlSurface(false);
    sceneFail = 'wasm-core-owns-final-frame';
    return false;
  }
  if (!pageShaderOwns()) return false;
  const v = sceneView();
  if (!v || !sceneDraw(v, { final: true })) {
    /* The shader declined.  `html.gl-surface` sets #fractal opacity:0, so
     * leaving the previous GPU frame on top would hide every 2D pass that
     * follows — and a later class toggle would expose a stale, magnified
     * low-resolution bitmap instead.  Only a successful shader draw owns the
     * visible layer. */
    setGlSurface(false);
    return false;
  }
  /* The shader just painted the whole frame in one draw call.  Any CPU pass
   * still in flight — the quick preview a wheel event started, a progressive
   * pass a preset kicked off — will land *on top* of it, tile by tile, and the
   * HUD will end up reporting the CPU engine while the screen shows a mix of
   * two different frames.  That is the "blocks + still slow" report: the GPU
   * had already finished, and then the slow path overwrote it.  Cancel it. */
  if (pending > 0 || liveBusy || mainQueue.length) cancelAll();
  /* The splash screen is driven by the pass index of the CPU plan; a shader
   * frame has no passes, so it has to close the curtain itself or the page
   * sits at "68%" forever. */
  if (!splash.finished) {
    splash.set(0.68, 'bootFirst');
    splash.finish();
  }
  /* The HUD reports the engine that produced this frame, and its precision.
   * Claiming the selected 512-bit setting here would be a lie: the shader's
   * coordinates are 24 bits wide (float) or 48 (double-float). */
  lastMeta = {
    engine: 'gpu',
    mode: state.spec.mode === 'j' ? 'julia' : 'mandelbrot',
    bits: sceneResult && sceneResult.program === 'df' ? 48 : 24,
    ms: sceneResult ? sceneResult.ms : 0,
    glitches: 0, refLen: 0
  };
  /* The HUD's time is the draw, not the wall clock since whatever started the
   * last CPU pass: a recolour through the shader is one draw, and reporting it
   * as "7891 ms" because frameStartAt was set by the previous render is worse
   * than useless. */
  frameMs = sceneResult ? sceneResult.ms : 0;
  frameSeq++;
  updateHud(true);
  takeSnapshot();
  return true;
}

/** Live frame while a gesture is running: one draw per input event.
 *
 * A gesture used to be a CSS-style blit of the last frame, which on the web
 * build meant a stretched bitmap for as long as the wheel kept turning.  One
 * fragment pass per event is both cheaper and sharp, so the shader takes the
 * gesture whenever it can and the blit remains the fallback. */
function sceneLive() {
  /* Pipeline purity (user report: "many legacy renderers drawing at once, the
   * settled frame is still broken"): the page has exactly one picture owner —
   * the WASM perturbation core.  The 24/48-bit fragment iterator is off for
   * committed frames AND live previews (?scene=1 re-enables both for A/B);
   * during a gesture the core's own low-resolution live pass or the snapshot
   * blit takes the frame. */
  if (!SCENE_FINAL_ENABLED) return false;
  if (!pageShaderOwns()) return false;
  if (performance.now() - sceneDrawAt < 6) return false;
  const v = sceneView();
  /* Do not drop the GL surface for a view the shader simply cannot reach: every
   * pointer move would flip the page between the shader layer and the 2D canvas,
   * which is a visible flicker and an extra composite per event.  Let the caller
   * fall back to the CPU preview with the surface as it is. */
  if (!v || !sceneCanDraw(v, false)) return false;
  if (!sceneDraw(v)) { setGlSurface(false); return false; }
  return true;
}

/* ---------------- shader clock ----------------
 * `params.time` is part of the reference's `Params` and four of its shipped
 * schemes read it: Amethyst Crown breathes, Nebula Bloom drifts, Rainbow Veins
 * pulses, the Chinese Remainder Clock ticks.  We always passed 0, so every
 * "colour that moves on its own" was frozen at t = 0 — the animation is part
 * of those presets, not a decoration.
 *
 * Re-shading is cheap on purpose: the iteration field does not change with
 * time, so a tick is one fragment pass over the field already on the GPU — the
 * same trade the reference makes with its 128x128 iteration texture.  Nothing
 * here re-iterates. */
let animRaf = 0;
let animT0 = performance.now();
let animPaused = false;
const ANIM_MIN_MS = 55;              // ~18 fps: enough for a slow breathing effect
let animLastAt = 0;
function schemeTime() { return (performance.now() - animT0) / 1000; }
function schemeWantsTime(src) { return !!src && src.indexOf('params.time') >= 0; }
function stopShadeAnimation() {
  if (animRaf) { cancelAnimationFrame(animRaf); animRaf = 0; }
}
function startShadeAnimation() {
  if (animRaf || animPaused || document.visibilityState === 'hidden') return;
  if (!lastDraw || !lastDraw.final || !schemeWantsTime(lastDraw.src)) return;
  animLastAt = 0;
  animRaf = requestAnimationFrame(animTick);
}
function animTick(t) {
  animRaf = 0;
  const d = lastDraw;
  if (animPaused || !d || !d.final || !schemeWantsTime(d.src)) return;
  /* Never fight a gesture or a fresh render: the field on the GPU is about to
   * be replaced, and a tick would paint the old one over the new picture. */
  if (!d.fieldLive) { animRaf = requestAnimationFrame(animTick); return; }
  if (t - animLastAt < ANIM_MIN_MS) { animRaf = requestAnimationFrame(animTick); return; }
  animLastAt = t;
  d.time = schemeTime();
  gpu.draw(d);
  /* The preview shares this exact Params object, so it advances with the main
   * view instead of drifting to its own clock. */
  if (juliaView) juliaView.redraw();
  animRaf = requestAnimationFrame(animTick);
}

function setGlSurface(on) {
  if (on === glSurface) return;
  glSurface = !!on;
  document.documentElement.classList.toggle('gl-surface', on);
  /* The two layers are mutually exclusive: letting a GL frame come up while
   * the WebGPU class is still set would hide both pictures. */
  if (on) setWgpuSurface(false);
}

/* ---------------- WebGPU deep engine ----------------
 *
 * Why this exists: the fragment scene is 48-bit double-float, which reaches
 * ~1e-9 of a pixel; past that the CPU kernel takes over, and at a few hundred
 * magnifications a full frame is already tens of millions of tile iterations
 * spread over worker round trips — the reported stutter.  This engine runs the
 * perturbation formula in float32 on the GPU against one MPFR reference orbit,
 * so the same frame is a single dispatch and stays exact at 1e-10 and beyond.
 *
 * It is not a separate page or a second UI: it consumes the page's own view
 * state (centre strings, span, iteration policy, palette table) and renders
 * into its own canvas layer.  The predicates below keep it to the sets the
 * shader can express (z²+c, Mandelbrot and Julia); anything else keeps the
 * existing pipelines untouched.
 */
function setWgpuSurface(on) {
  if (on === wgpuSurface) return;
  wgpuSurface = !!on;
  document.documentElement.classList.toggle('wgpu-surface', wgpuSurface);
  if (!wgpuSurface) {
    /* Any pending gesture transform belongs to the layer being hidden; leaving
     * it on would make the next frame appear shifted. */
    wgpuCanvas.style.transform = '';
  }
}

/** Identity of the current view, for "the engine said no to this one" caching. */
function wgpuViewKey() {
  const s = state;
  const j = s.spec.julia || {};
  return [s.center.re, s.center.im, s.span.m, s.span.e,
          s.spec.mode, s.spec.kind, s.spec.power, j.re, j.im,
          s.rotation || 0, s.maxIter, s.cycle].join('|');
}

/** The page view as the WebGPU renderer wants it, or null when it must decline. */
function wgpuView() {
  const no = (why) => { wgpuWhy = why; return null; };
  wgpuWhy = '';
  if (!mainGPU.ready) return no('not-ready');
  /* A backend that has thrown once will never paint again; keep the CPU
   * pipeline responsible for the picture instead of asking it every frame. */
  if (mainGPU.failed) return no('failed');
  /* WebGPU runs everywhere, phones included: it is the only backend that
   * keeps the reference orbit's exactness and still answers a gesture in one
   * dispatch.  The fallbacks below cover the cases where it genuinely cannot
   * draw, not the device class. */
  if (wgpuViewKey() === wgpuDeclineKey) return no('declined');
  /* `NATIVE` only says "a host bridge exists"; it is true for every desktop
   * run, including the ones where the picture lives in the page.  Gating on it
   * made this renderer unreachable in the desktop build entirely.  What
   * actually conflicts is a native canvas owning the visible pixels. */
  if (nativeCanvasMode()) return no('native');
  const spec = state.spec;
  if (spec.mode !== 'm' && spec.mode !== 'j') return no('mode');
  if (state.traps > 0 || state.inverse) return no('traps');
  if (state.scheme === 'distance') return no('distance');
  /* A user GLSL scheme is a colour program only its own shader can run. */
  if (state.glsl && state.glsl.trim()) return no('glsl');
  /* Every family in formulas.js has a perturbation step in the compute
   * shader, so the only thing left to check is that the id is one of them. */
  if (!KINDS[spec.kind]) return no('kind');
  const power = spec.power | 0 || 2;
  if (power < 2 || power > 10) return no('power');
  if (power !== 2 && spec.kind !== 'mandelbrot' && spec.kind !== 'multibrot') return no('power-kind');
  const p = psPair();
  /* Shallow views belong to the direct fragment shader (see wgpuMinPixelLog2). */
  if (Math.log2(Math.abs(p.m)) + p.e > wgpuMinPixelLog2) return no('shallow');
  /* ~10^6600 of per-pixel scale; the MPFR orbit is the only cost that grows
   * with this, and it stays inside the precision budget below. */
  if (p.e < -22000) return null;
  /* Precision floor of the pixel kernel.  WebGPU has no f64: the double-float
   * path carries two f32 limbs, 48 bits in total, and it must resolve the
   * *pixel* scale on top of a reference value of order one.  Measured: a frame
   * at 2^-40 of pixel scale still grows curved bands of false interior — the
   * large black arcs that read as a rendering bug — because 48 bits minus the
   * error a 7 000-step recurrence accumulates leaves far less than the 40 bits
   * the pixels need.  2^-32 keeps 16 bits of headroom and is clean on every
   * view tested; deeper than that the honest engine is the CPU's
   * arbitrary-precision Fexp path, so decline instead of painting a wrong
   * picture.  (A quad-double 4-limb kernel is the way to push this down.) */
  if (p.e < -32) return no('precision');
  const julia = spec.mode === 'j';
  return {
    centerRe: state.center.re,
    centerIm: state.center.im,
    /* The CPU pair is per-pixel; the renderer wants the plane width. */
    spanLog2: psLog2Now() + Math.log2(Math.max(1, canvas.width)),
    maxIter: effectiveIterTotal(),
    mode: julia ? 1 : 0,
    juliaRe: julia ? spec.julia.re : '0',
    juliaIm: julia ? spec.julia.im : '0',
    kind: spec.kind,
    power,
    phoenixP: spec.phoenixP != null ? spec.phoenixP : 0.5667,
    rotation: state.rotation || 0,
    /* Series/bilinear approximation is a shallow-view accelerator: it skips
     * 64-step blocks while the pixel offset stays in the linear regime.  At
     * depth the same skip is what paints the large black contour arcs across
     * the frame — the block's affine map stops matching the true orbit long
     * before its residual test notices, and every block boundary shows up as a
     * smooth curved band.  The recovered renderer only uses its series while
     * `delta` is inside `delta_max`; the honest equivalent here is to switch
     * it off once the frame is deep, where it saves <2 % of the iterations. */
    /* Series/bilinear approximation: OFF.
     *
     * It skips 64-step blocks while the pixel offset stays in the linear
     * regime, and the block's affine map stops matching the true orbit long
     * before its own residual test notices.  Every block boundary then shows
     * up as a smooth dark curve across the frame -- the thin contour lines
     * that made 10^4..10^6 look "discrete".  The old gate was `p.e > -40`,
     * which kept it on through exactly the depths people zoom to; measured
     * here it saves under 2 % of the iterations, and the lines cost far more
     * than that.  `MB_BLA=1` turns it back on for an A/B. */
    useBla: /[?&]bla=1/.test(location.search),
    shadeMode: 3,
    palette: { freq: 0, phase: 0, offset: state.offset || 0, exposure: 1 },
    lut: currentLut(),
    lutKey: scenePaletteKey(),
    /* Colour cycles across the frame.
     *
     * `bands: 3` is the number of wraps we want; `cycle` is the divisor the
     * shader actually divides the smooth iteration by, and only the renderer
     * knows it after the field exists.  So this is a first guess, and the
     * renderer re-shades from the same field once the frame reports its real
     * escape range (one full-screen pass, no re-iteration).  Reusing the range
     * measured at a comparable depth makes that first guess right most of the
     * time; the rest is one extra shade pass.
     *
     * Three wraps and not out's ten: its palette is a sum of cosines that
     * never reaches zero, whereas the presets here are there-and-back
     * gradients (ice runs 0.02,0.05,0.12 -> white -> 0.02,0.05,0.12), so
     * every wrap lands on the dark end and draws a visible arc. */
    cycle: wgpuCycleGuess(),
    bands: 3,
    safety: 1
  };
}

/** Colour-cycle divisor from the escape range measured at a nearby depth. */
function wgpuCycleGuess() {
  const e = state.lastEsc;
  const d = psLog2Now();
  if (e && e.max > e.min && Math.abs(d - e.depth) < 4) {
    return Math.max(1, (e.max - e.min) / 3);
  }
  return Math.max(2, effectiveIterTotal() / 10);
}

/**
 * Feed a WebGPU frame's real escape range back into the iteration budget.
 *
 * The GPU kernel reduces the escape range itself, so "the budget was too
 * small" stops being a guess: it is exactly the frames whose escapes reached
 * the ceiling.  Those pixels are the ones painted as interior — thin near-black
 * iso-lines that look like a rendering fault and were reported as "discrete".
 * Raising the cap and repainting once is the honest fix; a repaint loop is not,
 * so this rides the same ITER.maxRefine limit as the CPU path.
 */
function noteGpuObservation(status) {
  if (!status || !(status.maxIter > 0)) return;
  const cap = status.maxIter | 0;
  const hi = status.escMax;
  if (!(hi > 0) || hi < cap * 0.98) return;
  const before = observedIter.cap | 0;
  noteFrameObservation(cap, Math.ceil(hi), 1);
  if ((observedIter.cap | 0) > before) scheduleZoomRender(true);
}

/** Committed frame through WebGPU; false lets the other pipelines run. */
function wgpuPass() {
  const v = wgpuView();
  if (!v) {
    if (wgpuSurface) setWgpuSurface(false);
    return false;
  }
  /* Mid-gesture the compositor already holds the last frame under the
   * finger's transform.  Committing now would cancel the frame in flight and
   * replace the moving picture with a still one, which is what "does not
   * follow the finger" looks like.  The gesture end re-renders. */
  if ((drag || pinch) && wgpuSurface) return true;
  if (!mainGPU.commit(v)) return false;
  /* The same race scenePass guards against: a CPU pass still in flight paints
   * the old view tile by tile over the frame that is about to land. */
  if (pending > 0 || liveBusy || mainQueue.length) cancelAll();
  return true;
}

/** Live gesture feedback.  A WebGPU frame takes milliseconds, not one display
 * frame, so the committed bitmap is transformed on the compositor instead:
 * the picture follows the hand at 60 fps and the engine only repaints once the
 * gesture settles.  Returns true when it consumed the gesture. */
function wgpuLive(dx, dy, scale = 1, cx = 0, cy = 0) {
  if (!wgpuSurface) return false;
  const vf = viewFit();
  /* Input offsets are device pixels; CSS transforms are CSS pixels. */
  const k = vf.k;
  const tx = (dx + cx * (1 - scale)) * k;
  const ty = (dy + cy * (1 - scale)) * k;
  wgpuCanvas.style.transform =
    `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${scale.toFixed(5)})`;
  return true;
}

/** The engine refused this view (its reference orbit dies too early).  Hide
 *  the layer, remember the view, and let the other pipelines draw it. */
function onGpuDecline(info) {
  wgpuDeclineKey = wgpuViewKey();
  if (wgpuSurface) setWgpuSurface(false);
  nativeLog('[webgpu] declined: ' + (info && info.reason) +
            ' refLen=' + (info && info.refLen) + ' / ' + (info && info.maxIter));
  renderNow();
}

function onGpuFrame(status) {
  if (!status) return;
  setWgpuSurface(true);
  setGlSurface(false);
  wgpuCanvas.style.transform = '';
  /* The escape range this frame actually contained, straight from the
   * kernel's atomicMin/Max reduction.  It is what the band count is derived
   * from, and it is also the only honest answer to "is this frame one flat
   * band / wholly interior" — the page used to infer both from maxIter. */
  if (status.escMax > status.escMin && status.escMax > 0) {
    state.lastEsc = {
      min: status.escMin, max: status.escMax, depth: psLog2Now()
    };
  } else if (status.total > 0) {
    state.lastEsc = null;
  }
  lastMeta = {
    engine: 'webgpu',
    mode: state.spec.mode === 'j' ? 'julia' : 'mandelbrot',
    bits: status.bits,
    ms: status.frameMs,
    glitches: Math.round(status.glitchRatio * 100),
    refLen: status.refLen,
    escMin: status.escMax > status.escMin ? status.escMin : -1,
    escMax: status.escMax > status.escMin ? status.escMax : -1,
    bounded:
      status.total > 0 && status.escMin < 0 ? status.total : 0,
    cycle: status.cycle || 0,
    cap: status.maxIter || effectiveIterTotal(),
    done: true,
    final: true
  };
  frameMs = status.frameMs;
  frameSeq++;
  noteGpuObservation(status);
  if (!splash.finished) {
    splash.set(0.68, 'bootFirst');
    splash.finish();
  }
  updateHud(true);
  takeSnapshot();
}

/** Bring the optional WebGPU backend up without blocking the first paint. */
async function initMainGpu() {
  if (!(await mainGPU.init())) return;
  /* The page has already painted its first frame through another pipeline;
   * repaint it here so the two engines never mix. */
  renderNow();
}

/** The GLSL source the GPU path runs.  A user-supplied scheme wins, then the
 *  reference's Distance scheme, then its Smooth scheme (the default). */
function activeSchemeSrc() {
  if (state.glsl && state.glsl.trim()) return state.glsl;
  if (state.scheme === 'distance') return GLSL_BUILTIN.distance.src;
  return GLSL_BUILTIN.smooth.src;
}

/** The channel contract that belongs with `activeSchemeSrc()`. */
function activeSchemeChannels() {
  if (state.glsl && state.glsl.trim()) {
    return state.schemeChannels != null ? state.schemeChannels
                                        : inferChannels(state.glsl);
  }
  return state.scheme === 'distance' ? GLSL_BUILTIN.distance.channels
                                     : GLSL_BUILTIN.smooth.channels;
}

/* ---------------- Numeric helpers ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function spanNum() {
  const e = Math.max(-1020, state.span.e);
  return state.span.m * Math.pow(2, e);
}

function psPair() {
  const w = canvas.width;
  let m = state.span.m / w, e = state.span.e;
  while (Math.abs(m) >= 2) { m /= 2; e++; }
  while (Math.abs(m) < 1 && m !== 0) { m *= 2; e--; }
  return { m, e };
}

function psLog2Now() {
  const p = psPair();
  return Math.log2(Math.abs(p.m)) + p.e;
}

/** Approximate double pixel scale (0 beyond 1e-300 depth; only used by compatibility paths) */
function psNow() {
  const p = psPair();
  return p.e < -1000 ? 0 : p.m * Math.pow(2, p.e);
}

function depthNow() {
  return -psLog2Now() / Math.log2(10);
}

/* Magnification of what is on screen, measured on the pixel scale -- the same
 * quantity the renderer uses to place a pixel.  `depthNow()` is that scale
 * against 1.0 (10^3.2 for a wide opening frame), which is a precision input,
 * not a zoom.  Captured on the first HUD update so "1x" is exactly the opening
 * frame.  (Using state.span here read 795x at start-up: its mantissa/exponent
 * pair is not a plain decimal.) */
let homeDepth = null;
function zoomDepthNow(capture) {
  const d = depthNow();
  /* Capture on the first *completed* frame, not on the first paint: boot
   * restores the saved view a moment later, so a capture taken during the
   * first paint made the opening frame read 8.5x. */
  if (homeDepth === null && capture) homeDepth = d;
  if (homeDepth === null) return 0;
  return Math.max(0, d - homeDepth);
}

function bitsNow() {
  return resolveBitsFromLog2(state.bits, psLog2Now(), effectiveIterTotal());
}

function shiftCoord(baseStr, delta, bits) {
  const ctx2 = contextFor(Math.max(128, bits));
  const b = ctx2.fromString(baseStr);
  const d = ctx2.fromNumber(delta);
  return ctx2.toString(b + d, Math.ceil(bits * 0.32) + 10);
}

/** Shift a coordinate by a mant×2^exp offset so that doubles cannot underflow */
function shiftCoordScaled(baseStr, val, exp, bits) {
  /* `bits` is the single precision decision for this frame, taken once from
   * requiredBitsFromLog2() -- the reference's `depth + 0x40` rule.  This used
   * to raise it to 128 regardless and then print `bits * 0.32` decimal digits,
   * so the HUD, this arithmetic and the renderer were three different widths.
   * Use exactly the width that was chosen; log10(2) digits per bit is the
   * correct decimal length, not a 0.32 fudge. */
  const ctx2 = contextFor(bits);
  const b = ctx2.fromString(baseStr);
  const d = ctx2.shl(ctx2.fromNumber(val), exp);
  const digits = Math.max(20, Math.floor(bits * 0.30103));
  return ctx2.toString(b + d, digits);
}

/**
 * Automatic iteration count: the count grows far faster with depth than in shallow views (roughly another one
 * to two thousand iterations near the boundary per extra decade), otherwise a deep zoom is just "interior colour".
 */
function autoIterFor(depth) {
  const d = Math.max(0, depth);
  const base = 600 + 350 * Math.min(d, 10);
  /* Measured escape counts on a boundary tile (2^-67 at 1e-17, 2^-90 at
   * 1e-24, 2^-104 at 1e-28) are ~11k / 23k / 42k, so 1200 per decade left
   * entire regions unescaped (rendered as interior black).  2600 tracks the
   * measured growth while staying below the 200k clamp. */
  const extra = d > 10 ? 2600 * (d - 10) : 0;
  return Math.round(clamp(base + extra, 400, 200000));
}

/* ---------------- Observed iteration budget ----------------
 * `07_反汇编与伪代码` has NO maxiter = f(zoom): `canvas->maxiter` is the
 * largest iteration actually OBSERVED.  The transcribed predicates live in
 * the desktop core's mb_core.h; these are the same constants:
 *   0046f630.c:104-114  known*3+3000 / observed*5 / 0x2aaaa2da sentinel
 *   0046f630.c:197      vertex recalc gate known*3+1000
 *   00498d00.c:295      checkcanvas budget observed*5+10000
 *   00429d50.c:185      idle_maxiter 0x7fffffff
 * autoIterFor() above stays as the FIRST guess for a view with no history.
 * A completed frame whose pixels really reached the cap then raises the
 * ceiling for the next pass.  A STARVED frame (zero escapes AND a reference
 * that lived to the cap) is different: it must repaint once, or the user is
 * left looking at a truncated black picture forever.  `repainted` limits
 * that to exactly one extra pass per view, so no stutter loop is possible.
 */
const ITER = {
  slack: 3000, gate: 1000, checkSlack: 10000,
  sentinel: 0x2aaaa2da, idle: 0x7fffffff,
  safeCap: 200000, maxRefine: 3,
  /* Desktop core (B10): a frame with zero escapes AND a reference that
   * lived to the cap is "starved", not interior.  Jump straight here. */
  starvedCap: 80000
};
function vertexIterBudget(known, observedMax) {
  let b = known > 0 ? known * 3 + ITER.slack
        : observedMax > 0 ? observedMax * 5 : ITER.sentinel;
  if (b < ITER.slack) b = ITER.slack;
  if (b > ITER.idle) b = ITER.idle;
  return b;
}
function checkCanvasIterBudget(observedMax) {
  return Math.min(ITER.idle, Math.max(0, observedMax) * 5 + ITER.checkSlack);
}
const observedIter = { key: '', cap: 0, observedMax: 0, refine: 0, repainted: false };
/* The iteration ceiling the renderer actually used for the frame currently
 * landing.  lastMeta.cap was never written anywhere, so the "at limit" test
 * below always read 0 and the whole observed mechanism stayed dormant. */
let frameIterCap = 0;
function observedViewKey() {
  const s = state;
  return [s.center.re, s.center.im, s.span.m, s.span.e,
          s.spec.mode, s.spec.kind, s.spec.power, s.rotation || 0].join('|');
}
function observedIterCap() {
  return observedIter.key === observedViewKey() ? observedIter.cap : 0;
}
/** One completed final frame.  Only a pixel that genuinely reached the cap is
 *  evidence; a purely interior frame is NOT (the desktop core lost 14x frame
 *  time to that mistake).  The raised ceiling is picked up by the next pass,
 *  never by a self-triggered repaint. */
function noteFrameObservation(cap, hi, bounded, refLen) {
  const key = observedViewKey();
  if (key !== observedIter.key) {
    observedIter.key = key;
    observedIter.cap = 0;
    observedIter.refine = 0;
    observedIter.repainted = false;
  }
  /* Desktop core (B10) "starved" test.  hi === 0 is NOT evidence of an
   * interior view when the reference itself ran out at the cap: every pixel
   * was cut off.  Bump the ceiling and repaint ONCE — otherwise the
   * truncated frame is what the user keeps seeing (the "black block"). */
  const starved = cap > 0 && hi === 0 && (refLen | 0) >= cap - 1;
  if (starved) {
    if (!observedIter.repainted && observedIter.refine < ITER.maxRefine) {
      const next = Math.min(ITER.safeCap, Math.max(cap + 1, ITER.starvedCap));
      if (next > observedIter.cap) {
        observedIter.cap = next;
        observedIter.refine++;
        observedIter.repainted = true;
        nativeLog(`[iter] starved refLen ${refLen | 0}/${cap} -> ${next}, repaint once`);
        scheduleRender(140);
      }
    }
    return;
  }
  if (!(hi > 0)) return;
  observedIter.observedMax = Math.max(observedIter.observedMax, hi | 0);
  /* Keep the measurement across views: the next frame at this depth starts
   * from what pixels actually did instead of the depth formula's guess. */
  rememberObservedDepth(depthNow(), hi | 0);
  /* "Exhausted" means pixels stopped AT the ceiling.  A backend that reports a
   * max escape well above the ceiling is reporting a different quantity (the
   * reconstructed core counts interior steps too), not exhaustion; trusting it
   * multiplied the home view's budget from 1626 to 6498 and made the first
   * full-resolution frame four times slower.
   *
   * `bounded > 0` used to be part of this test, meaning "some pixel is
   * interior".  That made the signal unreachable for the frames that need it
   * most: a boundary view whose escapes all stop just under the ceiling has no
   * interior pixels at all, so the budget never grew and every clipped ridge
   * stayed painted near-black -- the thin contour lines reported as "discrete".
   * The `hi <= cap * 1.05` bound is what actually rejects a bogus high value,
   * and it does that on its own. */
  const atLimit = cap > 0 && hi >= cap - 1 && hi <= cap * 1.05;
  if (!atLimit || observedIter.refine >= ITER.maxRefine) return;
  const obs = observedIter.observedMax;
  const budget = Math.max(vertexIterBudget(obs, obs),
                          checkCanvasIterBudget(obs));
  /* Same runaway guard as the desktop core: a false "exhausted" signal may
   * never grow the limit past four times the caller's ceiling. */
  const safe = Math.min(ITER.safeCap, Math.max(cap * 4, 4000));
  const next = Math.min(safe, Math.max(cap + 1, budget));
  if (next <= observedIter.cap) return;
  observedIter.cap = next;
  observedIter.refine++;
  nativeLog(`[iter] observed ${hi | 0}/${cap} -> ${next} (refine ${observedIter.refine})`);
}

function fmtDepth(d) {
  if (!isFinite(d)) return '—';
  if (d < 2.2) return (Math.pow(10, d)).toFixed(2) + '×';
  return '10^' + d.toFixed(1);
}

function fmtZoomFactor(d) {
  if (d < 0) return '1×';
  if (d < 3) return Math.pow(10, d).toFixed(1) + '×';
  return '10^' + d.toFixed(1);
}

function trimNum(s, n = 14) {
  const str = String(s);
  if (str.length <= n + 2) return str;
  const m = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.exec(str);
  if (!m) return str.slice(0, n) + '…';
  return str.slice(0, n + 2) + '…';
}

/* ---------------- Worker pool ---------------- */
const workers = [];
let wasmEnabled = null;
const mainQueue = [];
const thumbQueue = [];
let pending = 0;
let envSeq = 0;

function initWorkers() {
  // The desktop shell computes in C++ and only needs one worker as a fallback
  // for expression formulas; the browser build keeps the full pool.
  /* Use every core the device reports, minus one: the page itself, its
   * compositor and whatever else the user is running still need a slot, and an
   * idle core is the difference between "fast" and "the whole machine stutters".
   * 32 is a memory guard, not a performance one — each worker holds its own
   * copy of the kernel plus a reference orbit. */
  const cores = Math.max(2, navigator.hardwareConcurrency || 4);
  /* A phone that reports 8 cores still cannot feed 7 wasm workers with their
   * own orbit heaps; four keeps every core busy without swapping. */
  const n = NATIVE ? 1 : clamp(cores - 1, 2, TOUCH_UI ? 4 : 32);
  for (let i = 0; i < n; i++) {
    const w = new Worker('js/worker.js?v=28', { type: 'module' });
    const rec = { w, busy: false, ready: false, id: i };
    w.onmessage = (e) => onWorkerMessage(rec, e.data);
    w.onerror = (e) => console.warn('worker error', e.message);
    w.postMessage({ type: 'ping' });
    workers.push(rec);
  }
}

function idleWorker() {
  return workers.find(w => w.ready && !w.busy);
}

/* ---------------- Out-of-browser render core ---------------- */
/* Same rule as the worker pool: as many requests in flight as the machine has
 * cores to serve them, one short so the OS stays responsive. */
const REMOTE_MAX = Math.max(8, Math.min(32, (navigator.hardwareConcurrency || 4) - 1));
let remoteInflight = 0;
const remoteQueue = [];
const remoteCtl = new Set();

function remoteDispatch(job) {
  if (remoteInflight >= REMOTE_MAX) { remoteQueue.push(job); return true; }
  remoteInflight++;
  const ctl = new AbortController();
  remoteCtl.add(ctl);
  remoteRender(job.payload, ctl.signal)
    .then((msg) => {
      remoteCtl.delete(ctl);
      remoteInflight--;
      if (job.onDone) job.onDone(msg);
      pumpRemote();
    })
    .catch((err) => {
      remoteCtl.delete(ctl);
      remoteInflight--;
      // Deliberate cancellation from a view change: not a failure, and harmless to later requests
      if (err && err.name === 'AbortError') { pumpRemote(); return; }
      // Service not up / crashed mid-flight: fall back to in-browser rendering
      disableRemote();
      dispatchLocal(job);
      updateEngineLabel();
      pumpRemote();
    });
  return true;
}

function pumpRemote() {
  while (remoteInflight < REMOTE_MAX && remoteQueue.length && remoteEnabled()) {
    remoteDispatch(remoteQueue.shift());
  }
  if (!remoteEnabled()) {
    while (remoteQueue.length) dispatchLocal(remoteQueue.shift());
  }
}

function cancelRemote() {
  for (const c of remoteCtl) c.abort();
  remoteCtl.clear();
  remoteInflight = 0;
  remoteQueue.length = 0;
}

/* ---------------- Frame-wide reference environment ----------------
 *
 * A deep frame has one reference orbit, not one per tile.  Electing it costs a
 * high-precision pass over the whole iteration budget; letting every worker do
 * that for every tile is why splitting a 2^-57 view into 512 px tiles was
 * *slower* than rendering it as a single gigantic tile — and why that single
 * tile (over the kernel's 1 MiB slot) fell back to JavaScript and froze the
 * page for minutes.
 *
 * So the page builds it once, keeps the arrays, and ships them with every tile
 * of that view; each worker copies them into its own orbit slot.  The transfer
 * happens once per worker per view (`rec.envSig`), not once per tile.
 */
let sharedEnv = null;      // { sig, payload } — payload is what workers adopt
let envPreparing = null;   // signature currently being built
let envShareBroken = false; // set after a failed prepare: fall back for good

/* Content signature of a view: the same fields the worker's own `viewKey`
 * hashes — and deliberately *not* the pass buffer size, because the reference
 * orbit belongs to the plane region, not to a resolution.  Hashing the buffer
 * made every pass of a progressive chain rebuild it, and a tile dispatched
 * after the next pass had started fell back to electing its own reference,
 * which is visible as a seam at exactly that tile's edge. */
function envSigFor(payload) {
  const s = payload.spec;
  return [s.mode, s.kind, s.power,
    s.julia ? s.julia.re + ',' + s.julia.im : '',
    payload.center.re, payload.center.im, payload.span.m, payload.span.e,
    payload.maxIter, payload.bits].join('|');
}

/* Can this view use the shared environment at all?  The JS high-precision path
 * (custom formulas, bit depths past the kernel's tier) owns its orbit cache in
 * render.js and is not wired to adopt one, so those views keep the single-tile
 * deep pass. */
function envShareable(spec, psLog2) {
  if (NATIVE || wasmEnabled === false || envShareBroken) return false;
  /* The out-of-browser core takes tiles over HTTP as JSON, and the orbit is
   * megabytes of doubles — shipping it per tile would cost more than building
   * it.  Its deep passes keep the single-tile shape until it can cache orbits
   * server-side. */
  if (remoteEnabled()) return false;
  if (!spec) return false;
  if (spec.mode === 'x') return false;                 // custom expression
  if (psLog2 < -16300) return false;                   // beyond the kernel's tiers
  if (spec.mode === 'n') return true;                  // Newton
  return spec.kind === 'mandelbrot' || spec.kind === 'multibrot';
}

function prepareEnv(payload, sig, done) {
  const rec = workers.find(w => w.ready && !w.busy) || workers.find(w => w.ready) || workers[0];
  if (!rec) { done(null); return; }
  rec.busy = true;
  const id = `env${++envSeq}`;
  const timer = setTimeout(() => {
    if (rec.envJob !== id) return;
    rec.envJob = null; rec.envWait = null; rec.busy = false;
    envShareBroken = true;
    console.warn('[env] prepare timed out; deep tiles fall back to per-tile orbits');
    done(null); pump();
  }, 120000);
  rec.envJob = id;
  rec.envWait = (msg) => {
    clearTimeout(timer);
    rec.envJob = null;
    rec.busy = false;
    if (msg.error || !msg.re) {
      /* One failure is enough: never loop (a re-entered runPass would ask for
       * the same environment again), and never leave the frame unrendered. */
      envShareBroken = true;
      console.warn('[env] prepare failed: ' + (msg.error || 'no orbit arrays') +
                   ' — deep tiles will elect their own references');
      done(null);
    } else {
      const env = {
        key: msg.key, len: msg.len, stride: msg.stride,
        refU: msg.refU, refV: msg.refV, dd: !!msg.dd, series: msg.series,
        re: msg.re, im: msg.im, reLo: msg.reLo, imLo: msg.imLo
      };
      sharedEnv = { sig, payload: env };
      console.info(`[env] orbit len=${msg.len} dd=${msg.dd ? 1 : 0} ` +
                   `sa=${msg.series ? msg.series.skip : 0} — shared by all tiles`);
      done(env);
    }
    pump();
  };
  rec.w.postMessage({ type: 'prepare', id, job: payload });
}

/** Cheap content key for a 512x4 palette table. */
function lutFingerprint(lut) {
  let h = 2166136261;
  for (let i = 0; i < lut.length; i += 7) { h ^= lut[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function dispatch(job) {
  // User palettes carry their stop table with the job: workers / the remote
  // renderer never read localStorage, so the definition must travel along.
  const pl = job.payload;
  /* Folded families past 2^-34 belong to the in-page C++ double-double
   * kernel.  The out-of-browser core only understands the older direct /
   * perturb modes; sending these jobs there would render them in f64 again and
   * silently undo the whole precision path. */
  const needsDD = !!(pl && pl.psLog2 <= -34 && pl.spec &&
    pl.spec.mode !== 'x' && pl.spec.mode !== 'n' &&
    pl.spec.kind !== 'mandelbrot' && pl.spec.kind !== 'multibrot');
  if (pl) {
    const stops = customPaletteStops(pl.palette);
    if (stops) pl.paletteStops = stops;
    /* The worker LUT has no notion of handle positions, so an edited ramp is
     * resampled for it.  The native kernel gets the real stops and does not
     * come through here.  Register the same table locally so the exact LUT
     * below is built from it, not from an older ramp. */
    else if (pl.palette === state.palette && Array.isArray(state.stops)) {
      const rs = resampleStops(state.stops, 64);
      pl.paletteStops = rs;
      registerCustomPalette(pl.palette, rs);
    }
    /* A worker is a separate module instance: palettes registered on this
     * thread (an imported preset's additive table, a user gradient) do not
     * exist in its registry, so paletteLUT(id) there falls back to Ice.
     * Ship the exact 512-entry table instead, with a content key so an
     * unchanged palette is uploaded once per worker, not once per tile. */
    const lut = paletteLUT(pl.palette);
    if (lut && lut.length === 2048) {
      pl.paletteLUT = new Uint8Array(lut);
      pl.paletteKey = lutFingerprint(lut);
    }
  }
  if (!job.thumb && remoteEnabled() && !needsDD) return remoteDispatch(job);
  return dispatchLocal(job);
}

function dispatchLocal(job) {
  // Desktop shell: the native C++ engine renders the tile and streams it back
  // through a shared buffer.  Custom expressions / deep non-z^2 families keep
  // the worker path because the native kernel does not evaluate them.
  if (nativeUsable() && nativeCapable(job.payload.spec, job.payload.psLog2)) {
    return nativeRender(job.payload, job.onDone);
  }
  const rec = idleWorker();
  if (!rec) { (job.thumb ? thumbQueue : mainQueue).push(job); return false; }
  /* Deep tile of a frame whose reference orbit is already built: hand the
   * arrays over the first time this worker sees the view.  Structured clone
   * copies them, so the page keeps its own for the remaining tiles. */
  if (job.envSig && sharedEnv && sharedEnv.sig === job.envSig &&
      rec.envSig !== job.envSig && !job.env) {
    job.payload.env = sharedEnv.payload;
    rec.envSig = job.envSig;
  }
  rec.busy = true;
  pending++;
  rec.w.postMessage({ type: 'render', job: job.payload });
  rec.job = job;
  return true;
}

function pump() {
  while (mainQueue.length) {
    if (!dispatch(mainQueue.shift())) return;
  }
  /* Thumbnails never contend with the picture: while any main-view tile is in
   * flight (or queued behind an in-flight one), the preview grid waits.  A
   * settled frame must be produced by the core alone, not interleaved with
   * 249 preset previews grabbing workers mid-pass. */
  while (thumbQueue.length && pending === 0 && !liveBusy) {
    if (!dispatch(thumbQueue.shift())) return;
  }
}

function onWorkerMessage(rec, msg) {
  if (msg.type === 'env') {
    const wait = rec.envWait;
    rec.envWait = null;
    if (wait) wait(msg);
    return;
  }
  if (msg.type === 'ready') {
    rec.ready = true;
    if (wasmEnabled === null) {
      wasmEnabled = msg.wasm;
      updateEngineLabel();
    }
    const readyCount = workers.filter(w => w.ready).length;
    splash.set(0.16 + 0.16 * (readyCount / Math.max(1, workers.length)), 'bootKernel');
    if (readyCount === workers.length) splash.set(0.34, 'bootKernel');
    pump();
    return;
  }
  if (msg.type === 'stage') {
    if (msg.stage === 'orbit') splash.set(0.52, 'bootEnv');
    else if (msg.stage === 'env') splash.set(0.6, 'bootEnv');
    return;
  }
  if (msg.type === 'error') {
    console.warn('render error', msg.message);
    rec.busy = false; pending--; pump(); return;
  }
  if (msg.type === 'tile') {
    rec.busy = false; pending--;
    const job = rec.job;
    rec.job = null;
    if (job && job.onDone) job.onDone(msg);
    pump();
  }
}

/* Reference palettes are not LUTs: the native kernel evaluates pal() itself.
 * This maps the selected palette id to that model (0 = use the LUT instead). */
function palettePalId(id) {
  const entry = PALETTE_LIST.find(p => p.id === id);
  return entry && entry.pal ? entry.pal : 0;
}

/* Which colour model the native kernel should use for this view.
 *
 * Built-in schemes keep their own additive `pal()` — that is what they were
 * tuned against, and a ramp sampled from them would change the look.  Anything
 * else (a preset naming a palette the core does not have, or a ramp the user
 * has edited) travels as a gradient. */
function nativeColourSet() {
  if (Array.isArray(state.stops) && state.stops.length >= 2) {
    return { pal: 0, stops: stopsPayload() };
  }
  const entry = PALETTE_LIST.find(p => p.id === state.palette);
  if (entry && entry.pal != null) return { pal: entry.pal, stops: null };
  return { pal: 0, stops: stopsPayload() };
}

/* The colour set actually sent to the renderer.
 *
 * `state.stops` is the user's edited ramp; when it is null the selected
 * palette's own table is used, which is how a preset or a built-in scheme
 * reaches the native kernel.  Positions are real (not evenly spaced) because
 * the editor lets a handle sit anywhere. */
function effectiveStops() {
  if (Array.isArray(state.stops) && state.stops.length >= 2) {
    return state.stops.map(s => ({ pos: +s.pos, r: +s.r, g: +s.g, b: +s.b }));
  }
  return paletteStopList(state.palette);
}

/* Flat [pos,r,g,b] x n for the shell's tiny parser.
 *
 * host.cpp reads at most 4*64 numbers and installs at most 32 stops
 * (:807 / :1607).  An additive scheme is sampled at 256 points, and sending
 * all of them would leave the desktop engine shading with only the first
 * eighth of the palette period.  Resample across the whole range instead. */
function stopsPayload() {
  const list = effectiveStops();
  const src = list.length > 32
    ? Array.from({ length: 32 }, (_, i) => list[Math.round(i * (list.length - 1) / 31)])
    : list;
  const out = [];
  for (const s of src) {
    out.push(+s.pos.toFixed(5), +s.r.toFixed(5), +s.g.toFixed(5), +s.b.toFixed(5));
  }
  return out;
}

/* The span slider is logarithmic: 0 means "fit the cycle to the frame", and
 * everything above it maps to 0.05 … 2000 iterations per palette cycle. */
const SPAN_MIN = 0.05;
const SPAN_MAX = 2000;
function spanToCycle(v) {
  return v <= 0 ? 0 : SPAN_MIN * Math.pow(SPAN_MAX / SPAN_MIN, clamp(v, 0, 100) / 100);
}
function cycleToSpan(c) {
  if (!(c > 0)) return 0;
  return clamp(Math.round(100 * Math.log(c / SPAN_MIN) / Math.log(SPAN_MAX / SPAN_MIN)), 1, 100);
}

function fmtCycle(c) {
  if (!(c > 0)) return t('auto');
  return c < 10 ? c.toFixed(2) : String(Math.round(c));
}

/* Install one of the reference's own GLSL recipes.  The shader is only half
 * of a scheme: the JSON also carries its UniformsColor table, the neutral
 * values of the `params.param[]` sliders, the two region brightnesses and a
 * samples count.  All of them have to travel together or the same codegl
 * paints a different picture here than it did in the original program. */
/** Move the view to the coordinates an official scheme was authored at. */
function applySchemeView(v) {
  if (!v || v.re == null || v.im == null) return false;
  state.center = { re: String(v.re), im: String(v.im) };
  state.span = { m: +v.m || 1.6, e: v.e | 0 };
  state.rotation = +v.rotation || 0;
  state.presetId = null;
  if (typeof syncRotationUi === 'function') syncRotationUi();
  return true;
}

/* ---- the scheme dictionary ----------------------------------------------
 *
 * The reference keeps a library of Colorschemes: readColorschemes (00547860)
 * seeds it with the five built-ins when the key is missing and writes it
 * straight back through writeColorschemes (00545cb0); every scheme the program
 * creates is added by name (addjdict replaces on a duplicate key).  The store
 * here is the same JSON array under a localStorage key instead of a path, so
 * the library survives a restart with the reference's round-trip semantics.
 * ------------------------------------------------------------------------- */
/* v2: the library now starts from the reference's own colorschemes.json.  The
 * old key held a five-entry hand-built seed plus whatever was added on top of
 * it, so it has to be left behind rather than merged — its numbers are not the
 * reference's. */
const SCHEME_STORE_KEY = 'mb.colorschemes.v2';
let schemeDict = null;

function schemeStoreSave() {
  if (!schemeDict) return false;
  try {
    localStorage.setItem(SCHEME_STORE_KEY, writeColorschemes(schemeDict));
    return true;
  } catch { return false; }
}

function schemeStoreLoad() {
  let text = '';
  try { text = localStorage.getItem(SCHEME_STORE_KEY) || ''; } catch { /* private mode */ }
  const r = readColorschemes(text);
  schemeDict = r.dict;
  refreshReferenceSchemes();
  /* An absent (or unusable) library is written back immediately, which is what
   * readColorschemes does before it returns the seeded dictionary. */
  if (r.seeded) schemeStoreSave();
  return schemeDict;
}

/** Add one scheme to the library; the name is the key, as addjdict's is. */
function schemeStoreAdd(name, codegl, opts = {}) {
  if (!schemeDict || !name || !codegl) return null;
  const cs = newColorscheme({
    name,
    codegl,
    nparam: Math.max(0, opts.nparam | 0),
    samples: Math.max(1, opts.samples | 0 || 1),
    channels: opts.channels != null ? (opts.channels >>> 0) : inferChannels(codegl),
    auxfile: opts.auxfile || null
  });
  schemeDict.set(name, cs);
  schemeStoreSave();
  return cs;
}

/* ---- the reference's own built-in schemes -------------------------------
 *
 * `colorschemes.json` seeds the library, but a library entry is not selectable
 * on its own: the palette dropdown lists *recipes* (shader + params + colour
 * table).  These records are the bridge, so the six entries from that file
 * appear in the UI with the codegl, `channels`, `samples` and `nparam` the file
 * gives them.
 *
 * The file carries no colour table of its own — the reference colours these
 * schemes with the program's current `params.color` table — so each record
 * starts on the program's own default three terms (initParams) rather than an
 * invented palette.  `params.param[]` is likewise not in the file; 0.33 is the
 * neutral value the shipped presets use for their single distance/scale slider.
 * ------------------------------------------------------------------------ */
const REF_PARAM_LABELS = {
  'Distance': [{ zh: '距离缩放', en: 'Distance scale' }],
  'Distance and iteration levels': [{ zh: '距离缩放', en: 'Distance scale' },
                                    { zh: '层级缩放', en: 'Level scale' }],
  'Texture': [{ zh: '纹理尺度', en: 'Texture scale' }]
};
let refSchemeRecords = [];

function refreshReferenceSchemes() {
  refSchemeRecords = [];
  if (!schemeDict) return;
  for (const d of REFERENCE_COLORSCHEMES) {
    const cs = schemeDict.get(d.name);
    if (!cs) continue;
    const nparam = cs.nparam | 0;
    refSchemeRecords.push({
      id: 'glsl:ref:' + cs.name,
      name: cs.name, nameZh: cs.name,
      group: 'reference',
      nparam,
      params: Array.from({ length: nparam }, () => 0.33),
      paramLabels: (REF_PARAM_LABELS[cs.name]
        || Array.from({ length: nparam }, (_, i) => ({ zh: `参数 ${i + 1}`, en: `Param ${i + 1}` }))
      ).slice(0, nparam),
      colors: TRAP_DEFAULT_COLORS.map(c => [c.r, c.g, c.b, c.frequency, c.initial]),
      gf: REF_DEFAULT_LOG_FREQ, gi: 0,
      briFinite: 1, briInfinite: 1, briFactor: 1,
      samples: cs.samples | 0 || 1,
      channels: cs.channels >>> 0,
      glsl: cs.codegl
    });
  }
}

/* The reference's five built-ins are not part of the preset library, but
 * `Texture` is the only user-visible consumer of the auxfile image, so it is
 * offered next to the presets.  Its one parameter is the reference's own
 * `params.param[0]` (texture scale), and its three pal() terms are the
 * program's default table (initParams). */
const TEXTURE_SCHEME = {
  id: 'glsl:builtin-texture',
  name: 'Texture', nameZh: '纹理',
  glsl: GLSL_BUILTIN.texture.src,
  channels: GLSL_BUILTIN.texture.channels,
  nparam: 1, paramLabels: ['纹理尺度'], samples: 1,
  params: [0.33, 0.3],
  colors: [
    [1, 0, 0, -2.1202635765075684, -1.0],
    [0, 1, 0, -1.1363141536712646, -1.5],
    [0, 0, 1, -0.023268627002835274, -0.5]
  ],
  gf: REF_DEFAULT_LOG_FREQ, gi: 0,
  briFinite: 1, briInfinite: 1, briFactor: 1
};
const SCHEME_LIB_ALL = [TEXTURE_SCHEME, ...SCHEME_LIB];

function findSchemeAny(id) {
  if (id === TEXTURE_SCHEME.id) return TEXTURE_SCHEME;
  return findScheme(id) || refSchemeRecords.find(s => s.id === id) || null;
}

/* ---- auxfile image -------------------------------------------------------
 * The Texture scheme maps (log|z|, arg z) onto a 4x4 grid of 512 px tiles in
 * texturesgl.jpg.  Shipping the scheme without the image made it render pure
 * white — present but wrong — so the image travels with the exe (assets/,
 * bundled by tools/gen-ui-resources.mjs) and is uploaded on first need. */
let auxImageState = 0;   // 0 untouched, 1 loading, 2 ready, 3 failed
function ensureAuxTexture() {
  if (auxImageState) return;
  auxImageState = 1;
  const img = new Image();
  img.onload = () => {
    auxImageState = (gpu && gpu.uploadAuxImage(img)) ? 2 : 3;
    /* The field is untouched; only the colour pass has to run again. */
    if (auxImageState === 2 && lastDraw && lastDraw.fieldLive) {
      gpu.draw(lastDraw);
      if (juliaView) juliaView.redraw();
    }
    nativeLog('[aux] ' + (auxImageState === 2 ? 'texturesgl.jpg ' + img.width + 'x' + img.height : 'upload failed'));
    if (auxImageState !== 2) auxMissing();
  };
  img.onerror = () => { auxImageState = 3; nativeLog('[aux] texturesgl.jpg missing'); auxMissing(); };
  img.src = 'assets/texturesgl.jpg';
}

/* The Texture scheme samples the atlas for every exterior pixel.  With the
 * atlas missing the sampler returns a flat colour — a blank picture with no
 * clue why.  Keep a real picture instead: fall back to the smooth scheme's
 * shader (same colour table, same brightness), keep the selection in the
 * dropdown so the state stays visible, and say what happened. */
function auxMissing() {
  if (state.glsl && /\btex_aux\b/.test(state.glsl)) {
    state.glsl = GLSL_BUILTIN.smooth.src;
    state.schemeChannels = GLSL_BUILTIN.smooth.channels;
    state.schemeMeta = Object.assign({}, state.schemeMeta,
                                     { nparam: 0, paramLabels: [], samples: 2 });
    state.schemeParams = [];
    syncSchemeParams();
    renderNow();
  }
  toast(getLang() === 'en' ? 'texturesgl.jpg missing — showing Smooth'
                           : '缺少 texturesgl.jpg — 改用平滑着色');
}

function installScheme(id) {
  const s = findSchemeAny(id);
  if (!s) {
    state.glsl = null;
    state.schemeId = null;
    state.schemeChannels = null;
    state.schemeMeta = null;
    state.schemeParams = [];
    state.schemeColors = [];
    state.schemeBri = { finite: 1, infinite: 1, factor: 1 };
    return false;
  }
  state.schemeId = s.id;
  state.schemeMeta = { nparam: s.nparam, paramLabels: s.paramLabels,
                       samples: s.samples, name: s.name, nameZh: s.nameZh };
  state.glsl = s.glsl;
  state.schemeChannels = s.channels == null ? null : s.channels;
  /* Most of the reference's custom schemes paint the exterior a flat colour
   * and put all their detail on the boundary.  At the home view that is just
   * a solid rectangle, so follow the authored view unless the user opts out. */
  if (s.view && state.schemeFollowView) applySchemeView(s.view);
  state.schemeParams = s.params.slice();
  /* The scheme library stores the file's literal (log-domain) tuples.
   * loadParams converts them with exp(f_i + F) / init_i + I before pal()
   * ever sees them (00546630.c:79/:87); do it once here. */
  state.schemeColors = shaderTerms(s.colors.map(c => ({
    r: c[0], g: c[1], b: c[2], frequency: c[3], initial: c[4]
  })), s.gf, s.gi);
  state.schemeBri = {
    finite: s.briFinite, infinite: s.briInfinite, factor: s.briFactor
  };
  return true;
}

/* The original UI shows exactly `nparam` sliders for a scheme, each bound
 * to one `params.param[i]`.  Generate them here rather than shipping a fixed
 * set of controls: a scheme with one parameter must not show two sliders.
 * Moving one re-shades the remembered iteration field, so it never pays for
 * another iteration pass (FIELD_MEM hit). */
function syncSchemeParams() {
  const box = $('scheme-params');
  if (!box) return;
  const s = state.schemeMeta || findSchemeAny(state.schemeId);
  if (!s || !s.nparam) { box.hidden = true; box.innerHTML = ''; return; }
  const en = getLang() === 'en';
  const lib = findSchemeAny(state.schemeId);
  const viewRow = lib && lib.view
    ? `<div class="scheme-view-row">` +
      `<label class="chk"><input type="checkbox" id="chk-scheme-view"` +
      `${state.schemeFollowView ? ' checked' : ''}/>` +
      `<span>${t('schemeFollowView')}</span></label>` +
      `<button class="btn tiny" id="btn-scheme-view" type="button">${t('schemeGotoView')}</button>` +
      `</div>`
    : '';
  box.hidden = false;
  box.innerHTML =
    `<div class="scheme-title">${t('schemeParams')}` +
    `<span class="scheme-hint">${t('schemeParamsHint')}</span></div>` +
    s.paramLabels.map((lab, i) => {
      const v = Number.isFinite(+state.schemeParams[i]) ? +state.schemeParams[i] : 0;
      return `<div class="row tight"><label>${en ? lab.en : lab.zh}</label>` +
        `<input type="range" data-sp="${i}" min="0" max="1" step="0.005" value="${v}"/>` +
        `<span class="val mono" data-spv="${i}">${v.toFixed(2)}</span></div>`;
    }).join('') + viewRow;
  const followChk = box.querySelector('#chk-scheme-view');
  if (followChk) followChk.onchange = (e) => { state.schemeFollowView = !!e.target.checked; };
  const gotoBtn = box.querySelector('#btn-scheme-view');
  if (gotoBtn) gotoBtn.onclick = () => {
    if (lib && lib.view && applySchemeView(lib.view)) {
      state.schemeFollowView = true;
      syncColorUi();
      renderNow();
    }
  };
  for (const inp of box.querySelectorAll('input[data-sp]')) {
    inp.oninput = (e) => {
      const i = +e.target.dataset.sp;
      const v = +e.target.value;
      state.schemeParams[i] = v;
      const out = box.querySelector(`[data-spv="${i}"]`);
      if (out) out.textContent = v.toFixed(2);
      scheduleRender(90);
    };
  }
}

/* The trap row's own two sliders are only meaningful while a trap is on. */
function syncTrapUi() {
  const sel = $('sel-trap');
  if (sel) sel.value = String(state.traps | 0);
  const box = $('trap-params');
  if (box) box.hidden = !(state.traps > 0);
  const g = $('rng-trapgain');
  if (g) { g.value = state.trapGain; $('val-trapgain').textContent = (+state.trapGain).toFixed(2); }
  const r = $('rng-traprings');
  if (r) { r.value = state.trapRings; $('val-traprings').textContent = (+state.trapRings).toFixed(2); }
}

/* Push the whole colour state into the controls: used at boot and whenever a
 * preset or a saved link replaces the view. */
function syncColorUi() {
  const psel = $('sel-palette');
  if (psel) psel.value = state.schemeId || state.palette;
  syncSchemeParams();
  const of = $('rng-offset');
  if (of) { of.value = state.offset; $('val-offset').textContent = state.offset.toFixed(2); }
  syncTrapUi();
  const toneRows = [
    ['rng-bri', 'val-bri', 'bri'],
    ['rng-gr', 'val-gr', 'gr'], ['rng-gg', 'val-gg', 'gg'], ['rng-gb', 'val-gb', 'gb']
  ];
  for (const [id, vid, key] of toneRows) {
    if ($(id)) $(id).value = state.tone[key];
    if ($(vid)) $(vid).textContent = (+state.tone[key]).toFixed(2);
  }
  syncPaletteStrip();
  /* With a GLSL scheme active the shader takes its table from the scheme, so
   * the band ramp and its phase cannot affect the picture.  They are dimmed and
   * made non-interactive instead of silently doing nothing, and come back the
   * moment a band palette is selected. */
  const schemeOn = !!state.glsl;
  const ed = $('grad-ed');
  if (ed) ed.classList.toggle('inert', schemeOn);
  if (of) {
    of.disabled = schemeOn;
    const row = of.closest('.row');
    if (row) row.classList.toggle('inert', schemeOn);
  }
}

/* The native renderer implements the reference's four `color(Data)` bodies.
 * These values are the indices of that switch (mb_core.cpp, shade()). */
const COLOR_MODES = { bands: 0, iteration: 1, distance: 2, levels: 3 };
function colorModeNow() {
  const m = COLOR_MODES[state.scheme];
  return m === undefined ? 0 : m;
}

/* ---------------- Render scheduling (progressive passes) ---------------- */
let viewId = 0;
let tileTotal = 0;
let tileDone = 0;
let lastMeta = null;
/* Escape-count span over EVERY tile of the current pass.  `lastMeta` alone is
 * whatever tile arrived last — often a uniform one at deep zoom — and reading
 * "no structure" off it told the user a detailed frame had none. */
let passStats = null;
/* A pass can spend minutes inside one tile at deep zoom (every pixel runs the
 * full iteration budget), and the HUD only repaints when a tile lands — so the
 * elapsed clock used to freeze at "0% · 4712 ms" and look like a hang. */
let passTick = 0, passStartAt = 0;
function startPassClock(t0) {
  passStartAt = t0;
  if (passTick) return;
  passTick = setInterval(updateHud, 500);
}
function stopPassClock() {
  passStartAt = 0;
  if (!passTick) return;
  clearInterval(passTick);
  passTick = 0;
}
function resetPassStats() { passStats = null; }
function addPassStats(m) {
  if (!m) return;
  if (!passStats) passStats = { escMin: Infinity, escMax: -Infinity, bounded: 0 };
  if (typeof m.escMin === 'number' && isFinite(m.escMin)) passStats.escMin = Math.min(passStats.escMin, m.escMin);
  if (typeof m.escMax === 'number' && isFinite(m.escMax)) passStats.escMax = Math.max(passStats.escMax, m.escMax);
  passStats.bounded += m.bounded | 0;
}
let renderTimer = 0;
let quickTimer = 0;
let wheelTimer = 0;
let lastQuickAt = 0;
/* Accumulated gesture transform since the last committed pass, in normalised
 * units (src = sx*dst + ox).  Mirrors nc::Preview's composition exactly, so a
 * live pass can be committed WITH this transform instead of snapping back. */
let liveXform = { sx: 1, ox: 0, sy: 1, oy: 0 };
function liveApply(ndx, ndy, scale, ncx, ncy) {
  const inv = 1 / scale;
  const nsx = inv, nox = ncx * (1 - inv) - ndx * inv;
  const nsy = inv, noy = ncy * (1 - inv) - ndy * inv;
  const L = liveXform;
  liveXform = {
    sx: L.sx * nsx, ox: L.sx * nox + L.ox,
    sy: L.sy * nsy, oy: L.sy * noy + L.oy
  };
}
function liveReset() { liveXform = { sx: 1, ox: 0, sy: 1, oy: 0 }; }
let currentPass = 0;
let frameStartAt = 0;
let frameMs = 0;
let frameSeq = 0;   // completed progressive chains, for measurement scripts

/* ------------------------------------------------------------------
 * Measurement: frame time breakdown.
 *
 * Where the work runs has to be decided by numbers, so the numbers stay
 * reproducible: `__mb.seg(true)` logs one `[seg]` line per shaded pass with
 * the four segments that split talks about —
 *   field  CPU iteration field (reference orbit + per pixel, from the host)
 *   copy   host shared buffer -> our own copy (it is reused next pass)
 *   upload field -> texture (WebGL texSubImage2D / D3D11 UpdateSubresource)
 *   shade  the fragment program, synchronised with gl.finish()
 *   post   hand-over to the compositor (surface swap, HUD, snapshot copy)
 * The host->page hop is `arrive` minus `field`; it is reported, not hidden.
 * ------------------------------------------------------------------ */
let segOn = false;
let segCopyMs = 0;
function segBegin() {
  if (!segOn) return null;
  return { t: performance.now(), copy: segCopyMs, upload: 0, shade: 0, post: 0 };
}
function segMark(rec, k, t0) { if (rec) rec[k] += performance.now() - t0; }
function segReport(rec, meta, tag, w, h, arriveMs) {
  if (!rec) return;
  const m = meta || {};
  const wall = performance.now() - rec.t;
  const field = +m.ms || 0;
  const arrive = +arriveMs || 0;
  nativeLog(`[seg] ${tag} ${w}x${h} samples=${m.samples || 1} mode=${m.mode || '-'} ` +
            `iter=${m.maxIterUsed || 0} refLen=${m.refLen || 0} ` +
            `field=${field.toFixed(1)} (orbit=${(+(m.orbitMs) || 0).toFixed(1)} ` +
            `px=${(+(m.renderMs) || 0).toFixed(1)}) ` +
            `hop=${(arrive - field).toFixed(1)} ` +
            `copy=${rec.copy.toFixed(1)} upload=${rec.upload.toFixed(1)} ` +
            `shade=${rec.shade.toFixed(1)} post=${rec.post.toFixed(1)} ` +
            `wall=${wall.toFixed(1)} total=${(arrive + wall).toFixed(1)}`);
  const t1 = performance.now();
  requestAnimationFrame(() =>
    nativeLog(`[seg] paint ${tag} ${(performance.now() - t1).toFixed(1)}ms`));
}

/**
 * Progressive rendering: coarse first, then fine. Each pass uses fewer pixels and fewer iterations,
 * so the image keeps sharpening across passes instead of clearing the canvas on every zoom.
 */
/* Two passes, not three: a coarse frame to look at, then the real one.  The
 * middle 0.5 pass cost a quarter of the final frame's pixels and was replaced
 * within a second anyway — it only delayed the sharp frame. */
/* Progressive passes.  There used to be a 0.16 thumbnail and then the full
 * frame: on a 4.18 Mpx canvas at an iteration-heavy boundary that is a 20 ms
 * glance followed by ~1 s of stretched thumbnail, which is what "一放大就卡"
 * really looks like.  The middle pass costs ~0.3 s of a second on its own and
 * gives the eye real structure at a third of the linear resolution, so the
 * frame keeps improving instead of freezing. */
const PASS_PLAN = [
  { scale: 0.25, iter: 1 },
  { scale: 0.55, iter: 1 },
  { scale: 1.0, iter: 1 }
];
/* LIVE gesture rendering: one medium-resolution pass, re-issued while the
 * gesture runs.  The old 0.13/0.38 pair replaced a sharp GPU preview with a
 * visibly blurry thumbnail every 110 ms ("move -> blurry -> re-render").
 * A single 0.62 pass keeps the structure readable, the C++ core's cross-frame
 * vertex cache makes it cheap, and the committed frame keeps the accumulated
 * gesture transform so the picture never snaps back mid-gesture. */
const LIVE_PLAN = [
  { scale: 0.42, iter: 0.35, live: true }
];
const QUICK_PLAN = LIVE_PLAN;
/* A live pass exists only to keep the picture moving.  autoIterFor() reaches
 * ~56k at 10^30 (and the observed ceiling can push it to 200k), so a pass that
 * used the full budget took hundreds of milliseconds -- and the wheel issued
 * one every 28 ms.  No scheduler can make that smooth.  Cap the *preview*
 * budget; the committed frame after the gesture still gets the full count. */
const LIVE_ITER_CAP = 2200;
/* One engine, one frame (pipeline purity, user report "稳定后也是坏的"): at
 * perturbation depths the committed frame renders ONCE at full resolution.
 * The old 0.25/0.55 ladder compositied low-resolution tiles of the NEW view
 * over the previous pass while later passes were still landing, so the screen
 * spent seconds as a mix of two views — the light wedges over fine structure
 * in the user's screenshots.  Gesture feedback comes from the snapshot blit
 * and the live pass, not from half a committed chain. */
const DEEP_PASS_PLAN = [{ scale: 1.0, iter: 1 }];
/* Measurement only: a plan forced through `__mb.plan([...])` so the old
 * three-pass plan and this one can be timed on the same view, same session. */
let planOverride = null;
function passPlanForNow() {
  if (planOverride) return planOverride;
  return psLog2Now() <= -34 ? DEEP_PASS_PLAN : PASS_PLAN;
}
/* Weight of each pass (share of completion, estimated from pixel counts). */
const PASS_WEIGHT = [0.01, 0.08, 1.0];

function passProgress(idx, frac, planLen = 3) {
  if (planLen <= 1) return Math.round(frac * 100);
  const w = PASS_WEIGHT;
  const a = idx === 0 ? 0 : w[Math.min(idx - 1, w.length - 1)];
  const b = w[Math.min(idx, w.length - 1)];
  return Math.round((a + (b - a) * frac) * 100);
}

/* Native surface: true = the image lives in the shell's D3D child window and
 * the page must be see-through; false = the page canvas is the visible one.
 * Only ever turned on after a commit actually landed (see the flush handler),
 * so a broken swapchain can never leave the window blank. */
let nativeSurface = false;
function setNativeSurface(on) {
  /* Once the shell's GL canvas is presenting, the page canvas must stay hidden:
   * it has no pixels to contribute.  Before the first committed frame the page
   * must keep painting, so `nativeGLPresented()` (not `nativeGLOwned()`) gates
   * the *enabling*.
   *
   * Disabling is always allowed.  Forcing `on` here made the page unable to
   * come back to its own canvas when the shell cannot render the pass at all
   * (a custom formula, a scheme on the JS path): the window then showed the
   * shell's last frame forever, because the fresh pixels were painted into a
   * layer with `opacity: 0`. */
  if (!NATIVE || !nativeCanvasMode()) return;
  if (on && !nativeSurfaceLive()) on = false;
  if (nativeSurface === on) return;
  nativeSurface = on;
  if (document.documentElement)
    document.documentElement.classList.toggle('native-surface', on);
  nativeLog(`[surface] native=${on ? 1 : 0}`);
}

const tileCv = document.createElement('canvas');
const tileCtx = tileCv.getContext('2d');
/* Whole-pass surface used by the native single-buffer path. */
const frameCv = document.createElement('canvas');
const frameCtx = frameCv.getContext('2d');

function cancelAll() {
  mainQueue.length = 0;
  cancelRemote();
  viewId++;
  if (NATIVE) nativeCancel(viewId);
  // A superseded pass never settles (its tiles are dropped by the viewId
  // check), so the live-pass latch has to be released here or the gesture
  // pipeline stalls after the first full render.
  liveBusy = false;
  /* A cancelled pass never reaches its "got === total" branch. */
  stopPassClock();
}

function iterForPlan(plan) {
  const total = effectiveIterTotal();
  if (plan.iter >= 1) return total;
  const scaled = Math.max(48, Math.round(total * plan.iter));
  /* Only gesture previews carry `live`.  A measurement plan injected through
   * __mb.plan() with a fractional iter must keep its exact budget. */
  return plan.live ? Math.min(scaled, LIVE_ITER_CAP) : scaled;
}

function buildPayload(rect, W, H, iter) {
  let pm = state.span.m / W, pe = state.span.e;
  while (Math.abs(pm) >= 2) { pm /= 2; pe++; }
  while (Math.abs(pm) < 1) { pm *= 2; pe--; }
  const ps = pe < -1000 ? 0 : pm * Math.pow(2, pe);
  return {
    id: `v${viewId}-${rect.x}-${rect.y}-${W}`,
    viewId,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    width: W, height: H,
    /* Desktop core (B10): the host reads mode/kind/power/julia from the TOP
     * LEVEL.  A nested spec alone made the Julia canvas draw the M set. */
    mode: state.spec.mode,
    kind: state.spec.kind,
    power: state.spec.power | 0,
    juliaRe: state.spec.julia ? state.spec.julia.re : '0',
    juliaIm: state.spec.julia ? state.spec.julia.im : '0',
    spec: {
      ...state.spec,
      julia: { ...state.spec.julia },
      customExpr: state.spec.customExpr,
      customParams: state.spec.customParams
    },
    center: { ...state.center },
    span: { ...state.span },
    /* The shell reads flat fields (centerRe/centerIm/spanMant/spanExp); the
     * nested objects above are for the page's own bookkeeping.  Without these
     * four the host silently kept its defaults, i.e. every frame was rendered
     * at the start view no matter how far the user zoomed. */
    centerRe: state.center.re,
    centerIm: state.center.im,
    spanMant: Math.abs(state.span.m),
    spanExp: state.span.e,
    pixelSize: ps,
    psMant: pm,
    psExp: pe,
    psLog2: Math.log2(Math.abs(pm)) + pe,
    maxIter: iter != null ? iter : effectiveIterTotal(),
    bits: state.bits,
    palette: state.palette,
    ...nativeColourSet(),
    /* Colour set: the ramp (with real handle positions) and the tone stage.
     * Without these three the shell kept its own default palette, which is why
     * editing colours appeared to do nothing. */
    /* The reference drives band spacing from each scheme's own frequency;
     * a fitted band count would re-phase the whole frame on every zoom. */
    bands: Math.max(0, state.bands | 0),
    /* Detail: how small a feature the frame is asked to draw.  This is the
     * knob that decides whether a deep view reads as lines or as speckle. */
    detail: clamp(state.detail | 0, 0, 3),
    /* The trap statistic is accumulated by the iteration pass itself; the host
     * hands it back in the field's fourth channel. */
    traps: state.traps | 0,
    ncycle: state.cycleAuto ? 0 : Math.max(0.02, state.cycle),   // 0 = fit to frame
    tone: { ...state.tone },
    colorMode: colorModeNow(),
    cycle: effectiveCycle(),
    offset: state.offset,
    rotation: state.rotation || 0,
    // Distance-estimate rim: outlines the body/branches so they read against
    // the iteration bands instead of dissolving into them.
    de: { on: true, width: 1.0, strength: 0.55 },
    // Reference colour scheme (see colorschemes.json in the reference app):
    // 1 = "Distance" — empty field black, one-pixel white rim, interior colour.
    scheme: state.scheme === 'distance' ? 1 : 0,
    shade: state.shade | 0,
    dither: state.shade === 3,
    /* Tile-slot diagnostic (see worker.js `job.dbg`): opt-in only. */
    dbg: !!window.__mbDbgWasm,
    samples: 1
  };
}

/* Multiply a binary-exponent span, keeping the mantissa in [1, 2). */
function scaleSpan(sp, k) {
  let m = sp.m * k, e = sp.e;
  while (m >= 2) { m /= 2; e += 1; }
  while (m > 0 && m < 1) { m *= 2; e -= 1; }
  return { m, e };
}

/* Depth -> the largest escape count actually observed near it.  The recovered
 * program has no maxiter = f(zoom); `canvas->maxiter` is what pixels really
 * did (0046f630.c).  The depth formula below is only a first guess, and at
 * 2^-66 it guesses 38 089 where the frame really escapes at 11 441 — three
 * times the work for the same picture.  Remembering the observation turns the
 * next visit to that depth into a correctly-sized frame. */
const OBS_BY_DEPTH = new Map();
function rememberObservedDepth(depth, hi) {
  const bucket = Math.round(depth);
  const prev = OBS_BY_DEPTH.get(bucket) || 0;
  if (hi > prev) OBS_BY_DEPTH.set(bucket, hi | 0);
}
function observedForDepth(depth) {
  const bucket = Math.round(depth);
  let best = 0;
  for (let d = bucket - 1; d <= bucket + 1; ++d) {
    const v = OBS_BY_DEPTH.get(d) || 0;
    if (v > best) best = v;
  }
  return best;
}

/* First-frame fraction of the depth guess.  The formula is a conservative
 * upper bound (measured 3.3x high at 2^-66), so starting at 45 % of it still
 * clears the real escape count while cutting the first frame to half the
 * time.  If a boundary pixel really does reach the ceiling the observed
 * mechanism raises the budget and re-renders, so the picture is never left
 * short — it just gets there in two cheaper steps instead of one long one. */
/* A touch device pays for an extra full-quality pass with a far smaller CPU
 * budget, so give its first frame more of the estimate.  The starved rule
 * still repaints exactly once if the guess is short. */
const FIRST_GUESS_SCALE = TOUCH_UI ? 0.7 : 0.4;

function autoIterNow() {
  const d = depthNow();
  let it = autoIterFor(d);
  /* A previous frame at this depth already told us what the pixels do.  1.3x
   * is headroom for a neighbouring view being slightly harder; 0.35x of the
   * formula is the floor so a stale observation cannot starve a new view. */
  const seen = observedForDepth(d);
  if (seen > 0) it = Math.max(seen * 1.3, it * 0.35);
  else it *= FIRST_GUESS_SCALE;
  // Custom formulas take the JS path (high-precision environment + series perturbation); iterations cost far more, so tighten the cap
  if (state.spec.mode === 'x') it = Math.min(it, 6000);
  /* The rank scales the automatic budget: 100 is the full count, 1 is one per
   * cent of it.  Fewer iterations loses the finest filigree first, which is
   * exactly what makes the body of the shape read more clearly — and it is
   * also proportionally faster, so the slider doubles as a speed control. */
  const rank = clamp(state.autoRank | 0 || 100, 1, 100);
  return Math.max(16, Math.round(it * rank / 100));
}

/* Iteration budget for one pass.
 *
 * A preset stores a fixed count that suits *its own* framing.  Zooming into a
 * preset with that count frozen is exactly how "it works at 10^10 and dies at
 * 10^15" happens: the frame needs tens of thousands of iterations and is only
 * allowed the preset's 1150, so everything is painted as interior.  While a
 * preset is the current view the count therefore follows the depth, with a
 * floor so the preset's own look is preserved at its own scale.  Any manual
 * edit of the iteration control clears the preset and takes over again.
 */
function effectiveIterTotal() {
  const auto = autoIterNow();
  /* The observed ceiling from completed frames (0046f630.c) takes over from
   * the depth-derived first guess once real pixels have proved the budget too
   * tight.  It never lowers a manual count. */
  const obs = observedIterCap();
  if (state.autoIter) return Math.max(auto, obs);
  let it = state.maxIter;
  if (state.presetId && state.spec.mode !== 'x') it = Math.max(it, Math.round(auto * 0.6));
  return Math.max(it, obs);
}

function effectiveCycle() {
  if (!state.cycleAuto) return Math.max(2, state.cycle);
  const it = effectiveIterTotal();
  /* Ten colour cycles across the frame, which is what the recovered program
   * does (`out/src/render.cpp effective_palette_scale()`).
   *
   * This函数 used to return `6 * log2(it)` -- "60-120 bands at every zoom
   * level" -- on the theory that more bands show more structure.  They do not:
   * at 1e4 the iteration range across the screen is a few thousand, so sixty
   * bands means a hue step every ~40 iterations, and every step reads as a
   * hard contour arc.  That is the "discrete / 离散" look: the frame is not
   * quantised, it is over-banded.  Ten cycles keep the same field smooth at
   * every depth and match the reference's own exposure. */
  return clamp(Math.round(it / 10), 2, 4096);
}

/** Draw one pass of tiles onto the canvas: low-resolution passes are smoothly upscaled so no mosaic blocks appear */
/* ---------------- Colour-position field ----------------
 *
 * The CPU pass can hand back the *colour position* of every pixel instead of
 * its RGBA (kernel.cpp `gField`, worker.js `job.asField`).  The palette is the
 * only thing that turns a position into a colour, so a palette change does not
 * invalidate a single iteration: re-shading a finished frame costs one table
 * lookup per pixel instead of the whole render.
 *
 * Measured at 2^-30 (2496x1408): 5.5 s for the CPU re-render it replaces,
 * ~45 ms to re-shade.  The cache is keyed on everything that *does* move a
 * pixel's position — the view, the iteration budget, cycle/offset/bands and
 * the shade policy — but deliberately not on the palette itself.
 */
let fieldCaptureOn = true; // debug switch: __mb.field(false) renders straight to RGBA
let fieldCache = null;     // { key, w, h, data: Float32Array }
let fieldBuild = null;     // the final pass of the current render, accumulating

function fieldKeyNow() {
  return [state.center.re, state.center.im, state.span.m, state.span.e,
    effectiveIterTotal(), effectiveCycle(), state.offset, state.bands,
    state.shade, state.spec.mode, state.spec.kind, state.spec.power,
    state.spec.julia ? state.spec.julia.re + ',' + state.spec.julia.im : '',
    state.traps, state.aa, state.bits, state.glsl ? 1 : 0,
    canvas.width, canvas.height].join('|');
}

/** Shade `data` (one colour position per pixel, -1 = interior) into RGBA. */
function shadeField(data, w, h, lut) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, n = w * h, o = 0; i < n; i++, o += 4) {
    const u = data[i];
    if (!(u >= 0)) { out[o] = 5; out[o + 1] = 6; out[o + 2] = 9; out[o + 3] = 255; continue; }
    let x = u * 512;
    let i0 = x | 0;
    if (i0 > 511) i0 = 511;
    const f = x - i0, j0 = (i0 + 1) & 511;
    const a = i0 * 4, b = j0 * 4;
    out[o] = lut[a] + (lut[b] - lut[a]) * f;
    out[o + 1] = lut[a + 1] + (lut[b + 1] - lut[a + 1]) * f;
    out[o + 2] = lut[a + 2] + (lut[b + 2] - lut[a + 2]) * f;
    out[o + 3] = 255;
  }
  return out;
}

/** The 512-entry table the CPU path would use for the current colours. */
function currentLut() {
  const stops = customPaletteStops(state.palette) ||
    (Array.isArray(state.stops) ? resampleStops(state.stops, 64) : null);
  if (stops) registerCustomPalette(state.palette, stops);
  return paletteLUT(state.palette);
}

/** Re-shade the cached field with the current palette.  False = render. */
function reshadeFromField() {
  if (!fieldCache) return false;
  if (fieldCache.key !== fieldKeyNow()) return false;
  const t0 = performance.now();
  const rgba = shadeField(fieldCache.data, fieldCache.w, fieldCache.h, currentLut());
  /* Re-shading paints the 2D canvas.  The shader declined this frame (that is
   * why recolourOnly() reached here), so the GL layer must not stay on top:
   * otherwise a palette click visibly does nothing. */
  setGlSurface(false);
  composeTile(ctx, { canvas: tileCv, ctx: tileCtx },
    { x: 0, y: 0, w: fieldCache.w, h: fieldCache.h, data: rgba },
    fieldCache.w / canvas.width);
  lastMeta = Object.assign({}, lastMeta, { ms: performance.now() - t0, engine: 'reshade' });
  frameSeq++;
  updateHud(true);
  takeSnapshot();
  return true;
}

/**
 * A colour changed and nothing else did.  In order of cost:
 *   1. the fragment shader repaints from its own iteration — one draw;
 *   2. the cached colour-position field is re-shaded — one table lookup;
 *   3. otherwise the frame really has to be re-rendered.
 */
function recolourOnly() {
  if (wgpuPass()) return;
  if (scenePass()) return;
  if (reshadeFromField()) return;
  scheduleRender(60);
}

function drawTile(msg, scale, passW, passH) {
  /* A tile from a pass buffer of a different size can only be a leftover from
   * a pass that started before the canvas changed shape (a panel opening, a
   * window drag, a DPR change).  Compositing it would place its pixels at the
   * wrong scale and leave a hole where it should have been — the block pattern
   * in the report.  Drop it; the pass it belonged to is already superseded. */
  if (passW && (msg.width !== passW || msg.height !== passH)) {
    if (window.__mbDebug) {
      (window.__mbDropped = window.__mbDropped || []).push(
        { x: msg.x, y: msg.y, w: msg.w, h: msg.h, tw: msg.width, th: msg.height, pw: passW, ph: passH });
    }
    return;
  }
  /* `tailKept` is the worker's workspace self-check: bytes of the tile slot the
   * kernel failed to write (always 0 on a healthy layout). */
  if (window.__mbDebug) {
    (window.__mbTiles = window.__mbTiles || []).push({
      x: msg.x, y: msg.y, w: msg.w, h: msg.h, s: scale,
      mode: msg.meta && msg.meta.mode, gl: msg.meta && msg.meta.glitches,
      tailKept: msg.meta && msg.meta.tailKept,
      /* 'env' = this tile adopted the frame-wide reference orbit.  A deep
       * frame must be all 'env': tiles that elect their own disagree at the
       * seams, because each reference leaves its own glitch pattern. */
      ref: msg.meta && msg.meta.refSrc, ms: msg.meta && Math.round(msg.meta.ms)
    });
  }
  if (msg.meta && msg.meta.field) {
    const f = msg.data;
    /* Keep the raw positions for the re-shade cache before they are consumed
     * by the colour stage. */
    if (fieldBuild && fieldBuild.w === msg.width && fieldBuild.h === msg.height) {
      for (let y = 0; y < msg.h; y++) {
        const src = y * msg.w;
        fieldBuild.data.set(f.subarray(src, src + msg.w), (msg.y + y) * fieldBuild.w + msg.x);
      }
    }
    msg = { x: msg.x, y: msg.y, w: msg.w, h: msg.h,
            data: shadeField(f, msg.w, msg.h, paletteLUT(state.palette)) };
  }
  composeTile(ctx, { canvas: tileCv, ctx: tileCtx }, msg, scale);
}

/**
 * Paint a whole pass that arrived in one buffer.  One putImageData plus one
 * scaled drawImage replaces N per-tile composites; AA reduction and smooth
 * upscaling still go through the same drawlib path, so the look is identical.
 */
function paintFrame(f, scale) {
  if (!f || !f.data) return;
  composeTile(ctx, { canvas: frameCv, ctx: frameCtx },
    { x: 0, y: 0, w: f.w, h: f.h, data: f.data }, scale);
}

/* ------------------------------------------------------------------
 * GPU pass.
 *
 * One request for the whole frame, and the shell returns the iteration field
 * rather than pixels.  Everything after that is one draw call.
 *
 * Why this is worth a second pipeline: the field does not depend on the
 * colours, so a scheme change re-runs only the shader — the reference program
 * behaves the same way, which is why its palette sliders are instant no matter
 * how deep the view is.  It is also the only route to the presets whose whole
 * look is a fragment shader.
 *
 * Returns true when it took the pass; false means "fall back to CPU tiles".
 * ----------------------------------------------------------------*/
/* ---------------- Field memory ----------------
 * The reference keeps its computed AREA / PREPIXELS around and only
 * recomputes what a new view actually invalidates (00427ab0.c:152,
 * 00498570.c:88-107).  Here the equivalent is the iteration field itself:
 * it is a property of the *view*, never of the colours.  Remembering the last
 * few finished fields means a palette edit, a tone change, a zoom back out or
 * a return to a preset costs one shader draw instead of another full
 * iteration pass — the "already rendered work is remembered" behaviour.
 *
 * The key deliberately excludes every colour term.  A host buffer is reused
 * on the next pass, so the cached copy must be our own, not a view onto it. */
const FIELD_MEM = new Map();
let fieldMemBytes = 0;
/* 96 MB default; phones get 32 MB because a background tab can be killed for
 * holding a tenth of the device's RAM.  `cachesize` (9/10/11 -> 1/4, 1x, 4x)
 * and `totalmemory` (at most a quarter) from appdata\mandelbrot.json scale it
 * on the desktop shell. */
let FIELD_MEM_BUDGET = (TOUCH_UI ? 32 : 96) * 1024 * 1024;
const FIELD_MEM_MAX_ENTRIES = TOUCH_UI ? 3 : 8;
function fieldMemoryKey(p) {
  const s = p.spec || {};
  /* Everything that can change the *field* must be here; everything that
   * only changes the colour must not be.  A custom formula, a different
   * precision or a distance channel all produce a different field, while a
   * palette, tone, cycle, phase or GLSL scheme produce the same one. */
  return [p.centerRe, p.centerIm, p.spanMant, p.spanExp, p.width, p.height,
          p.rotation || 0, p.maxIter, p.quality, p.bits,
          p.colorMode, p.scheme, p.shade, p.dither, p.traps, !!p.inverse,
          !!p.fieldValue,
          p.de && p.de.on, p.de && p.de.width, p.de && p.de.strength,
          s.mode, s.kind, s.power, s.juliaReS || '', s.juliaImS || '',
          s.julia && s.julia.re || '', s.julia && s.julia.im || '',
          s.newtonDegree, s.phoenixP, s.customExpr || '',
          JSON.stringify(s.customParams || {})].join('|');
}
function rememberField(key, w, h, data, meta, ch) {
  const bytes = data.byteLength;
  if (!bytes || bytes > 64 * 1024 * 1024) return;
  const prev = FIELD_MEM.get(key);
  if (prev) { fieldMemBytes -= prev.data.byteLength; FIELD_MEM.delete(key); }
  FIELD_MEM.set(key, { w, h, ch: ch === 6 ? 6 : 4, data, meta });
  fieldMemBytes += bytes;
  while ((fieldMemBytes > FIELD_MEM_BUDGET || FIELD_MEM.size > FIELD_MEM_MAX_ENTRIES) &&
         FIELD_MEM.size > 1) {
    const oldest = FIELD_MEM.keys().next().value;
    const rec = FIELD_MEM.get(oldest);
    fieldMemBytes -= rec.data.byteLength;
    FIELD_MEM.delete(oldest);
  }
}

function gpuPass(vId, plan, done, planList) {
  /* A user-typed iteration formula is not something the native field kernel can
   * evaluate.  Taking the GPU path here would quietly paint the built-in z^2
   * set and keep the shader's colours — the formula would look "applied" while
   * being ignored.  Custom mode therefore stays on the worker renderer, whose
   * deep tier owns the high-precision reference orbit and the jet series. */
  if (state.spec.mode === 'x') return false;
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return false;
  const s = plan.scale;
  const final = plan.scale >= 1;
  const pw = Math.max(16, Math.round(W * s));
  const ph = Math.max(16, Math.round(H * s));
  const iter = iterForPlan(plan);
  const idx = planList ? Math.max(0, planList.indexOf(plan)) : 0;

  const payload = buildPayload({ x: 0, y: 0, w: pw, h: ph }, pw, ph, iter);
  payload.quality = final ? 2 : 1;
  payload.aa = 1;                       // the shader supersamples, not the kernel

  const terms = nativePaletteTerms(state.palette) || {};
  const flat = terms.palColors || [];
  /* `paletteStopList` already returns {pos, r, g, b} handles; an edited ramp
   * may still be raw [r,g,b] triples, so normalise both into one shape. */
  const stopsRaw = (state.stops && state.stops.length)
    ? state.stops
    : paletteStopList(state.palette);
  const stopList = (stopsRaw || []).map((c, i, a) => Array.isArray(c)
    ? { pos: i / Math.max(1, a.length - 1), r: c[0], g: c[1], b: c[2] }
    : { pos: c.pos, r: c.r, g: c.g, b: c.b });
  /* An official codegl is the authority when one is installed: the reference
   * compiles that source verbatim and feeds it the scheme's own Params.
   * A ramp the user has edited outranks it, otherwise dragging a stop on an
   * official scheme would silently do nothing. */
  const hasGlsl = !!(state.glsl && state.glsl.trim());
  const editedRamp = !!(state.stops && state.stops.length >= 2);
  const scheme = state.schemeMeta || findSchemeAny(state.schemeId);
  const useRamp = editedRamp || (!hasGlsl && !flat.length);
  /* An orbit trap owns the colour stage while it is on.  Its statistic lives
   * in the field's fourth channel, which every other shader reads as `dist2`,
   * so running both at once would make one of them lie. */
  const trapMode = state.traps | 0;
  const trapOn = trapMode > 0;
  const rampShade = useRamp && !trapOn;
  /* Only a codegl that is actually shading keeps its own Params/colour table;
   * a ramp run uses param[0] as iterations-per-cycle and param[1] as phase. */
  const glslActive = !trapOn && hasGlsl && !useRamp;

  /* The reference's `samples` is per-pixel supersampling inside the shader.
   * Every official scheme ships its own count (2 or 4), so a still frame uses
   * that rather than a global setting.  Gesture passes stay at one. */
  const samples = final
    ? (scheme ? clamp(scheme.samples | 0, 1, 4) : clamp(state.aa | 0, 1, 4))
    : 1;

  const schemeSrc = trapOn ? GLSL_BUILTIN.trap.src
                           : (glslActive ? state.glsl
                              : (useRamp ? GLSL_BUILTIN.ramp.src : activeSchemeSrc()));
  /* Already known to fail to compile: do not even try, and do not take the
   * whole GPU path down with it. */
  if (badSchemeSrc && schemeSrc === badSchemeSrc) return false;
  /* The channel mask is the scheme's own contract with the colour library:
   * built-ins declare exactly the members they read, a loaded codegl brings the
   * reference's `channels` number, and anything else is inferred from its body. */
  const schemeChannels = trapOn ? GLSL_BUILTIN.trap.channels
    : useRamp ? GLSL_BUILTIN.ramp.channels
    : activeSchemeChannels();
  /* Only the two Distance schemes (and a codegl declaring those channels)
   * need the derivative recurrence.  An orbit trap writes its own value into
   * channel a and does not read dist, so it does not need it either.  On a
   * deep frame this removes one complex multiply per iteration per pixel. */
  payload.fieldDist = !trapOn && !!(schemeChannels & (CHANNEL.DIST | CHANNEL.DIST2));
  /* CHANNEL_VALUE (and CHANNEL_DERIVATIVE, which the reference aliases onto the
   * same two textures) needs z at the escape point.  That is a second field
   * plane — 50% more shared memory and one extra float pair per pixel — so it
   * is requested only by a scheme that actually reads it. */
  payload.fieldValue = !trapOn &&
    !!(schemeChannels & (CHANNEL.VALUE | CHANNEL.DERIVATIVE));
  /* A scheme that samples tex_aux needs the auxfile image; load it once, and
   * the pending draw below already runs with whatever is uploaded by then. */
  if (/\btex_aux\b/.test(schemeSrc)) ensureAuxTexture();
  const err = gpu.setScheme(schemeSrc, samples, schemeChannels);
  if (err) {
    /* One shader failing to compile must not cost the session its GPU path.
     * It used to set gpuOk = false for good, so a single bad `codegl` dropped
     * every later frame onto the CPU renderer — which looks exactly like "the
     * colour controls stopped working".  Remember the offending source and
     * skip only that one. */
    nativeLog('[glsl] ' + err.slice(0, 1200));
    /* Keep the failure attributable: the verification run switches through the
     * reference's schemes and needs to say which one did not compile. */
    (window.__mbShaderErrors = window.__mbShaderErrors || [])
      .push({ id: state.schemeId || null, err: String(err).slice(0, 400) });
    badSchemeSrc = schemeSrc;
    return false;
  }

  const passT0 = performance.now();
  startPassClock(passT0);
  const fk = fieldMemoryKey(payload);

  /* One shade step, shared by a fresh field and a remembered one. */
  const shade = (w, h, data, ch, meta, ms, cached) => {
    const seg = segBegin();
    const u0 = performance.now();
    if (ch >= 6) {
      /* Planar field: the colour plane first, then one value texel per pixel
       * (z at the escape point).  Both are subarray views — no repacking, which
       * would cost a 15 M float rewrite on a 2.5 Mpx window. */
      const plane = w * h * 4;
      gpu.uploadField(data.subarray(0, plane), w, h);
      gpu.uploadAux(data.subarray(plane, plane + w * h * 2), w, h);
    } else {
      gpu.uploadField(data, w, h);
    }
    gpu.resize(w, h);
    segMark(seg, 'upload', u0);

    const colors = [];
    if (trapOn) {
      /* The trap shader still calls pal(), so it needs a table.  An additive
       * palette supplies its own terms; a ramp palette has none, and the
       * program's own default three-term table is what the reference falls
       * back to in that case. */
      if (flat.length) {
        for (let i = 0; i + 4 < flat.length && colors.length < 20; i += 5) {
          colors.push({ r: flat[i], g: flat[i + 1], b: flat[i + 2],
                        frequency: flat[i + 3], initial: flat[i + 4] });
        }
      } else {
        for (const c of TRAP_DEFAULT_SHADER_COLORS) colors.push({ ...c });
      }
    } else if (glslActive) {
      /* The scheme's own UniformsColor table (params.color[].c/frequency/
       * initial).  Without it every `mix(c, params.color[0].c, …)` in an
       * official codegl would blend toward black. */
      for (const c of (state.schemeColors || [])) {
        if (colors.length >= 20) break;
        colors.push({ r: +c.r || 0, g: +c.g || 0, b: +c.b || 0,
                      frequency: +c.frequency || 0, initial: +c.initial || 0 });
      }
    } else if (!useRamp) {
      for (let i = 0; i + 4 < flat.length && colors.length < 20; i += 5) {
        colors.push({ r: flat[i], g: flat[i + 1], b: flat[i + 2],
                      frequency: flat[i + 3], initial: flat[i + 4] });
      }
    }
    const briF = glslActive ? state.schemeBri.finite
                         : (terms.briFinite != null ? terms.briFinite : 1);
    const briI = glslActive ? state.schemeBri.infinite
                         : (terms.briInfinite != null ? terms.briInfinite : 1);
    /* Brightness and the per-channel gains are the only console controls with
     * a counterpart in the reference (brightnessfinite/infinite and the
     * UniformsColor table).  Contrast, gamma, saturation and hue were removed
     * rather than left inert. */
    const T = state.tone;
    const gR = +T.gr || 1, gG = +T.gg || 1, gB = +T.gb || 1;
    const toneBri = T.bri == null ? 1 : +T.bri;
    if (gR !== 1 || gG !== 1 || gB !== 1) {
      for (const c of colors) { c.r *= gR; c.g *= gG; c.b *= gB; }
    }
    const drawOpts = {
      colors,
      stops: rampShade ? stopList.map(s => ({
        pos: s.pos, r: s.r * gR, g: s.g * gG, b: s.b * gB
      })) : [],
      briFinite: briF * toneBri,
      briInfinite: briI * toneBri,
      briFactor: glslActive ? state.schemeBri.factor : 1,
      /* Official schemes read params.param[i] — distance scale, detail
       * distance or iteration limit — from their own sliders.  A ramp instead
       * uses param[0] for iterations-per-cycle and param[1] for the phase. */
      param: glslActive
        ? [...state.schemeParams, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 10)
        : (trapOn
            ? [trapParam().gain, trapParam().rings, 0, 0, 0, 0, 0, 0, 0, 0]
            : [effectiveCycle(), state.offset, 0, 0, 0, 0, 0, 0, 0, 0]),
      julia: state.spec.mode === 'j',
      inverse: !!state.inverse,
      /* The reference's own clock.  A scheme that reads it animates; one that
       * does not sees a constant, exactly as in the original program. */
      time: schemeTime()
    };
    const d0 = performance.now();
    gpu.draw(drawOpts);
    /* Measurement only: the draw call is asynchronous, so the shader's cost is
     * only visible after a sync.  Off by default (it costs a pipeline drain). */
    if (seg) gpu.gl.finish();
    segMark(seg, 'shade', d0);
    /* The reference's second viewport is shaded by the same program instance;
     * hand it the compiled scheme and the exact Params we just used. */
    lastDraw = { ...drawOpts, src: schemeSrc, samples, final, fieldLive: true };
    if (juliaView) juliaView.redraw();

    /* The shader layer is the picture now: hide the 2D one and let the
     * compositor do the rest.  No full-frame copy — on a 2.96 Mpx window that
     * copy alone measured longer than the iteration pass it was copying. */
    const p0 = performance.now();
    setGlSurface(true);
    try {
      const d = gpu.gl.getExtension('WEBGL_debug_renderer_info');
      const probe = new Uint8Array(4);
      gpu.gl.readPixels((gpu.canvas.width / 2) | 0, (gpu.canvas.height / 2) | 0,
                        1, 1, gpu.gl.RGBA, gpu.gl.UNSIGNED_BYTE, probe);
      nativeLog(`[gl] ${w}x${h} stops=${stopList.length} ramp=${useRamp} ` +
                `cyc=${effectiveCycle().toFixed(2)} err=${gpu.gl.getError()} ` +
                `samples=${samples} px=${probe[0]},${probe[1]},${probe[2]} ` +
                `cached=${cached} briF=${(+briF || 0).toFixed(2)} ` +
                `briI=${(+briI || 0).toFixed(2)} ` +
                `scheme=${scheme ? scheme.name : '-'} ` +
                `param=${hasGlsl ? state.schemeParams.map(v => (+v).toFixed(2)).join(',') : '-'} ` +
                `glsl=${state.glsl ? state.glsl.length : 0}B ` +
                `renderer=${d ? gpu.gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'}`);
    } catch (e) {
      nativeLog('[gl] diag failed: ' + (e && e.message));
    }
    tileTotal = 1;
    tileDone = 1;
    currentPass = idx;
    resetPassStats();
    addPassStats(meta);
    lastMeta = Object.assign({}, meta || {}, { ms, done: true, final: !!final });
    updateHud();
    takeSnapshot();
    if (!splash.finished && final) splash.finish();
    startShadeAnimation();
    segMark(seg, 'post', p0);
    segReport(seg, meta, 'gpu', w, h);
  };

  /* A remembered field needs only a shader draw: the palette, tones and
   * scheme may all have changed (setScheme above already rebuilt the shader),
   * but the iteration field itself has not. */
  const mem = FIELD_MEM.get(fk);
  const wantCh = payload.fieldValue ? 6 : 4;
  if (mem && mem.w === pw && mem.h === ph && mem.ch === wantCh &&
      mem.data.length === pw * ph * wantCh) {
    FIELD_MEM.delete(fk); FIELD_MEM.set(fk, mem);   // refresh LRU order
    shade(pw, ph, mem.data, mem.ch, mem.meta, performance.now() - passT0, 1);
    nativeLog(`[field] hit ${pw}x${ph} mem=${FIELD_MEM.size} ` +
              `${(fieldMemBytes / 1048576).toFixed(1)}MB`);
    done();
    return true;
  }

  const took = nativeField(payload, (msg) => {
    if (!msg || msg.viewId !== vId) return;
    /* A later view has been requested while this field was computing; the
     * result is stale and painting it would flash the old picture. */
    if (vId !== viewId) return;
    const ms = performance.now() - passT0;
    /* Remember every pass, not just the final one: a palette edit otherwise
     * still recomputes the skeleton and normal fields.  The host reuses its
     * shared buffer on the next pass, so a field we intend to keep must own its
     * bytes; a field the memory budget cannot hold is shaded straight out of the
     * host buffer instead and never copied. */
    {
      const bytes = msg.data.byteLength;
      /* `state.forceCopy` reproduces the old unconditional copy, so its cost can
       * be measured on the same view instead of being estimated. */
      /* One frame must always fit.  The budget used to be a flat 96 MB with a
       * 64 MB per-frame ceiling, so a 3282x1920 field (96.2 MB) could never be
       * kept: every palette change, every return to the same view and every
       * zoom-out paid for a full re-iteration.  The ceiling is now the larger
       * of the configured budget and two frames. */
      const budget = Math.max(FIELD_MEM_BUDGET, bytes * 2);
      const keep = state.forceCopy ||
                   (bytes > 0 && bytes <= budget &&
                    (FIELD_MEM.has(fk) ||
                     fieldMemBytes + bytes <= budget) &&
                    !state.noFieldCache);
      if (keep) {
        const c0 = performance.now();
        const copy = msg.data.slice ? msg.data.slice() : new Float32Array(msg.data);
        rememberField(fk, msg.w, msg.h, copy, msg.meta, msg.ch);
        segCopyMs = performance.now() - c0;
      } else {
        segCopyMs = 0;
        nativeLog(`[field] nocopy ${msg.w}x${msg.h} ` +
                  `${(bytes / 1048576).toFixed(1)}MB cache=${(fieldMemBytes / 1048576).toFixed(1)}MB`);
      }
    }
    shade(msg.w, msg.h, msg.data, msg.ch, msg.meta, ms, 0);
    done();
  });
  return took;
}

function runPass(vId, plan, done, planList) {
  const W = canvas.width, H = canvas.height;
  /* The field about to be computed is not the one on the GPU any more, so the
   * clock must stop painting over it until the new one is shaded. */
  if (lastDraw) lastDraw.fieldLive = false;
  let s = plan.scale;
  /* GPU path first: one whole-frame field, shaded in one fragment pass.  It is
   * taken whenever the depth and the scheme allow it, because everything the
   * field carries (the smooth count, the distance estimate, the escape count)
   * is exactly what the reference's shaders read — and a colour change then
   * costs one draw call instead of another iteration pass. */
  if (gpuOk && state.gpu && NATIVE && pageShaderOwns() &&
      gpuPass(vId, plan, done, planList)) return;
  /* The 2D canvas is the picture from here on: with a custom formula (or a
   * scheme that failed to compile) the shader layer must not stay on top of
   * it, or the frames painted below would be invisible. */
  setGlSurface(false);
  /* Supersampling: only the final (full-resolution) pass is rendered at
     s x aa and box-reduced by the drawing layer.  Progressive low-res passes
     stay 1x so the zoom preview keeps its latency. */
  const final = plan.scale >= 1;
  /* An hd canvas already doubles the sample count, so a 3x final pass on a
     large window would allocate tens of megapixels.  Cap the *effective*
     factor (not the user's setting) so one pass stays under ~16 MP. */
  let ss = final ? Math.max(1, Math.min(4, state.aa | 0)) : 1;
  while (ss > 1 && (W * ss) * (H * ss) > 16e6) ss--;
  /* A device-pixel buffer is already a supersample: at dpr 1.9 the canvas holds
   * 2x the CSS pixels, so stacking 2x2 supersampling on top rendered 12 MP for
   * a 6 MP screen — four times the work for no visible difference.  The budget
   * is "at most 2 samples per CSS pixel". */
  const dprNow = Math.min(2, window.devicePixelRatio || 1);
  while (ss > 1 && ss * dprNow > 2) ss--;
  /* Deep passes pay double-double arithmetic per pixel, so the pass cost is
   * quadratic in `ss` exactly where latency matters most.  The lattice output
   * is already interpolated (the rim comes from a signed-distance zero
   * crossing, not from point samples), so supersampling buys very little
   * there: measured 3732 ms -> ~950 ms for the same frame at ss=1.
   * Keep one sample and spend the budget on the live cadence instead. */
  if (final && psLog2Now() <= -34) ss = 1;
  /* NB: the pass buffer is declared to the shell as cw*ss x ch*ss, and the
   * compositor maps it 1:1 onto the canvas, so a pass may not be rendered at
   * an arbitrary fraction of the canvas.  Depth therefore buys its speed from
   * ss (above) and from the live-pass scale, not from a hidden downscale. */
  const pw = Math.max(8, Math.round(W * s * ss));
  const ph = Math.max(8, Math.round(H * s * ss));
  const iter = iterForPlan(plan);
  /* Tiles exist so the work can run in parallel.  A deep pass used to be the
   * exception — every tile elected its own reference point and built its own
   * high-precision orbit, so splitting the frame multiplied that cost and was
   * slower than one enormous tile.  One enormous tile is worse than it sounds:
   * it exceeds the kernel's 1 MiB output slot, falls back to the JavaScript
   * renderer for the whole frame, and leaves the page frozen with half a
   * picture (and, past the reference's precision, whole blocks of flat
   * colour).  prepareEnv() now builds the orbit once for the view and every
   * tile adopts it, so the deep pass tiles like any other. */
  const deepPass = psLog2Now() <= -34;
  const shareEnv = deepPass && envShareable(state.spec, psLog2Now());
  /* Folded families (tricorn / burning ship / celtic / perpendicular / phoenix)
   * now use the C++ double-double kernel, which needs NO reference orbit.  They
   * inherited the "one whole-frame tile" shape from the JS high-precision
   * renderer; on any canvas wider than 512 px that tile overflows the kernel's
   * 1 MiB output slot, so the worker fell straight back to JS again — 29 s for
   * one celtic frame.  Tiling is free for a direct kernel, so split it. */
  const ddDirect = deepPass && state.spec.mode !== 'x' && state.spec.mode !== 'n' &&
    !(state.spec.kind === 'mandelbrot' || state.spec.kind === 'multibrot');
  /* One tile must fit the shell's 1 MB shared slot (512x512 RGBA), so the
   * upper bound is a hard 512 even when supersampling asks for more. */
  const tw = (deepPass && !shareEnv && !ddDirect)
    ? Math.max(pw, ph)
    : Math.min(512, Math.max(40, Math.round(Math.min(TILE, state.tilePx || TILE) *
                                            Math.max(s, 0.5) * ss)));
  const tiles = [];
  for (let y = 0; y < ph; y += tw) {
    for (let x = 0; x < pw; x += tw) {
      tiles.push({ x, y, w: Math.min(tw, pw - x), h: Math.min(tw, ph - y) });
    }
  }
  tiles.sort((a, b) =>
    Math.hypot(a.x + a.w / 2 - pw / 2, a.y + a.h / 2 - ph / 2) -
    Math.hypot(b.x + b.w / 2 - pw / 2, b.y + b.h / 2 - ph / 2));

  /* Build (or find) the frame-wide reference orbit before dispatching.  The
   * prepare is one message round trip on one worker; the alternative for every
   * worker is the same high-precision pass, in parallel, once per view. */
  let envSig = null;
  if (shareEnv) {
    const p0 = buildPayload(tiles[0], pw, ph, iter);
    envSig = envSigFor(p0);
    if (!(sharedEnv && sharedEnv.sig === envSig)) {
      if (envPreparing === envSig) return;          // its callback re-enters
      envPreparing = envSig;
      const t = performance.now();
      console.info(`[env] building reference orbit for ${tiles.length} tiles ` +
                   `(2^${psLog2Now().toFixed(1)}, ${iter} iter)`);
      updateHudSoon();
      prepareEnv(p0, envSig, (env) => {
        envPreparing = null;
        if (vId !== viewId) return;                 // view changed while building
        nativeLog(`[env] ready in ${(performance.now() - t).toFixed(0)} ms`);
        console.info(`[env] ready in ${(performance.now() - t).toFixed(0)} ms`);
        runPass(vId, plan, done, planList);         // re-enter with the env in place
      });
      return;
    }
  }
  const total = tiles.length;
  const idx = planList.indexOf(plan);
  let got = 0;
  currentPass = idx;
  resetPassStats();

  // Single-buffer mode: the native shell writes every tile of this pass into
  // one shared surface and publishes it once, so the per-tile round trip
  // (and its putImageData) disappears from the hot path.
  const probe = buildPayload(tiles[0], pw, ph, iter);
  const useFrame = NATIVE && nativeFrameReady() && nativeCapable(probe.spec, probe.psLog2);
  if (useFrame) nativeFrameBegin(vId, pw, ph, ss, W, H);
  // This pass will paint the page canvas (JS fallback) — make sure it is visible.
  else setNativeSurface(false);
  /* Either way a CPU pass owns the 2D canvas from here.  The single-buffer
   * native path used to skip this, leaving `gl-surface` on and hiding the
   * whole frame after the shader had declined. */
  setGlSurface(false);
  const passT0 = performance.now();
  startPassClock(passT0);

  /* The compositor ratio belongs to this *pass*, not to the window it happens
   * to be running in.  `pw` was computed from canvas.width at the top of this
   * function; reading canvas.width again per tile meant that anything resizing
   * the canvas while a pass was in flight — the console panel opening, the
   * window being dragged — changed the ratio mid-pass.  Every tile already in
   * flight then landed scaled by a different factor, which is exactly the
   * "big misaligned blocks with black gaps" picture.  Capture it once, and
   * reject any tile that does not belong to this pass buffer.
   *
   * The final CPU pass doubles as the colour-position capture: the tiles come
   * back as one float per pixel, the page shades them, and the raw positions
   * are kept so a palette change is a table lookup instead of a re-render. */
  const passScale = pw / Math.max(1, W);
  const passPw = pw, passPh = ph;
  /* The out-of-browser core returns raw RGBA over HTTP (JSON meta + binary
   * body), so the field capture stays on the in-page worker path. */
  /* The out-of-browser core advertises colour-position output in /ping
   * (version 3).  Older servers only ever returned RGBA, so asking them for a
   * field would be interpreted as random pixels.  dd-direct tiles always stay
   * on the local worker, so they can capture a field regardless. */
  const remoteFieldOk = !remoteEnabled() ||
    !!(remoteStatus().info && remoteStatus().info.field) || ddDirect;
  const captureField = final && !useFrame && !state.glsl &&
    remoteFieldOk && fieldCaptureOn;
  fieldBuild = captureField ? { w: pw, h: ph, data: new Float32Array(pw * ph) } : null;

  for (const rect of tiles) {
    const payload = buildPayload(rect, pw, ph, iter);
    // Skeleton pass -> normal -> final.  The native kernel spends far fewer
    // iterations on the coarse passes and only the structure bands get the
    // full budget, so the first frame lands without waiting for the whole view.
    payload.quality = idx === 0 ? 0 : (final ? 2 : 1);
    /* The reference always renders SAMPLES x SAMPLES sub-pixels (its
     * examples ship samples = 2).  `ss` is the page-side resolution
     * multiplier, which would cost 4x memory; the core's `aa` does the
     * same thing adaptively on the pixels that need it, so the final
     * pass asks for that and the preview passes stay at 1. */
    payload.aa = final ? 2 : 1;
    payload.frame = useFrame;
    payload.asField = captureField;
    dispatch({
      payload,
      envSig,
      onDone: (msg) => {
        if (msg.viewId !== vId) return;
        /* The compositor scale is a property of the *pass buffer*, not of this
         * tile: every tile is rendered into a pw x ph buffer (pw already
         * includes s and ss) and must map 1:1 onto the canvas with the same
         * ratio.  Passing `s * ss` here was wrong for the incremental passes:
         * they run with ss = 1, so a tile rendered at full buffer resolution
         * was blitted at 1:1 into a canvas that is half that size — twice too
         * large, at the wrong place, over the top of an already correct frame.
         * That is the black band that appeared every 256 pixels. */
        if (!msg.frame) drawTile(msg, passScale, passPw, passPh);
        addPassStats(msg.meta);
        /* The per-tile meta describes ONE tile.  Everything the HUD derives
         * from it that claims something about the whole frame (the "no
         * structure" overlay above all) waits for `done`, which is only set
         * once every tile of the pass has landed. */
        lastMeta = Object.assign({}, msg.meta, { done: false, final });
        got++;
        tileTotal = total;
        tileDone = Math.round(passProgress(idx, got / total, planList.length) / 100 * total);
        // Ten DOM writes per tile force a layout each time and dominate the
        // pass latency; one update per animation frame is enough for the HUD.
        updateHudSoon();
        if (got === total) {
          // The HUD's "done" time must be this pass, not the last tile's:
          // the final pass is split into many small tiles whose per-tile
          // renderMs rounds to 0, which made the HUD look timing-less.
          lastMeta = Object.assign({}, msg.meta, {
            ms: performance.now() - passT0, done: true, final
          });
          stopPassClock();
          updateHud();
          /* A complete final pass in field mode becomes the re-shade cache.
           * Anything that moves a pixel's colour position invalidates it (see
           * fieldKeyNow), so a stale entry can never be used for a new view. */
          if (captureField && fieldBuild) {
            fieldCache = { key: fieldKeyNow(), w: fieldBuild.w, h: fieldBuild.h, data: fieldBuild.data };
          } else if (final) {
            fieldCache = null;
          }
          fieldBuild = null;
          const settle = () => {
            takeSnapshot();
            if (nativeCanvasMode())
              nativeLog(`[pass] view=${vId} idx=${idx} scale=${s} ss=${ss} ` +
                        `ms=${(performance.now() - passT0).toFixed(1)}`);
            if (!splash.finished) {
              /* A single-pass plan closes the curtain on its first (and only)
               * pass; the ladder did it after the second. */
              if (idx === planList.length - 1) splash.finish();
              else if (idx === 0) splash.set(0.68, 'bootFirst');
            }
            done();
          };
          if (useFrame) {
            /* Hand the accumulated transform to the shell and rebase the page
             * IMMEDIATELY: preview events arriving between the flush message
             * and its ack must accumulate on the new frame, exactly like the
             * shell does after CommitPassWithPreview. */
            const xf = liveXform;
            liveReset();
            nativeFrameFlush(vId, (f) => {
              /* While the D3D surface is the visible one, copying the pass into
               * the (hidden) page canvas is pure cost — 11.8 Mpx putImageData +
               * drawImage per commit.  Only paint when this frame is what the
               * user actually sees, i.e. before the first successful commit or
               * after a fallback pass. */
              if (!nativeSurface) paintFrame(f, passScale);
              // A landed commit means the swapchain now holds this frame; from
              // here on the page can be transparent without going blank.
              if (f && f.w && f.ok !== false) setNativeSurface(true);
              settle();
            }, xf);
          } else { liveReset(); settle(); }
        }
      }
    });
  }
  if (!final) updateHud();
}

function renderPlan(plan, onDone) {
  cancelAll();
  frameStartAt = performance.now();
  const vId = viewId;
  tileDone = 0;
  tileTotal = 0;
  let i = 0;
  const next = () => {
    if (vId !== viewId) { nativeLog(`[plan-abort] view=${vId} idx=${i} viewId=${viewId}`); return; }
    if (i >= plan.length) {
      frameMs = performance.now() - frameStartAt;
      frameSeq++;
      stopPassClock();
      updateHud(true);
      takeSnapshot();
      if (onDone) onDone();
      return;
    }
    const idx = i++;
    try {
      runPass(vId, plan[idx], next, plan);
    } catch (err) {
      nativeLog(`[js-error] pass view=${vId} idx=${idx} ${err && err.message} :: ${err && err.stack}`);
      throw err;
    }
  };
  next();
  updateHud();
}

/* ------------------------------------------------------------------
 * Live passes.
 *
 * A gesture transforms the committed frame and nothing else: the real pass is
 * issued once, 360 ms after the wheel stops (07f0583c).  This block is the
 * alternative the desktop carried for a while — ONE cheap pass at a time on
 * the current view, never overlapping another — and it is kept, unused by the
 * wheel, for the cases that need a sharp frame mid-gesture.  The pass is
 * deliberately small: `LIVE_PX` pixels with the iteration count scaled down.  The pass is never allowed to overlap another (that would just divide
 * the same CPU time), and it is deliberately small: `LIVE_PX` pixels with the
 * iteration count scaled down, which lands in a few tens of milliseconds on
 * every depth we support.  The frame it commits is applied on top of the
 * accumulated gesture transform (nativeFrameFlush(..., liveXform)), so a
 * commit never snaps the picture back to where the pass started.
 * ---------------------------------------------------------------- */
const LIVE_PX_SHALLOW = 4.2e5;  // pixel budget of one live pass (direct path)
const LIVE_PX_DEEP = 1.2e5;     // deep views pay dd per vertex: keep it small
let liveBusy = false;
let liveAt = 0;

/** Resolution/iteration plan for the next live pass, fitted to the budget. */
function livePlan() {
  const W = canvas.width || 1, H = canvas.height || 1;
  const deep = psLog2Now() <= -45;
  const budget = deep ? LIVE_PX_DEEP : LIVE_PX_SHALLOW;
  const s = clamp(Math.sqrt(budget / (W * H)), 0.22, 0.8);
  return [{ scale: s, iter: deep ? 0.75 : 0.6, live: true }];
}

/** Render one live pass, unless the previous one is still running.
 *
 * Nothing calls this after the wheel moved to the 07f0583c model; it is here
 * for a caller that wants a sharp frame mid-gesture.  There is deliberately no
 * queue: a pass that arrives while another is in flight is dropped, because
 * queueing them is exactly what made the page-side pass latency climb
 * 30 -> 218 ms during a six-notch burst. */
function maybeLivePass() {
  if (wgpuSurface) return;
  /* The shader is already drawing every gesture frame at full resolution; a
   * CPU live pass on top of it would fight for the same canvas and overwrite
   * the HUD with a tile that never reaches the screen. */
  if (pageShaderOwns() && scene.ok && state.gpu &&
      sceneCanDraw(sceneView(), false)) return;
  if (!NATIVE && !wasmEnabled) return;
  if (liveBusy) return;
  liveAt = performance.now();
  liveBusy = true;
  renderLive(livePlan());
}

/** Like renderPlan, but for the live cadence: no cancel of in-flight work. */
function renderLive(plan) {
  viewId++;
  const vId = viewId;
  const t0 = performance.now();
  const run = () => {
    if (vId !== viewId) { liveBusy = false; return; }
    try {
      runPass(vId, plan[0], () => {
        liveAt = performance.now();
        liveBusy = false;
        /* The live pass just painted the real view over the canvas.  The
         * gesture, however, is still transforming the bitmap it took before
         * the pass started: the very next pointer event blits that older
         * picture back on top, and the frame alternates between "true render"
         * and "stretched stale snapshot" for the rest of the gesture.  That is
         * the flicker on every zoom step.  Re-take the bitmap and restart the
         * accumulated scale from it, so the transform always describes the
         * picture actually on screen. */
        if (!nativeCanvasMode()) {
          takeSnapshot();
          previewScale = 1;
        }
      }, plan);
    } catch (err) {
      liveAt = performance.now();
      liveBusy = false;
      nativeLog(`[js-error] live ${err && err.message}`);
    }
  };
  run();
}

function renderNow() {
  if (juliaView) juliaView.onViewChanged();
  /* Size the buffer before anything is dispatched: a deep frame at 4.2 Mpx is
   * three times the work of the same frame at 2.2 Mpx and looks the same. */
  applyDeepPixelCap();
  frameStartAt = performance.now();
  /* Record the ceiling this frame is actually rendered with, before any
   * backend can change the view.  The "at limit" evidence below needs it. */
  frameIterCap = effectiveIterTotal();
  /* WebGPU first: it is the only path that stays exact and cheap past df64's
   * reach, and it also replaces the df64 shader on the shallow views that were
   * stuttering. */
  if (wgpuPass()) return;
  /* The shader owns shallow views outright: one draw call, no tiles, no
   * worker round trip.  Everything it declines falls through to the CPU
   * pipeline unchanged. */
  if (scenePass()) return;
  renderPlan(passPlanForNow());
}

function scheduleRender(delay = 90) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderNow(), delay);
}

/** Wheel zoom: transform the previous frame instantly + a light preview; the full progressive render starts only after 300 ms of quiet */
function scheduleZoomRender(immediate) {
  if (immediate) {
    clearTimeout(wheelTimer);
    wheelTimer = 0;
    renderNow();
    return;
  }
  /* 07f0583c: one quiet timer, 360 ms.  No pass while the wheel is still
   * moving — a coarse pass under a stretched snapshot is the flicker. */
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelTimer = 0; renderNow(); }, 360);
}

/* ---------------- Visual feedback ---------------- */
function blitSnapshot(dx, dy, scale = 1, cx = 0, cy = 0) {
  const W = canvas.width, H = canvas.height;
  // Route 1: the frame lives in the native swapchain, so the gesture feedback
  // is a GPU transform in the shell instead of a JS canvas blit.
  if (nativePreviewTarget()) {
    if (!W || !H) return;
    const ndx = dx / W, ndy = dy / H, ncx = cx / W, ncy = cy / H;
    liveApply(ndx, ndy, scale, ncx, ncy);
    nativeCanvasPreview(ndx, ndy, scale, ncx, ncy, viewId);
    return;
  }
  /* A WebGPU frame lives on its own composited layer; transform that layer. */
  if (wgpuLive(dx, dy, scale, cx, cy)) return;
  /* A shader gesture is a fresh draw rather than a transform of the previous
   * frame: the picture follows the hand at full resolution. */
  if (sceneLive()) return;
  /* The shader frame is still the visible picture when it merely throttled
   * this event (one draw per 6 ms).  Painting the gesture transform into the
   * hidden 2D canvas is wasted work, and when the class later flips it exposes
   * a magnified low-resolution bitmap instead of the shader's sharp frame.
   *
   * `sceneCanDraw` — not `sceneView()` alone: a view the shader builds but
   * cannot draw (past df64's reach) returned truthy here and every pointer
   * event was swallowed, so a deep pan did not move the picture at all. */
  if (glSurface && scene.ok && state.gpu) {
    const sv = sceneView();
    if (sv && sceneCanDraw(sv, false)) return;
  }
  if (!snap.width) return;
  setGlSurface(false);
  ctx.save();
  /* A pinch scales the snapshot, so it exposes a border on all four sides and
   * there is no edge to continue; the page colour is the honest fill there.
   * (A pan does the opposite — see the edge stretch below.) */
  if (scale !== 1) {
    ctx.fillStyle = getComputedStyle(document.documentElement).backgroundColor ||
                    getComputedStyle(document.body).backgroundColor || '#06080c';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(snap, dx, dy);
  ctx.restore();
  /* A pan exposes a strip of the frame the snapshot does not cover.  Filling
   * it with the page background reads as a hard seam — the picture's own
   * background is whatever the renderer painted, and with the native surface
   * active the body colour is transparent, i.e. pure black.  Stretching the
   * snapshot's last row/column into the gap continues the picture instead:
   * one blit, no resampling of the visible area, no seam. */
  if (scale === 1) {
    if (dx > 0) ctx.drawImage(snap, 0, 0, 1, snap.height, 0, 0, dx, H);
    else if (dx < 0) ctx.drawImage(snap, snap.width - 1, 0, 1, snap.height, W + dx, 0, -dx, H);
    if (dy > 0) ctx.drawImage(snap, 0, 0, snap.width, 1, 0, 0, W, dy);
    else if (dy < 0) ctx.drawImage(snap, 0, snap.height - 1, snap.width, 1, 0, H + dy, W, -dy);
  }
}

function takeSnapshot() {
  /* A newly committed frame replaces the gesture's bitmap baseline. */
  previewScale = 1;
  if (nativeCanvasMode()) {
    // The shell resets its preview transform when a pass is committed, so the
    // page only needs the size so the snapshot bookkeeping stays consistent.
    snap.width = canvas.width;
    snap.height = canvas.height;
    return;
  }
  snap.width = canvas.width;
  snap.height = canvas.height;
  snapCtx.clearRect(0, 0, snap.width, snap.height);
  snapCtx.imageSmoothingEnabled = true;
  snapCtx.imageSmoothingQuality = 'high';
  if (wgpuSurface && wgpuCanvas.width > 0) {
    snapCtx.drawImage(wgpuCanvas, 0, 0, snap.width, snap.height);
  } else if (glSurface && glCanvas.width > 0) {
    /* The visible picture is the shader layer; its buffer may be smaller than
     * the canvas (a low-res field upscaled by the shader), so scale it. */
    snapCtx.drawImage(glCanvas, 0, 0, snap.width, snap.height);
  } else {
    snapCtx.drawImage(canvas, 0, 0);
  }
}

/* ---- pan ---------------------------------------------------------------
 * A pan moves the view, not a bitmap.  The old path translated the previous
 * frame and started a fresh (cancelling) pass every 55 ms; whichever renderer
 * owned the picture then either ignored the transform (a pass landed at the
 * old centre and snapped the image back) or never finished a pass at all,
 * which is exactly what "dragging does nothing, the picture flickers" was.
 * The gesture now only ever does two things per pointer event: update the
 * centre, and ask the surface that is actually visible to show it.
 * ---------------------------------------------------------------------- */

/**
 * A screen-pixel offset expressed in the plane's own axes.
 *
 * Two facts meet here and nowhere else:
 *
 *   - the plane's y axis points up while the screen's points down, so a
 *     downward drag has to become a negative imaginary offset;
 *   - a rotated view turns the plane *under* the screen, so the offset has to
 *     be rotated by the same angle before it is applied.
 *
 * Missing the second one is what makes a rotated view feel wrong: dragging
 * right moves the picture along the rotated axis, i.e. diagonally, and the
 * further the view is turned the less the picture follows the hand.  Every
 * gesture — pan, wheel zoom, pinch — goes through this function, so there is
 * only one place that can get it wrong.
 *
 * The result is in mantissa units with `e` as the shared exponent, which is the
 * form `shiftCoordScaled` wants: `value * 2^e`.
 */
function planeDelta(dxPx, dyPx) {
  const p = psPair();
  const th = state.rotation || 0;
  const c = Math.cos(th), s = Math.sin(th);
  const x = dxPx * p.m;
  const y = -dyPx * p.m;
  return { u: x * c - y * s, v: x * s + y * c, e: p.e };
}

/** Absolute plane coordinate under a client-space point, as a decimal string.
 *
 *  `screenToPlane` below adds a plane offset to `Number(center)` in double
 *  arithmetic.  At 10^17 a pixel is ~1e-17 while the centre is ~0.8, whose
 *  double ULP is 1.1e-16: the offset is swallowed, the whole window collapses
 *  onto about ten distinct values, and neither the Julia seed nor a zoom
 *  anchor can follow the pointer.  Build the sum in fixed point instead so the
 *  coordinate keeps exactly the width the renderer is using. */
function screenToPlaneHi(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = (clientX - r.left) * (canvas.width / Math.max(1, r.width));
  const sy = (clientY - r.top) * (canvas.height / Math.max(1, r.height));
  const d = planeDelta(sx - canvas.width / 2, sy - canvas.height / 2);
  const bits = Math.max(128, requiredBitsFromLog2(psLog2Now(), effectiveIterTotal()));
  return {
    re: shiftCoordScaled(state.center.re, d.u, d.e, bits),
    im: shiftCoordScaled(state.center.im, d.v, d.e, bits)
  };
}

/** Absolute plane coordinate under a client-space point.
 *  The reference's Julia preview re-seeds from the point under the mouse
 *  (00405590.c:126-137); this is that point, using the same rotated
 *  screen-to-plane matrix every gesture already goes through.
 *
 *  Kept as the double-valued form for the preview shader, which works at a
 *  whole-set scale.  Anything that becomes a *coordinate of the main view*
 *  (a Julia seed, a preset, a zoom anchor) must use screenToPlaneHi. */
function screenToPlane(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = (clientX - r.left) * (canvas.width / Math.max(1, r.width));
  const sy = (clientY - r.top) * (canvas.height / Math.max(1, r.height));
  const d = planeDelta(sx - canvas.width / 2, sy - canvas.height / 2);
  const k = Math.pow(2, d.e);
  return {
    re: (Number(state.center.re) || 0) + d.u * k,
    im: (Number(state.center.im) || 0) + d.v * k
  };
}

/** Client-space point of a plane coordinate — the inverse of screenToPlaneHi.
 *
 *  The offset from the centre is computed in fixed point and scaled by 2^-e
 *  with an exact bit shift, so a 1e-17 difference survives even though both
 *  endpoints are ~0.8 doubles.  Dividing by Math.pow(2, e) here used to lose
 *  the difference before it ever reached the transform. */
function planeToScreen(re, im) {
  const r = canvas.getBoundingClientRect();
  const p = psPair();
  const th = state.rotation || 0;
  const c = Math.cos(th), s = Math.sin(th);
  const ctx = contextFor(Math.max(128, bitsNow()));
  const cr = ctx.fromString(state.center.re);
  const ci = ctx.fromString(state.center.im);
  const du = ctx.toNumber(ctx.shl(ctx.sub(ctx.fromString(String(re)), cr), -p.e));
  const dv = ctx.toNumber(ctx.shl(ctx.sub(ctx.fromString(String(im)), ci), -p.e));
  const x = du * c + dv * s;
  const y = -du * s + dv * c;
  const sx = canvas.width / 2 + x / p.m;
  const sy = canvas.height / 2 - y / p.m;
  const sc = r.width / Math.max(1, canvas.width);
  return { x: r.left + sx * sc, y: r.top + sy * sc };
}

/** Centre after panning `base` by a device-pixel offset. */
function panCenter(base, dx, dy) {
  const d = planeDelta(dx, dy);
  const bits = bitsNow() + 40;
  /* Same deal as the zoom: the shell's GMP answers first, the page's own
   * fixed point is the fallback.  A drag can be hundreds of events, so this
   * is also the path where an accumulating rounding would be visible. */
  const host = viewOp({ op: 'pan', re: base.re, im: base.im,
                        spanMant: Math.abs(state.span.m), spanExp: state.span.e,
                        w: canvas.width, h: canvas.height, a: dx, b: dy,
                        rot: state.rotation || 0, bits });
  if (host) return { re: host.re, im: host.im };
  /* The content follows the hand, so the *centre* moves the other way. */
  return {
    re: shiftCoordScaled(base.re, -d.u, d.e, bits),
    im: shiftCoordScaled(base.im, -d.v, d.e, bits)
  };
}

/**
 * Hand one pan step to the shell's own GL canvas.
 *
 * The transform is ABSOLUTE — the state of the committed frame relative to the
 * view the hand is asking for — not a delta.  The shell composes previews, so
 * feeding it the running offset on every pointer event multiplied the pan by
 * the number of events: the picture flew away from the cursor and snapped back
 * on release.  With an absolute transform a duplicated or dropped event can
 * only ever leave the picture at a slightly older position, never accumulate.
 */
function nativePan(dxPx, dyPx, W, H) {
  if (!W || !H) return false;
  nativeCanvasSetPreview({ sx: 1, ox: -dxPx / W, sy: 1, oy: -dyPx / H }, viewId);
  return true;
}

/* ---------------- Interaction ---------------- */
let drag = null;

/* Multi-pointer tracking powers two-finger pinch-zoom and pan on touch
 * devices.  A single pointer keeps the original drag-to-pan behaviour. */
const pointers = new Map();
let pinch = null;

const panelQuery = window.matchMedia('(max-width: 900px)');
function isMobileShell() { return panelQuery.matches; }

/**
 * Map client (CSS px) coordinates onto the rendered bitmap.
 * The canvas element fills the window but the bitmap is presented with
 * `object-fit: contain`, so there can be letterbox bars on either axis.
 * `k` is CSS px per bitmap px; `ox/oy` are the top-left of the displayed
 * image inside the viewport.
 */
function viewFit() {
  const r = canvas.getBoundingClientRect();
  const k = Math.min(r.width / canvas.width, r.height / canvas.height) || 1;
  return {
    rect: r,
    k,
    ox: r.left + (r.width - canvas.width * k) * 0.5,
    oy: r.top + (r.height - canvas.height * k) * 0.5
  };
}

function pointerPos(e) {
  const vf = viewFit();
  return {
    x: (e.clientX - vf.ox) / vf.k,
    y: (e.clientY - vf.oy) / vf.k
  };
}

function pinchMetrics() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return null;
  const [a, b] = pts;
  return {
    d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2
  };
}

function startPinch() {
  const m = pinchMetrics();
  if (!m) return;
  drag = null;
  canvas.classList.remove('dragging');
  /* One canvas, one owner: a CPU pass still in flight would land on top of
   * the pinch preview and snap the picture back under the fingers.  The
   * single-pointer drag path already does this on first movement. */
  cancelAll();
  takeSnapshot();
  /* Remember the view the gesture started from: every pointer event rebuilds
   * the view from these numbers instead of accumulating on the last one, so a
   * pinch that wanders out to the zoom limit and back still lands exactly
   * where the fingers are. */
  pinch = {
    d0: m.d, cx0: m.cx, cy0: m.cy,
    spanM: state.span.m, spanE: state.span.e,
    cre: state.center.re, cim: state.center.im
  };
}

/** Rebuild the view from the pinch's starting state — no accumulation. */
function applyPinch(m) {
  const p0 = pinch;
  if (!p0 || !m) return;
  state.span = { m: p0.spanM, e: p0.spanE };
  state.center = { re: p0.cre, im: p0.cim };
  const vf = viewFit();
  const s = 1 / vf.k;
  const dx = (m.cx - p0.cx0) * s;
  const dy = (m.cy - p0.cy0) * s;
  if (Math.hypot(dx, dy) > 0.5) state.center = panCenter(state.center, dx, dy);
  const factor = clamp(p0.d0 / Math.max(1, m.d), 0.2, 5);
  zoomView((m.cx - vf.ox) * s, (m.cy - vf.oy) * s, factor);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  /* The Julia seed picker owns the next click: it pins c there and must not
   * start a pan (the two would fight over the same gesture). */
  if (juliaView && juliaView.isPicking() && juliaView.pickAt(e.clientX, e.clientY)) {
    e.preventDefault();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) { startPinch(); return; }
  if (pointers.size > 2) return;

  // A tap on the fractal dismisses the mobile console sheet.
  if (isMobileShell() && document.body.classList.contains('panel-open')) {
    setPanelOpen(false);
  }

  canvas.classList.add('dragging');
  takeSnapshot();
  drag = {
    x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
    px: e.clientX, py: e.clientY, moved: false,
    // Anchor for the pan preview: the centre the drag started from.
    baseCenter: { re: state.center.re, im: state.center.im }
  };
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinch && pointers.size >= 2) {
    const m = pinchMetrics();
    if (!m) return;
    applyPinch(m);
    /* Follow the fingers.  On the shader path the view itself has just moved,
     * so redrawing it is both cheaper and sharper than transforming the old
     * bitmap — this is why the picture now tracks the gesture instead of
     * sitting still until the fingers lift. */
    if (wgpuSurface) {
      const vf = viewFit();
      const s = 1 / vf.k;
      const scale = clamp(pinch.d0 / m.d, 0.2, 5);
      const ax = (m.cx - vf.ox) * s;
      const ay = (m.cy - vf.oy) * s;
      wgpuLive((m.cx - pinch.cx0) * s, (m.cy - pinch.cy0) * s, scale, ax, ay);
      updateHud();
      return;
    }
    if (state.gpu && scene.ok) {
      sceneLive();
      updateHud();
      return;
    }
    const vf = viewFit();
    const s = 1 / vf.k;
    const scale = clamp(pinch.d0 / m.d, 0.2, 5);
    const ax = (m.cx - vf.ox) * s;
    const ay = (m.cy - vf.oy) * s;
    blitSnapshot((m.cx - pinch.cx0) * s, (m.cy - pinch.cy0) * s, scale, ax, ay);
    return;
  }

  if (!drag) return;
  const vf = viewFit();
  const dx = (e.clientX - drag.sx) / vf.k;
  const dy = (e.clientY - drag.sy) / vf.k;
  drag.px = e.clientX;
  drag.py = e.clientY;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 1) {
    /* First real movement: a pass that is already computing renders the *old*
     * centre, and if it lands mid-gesture it paints the pre-drag view over the
     * panned one — the image jumps back under the hand.  Drop it here rather
     * than on pointerdown, so a plain click does not cancel a render. */
    if (!drag.moved) cancelAll();
    drag.moved = true;
  }
  /* Rebuild the centre from the gesture's anchor on every event.  Accumulating
   * would drift with the device's event rate, and a centre that has already
   * been applied cannot be un-applied when a stale frame lands. */
  state.center = panCenter(drag.baseCenter, dx, dy);
  updateHudSoon();
  /* Whichever surface is visible gets the new view in the cheapest way it can:
   * the shell's GL canvas is a GPU transform of the committed frame, the page's
   * shader is one fragment pass, and only the CPU fallback moves a bitmap. */
  if (nativePreviewTarget()) {
    nativePan(dx, dy, canvas.width, canvas.height);
  } else if (!wgpuLive(dx, dy)) {
    if (!sceneLive()) blitSnapshot(dx, dy);
  }
});

canvas.addEventListener('pointerup', (e) => {
  const hadPinch = !!pinch;
  const mEnd = hadPinch ? pinchMetrics() : null;
  pointers.delete(e.pointerId);

  if (hadPinch) {
    if (pointers.size <= 1) {
      finishPinch(mEnd);
      if (pointers.size === 1) {
        // One finger is still down: continue as a fresh pan gesture.
        const p = [...pointers.values()][0];
        takeSnapshot();
        drag = {
          x: p.x, y: p.y, sx: p.x, sy: p.y, px: p.x, py: p.y, moved: false,
          baseCenter: { re: state.center.re, im: state.center.im }
        };
      }
    }
    return;
  }

  if (!drag) return;
  canvas.classList.remove('dragging');
  const wasDrag = drag.moved;
  drag = null;
  if (!wasDrag) return;
  /* The view already moved with the pointer events; the release only has to
   * turn that gesture view into a full-quality frame.  Re-applying the offset
   * here (the old commitPan) moved the picture a second time.  No reset is
   * sent for the native surfaces: the commit that is about to land carries the
   * transform, and clearing it here would visibly snap the picture back for
   * the duration of the render. */
  liveReset();
  renderNow();
});

canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pinch) { pinch = null; return; }
  drag = null;
  canvas.classList.remove('dragging');
});

/** Finish a pinch: the view was already following the fingers; commit it at
 * full quality instead of applying the gesture a second time. */
function finishPinch(m) {
  const p0 = pinch;
  if (!p0 || !m) { pinch = null; return; }
  applyPinch(m);
  pinch = null;
  renderNow();
  if (state.autoIter) syncIterUi();
  updateHud();
}

function commitPan(base, dx, dy) {
  state.center = panCenter(base, dx, dy);
  scheduleZoomRender();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  /* The 07f0583c web handler: one notch is one exact zoom step about the
   * pointer.  No velocity, no coasting, no per-tick re-application. */
  const { x, y } = pointerPos(e);
  const factor = Math.exp(clamp(e.deltaY, -240, 240) * 0.0035);
  zoomAt(x, y, factor, true);
}, { passive: false });

/* Regression hook driven by the shell when MB_NATIVE_SELFTEST=1: a burst of
 * real wheel events through the same path a mouse takes, so the measured
 * cadence is the product's, not a synthetic benchmark. */
window.__mbSelfTest = function () {
  const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
  let n = 0;
  nativeLog('[selftest-js] wheel burst 14 notches @20ms');
  const fire = () => {
    if (n++ >= 14) return;
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true
    }));
    setTimeout(fire, 20);
  };
  fire();
};

canvas.addEventListener('dblclick', (e) => {
  /* A click that just pinned the Julia seed is still part of that gesture. */
  if (juliaView && juliaView.pickedRecently && juliaView.pickedRecently()) return;
  const { x, y } = pointerPos(e);
  zoomAt(x, y, e.shiftKey ? 2.4 : 1 / 2.4, true);
});

/** Zoom the view about a screen point, without drawing anything.
 *
 * Split out of zoomAt so a live gesture (pinch) can rebuild the view from its
 * starting state on every pointer event and then let the shader redraw — the
 * old code only transformed a snapshot, which is why the picture did not
 * follow the fingers on the GPU path. */
/** Zoom about a screen point with the recovered viewport rule.
 *
 * C:/Users/harve/Desktop/mande/out/src/app/app_state.cpp
 * AppState::zoom_at_pixel(x, y, factor):
 *      before = vp.point_at(x, y);
 *      vp.zoom_by(factor);
 *      after  = vp.point_at(x, y);
 *      vp.centre += before - after;
 *
 * Two evaluations of the SAME pixel instead of a `(1-factor)` closed form:
 * the centre is never re-parsed at a different precision, and rotation is
 * handled by the very same plane map the renderer uses.  `planeDelta`
 * returns (double mantissa, binary exponent); the exponents are aligned
 * before subtracting because normalizeSpan may move one by a power of two. */
function applyZoomAt(px, py, factor) {
  const W = canvas.width, H = canvas.height;
  const log2New = psLog2Now() + Math.log2(factor);
  if (log2New < MIN_LOG2PS) return false;
  if (spanNum() * factor > MAX_SPAN) return false;
  const bits = requiredBitsFromLog2(log2New, effectiveIterTotal());
  const cx = px - W / 2, cy = py - H / 2;
  const before = planeDelta(cx, cy);
  /* The scale the correction is measured against: the one on screen now.  The
   * request below gets these, not the updated span, or the shell would apply
   * the factor a second time. */
  const spanMant0 = state.span.m, spanExp0 = state.span.e;
  state.span = { m: spanMant0 * factor, e: spanExp0 };
  normalizeSpan();
  /* centre += before - after, evaluated as ONE product.
   *
   * The recovered program does two point_at() calls and subtracts them in
   * its own arbitrary-precision type.  Both forms were measured to be exact
   * in the page's fixed point (200 steps ×0.98 at 2^-3000 drift 0.0 px), so
   * this is not where a deck drifts; the single product is simply fewer
   * operations and one fewer evaluation to keep in sync with the renderer.
   *     before - after = d*s_old - d*s_new = d*s_old*(1 - factor).
   */
  const k = 1 - factor;
  if (k !== 0) {
    /* The shell answers with the same GMP the reference orbit is built from,
     * at the width the frame actually needs.  When it is absent (a browser, or
     * a shell without the DLL) the arithmetic below is the fallback — it is
     * exact too, but it is a second implementation and its width is chosen
     * here instead of by the renderer. */
    const host = viewOp({ op: 'zoom', re: state.center.re, im: state.center.im,
                          spanMant: spanMant0, spanExp: spanExp0,
                          w: W, h: H, a: px, b: py, factor,
                          rot: state.rotation || 0, bits });
    if (host) {
      state.center = { re: host.re, im: host.im };
      state.span = { m: host.spanMant, e: host.spanExp };
      return true;
    }
    state.center = {
      re: shiftCoordScaled(state.center.re, before.u * k, before.e, bits),
      im: shiftCoordScaled(state.center.im, before.v * k, before.e, bits)
    };
  }
  return true;
}

function zoomView(px, py, factor) { return applyZoomAt(px, py, factor); }

function zoomAt(px, py, factor, instant) {
  if (!zoomView(px, py, factor)) return;

  if (instant) {
    /* Transform the committed frame about the cursor.  The native surface
     * composes this step on its own side (so it wants 1/factor); a 2D canvas
     * redraws the same snapshot on every event (so it wants the accumulated
     * scale).  Mixing the two squared the zoom on every notch. */
    if (!snap.width) takeSnapshot();
    previewScale = clamp(previewScale / factor, 0.02, 50);
    blitSnapshot(0, 0, nativeCanvasMode() ? 1 / factor : previewScale, px, py);
    scheduleZoomRender();
  } else {
    renderNow();
  }
  if (state.autoIter) syncIterUi();
  updateHud();
}

function normalizeSpan() {
  let { m, e } = state.span;
  while (Math.abs(m) >= 2) { m /= 2; e++; }
  while (Math.abs(m) < 1) { m *= 2; e--; }
  state.span = { m, e };
}

/* ---------------- Wheel navigation ----------------
 * 07f0583c's model, and nothing else: a notch is one exact zoom step about the
 * pointer (applyZoomAt), the committed frame is transformed for feedback, and
 * the real pass is debounced by 360 ms.  The recovered nav_timer velocity
 * integrator that used to live here re-applied the step on every display
 * frame; each re-application measured its anchor against the previous scale,
 * so a burst accumulated a drift (measured: 0.78 px per notch, 52 px over
 * eight) and the picture slid away from the pointer.
 */

/* ---------------- HUD ---------------- */
let hudPending = false;
/* A pass that has just finished must not be repainted as "rendering 0%" by an
 * updateHudSoon() scheduled a frame earlier.  That ordering is the normal one:
 * the last tile calls updateHudSoon() on its way past the `got === total`
 * check, the synchronous updateHud(true) writes "done", and the rAF callback
 * then runs afterwards and overwrites it with the live state.  The HUD sat at
 * "rendering 0%" forever even though the frame had landed. */
let hudDoneStamp = 0;
function updateHudSoon() {
  if (hudPending) return;
  hudPending = true;
  requestAnimationFrame(() => {
    hudPending = false;
    /* Only repaint the live state if a *newer* pass has started since. */
    if (performance.now() - hudDoneStamp < 120) return;
    updateHud();
  });
}

/* Significant decimals actually present in a coordinate string.  Trailing
 * zeros carry no information, so "-0.745428000332250000000..." counts as 14. */
function centerDecimals() {
  const count = (v) => {
    const s = String(v);
    const dot = s.indexOf('.');
    if (dot < 0) return 0;
    const frac = s.slice(dot + 1).replace(/[eE].*$/, '');
    let n = frac.length;
    while (n > 0 && frac[n - 1] === '0') --n;
    return n;
  };
  return Math.max(count(state.center.re), count(state.center.im));
}

/* Window width as a power of ten, from the mantissa/exponent pair.  The plain
 * number is already zero at the depths this is interesting for. */
function spanDecades() {
  const m = Math.abs(state.span.m) || 1;
  const lg2 = Math.log2(m) + state.span.e;
  return -lg2 * Math.log10(2);
}

/* The two regions whose interior is known in closed form.  A centre inside
 * them is genuinely interior at every depth, so the flat frame needs no
 * apology; everything else that goes flat has a different story. */
function inCardioidOrBulb(re, im) {
  const x = Number(re), y = Number(im);
  if (!isFinite(x) || !isFinite(y)) return false;
  const xm = x - 0.25;
  const q = xm * xm + y * y;
  if (q * (q + xm) <= 0.25 * y * y) return true;          // main cardioid
  return (x + 1) * (x + 1) + y * y <= 0.0625;             // period-2 bulb
}

function updateHud(done = false) {
  /* Every "this pass is finished" call stamps the clock, so a queued live
   * repaint cannot overwrite it (see updateHudSoon). */
  if (done) hudDoneStamp = performance.now();
  const d = depthNow();
  const ps = psNow();
  /* The width on screen is the width the renderer actually used.  Before this
   * it was the page's own guess, which stayed at 64 for every zoom shallower
   * than 2^-45 — the "auto precision" menu looked like it did nothing. */
  const bits = (lastMeta && lastMeta.bits > 0) ? lastMeta.bits : bitsNow();
  const zd = zoomDepthNow(done);
  $('hud-depth').textContent = `${t('zoom')} ${fmtZoomFactor(zd)}`;
  /* A phone HUD is ~46 characters wide in total, so the coordinate line has to
   * give up digits rather than overflow: 16 sig-figs on a desktop, 10 here.
   * The value itself is untouched — this is display only. */
  const coordDigits = isMobileShell() ? 10 : 16;
  const cre = trimNum(state.center.re, coordDigits);
  const cim = state.center.im;
  $('hud-center').textContent = `${cre} ${cim.startsWith('-') ? '−' : '+'} ${trimNum(cim.replace('-', ''), coordDigits)} i`;
  $('chip-precision').textContent = `${bits} bit`;

  const engineName = (e) => e === 'remote' ? 'CORE' : e === 'wasm' ? 'WASM'
    : e === 'hp' ? 'HP' : e === 'core' ? 'CORE' : e === 'NATIVE' ? 'NATIVE'
    : e === 'gpu' ? 'GPU' : e === 'webgpu' ? 'WebGPU' : 'JS';
  const modeLabel = lastMeta
    ? engineName(lastMeta.engine) + ' · ' + lastMeta.mode
    : (remoteEnabled() ? 'CORE' : NATIVE ? 'NATIVE' : (wasmEnabled === null ? '…' : wasmEnabled ? 'WASM' : 'JS'));
  const pct = tileTotal ? Math.round((tileDone / tileTotal) * 100) : 0;
  const liveMs = !done && passStartAt ? performance.now() - passStartAt : 0;
  const ms = done && frameMs > 0 ? frameMs.toFixed(0) + ' ms'
    : (liveMs > 0 ? liveMs.toFixed(0) + ' ms'
      : (lastMeta ? lastMeta.ms.toFixed(0) + ' ms' : ''));
  let limitHint = '';
  if (state.spec.mode === 'x' && d > 13) {
    limitHint = lastMeta && lastMeta.exact === false ? ` · ${t('approxHint')}` : '';
  }
  /* What the frame actually contained.  A deep view whose whole area escapes
   * in the same iteration has nothing to draw, and saying so is the difference
   * between "the renderer is broken" and "there is no detail here". */
  let colourHint = '';
  /* The status row is one line and clips this on a narrow window, so the same
   * fact is also stated in the middle of the picture. */
  let noDetail = false;
  let interiorOnly = false;
  let precisionOnly = false;
  /* Only a *finished, final* pass may say anything about the frame's content.
   * A skeleton pass runs on a deliberately small iteration budget, so every
   * pixel "escapes" at the cap and the union looks like a flat frame — that is
   * where the "no structure" banner came from, flickering in and out during
   * every zoom and every drag. */
  if (lastMeta && lastMeta.done && lastMeta.final !== false) {
    /* Union over the pass, not the last tile: a single uniform tile must not
     * label a frame full of filaments as "no structure". */
    const stats = passStats;
    const lo = stats && isFinite(stats.escMin) ? stats.escMin : lastMeta.escMin;
    /* Union, not "stats overrides meta": a final tile may report an empty
     * union (0 escapes, 0 interior) while the frame's metadata carries the
     * real interior count.  Letting 0 win put the "no structure" banner on a
     * frame that had simply not been shaded yet. */
    const hi = Math.max(stats && isFinite(stats.escMax) ? stats.escMax : 0,
                        lastMeta.escMax | 0);
    const bounded = Math.max(stats ? (stats.bounded | 0) : 0,
                             lastMeta.bounded | 0);
    /* "Known" means the pass actually reported an escape distribution.  A
     * bridge that does not fill escMin/escMax leaves 0/0 there, which used to
     * satisfy this test and made every native frame claim "no structure"
     * (`hi - lo <= 1`, `bounded == 0`).  Zero escapes and zero interior is
     * missing data, not a flat picture. */
    const known = Number.isFinite(lo) && Number.isFinite(hi) && (hi > 0 || bounded > 0);
    /* A pixel that reached the cap did not prove there is nothing to draw —
     * it proved the budget was too small.  That is a different message, and
     * not one this banner is allowed to make. */
    /* lastMeta.cap was never written by any backend.  Fall back to the cap
     * captured when the pass started, otherwise atLimit is always false and
     * the observed-iteration mechanism can never fire. */
    const cap = (lastMeta.cap | 0) || frameIterCap;
    const atLimit = cap > 0 && hi >= cap - 1;
    noteFrameObservation(cap, hi, bounded, lastMeta && lastMeta.refLen);
    if (known && hi > lo) colourHint = ` · ${t('escRange')} ${lo | 0}–${hi | 0}`;
    if (!atLimit && known && hi - lo <= 1 && !(bounded > 0)) {
      colourHint += ` · ${t('noDetail')}`;
      noDetail = true;
    }
    /* A frame with no escaping pixel at all is *inside* the set: it has one
     * colour by definition, and without saying so a full-frame black reads as
     * a broken renderer rather than as the maths it is. */
    if (!atLimit && known && hi === 0 && lo === 0 && bounded > 0) {
      colourHint += ` · ${t('allInterior')}`;
      noDetail = true;
      interiorOnly = true;   // different banner: black is the correct answer
      /* "All interior" has two causes and they need different advice.  If the
       * centre string carries fewer decimals than the window is narrow, the
       * frame ran out of *coordinate*, not into the set: every preset that
       * ships with the app holds 12-14 decimals, so pushing one past 1e-14 of
       * pixel scale lands on a point whose remaining digits are all zero and
       * the picture is flat by construction.  Telling that reader "this is the
       * maths" sends them hunting a renderer bug that does not exist. */
      if (centerDecimals() > 0 && spanDecades() > centerDecimals() + 0.5 &&
          !inCardioidOrBulb(state.center.re, state.center.im))
        precisionOnly = true;
    }
    if (lastMeta.cyc > 0 && lastMeta.cyc < 1000) {
      colourHint += ` · ${t('cycShort')} ${lastMeta.cyc < 1 ? lastMeta.cyc.toFixed(2) : Math.round(lastMeta.cyc)}`;
    }
  }
  $('hud-engine').textContent = `${modeLabel} · ${bits} bit` + (lastMeta ? ` · ${t('refLen')} ${lastMeta.refLen}` : '') + colourHint + limitHint;
  /* "rendering N%" only makes sense while a CPU pass actually exists.  A
   * shader frame never builds one, so tileTotal stays 0 and the HUD used to
   * read "rendering 0%" for every GPU frame — including the one it had just
   * finished.  The 500 ms pass clock repainting the same stale text is why it
   * never settled. */
  $('hud-progress').textContent = (done || pct >= 100 || !tileTotal)
    ? `${t('statusDone')} · ${ms}`
    : `${t('statusRendering')} ${pct}%` + (ms ? ` · ${ms}` : '')
      + (liveMs > 15000 ? ` · ${t('slowDeep')}` : '');

  $('kv-center').textContent = `${trimNum(state.center.re, 22)} , ${trimNum(state.center.im, 22)}`;
  $('kv-zoom').textContent = fmtZoomFactor(zd);

  const nd = $('nodetail');
  if (nd) {
    nd.hidden = !noDetail;
    if (noDetail) {
      const title = nd.querySelector('b'), hint = nd.querySelector('span');
      const tk = precisionOnly ? 'precisionTitle'
               : interiorOnly ? 'allInteriorTitle' : 'noDetailTitle';
      const hk = precisionOnly ? 'precisionHint'
               : interiorOnly ? 'allInteriorHint' : 'noDetailHint';
      if (title) { title.dataset.i18n = tk; title.textContent = t(tk); }
      if (hint) {
        hint.dataset.i18n = hk;
        hint.textContent = precisionOnly
          ? t(hk).replace('{N}', String(centerDecimals()))
                  .replace('{D}', spanDecades().toFixed(0))
          : t(hk);
      }
    }
  }
}

function updateEngineLabel() {
  updateHud();
}

/* ---------------- Controls ---------------- */
function syncIterUi() {
  const it = effectiveIterTotal();
  $('rng-iter').value = clamp(it, 100, 200000);
  $('in-iter').value = it;
}

/* Rotation travels in radians (the reference program's unit, and what the
 * kernel's screenDelta() consumes); the console speaks degrees.  One place
 * owns the conversion so a preset, an animation keyframe and the slider all
 * leave the two controls showing the same number as the picture. */
function syncRotationUi() {
  const deg = clamp(Math.round((state.rotation || 0) * 180 / Math.PI), -180, 180);
  const r = $('rng-rot'), n = $('in-rot');
  if (r) r.value = String(deg);
  if (n && document.activeElement !== n) n.value = String(deg);
}

function setRotationDeg(deg, render) {
  const d = clamp(Math.round(Number.isFinite(+deg) ? +deg : 0), -180, 180);
  state.rotation = d * Math.PI / 180;
  syncRotationUi();
  if (render) renderNow();
}

function fillSelects() {
  const user = loadUserPalettes();
  /* Two genuinely different drawing logics, so keep them apart in the list:
   * a cyclic ramp changes colour at one fixed rate everywhere, while an
   * additive scheme sums several frequencies — a slow one lays down the large
   * soft fields, fast ones resolve the filigree.  The reference program's
   * memorable deep views all come from the second family. */
  const opt = p => `<option value="${p.id}">${getLang() === 'en' ? p.en : p.zh}</option>`;
  const ramp = PALETTE_LIST.filter(p => !paletteColors(p.id));
  const art = PALETTE_LIST.filter(p => !!paletteColors(p.id));
  const refGlsl = refSchemeRecords
    .map(s => `<option value="${s.id}">${getLang() === 'en' ? s.name : s.nameZh}</option>`)
    .join('');
  const glsl = SCHEME_LIB_ALL
    .map(s => `<option value="${s.id}">${getLang() === 'en' ? s.name : s.nameZh}</option>`)
    .join('');
  const builtin =
    `<optgroup label="${t('paletteGroupRamp')}">` + ramp.map(opt).join('') + '</optgroup>' +
    `<optgroup label="${t('paletteGroupArt')}">` + art.map(opt).join('') + '</optgroup>' +
    `<optgroup label="${getLang() === 'en' ? 'Reference built-ins' : '原版内置'}">` + refGlsl + '</optgroup>' +
    `<optgroup label="${t('paletteGroupGlsl')}">` + glsl + '</optgroup>';
  const custom = user.length
    ? `<optgroup label="${t('customPalettes')}">` +
      user.map(p => `<option value="${p.id}">${p.name}</option>`).join('') + '</optgroup>'
    : '';
  $('sel-palette').innerHTML = builtin + custom;
  // Rebuilds happen on theme / language switches — keep the selection.
  $('sel-palette').value = state.schemeId || state.palette;
}

/* ---------------- Gradient editor ----------------
 * A ramp widget, Photoshop's colour-stop bar reduced to what a palette needs:
 * click the bar to add a handle, drag a handle to move it, double-click to
 * remove it, and the selected handle's colour and position stay editable in the
 * row below.  Every edit rewrites `state.stops`, which is what the renderer
 * receives — there is no separate "apply" step to forget, and no palette
 * registry to keep in sync.
 * -------------------------------------------------*/
let gradSel = 0;
/* The ramp is three stacked bars, each one third of the palette drawn at full
 * width.  Zone 1 = [0,1/3), zone 2 = [1/3,2/3), zone 3 = [2/3,1]. */
const ZONE_SPAN = 1 / 3;
function laneRange(z) {
  const a = (z - 1) * ZONE_SPAN;
  return [a, a + ZONE_SPAN];
}
function laneBars() {
  /* Both the console's gradient editor and the presets panel draw the same
   * ramp, so this deliberately matches every bar in the document: whichever
   * surface is open repaints, and so does the other one when it comes back. */
  return Array.from(document.querySelectorAll('.grad-bar'));
}
/* Pointer x -> ramp position.  `free` lets a drag continue past the lane's
 * edges into a neighbouring third; a click always stays inside its own lane. */
function barToT(clientX, rect, zone, free = false) {
  let f = (clientX - rect.left) / Math.max(1, rect.width);
  if (!free) f = clamp(f, 0, 1);
  const [a, b] = laneRange(zone);
  return clamp(a + f * (b - a), 0, 1);
}
/* Ramp position -> offset within one lane, in percent. */
function tToPct(t, zone) {
  const [a, b] = laneRange(zone);
  return clamp((t - a) / Math.max(1e-9, b - a), 0, 1) * 100;
}

function editorStops() {
  return effectiveStops().map(s => ({ ...s }));
}

/* `sort` is off while dragging: re-sorting mid-drag would swap indices under
 * the pointer.  The drag handler clamps the handle between its neighbours
 * instead, so the list stays ordered anyway. */
function commitStops(list, sort = true) {
  const s = list.map(c => ({
    pos: Math.round(clamp(c.pos, 0, 1) * 1000) / 1000,
    r: c.r, g: c.g, b: c.b
  }));
  if (sort) s.sort((a, b) => a.pos - b.pos);
  state.stops = s;
  syncPaletteStrip();
  recolourOnly();
}

function syncPaletteStrip() {
  const list = effectiveStops();
  if (gradSel > list.length - 1) gradSel = list.length - 1;
  const css = stopListGradientCSS(list);
  for (const bar of laneBars()) {
    const zone = +bar.dataset.zone;
    const [a, b] = laneRange(zone);
    const fill = bar.querySelector('.grad-fill');
    /* Only the image changes; background-size (300%) and the pan position are
     * fixed in CSS, so each lane automatically shows its own third. */
    if (fill) fill.style.backgroundImage = css;
    const box = bar.querySelector('.grad-handles');
    if (!box) continue;
    box.innerHTML = '';
    list.forEach((s, i) => {
      /* Half-open thirds: a stop on a boundary belongs to the lane on its
       * right, so no handle is drawn twice.  The last lane owns t = 1. */
      const inside = s.pos >= a - 1e-9 &&
                     (s.pos < b - 1e-9 || (zone === 3 && s.pos <= 1 + 1e-9));
      if (!inside) return;
      const h = document.createElement('div');
      h.className = 'grad-handle' + (i === gradSel ? ' sel' : '');
      h.style.left = tToPct(s.pos, zone) + '%';
      h.style.background = `rgb(${Math.round(s.r * 255)},${Math.round(s.g * 255)},${Math.round(s.b * 255)})`;
      h.dataset.i = String(i);
      box.appendChild(h);
    });
  }
  const sel = list[clamp(gradSel, 0, list.length - 1)];
  if (sel) {
    const col = $('grad-color');
    if (col) col.value = rgb01ToHex([sel.r, sel.g, sel.b]);
    const pos = $('grad-pos');
    if (pos && document.activeElement !== pos) pos.value = sel.pos.toFixed(3);
  }
  syncRgbSliders();
}

function bindGradientEditor() {
  /* Delegated from the document, not from the console's own stack: the presets
   * panel carries a second set of the same lanes, and one handler for every
   * `.grad-bar` is what makes the two surfaces behave identically. */
  const stack = document;

  stack.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const bar = e.target.closest('.grad-bar');
    if (!bar) return;
    const zone = +bar.dataset.zone;
    const rect = bar.getBoundingClientRect();
    const t = barToT(e.clientX, rect, zone);
    const handle = e.target.closest('.grad-handle');

    if (!handle) {                       // empty stretch of bar: insert there
      const list = editorStops();
      const c = sampleStopList(list, t);
      list.push({ pos: t, r: c[0], g: c[1], b: c[2] });
      list.sort((a, b) => a.pos - b.pos);
      gradSel = list.findIndex(s => Math.abs(s.pos - t) < 1e-6);
      commitStops(list, false);
      return;
    }

    const idx = +handle.dataset.i;
    gradSel = idx;
    syncPaletteStrip();
    /* Capture on the bar, not the handle: syncPaletteStrip() has just replaced
     * the handle DOM, so the pointer must belong to something that survives. */
    bar.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const list = editorStops();
      const lo = idx > 0 ? list[idx - 1].pos + 0.002 : 0;
      const hi = idx < list.length - 1 ? list[idx + 1].pos - 0.002 : 1;
      const tt = clamp(barToT(ev.clientX, rect, zone, true), lo, hi);
      list[idx].pos = tt;
      commitStops(list, false);
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });

  stack.addEventListener('dblclick', (e) => {
    const handle = e.target.closest('.grad-handle');
    if (!handle) return;
    const list = editorStops();
    if (list.length <= 2) return;
    list.splice(+handle.dataset.i, 1);
    gradSel = Math.max(0, Math.min(gradSel, list.length - 1));
    commitStops(list, false);
  });

  $('grad-color').oninput = (e) => {
    const list = editorStops();
    if (!list[gradSel]) return;
    const [r, g, b] = hexToRgb01(e.target.value);
    list[gradSel].r = r; list[gradSel].g = g; list[gradSel].b = b;
    commitStops(list, false);
  };

  $('grad-pos').onchange = (e) => {
    const list = editorStops();
    if (!list[gradSel]) return;
    list[gradSel].pos = clamp(+e.target.value || 0, 0, 1);
    commitStops(list, true);
  };

  $('grad-add').onclick = () => {
    const list = editorStops();
    const sel = list[gradSel] || list[0];
    const pos = sel ? Math.min(1, sel.pos + 0.1) : 0.5;
    const c = sampleStopList(list, pos);
    list.push({ pos, r: c[0], g: c[1], b: c[2] });
    list.sort((a, b) => a.pos - b.pos);
    gradSel = list.findIndex(s => Math.abs(s.pos - pos) < 1e-6);
    commitStops(list, false);
  };

  $('grad-del').onclick = () => {
    const list = editorStops();
    if (list.length <= 2) return;
    list.splice(gradSel, 1);
    gradSel = Math.max(0, Math.min(gradSel, list.length - 1));
    commitStops(list, false);
  };

  $('grad-reset').onclick = () => {
    state.stops = null;                   // back to the selected palette's ramp
    gradSel = 0;
    syncPaletteStrip();
    recolourOnly();
  };
}

/* ---------------- User palettes ----------------
 * Stored apart from the theme so switching light/dark or zh/en never wipes
 * them.  Registered into palettes.js at boot, which makes them first-class
 * ids for every render path (worker WASM and the native kernel alike).
 * -------------------------------------------------*/
function loadUserPalettes() {
  try {
    const l = JSON.parse(localStorage.getItem('mb.palettes') || '[]');
    return Array.isArray(l) ? l : [];
  } catch { return []; }
}

function saveUserPalettes(list) {
  try { localStorage.setItem('mb.palettes', JSON.stringify(list)); } catch { /* quota */ }
}

function hydrateUserPalettes() {
  for (const p of loadUserPalettes()) {
    if (p && p.id && Array.isArray(p.stops)) registerCustomPalette(p.id, p.stops);
  }
}

function hexToRgb01(h) {
  const s = String(h).replace('#', '');
  const v = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  const n = parseInt(v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgb01ToHex(c) {
  const f = (x) => clamp(Math.round(x * 255), 0, 255).toString(16).padStart(2, '0');
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}

/** Colour-set editor: even-spaced stops, closed loop, live gradient preview. */
function openPaletteEditor() {
  const curId = state.palette;
  const editing = isCustomPalette(curId);
  const base = paletteStops(curId) || paletteStops('ice');
  const stored = loadUserPalettes().find(p => p.id === curId);
  const draft = {
    id: curId,
    editing,
    name: stored ? stored.name : t('myPalette'),
    stops: base.map(c => rgb01ToHex(c)),
    /* Where each stop sits on the ramp.  The flat stop list the registry keeps
     * is evenly spaced, so an edited ramp is resampled on apply; the handles
     * only have to keep these numbers ordered. */
    pos: base.map((c, i) => (base.length > 1 ? i / (base.length - 1) : 0))
  };

  const body = `
    <div class="pal-edit">
      <div class="pal-preview" id="pal-preview">
        <div class="grad-handles" id="pal-handles"></div>
      </div>
      <div class="row"><label>${t('paletteName')}</label><input class="ctl" id="pal-name"/></div>
      <div class="pal-stops" id="pal-stops"></div>
      <div class="btnrow">
        <button class="btn" id="pal-add">${t('addStop')}</button>
        <button class="btn" id="pal-base">${t('fromBuiltin')}</button>
        ${editing ? `<button class="btn danger" id="pal-del">${t('delete')}</button>` : ''}
      </div>
      <div class="fx-hint">${t('paletteHint')}</div>
    </div>`;
  const foot = `
    <button class="btn ghost" data-close>${t('close')}</button>
    <button class="btn primary" id="pal-apply">${t('apply')}</button>`;
  openModal('palette', t('paletteTitle'), t('paletteSub'), body, foot, 'mid');
  $('pal-name').value = draft.name;

  function gradientOf(stops, pos) {
    return 'linear-gradient(90deg,' +
      stops.map((h, i) => `${h} ${((pos ? pos[i] : i / (stops.length - 1)) * 100).toFixed(2)}%`)
        .join(',') + ')';
  }

  /* Ramp value at t, reading the draft's own positions. */
  function sampleDraft(t) {
    const hs = draft.stops.map(hexToRgb01);
    const ps = draft.pos;
    let i = 0;
    while (i < ps.length - 1 && ps[i + 1] < t) ++i;
    const j = Math.min(i + 1, ps.length - 1);
    const span = Math.max(1e-9, ps[j] - ps[i]);
    const f = clamp((t - ps[i]) / span, 0, 1);
    return [0, 1, 2].map(c => hs[i][c] + (hs[j][c] - hs[i][c]) * f);
  }

  function paintHandles() {
    const box = $('pal-handles');
    if (!box) return;
    box.innerHTML = draft.stops.map((h, i) =>
      `<div class="grad-handle" data-i="${i}" style="left:${(draft.pos[i] * 100).toFixed(2)}%;background:${h}"></div>`)
      .join('');
    for (const el of box.querySelectorAll('.grad-handle')) {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const bar = $('pal-preview');
        const rect = bar.getBoundingClientRect();
        const idx = +el.dataset.i;
        el.setPointerCapture(e.pointerId);
        el.classList.add('sel');
        const move = (ev) => {
          const lo = idx > 0 ? draft.pos[idx - 1] + 0.005 : 0;
          const hi = idx < draft.pos.length - 1 ? draft.pos[idx + 1] - 0.005 : 1;
          const t = clamp((ev.clientX - rect.left) / Math.max(1, rect.width), lo, hi);
          draft.pos[idx] = t;
          el.style.left = (t * 100).toFixed(2) + '%';
          $('pal-preview').style.background = gradientOf(draft.stops, draft.pos);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.classList.remove('sel');
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }
  }

  function repaint() {
    $('pal-preview').style.background = gradientOf(draft.stops, draft.pos);
    paintHandles();
  }

  function renderStops() {
    const box = $('pal-stops');
    box.innerHTML = draft.stops.map((h, i) => `
      <div class="pal-stop">
        <span class="pal-idx mono">${i + 1}</span>
        <input type="color" value="${h}" data-i="${i}"/>
        <span class="pal-hex mono">${h.toUpperCase()}</span>
        <button class="iconbtn tiny" data-del="${i}" title="${t('delete')}" ${draft.stops.length <= 2 ? 'hidden' : ''}>
          <svg viewBox="0 0 14 14" width="11" height="11"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>`).join('');
    box.querySelectorAll('input[type="color"]').forEach(inp => {
      inp.addEventListener('input', () => {
        draft.stops[+inp.dataset.i] = inp.value;
        inp.closest('.pal-stop').querySelector('.pal-hex').textContent = inp.value.toUpperCase();
        repaint();
      });
    });
    box.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => {
        if (draft.stops.length <= 2) return;
        draft.stops.splice(+btn.dataset.del, 1);
        draft.pos.splice(+btn.dataset.del, 1);
        renderStops();
        repaint();
      };
    });
    repaint();
  }

  $('pal-add').onclick = () => {
    /* Insert in the middle of the widest gap: adding a stop where there is
     * already a dense run of them changes nothing visible. */
    let best = 1, gap = -1;
    for (let i = 1; i < draft.pos.length; ++i) {
      const d = draft.pos[i] - draft.pos[i - 1];
      if (d > gap) { gap = d; best = i; }
    }
    const at = draft.pos[best - 1] + gap / 2;
    draft.stops.splice(best, 0, draft.stops[best - 1] || '#ffffff');
    draft.pos.splice(best, 0, at);
    renderStops();
  };
  $('pal-base').onclick = () => {
    const base2 = paletteStops('ice') || [];
    draft.stops = base2.map(c => rgb01ToHex(c));
    draft.pos = base2.map((c, i) => (base2.length > 1 ? i / (base2.length - 1) : 0));
    renderStops();
  };
  const delBtn = $('pal-del');
  if (delBtn) {
    delBtn.onclick = () => {
      const list = loadUserPalettes().filter(p => p.id !== draft.id);
      saveUserPalettes(list);
      state.palette = 'ice';
      fillSelects(); syncPaletteStrip(); renderNow();
      closeModal();
      toast(t('delete') + ' ✓');
    };
  }

  $('pal-apply').onclick = () => {
    draft.name = ($('pal-name').value || '').trim().slice(0, 24) || t('myPalette');
    /* The registry stores evenly spaced stops, so an edited ramp is resampled
     * from its own handle positions.  32 samples is well below what the eye can
     * tell apart in a 256-entry LUT. */
    const N = 32;
    const stops = [];
    for (let i = 0; i < N; ++i) stops.push(sampleDraft(i / (N - 1)));
    let id = draft.id;
    if (!draft.editing) {
      id = 'u' + Date.now().toString(36);
      draft.editing = true;
      draft.id = id;
    }
    const list = loadUserPalettes();
    const rec = { id, name: draft.name, stops };
    const i = list.findIndex(p => p.id === id);
    if (i >= 0) list[i] = rec; else list.push(rec);
    saveUserPalettes(list);
    registerCustomPalette(id, stops);
    state.palette = id;
    fillSelects();
    $('sel-palette').value = id;
    syncPaletteStrip();
    renderNow();
    closeModal();
  };

  renderStops();
}

/** Set the supersampling factor used by the final pass (1 = off) and re-render. */
function setAA(n) {
  state.aa = clamp(n | 0, 1, 3);
  const sel = $('sel-aa');
  if (sel) sel.value = String(state.aa);
  renderNow();
}

function syncModeUi() {
  const m = state.spec.mode;
  document.querySelectorAll('#seg-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('grp-julia').hidden = m !== 'j';
  syncFormulaUi();
}

/* Family of the iteration.  Kept as (kind, power) because the number of
 * branches is what the set is named after: z^2 for the classic Mandelbrot,
 * z^p for a multibrot, and the four signed-absolute folds that only exist at
 * power 2.  Both reach the native core unchanged through spec.kind/power. */
function syncFamilyUi() {
  const sel = $('sel-family'), num = $('num-power'), row = $('row-power');
  if (sel) sel.value = state.spec.mode === 'x' ? 'custom' : state.spec.kind;
  if (num) num.value = String(state.spec.power);
  if (row) row.hidden = state.spec.kind !== 'multibrot' || state.spec.mode === 'x';
  syncFormulaUi();
}

/* The panel always shows which iteration it is actually running.  A custom
 * formula lives in `spec.customExpr` and is only active in mode 'x'; showing
 * it next to the entry button is what keeps "which formula is on screen"
 * answerable without opening the editor. */
function syncFormulaUi() {
  const code = $('formula-current');
  if (!code) return;
  const custom = state.spec.mode === 'x';
  const src = (state.spec.customExpr || 'z^2 + c').trim().split('\n')
    .filter(s => s.trim()).pop() || '';
  code.textContent = custom
    ? (src.length > 30 ? src.slice(0, 30) + '…' : src)
    : 'z² + c';
  code.title = custom ? state.spec.customExpr : 'z² + c';
}

function setFamily(kind, power) {
  /* Choosing a built-in family leaves custom mode; the formula stays stored so
   * picking the custom-formula entry again brings it back. */
  if (kind === 'custom') { openFormula(); return; }
  state.spec.mode = 'm';
  state.spec.kind = kind || 'mandelbrot';
  state.spec.power = state.spec.kind === 'multibrot'
    ? clamp(Math.round(+power || 2), 2, 8) : 2;
  syncModeUi();
  syncFamilyUi();
  renderNow();
}

/* ---------------- Parameter sliders (Desmos style) ----------------
 * Every free single letter in the custom expression becomes a live slider.
 * The range (min/max/step) is remembered per parameter while the app is open
 * and is user-editable, like a Desmos slider's min/max/step fields.
 * ------------------------------------------------------------------ */
const PARAM_RANGE = {};

function defaultRange(v) {
  const a = Math.abs(v);
  if (a <= 1) return { min: -3, max: 3, step: 0.01 };
  return { min: v - 3 * a, max: v + 3 * a, step: +((a / 100).toPrecision(2)) };
}

/* Compile the expression once per edit to find its parameters. */
let _pnKey = null, _pnVal = [];
function paramNames(spec) {
  if (!spec || spec.mode !== 'x' || !spec.customExpr) return [];
  if (_pnKey === spec.customExpr) return _pnVal;
  let names = [];
  try { names = compileMath(spec.customExpr).params || []; } catch { names = []; }
  _pnKey = spec.customExpr; _pnVal = names;
  return names;
}

let paramTimer = 0;
function scheduleParamRender() {
  clearTimeout(paramTimer);
  paramTimer = setTimeout(() => renderNow(), 120);
}

function syncParamPanel() {
  const box = $('grp-params'), list = $('param-list');
  if (!box || !list) return;
  const names = paramNames(state.spec);
  box.hidden = names.length === 0;
  if (!names.length) { list.innerHTML = ''; return; }
  const tag = $('param-tag');
  if (tag) tag.textContent = names.length + ' · ' + t('live');

  state.spec.customParams = state.spec.customParams || {};
  const cp = state.spec.customParams;
  names.forEach(n => { if (!Number.isFinite(+cp[n])) cp[n] = 0; });

  list.innerHTML = names.map(n => {
    const v = +cp[n];
    const rg = PARAM_RANGE[n] || (PARAM_RANGE[n] = defaultRange(v));
    return `<div class="prm" data-p="${n}">
      <div class="prm-top">
        <span class="prm-name"><i>${n}</i></span>
        <input class="ctl prm-val mono" type="number" step="any" value="${v}"/>
        <button class="iconbtn prm-gear" title="min / max / step" aria-label="range">⋯</button>
      </div>
      <input class="prm-slider" type="range" min="${rg.min}" max="${rg.max}" step="${rg.step}" value="${v}"/>
      <div class="prm-range" hidden>
        <label>min<input class="ctl" type="number" step="any" data-k="min" value="${rg.min}"/></label>
        <label>max<input class="ctl" type="number" step="any" data-k="max" value="${rg.max}"/></label>
        <label>step<input class="ctl" type="number" step="any" min="1e-12" data-k="step" value="${rg.step}"/></label>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.prm').forEach(row => {
    const name = row.dataset.p;
    const sl = row.querySelector('.prm-slider');
    const num = row.querySelector('.prm-val');
    const rgRow = row.querySelector('.prm-range');
    const set = (v, syncSlider) => {
      cp[name] = v;
      num.value = (+v).toFixed(6).replace(/\.?0+$/, '') || '0';
      if (syncSlider) sl.value = String(v);
      scheduleParamRender();
    };
    sl.oninput = () => set(+sl.value, false);
    num.oninput = () => { const v = +num.value; if (Number.isFinite(v)) set(v, true); };
    row.querySelector('.prm-gear').onclick = () => { rgRow.hidden = !rgRow.hidden; };
    rgRow.querySelectorAll('input').forEach(inp => {
      inp.oninput = () => {
        const k = inp.dataset.k;
        const v = +inp.value;
        if (!Number.isFinite(v)) return;
        const rg = PARAM_RANGE[name] || (PARAM_RANGE[name] = defaultRange(+cp[name]));
        rg[k] = v;
        if (rg.min > rg.max) rg.max = rg.min;
        if (!(rg.step > 0)) rg.step = 0.01;
        sl.min = rg.min; sl.max = rg.max; sl.step = rg.step;
      };
    });
  });
}

function applyMode(mode) {
  state.spec.mode = mode;
  state.presetId = null;
  if (mode === 'n') {
    state.spec.newtonDegree = state.spec.newtonDegree || 3;
    state.center = { re: '0', im: '0' };
    state.span = { m: 1.75, e: 1 };   // 3.5 units wide, exactly fitting the three roots
    state.maxIter = 90; state.autoIter = false; $('chk-autoiter').checked = false;
    state.bands = 9; state.cycleAuto = true;
  } else if (mode === 'j') {
    state.center = { re: '0', im: '0' };
    state.span = { m: 1.6, e: 1 };
    state.maxIter = 800; state.autoIter = false; $('chk-autoiter').checked = false;
  } else if (mode === 'm') {
    state.center = { re: '-0.6', im: '0' };
    state.span = { m: 1.6, e: 1 };
    state.maxIter = 600; state.autoIter = true; $('chk-autoiter').checked = true;
  } else {
    state.center = { re: '-0.5', im: '0' };
    state.span = { m: 1.6, e: 1 };
  }
  syncModeUi(); syncIterUi(); renderNow();
}

/* ---- the second viewport as a door into the first ----------------------
 * Clicking the Julia preview opens that exact set in the main view.  The view
 * before the jump is kept here so the caption's back button can put it back —
 * the reference's own `julia_x/y` + `zoom`, i.e. what the user was looking at.
 * ---------------------------------------------------------------------- */
let juliaReturn = null;

function openJuliaSet(c) {
  if (!juliaReturn) {
    juliaReturn = {
      mode: state.spec.mode,
      julia: { ...state.spec.julia },
      center: { ...state.center },
      span: { ...state.span },
      maxIter: state.maxIter,
      autoIter: state.autoIter
    };
  }
  state.spec.mode = 'j';
  state.spec.julia = { re: String(c.re), im: String(c.im) };
  state.presetId = null;
  /* A Julia set lives inside |z| < 2, so the frame is the same 3.2 units the
   * mode switch uses, centred on the origin. */
  state.center = { re: '0', im: '0' };
  state.span = { m: 1.6, e: 1 };
  state.autoIter = false;
  state.maxIter = Math.max(800, state.maxIter | 0);
  $('chk-autoiter').checked = false;
  $('in-jr').value = state.spec.julia.re;
  $('in-ji').value = state.spec.julia.im;
  syncModeUi(); syncIterUi();
  if (juliaView) juliaView.setFocus(true);
  renderNow();
}

function backFromJulia() {
  const r = juliaReturn;
  juliaReturn = null;
  if (!r) return;
  state.spec.mode = r.mode;
  state.spec.julia = r.julia;
  state.center = r.center;
  state.span = r.span;
  state.maxIter = r.maxIter;
  state.autoIter = r.autoIter;
  $('chk-autoiter').checked = state.autoIter;
  $('in-jr').value = state.spec.julia.re;
  $('in-ji').value = state.spec.julia.im;
  syncModeUi(); syncIterUi();
  if (juliaView) juliaView.setFocus(false);
  renderNow();
}

/* ---------------- Presets window ---------------- */
let modalKind = null;
/* Thumbnail work that outlives its grid only burns CPU and keeps detached
 * canvases (and their fields) alive.  Drop every queued job and observer when
 * the panel is replaced or closed; in-flight worker jobs finish into detached
 * canvases and are forgotten. */
function clearThumbWork() {
  thumbQueue.length = 0;
  thumbJobs.length = 0;
  clearTimeout(thumbBackfill);
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
}
function openModal(kind, title, sub, bodyHtml, footHtml, cls = '') {
  if (modalKind === 'presets') clearThumbWork();
  modalKind = kind;
  const root = $('modal-root');
  root.hidden = false;
  const modal = $('modal');
  modal.className = 'modal glass ' + cls;
  $('modal-title').textContent = title;
  $('modal-sub').textContent = sub || '';
  $('modal-sub').hidden = !sub;
  $('modal-body').innerHTML = bodyHtml;
  /* The formula panel manages its own scrolling (see .fx-fit in app.css). */
  $('modal-body').classList.toggle('fx-fit', kind === 'formula');
  $('modal-foot').innerHTML = footHtml || '';
  root.querySelectorAll('[data-close]').forEach(el => el.onclick = closeModal);
}

function closeModal() {
  $('modal-root').hidden = true;
  $('modal-root').classList.remove('previewing');
  stopAnimation();
  if (modalKind === 'presets') clearThumbWork();
  modalKind = null;
}

document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));

/* ------------------------------------------------------------------
 * Colour controls shared by the presets panel and the console.
 *
 * One ramp, one selection index (`gradSel`), one writer (`commitStops`).  The
 * presets panel and the console's gradient editor are two views of the same
 * `state.stops`, so an edit made in either shows up in both — there is no
 * second copy of the colour state to keep in sync.
 * ------------------------------------------------------------------ */
function rgbRowHtml() {
  const rows = ['r', 'g', 'b'].map(k => `
        <label class="pce-slide">
          <span class="pce-ch">${k.toUpperCase()}</span>
          <input type="range" min="0" max="255" step="1" data-rgb="${k}" value="0">
          <b data-rgbval="${k}">0</b>
        </label>`).join('');
  return `<div class="pce-rgb">${rows}</div>`;
}

function gradLanesHtml(prefix) {
  return [1, 2, 3].map(z => `
      <div class="grad-lane" data-zone="${z}">
        <div class="grad-bar" data-zone="${z}" title="${t('gradHint')}">
          <div class="grad-fill"></div>
          <span class="grad-lane-tag">${z === 1 ? t('zoneLeft') : z === 2 ? t('zoneMid') : t('zoneRight')}</span>
          <div class="grad-handles"></div>
        </div>
      </div>`).join('');
}

function bindRgbSliders(root) {
  if (!root) return;
  root.querySelectorAll('[data-rgb]').forEach(inp => {
    inp.addEventListener('input', () => {
      const list = editorStops();
      const i = clamp(gradSel, 0, list.length - 1);
      for (const k of ['r', 'g', 'b']) {
        const el = root.querySelector(`[data-rgb="${k}"]`);
        if (el) list[i][k] = (+el.value) / 255;
      }
      commitStops(list, false);
      for (const k of ['r', 'g', 'b']) {
        const v = root.querySelector(`[data-rgbval="${k}"]`);
        if (v) v.textContent = String(inp.value);
      }
    });
  });
}

/** Push the selected stop into every RGB slider on screen. */
function syncRgbSliders() {
  const list = effectiveStops();
  const sel = list[clamp(gradSel, 0, list.length - 1)];
  if (!sel) return;
  document.querySelectorAll('[data-rgb]').forEach(inp => {
    const k = inp.dataset.rgb;
    const v = Math.round(clamp(sel[k], 0, 1) * 255);
    if (document.activeElement !== inp) inp.value = String(v);
    const lab = inp.parentElement && inp.parentElement.querySelector('[data-rgbval]');
    if (lab) lab.textContent = String(v);
  });
}

/* Three tabs: the reference's own two pictures, the other families, and the
 * user's saved work.  `other` is a family tab, not a folder — the cards are
 * ordinary presets that happen to iterate another formula. */
const PRESET_CATS = ['m', 'j', 'other', 'mine'];

function presetCatLabel(k) {
  return ({
    m: t('presetSetM'), j: t('presetSetJ'), mine: t('presetSetMine'),
    other: getLang() === 'en' ? 'Other sets' : '其他集'
  })[k] || k;
}

/**
 * The preset panel.
 *
 * The library is built in (see presetlib.js), so there is no folder to scan and
 * no message to wait for: the grid, the counts and the thumbnails are all local
 * work.  Three things live here and nowhere else — the search/category filter,
 * the save row, and the colour footer that edits the live ramp while the
 * picture stays visible behind it.
 */
function openPresets() {
  const body = `
    <div class="preset-toolbar">
      <div class="cats" id="preset-cats">
        ${PRESET_CATS.map(k => `<button data-cat="${k}" class="${k === 'm' ? 'on' : ''}">${presetCatLabel(k)}</button>`).join('')}
      </div>
      <span class="preset-count" id="preset-count"></span>
      <span class="preset-grow"></span>
      <button class="btn tiny" id="preset-import" title="Ctrl+O">${t('presetImport')}</button>
      <button class="btn tiny" id="preset-export" title="Ctrl+S">${t('presetExport')}</button>
      <button class="btn primary" id="preset-save">＋ ${t('saveView')}</button>
    </div>
    <div class="save-row" id="preset-save-row" hidden>
      <input class="ctl" id="preset-name" placeholder="${t('namePlaceholder')}" spellcheck="false" />
      <button class="btn primary" id="preset-name-ok">${t('saveCurrent')}</button>
      <button class="btn ghost" id="preset-name-cancel">${t('cancel')}</button>
    </div>
    <div class="preset-grid" id="preset-grid"></div>`;
  openModal('presets', t('presetTitle'), '', body);

  let cat = 'm';
  const grid = $('preset-grid');
  let current = state.presetId || null;   // the preset the view came from

  /* Three filters, one dimension: the set.  The library only contains pictures,
   * so there is nothing to search and no colour to edit in here. */
  const matches = (it) => it.c === cat;

  /* A display name has to identify a card.  Two entries that end up with the
   * same label would be indistinguishable, so the id is appended on collision. */
  const labelFor = (it, list) => {
    const base = getLang() === 'en' ? it.n : (it.nz || it.n);
    const dup = list.filter(o => (getLang() === 'en' ? o.n : (o.nz || o.n)) === base).length > 1;
    return dup ? `${base} · ${it.f}` : base;
  };

  const renderList = () => {
    const list = LIB.items.filter(matches);
    $('preset-count').textContent = `${list.length} / ${LIB.count}`;
    if (!list.length) {
      grid.innerHTML = `<div class="preset-empty">${cat === 'mine' ? t('presetEmptyMine') : t('empty')}</div>`;
      return;
    }
    grid.innerHTML = list.map(it => `
      <div class="pcard-wrap">
        <button class="pcard${current === it.f ? ' on' : ''}" data-id="${it.f}">
          <canvas class="thumb" data-id="${it.f}" width="158" height="99"></canvas>
          <span class="meta">
            <span class="nm">${labelFor(it, list)}</span>
            <span class="tag">${it.m.toUpperCase()}${it.an ? ' · ↻' : ''}${it.cg ? ' · GLSL' : ''}</span>
          </span>
        </button>
        ${it.c === 'mine'
          ? `<button class="pcard-del" data-del="${it.f}" title="${t('delete')}">×</button>`
          : ''}
      </div>`).join('');

    grid.querySelectorAll('.pcard').forEach(el => {
      el.onclick = async () => {
        const id = el.dataset.id;
        try {
          const patch = await loadPatch(id);
          applyRefPresetPatch(patch, id);
          markCurrent(el, id);
        } catch (e) {
          /* A failure here used to be invisible: the toast said "preset ✗" and
           * the console said nothing, so a preset that could not be opened
           * looked like one that did nothing. */
          console.error('[preset] open failed', e);
          toast('preset ✗');
        }
      };
    });
    grid.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        deletePreset(b.dataset.del, (m) => {
          toast(m && m.ok ? t('deleted') : 'preset ✗');
          renderList();
        });
      };
    });
    observeThumbs();
  };

  const markCurrent = (el, id) => {
    current = id != null ? id : (el && el.dataset.id);
    state.presetId = current;
    grid.querySelectorAll('.pcard').forEach(c => c.classList.toggle('on', c === el));
    syncAnimationButton();
  };

  /* ---- toolbar -------------------------------------------------------- */
  const saveMine = () => {
    const name = $('preset-name').value.trim() ||
                 `${t('custom')} ${new Date().toLocaleString()}`;
    const obj = makeRefPreset(name);
    /* Overwrite only when the open view *is* one of the user's own presets and
     * the name was not changed; a built-in one always gets a copy. */
    const overwrite = current && LIB.items.some(i => i.f === current && i.c === 'mine')
      ? current : '';
    savePreset(obj, overwrite, name, (m) => {
      toast(m && m.ok ? t('saved') : 'preset ✗');
      if (m && m.ok) {
        current = m.name;
        state.presetId = m.name;
        state.presetFile = m.name;
        cat = 'mine';
        $('preset-cats').querySelectorAll('button').forEach(x =>
          x.classList.toggle('on', x.dataset.cat === 'mine'));
        renderList();
      }
    });
    $('preset-name').value = '';
    $('preset-save-row').hidden = true;
  };

  $('preset-save').onclick = () => {
    const row = $('preset-save-row');
    row.hidden = !row.hidden;
    if (!row.hidden) {
      $('preset-name').value = state.presetName || '';
      $('preset-name').focus();
    }
  };
  $('preset-name-cancel').onclick = () => { $('preset-save-row').hidden = true; };
  $('preset-name-ok').onclick = saveMine;
  $('preset-name').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveMine(); }
  };
  $('preset-cats').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      cat = b.dataset.cat;
      $('preset-cats').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderList();
    };
  });
  $('preset-import').onclick = importPresetFile;
  $('preset-export').onclick = exportPresetFile;
  syncAnimationButton();
  renderList();
  nativeLog(`[ui] presets lib=${LIB.count} mine=${LIB.items.filter(i => i.c === 'mine').length} ` +
            `cards=${grid.children.length} cat=${cat}`);
}

/** Refresh the animation button: only presets that carry keyframes can play. */
function syncAnimationButton() {
  const b = $('pce-play');
  if (!b) return;
  const has = !!(state.animation && state.animation.keys);
  b.hidden = !has;
  b.textContent = (animPlaying ? '⏸ ' : '▶ ') + t('presetPlay');
}

/* The view a preset produced, for the "save" path when no shell is present. */
let thumbObserver = null;
let thumbBackfill = 0;
function observeThumbs() {
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) enqueueThumb(en.target);
    }
  }, { root: $('modal-body'), rootMargin: '120px' });
  document.querySelectorAll('.thumb').forEach(c => thumbObserver.observe(c));
  // Backfill the cards a fast scroll skipped.  The grid is ~512 cards and the
  // desktop shell runs a single worker, so the observer alone used to leave
  // every card that never intersected the viewport black until the category
  // was reopened.
  clearTimeout(thumbBackfill);
  thumbBackfill = setTimeout(() => {
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    document.querySelectorAll('.thumb').forEach(c => enqueueThumb(c));
  }, 350);
}

/** 2/zoom as a mantissa/exponent pair, which is what the view stores. */
function enqueueThumb(cv) {
  /* The field and the card are the same size on purpose: the shader samples
   * the field at gl_FragCoord, so a smaller field would be read as "everything
   * outside the top-left corner" and every card would go flat. */
  /* The field and the card are the same size on purpose: the shader samples
   * the field at gl_FragCoord, so a smaller field would read as "everything
   * outside the top-left corner" and every card would go flat.  A card is
   * displayed at 158x99, but shading a 100x62 field and letting CSS scale it
   * costs 2.5x less and buys the iterations a 1e74 preset needs. */
  /* Render at twice the displayed size and let the blit minify.
   *
   * `dist` is in *rendered pixels* (the reference divides by the pixel size and
   * its shader multiplies back by `pixelsize`), so a Distance-style scheme puts
   * its rim at a fixed 0.4 px.  A 100 px wide field turned that rim into 0.02 px
   * at the card's scale, which aliases into one-different-colour-per-pixel
   * speckle — measured: 13010 distinct colours in a 158x99 card while the main
   * canvas of the same view was a clean line drawing.  Two samples per axis is
   * the cheapest cure and costs 4x on a 316x198 grid, not on the real frame. */
  const W = 316, H = 198;
  const FW = W, FH = H;
  if (cv.dataset.q) return;
  cv.dataset.q = '1';
  const id = cv.dataset.id;
  const it = id ? LIB.items.find(x => x.f === id) : null;
  if (!it) return;

  /* A card is a hint, not a picture: the preset's own additive colour table is
   * what the CPU path can draw, and a shader-based preset is approximated by
   * those same terms here.  Opening the card always uses the shader. */
  const patch = patchOf(it.obj);
  const spec = specOfPatch(patch, it.m);
  const center = patch.center || { re: '0', im: '0' };
  let span = patch.span || { m: 1.6, e: 1 };
  /* The card must use the *same* budget as the view it opens, otherwise it
   * advertises a picture the program will not draw.  900 + 800 per decade
   * capped at 30k was exactly that: a 1e56 preset needs ~124k, so at 30k the
   * kernels stop mid-orbit, every pixel is "bounded", the cycle finder hands
   * out whatever period it happened to catch and the card comes out as
   * salt-and-pepper noise while the main canvas is a clean scroll fan (both
   * measured on Mandelbrot 15).  Same formula, same cap as the main view. */
  const zoomLog = Math.log10(Math.max(1, Number(it.zo) || 1));
  const maxIter = Math.min(120000, autoIterFor(zoomLog));
  const palette = thumbPalette(it);
  const cycle = 12;
  const offset = 0;

  /* Thumbnails are framed a little wider than the view they name, so the shape
   * has air around it inside the card instead of bleeding into the edges. */
  span = scaleSpan(span, 1.22);
  const ps = (span.m * Math.pow(2, span.e)) / FW;
  /* Numeric id: the native host parses viewId as an int and discards jobs with
   * viewId < cancelView, so a string id turned into 0 and every thumbnail was
   * dropped as stale.  A high id is never older than a main-pass cancel. */
  const THUMB_VIEW_ID = 900000;
  const payload = {
    id: 'th-' + id, viewId: THUMB_VIEW_ID,
    x: 0, y: 0, w: FW, h: FH, width: W, height: H,
    spec,
    center, span,
    pixelSize: ps,
    maxIter,
    /* `aa` must match the main view's request (1).  The shader is what
     * supersamples, and asking the *kernel* for 2x as well made the card's
     * field and its canvas disagree about their size, which the shader then
     * read as an out-of-range texture: a 158x99 card came back as one
     * distinct colour per pixel while the main canvas was clean. */
    bits: 'auto', palette, cycle, offset, samples: 2, quality: 2, aa: 1,
    rotation: patch.rotation || 0
  };
  if (modalKind !== 'presets') return;

  /* The card shows what *this* program draws, not the reference's JPEG.
   *
   * It used to prefer the shipped JPEG and never render: a card that promises
   * the original's picture while the app produces something else is the one
   * thing a preset browser must not do.  The JPEG is still useful as an
   * instant placeholder while the real thumbnail is being computed, so it is
   * painted first and replaced the moment the render lands — unless the render
   * already got there. */
  const art = PRESET_THUMBS[id];
  if (art) {
    const im = new Image();
    im.onload = () => {
      if (cv.dataset.q === 'own') return;   // a real render already replaced it
      const g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, cv.width, cv.height);
      cv.dataset.q = 'art';
    };
    im.src = art;
  }

  /* The card must show the colour recipe the card *opens*, which for most of
   * the shipped presets is a shader rather than a palette table.  So the same
   * split the main view uses applies here: the host integrates a small field,
   * one shared WebGL surface shades it, and the result is blitted into the
   * card's 2D canvas.  A per-card context would hit the browser's context
   * limit (~16), which is why there is exactly one. */
  if (gpuOk && NATIVE && !gpu.gl.isContextLost()) {
    thumbJobs.push({ cv, patch, payload, fieldW: FW, fieldH: FH });
    pumpThumbs();
    return;
  }

  dispatch({
    payload, thumb: true,
    onDone: (msg) => {
      if (!msg || msg.viewId !== THUMB_VIEW_ID || !msg.data) return;
      const g = cv.getContext('2d');
      const img = new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h);
      g.putImageData(img, 0, 0);
      cv.dataset.q = 'own';
    }
  });
}

/* ---- thumbnail shading ------------------------------------------------- */

let thumbGpu = null;
let thumbGpuCv = null;
let thumbBusy = false;
const thumbJobs = [];

/** One WebGL surface for every card, created on first use. */
function thumbRenderer() {
  if (thumbGpu) return thumbGpu;
  thumbGpuCv = document.createElement('canvas');
  thumbGpuCv.width = 158;
  thumbGpuCv.height = 99;
  thumbGpu = new FieldRenderer(thumbGpuCv);
  return thumbGpu;
}

function pumpThumbs() {
  if (thumbBusy) return;
  const job = thumbJobs.shift();
  if (!job) return;
  const { cv, patch, payload, fieldW, fieldH } = job;
  const r = thumbRenderer();
  if (!r.ok) { cv.dataset.q = ''; return; }
  thumbBusy = true;
  const ok = nativeField(payload, (msg) => {
    try {
      if (!msg || !msg.data) return;
      const W = msg.w, H = msg.h;
      const rec = resolveScheme(patch);
      const err = r.setScheme(rec.src || GLSL_BUILTIN.smooth.src, 1);
      if (err) { nativeLog('[thumb] sch: ' + String(err).slice(0, 160)); return; }
      r.uploadField(msg.data, W, H);
      r.resize(W, H);
      r.draw({
        colors: rec.colors,
        stops: [],
        briFinite: rec.bri.finite,
        briInfinite: rec.bri.infinite,
        briFactor: rec.bri.factor,
        param: rec.params,
        julia: patch.mode === 'j',
        juliaRe: patch.julia ? Number(patch.julia.re) : 0,
        juliaIm: patch.julia ? Number(patch.julia.im) : 0,
        inverse: !!patch.inverse,
        tone: { bri: 1, gr: 1, gg: 1, gb: 1 }
      });
      cv.getContext('2d').imageSmoothingQuality = 'high';
      cv.getContext('2d').drawImage(thumbGpuCv, 0, 0, cv.width, cv.height);
      cv.dataset.q = 'own';
    } finally {
      thumbBusy = false;
      setTimeout(pumpThumbs, 0);
    }
  });
  if (!ok) { thumbBusy = false; cv.dataset.q = ''; }
  void fieldW; void fieldH;
}

/* ------------------------------------------------------------------
 * Reference presets (the original program's own JSON).
 *
 * A file describes position, zoom, rotation, the Julia seed, the additive
 * `colors` table, the brightness pair — and, for the presets whose whole look
 * is a shader, the `colorscheme.codegl` source.  Importing therefore does two
 * things at once: it moves the view, and it installs a colour scheme.  The
 * second half is the one that matters: four of the shipped presets cannot be
 * expressed as pal() parameters at all, so without the shader they come back
 * as "some other fractal".
 *
 * Export writes the same shape back, including the HLSL twin the original
 * program actually reads, so a round trip stays loadable there.
 * ------------------------------------------------------------------ */
const IMPORTED_PALETTE = 'imported';

/* ---- colour recipe of a preset ---------------------------------------- */

/* The reference's built-in schemes are named in its presets and compiled into
 * its binary: Example 5 says only "Distance and iteration levels" and still
 * gets that shader.  We carry the same set, so a file that names one resolves
 * to our copy instead of silently falling back to a ramp. */
const BUILTIN_SCHEME_BY_NAME = [
  [/^iteration\s+with\s+limit/i, 'glsl:6'],
  [/^iteration/i, 'builtin:iteration'],
  [/^smooth/i, 'builtin:smooth'],
  [/^distance\s+and\s+iteration\s+levels/i, 'glsl:8'],
  [/^distance/i, 'glsl:7'],
  [/^texture/i, 'glsl:9'],
  [/^amethyst/i, 'glsl:1'],
  [/^nebula/i, 'glsl:2'],
  [/^rainbow\s+veins/i, 'glsl:3'],
  [/^high\s+precision\s+rainbow/i, 'glsl:4'],
  [/^chinese\s+remainder/i, 'glsl:5']
];

function builtinSchemeId(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  for (const [re, id] of BUILTIN_SCHEME_BY_NAME) if (re.test(s)) return id;
  return null;
}

/**
 * Everything needed to *shade* a preset: the fragment source, its params, its
 * colour table, its brightness pair and its supersampling count.
 *
 * Pure by construction — the preset grid calls it for every card, so it must
 * not touch `state`.  A file either carries its own `codegl` or names one of
 * the built-ins; in both cases the result is one shader body.
 */
/* Imported `codegl` bodies are GLSL ES 1.00: they carry precision qualifiers
 * inside expressions (`highp float(x)`), which ES 3.00 rejects, and sometimes a
 * `#version`/`precision` line that would land in the middle of our program.
 * Strip both at the boundary rather than teaching every scheme about it. */
function sanitizeGlsl(src) {
  if (!src) return '';
  return String(src)
    .replace(/^\s*#version[^\n]*$/gm, '')
    .replace(/^\s*precision\s+(?:lowp|mediump|highp)\s+\w+\s*;\s*$/gm, '')
    .replace(/\b(?:highp|mediump|lowp)\s+(?=(?:float|int|vec[234]|mat[234]|sampler2D)\b)/g, '');
}

/* The program's own default three-term palette, used by the trap shader when
 * the current palette is a ramp (a ramp has no pal() terms to sum). */
const TRAP_DEFAULT_COLORS = [
  { r: 1, g: 0, b: 0, frequency: -2.1202635765075684, initial: -1.0 },
  { r: 0, g: 1, b: 0, frequency: -1.1363141536712646, initial: -1.5 },
  { r: 0, g: 0, b: 1, frequency: -0.023268627002835274, initial: -0.5 }
];
/* The program's own three-term default, in the domain `pal()` reads. */
const TRAP_DEFAULT_SHADER_COLORS = shaderTerms(TRAP_DEFAULT_COLORS);

/** Trap gain / ring count: the console's own two sliders. */
function trapParam() {
  const clamp01 = (v, d) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : d);
  return { gain: clamp01(state.trapGain, 0.45), rings: clamp01(state.trapRings, 0.40) };
}

/* Re-shade without re-rendering.
 *
 * A trap's gain and ring count are read only by the fragment shader, so the
 * field on the GPU stays valid and the whole update is one draw call — the
 * same path the shader clock uses.  When there is no live field yet (a render
 * in flight, a gesture) the caller falls back to a normal render. */
function reshadeOnly() {
  const d = lastDraw;
  if (!d || !d.fieldLive || !d.param || !(state.traps > 0)) return false;
  d.param[0] = trapParam().gain;
  d.param[1] = trapParam().rings;
  gpu.draw(d);
  if (juliaView) juliaView.redraw();
  return true;
}

function resolveScheme(patch) {
  const out = {
    src: sanitizeGlsl(patch.glsl || ''),
    schemeId: null,
    /* NPARAM is 10 in the reference shader; the old 4-slot clamp silently
     * discarded params.param[4..9] of a scheme that declares them. */
    nparam: Math.max(0, Math.min(REF_MAX_PARAM, patch.nparam | 0)),
    params: (patch.param || []).slice(0, REF_MAX_PARAM).map(v => +v || 0),
    channels: patch.channels == null ? null : (patch.channels >>> 0),
    colors: shaderTerms((patch.colors || []).map(c => ({
      r: c.r, g: c.g, b: c.b,
      frequency: c.frequency != null ? c.frequency : 0,
      initial: c.initial != null ? c.initial : 0
    })), patch.colorFreq, patch.colorInit),
    bri: {
      finite: patch.briFinite != null ? patch.briFinite : 1,
      infinite: patch.briInfinite != null ? patch.briInfinite : 1,
      factor: patch.briFactor != null ? patch.briFactor : 1
    },
    samples: clamp(patch.samples | 0 || 2, 1, 4)
  };
  if (!out.src) {
    const sid = builtinSchemeId(patch.schemeBuiltin || patch.schemeName);
    if (sid === 'builtin:iteration' || sid === 'builtin:smooth') {
      out.src = GLSL_BUILTIN[sid.slice(8)].src;
      out.nparam = 0;
      out.params = [];
    } else if (sid) {
      const s = findSchemeAny(sid);
      if (s) {
        out.src = sanitizeGlsl(s.glsl);
        out.schemeId = s.id;
        out.nparam = s.nparam;
        /* The file's `custom` is the authored setting; the library value is
         * only the fallback when a file names the scheme but not its params. */
        if (!(patch.param && patch.param.length)) out.params = (s.params || []).slice(0, REF_MAX_PARAM);
        /* Three of the built-in schemes (Distance, Distance and iteration
         * levels, Texture) are compiled into the reference together with the
         * program's *default* colour table, so their JSON carries no `colors`
         * at all — the file's own table (or the default the preset generator
         * injected) is what `pal()` must read.  Overwriting it with an empty
         * list left `pal()` returning white and turned these presets into a
         * solid white frame. */
        if (s.colors && s.colors.length) {
          out.colors = shaderTerms(s.colors.map(c => ({
            r: c[0], g: c[1], b: c[2], frequency: c[3], initial: c[4]
          })), s.gf, s.gi);
        }
        out.bri = {
          finite: patch.briFinite != null ? patch.briFinite : s.briFinite,
          infinite: patch.briInfinite != null ? patch.briInfinite : s.briInfinite,
          factor: patch.briFactor != null ? patch.briFactor : s.briFactor
        };
        out.samples = clamp(patch.samples | 0 || s.samples || 2, 1, 4);
        out.channels = s.channels == null ? null : s.channels;
      }
    }
  }
  /* A shipped file may name a custom `codegl` scheme and carry no `colors` at
   * all (Example 12 does).  The reference only overwrites the palette entries
   * the file actually contains, so such a file inherits the palette that was
   * loaded before it — the program's own three-term default on a fresh start.
   * Leaving the list empty makes `pal()` sum nothing and paint a solid black
   * frame, which is exactly what an all-black import looked like. */
  if (!out.colors.length) {
    out.colors = (state.schemeColors && state.schemeColors.length
      ? state.schemeColors
      : TRAP_DEFAULT_SHADER_COLORS).map(c => ({
        r: c.r, g: c.g, b: c.b,
        frequency: +c.frequency || 0, initial: +c.initial || 0
      }));
  }
  while (out.params.length < out.nparam) out.params.push(0.33);
  out.params = out.params.slice(0, Math.max(0, out.nparam));
  return out;
}

/**
 * Install a preset patch.
 *
 * `patch` comes from presetlib.patchOf(), which is the one place that knows how
 * the file's four coordinate pairs map onto the app's view.  Everything else
 * here is bookkeeping: which formula, which colour source, which samples, and
 * whether the file also carries keyframes.
 */
/* The engine's families, by the number the kernels use.  A card carries that
 * number in `spec`; the UI wants the name, and native.js maps the name back to
 * the number for the request — one vocabulary, two spellings. */
const KIND_NAMES = ['mandelbrot', 'tricorn', 'burningship', 'celtic',
                    'perpendicular', 'phoenix'];
function kindNameOf(kind, power) {
  const n = Number(kind) || 0;
  if (n === 0 && power > 2) return 'multibrot';
  return KIND_NAMES[n] || 'mandelbrot';
}
/** The formula a patch names: its own `spec`, else the reference's z^2 + c. */
function specOfPatch(patch, modeOverride) {
  const sp = patch && patch.spec;
  const mode = modeOverride || (sp && sp.mode) || (patch && patch.mode) || 'm';
  const kind = sp ? Number(sp.kind) || 0 : 0;
  const power = sp ? Number(sp.power) || 2 : 2;
  return {
    mode: mode === 'j' ? 'j' : 'm',
    kind: kindNameOf(kind, power),
    power,
    julia: (patch && patch.julia) || null
  };
}

function applyRefPresetPatch(patch, file) {
  const sp = specOfPatch(patch);
  state.spec.mode = sp.mode;
  /* A reference file is the quadratic map; the cards this program authored
   * carry their own family in `spec`, so reading it costs nothing and leaving
   * it out would silently paint another set with the file's picture. */
  state.spec.kind = sp.kind;
  state.spec.power = sp.power;
  syncFamilyUi();
  if (patch.julia) state.spec.julia = { re: patch.julia.re, im: patch.julia.im };

  if (patch.center) state.center = { re: patch.center.re, im: patch.center.im };
  if (patch.span) state.span = patch.span;
  if (patch.rotation != null) state.rotation = patch.rotation;

  /* A preset owns its whole colour recipe.  The seven tone sliders and the
   * phase knob are session state, not file state, so leaving them where the
   * last view put them tinted every preset opened afterwards — the file's
   * measured palette then looked "wrong" while the preset's own numbers were
   * fine.  Neutral here, and syncColorUi() pushes it into the controls. */
  state.tone = { bri: 1, gr: 1, gg: 1, gb: 1 };
  state.offset = 0;
  state.shade = 0;
  state.bands = 0;              // the file's own frequencies, never a fitted band count
  state.detail = 3;

  /* The shader is the preset's real colour recipe (see resolveScheme). */
  const rec = resolveScheme(patch);
  state.glsl = rec.src || null;
  state.schemeChannels = rec.channels == null ? null : rec.channels;
  state.schemeName = patch.schemeName || '';
  state.schemeId = rec.schemeId;
  if (state.glsl) {
    state.schemeMeta = {
      nparam: rec.nparam,
      paramLabels: Array.from({ length: rec.nparam }, (_, i) => ({
        zh: i === 0 ? '方案参数' : '细节距离',
        en: i === 0 ? 'Scheme parameter' : 'Detail distance'
      })),
      samples: rec.samples
    };
    state.schemeParams = rec.params.slice(0, REF_MAX_PARAM);
    state.schemeColors = rec.colors;
    state.schemeBri = rec.bri;
    /* The file's own scheme joins the library under its own name, which is
     * what the reference does for every Colorscheme it creates.  A name that
     * is already there is replaced, as addjdict does. */
    schemeStoreAdd(state.schemeName || patch.name || 'imported', state.glsl, {
      nparam: rec.nparam, samples: rec.samples, channels: state.schemeChannels
    });
  } else {
    state.schemeMeta = null;
  }
  if (patch.samples) state.aa = patch.samples;

  if (patch.colors && patch.colors.length) {
    registerAdditivePalette(IMPORTED_PALETTE, patch.colors,
                            patch.briFinite, patch.briInfinite,
                            patch.schemeName || (patch.name || '').trim(),
                            { gf: patch.colorFreq, gi: patch.colorInit });
    state.palette = IMPORTED_PALETTE;
    state.stops = null;
    /* The LUT now samples this table over one slowest-term period; the colour
     * cycle has to be that same period or the palette is phase-compressed. */
    const cyc = paletteCycle(IMPORTED_PALETTE);
    if (cyc > 0) { state.cycle = cyc; state.cycleAuto = false; }
  }
  /* An edited ramp comes back as a ramp; without one the preset's own colour
   * table is the source, so any earlier edit is dropped. */
  state.stops = Array.isArray(patch.ramp) && patch.ramp.length ? patch.ramp : null;
  state.inverse = !!patch.inverse;
  state.animation = patch.animation || null;
  state.juliaView = patch.juliaView || state.juliaView;
  /* A reference JSON carries the second viewport's own zoom/rotation and the
   * Mandelbrot seed (julia_mx/my).  Feed them to the preview so opening an
   * official example reproduces its authored Julia set too. */
  if (juliaView) juliaView.setParams({
    zoom: state.juliaView && state.juliaView.zoom,
    rotation: state.juliaView && state.juliaView.rotation,
    center: state.juliaView && state.juliaView.re != null
      ? { re: state.juliaView.re, im: state.juliaView.im } : null,
    seed: patch.juliaSeed || null
  });
  state.presetFile = file || '';
  state.presetName = patch.name || '';
  state.presetId = file || patch.id || null;
  /* Keep the file-only fields that have no UI control, so exporting the view
   * writes them back instead of silently dropping realm flags, the legacy
   * home zoom, the scheme's aux texture path and its builtin marker. */
  state.presetMeta = {
    realmFlags: patch.realmFlags,
    juliamode: patch.juliamode,
    initialZoom: patch.initialZoom,
    auxfile: patch.auxfile || '',
    builtin: patch.builtin
  };

  /* `mode` here used to be a bare identifier that no longer existed after the
   * spec was factored into `specOfPatch`: the template threw, the throw
   * aborted the function *before* renderNow(), and every preset in the library
   * therefore loaded its numbers but never repainted. */
  nativeLog(`[preset] open ${file || '-'} mode=${state.spec.mode} ` +
            `center=${state.center.re},${state.center.im} ` +
            `span=${state.span.m}*2^${state.span.e} rot=${(state.rotation || 0).toFixed(3)} ` +
            `glsl=${state.glsl ? 'yes' : 'no'} colors=${patch.colors ? patch.colors.length : 0} ` +
            `anim=${patch.animation ? 'yes' : 'no'}`);

  try {
    const sel = $('sel-palette');
    if (patch.colors && patch.colors.length) {
      let opt = [...sel.options].find(o => o.value === IMPORTED_PALETTE);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = IMPORTED_PALETTE;
        sel.appendChild(opt);
      }
      opt.textContent = patch.schemeName || patch.name || 'Imported';
    }
    sel.value = state.palette;
    $('sel-scheme').value = state.scheme;
  } catch (_) { /* the palette may not be in the dropdown yet */ }

  /* Anything below can throw on a preset that carries a field the controls do
   * not know about, and an exception here used to abort the function before
   * `renderNow()` — the state changed, the picture did not, and it looked like
   * the preset had failed to load.  The view must be drawn regardless. */
  try { syncColorUi(); syncModeUi(); syncIterUi(); syncRotationUi(); }
  catch (e) { console.error('[preset] ui', e); }
  /* A preset that carries keyframes starts paused: playing is a deliberate act,
   * and a view that starts moving on its own is not what "open a file" means. */
  try { stopAnimation(); syncAnimationButton(); }
  catch (e) { console.error('[preset] anim', e); }
  viewId++;
  renderNow();
  toast(patch.name || patch.schemeName || t('saved'));
  return true;
}

/**
 * The reference reads four JSON shapes through four loaders (00539080,
 * 005472c0, 00547070 and 0055ef40).  A colorschemes.json library or a
 * mandelbrot.json settings file used to be fed to patchOf(), which produced
 * an empty view instead of installing what the file describes.
 */
function applyRefConfigText(obj, kind, name) {
  if (kind === 'colorschemes' || kind === 'scheme') {
    const list = Array.isArray(obj) ? obj : [obj];
    const r = readColorschemes(JSON.stringify(list));
    let added = 0;
    for (const [k, cs] of r.dict) { schemeDict.set(k, cs); added++; }
    schemeStoreSave();
    refreshReferenceSchemes();
    nativeLog('[cfg] imported ' + added + ' colorscheme(s) from ' + (name || 'file'));
    toast(added + ' schemes ✓');
    return true;
  }
  if (kind === 'settings') {
    applyConfig(readRefSettings(obj));
    nativeLog('[cfg] imported appdata/mandelbrot.json from ' + (name || 'file'));
    toast('settings ✓');
    return true;
  }
  return false;
}

/** Text entry point, used by the file dialog and by a file named on the CLI. */
function applyRefPresetText(text, name) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    nativeLog('[preset] parse failed: ' + (e && e.message));
    toast('JSON ✗');
    return false;
  }
  const kind = classifyRefJson(obj);
  if (kind !== 'preset') {
    if (applyRefConfigText(obj, kind, name)) return true;
    nativeLog('[preset] unsupported JSON shape: ' + kind);
    toast('unsupported JSON ✗');
    return false;
  }
  let patch;
  try {
    patch = patchOf(obj);
  } catch (e) {
    nativeLog('[preset] not a preset: ' + (e && e.message));
    toast('preset ✗');
    return false;
  }
  if (!patch.name && name) patch.name = String(name).split(/[\\/]/).pop();
  /* Import = add to "mine" *and* open it.  Storing first means the id the
   * library assigns is the one the view records, so saving again overwrites
   * instead of piling up copies. */
  let stored = '';
  savePreset(obj, '', patch.name || 'imported', (m) => { if (m && m.ok) stored = m.name; });
  return applyRefPresetPatch(patch, stored);
}

/* The shell can open a preset or a panel by name: a file on the command line,
 * or a scripted screenshot. */
window.addEventListener('mbShell', async (e) => {
  const m = e.detail;
  if (!m) return;
  if (m.type === 'openPreset' && m.name) {
    try {
      const patch = await loadPatch(m.name);
      applyRefPresetPatch(patch, m.name);
    } catch (err) {
      nativeLog('[preset] shell open failed: ' + (err && err.message));
    }
  } else if (m.type === 'openPanel' && m.panel === 'presets') {
    openPresets();
  }
});

/* The shell can push a preset without being asked (a file named on the
 * command line, or one dropped on the window). */
window.addEventListener('mbPreset', (e) => {
  const m = e.detail;
  if (m && m.type === 'presetImport' && m.ok) applyRefPresetText(m.text, m.name);
  else if (m && m.type === 'presetExport') toast(m.ok ? t('saved') : 'preset ✗');
});

/* ---- appdata\mandelbrot.json -------------------------------------------
 * The reference program's parameter file (winparameters.html).  The shell
 * parses it, clamps every key to the documented range/defaults, applies
 * `nthread` before the engine starts, and sends the effective values here.
 * Only the keys with a real counterpart in this port change anything; the rest
 * are surfaced so the reference's own file is drop-in.
 */
function applyConfig(cfg) {
  if (!cfg) return;
  state.cfg = cfg;
  const MB = 1024 * 1024;
  let budget = 96 * MB;
  if (cfg.cachesize === 9) budget /= 4;
  else if (cfg.cachesize === 11) budget *= 4;
  if (cfg.totalmemory > 0) budget = Math.min(budget, cfg.totalmemory * MB / 4);
  FIELD_MEM_BUDGET = Math.max(16 * MB, Math.min(512 * MB, budget));
  if (cfg.guiscale && Math.abs(cfg.guiscale - 1) > 1e-3)
    document.documentElement.style.zoom = String(cfg.guiscale);
  const mb = Math.round(FIELD_MEM_BUDGET / MB);
  const note = $('cfg-note');
  if (note) {
    note.hidden = false;
    note.textContent = getLang() === 'en'
      ? (cfg.loaded ? `mandelbrot.json loaded · threads ${cfg.nthread || nativeThreads()} · cache ${cfg.cachesize} · field ${mb} MB`
                    : 'mandelbrot.json not found · documented defaults')
      : (cfg.loaded ? `mandelbrot.json 已读取 · 线程 ${cfg.nthread || nativeThreads()} · 缓存 ${cfg.cachesize} · 场缓存 ${mb} MB`
                    : 'mandelbrot.json 未找到 · 使用文档默认值');
  }
  nativeLog('[cfg] applied ' + JSON.stringify(cfg) + ' fieldMB=' + mb);
}
window.addEventListener('mbConfig', (e) => applyConfig(e.detail));

function importPresetFile() {
  if (!nativeImportPreset((m) => {
        if (!m || !m.ok) { toast('preset ✗'); return; }
        applyRefPresetText(m.text, m.name);
      })) {
    /* Browser build: fall back to a file input, which is the only way a page
     * can read a local file on its own. */
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      applyRefPresetText(await f.text(), f.name);
    });
    inp.click();
  }
}

/**
 * The current view as a reference-shaped preset object.
 *
 * Every field is filled: the position and zoom as decimal text (so a 40-digit
 * centre survives), the rotation, the Julia view *and* seed, the additive colour
 * table, the brightness pair, the scheme's shader when one is installed, and the
 * animation when the view has one.
 */
function makeRefPreset(name) {
  /* Export writes the file's LITERAL log-domain table, not the exp()-converted
   * values the shader uses: the reference applies exp(f_i + F) itself in
   * loadParams.  Writing shader values here would double-apply it. */
  const raw = paletteRaw(state.palette);
  const terms = nativePaletteTerms(state.palette) || {};
  const colors = raw ? raw.colors.map(c => ({ ...c })) : [];
  return buildObject({
    colorFreq: raw ? raw.gf : undefined,
    colorInit: raw ? raw.gi : undefined,
    name,
    nameZh: name,
    id: (state.presetFile || '').replace(/\.json$/, '') || null,
    category: 'user',
    mode: state.spec.mode,
    center: state.center,
    span: state.span,
    rotation: state.rotation || 0,
    julia: state.spec.julia,
    juliaView: state.juliaView,
    colors,
    /* A hand-edited ramp travels as itself (see presetlib.buildObject): it is
     * not expressible as the additive table, and rounding it into one would
     * lose the edit that produced it. */
    ramp: Array.isArray(state.stops) ? state.stops : null,
    briFinite: terms.briFinite,
    briInfinite: terms.briInfinite,
    briFactor: state.schemeBri ? state.schemeBri.factor : 1,
    inverse: !!state.inverse,
    glsl: state.glsl || '',
    hlsl: state.glsl ? glslToHlsl(state.glsl) : '',
    schemeName: state.schemeName || (state.glsl ? 'Imported scheme' : undefined),
    samples: state.aa,
    nparam: state.schemeMeta ? state.schemeMeta.nparam : 0,
    channels: state.schemeChannels == null ? undefined : state.schemeChannels,
    auxfile: (state.presetMeta && state.presetMeta.auxfile) || '',
    builtin: state.presetMeta && state.presetMeta.builtin,
    param: state.schemeParams ? state.schemeParams.slice(0, REF_MAX_PARAM) : null,
    juliamode: state.presetMeta ? state.presetMeta.juliamode : undefined,
    realmFlags: state.presetMeta ? state.presetMeta.realmFlags : undefined,
    initialZoom: state.presetMeta ? state.presetMeta.initialZoom : undefined,
    animation: state.animation || null
  });
}

function exportPresetFile() {
  const json = JSON.stringify(makeRefPreset(state.presetName || 'preset'), null, 2) + '\n';
  if (!nativeExportPreset(json, (m) => {
        toast(m && m.ok ? t('saved') : 'preset ✗');
      })) {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'preset.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}

/* ------------------------------------------------------------------
 * Animation playback.
 *
 * Some presets carry a keyframe list (the reference program's own files can
 * describe a move as well as a view).  Playing one walks the view along those
 * keys and asks for a frame at a fixed cadence; the renderer's progressive
 * path already drops stale frames, so a slow frame simply means a lower frame
 * rate, never a queue.
 *
 * It is deliberately not a video renderer: no frame is written to disk, and the
 * cadence is chosen to stay interactive.
 * ---------------------------------------------------------------- */
let animPlaying = false;
let animRAF = 0;
let animStart = 0;
let animLast = 0;
const ANIM_FRAME_MS = 130;

function stopAnimation() {
  animPlaying = false;
  if (animRAF) { cancelAnimationFrame(animRAF); animRAF = 0; }
  syncAnimationButton();
}

function toggleAnimation() {
  if (animPlaying) { stopAnimation(); return; }
  const anim = state.animation;
  if (!anim || !anim.keys) return;
  animPlaying = true;
  animStart = performance.now();
  animLast = 0;
  syncAnimationButton();
  const step = (now) => {
    if (!animPlaying) return;
    const dur = Math.max(0.5, Number(anim.duration) || 12) * 1000;
    const t = ((now - animStart) % dur) / dur;
    if (now - animLast >= ANIM_FRAME_MS) {
      animLast = now;
      const v = sampleAnimation(anim, t);
      if (v) {
        /* The keys carry plain numbers; the view wants decimal text.  Going
         * through String() keeps one code path for the renderer, which reads
         * the centre as text so a deep view is not truncated. */
        if (isFinite(v.x) && isFinite(v.y)) {
          state.center = { re: String(v.x), im: String(v.y) };
        }
        if (v.zoom && isFinite(v.zoom)) {
          const span = 2 / v.zoom;
          let m = span, e = 0;
          while (m >= 2) { m /= 2; e++; }
          while (m < 1) { m *= 2; e--; }
          state.span = { m, e };
        }
        if (v.rotation != null && isFinite(v.rotation)) { state.rotation = v.rotation; syncRotationUi(); }
        if (v.offset != null && isFinite(v.offset)) state.offset = v.offset;
        viewId++;
        renderNow();
      }
    }
    animRAF = requestAnimationFrame(step);
  };
  animRAF = requestAnimationFrame(step);
}

/* ---------------- Formula window ---------------- */
let formulaWorkerJob = null;

function openFormula() {
  const body = `
    <div class="fx-wrap">
      <div class="fx-list" id="fx-list"></div>
      <div class="fx-preview">
        <div class="fx-stage" id="fx-stage">
          <canvas id="formula-preview" width="720" height="450"></canvas>
          <div class="fx-insetbox" id="fx-inset-box" hidden>
            <canvas id="formula-inset" width="320" height="200"></canvas>
            <div class="fx-inset-cap" id="fx-inset-cap">10^9</div>
          </div>
          <div class="fx-marker" id="fx-marker" hidden></div>
          <button class="btn tiny fx-branch-btn" id="fx-branch-next">${t('pickAnother')}</button>
          <div class="fx-branch-info" id="fx-branch-info">${t('pickCriteria')}</div>
        </div>
      </div>
    </div>`;
  const foot = `
    <button class="btn ghost" id="f-copy">LaTeX</button>
    <button class="btn" id="f-save">${t('saveFormula')}</button>
    <button class="btn" id="f-parse">${t('parseExpr')}</button>
    <button class="btn primary" id="f-apply">${t('apply')}</button>`;
  openModal('formula', t('formulaTitle'), t('formulaSub'), body, foot, 'wide');

  const state2 = {
    expr: state.spec.customExpr || 'z^2 + c',
    vals: { ...state.spec.customParams },
    params: [],
    latex: '',
    ok: false
  };

  const list = $('fx-list');
  // One-time shell: the textarea is created once and never rebuilt, so typing
  // never loses focus / caret. Only the parameter block and the LaTeX line
  // get refreshed, and only when the user explicitly asks for a parse.
  list.innerHTML = `
    <div class="fx-row fx-main">
      <span class="fx-idx">1</span>
      <div class="fx-cell"><div class="fx-tex big" id="fx-tex"></div></div>
    </div>
    <div class="fx-row fx-input">
      <span class="fx-idx">ƒ</span>
      <div class="fx-cell"><textarea class="fx-expr" id="fx-expr" spellcheck="false"></textarea></div>
    </div>
    <div class="fx-examples" id="fx-examples">
      ${EXAMPLES.map(e => `<button data-expr="${e.expr.replace(/"/g, '&quot;')}">${getLang() === 'en' ? e.en : e.zh}</button>`).join('')}
    </div>
    <div class="fx-hint">${t('fxHint')}</div>
    <div class="fx-meta" id="fx-meta"></div>
    <div class="fx-deep" id="fx-deep">${t('formulaDeep')}</div>
    <div id="fx-params"></div>`;

  const ta = $('fx-expr');
  ta.value = state2.expr;
  ta.addEventListener('input', () => {
    state2.expr = ta.value;
    state2.dirty = true;
    setMetaPending();
  });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      validate();
    }
  });

  function setMetaPending() {
    const m = $('fx-meta');
    if (!m) return;
    m.className = 'fx-meta';
    m.textContent = t('parsePending');
  }

  function renderTex() {
    const el = $('fx-tex');
    if (!el) return;
    if (!state2.ok) { el.innerHTML = 'z \u2192 <span class="fx-err">?</span>'; return; }
    el.innerHTML = `z \u2192 ${latexToHtml(state2.latex)}`;
  }

  function renderParams() {
    const box = $('fx-params');
    if (!box) return;
    let html = '';
    state2.params.forEach((name, i) => {
      const v = state2.vals[name] ?? 0;
      html += `
      <div class="fx-row fx-param">
        <span class="fx-idx">${i + 2}</span>
        <div class="fx-cell">
          <div class="fx-tex"><i>${name}</i> = <span class="fx-val">${v.toFixed(2)}</span></div>
          <div class="fx-slider">
            <span>-3</span>
            <input type="range" data-p="${name}" min="-3" max="3" step="0.01" value="${v}"/>
            <span>3</span>
          </div>
        </div>
      </div>`;
    });
    box.innerHTML = html;
    box.querySelectorAll('.fx-slider input').forEach(sl => {
      sl.addEventListener('input', () => {
        const name = sl.dataset.p;
        state2.vals[name] = parseFloat(sl.value);
        const lab = sl.closest('.fx-cell').querySelector('.fx-val');
        if (lab) lab.textContent = state2.vals[name].toFixed(2);
        clearTimeout(sl._tm);
        sl._tm = setTimeout(() => {
          renderFormulaPreview(state2.expr, state2.vals);
          /* A parameter moves the branches themselves, so the previous pick is
           * no longer describing this family: score again. */
          state2.branch = null;
          renderInset(state2.expr, state2.vals);
        }, 150);
      });
    });
  }

  function validate() {
    const meta = $('fx-meta');
    try {
      const r = compileMath(state2.expr);
      state2.ok = true;
      state2.latex = r.latex;
      const uniq = [...new Set(r.params || [])];
      state2.params = uniq;
      uniq.forEach(n => { if (!(n in state2.vals)) state2.vals[n] = 0; });
      state2.fn = r.fn;
      state2.step = r.step;
      /* A new expression means every previous pick described a different
       * family: drop it so the branch scorer runs again from scratch. */
      state2.branch = null;
      state2.recent = [];
      state2.parsedExpr = state2.expr;
      state2.dirty = false;
      renderTex();
      renderParams();
      if (ta) ta.classList.remove('bad');
      const deep = $('fx-deep');
      if (deep) {
        /* Which deep path this expression can take.  A holomorphic formula gets
         * the exact power-series (jet) perturbation; a non-analytic one (abs,
         * conj, arg, re, im) only admits a linear perturbation, and saying so
         * is better than letting it quietly blur at depth. */
        const holy = !/(^|[^A-Za-z])(abs|conj|arg|re|im|abs2|norm)\s*\(/.test(state2.expr);
        deep.className = 'fx-deep ' + (holy ? 'ok' : 'warn');
        deep.textContent = holy ? t('formulaDeep') : t('formulaDeepOff');
      }
      if (meta) {
        meta.className = 'fx-meta ok';
        meta.textContent = t('compileOk') + ' · ' + uniq.length + ' ' + t('params');
      }
      renderFormulaPreview(state2.expr, state2.vals);
      /* The whole point of the inset is to answer "is *this* parameter set worth
       * zooming into", so every successful parse re-asks it. */
      renderInset(state2.expr, state2.vals);
    } catch (err) {
      state2.ok = false;
      state2.dirty = false;
      state2.parsedExpr = state2.expr;
      renderTex();
      if (ta) ta.classList.add('bad');
      if (meta) {
        const pos = Number.isFinite(err.pos) ? err.pos : null;
        const line = Number.isFinite(err.line) ? err.line : null;
        let where = '';
        if (line != null) {
          where = t('errorAt')
            .replace('{line}', String(line))
            .replace('{col}', String((pos != null ? pos : 0) + 1)) + ' · ';
        } else if (pos != null) {
          where = 'col ' + (pos + 1) + ' · ';
        }
        meta.className = 'fx-meta err';
        meta.textContent = t('compileErr') + '：' + where + err.message;
      }
    }
  }

  $('fx-examples').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state2.expr = b.dataset.expr;
      ta.value = state2.expr;
      ta.focus();
      validate();
    };
  });
  $('f-parse').onclick = () => { state2.expr = ta.value; validate(); };

  function applyCurrent() {
    if (state2.dirty || !state2.parsedExpr) validate();
    if (!state2.ok) return false;
    state.spec.customExpr = state2.expr;
    state.spec.customParams = { ...state2.vals };
    state.spec.mode = 'x';
    /* Keep the view the user is looking at.  Jumping back to the home view on
     * apply made "write a formula, then zoom in" impossible: every edit threw
     * the zoom away.  The formula is applied to whatever frame is on screen. */
    state.presetId = null;
    syncModeUi(); syncFormulaUi(); renderNow();
    closeModal();
    return true;
  }
  $('f-apply').onclick = applyCurrent;
  $('f-save').onclick = () => {
    if (state2.dirty || !state2.parsedExpr) validate();
    if (!state2.ok) return;
    const l = loadFormulas();
    l.push({ name: state2.expr.split('\n')[0].slice(0, 40), expr: state2.expr, params: { ...state2.vals }, at: Date.now() });
    saveFormulas(l);
    toast(t('saved'));
  };
  $('f-copy').onclick = () => {
    navigator.clipboard?.writeText(state2.latex).then(() => toast('LaTeX ✓')).catch(() => toast('LaTeX'));
  };

  /* ---- second viewport: automatic branch view ------------------------
   * The inset no longer asks the user where to look.  It scores the preview
   * domain and picks a *branch* on its own: a place that is outside the set,
   * carries a real iteration gradient, and is not a flat wash.  The same rule
   * the colour stage uses to decide "there is structure here" is what decides
   * the pick, so this is a measurement, not a scatter of random points.
   *
   * The score of a candidate point uses the real iteration counts from the
   * same `step` kernel the renderer runs (never the colours, which are a
   * palette away from the truth):
   *
   *   edge  — boundary density: fraction of a one-level-set difference across
   *           the four neighbours.  A point inside a lobe or inside a flat
   *           exterior band has edge = 0.
   *   grad  — iteration gradient, mean |Δn| over the four neighbours: level
   *           sets per preview pixel.  Flat colour means grad ≈ 0.
   *   open  — non-flatness, the spread of the neighbour counts divided by the
   *           centre's count.  A single-colour region scores 0 here.
   *
   * score = (log(1+grad)·0.6 + edge·0.4) · (0.35 + min(1, open))
   *
   * Interior points (`m2 < 0`, i.e. the kernel's "never escaped") are dropped
   * before scoring.  The pick is drawn from the top 15 % of the survivors, and
   * the last few picks are excluded so "another one" really rotates.  The
   * magnification is derived from the local structure scale, not chosen by the
   * user; if the render comes back flat the point is rejected and another is
   * tried, so a blank inset is never shown.
   * ------------------------------------------------------------------ */
  const MAIN_W = 4.26666;              // preview width in the complex plane
  const MAIN_H = MAIN_W * (450 / 720); // and its height, same pixel size
  const MAIN_C = { re: -0.5, im: 0 };
  const PREVIEW_MAXITER = 500;
  state2.branch = null;
  state2.recent = [];
  let insetSeq = 0;

  const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

  /** Luminance gradient and spread of a rendered RGBA buffer. */
  function imageStructure(d, w, h) {
    let sum = 0, sum2 = 0, gsum = 0, n = 0;
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    for (let y = 1; y + 2 < h; y += 2) {
      for (let x = 1; x + 2 < w; x += 2) {
        const i = (y * w + x) * 4;
        const l = lum(i);
        sum += l; sum2 += l * l; n++;
        gsum += Math.abs(lum((y * w + x + 2) * 4) - l);
        gsum += Math.abs(lum(((y + 2) * w + x) * 4) - l);
      }
    }
    const mean = n ? sum / n : 0;
    const sd = Math.sqrt(Math.max(0, (n ? sum2 / n : 0) - mean * mean));
    return { sd, edge: n ? gsum / (2 * n) : 0 };
  }

  /** Score every candidate cell of the preview; return the survivors. */
  function branchCandidates(k) {
    const px = MAIN_W / 720;
    const d = px * 2;
    const cols = 56, rows = 34;
    const out = [];
    for (let gy = 2; gy < rows - 2; gy++) {
      for (let gx = 2; gx < cols - 2; gx++) {
        const re = MAIN_C.re + (((gx + 0.5) / cols) - 0.5) * MAIN_W;
        const im = MAIN_C.im + (0.5 - ((gy + 0.5) / rows)) * MAIN_H;
        const n0 = k.at(re, im, PREVIEW_MAXITER);
        if (n0 < 0) continue;                     // interior: not a branch
        let gsum = 0, minN = n0, maxN = n0, live = 0;
        for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
          const n1 = k.at(re + dx, im + dy, PREVIEW_MAXITER);
          if (n1 < 0) continue;                   // neighbour inside the set
          live++;
          gsum += Math.abs(n1 - n0);
          if (n1 < minN) minN = n1;
          if (n1 > maxN) maxN = n1;
        }
        if (live < 2) continue;                   // hugging the set: no room
        const grad = gsum / live;
        const spread = maxN - minN;
        const edge = spread > 0 ? Math.min(1, spread / (maxN + 1)) : 0;
        const open = spread / (n0 + 1);
        /* A point that escapes early is an exterior plateau: at n = 19 the
         * nearest boundary is ~2^-19 away, so any card small enough to be
         * interesting lands inside a smooth wash.  Requiring a high escape
         * count is what puts the pick on the boundary rather than near it. */
        if (n0 < 40 || grad < 1.0) continue;
        const score = Math.log1p(n0) * Math.log1p(grad) *
                      (0.35 + Math.min(1, open));
        if (score < 0.3) continue;                // flat band / dead region
        out.push({ re, im, score, grad, edge, open, n: n0 });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /** Kernels for the scorer; rebuilt per call because params can change. */
  function branchKernel() {
    const stp = state2.step;
    if (!stp) return null;
    const P = state2.params.map(n2 => state2.vals[n2] ?? 0);
    const S = {}, OUT = new Float64Array(2);
    return {
      P,
      /* n < 0 marks "inside" (a period was found); n >= limit means no escape
       * within the budget, which is the same answer for our purposes. */
      at(re, im, limit) {
        stp(0, 0, re, im, P, limit, S, OUT);
        const n = OUT[0];
        return (OUT[1] < 0 || n >= limit) ? -1 : n;
      }
    };
  }

  /**
   * Walk down to the boundary at the target scale.
   *
   * The overview cannot show a 10^-9 feature: a coarse sample of it can only
   * tell us "the boundary is somewhere near".  So the pick is not a point but
   * a descent — at each decade we sample a 9x9 grid one card wide, move to the
   * cell with the highest escape count, and zoom another decade.  The escape
   * count is a monotone proxy for "closer to the set", so this converges onto
   * the boundary instead of guessing at it.  81 kernel calls per decade is
   * cheap enough to run on every open.
   */
  function descendToBoundary(re, im, targetMag, k) {
    const limit = Math.min(6000, 400 + Math.round(targetMag * 90));
    let x = re, y = im;
    for (let mag = 1.5; mag <= targetMag + 0.001; mag += 1) {
      const span = MAIN_W / Math.pow(10, mag);
      const d = span / 8;                       // 9x9 grid, one card wide
      let bx = x, by = y, bn = -1;
      for (let j = -4; j <= 4; j++) {
        for (let i = -4; i <= 4; i++) {
          const n = k.at(x + i * d, y + j * d, limit);
          /* A cell that never escapes is *inside*; the boundary we want hugs
           * it from the outside, so interior cells are skipped, not chosen. */
          if (n > bn) { bn = n; bx = x + i * d; by = y + j * d; }
        }
      }
      if (bn < 0) break;
      x = bx; y = by;
    }
    return { re: x, im: y };
  }

  /** Pick one branch from the best-scoring candidates, avoiding recent ones. */
  function pickBranch() {
    const k = branchKernel();
    if (!k) return null;
    const cands = branchCandidates(k);
    if (!cands.length) return null;
    const top = cands.slice(0, Math.max(1, Math.round(cands.length * 0.3)));
    const fresh = top.filter(c =>
      !state2.recent.some(r => Math.hypot(r.re - c.re, r.im - c.im) < 0.25));
    const pool = fresh.length ? fresh : top;
    const c = pool[(Math.random() * pool.length) | 0];
    /* Magnification follows the escape count.  A point that escapes at n has
     * its nearest boundary about 2^-n away, so the card must be much smaller
     * than that to stand inside the structure: log10(2^n) = 0.301·n, plus a
     * margin.  The margin is the whole trick — at exactly 2^-n the card is a
     * quarter of the boundary, at one decade less it is a portrait of it. */
    const magLog = clampN(0.301 * c.n + 1.5, 4, 10);
    const p = descendToBoundary(c.re, c.im, magLog, k);
    state2.branch = { re: p.re, im: p.im, magLog, seed: { re: c.re, im: c.im },
                      n: c.n, grad: c.grad, edge: c.edge, open: c.open, score: c.score };
    state2.recent.push({ re: p.re, im: p.im });
    if (state2.recent.length > 4) state2.recent.shift();
    return state2.branch;
  }

  function insetSpan() {
    let w = MAIN_W / Math.pow(10, state2.branch.magLog);
    let e = Math.floor(Math.log2(w));
    let m = w / Math.pow(2, e);
    while (m >= 2) { m /= 2; e++; }
    while (m < 1) { m *= 2; e--; }
    return { m, e, w };
  }

  /** Extend a double coordinate with zeros to the digits the depth needs. */
  function padCoord(v, digits) {
    let s = String(v);
    const dot = s.indexOf('.');
    if (dot < 0 && digits > 0) s += '.';
    const have = dot < 0 ? 0 : s.length - dot - 1;
    if (digits > have) s += '0'.repeat(digits - have);
    return s;
  }

  function drawMarker() {
    const mk = $('fx-marker'), cv = $('formula-preview');
    if (!mk || !cv || !state2.branch) { if (mk) mk.hidden = true; return; }
    const stage = $('fx-stage').getBoundingClientRect();
    const r = cv.getBoundingClientRect();
    const px = (state2.branch.re - MAIN_C.re) / MAIN_W + 0.5;
    const py = 0.5 - (state2.branch.im - MAIN_C.im) / MAIN_H;
    mk.hidden = false;
    mk.style.left = (r.left - stage.left + px * r.width) + 'px';
    mk.style.top = (r.top - stage.top + py * r.height) + 'px';
  }

  function branchInfo(b, ms, st) {
    const el = $('fx-branch-info');
    if (!el) return;
    if (!b) { el.textContent = t('pickCriteria'); return; }
    const y = b.im < 0 ? '-' : '+';
    el.textContent = `10^${b.magLog.toFixed(1)} · n=${b.n} ∇=${b.grad.toFixed(0)}` +
                     ` · ${b.re.toFixed(4)}${y}${Math.abs(b.im).toFixed(4)}i` +
                     (st ? ` · σ${st.sd.toFixed(0)} Δ${st.edge.toFixed(0)}` : '') +
                     (ms != null ? ` · ${ms}ms` : '');
  }

  /** Render the picked branch; a flat answer is rejected and re-picked. */
  function renderInset(src, vals, tries = 3) {
    const cv = $('formula-inset');
    const box = $('fx-inset-box');
    const cap = $('fx-inset-cap');
    if (!cv || !box) return;
    if (!state2.branch && !pickBranch()) { box.hidden = true; return; }
    const b = state2.branch;
    drawMarker();
    const W = cv.width, H = cv.height;
    const sp = insetSpan();
    const ps = sp.w / W;
    const digits = Math.ceil(b.magLog) + 22;
    const id = 'fi' + (++insetSeq);
    const t0 = performance.now();
    box.hidden = false;
    if (cap) cap.textContent = '10^' + b.magLog.toFixed(1);
    dispatch({
      payload: {
        id, viewId: 'formula-inset',
        x: 0, y: 0, w: W, h: H, width: W, height: H,
        spec: {
          mode: 'x', kind: 'mandelbrot', power: 2,
          customExpr: src, customParams: { ...(vals || state2.vals) },
          julia: { ...state.spec.julia }
        },
        center: { re: padCoord(b.re, digits), im: padCoord(b.im, digits) },
        span: { m: sp.m, e: sp.e },
        pixelSize: ps,
        maxIter: Math.min(6000, 400 + Math.round(b.magLog * 90)),
        bits: 'auto',
        palette: state.palette, cycle: state.cycle, offset: state.offset, samples: 1
      },
      thumb: true,
      onDone: (msg) => {
        if (msg.viewId !== 'formula-inset' || msg.id !== id) return;
        const c2 = $('formula-inset');
        if (!c2) return;
        const pxIn = (msg.data instanceof ArrayBuffer)
          ? new Uint8ClampedArray(msg.data) : msg.data;
        const st = imageStructure(pxIn, msg.w, msg.h);
        /* A blank card is not an answer.  Retry with another branch while the
         * pick still looks structureless — a deep environment that failed to
         * build shows up here as sd = 0 and is never shown as a result.  Every
         * other retry also steps one decade shallower: a card that is flat at
         * 10^8 is usually an exterior plateau, and the boundary it belongs to
         * is visible a decade out. */
        if (st.sd < 8 && st.edge < 2.0 && tries > 0) {
          const prev = state2.branch.magLog;
          if (pickBranch()) {
            if (tries % 2 === 0) state2.branch.magLog = Math.max(4, prev - 1.2);
            renderInset(src, vals, tries - 1);
            return;
          }
        }
        c2.getContext('2d').putImageData(
          new ImageData(new Uint8ClampedArray(pxIn), msg.w, msg.h), 0, 0);
        if (cap) {
          cap.textContent = '10^' + b.magLog.toFixed(1) + ' · ' +
                            Math.round(performance.now() - t0) + ' ms';
        }
        branchInfo(b, Math.round(performance.now() - t0), st);
      }
    });
  }

  const nextBtn = $('fx-branch-next');
  if (nextBtn) nextBtn.onclick = () => { pickBranch(); renderInset(state2.expr, state2.vals); };

  validate();
}

function compileFormulaLocal(src) {
  const r = compileMath(src);
  return r.latex;
}

function renderFormulaPreview(src, vals) {
  const cv = $('formula-preview');
  if (!cv) return;
  const W = cv.width, H = cv.height;
  /* 4/3 of the old span draws the set at three quarters of its previous size,
   * which leaves room around it for the outline to actually be legible. */
  const span = { m: 2.1333, e: 1 };
  const ps = (span.m * Math.pow(2, span.e)) / W;
  const payload = {
    id: 'fp', viewId: 'formula',
    x: 0, y: 0, w: W, h: H, width: W, height: H,
    spec: {
      mode: 'x', kind: 'mandelbrot', power: 2,
      customExpr: src, customParams: { ...(vals || state.spec.customParams) },
      julia: { ...state.spec.julia }
    },
    center: { re: '-0.5', im: '0' }, span,
    pixelSize: ps, maxIter: 500, bits: 64,
    palette: state.palette, cycle: state.cycle, offset: state.offset, samples: 1
  };
  dispatch({
    payload, thumb: true,
    onDone: (msg) => {
      if (msg.viewId !== 'formula') return;
      const c2 = $('formula-preview');
      if (!c2) return;
      c2.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h), 0, 0);
    }
  });
}

function loadFormulas() {
  try { return JSON.parse(localStorage.getItem('mb.formulas') || '[]'); } catch { return []; }
}
function saveFormulas(list) { localStorage.setItem('mb.formulas', JSON.stringify(list)); }

/* ---------------- About ---------------- */
function openAbout() {
  const body = `
    <div class="about-body">${t('aboutBody')}</div>
    <div class="about-stats">
      <div><b>${LIB.count}</b><span>${t('statPresets')}</span></div>
      <div><b>7</b><span>${t('statSets')}</span></div>
      <div><b>10⁻³⁰⁰</b><span>${t('statDepth')}</span></div>
      <div><b>${wasmEnabled ? 'WASM' : 'JS'}</b><span>${t('engine')}</span></div>
    </div>
    <div style="margin-top:18px;font-size:11px;letter-spacing:.14em;color:var(--text-3);text-transform:uppercase">${t('shortcuts')}</div>
    <div class="shortcut-grid">
      <kbd>Drag</kbd><span>${t('scPan')}</span>
      <kbd>Wheel</kbd><span>${t('scZoom')}</span>
      <kbd>2×</kbd><span>${t('scDbl')}</span>
      <kbd>↑ ↓ ← →</kbd><span>${t('scKeysPan')}</span>
      <kbd>Z / X</kbd><span>${t('scKeysZoom')}</span>
      <kbd>A · C</kbd><span>${t('scKeysAa')}</span>
      <kbd>R</kbd><span>${t('scReset')}</span>
      <kbd>P</kbd><span>${t('scPanel')}</span>
      <kbd>F</kbd><span>${t('scFull')}</span>
      <kbd>S</kbd><span>${t('scShot')}</span>
      <kbd>+ / −</kbd><span>${t('scIter')}</span>
    </div>
    <div style="margin-top:18px;font-size:11px;letter-spacing:.14em;color:var(--text-3);text-transform:uppercase">${t('aboutTech')}</div>
    <div class="legend" style="margin-top:6px">${t('aboutTechBody')}</div>`;
  openModal('about', t('aboutTitle'), '', body, '', 'narrow');
}


/* ---------------- Minimal LaTeX typesetting ---------------- */
const LATEX_SYMBOL = {
  pi: 'π', tau: 'τ', phi: 'φ', infty: '∞', cdot: '·', times: '×',
  ln: 'ln', sin: 'sin', cos: 'cos', tan: 'tan', sinh: 'sinh', cosh: 'cosh',
  tanh: 'tanh', arg: 'arg', sum: '∑', prod: '∏'
};

function latexToHtml(tex) {
  const s = String(tex || '');
  let i = 0;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function skip() { while (i < s.length && s[i] === ' ') i++; }

  function group() {
    skip();
    if (s[i] === '{') {
      i++;
      return seq();
    }
    if (s[i] === '\\') {
      const save = i;
      i++;
      let name = '';
      while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
      if (name) return `<span class="op">${esc(LATEX_SYMBOL[name] || name)}</span>`;
      i = save;
      return esc(s[i++] || '');
    }
    const ch = s[i++] || '';
    if (/[a-zA-Z]/.test(ch)) return `<i>${esc(ch)}</i>`;
    return esc(ch);
  }

  function seq() {
    let out = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === '}') { i++; break; }
      if (ch === ' ') { i++; continue; }
      if (ch === '\\') {
        i++;
        let name = '';
        while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
        if (!name) { out += esc(s[i++] || ''); continue; }
        switch (name) {
          case 'frac': {
            const n = group(), d = group();
            out += `<span class="frac"><span class="num">${n}</span><span class="den">${d}</span></span>`;
            break;
          }
          case 'sqrt': {
            const a = group();
            out += `<span class="sqrt"><span class="radical">√</span><span class="radicand">${a}</span></span>`;
            break;
          }
          case 'left': case 'right': {
            const d = s[i++] || '.';
            if (d !== '.') out += esc(d);
            break;
          }
          case 'overline': out += `<span class="ovl">${group()}</span>`; break;
          case 'operatorname': out += `<span class="op">${group()}</span>`; break;
          case 'sum': case 'prod': {
            const sym = name === 'sum' ? '∑' : '∏';
            let sub = '', sup = '';
            for (;;) {
              skip();
              if (s[i] === '_') { i++; sub = group(); }
              else if (s[i] === '^') { i++; sup = group(); }
              else break;
            }
            out += `<span class="bigop"><span class="op-sym">${sym}</span>`
              + `<span class="op-lim"><span>${sup}</span><span>${sub}</span></span></span>`;
            break;
          }
          case 'begin': {
            const env = group();
            if (env.indexOf('cases') >= 0) {
              const endIdx = s.indexOf('\\end', i);
              const body = s.slice(i, endIdx < 0 ? s.length : endIdx);
              i = endIdx < 0 ? s.length : endIdx;
              const rows = body.split('&').map(x => x.trim()).filter(Boolean);
              out += `<span class="cases">{</span><span class="cases-body">`
                + rows.map(r => `<span>${esc(r)}</span>`).join('') + '</span>';
            }
            break;
          }
          case 'end': group(); break;
          case 'lfloor': out += '⌊'; break;
          case 'rfloor': out += '⌋'; break;
          case 'lceil': out += '⌈'; break;
          case 'rceil': out += '⌉'; break;
          default: out += `<span class="op">${esc(LATEX_SYMBOL[name] || name)}</span>`;
        }
        continue;
      }
      if (ch === '^' || ch === '_') {
        i++;
        const g = group();
        out += ch === '^' ? `<sup>${g}</sup>` : `<sub>${g}</sub>`;
        continue;
      }
      if (ch === '{' || ch === '}') { i++; continue; }
      if (/[a-zA-Z]/.test(ch)) {
        let w = ch; i++;
        while (i < s.length && /[a-zA-Z]/.test(s[i])) w += s[i++];
        out += `<i>${esc(w)}</i>`;
        continue;
      }
      out += esc(ch);
      i++;
    }
    return out;
  }

  try { return seq() || '&nbsp;'; } catch { return '&nbsp;'; }
}

/* ---------------- Toasts ---------------- */
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------------- Top bar / panel events ---------------- */
function bindUi() {
  // Set menu
  const setsBtn = $('btn-sets'), setsMenu = $('menu-sets');
  setsBtn.onclick = (e) => {
    e.stopPropagation();
    closeMenus(setsMenu);
    setsMenu.hidden = !setsMenu.hidden;
    setsBtn.classList.toggle('open', !setsMenu.hidden);
  };
  setsMenu.querySelectorAll('button').forEach(b => {
    b.onclick = () => { applyMode(b.dataset.mode); setsMenu.hidden = true; setsBtn.classList.remove('open'); };
  });

  const setBtn = $('btn-settings'), setMenu = $('menu-settings');
  setBtn.onclick = (e) => {
    e.stopPropagation();
    closeMenus(setMenu);
    setMenu.hidden = !setMenu.hidden;
    setBtn.classList.toggle('open', !setMenu.hidden);
  };

  // Clicks inside a menu must not close the dropdown
  ['menu-sets', 'menu-settings'].forEach(id => {
    $(id).addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('click', () => { closeMenus(); });

  $('btn-presets').onclick = openPresets;
  /* Same editor as the side-panel entry — one code path, one state. */
  const topFormula = $('btn-formula-top');
  if (topFormula) topFormula.onclick = () => openFormula();
  /* Import and export live in the presets panel now: a preset file is a
   * preset, and the keyboard shortcuts still reach the same two functions. */

  /* The badge is the embedded library's live count (built-ins plus "mine"),
   * never a number baked into the page. */
  onLibrary((lib) => {
    /* One line of proof that the names survived the trip: they are UTF-8 in the
     * file, UTF-16 across the WebView boundary, and JSON on arrival. */
    const f0 = lib.items && lib.items[0];
    nativeLog(`[ui] preset lib ${lib.count} dir=${lib.dir || '-'} ` +
              `first=${f0 ? (f0.nz || f0.n) + ' / ' + f0.n : '-'}`);
    const badge = document.querySelector('#btn-presets .badge');
    if (badge) {
      const n = lib.count || 0;
      badge.textContent = n ? String(n) : '';
      badge.hidden = !n;
    }
    /* A panel that is already open gets rebuilt so a save or a delete shows up
     * without being asked for. */
    if (modalKind === 'presets') openPresets();
  });
  $('btn-about').onclick = () => { closeMenus(); openAbout(); };
  $('btn-fullscreen').onclick = toggleFullscreen;

  // Language / theme
  $('seg-lang').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.lang = b.dataset.lang;
      setLang(state.lang);
      $('seg-lang').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      applyI18n(); fillSelects(); syncPaletteStrip();
    };
  });
  $('seg-theme').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.theme = b.dataset.theme;
      document.documentElement.dataset.theme = state.theme;
      $('seg-theme').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    };
  });

  $('sel-scale').onchange = (e) => {
    state.renderScale = Math.max(1, Math.min(2, +e.target.value || 2));
    try { localStorage.setItem('mb.scale', String(state.renderScale)); } catch { /* private mode */ }
    resizeCanvas();
  };

  /* View angle.  The kernel rotates the plane under the screen, so this is a
   * rigid turn of the picture, not a change of the centre.  Dragging still
   * follows the mouse because planeDelta() applies the same angle to the pan. */
  const rotRange = $('rng-rot'), rotNum = $('in-rot');
  if (rotRange) {
    rotRange.oninput = (e) => { setRotationDeg(+e.target.value, false); scheduleRender(120); };
    rotRange.onchange = () => renderNow();
  }
  if (rotNum) rotNum.onchange = (e) => setRotationDeg(+e.target.value, true);
  const rotZero = $('btn-rot-zero'), rotQuarter = $('btn-rot-quarter');
  if (rotZero) rotZero.onclick = () => setRotationDeg(0, true);
  if (rotQuarter) rotQuarter.onclick = () => {
    let d = Math.round((state.rotation || 0) * 180 / Math.PI) + 90;
    if (d > 180) d -= 360;
    setRotationDeg(d, true);
  };
  syncRotationUi();

  // Segmented control
  $('seg-mode').querySelectorAll('button').forEach(b => {
    b.onclick = () => applyMode(b.dataset.mode);
  });

  const selFamily = $('sel-family'), numPower = $('num-power');
  if (selFamily) selFamily.onchange = () => {
    setFamily(selFamily.value, selFamily.value === 'multibrot'
      ? (+($('num-power').value) || 3) : 2);
  };
  if (numPower) numPower.onchange = () => setFamily('multibrot', +numPower.value);
  const btnFormula = $('btn-formula-editor');
  if (btnFormula) btnFormula.onclick = () => openFormula();

  $('in-jr').oninput = (e) => { state.spec.julia.re = e.target.value.trim() || '0'; };
  $('in-ji').oninput = (e) => { state.spec.julia.im = e.target.value.trim() || '0'; };
  $('in-jr').onchange = () => renderNow();
  $('in-ji').onchange = () => renderNow();

  $('chk-autoiter').onchange = (e) => {
    state.autoIter = e.target.checked;
    if (state.autoIter) syncIterUi();
    renderNow();
  };
  $('rng-iter').oninput = (e) => {
    state.autoIter = false;
    $('chk-autoiter').checked = false;
    state.maxIter = +e.target.value;
    $('in-iter').value = state.maxIter;
  };
  $('rng-iter').onchange = () => renderNow();
  $('in-iter').onchange = (e) => {
    state.autoIter = false;
    state.presetId = null;          // manual budget wins over the preset floor
    $('chk-autoiter').checked = false;
    state.maxIter = clamp(+e.target.value || 600, 100, 200000);
    $('rng-iter').value = state.maxIter;
    renderNow();
  };

  $('sel-bits').onchange = (e) => { state.bits = e.target.value; renderNow(); };
  $('sel-palette').onchange = (e) => {
    const id = e.target.value;
    state.stops = null;            // a different recipe means its own colours
    if (String(id).startsWith('glsl:')) {
      installScheme(id);           // official codegl + its own param sliders
    } else {
      state.palette = id;
      /* An additive scheme's frequencies are in radians/iteration, so its
       * LUT spans exactly one slowest-term period.  Align the colour cycle
       * with that period instead of leaving the ramp's default 140, which
       * would compress the phase and stripe deep views. */
      const cyc = paletteCycle(id);
      if (cyc > 0) { state.cycle = cyc; state.cycleAuto = false; }
      installScheme(null);
      gradSel = 0;
      syncPaletteStrip();
    }
    syncSchemeParams();
    syncColorUi();               // dim the band-only rows when a scheme is on
    recolourOnly();
  };
  $('sel-scheme').onchange = (e) => { state.scheme = e.target.value; renderNow(); };
  const selShade = $('sel-shade');
  if (selShade) selShade.onchange = (e) => { state.shade = parseInt(e.target.value, 10) || 0; renderNow(); };
  /* A trap changes the *field* (the kernel has to accumulate it), so this is a
   * full re-render, not a re-shade. */
  const selTrap = $('sel-trap');
  if (selTrap) {
    selTrap.value = String(state.traps | 0);
    selTrap.onchange = (e) => {
      state.traps = Math.max(0, Math.min(4, parseInt(e.target.value, 10) || 0));
      syncTrapUi();
      renderNow();          // a trap changes the field, so this one is a render
    };
  }
  for (const [id, vid, key] of [['rng-trapgain', 'val-trapgain', 'trapGain'],
                                ['rng-traprings', 'val-traprings', 'trapRings']]) {
    const el = $(id);
    if (!el) continue;
    el.oninput = (e) => {
      state[key] = +e.target.value;
      $(vid).textContent = (+e.target.value).toFixed(2);
      /* Shader-only change: repaint, never re-iterate. */
      if (!reshadeOnly()) scheduleRender(140);
    };
  }
  const paletteEdit = $('btn-palette-edit');
  if (paletteEdit) {
    paletteEdit.title = t('paletteTitle');
    paletteEdit.onclick = () => openPaletteEditor();
  }
  const rank = $('rng-iterrank');
  const rankNum = $('in-iterrank');
  const applyRank = (v) => {
    state.autoRank = clamp(Math.round(v) || 100, 1, 100);
    if (rank) rank.value = String(state.autoRank);
    if (rankNum && document.activeElement !== rankNum) rankNum.value = String(state.autoRank);
    scheduleRender(120);
  };
  if (rank) {
    rank.oninput = (e) => applyRank(+e.target.value);
    rank.onchange = () => renderNow();
  }
  if (rankNum) {
    rankNum.onchange = (e) => applyRank(+e.target.value);
  }
  if (rank) rank.value = String(state.autoRank);
  if (rankNum) rankNum.value = String(state.autoRank);
  bindGradientEditor();

  /* The band-density / detail / cycle-span sliders are gone.  The reference
   * has none of them: spacing comes from each scheme's own frequency, detail
   * from SAMPLES in the shader, and a frame-fitted cycle re-phases the whole
   * picture on every zoom.  Official params.param[] sliders (generated by
   * syncSchemeParams) are the only colour controls beyond the tone stage. */
  const offsetEl = $('rng-offset');
  offsetEl.oninput = (e) => {
    state.offset = +e.target.value;
    $('val-offset').textContent = state.offset.toFixed(2);
  };
  offsetEl.onchange = () => renderNow();

  /* Tone stage: every slider writes state.tone and repaints after a short
   * quiet period, so dragging shows the effect continuously. */
  const toneMap = [
    ['rng-bri', 'val-bri', 'bri'],
    ['rng-gr', 'val-gr', 'gr'], ['rng-gg', 'val-gg', 'gg'], ['rng-gb', 'val-gb', 'gb']
  ];
  for (const [id, vid, key] of toneMap) {
    const el = $(id);
    if (!el) continue;
    el.oninput = (e) => {
      state.tone[key] = +e.target.value;
      $(vid).textContent = (+e.target.value).toFixed(2);
    };
    el.onchange = () => renderNow();
  }
  const toneReset = $('btn-tone-reset');
  if (toneReset) {
    toneReset.onclick = () => {
      state.tone = { bri: 1, gr: 1, gg: 1, gb: 1 };
      for (const [id, vid, key] of toneMap) {
        if ($(id)) $(id).value = state.tone[key];
        if ($(vid)) $(vid).textContent = state.tone[key].toFixed(2);
      }
      renderNow();
    };
  }

  $('btn-reset').onclick = () => applyMode(state.spec.mode);

  /* Supersampling selector, applied to the final pass only:
   *   1 = off (the reference's default)
   *   2 = "High res": 2x2 = 4 values per pixel, then downsampled — exactly the
   *       option winapp.html documents
   *   3 = 3x3 = 9 values (our sharper default; kept so the port never regresses) */
  const selAA = $('sel-aa');
  if (selAA) {
    selAA.value = String(state.aa);
    selAA.onchange = () => setAA(+selAA.value);
  }

  $('btn-fit').onclick = () => {
    state.span = state.spec.mode === 'j' ? { m: 1.6, e: 1 } : { m: 1.6, e: 1 };
    state.center = state.spec.mode === 'm' ? { re: '-0.6', im: '0' } : { re: '0', im: '0' };
    if (state.autoIter) syncIterUi();
    renderNow();
  };
  $('btn-link').onclick = () => {
    const s = encodeState();
    location.hash = s;
    navigator.clipboard?.writeText(location.href).then(() => toast(t('copied'))).catch(() => toast(t('copied')));
  };
  $('btn-png').onclick = () => exportPng();

  // Panel dragging (desktop only; on mobile the bottom drawer takes over)
  const panel = $('panel');
  const head = $('panel-drag');
  let pd = null;
  head.addEventListener('pointerdown', (e) => {
    if (isMobileShell()) return;
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    pd = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!pd) return;
    panel.style.right = 'auto';
    panel.style.left = clamp(e.clientX - pd.dx, 8, innerWidth - 80) + 'px';
    panel.style.top = clamp(e.clientY - pd.dy, 58, innerHeight - 80) + 'px';
  });
  head.addEventListener('pointerup', () => { pd = null; });

  // Minimise -> fold into the top-bar console button
  $('btn-panel-collapse').onclick = () => setPanelOpen(false);
  $('btn-console').onclick = () => togglePanel();
  // The desktop build ships a self-contained native core (see its src folder);
  // the "download core" entry only makes sense for the web page.
  if (NATIVE) {
    const coreBtn = $('btn-core');
    if (coreBtn) coreBtn.remove();
  } else $('btn-core').onclick = () => {
    closeMenus();
    openCorePanel({
      t,
      openModal,
      toast,
      reprobe: async () => {
        resetRemote();
        const ok = await probeRemote();
        updateEngineLabel();
        return ok;
      }
    });
  };

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') {
      const modalOpen = !$('modal-root').hidden;
      const menuOpen = !$('menu-sets').hidden || !$('menu-settings').hidden;
      closeModal(); closeMenus();
      /* Esc is also the way out of a deep pass that will take minutes; the
       * HUD advertises it while `slowDeep` is shown. */
      if (!modalOpen && !menuOpen && passTick) {
        cancelAll();
        stopPassClock();
        updateHud(true);
      }
      return;
    }
    const k = e.key;
    /* --- keyboard navigation: arrows pan by 1/8 view, z/x (or PgUp/PgDn) zoom --- */
    const step = Math.max(8, Math.round(Math.min(canvas.width, canvas.height) / 8));
    /* Preset files: the reference program's own JSON.  Ctrl+O / Ctrl+S are the
     * pair every editor uses, and they have to be handled before the plain-key
     * block below swallows the modifier. */
    if ((e.ctrlKey || e.metaKey) && (k === 'o' || k === 'O')) {
      e.preventDefault(); importPresetFile(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) {
      e.preventDefault(); exportPresetFile(); return;
    }
    /* Ctrl+Shift+D: capture the exact view.
     *
     * "It breaks at 1e30" cannot be reproduced from a description -- the
     * centre is a 30-digit string, the span is a mantissa/exponent pair, and
     * the pass metadata carries the engine, width and escape spread that the
     * report is about.  This writes all of it to the clipboard and to the
     * shell log, so the failing frame can be replayed verbatim instead of
     * guessed at. */
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'd' || k === 'D')) {
      e.preventDefault();
      let dump = null;
      try {
        dump = {
          center: { re: state.center.re, im: state.center.im },
          span: { m: state.span.m, e: state.span.e },
          maxIter: state.maxIter,
          rotation: state.rotation || 0,
          bits: state.bits,
          spec: state.spec,
          viewport: __mb.viewport(),
          meta: __mb.meta()
        };
      } catch (err) {
        dump = { error: String(err && err.message ? err.message : err) };
      }
      const s = JSON.stringify(dump);
      try { navigator.clipboard.writeText(s); } catch (_) {}
      try { nativeLog('VIEWDUMP ' + s); } catch (_) {}
      toast('View copied to clipboard + shell.log');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowLeft') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, -step, 0); return; }
    if (k === 'ArrowRight') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, step, 0); return; }
    if (k === 'ArrowUp') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, 0, -step); return; }
    if (k === 'ArrowDown') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, 0, step); return; }
    if (k === 'z' || k === 'Z' || k === 'PageUp') { e.preventDefault(); zoomAt(canvas.width / 2, canvas.height / 2, 0.5, true); return; }
    if (k === 'x' || k === 'X' || k === 'PageDown') { e.preventDefault(); zoomAt(canvas.width / 2, canvas.height / 2, 2, true); return; }
    if (k === 'Home' || k === '0') { e.preventDefault(); applyMode(state.spec.mode); return; }
    /* --- the reference program's numeric keypad (winapp.html) --------------
     * 2/4/6/8 pan, 1/3 zoom out/in, 7/9 rotate, 5 stop.  Numpad keys report the
     * same `e.key` as the top row, so both work.  Only "0" was already taken
     * (home view), so nothing above is overridden. */
    if (k === '2') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, 0, step); return; }
    if (k === '8') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, 0, -step); return; }
    if (k === '4') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, -step, 0); return; }
    if (k === '6') { e.preventDefault(); commitPan({ re: state.center.re, im: state.center.im }, step, 0); return; }
    if (k === '3') { e.preventDefault(); zoomAt(canvas.width / 2, canvas.height / 2, 0.5, true); return; }
    if (k === '1') { e.preventDefault(); zoomAt(canvas.width / 2, canvas.height / 2, 2, true); return; }
    if (k === '7') { e.preventDefault(); setRotationDeg((state.rotation || 0) * 180 / Math.PI - 15, true); return; }
    if (k === '9') { e.preventDefault(); setRotationDeg((state.rotation || 0) * 180 / Math.PI + 15, true); return; }
    if (k === '5') {
      e.preventDefault();
      cancelAll(); stopPassClock(); updateHud(true);
      return;
    }
    /* F1 opens the Julia set of the current centre; pressed again it goes back.
     * The reference's F1 shows/hides a second *window*; we have that preview
     * dock permanently, so the key is mapped to the full view instead. */
    if (k === 'F1') {
      e.preventDefault();
      if (state.spec.mode === 'j') backFromJulia();
      else openJuliaSet({ re: state.center.re, im: state.center.im });
      return;
    }
    /* F3–F7: the reference's shading-mode keys.  Our kernel has four band
     * density policies (0..3), so F7 repeats the densest one. */
    if (k === 'F3' || k === 'F4' || k === 'F5' || k === 'F6' || k === 'F7') {
      e.preventDefault();
      state.shade = clamp(+k.slice(1) - 3, 0, 3);
      const sel = $('sel-shade');
      if (sel) sel.value = String(state.shade);
      renderNow();
      return;
    }
    /* T: trajectory trace is not ported yet (linewidth/pointsize/ntrace are read
     * from mandelbrot.json but unused).  Say so instead of binding a key to
     * something that looks similar but is not. */
    if (k === 't' || k === 'T') {
      toast(getLang() === 'en' ? 'Trace mode is not ported yet' : '轨迹模式尚未移植');
      return;
    }
    if (k === 'c' || k === 'C') {
      const ids = PALETTE_LIST.map(p => p.id);
      const i = (ids.indexOf(state.palette) + 1) % ids.length;
      state.palette = ids[i];
      $('sel-palette').value = state.schemeId || state.palette;
      syncPaletteStrip(); renderNow(); return;
    }
    if (k === 'a' || k === 'A') { setAA(state.aa === 1 ? 2 : state.aa === 2 ? 3 : 1); return; }
    if (k === 'r' || k === 'R') applyMode(state.spec.mode);
    if (k === 'p' || k === 'P') togglePanel();
    if (k === 'f' || k === 'F' || k === 'F11') toggleFullscreen();
    if (k === 's' || k === 'S') exportPng();
    if (e.key === '+' || e.key === '=') {
      state.autoIter = false; $('chk-autoiter').checked = false;
      state.maxIter = clamp(state.maxIter * 1.5 | 0, 100, 200000);
      $('in-iter').value = state.maxIter; $('rng-iter').value = state.maxIter; renderNow();
    }
    if (e.key === '-' || e.key === '_') {
      state.autoIter = false; $('chk-autoiter').checked = false;
      state.maxIter = clamp(state.maxIter / 1.5 | 0, 100, 200000);
      $('in-iter').value = state.maxIter; $('rng-iter').value = state.maxIter; renderNow();
    }
  });
}

function closeMenus(except) {
  ['menu-sets', 'menu-settings'].forEach(id => {
    const el = $(id);
    if (el !== except) {
      el.hidden = true;
      $(id === 'menu-sets' ? 'btn-sets' : 'btn-settings').classList.remove('open');
    }
  });
  if (except === $('menu-sets')) $('btn-sets').classList.add('open');
}

/* ---------------- Console open / close ---------------- */
/**
 * Single source of truth for console visibility.  The panel, the top-bar
 * toggle (which also serves as the "minimized" target) and the keyboard
 * shortcut all route through here so their states can never drift apart.
 */
function setPanelOpen(open, persist = true) {
  document.body.classList.toggle('panel-closed', !open);
  document.body.classList.toggle('panel-open', open && isMobileShell());
  const btn = $('btn-console');
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.title = (open ? t('consoleHide') : t('consoleShow')) + ' · P';
  }
  if (persist) {
    try { localStorage.setItem('mb.panel', open ? '1' : '0'); } catch { /* private mode */ }
  }
}

function togglePanel() {
  setPanelOpen(document.body.classList.contains('panel-closed'));
}

/* Fullscreen.  WebView2 does not implement the DOM Fullscreen API, so inside
 * the desktop shell the request goes to the host, which drops the window frame
 * and covers the monitor.  In a browser the standard API is used instead. */
const shellBridge = (typeof window !== 'undefined' && window.chrome && window.chrome.webview) || null;
/* Copy a link that carries the FULL view state — the HUD shows a truncated
 * centre, so a screenshot cannot be replayed at the same depth.  This is how
 * a rendering dispute is settled: the link opens the exact high-precision
 * viewpoint on any machine (and the desktop core renders the same point for
 * a pixel-level comparison). */
function copyViewLink() {
  const url = location.origin + location.pathname + '#' + encodeState();
  const done = () => {
    const n = document.getElementById('cfg-note');
    if (n) { n.textContent = t('copyViewDone'); n.hidden = false;
             setTimeout(() => { n.hidden = true; }, 2500); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => { window.prompt(t('copyViewPrompt'), url); });
  } else {
    window.prompt(t('copyViewPrompt'), url);
  }
}
$('btn-copyview').onclick = () => { closeMenus(); copyViewLink(); };

function toggleFullscreen() {
  closeMenus();
  if (shellBridge && shellBridge.postMessage) {
    try { shellBridge.postMessage(JSON.stringify({ type: 'cmd', cmd: 'fullscreen' })); } catch { /* shell gone */ }
    return;
  }
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

function exportPng() {
  if (nativeCanvasMode()) {
    // Pixels never come back to JS in route 1; the shell keeps the last final
    // pass and writes a PNG through the system Save As dialog.
    nativeCanvasExport();
    return;
  }
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mandelbrot-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

/* ---------------- State serialisation ---------------- */
function encodeState() {
  const payload = {
    s: state.spec, c: state.center, sp: state.span, i: state.maxIter,
    a: state.autoIter, b: state.bits, p: state.palette, cy: state.cycle, o: state.offset,
    /* r = view angle in radians, so a shared link keeps the rotation too. */
    r: state.rotation,
    sh: state.scheme,
    /* Colour set: band density, period, tone stage and the edited ramp.  A
     * link that dropped these would open with somebody else's colours. */
    bd: state.bands, ca: state.cycleAuto,
    /* Only the four live tone keys travel.  An older link that still carries
     * con/gam/sat/hue is read as if those keys were absent (see decodeState). */
    tn: { bri: state.tone.bri, gr: state.tone.gr,
          gg: state.tone.gg, gb: state.tone.gb },
    st: state.stops,
    /* An official GLSL recipe: the library id is enough for embedded schemes
     * (the source can be looked up), while an imported one has to carry its
     * own codegl.  Either way the slider values travel with it. */
    si: state.schemeId, sm: state.schemeMeta, spm: state.schemeParams,
    sc: state.schemeColors, sb: state.schemeBri,
    gl: state.schemeId ? null : state.glsl
  };
  return 'st=' + btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function decodeState() {
  const h = location.hash.replace(/^#/, '');
  if (!h.startsWith('st=')) return false;
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(h.slice(3)))));
    Object.assign(state, {
      spec: o.s, center: o.c, span: o.sp, maxIter: o.i,
      autoIter: o.a, bits: o.b, palette: o.p, cycle: o.cy, offset: o.o,
      rotation: Number.isFinite(+o.r) ? +o.r : 0,
      scheme: o.sh === 'bands' ? 'bands' : 'distance',
      bands: o.bd != null ? o.bd : state.bands,
      cycleAuto: o.ca !== false,
      /* Only the four live keys are read.  A link saved before the console lost
       * contrast/gamma/saturation/hue still carries those keys; they are
       * dropped here, so the state never grows fields no control owns. */
      tone: {
        bri: Number.isFinite(+(o.tn && o.tn.bri)) ? +o.tn.bri : 1,
        gr: Number.isFinite(+(o.tn && o.tn.gr)) ? +o.tn.gr : 1,
        gg: Number.isFinite(+(o.tn && o.tn.gg)) ? +o.tn.gg : 1,
        gb: Number.isFinite(+(o.tn && o.tn.gb)) ? +o.tn.gb : 1
      },
      stops: Array.isArray(o.st) && o.st.length >= 2 ? o.st : null,
      schemeMeta: o.sm || null,
      schemeParams: Array.isArray(o.spm) ? o.spm : [],
      schemeColors: Array.isArray(o.sc) ? o.sc : [],
      schemeBri: o.sb || { finite: 1, infinite: 1, factor: 1 },
      glsl: o.gl || null
    });
    if (o.si) {
      const s = findSchemeAny(o.si);
      if (s) {
        state.schemeId = s.id;
        state.glsl = s.glsl;
        state.schemeMeta = { nparam: s.nparam, paramLabels: s.paramLabels,
                             samples: s.samples };
        state.schemeColors = s.colors.map(c => ({
          r: c[0], g: c[1], b: c[2], frequency: c[3], initial: c[4]
        }));
        state.schemeBri = { finite: s.briFinite, infinite: s.briInfinite,
                            factor: s.briFactor };
      }
    } else {
      state.schemeId = null;
    }
    if (!state.schemeParams.length && state.schemeMeta)
      state.schemeParams = [0.33, 0.3];
    return true;
  } catch { return false; }
}

/* ---------------- i18n application ---------------- */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.dataset.i18n;
    el.textContent = t(k);
  });
  document.title = 'MANDELBROT · ' + t('appSub');
  fillSelects();
  syncSchemeParams();          // slider labels follow the language switch
  if (juliaView) juliaView.syncUi();
  updateHud();
  setPanelOpen(!document.body.classList.contains('panel-closed'), false);
  if (modalKind === 'presets') openPresets();
}

/* ---------------- Canvas sizing ---------------- */
/* A deep frame runs 7 000-20 000 iterations per pixel, so the buffer size is
 * the difference between one second and three.  The cap flips at 2^-30 of
 * pixel scale, where the structure is already far wider than the screen. */
let deepPixelCap = false;

function applyDeepPixelCap() {
  const deep = psPair().e < -30;
  if (deep === deepPixelCap) return;
  deepPixelCap = deep;
  resizeCanvas(false);
}

function resizeCanvas(render = true) {
  /* A pass in flight is measured in the *old* buffer geometry.  Resizing the
   * canvas without cancelling it leaves tiles that were dispatched at the old
   * width to be composited into a buffer of a different width; the ratio no
   * longer matches and the result is a frame of misplaced blocks and holes.
   * Dropping the pass costs one re-render, which the resize schedules anyway. */
  let dpr = Math.max(1, Math.min(TOUCH_UI ? 1.5 : 2, +state.renderScale || 1));
  /* Pixel budget.  "2x" on a 1080p window is an 11 Mpx buffer, and every one
   * of those pixels is iterated on the CPU path and shaded on the GPU path —
   * four times the work of 1x for a difference the eye cannot see at arm's
   * length.  The cap keeps a high setting honest on a large display instead of
   * letting it turn every gesture into a slideshow.
   *
   * A deep frame is a different animal: 7 000-20 000 iterations per pixel
   * turns 4.2 Mpx into seconds of CPU time, while the structure itself is
   * kilometres wide on screen.  Halving the buffer there costs nothing visible
   * and halves the wait. */
  const MAX_PIXELS = deepPixelCap ? 2.2e6 : (TOUCH_UI ? 1.6e6 : 4.2e6);
  while (dpr > 1 && innerWidth * dpr * innerHeight * dpr > MAX_PIXELS) dpr -= 0.25;
  dpr = Math.max(1, dpr);
  const nextW = Math.max(320, Math.round(innerWidth * dpr));
  const nextH = Math.max(240, Math.round(innerHeight * dpr));
  if ((canvas.width !== nextW || canvas.height !== nextH) &&
      !nativeCanvasMode() && (pending > 0 || liveBusy)) {
    cancelAll();
  }
  canvas.width = nextW;
  canvas.height = nextH;
  /* The shader's backing store is only sized inside sceneDraw(), so a view the
   * shader declines leaves it at the *previous* window's dimensions.  CSS then
   * stretches that stale frame over the new viewport — a second source of
   * misplaced blocks.  Keep both layers in lockstep; resizing a WebGL canvas
   * clears its drawing buffer, so the 2D layer has to become visible. */
  if (glCanvas.width !== nextW || glCanvas.height !== nextH) {
    glCanvas.width = nextW;
    glCanvas.height = nextH;
    setGlSurface(false);
  }
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // One line in shell.log per resize: the only way to see the real viewport,
  // DPI and buffer size without a debugger attached to WebView2.
  try {
    window.chrome?.webview?.postMessage(JSON.stringify({
      type: 'log',
      msg: `viewport css=${innerWidth}x${innerHeight} dpr=${(window.devicePixelRatio || 1).toFixed(2)} ` +
           `buffer=${canvas.width}x${canvas.height} scale=${state.renderScale}`
    }));
  } catch { /* browser build */ }
  if (render) renderNow();
}

/* Window resizing is part of the view, not a decoration: the span is a width,
 * so a wider/taller window simply reveals more of the plane and the frame is
 * rendered again at that shape.  The old bitmap is stretched into the new
 * rectangle immediately (one blit) so the window never shows empty bands while
 * the first pass is still running. */
let resizeTimer = 0;
function onWindowResize() {
  const native = nativeCanvasMode();
  const had = snap.width > 0;
  resizeCanvas(false);
  if (native) {
    // Route 1 contract: a resize only changes the picture frame.  The shell
    // resizes its swapchain and stretches the displayed pass; the plane is
    // not recomputed until the next interaction asks for a new view.
    return;
  }
  if (had) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(snap, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderNow(), 150);
}
/* The shell tells us when its own GL canvas has something on screen; from then
 * on the page is chrome only. */
window.addEventListener('mbNativeCommit', () => {
  /* The shell just put a pass on screen.  In visual hosting this makes the page
   * transparent over the native canvas; the gate inside setNativeSurface()
   * decides whether that is allowed for the path in use. */
  setNativeSurface(true);
});
window.addEventListener('resize', onWindowResize);
window.addEventListener('orientationchange', onWindowResize);

/* ---------------- Boot splash ---------------- */
const splash = {
  p: 0,
  startAt: 0,
  finished: false,
  el: null,
  fill: null,
  status: null,
  pct: null,
  init() {
    this.el = $('boot');
    this.fill = $('boot-fill');
    this.status = $('boot-status');
    this.pct = $('boot-pct');
    this.startAt = performance.now();
    this.set(0.04, 'bootInit');
  },
  set(p, key) {
    if (this.finished) return;
    if (p > this.p) this.p = Math.min(0.995, p);
    if (this.fill) this.fill.style.width = (this.p * 100).toFixed(1) + '%';
    if (this.pct) this.pct.textContent = Math.round(this.p * 100) + '%';
    if (key && this.status) this.status.textContent = t(key);
  },
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.p = 1;
    if (this.fill) this.fill.style.width = '100%';
    if (this.pct) this.pct.textContent = '100%';
    if (this.status) this.status.textContent = t('bootReady');
    const wait = Math.max(0, 820 - (performance.now() - this.startAt));
    setTimeout(() => {
      const el = this.el;
      if (el) el.classList.add('hide');
      document.body.classList.remove('booting');
      setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, 700);
    }, wait);
  }
};

/* ---------------- Boot ---------------- */
function boot() {
  // Tell the inline bootstrap guard that the module graph loaded fine.
  window.__mbModuleLoaded = true;
  if (window.__mbBootWatch) clearTimeout(window.__mbBootWatch);

  splash.init();
  hydrateUserPalettes();
  /* The colour-scheme library is read before anything can install a scheme. */
  schemeStoreLoad();
  decodeState();
  setLang(state.lang);
  document.documentElement.dataset.theme = state.theme;
  fillSelects();
  syncModeUi();
  syncPaletteStrip();
  syncIterUi();
  applyI18n();
  bindUi();
  initGlassSelects();
  /* The shell may have answered `hello` before the listener above existed. */
  applyConfig(nativeConfig());

  // Panel starts open on desktop, folded into the top-bar button on phones.
  let panelPref = null;
  try { panelPref = localStorage.getItem('mb.panel'); } catch { /* ignore */ }
  /* A launch flag (?panel=1) wins over the stored preference: the shell uses it
   * to open the console for screenshots and regression runs. */
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('panel')) panelPref = q.get('panel');
  } catch { /* ignore */ }
  setPanelOpen(panelPref === null ? !isMobileShell() : panelPref === '1', false);
  panelQuery.addEventListener('change', () => {
    document.body.classList.toggle('panel-open',
      !document.body.classList.contains('panel-closed') && isMobileShell());
  });

  $('in-jr').value = state.spec.julia.re;
  $('in-ji').value = state.spec.julia.im;
  $('sel-palette').value = state.schemeId || state.palette;
  $('sel-scheme').value = state.scheme;
  syncColorUi();
  $('chk-autoiter').checked = state.autoIter;
  $('sel-bits').value = state.bits;
  splash.set(0.16, 'bootKernel');

  // Safety net: whatever happens, enter the main UI after 8 seconds
  setTimeout(() => { if (!splash.finished) splash.finish(); }, 8000);

  probeRemote().then((ok) => {
    updateEngineLabel();
    splash.set(ok ? 0.44 : 0.4, 'bootCore');
    if (ok) updateHud();
  });
  initWorkers();
  /* Resolution must be restored before the first canvas sizing, otherwise the
   * saved choice would only take effect on the next view change. */
  try {
    const sc = parseFloat(localStorage.getItem('mb.scale') || '');
    if (sc >= 1 && sc <= 2) state.renderScale = sc;
  } catch { /* private mode */ }
  if ($('sel-scale')) $('sel-scale').value = String(state.renderScale);
  resizeCanvas();
  initMainGpu();

  /* The reference's second viewport (00406070.c) is brought up last so it can
   * borrow the first pass's compiled scheme and Params. */
  juliaView = initJuliaView({
    mainCanvas: canvas,
    getScheme: () => lastDraw,
    /* The dock shades with its own fragment program, so all it needs from the
     * main view is colour: the live palette, band spacing and phase. */
    getPalette: () => state.palette,
    getCycle: () => effectiveCycle(),
    getOffset: () => state.offset || 0,
    /* The dock's seed becomes a coordinate of the main view; feeding it the
     * double-valued screenToPlane pinned every deep Julia set to a 16-digit
     * grid point.  The dock still converts to Number internally for its own
     * whole-set preview shader, which needs no more than that. */
    screenToPlane: screenToPlaneHi,
    planeToScreen,
    getCenter: () => ({ re: state.center.re, im: state.center.im }),
    t, getLang, onLog: nativeLog,
    onOpen: openJuliaSet,
    onBack: backFromJulia
  });
  /* Dev probe: tools/cdp.mjs verifies the second viewport (seed round-trip,
   * picking, marker placement) through this instead of a debugger.  The render
   * and preset entry points are exported too, so an automated A/B against the
   * reference examples does not have to click through the modal. */
  /* Raw renderer handle, for the deep-frame diagnostics tools. */
  window.__mbgpu = mainGPU;
  window.__mb = { state, screenToPlane, screenToPlaneHi, planeToScreen, julia: juliaView,
                  render: renderNow, apply: applyRefPresetPatch,
                  /* Export the gmp-wasm (MPFR) reference orbit for the desktop
                   * Boost bridge, see tools/bridge-crosscheck.mjs. */
                  exportOrbitJson: async (o) =>
                    (await import('./wgpu/ref-orbit.js?v=28')).exportReferenceOrbitJson(o),
                  load: loadPatch, resolveScheme,
                  /* Install a scheme by id from the library, exactly as the
                   * colour panel does, so a verification run can switch to a
                   * codegl (e.g. the Texture scheme) without clicking. */
                  scheme: installScheme,
                  /* Measurement hook for the frame-time breakdown: one `[seg]`
                   * log line per shaded pass (see segReport). */
                  seg: (on) => { segOn = !!on; return segOn; },
                  /* Observed-iteration state (0046f630.c).  iterProbe feeds a
                   * synthetic completed frame so the budget rule can be
                   * checked without waiting for a real exhausted pass. */
                  iter: () => ({
                    cap: observedIter.cap,
                    observedMax: observedIter.observedMax,
                    refine: observedIter.refine,
                    repainted: observedIter.repainted,
                    frameCap: frameIterCap,
                    total: effectiveIterTotal(),
                    key: observedIter.key
                  }),
                  iterProbe: (cap, hi, bounded, refLen) => {
                    noteFrameObservation(cap, hi, bounded,
                      refLen != null ? refLen : (lastMeta && lastMeta.refLen));
                    return {
                      cap: observedIter.cap,
                      observedMax: observedIter.observedMax,
                      refine: observedIter.refine,
                      total: effectiveIterTotal()
                    };
                  },
                  /* Same view, cache off: isolates the field copy's cost. */
                  nocache: (on) => { state.noFieldCache = !!on; return state.noFieldCache; },
                  /* Field-cache occupancy, so a mobile run can assert that
                   * switching sets does not accumulate buffers. */
                  cache: () => ({ fields: FIELD_MEM.size, bytes: fieldMemBytes,
                                  budget: FIELD_MEM_BUDGET, maxEntries: FIELD_MEM_MAX_ENTRIES }),
                  /* A/B switch for the colour-position capture path. */
                  field: (on) => { fieldCaptureOn = !!on; fieldCache = null; return fieldCaptureOn; },
                  forcecopy: (on) => { state.forceCopy = !!on; return state.forceCopy; },
                  /* Force a pass plan (measurement only), e.g. the old 0.16/0.5/1.0. */
                  plan: (arr) => {
                    planOverride = Array.isArray(arr) && arr.length
                      ? arr.map(o => ({ scale: +o.scale || 1,
                                        iter: o.iter == null ? 1 : +o.iter }))
                      : null;
                    return passPlanForNow();
                  },
                  /* Last completed frame's wall time (trigger -> last pass done)
                   * and the exact pixel grid we render, for the speed comparison. */
                  /* Why the shader declined the last frame, if it did. */
                  scene: () => ({ ok: scene.ok, fail: sceneFail,
                                  view: !!sceneView(), last: sceneLast,
                                  result: sceneResult }),
                  /* Layer-ownership probe: the visible surface, both backing
                   * stores, the gesture bitmap baseline and its accumulated
                   * scale.  tools/layercheck.mjs asserts these never disagree. */
                  layer: () => ({ gl: glSurface,
                                  glBuffer: [glCanvas.width, glCanvas.height],
                                  c2d: [canvas.width, canvas.height],
                                  snap: [snap.width, snap.height],
                                  bitmapScale: previewScale,
                                  field: fieldCache ? [fieldCache.w, fieldCache.h] : null }),
                  frame: () => frameMs,
                  frames: () => frameSeq,
                  /* Metadata of the last finished pass: orbit time, whether the
                   * environment came from the cache, bits, glitches. */
                  meta: () => lastMeta,
                  /* WebGPU engine probe: its geometry and a float-field
                   * readback, so tools/wgpucheck.mjs can A/B the shader's
                   * iteration counts against a direct evaluation. */
                  /* Debug knob: lower the depth at which the WebGPU engine
                   * takes over, so a shallow view can be A/B tested against
                   * the direct fragment shader.  null restores the default. */
                  wgpuDD: (v) => mainGPU.forceDD(v),
                  wgpuForce: (v) => {
                    if (v != null) { wgpuMinPixelLog2 = +v; wgpuDeclineKey = ''; }
                    return wgpuMinPixelLog2;
                  },
                  wgpu: () => (mainGPU.renderer ? {
                    ready: mainGPU.ready, failed: mainGPU.failed, why: wgpuWhy,
                    status: mainGPU.status,
                    geometry: {
                      w: mainGPU.renderer.viewW, h: mainGPU.renderer.viewH,
                      field: [mainGPU.renderer._lastFw, mainGPU.renderer._lastFh],
                      spanLog2: mainGPU.renderer.view && mainGPU.renderer.view.spanLog2,
                      maxIter: mainGPU.renderer.view && mainGPU.renderer.view.maxIter,
                      centerRe: mainGPU.renderer.view && mainGPU.renderer.view.centerRe,
                      centerIm: mainGPU.renderer.view && mainGPU.renderer.view.centerIm,
                      rotation: mainGPU.renderer.view && mainGPU.renderer.view.rotation
                    },
                    sample: (pts) => mainGPU.renderer.readFieldSamples(pts)
                  } : { ready: mainGPU.ready, failed: mainGPU.failed }),
                  viewport: () => ({ css: [innerWidth, innerHeight],
                                     dpr: window.devicePixelRatio || 1,
                                     buffer: [canvas.width, canvas.height] }),
                  /* Zoom / anchor probes.  `zoomRaw` moves the view without
                   * drawing, so a drift measurement can run a hundred
                   * notches synchronously; `anchorAt` returns the plane
                   * coordinate under a canvas pixel as a decimal string at
                   * the current width, which is the quantity a zoom gesture
                   * must leave unchanged. */
                  zoomRaw: (px, py, f) => applyZoomAt(px, py, f),
                  anchorAt: (px, py) => {
                    const d = planeDelta(px - canvas.width / 2,
                                         py - canvas.height / 2);
                    const bits = Math.max(128, requiredBitsFromLog2(
                      psLog2Now(), effectiveIterTotal()));
                    return {
                      re: shiftCoordScaled(state.center.re, d.u, d.e, bits),
                      im: shiftCoordScaled(state.center.im, d.v, d.e, bits),
                      bits, psLog2: psLog2Now()
                    };
                  },
                  /* The scheme library, so the colour port can be inspected
                   * without a debugger: names, the JSON that is on disk, and
                   * whether a seeded write-back happened. */
                  schemes: {
                    names: () => (schemeDict ? [...schemeDict.keys()] : []),
                    get: (n) => (schemeDict ? schemeDict.get(n) : null),
                    json: () => (schemeDict ? writeColorschemes(schemeDict) : ''),
                    save: schemeStoreSave
                  } };

  // The shell also pauses on WM_SIZE/SIZE_MINIMIZED; this covers the page-side
  // signal (tab hidden) so the C++ pool never spins while nobody is looking.
  if (NATIVE) {
    document.addEventListener('visibilitychange', () => {
      nativeSetPaused(document.visibilityState === 'hidden');
    });
  }

  // Framing model: resizing / maximising / restoring only changes the frame.
  // The rendered bitmap keeps its size and content; CSS `object-fit: contain`
  // presents it proportionally inside the new frame, and no render pass is
  // triggered.  (HD toggle and "fit to window" still re-render on purpose.)
  updateHud();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
