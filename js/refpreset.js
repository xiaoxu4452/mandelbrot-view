/* ------------------------------------------------------------------
 * refpreset.js — the reference program's own JSON formats.
 *
 * This is a transcription of the loader in the reference binary, not a
 * format we invented.  Every rule below is traceable to the decompilation:
 *
 *   00539080.c  loadviewportjson          viewport keys, juliamode, flags
 *   00537270.c  worker_storeviewportjson  the keys it writes back
 *   005472c0.c  readParams                parameters.* semantics & defaults
 *   00545e70.c  writeParams               the keys it writes back
 *   00547070.c  ColorschemeFromDictionary colorscheme.* validation
 *   00545b90.c  DictionaryFromColorscheme the keys it writes back
 *   00546630.c  loadParams                exp(f_i + F), init_i + I
 *   00545d80.c  initParams                default F = -ln(10), I = 0
 *   0055ef40.c  main                      \appdata\mandelbrot.json keys
 *   08_全量覆盖/DWARF  INITIALCOLORS @ VA 0x0056bd40 (.rdata)
 *
 * The three mistakes this file used to make, all of which changed the picture:
 *
 *  1. A `colors` entry that omits `rgb`, `frequency` or `initial` does NOT
 *     become zero.  readParams first copies the program's three-term default
 *     table into params->color[], then overwrites *only the keys present*.
 *     Eight shipped presets omit `rgb` on purpose: entry 0 stays red, entry 1
 *     green, entry 2 blue.  An empty array `[]` is also legal and means
 *     "keep the whole default slot".
 *  2. `parameters.frequency` / `parameters.initial` are GLOBAL OFFSETS added
 *     to every term at shader-upload time:
 *         params.color[i].frequency = exp(f_i + F)
 *         params.color[i].initial   = init_i + I
 *     They are not per-entry defaults.  Using them as defaults both replaced
 *     an inherited frequency and applied the offset twice.
 *  3. `colorscheme.name` is mandatory (readParams returns false without it),
 *     and a dictionary with `codegl` becomes a CUSTOM scheme.  `code` is the
 *     Metal/HLSL twin; the GL build ignores it but we keep it for round trips.
 *
 * Limits come straight from the binary's #defines: NCOLOR 20, NPARAM 10.
 * ----------------------------------------------------------------*/

import { REF_DEFAULT_LOG_FREQ } from './palettes.js?v=28';

const ZOOM_SPAN = 2.0;      // span = ZOOM_SPAN / zoom

/** NCOLOR in the reference shader (00546630.c / core_fractal.glsl). */
export const REF_MAX_COLORS = 20;
/** NPARAM in the reference shader; `custom` is read into params.param[10]. */
export const REF_MAX_PARAM = 10;

/**
 * INITIALCOLORS, read out of mandelbrot.exe at VA 0x0056bd40 as three
 * float32 quintuples (r, g, b, frequency, initial).  readParams copies this
 * into params->color[0..2] before it looks at the file, so these are the
 * values a partial `colors` entry inherits.
 */
export const REF_INITIAL_COLORS = Object.freeze([
  Object.freeze({ r: 1, g: 0, b: 0, frequency: -2.1202635765075684, initial: -1 }),
  Object.freeze({ r: 0, g: 1, b: 0, frequency: -1.1363141536712646, initial: -1.5 }),
  Object.freeze({ r: 0, g: 0, b: 1, frequency: -0.023268627002835274, initial: -0.5 })
]);

/** The reference's appdata\mandelbrot.json settings, with its own defaults. */
export const REF_SETTINGS_KEYS = Object.freeze([
  'guiscale', 'framerate', 'linewidth', 'nthread', 'cachesize',
  'totalmemory', 'graphicsmemory', 'graphicsrate', 'ntrace', 'pointsize',
  'juliawndsize', 'GLFW_CONTEXT_VERSION_MAJOR', 'GLFW_CONTEXT_VERSION_MINOR',
  'yreduce', 'startautomode', 'highres', 'presentationmode',
  'debuginfomode', 'touchmodeaverage', 'videooptions'
]);

/** Parse a decimal that may be far longer than a double, keeping every digit. */
function keepDecimal(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  return s.length ? s : null;
}

/** A JSON number, or the fallback when the key is absent / not numeric. */
function num(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

/** Split a decimal string into (mantissa in [1,2), binary exponent). */
export function decimalToSpan(str) {
  const v = Number(str);
  if (!isFinite(v) || v <= 0) return { m: 1.6, e: 1 };
  let m = v, e = 0;
  while (m >= 2) { m /= 2; e++; }
  while (m < 1) { m *= 2; e--; }
  return { m, e };
}

export function zoomToSpan(zoom) {
  const z = Number(zoom);
  if (!isFinite(z) || z <= 0) return { m: 1.6, e: 1 };
  return decimalToSpan(ZOOM_SPAN / z);
}

export function spanToZoom(span) {
  const v = span.m * Math.pow(2, span.e);
  return v > 0 ? ZOOM_SPAN / v : 1;
}

/**
 * readParams' `colors` array, in the FILE's literal (log-frequency) domain.
 *
 * The returned terms are what `shaderTerms(colors, F, I)` consumes.  A missing
 * key inherits slot i of INITIALCOLORS for i < 3, and zero beyond that (the
 * reference leaves those slots untouched, and writeParams always writes all
 * three keys for entries 3..19).
 */
export function readColors(parameters) {
  const src = (parameters && Array.isArray(parameters.colors))
    ? parameters.colors : [];
  const out = [];
  for (let i = 0; i < Math.min(src.length, REF_MAX_COLORS); i++) {
    const entry = src[i];
    const base = i < REF_INITIAL_COLORS.length
      ? REF_INITIAL_COLORS[i]
      : { r: 0, g: 0, b: 0, frequency: 0, initial: 0 };
    const term = {
      r: base.r, g: base.g, b: base.b,
      frequency: base.frequency, initial: base.initial
    };
    if (Array.isArray(entry)) {
      /* readParams accepts an empty array as "leave this slot alone"; a
       * non-empty array is rejected by the loader, so there is nothing to
       * read from it either. */
    } else if (entry && typeof entry === 'object') {
      if (Array.isArray(entry.rgb)) {
        /* A short rgb array only overrides the channels it names (the
         * reference loops over countjarray, it does not require 3). */
        if (entry.rgb.length > 0) term.r = num(entry.rgb[0], term.r);
        if (entry.rgb.length > 1) term.g = num(entry.rgb[1], term.g);
        if (entry.rgb.length > 2) term.b = num(entry.rgb[2], term.b);
      }
      if (entry.frequency != null) term.frequency = num(entry.frequency, term.frequency);
      if (entry.initial != null) term.initial = num(entry.initial, term.initial);
    }
    out.push(term);
  }
  return out;
}

/**
 * The palette a file with no `colors` key gets: readParams resets params to
 * INITIALCOLORS on every call, it does not inherit the previous view's table.
 */
export function defaultRefColors() {
  return REF_INITIAL_COLORS.map(c => ({ ...c }));
}

/** The global parameters readParams extracts, with the reference's defaults. */
export function readGlobals(parameters) {
  const p = parameters || {};
  return {
    briFinite: num(p.brightnessfinite, 1),
    briInfinite: num(p.brightnessinfinite, 1),
    briFactor: num(p.brightnessfactor, undefined),
    frequency: num(p.frequency, REF_DEFAULT_LOG_FREQ),
    initial: num(p.initial, 0),
    inverse: !!num(p.inverse, 0),
    param: Array.isArray(p.custom)
      ? p.custom.slice(0, REF_MAX_PARAM).map(v => num(v, 0)) : []
  };
}

/**
 * Which of the reference's JSON files is this?
 *
 * The program reads four different shapes through four different loaders:
 * a viewport preset, a single colorscheme dictionary, the colorschemes
 * library (an array of dictionaries), and its appdata settings file.
 * Feeding one to another loader is what used to make an imported
 * colorschemes.json open as a blank fractal.
 */
export function classifyRefJson(obj) {
  if (Array.isArray(obj)) {
    return obj.length && obj.every(isColorschemeDict) ? 'colorschemes' : 'unknown';
  }
  if (!obj || typeof obj !== 'object') return 'unknown';
  if (isColorschemeDict(obj)) return 'scheme';
  const keys = Object.keys(obj);
  const looksPreset = keys.some(k =>
    k === 'x' || k === 'y' || k === 'zoom' || k === 'parameters' ||
    k === 'julia_x' || k === 'julia_zoom' || k === 'initialzoom');
  if (looksPreset) return 'preset';
  const settingsHits = keys.filter(k => REF_SETTINGS_KEYS.includes(k)).length;
  if (settingsHits > 0) return 'settings';
  /* `{}` is a legal file: loadviewportjson treats a missing `parameters`
   * dictionary as "use every default" (Retinamandelbrot Example 1 is exactly
   * that file).  Our own extensions are also preset-only keys. */
  const extensions = ['name', 'nameZh', 'nameEn', 'id', 'category', 'format',
                      'ramp', 'spec', 'animation', 'flags', 'showZoom',
                      'initialzoom', 'julia_initialzoom', 'julia_zoom',
                      'julia_rotation', 'julia_x', 'julia_y', 'julia_mx', 'julia_my'];
  return keys.every(k => extensions.includes(k)) ? 'preset' : 'unknown';
}

function isColorschemeDict(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) &&
         typeof o.name === 'string' && typeof o.codegl === 'string' &&
         (o.channels == null || Number.isFinite(Number(o.channels)));
}

/**
 * \appdata\mandelbrot.json (0055ef40.c).  Only keys the binary actually
 * reads are carried; `videooptions` is a nested dictionary of its own.
 */
export function readRefSettings(obj) {
  const out = { loaded: true };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of REF_SETTINGS_KEYS) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (k === 'videooptions') {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...v };
    } else if (typeof v === 'boolean') {
      out[k] = v ? 1 : 0;
    } else if (isFinite(Number(v))) {
      out[k] = Number(v);
    }
  }
  return out;
}

/**
 * Turn a reference preset object into the pieces the app applies.
 *
 * Returns a plain description — it does not touch global state, so the caller
 * decides what to keep.
 */
export function importRefPreset(obj, opts = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('not a preset object');
  }
  const p = (obj.parameters && typeof obj.parameters === 'object' &&
             !Array.isArray(obj.parameters)) ? obj.parameters : {};
  const cs = (p.colorscheme && typeof p.colorscheme === 'object' &&
              !Array.isArray(p.colorscheme)) ? p.colorscheme : {};
  const out = {};

  /* Which view the file opens.
   *
   *   x / y, zoom, rotation                  the Mandelbrot view
   *   julia_x / julia_y, julia_zoom, ...     the Julia plane view
   *   julia_mx / julia_my                    the seed (Mandelbrot point)
   *
   * loadviewportjson clamps juliamode > 2 back to 0.  The GUI uses
   * `juliamode == 1` for the embedded Julia window (00405590.c:126) and
   * `juliamode == 2` for the full-screen Julia view (00402850.c:14), so only
   * 2 replaces the main viewport. */
  const jmRaw = p.juliamode != null ? p.juliamode : obj.juliamode;
  const juliamode = Math.max(0, Math.min(2, Number(jmRaw) | 0 || 0));
  out.juliamode = juliamode;
  out.juliaDock = juliamode === 1;
  /* Our own cards use `juliamode: 1` together with `flags.julia` / `spec.mode`
   * to mean "the main viewport IS a Julia set".  The reference's 1 is only an
   * embedded dock, but honouring that literally here would turn 83 authored
   * Julia cards into Mandelbrot views, so the explicit extensions win. */
  const juliaMode = juliamode === 2 ||
    !!(obj.flags && typeof obj.flags === 'object' && obj.flags.julia === true) ||
    !!(obj.spec && obj.spec.mode === 'j');
  const x = keepDecimal(obj.x);
  const y = keepDecimal(obj.y);
  const jx = keepDecimal(obj.julia_x);
  const jy = keepDecimal(obj.julia_y);
  const mx = keepDecimal(obj.julia_mx);
  const my = keepDecimal(obj.julia_my);

  if (juliaMode) {
    out.mode = 'j';
    if (jx != null && jy != null) out.center = { re: jx, im: jy };
    else if (x != null && y != null) out.center = { re: x, im: y };
    const jz = obj.julia_zoom != null ? obj.julia_zoom
             : (obj.julia_initialzoom != null ? obj.julia_initialzoom : obj.zoom);
    if (jz != null) out.span = zoomToSpan(jz);
    const jr = obj.julia_rotation != null ? obj.julia_rotation : obj.rotation;
    if (jr != null && isFinite(Number(jr))) out.rotation = Number(jr);
    /* The seed falls back to the Mandelbrot view centre when the file
     * predates julia_mx/my, which is what loadviewportjson does. */
    const seedRe = mx != null ? mx : x;
    const seedIm = my != null ? my : y;
    if (seedRe != null && seedIm != null) out.julia = { re: seedRe, im: seedIm };
  } else {
    if (x != null && y != null) out.center = { re: x, im: y };
    /* `showZoom` wins when present: it is the decade that actually contains
     * the boundary the shipped picture shows (see gen-presets.mjs).
     * `initialzoom` is the reference's legacy home zoom, read by
     * loadviewportjson but no longer written by storeviewportjson. */
    const dz = obj.showZoom != null ? obj.showZoom
             : (obj.zoom != null ? obj.zoom : obj.initialzoom);
    if (dz != null) out.span = zoomToSpan(dz);
    if (obj.rotation != null && isFinite(Number(obj.rotation))) {
      out.rotation = Number(obj.rotation);
    }
    if (jx != null && jy != null) out.juliaView = { re: jx, im: jy };
    if (mx != null && my != null) out.juliaSeed = { re: mx, im: my };
  }

  /* The reference keeps a second VIEWPORT for the Julia preview (00406070.c).
   * Its own centre, zoom and rotation are separate from the main view. */
  if (obj.julia_zoom != null || obj.julia_rotation != null ||
      obj.julia_initialzoom != null) {
    const jv = out.juliaView || {};
    if (obj.julia_zoom != null) jv.zoom = Number(obj.julia_zoom);
    if (obj.julia_initialzoom != null) jv.initialZoom = String(obj.julia_initialzoom);
    if (obj.julia_rotation != null) jv.rotation = Number(obj.julia_rotation);
    out.juliaView = jv;
  }
  if (obj.initialzoom != null) out.initialZoom = String(obj.initialzoom);

  if (obj.animation && obj.animation.keys) out.animation = obj.animation;

  /* `flags` is a numeric REALM bitfield (00539080.c:290), not an object of
   * switches.  Preserve the bits verbatim: storeviewportjson writes them into
   * the .mb header as 0xb1010000 | flags, and inventing meanings would break
   * a round trip. */
  if (obj.flags != null) {
    if (typeof obj.flags === 'number' && isFinite(obj.flags)) {
      out.realmFlags = obj.flags >>> 0;
    } else if (typeof obj.flags === 'object' && obj.flags.inverse != null) {
      out.inverse = !!obj.flags.inverse;
    }
  }

  const g = readGlobals(p);
  const colors = readColors(p);
  if (colors.length) out.colors = colors;
  out.colorFreq = g.frequency;
  out.colorInit = g.initial;
  out.briFinite = g.briFinite;
  out.briInfinite = g.briInfinite;
  if (g.briFactor !== undefined) out.briFactor = g.briFactor;
  out.inverse = g.inverse || out.inverse === true;
  if (g.param.length) out.param = g.param;
  out.param = out.param || [];

  /* The shader.  `codegl` is the GLSL twin the GL build reads; `code` is the
   * Metal/HLSL twin, kept only so an exported file stays loadable by the
   * build that uses it. */
  const gl = typeof cs.codegl === 'string' ? cs.codegl : '';
  if (gl.trim()) out.glsl = gl;
  if (typeof cs.code === 'string' && cs.code.trim()) out.hlsl = cs.code;
  if (cs.name) out.schemeName = String(cs.name).trim();
  /* `ColorschemeFromDictionary` defaults samples to 1 and nparam to 0; the
   * renderer caps supersampling separately, so the parsed value stays exact. */
  if (cs.samples != null) out.samples = Math.max(1, Number(cs.samples) | 0);
  if (cs.channels != null) out.channels = Number(cs.channels) >>> 0;
  if (cs.nparam != null) {
    out.nparam = Math.max(0, Math.min(REF_MAX_PARAM, Number(cs.nparam) | 0));
  }
  if (cs.builtin != null) out.builtin = num(cs.builtin, 0) ? 1 : 0;
  if (typeof cs.aux === 'string' && cs.aux.trim()) out.auxfile = cs.aux.trim();
  /* A file may name one of the program's built-in schemes and ship no
   * `codegl` at all.  Carry the name through so the app can install its own
   * copy of that shader instead of falling back to a ramp. */
  if (!gl.trim() && cs.name) out.schemeBuiltin = String(cs.name).trim();

  if (opts.keepRaw !== false) out.raw = obj;
  return out;
}

/** The exact Decimal text for a centre coordinate, given our string form. */
function coordText(s, fallback) {
  if (typeof s === 'string' && s.length) return s;
  if (typeof s === 'number') return String(s);
  return fallback;
}

/**
 * Build a preset in the reference's own shape.
 *
 * Everything the reference can express is written back the way it writes it,
 * including the HLSL twin (`code`) when the scheme came from a shipped preset.
 */
export function exportRefPreset(v) {
  const span = v.span || { m: 1.6, e: 1 };
  const colors = (v.colors || []).slice(0, REF_MAX_COLORS).map(c => ({
    rgb: [c.r || 0, c.g || 0, c.b || 0],
    frequency: c.frequency != null ? c.frequency : 0,
    initial: c.initial != null ? c.initial : 0
  }));

  const scheme = {};
  if (v.schemeName) scheme.name = v.schemeName;
  if (v.glsl) {
    scheme.codegl = v.glsl;
    scheme.code = v.hlsl || glslToHlsl(v.glsl);
  }
  if (v.samples != null) scheme.samples = Math.max(1, v.samples | 0);
  if (v.channels != null) scheme.channels = v.channels >>> 0;
  if (v.nparam != null) scheme.nparam = Math.max(0, Math.min(REF_MAX_PARAM, v.nparam | 0));
  if (v.auxfile) scheme.aux = v.auxfile;
  scheme.builtin = v.builtin != null ? (v.builtin ? 1 : 0)
                                    : (v.glsl ? 0 : 1);

  const params = {};
  /* writeParams omits juliamode when it is zero. */
  if (v.juliamode != null ? v.juliamode : (v.mode === 'j' ? 2 : 0)) {
    params.juliamode = v.juliamode != null ? v.juliamode : 2;
  }
  if (v.colorFreq != null) params.frequency = v.colorFreq;
  if (v.colorInit != null) params.initial = v.colorInit;
  params.colors = colors;
  if (v.glsl || scheme.name) params.colorscheme = scheme;
  if (v.briFinite != null) params.brightnessfinite = v.briFinite;
  if (v.briInfinite != null) params.brightnessinfinite = v.briInfinite;
  if (v.briFactor != null) params.brightnessfactor = v.briFactor;
  if (v.inverse) params.inverse = 1;
  if (Array.isArray(v.param) && v.param.length) {
    params.custom = v.param.slice(0, REF_MAX_PARAM).map(x => num(x, 0));
  }

  const out = {
    x: coordText(v.center && v.center.re, '0'),
    y: coordText(v.center && v.center.im, '0'),
    zoom: Number(spanToZoom(span).toPrecision(10)).toString(),
    rotation: v.rotation || 0,
    julia_x: coordText(v.juliaView && v.juliaView.re, coordText(v.center && v.center.re, '-0.745428')),
    julia_y: coordText(v.juliaView && v.juliaView.im, coordText(v.center && v.center.im, '0.113009')),
    julia_zoom: v.juliaView && v.juliaView.zoom != null ? String(v.juliaView.zoom) : '0.500000000000000000',
    julia_rotation: v.juliaView && v.juliaView.rotation != null ? v.juliaView.rotation : -1.5707963267948966,
    julia_mx: coordText(v.julia && v.julia.re, coordText(v.center && v.center.re, '-0.745428')),
    julia_my: coordText(v.julia && v.julia.im, coordText(v.center && v.center.im, '0.113009')),
    parameters: params
  };
  if (v.initialZoom) out.initialzoom = v.initialZoom;
  if (v.realmFlags != null) out.flags = v.realmFlags >>> 0;
  if (v.animation) out.animation = v.animation;
  return out;
}

/**
 * GLSL -> HLSL for the common subset a colour scheme uses.
 *
 * This is deliberately a text translation of *our* dialect (the one the
 * reference's own `codegl` sources are written in), not a general compiler.
 */
export function glslToHlsl(src) {
  if (!src) return '';
  let s = String(src);
  s = s.replace(/\bvec4\b/g, 'float4').replace(/\bvec3\b/g, 'float3')
       .replace(/\bvec2\b/g, 'float2');
  s = s.replace(/\bmix\s*\(/g, 'lerp(');
  s = s.replace(/\bfract\s*\(/g, 'frac(');
  s = s.replace(/\bmod\s*\(/g, 'fmod(');
  s = s.replace(/\batan\s*\(([^,()]+),([^()]+)\)/g, 'atan2($1,$2)');
  s = s.replace(/float4\s+color\s*\(\s*Data\s+(\w+)\s*\)/,
                'float4 color(constant Params &params, Data $1)');
  return s;
}
