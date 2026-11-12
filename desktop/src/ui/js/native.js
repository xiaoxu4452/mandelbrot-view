/* ------------------------------------------------------------------
 * native.js — bridge to the Win32 + WebView2 shell.
 *
 * The shell owns an mbc::Engine (native C++ thread pool).  A render request
 * travels as a small JSON message; the finished tile comes back through a
 * WebView2 shared buffer, which the C++ kernel wrote into directly — no
 * base64, no JSON pixel payload.
 *
 * The browser build keeps using the worker/WASM path: this module is inert
 * unless `window.chrome.webview` exists.
 * ----------------------------------------------------------------*/
import { paletteLUT, paletteStops, paletteColors } from './palettes.js';

const bridge = (typeof window !== 'undefined' && window.chrome && window.chrome.webview) || null;

export const NATIVE = !!(bridge && bridge.addEventListener && bridge.postMessage);
let usable = NATIVE;
let canvasMode = false;      // route 1: pixels live in the native swapchain
/* The shell renders and presents the picture itself (OpenGL canvas).  The page
 * then owns only its chrome: it must never paint over the frame, and it must
 * not try to shade a field it will not be showing. */
let glNative = false;
/* True only after the shell has actually committed a frame to the GL canvas.
 * Until then the page keeps painting its own picture. */
let glPresented = false;

let seqCounter = 0;
const inflight = new Map();          // seq -> { onDone, id, viewId }
let lutRef = null;                   // last uploaded LUT (identity, so edits re-upload)
let readyThreads = 0;
let readyWaiters = [];
let statsHook = null;
let frameCap = false;                 // host can write a whole pass into one buffer
const frameWaiters = new Map();       // viewId -> { cb, timer }

function post(obj) {
  try { bridge.postMessage(JSON.stringify(obj)); } catch { /* bridge gone */ }
}

export function nativeUsable() { return usable; }

/** True once the shell reported a working native child-window canvas. */
/* A native surface exists if either half is presenting: the D3D swapchain or
 * the shell's own GL canvas.  Keeping this D3D-only meant the page never sent
 * gesture previews once the GL canvas took over, so the wheel froze the picture
 * and snapped at the end. */
export function nativeCanvasMode() { return usable && (canvasMode || glNative); }

/** True when the shell's own GL canvas is the visible surface. */
export function nativeGLOwned() { return usable && glNative; }

/** True when a gesture transform sent to the shell will actually be seen.
 *  The GL canvas exists before its first committed frame, and until then the
 *  page canvas is what the user is looking at — sending a preview there moved
 *  nothing and skipped the page's own blit. */
export function nativePreviewTarget() {
  return usable && (canvasMode || (glNative && glPresented));
}

/** True once the GL canvas has a committed frame to show. */
export function nativeGLPresented() { return usable && glNative && glPresented; }

/** Gesture feedback: one blit of the displayed frame, applied on the GPU. */
export function nativeCanvasPreview(dx, dy, scale, cx, cy, view) {
  if (!nativeCanvasMode()) return;
  /* `view` lets the shell drop a preview that arrives after the frame it was
   * meant to move: applying it then would transform the *new* picture by a
   * gesture that is already stale, which reads as a jump. */
  post({ type: 'preview', dx, dy, scale, cx, cy, view: view | 0 });
}

/**
 * Set the shell canvas' gesture transform outright.
 *
 * `nativeCanvasPreview` *composes* — which is what a sequence of wheel deltas
 * wants.  A pan, on the other hand, knows its total offset from the frame that
 * is on screen; sending it through the composing entry point added it again on
 * every pointer event, so the image accelerated away from the cursor.  This
 * form replaces the transform, so an event that is duplicated, coalesced or
 * dropped can never move the picture anywhere but the place the hand asked for.
 */
export function nativeCanvasSetPreview(xf, view) {
  if (!nativeCanvasMode()) return;
  post({
    type: 'preview', abs: 1, view: view | 0,
    sx: xf.sx, ox: xf.ox, sy: xf.sy, oy: xf.oy
  });
}

/** PNG export is performed by the shell (WIC + system Save As). */
export function nativeCanvasExport() {
  if (!canvasMode) return false;
  post({ type: 'exportPng' });
  return true;
}

export function nativeLog(msg) { post({ type: 'log', msg: String(msg) }); }

/* ---- preset files -------------------------------------------------------
 *
 * The library itself is embedded (presets-data.js); the only file operations
 * are importing or exporting ONE JSON preset in the reference program's
 * format.  A WebView2 page cannot open an arbitrary path, so the shell owns
 * the dialogs and ships the file *text* back and forth — the page never
 * re-serialises a 40-digit centre.
 * ---------------------------------------------------------------------- */
const presetWaiters = [];

export function nativeImportPreset(cb) {
  if (!usable) return false;
  presetWaiters.push(cb);
  post({ type: 'importPreset' });
  return true;
}

export function nativeExportPreset(json, cb) {
  if (!usable) return false;
  if (cb) presetWaiters.push(cb);
  post({ type: 'exportPreset', json: String(json) });
  return true;
}

export function nativeThreads() { return readyThreads; }

/* Effective appdata\mandelbrot.json values (validated by the shell), if the
 * `ready` handshake has already arrived. */
let lastCfg = null;
export function nativeConfig() { return lastCfg; }

/** True when the shell supports single-frame publishing (single buffer per pass). */
export function nativeFrameReady() { return usable && frameCap; }

/**
 * Declare the pass surface.  Every tile of this pass is then rendered straight
 * into one host-side buffer, and `nativeFrameFlush` publishes it once.
 */
export function nativeFrameBegin(viewId, w, h, ss, cw, ch) {
  if (!NATIVE || !frameCap) return;
  // ss/cw/ch let the native canvas reproduce the page's AA reduction and
  // place the pass 1:1 over the canvas rectangle.
  post({ type: 'frame', viewId, w, h, ss: ss || 1, cw: cw || w, ch: ch || h });
}

/**
 * Ask for the finished pass.  The callback receives {viewId, w, h, data} once
 * the whole surface is painted.  A watchdog keeps the render pipeline moving
 * if the host had to fall back to per-tile buffers (each tile was then drawn
 * individually, so nothing is missing).
 */
export function nativeFrameFlush(viewId, cb, xform) {
  if (!NATIVE || !frameCap) return false;
  const old = frameWaiters.get(viewId);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => {
    if (!frameWaiters.has(viewId)) return;
    frameWaiters.delete(viewId);
    cb(null);
  }, 1500);
  frameWaiters.set(viewId, { cb, timer });
  /* xform is the gesture transform accumulated while this pass was computing
   * (src = sx*dst + ox, normalised).  The shell applies it to the freshly
   * committed texture, so a live render never jumps back to the old view. */
  const msg = { type: 'flush', viewId };
  if (xform && (xform.sx !== 1 || xform.ox !== 0 || xform.sy !== 1 || xform.oy !== 0)) {
    Object.assign(msg, {
      keep: 1, sx: xform.sx, ox: xform.ox, sy: xform.sy, oy: xform.oy
    });
  }
  post(msg);
  return true;
}

export function nativeOnReady(cb) {
  if (readyThreads > 0) { cb(readyThreads); return; }
  readyWaiters.push(cb);
}

export function nativeSetStatsHook(cb) { statsHook = cb; }

export function nativeSetPaused(on) { if (NATIVE) post({ type: 'pause', on: !!on }); }

export function nativeCancel(viewId) {
  if (!NATIVE) return;
  // Anything the page stops waiting for must not keep a timer alive.
  for (const [k, v] of frameWaiters) {
    if (k <= viewId) { clearTimeout(v.timer); frameWaiters.delete(k); }
  }
  post({ type: 'cancel', viewId });
}

/** Upload the 512x4 palette LUT whenever the effective table changes. */
function syncLut(palette) {
  if (!palette) return;
  const lut = paletteLUT(palette);
  if (lut === lutRef) return;
  const arr = new Array(lut.length);
  for (let i = 0; i < lut.length; i++) arr[i] = lut[i];
  post({ type: 'lut', id: palette, data: arr });
  lutRef = lut;
}

function kindCode(spec) {
  switch (spec.kind) {
    case 'mandelbrot':
    case 'multibrot': return 0;
    case 'tricorn': return 1;
    case 'burningship': return 2;
    case 'celtic': return 3;
    case 'perpendicular': return 4;
    case 'phoenix': return 5;
    default: return -1;
  }
}

/**
 * True when this view can be handed to the native kernel.  Custom expressions
 * and Newton still need the JS evaluator, so they keep the worker path.
 */
/**
 * The colour set, in the form the core expects.
 *
 * Additive schemes travel as (r,g,b,frequency,initial) quintuples — literally
 * the reference program's `params.color[]`, so the core runs the same pal()
 * and gets the same picture.  Everything else travels as a gradient ramp.
 * Without this the job only carried `pal: 0`, i.e. every render and every
 * preset thumbnail came out in the same Ice ramp.
 */
function palettePayload(id) {
  const cols = paletteColors && paletteColors(id);
  if (cols && cols.length) {
    const c = [];
    for (const k of cols) c.push(k.r, k.g, k.b, k.frequency, k.initial);
    return { palColors: c, briFinite: cols.briFinite, briInfinite: cols.briInfinite };
  }
  const stops = paletteStops && paletteStops(id);
  if (!stops || stops.length < 2) return {};
  const out = [];
  const n = stops.length - 1;
  for (let i = 0; i < stops.length; i++) out.push(i / n, stops[i][0], stops[i][1], stops[i][2]);
  return { palStops: out };
}

export function nativeCapable(spec, psLog2) {
  if (!usable) return false;
  if (spec.mode !== 'm' && spec.mode !== 'j') return false;
  const k = kindCode(spec);
  if (k < 0) return false;
  /* No depth cut here any more: bits scale with psLog2 (up to 16384, ≈1e4930),
   * so depth is a cost question, not a capability question.
   *
   * The polynomial core z^p + c is perturbable natively for every power the
   * core supports (2..8), so a deep multibrot no longer has to fall back to
   * the JS worker.  The folded families (tricorn / burning ship / celtic /
   * perpendicular) still need a double orbit below 1e-13 because their step
   * flips sign somewhere along the orbit, so they stay shallow-only; phoenix
   * has no native kernel at all. */
  if (psLog2 <= -45 && (k !== 0 || (spec.power || 2) > 8)) return false;
  return true;
}

/** Everything the shell needs to describe one render, tiles and fields alike. */
function buildMsg(payload, seq) {
  const spec = payload.spec || {};
  const tone = payload.tone || {};
  const pal = palettePayload(payload.palette);
  return {
    type: 'render',
    seq,
    id: payload.id,
    viewId: payload.viewId,
    x: payload.x, y: payload.y, w: payload.w, h: payload.h,
    viewWidth: payload.width, viewHeight: payload.height,
    centerRe: payload.center.re,
    centerIm: payload.center.im,
    spanMant: payload.span.m,
    spanExp: payload.span.e,
    maxIter: payload.maxIter,
    bits: payload.bits === 'auto' ? 0 : (payload.bits | 0),
    cycle: payload.cycle,
    ncycle: payload.ncycle || 0,
    bands: payload.bands || 0,
    /* How small a feature the frame is asked to draw (0..3).  This is the
     * control that decides whether a deep view reads as lines or as a field
     * of sub-pixel speckle. */
    detail: payload.detail != null ? (payload.detail | 0) : 3,
    /* Orbit trap (0 = off).  The index is the *only* thing the shell needs;
     * the statistic itself comes back inside the field's fourth channel. */
    traps: payload.traps | 0,
    offset: payload.offset,
    rotation: payload.rotation || 0,
    /* The active shader declares which field channels it reads.  When it does
     * not declare DIST/DIST2 the core skips the derivative recurrence, which
     * is a second complex multiply on every iteration of every pixel. */
    fieldDist: payload.fieldDist !== false,
    /* CHANNEL_VALUE: the scheme reads z at the escape point, so the field
     * grows a second plane.  Absent means the four-channel layout. */
    fieldValue: payload.fieldValue === true,
    /* Colour: the shell owns the palette function, so the ramp and the tone
     * stage travel with every job.  `pal` stays for the built-in additive
     * schemes, which have no ramp. */
    pal: payload.pal | 0,
    colorMode: payload.colorMode | 0,
    stops: pal.palStops || (Array.isArray(payload.stops) ? payload.stops : null),
    colors: pal.palColors || null,
    briFinite: pal.briFinite,
    briInfinite: pal.briInfinite,
    bri: tone.bri != null ? tone.bri : 1,
    /* contrast / gamma / saturation are gone from the console (the reference
     * has no such stage); the shell keeps its own neutral defaults. */
    gainR: tone.gr != null ? tone.gr : 1,
    gainG: tone.gg != null ? tone.gg : 1,
    gainB: tone.gb != null ? tone.gb : 1,
    shade: payload.shade != null ? payload.shade : 0,
    dither: payload.dither === true,
    scheme: payload.scheme | 0,
    quality: payload.quality != null ? payload.quality : 1,
    aa: payload.aa || (payload.quality === 2 ? 2 : 1),
    frame: frameCap && payload.frame === true,
    dynamicIter: payload.dynamicIter === true,
    mode: spec.mode === 'j' ? 1 : 0,
    kind: kindCode(spec),
    power: spec.power || 2,
    juliaRe: spec.julia ? String(spec.julia.re) : 0,
    juliaIm: spec.julia ? String(spec.julia.im) : 0,
    phoenixP: spec.phoenixP != null ? spec.phoenixP : 0.5667
  };
}

export function nativeRender(payload, onDone) {
  if (!usable) return false;
  const spec = payload.spec || {};
  const k = kindCode(spec);
  if (k < 0) return false;
  syncLut(payload.palette);

  const seq = ++seqCounter;
  inflight.set(seq, { onDone, id: payload.id, viewId: payload.viewId });
  post(buildMsg(payload, seq));
  return true;
}

/**
 * Ask for a whole-frame iteration *field* instead of pixels.
 *
 * The shell then skips its colour stage entirely and hands back
 * w*h*4 float32 (smoothiter, distance, iter, dist2).  The page uploads that as
 * a texture and shades it with `gpu.js`, which is the reference program's own
 * split and the only way to run its per-preset GLSL schemes.
 *
 * A field pass is never a tile: the shader needs the frame's own pixel grid
 * for its screen-space terms.
 */
export function nativeField(payload, onDone) {
  if (!usable) return false;
  const spec = payload.spec || {};
  if (kindCode(spec) < 0) return false;
  const seq = ++seqCounter;
  inflight.set(seq, { onDone, id: payload.id, viewId: payload.viewId });
  const msg = buildMsg(payload, seq);
  msg.fieldPass = true;
  msg.frame = false;
  msg.aa = 1;                 // the shader does its own SAMPLES x SAMPLES
  post(msg);
  return true;
}

/** The palette terms the GPU path needs for `params.color[]`. */
export function nativePaletteTerms(id) { return palettePayload(id); }

function onTile(info, ab) {
  const rec = inflight.get(info.seq);
  if (!rec) return;
  inflight.delete(info.seq);
  const n = (info.bw | 0) * (info.bh | 0) * 4;
  let data;
  try {
    data = new Uint8ClampedArray(ab, 0, n);
  } catch {
    data = new Uint8ClampedArray(ab.slice(0, n));
  }
  try {
    rec.onDone({
      type: 'tile',
      id: info.id,
      viewId: info.viewId,
      x: info.x, y: info.y, w: info.bw, h: info.bh,
      data,
      meta: info.meta
    });
  } finally {
    // Release the host-side slot: it may be reused for the next tile.
    post({ type: 'ack', seq: info.seq });
  }
}

/** A whole pass arrived: hand the surface over as one contiguous RGBA image. */
function onFrame(info, ab) {
  const w = info.w | 0, h = info.h | 0;
  if (w <= 0 || h <= 0) return;
  const n = w * h * 4;
  let data;
  try {
    data = new Uint8ClampedArray(ab, 0, n);
  } catch {
    data = new Uint8ClampedArray(ab.slice(0, n));
  }
  const rec = frameWaiters.get(info.viewId);
  if (!rec) return;
  clearTimeout(rec.timer);
  frameWaiters.delete(info.viewId);
  rec.cb({ viewId: info.viewId, w, h, data });
}

/** A whole-frame iteration field arrived (float32, w*h*ch). */
function onField(info, ab) {
  const w = info.w | 0, h = info.h | 0;
  /* 4 = colour plane (smoothiter, dist, iter, dist2) packed per texel.
   * 6 = the same plane followed by a value plane of two floats per texel
   * (z at the escape point), which the Texture scheme continues itself. */
  const ch = info.ch === 6 ? 6 : 4;
  /* The host reserves a shared-buffer *slot* per field pass and only reuses it
   * once this ack arrives.  A stale result (no waiter), a bad size or a broken
   * buffer must still ack, or the slot pool fills up and every later field pass
   * silently falls back to the CPU renderer. */
  try {
    if (w <= 0 || h <= 0) return;
    const n = w * h * ch;
    let data;
    try {
      data = new Float32Array(ab, 0, n);
    } catch {
      data = new Float32Array(ab.slice(0, n * 4));
    }
    const rec = inflight.get(info.seq);
    if (!rec) return;
    inflight.delete(info.seq);
    rec.onDone({ type: 'field', id: rec.id, viewId: info.viewId,
                 w, h, ch, data, meta: info.meta });
  } finally {
    post({ type: 'ack', seq: info.seq });
  }
}

if (NATIVE) {
  // Page errors are invisible from the host otherwise; both go to shell.log.
  const report = (tag, msg) => post({ type: 'log', msg: tag + ' ' + (msg || '') });
  window.addEventListener('error', (e) => report('ERR', `${e.message} @${e.filename || ''}:${e.lineno || 0}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report('REJ', (r && (r.stack || r.message)) || String(r));
  });

  bridge.addEventListener('sharedbufferreceived', (ev) => {
    // WebView2 hands additionalData over already parsed as an object.
    let info = ev.additionalData;
    if (typeof info === 'string') {
      try { info = JSON.parse(info); } catch { return; }
    }
    if (!info) return;
    if (info.type === 'frame') { onFrame(info, ev.getBuffer()); return; }
    if (info.type === 'field') { onField(info, ev.getBuffer()); return; }
    if (info.type !== 'tile') return;
    onTile(info, ev.getBuffer());
  });

  bridge.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'ready') {
      readyThreads = m.threads || 1;
      if (m.shm === false) usable = false;
      frameCap = m.shm !== false && m.frame !== false;
      canvasMode = m.native === true;
      glNative = m.glnative === true;
      /* Do NOT switch the page transparent here.  The GL canvas exists but has
       * not drawn anything yet, and a transparent page over an empty child
       * window is a blank product.  nativeflush (post-commit) is the only
       * signal that justifies hiding the page's own canvas. */
      glPresented = false;
      /* The shell read appdata\mandelbrot.json (winparameters.html) and already
       * validated/defaulted every field; hand the effective values to the page. */
      if (m.cfg) { lastCfg = m.cfg; window.dispatchEvent(new CustomEvent('mbConfig', { detail: m.cfg })); }
      /* The transparent-surface class is NOT added here: it may only be turned
       * on once the shell has actually committed a frame, otherwise the page
       * hides its own canvas with nothing behind it yet.  app.js owns it. */
      for (const cb of readyWaiters) cb(readyThreads);
      readyWaiters.length = 0;
    } else if (m.type === 'nativeflush') {
      // Whole pass committed to the native surface: no pixels travel to JS.
      const rec = frameWaiters.get(m.viewId);
      if (!rec) {
        /* No pass was declared through nativeFrameFlush (the shell owns the
         * frame), so this is the "first frame is on screen" signal.  Only now
         * may the page become transparent. */
        if (glNative) glPresented = true;
        window.dispatchEvent(new CustomEvent('mbNativeCommit', { detail: m }));
        return;
      }
      clearTimeout(rec.timer);
      frameWaiters.delete(m.viewId);
      rec.cb({ viewId: m.viewId, w: m.w, h: m.h, data: null, ok: m.ok !== 0 });
    } else if (m.type === 'exportResult') {
      window.dispatchEvent(new CustomEvent('mbExportResult', { detail: m }));
    } else if (m.type === 'presetImport' || m.type === 'presetExport') {
      /* A dialog result belongs to the request that opened it, but the shell
       * may also push one on its own (a command-line import, a file dropped on
       * the window).  With no waiter outstanding it goes out as an event. */
      const cb = presetWaiters.shift();
      if (cb) cb(m);
      else window.dispatchEvent(new CustomEvent('mbPreset', { detail: m }));
    } else if (m.type === 'openPreset' || m.type === 'openPanel') {
      /* The shell can name a preset on the command line, or ask for a panel to
       * be opened (a first-run tour, a screenshot script). */
      window.dispatchEvent(new CustomEvent('mbShell', { detail: m }));
    } else if (m.type === 'selftest') {
      if (typeof window.__mbSelfTest === 'function') window.__mbSelfTest();
    } else if (m.type === 'tilemeta') {
      // Frame mode: the pixels are already in the pass buffer; this only
      // reports progress so the HUD and the pass counter keep moving.
      const rec = inflight.get(m.seq);
      if (!rec) return;
      inflight.delete(m.seq);
      rec.onDone({
        type: 'tile', id: rec.id, viewId: m.viewId, frame: true, data: null,
        x: m.x, y: m.y, w: m.bw, h: m.bh, meta: m.meta
      });
    } else if (m.type === 'noshm') {
      // Runtime without the shared-buffer API: fall back to the worker path.
      usable = false;
    } else if (m.type === 'stats' && statsHook) {
      statsHook(m);
    }
  });

  post({ type: 'hello' });
}
