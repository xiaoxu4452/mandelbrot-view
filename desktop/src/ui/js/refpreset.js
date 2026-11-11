/* ------------------------------------------------------------------
 * refpreset.js — the reference program's own preset format.
 *
 * The format is not ours and not negotiable: it is what
 * `examples/*.json` in the reference distribution contains, and a preset is
 * only interchangeable with that program if a round trip preserves it.  The
 * shape is:
 *
 *   {
 *     "x": "-0.7454280003322500000000007785600000000000",
 *     "y": "0.1130090000000000000000000000000000000000",
 *     "zoom": "0.100000e5",
 *     "rotation": 0.0,
 *     "julia_x": "...", "julia_y": "...", "julia_zoom": "...",
 *     "julia_rotation": 0.0, "julia_mx": "...", "julia_my": "...",
 *     "parameters": {
 *       "colors": [ { "rgb": [r,g,b], "frequency": f, "initial": i }, ... ],
 *       "colorscheme": {
 *         "name": "...", "codegl": "<fragment shader>", "code": "<HLSL twin>",
 *         "samples": 2, "channels": 17, "builtin": 0, "nparam": 1
 *       },
 *       "brightnessfinite": 1.0, "brightnessinfinite": 1.0,
 *       "brightnessfactor": 1.0
 *     }
 *   }
 *
 * Three details matter and are easy to get wrong:
 *
 *  1. `zoom` is a *factor*, not a span.  Measured against the shipped
 *     Example 11 (zoom 0.895007e3 at x = -1.8612345512112392) the field of
 *     view is 2/zoom across the longer canvas axis, which is what the numbers
 *     below use.  A span of 2 is the classic "whole set" view, so zoom 1 means
 *     exactly that.
 *  2. `colors` entries may omit `rgb`, `frequency` or `initial`.  A missing
 *     `frequency` is the program's DC term (0), and a missing `rgb` keeps that
 *     entry black, i.e. it contributes nothing — that is why several shipped
 *     presets list more entries than they visibly use.
 *  3. `colorscheme.codegl` is the *real* recipe for the look.  Four of the
 *     shipped presets (Amethyst Crown, Nebula Bloom, Rainbow Veins, Chinese
 *     Remainder Clock) cannot be expressed as `pal()` parameters at all: their
 *     colour is a shader.  Importing the field without the shader would render
 *     them as something else entirely, so `codegl` always wins.
 * ----------------------------------------------------------------*/

import { REF_DEFAULT_LOG_FREQ } from './palettes.js';

const ZOOM_SPAN = 2.0;      // span = ZOOM_SPAN / zoom

/** Parse a decimal that may be far longer than a double, keeping every digit. */
function keepDecimal(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(v);
  const s = String(v).trim();
  return s.length ? s : null;
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

/** The additive terms of a preset, normalised to what our palette wants. */
export function readColors(parameters) {
  const src = (parameters && parameters.colors) || [];
  /* `parameters.frequency` / `parameters.initial` are the scheme's defaults: a
   * colour entry is allowed to omit them and inherit, and Example 11 of the
   * reference does exactly that.  Treating "absent" as zero instead of "inherit"
   * turns its three-term scheme into one sinusoid plus two DC blobs — visibly
   * flatter, and not a detail anyone would guess from the file. */
  const dFreq = parameters && parameters.frequency != null
    ? Number(parameters.frequency) : 0;
  const dInit = parameters && parameters.initial != null
    ? Number(parameters.initial) : 0;
  const out = [];
  for (const c of src) {
    if (!c) continue;
    const rgb = Array.isArray(c.rgb) ? c.rgb : [0, 0, 0];
    out.push({
      r: Number(rgb[0]) || 0,
      g: Number(rgb[1]) || 0,
      b: Number(rgb[2]) || 0,
      frequency: c.frequency != null ? Number(c.frequency) : dFreq,
      initial: c.initial != null ? Number(c.initial) : dInit
    });
  }
  return out;
}

/**
 * Turn a reference preset object into the pieces the app applies.
 *
 * Returns a plain description — it does not touch global state, so the caller
 * decides what to keep (a preset with `juliamode` should not silently switch a
 * Mandelbrot view into a Julia one unless the file asks for it).
 */
export function importRefPreset(obj, opts = {}) {
  if (!obj || typeof obj !== 'object') throw new Error('not a preset object');
  const p = obj.parameters || {};
  const cs = p.colorscheme || {};
  const out = {};

  /* Which view the file opens.
   *
   * The four coordinate pairs mean different things and getting them the wrong
   * way round renders a different fractal:
   *
   *   x / y, zoom, rotation                  the Mandelbrot view
   *   julia_x / julia_y, julia_zoom, ...     the *Julia plane* view
   *   julia_mx / julia_my                    the seed: the Mandelbrot point the
   *                                          Julia set belongs to
   *
   * Example 4 of the reference makes this unambiguous — x,y is -0.230/-0.754
   * and matches julia_mx/my, while julia_x/y is -0.127/-0.845 and is where the
   * Julia picture is centred.
   */
  const juliaMode = !!(p.juliamode || obj.juliamode ||
                       (obj.flags && obj.flags.julia));
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
    const jz = obj.julia_zoom != null ? obj.julia_zoom : obj.zoom;
    if (jz != null) out.span = zoomToSpan(jz);
    const jr = obj.julia_rotation != null ? obj.julia_rotation : obj.rotation;
    if (jr != null && isFinite(Number(jr))) out.rotation = Number(jr);
    /* The seed falls back to the Mandelbrot view centre when the file predates
     * julia_mx/my, which is exactly how the reference behaves. */
    const seedRe = mx != null ? mx : x;
    const seedIm = my != null ? my : y;
    if (seedRe != null && seedIm != null) out.julia = { re: seedRe, im: seedIm };
  } else {
    if (x != null && y != null) out.center = { re: x, im: y };
    /* `showZoom` wins when present: it is the decade that actually contains
     * the boundary the shipped picture shows (see gen-presets.mjs). */
    const dz = obj.showZoom != null ? obj.showZoom : obj.zoom;
    if (dz != null) out.span = zoomToSpan(dz);
    if (obj.rotation != null && isFinite(Number(obj.rotation))) {
      out.rotation = Number(obj.rotation);
    }
    /* Still remember the Julia view and seed: switching to Julia afterwards
     * then lands on the view the file was authored with. */
    if (jx != null && jy != null) out.juliaView = { re: jx, im: jy };
    if (mx != null && my != null) out.juliaSeed = { re: mx, im: my };
  }

  if (obj.animation && obj.animation.keys) out.animation = obj.animation;

  const colors = readColors(p);
  if (colors.length) out.colors = colors;
  /* loadParams (00546630.c:79/:87) feeds the shader
   *   frequency = exp(color.frequency + params.frequency)
   *   initial   = color.initial   + params.initial
   * A file that omits the global keys inherits the program's defaults
   * (initParams 00545d80.c:29: F = -ln(10), I = 0).  Carry them so the palette
   * can be reconstructed exactly, and so a round trip writes them back. */
  out.colorFreq = p.frequency != null ? Number(p.frequency) : REF_DEFAULT_LOG_FREQ;
  out.colorInit = p.initial != null ? Number(p.initial) : 0;
  if (p.brightnessfinite != null) out.briFinite = Number(p.brightnessfinite);
  if (p.brightnessinfinite != null) out.briInfinite = Number(p.brightnessinfinite);
  if (p.brightnessfactor != null) out.briFactor = Number(p.brightnessfactor);

  /* The shader.  `codegl` is the GLSL twin; `code` is HLSL and is only useful
   * as a fallback when a file predates the split. */
  const gl = typeof cs.codegl === 'string' ? cs.codegl : '';
  if (gl.trim()) out.glsl = gl;
  if (cs.samples != null) out.samples = Math.max(1, Math.min(4, Number(cs.samples) | 0));
  /* The scheme's channel contract travels with the shader: `compileColorscheme`
   * refuses to expose a member the mask does not declare. */
  if (cs.channels != null) out.channels = Number(cs.channels) >>> 0;
  if (cs.name) out.schemeName = String(cs.name).trim();
  /* A file may name one of the program's built-in schemes and ship no
   * `codegl` at all — Example 5 asks for "Distance and iteration levels" and
   * relies on the binary having it.  Carry the name through so the app can
   * install its own copy of that shader instead of falling back to a ramp. */
  if (!gl.trim() && cs.name) out.schemeBuiltin = String(cs.name).trim();
  /* The original UI shows exactly `nparam` sliders bound to params.param[]. */
  if (cs.nparam != null) out.nparam = Math.max(0, Math.min(4, Number(cs.nparam) | 0));
  if (Array.isArray(p.custom)) out.param = p.custom.map(Number).slice(0, 10);

  /* The reference keeps a second VIEWPORT for the Julia preview (00406070.c).
   * juliamode 0 = off, 1 = embedded window, 2 = full screen.  Its own centre,
   * zoom and rotation are separate from the Mandelbrot view. */
  if (p.juliamode != null) out.juliamode = Math.max(0, Math.min(2, Number(p.juliamode) | 0));
  if (obj.julia_zoom != null || obj.julia_rotation != null) {
    const jv = out.juliaView || {};
    if (obj.julia_zoom != null) jv.zoom = Number(obj.julia_zoom);
    if (obj.julia_rotation != null) jv.rotation = Number(obj.julia_rotation);
    out.juliaView = jv;
  }

  /* `flags` in the newer files carries the per-preset switches (inverse and
   * friends); the older `examples/*.json` put the same switch straight into
   * `parameters`, which is where Example 5 keeps its inverted colours. */
  if (obj.flags && typeof obj.flags === 'object') {
    if (obj.flags.inverse != null) out.inverse = !!obj.flags.inverse;
  }
  if (p.inverse != null) out.inverse = !!p.inverse;
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
 * including the HLSL twin (`code`) when the scheme came from a shipped preset
 * — a file we export has to be loadable by the original program, which reads
 * `code`, not `codegl`.
 */
export function exportRefPreset(v) {
  const span = v.span || { m: 1.6, e: 1 };
  const colors = (v.colors || []).map(c => {
    const o = {};
    if (c.r || c.g || c.b) o.rgb = [c.r, c.g, c.b];
    o.frequency = c.frequency != null ? c.frequency : 0;
    o.initial = c.initial != null ? c.initial : 0;
    return o;
  });

  const scheme = {};
  if (v.schemeName) scheme.name = v.schemeName;
  if (v.glsl) {
    scheme.codegl = v.glsl;
    /* The HLSL twin is a mechanical translation of the GLSL one, so exporting
     * a shader we imported keeps the original `code` verbatim when we have it
     * and otherwise emits a faithful float3/float4 spelling of the same body. */
    scheme.code = v.hlsl || glslToHlsl(v.glsl);
  }
  if (v.samples != null) scheme.samples = v.samples;
  if (v.channels != null) scheme.channels = v.channels;
  if (v.nparam != null) scheme.nparam = v.nparam;
  scheme.builtin = v.glsl ? 0 : (v.builtin != null ? v.builtin : 1);

  const params = {};
  params.juliamode = v.mode === 'j' ? 1 : 0;
  /* These two are the *global* log-frequency and phase that loadParams adds to
   * every colour.  Without them an exported file would be re-read with the
   * program's defaults and its whole palette would drift. */
  if (v.colorFreq != null) params.frequency = v.colorFreq;
  if (v.colorInit != null) params.initial = v.colorInit;
  params.colors = colors;
  if (v.glsl) params.colorscheme = scheme;
  else if (scheme.name) params.colorscheme = scheme;
  if (v.briFinite != null) params.brightnessfinite = v.briFinite;
  if (v.briInfinite != null) params.brightnessinfinite = v.briInfinite;
  if (v.briFactor != null) params.brightnessfactor = v.briFactor;
  if (Array.isArray(v.param) && v.param.length) params.custom = v.param;

  const out = {
    x: coordText(v.center && v.center.re, '0'),
    y: coordText(v.center && v.center.im, '0'),
    zoom: Number(spanToZoom(span).toPrecision(10)).toString(),
    rotation: v.rotation || 0,
    /* The Julia block always describes something usable: in Julia mode it is
     * the current view and the current seed, in Mandelbrot mode it is the
     * remembered Julia view (or the Mandelbrot centre, which is what the
     * reference itself does when a file has no Julia view yet). */
    julia_x: coordText(v.juliaView && v.juliaView.re, coordText(v.center && v.center.re, '-0.745428')),
    julia_y: coordText(v.juliaView && v.juliaView.im, coordText(v.center && v.center.im, '0.113009')),
    julia_zoom: v.juliaView && v.juliaView.zoom != null ? String(v.juliaView.zoom) : '0.500000000000000000',
    julia_rotation: v.juliaView && v.juliaView.rotation != null ? v.juliaView.rotation : -1.5707963267948966,
    julia_mx: coordText(v.julia && v.julia.re, coordText(v.center && v.center.re, '-0.745428')),
    julia_my: coordText(v.julia && v.julia.im, coordText(v.center && v.center.im, '0.113009')),
    parameters: params
  };
  if (v.animation) out.animation = v.animation;
  return out;
}

/**
 * GLSL -> HLSL for the common subset a colour scheme uses.
 *
 * This is deliberately a text translation of *our* dialect (the one the
 * reference's own `codegl` sources are written in), not a general compiler:
 * the vec/float type renames, mix/atan/fract/mod/exp, and the `Data` accessor
 * names are all identical between the two languages, which is why the mapping
 * is this short.
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
  // `vec4 color(Data data)` -> `float4 color(constant Params &params, Data input)`
  s = s.replace(/float4\s+color\s*\(\s*Data\s+(\w+)\s*\)/,
                'float4 color(constant Params &params, Data $1)');
  return s;
}
