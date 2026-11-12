/* ------------------------------------------------------------------
 * palettes.js — colour palettes (the CPU LUT and the GPU texture share one table)
 * Direction: scientific cartography / low saturation / seamlessly loopable; no neon pseudo-tech look
 * ----------------------------------------------------------------*/

const STOPS = {
  mono: [
    [0.06, 0.07, 0.08], [0.55, 0.57, 0.60], [0.95, 0.96, 0.97],
    [0.55, 0.57, 0.60], [0.06, 0.07, 0.08]
  ],
  graphite: [
    [0.10, 0.11, 0.12], [0.30, 0.32, 0.34], [0.68, 0.70, 0.73],
    [0.92, 0.93, 0.94], [0.68, 0.70, 0.73], [0.30, 0.32, 0.34], [0.10, 0.11, 0.12]
  ],
  ice: [
    [0.02, 0.05, 0.12], [0.06, 0.16, 0.30], [0.12, 0.36, 0.52],
    [0.35, 0.66, 0.78], [0.72, 0.88, 0.93], [0.97, 0.99, 1.00],
    [0.72, 0.88, 0.93], [0.35, 0.66, 0.78], [0.12, 0.36, 0.52], [0.02, 0.05, 0.12]
  ],
  copper: [
    [0.05, 0.03, 0.02], [0.22, 0.11, 0.05], [0.45, 0.23, 0.09],
    [0.72, 0.44, 0.18], [0.90, 0.68, 0.38], [0.98, 0.90, 0.76],
    [0.90, 0.68, 0.38], [0.72, 0.44, 0.18], [0.45, 0.23, 0.09], [0.05, 0.03, 0.02]
  ],
  ember: [
    [0.03, 0.02, 0.03], [0.18, 0.04, 0.06], [0.40, 0.07, 0.08],
    [0.68, 0.16, 0.09], [0.86, 0.35, 0.12], [0.95, 0.62, 0.30],
    [0.99, 0.86, 0.66], [0.95, 0.62, 0.30], [0.68, 0.16, 0.09], [0.18, 0.04, 0.06], [0.03, 0.02, 0.03]
  ],
  viridis: [
    [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530],
    [0.207, 0.372, 0.553], [0.164, 0.471, 0.558], [0.128, 0.567, 0.551],
    [0.135, 0.659, 0.518], [0.267, 0.749, 0.441], [0.478, 0.821, 0.318],
    [0.741, 0.873, 0.150], [0.993, 0.906, 0.144], [0.741, 0.873, 0.150],
    [0.478, 0.821, 0.318], [0.135, 0.659, 0.518], [0.164, 0.471, 0.558], [0.267, 0.005, 0.329]
  ],
  twilight: [
    [0.886, 0.850, 0.887], [0.741, 0.690, 0.831], [0.561, 0.494, 0.741],
    [0.384, 0.376, 0.702], [0.263, 0.333, 0.647], [0.192, 0.286, 0.549],
    [0.161, 0.226, 0.443], [0.149, 0.176, 0.353], [0.169, 0.153, 0.298],
    [0.224, 0.153, 0.278], [0.361, 0.184, 0.318], [0.549, 0.220, 0.353],
    [0.741, 0.290, 0.353], [0.886, 0.431, 0.318], [0.965, 0.612, 0.365],
    [0.993, 0.784, 0.529], [0.965, 0.902, 0.729], [0.886, 0.850, 0.887]
  ],
  ocean: [
    [0.02, 0.09, 0.14], [0.03, 0.19, 0.26], [0.05, 0.32, 0.36],
    [0.09, 0.46, 0.45], [0.24, 0.60, 0.52], [0.52, 0.76, 0.63],
    [0.83, 0.90, 0.80], [0.52, 0.76, 0.63], [0.24, 0.60, 0.52], [0.09, 0.46, 0.45], [0.02, 0.09, 0.14]
  ],
  sage: [
    [0.07, 0.09, 0.08], [0.16, 0.22, 0.17], [0.30, 0.38, 0.29],
    [0.50, 0.57, 0.44], [0.72, 0.75, 0.63], [0.90, 0.90, 0.82],
    [0.98, 0.97, 0.93], [0.90, 0.90, 0.82], [0.72, 0.75, 0.63], [0.50, 0.57, 0.44], [0.30, 0.38, 0.29], [0.07, 0.09, 0.08]
  ],
  spectrum: [
    [0.02, 0.03, 0.06], [0.10, 0.18, 0.45], [0.07, 0.36, 0.52],
    [0.10, 0.50, 0.42], [0.42, 0.55, 0.20], [0.72, 0.55, 0.14],
    [0.80, 0.32, 0.16], [0.62, 0.16, 0.28], [0.34, 0.10, 0.34],
    [0.14, 0.08, 0.24], [0.02, 0.03, 0.06]
  ],
  paper: [
    [0.96, 0.95, 0.92], [0.85, 0.82, 0.75], [0.70, 0.65, 0.55],
    [0.52, 0.47, 0.38], [0.33, 0.30, 0.25], [0.18, 0.16, 0.14],
    [0.09, 0.08, 0.07], [0.18, 0.16, 0.14], [0.33, 0.30, 0.25],
    [0.52, 0.47, 0.38], [0.70, 0.65, 0.55], [0.85, 0.82, 0.75], [0.96, 0.95, 0.92]
  ],
  slate: [
    [0.06, 0.07, 0.09], [0.12, 0.14, 0.18], [0.22, 0.25, 0.31],
    [0.38, 0.42, 0.50], [0.58, 0.62, 0.70], [0.78, 0.81, 0.86],
    [0.94, 0.95, 0.97], [0.78, 0.81, 0.86], [0.58, 0.62, 0.70],
    [0.38, 0.42, 0.50], [0.22, 0.25, 0.31], [0.06, 0.07, 0.09]
  ],
  orchid: [
    [0.05, 0.03, 0.07], [0.18, 0.08, 0.24], [0.34, 0.14, 0.38],
    [0.55, 0.26, 0.48], [0.74, 0.45, 0.58], [0.88, 0.66, 0.71],
    [0.96, 0.85, 0.86], [0.88, 0.66, 0.71], [0.74, 0.45, 0.58],
    [0.55, 0.26, 0.48], [0.34, 0.14, 0.38], [0.05, 0.03, 0.07]
  ]
};

/* The renderer owns the palette model: each entry names one of the built-in
 * `pal()` schemes in the native core, and `pal` is its index there.  The LUT
 * below is still what the picker paints its swatch with, so the gradient is a
 * preview of the hue family, not a byte-exact copy of the rendered colours. */
export const PALETTE_LIST = [
  { id: 'ice', en: 'Ice', zh: '冰蓝' },
  { id: 'mono', en: 'Monochrome', zh: '单色' },
  { id: 'graphite', en: 'Graphite', zh: '石墨' },
  { id: 'slate', en: 'Slate', zh: '石板' },
  { id: 'copper', en: 'Copper', zh: '铜' },
  { id: 'ember', en: 'Ember', zh: '余烬' },
  { id: 'viridis', en: 'Viridis', zh: '翠绿' },
  { id: 'ocean', en: 'Ocean', zh: '深海' },
  { id: 'sage', en: 'Sage', zh: '鼠尾草' },
  { id: 'twilight', en: 'Twilight', zh: '暮色' },
  { id: 'spectrum', en: 'Spectrum', zh: '光谱' },
  { id: 'orchid', en: 'Orchid', zh: '兰紫' },
  { id: 'paper', en: 'Paper', zh: '纸本' },
  /* The reference program's own schemes, transcribed from examples/*.json.
   * These are additive sinusoids, not ramps: pal() is a sum of
   * rgb_i * 0.5*(1+sin(iter*frequency_i + initial_i)). */
  { id: 'prism', en: 'Prism', zh: '三棱镜' },
  { id: 'amethyst', en: 'Amethyst', zh: '紫晶' },
  { id: 'nebula', en: 'Nebula', zh: '星云' },
  { id: 'veins', en: 'Rainbow Veins', zh: '虹脉' },
  { id: 'clock', en: 'Clockwork', zh: '时序' },
  { id: 'sine13', en: 'Deep Spectrum', zh: '深空光谱' },
  { id: 'engrave', en: 'Engraved', zh: '镌刻' }
];

/* ------------------------------------------------------------------
 * Additive schemes.
 *
 * A source JSON stores (r, g, b, frequency, initial) in the reference's own
 * *log* domain, NOT in the domain `pal()` reads.  Two pieces of evidence:
 *
 *   005472c0.c:138 / :210   parameters.frequency and colors[].frequency are
 *                           parsed verbatim into Params (log domain).
 *   00546630.c:79  / :87    loadParams uploads
 *                           params.color[i].frequency = exp(f_i + F)
 *                           params.color[i].initial   = init_i + I
 *                           to the shader, where F/I are the *global*
 *                           parameters.frequency / parameters.initial.
 *   00545d80.c:29           default F = -2.3025851 = -ln(10), I = 0.
 *
 * So a colour entry that the file writes as -2.12 with F = -3.51 is really
 * exp(-5.63) = 0.0036 rad/iteration, i.e. a ~1760-iteration rainbow band —
 * not a 3-iteration speckle.  Feeding the raw number straight into `pal()`
 * was the single biggest reason the official presets did not look like the
 * reference, and why zooming never swept through a rainbow: with 2–6
 * iteration periods the phase aliases instead of drifting.
 *
 * `COLORS[x].raw` keeps the file's literal numbers (export must write them
 * back verbatim, or the original program would apply exp() twice).
 * `COLORS[x].colors` holds the shader-ready values every renderer reads.
 * A missing rgb stays black, exactly as the reference's loader behaves.
 * brightnessfinite/infinite are the two region brightnesses.
 * ----------------------------------------------------------------*/

/** Default global log-frequency of the reference (00545d80.c:29). */
export const REF_DEFAULT_LOG_FREQ = -Math.LN10;

/** Convert a reference-domain colour table into what `pal()` actually reads. */
export function shaderTerms(colors, gf, gi) {
  const F = gf != null ? gf : REF_DEFAULT_LOG_FREQ;
  const I = gi != null ? gi : 0;
  return (colors || []).map(c => ({
    r: +c.r || 0, g: +c.g || 0, b: +c.b || 0,
    frequency: Math.exp((+c.frequency || 0) + F),
    initial: (+c.initial || 0) + I
  }));
}

/** Preserve the file's literal values; `source` is optional metadata. */
function refRecord(rec) {
  const gf = rec.gf != null ? rec.gf : REF_DEFAULT_LOG_FREQ;
  const gi = rec.gi || 0;
  const raw = rec.colors.map(c => ({
    r: c.r, g: c.g, b: c.b,
    frequency: c.frequency != null ? c.frequency : 0,
    initial: c.initial != null ? c.initial : 0
  }));
  return {
    briFinite: rec.briFinite, briInfinite: rec.briInfinite,
    gf, gi, raw,
    colors: shaderTerms(raw, gf, gi)
  };
}

const COLORS = {
  prism: {
    /* global log-frequency / phase from the source example */
    gf: -3.5148096084594727, gi: 0,
    briFinite: 1.0, briInfinite: 0.55,
    colors: [
      { r: 1, g: 0, b: 0, frequency: -2.1202636, initial: -1.0 },
      { r: 0, g: 1, b: 0, frequency: -1.1363142, initial: -1.5 },
      { r: 0, g: 0, b: 1, frequency: -0.0232686, initial: -0.5 }
    ]
  },
  amethyst: {
    briFinite: 1.0, briInfinite: 0.45,
    colors: [
      { r: 0.55, g: 0.25, b: 0.85, frequency: -2.0, initial: 0.0 },
      { r: 1.0, g: 0.75, b: 0.15, frequency: -1.5, initial: -0.3 }
    ]
  },
  nebula: {
    briFinite: 1.0, briInfinite: 0.40,
    colors: [
      { r: 0, g: 0.85, b: 1, frequency: -1.8, initial: 0.0 },
      { r: 1, g: 0.15, b: 0.6, frequency: -2.2, initial: -0.4 }
    ]
  },
  veins: {
    briFinite: 1.0, briInfinite: 0.40,
    colors: [
      { r: 0.8, g: 0.2, b: 1, frequency: -1.6, initial: 0.0 },
      { r: 0, g: 1, b: 0.7, frequency: -2.2, initial: -0.4 }
    ]
  },
  clock: {
    briFinite: 1.0, briInfinite: 0.498,
    colors: [
      { r: 0, g: 0.0298922, b: 1, frequency: -2.2056529, initial: 0.0 },
      { r: 1, g: 0, b: 0.0000005, frequency: -1.2836257, initial: -0.5 }
    ]
  },
  sine13: {
    /* global log-frequency / phase from the source example */
    gf: -2.0366196632385254, gi: -0.04542328044772148,
    briFinite: 1.02, briInfinite: 0.45,
    colors: [
      { r: 0, g: 0, b: 0, frequency: -1.0400593, initial: -1.6567906 },
      { r: 0, g: 0, b: 0, frequency: -0.4688427, initial: -1.9316331 },
      { r: 0, g: 0, b: 0, frequency: 0.2492582, initial: -0.3547057 },
      { r: 1, g: 0.9851013, b: 0, frequency: -2.6394658, initial: -2.1216540 },
      { r: 0, g: 1, b: 0.9913976, frequency: -1.8071216, initial: -1.5025265 },
      { r: 1, g: 0, b: 0.9428220, frequency: -3.0393176, initial: -2.2120402 }
    ]
  },
  engrave: {
    /* global log-frequency / phase from the source example */
    gf: -3.7335216999053955, gi: 0,
    briFinite: 1.0, briInfinite: 0.55,
    colors: [
      { r: 0.5, g: 0.5, b: 0.5, frequency: -1.7339181, initial: 0.0 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: -1.1228070, initial: 0.0 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: -0.0721248, initial: 0.0 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: -0.4634503, initial: -1.5707964 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: 0.7909357, initial: -1.5707964 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: 0.3245614, initial: -1.5707964 },
      { r: 0.9651463, g: 0.0302470, b: 0.8837509, frequency: -0.2007797, initial: -1.0543925 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: 0.4049708, initial: -1.5707964 },
      { r: 0.5, g: 0.5, b: 0.5, frequency: -0.0989279, initial: -1.5707964 }
    ]
  }
};

/* The shipped tables above are literal copies of the reference JSON.  Convert
 * them once here; from this point on every consumer (GPU uniforms, the CPU
 * LUT, swatches, the native bridge) sees shader-domain frequencies. */
for (const k of Object.keys(COLORS)) COLORS[k] = refRecord(COLORS[k]);

const LUT_SIZE = 512;
const lutCache = new Map();

/* ---------------- User-defined palettes ----------------
 * Kept in a registry separate from STOPS so a theme / language switch can
 * rebuild the UI without ever touching the user's own colour sets.
 * A registered id behaves exactly like a built-in one everywhere (LUT,
 * gradient CSS, native upload), so the render paths need no special case.
 * -------------------------------------------------------*/
const CUSTOM = new Map();   // id -> [[r,g,b], ...] in 0..1

function sameStops(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) return false;
  }
  return true;
}

export function registerCustomPalette(id, stops) {
  if (!id || !Array.isArray(stops) || stops.length < 2) return false;
  if (sameStops(CUSTOM.get(id), stops)) return true;
  CUSTOM.set(id, stops.map(c => [c[0], c[1], c[2]]));
  lutCache.delete(id);
  return true;
}

/**
 * Register an additive scheme — the reference program's own colour model, the
 * one its `parameters.colors` array describes: pal() is the sum of
 * `rgb_i * 0.5*(1+sin(iter*frequency_i + initial_i))`.
 *
 * Imported presets arrive in exactly that form, so they are registered as-is
 * rather than being resampled into a ramp: a ramp cannot represent the DC term
 * of a low-frequency component, and rounding frequencies to a fixed number of
 * samples is what makes imported presets look "close but wrong".
 */
export function registerAdditivePalette(id, colors, briFinite, briInfinite, label, opt) {
  if (!id || !Array.isArray(colors) || !colors.length) return false;
  const o = opt || {};
  COLORS[id] = refRecord({
    briFinite: briFinite != null ? briFinite : 1.0,
    briInfinite: briInfinite != null ? briInfinite : 1.0,
    gf: o.gf, gi: o.gi,
    colors: colors.slice(0, 20)
  });
  if (label) ADDITIVE_LABEL.set(id, label);
  lutCache.delete(id);
  return true;
}

/**
 * The literal JSON colour table and its two global keys.  Export writes these,
 * not the shader-domain values: the original program applies exp() itself.
 */
export function paletteRaw(id) {
  const c = COLORS[id];
  if (!c) return null;
  return {
    colors: (c.raw || []).map(k => ({ ...k })),
    gf: c.gf != null ? c.gf : REF_DEFAULT_LOG_FREQ,
    gi: c.gi || 0,
    briFinite: c.briFinite,
    briInfinite: c.briInfinite
  };
}

/** Human name of an imported additive scheme, for the preset list. */
const ADDITIVE_LABEL = new Map();
export function additiveLabel(id) { return ADDITIVE_LABEL.get(id) || null; }

export function isCustomPalette(id) { return CUSTOM.has(id); }

export function customPaletteStops(id) { return CUSTOM.get(id) || null; }

/** Stops of any palette (built-in or user-defined); null when unknown. */
/* A native palette entry may name a different stop table for its swatch
 * (`stops`), so `paletteStops` resolves that indirection once here. */
function stopTableFor(id) {
  const entry = PALETTE_LIST.find(p => p.id === id);
  if (entry && entry.stops && STOPS[entry.stops]) return STOPS[entry.stops];
  if (STOPS[id]) return STOPS[id];
  /* An additive scheme has no stop table of its own.  Sample its pal() over
   * exactly one slowest-term period so every downstream consumer — the CPU
   * LUT, the per-pixel GPU LUT, the native `stops` message and the swatch —
   * sees the same colours.  Returning null here made every official preset
   * fall back to STOPS.ice on the CPU path. */
  return sampledStops(id);
}

export function paletteStops(id) {
  if (CUSTOM.has(id)) return CUSTOM.get(id);
  return stopTableFor(id);
}

/* The same table with explicit positions.  The built-ins are stored evenly
 * spaced, but everything downstream — the gradient bar, the editor handles and
 * the native renderer — works on (position, colour) pairs, so the conversion
 * happens once here instead of in three places. */
export function paletteStopList(id) {
  const raw = paletteStops(id) || STOPS.ice;
  const last = Math.max(1, raw.length - 1);
  return raw.map((c, i) => ({ pos: raw.length > 1 ? i / last : 0, r: c[0], g: c[1], b: c[2] }));
}

/** CSS gradient for an arbitrary stop list (used by the editor bar). */
export function stopListGradientCSS(list) {
  const s = list && list.length ? list : paletteStopList('ice');
  const parts = s.map(c =>
    `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}) ${(c.pos * 100).toFixed(2)}%`);
  return `linear-gradient(90deg, ${parts.join(',')})`;
}

/** Smoothstep-blended colour at t in 0..1, matching the native sampler. */
export function sampleStopList(list, t) {
  if (!list || !list.length) return [0, 0, 0];
  const x = Math.min(0.999999, Math.max(0, t));
  let i = 0;
  while (i + 1 < list.length && list[i + 1].pos <= x) i++;
  const a = list[i];
  const b = list[i + 1] || a;
  let u = b.pos > a.pos ? (x - a.pos) / (b.pos - a.pos) : 0;
  u = Math.max(0, Math.min(1, u));
  u = u * u * (3 - 2 * u);
  return [a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u];
}

/** Resample a stop list into N evenly-spaced colours (for the worker LUT). */
export function resampleStops(list, n = 64) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(sampleStopList(list, i / n));
  return out;
}


/** One slowest-term period of pal(), in ITERATIONS.
 *
 * The reference's pal(iter) is a sum of sin(iter*f_i + init_i) with f_i in
 * radians per iteration.  The LUT is indexed by the colour position
 * u = fract(iter / cycle), so setting cycle to this span makes the 512-entry
 * table a faithful sample of pal() rather than a compression of it.  Clamped
 * because a pathological table (or a pure DC term) must not produce an
 * unusable iteration scale. */
export function paletteCycle(id) {
  const c = COLORS[id];
  if (!c) return 0;
  let minF = Infinity;
  for (const k of c.colors) {
    const f = Math.abs(k.frequency);
    if (f > 1e-6 && f < minF) minF = f;
  }
  return minF < Infinity ? Math.max(8, Math.min(4096, 2 * Math.PI / minF)) : 140;
}

/** The additive scheme behind an id, or null.  Returned as an array of
 *  {r,g,b,frequency,initial} with the two region brightnesses attached, so a
 *  caller can iterate it and still read the brightness figures. */
export function paletteColors(id) {
  const c = COLORS[id];
  if (!c) return null;
  const out = c.colors.map(k => ({ ...k }));
  out.briFinite = c.briFinite;
  out.briInfinite = c.briInfinite;
  return out;
}

/** Render an additive scheme as a ramp, for swatches and the web LUT.
 *  One period of the slowest component is sampled; the whole table is scaled
 *  by a single factor so the relative light and dark survives. */
function sampledStops(id) {
  const c = COLORS[id];
  if (!c) return null;
  /* The same span the caller uses as `cycle`, so u = iter/cycle addresses
   * exactly this table instead of squeezing it into a different period. */
  const span = paletteCycle(id);
  const N = 256, out = new Array(N);
  let peak = 1e-9;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * span;
    let r = 0, g = 0, b = 0;
    for (const k of c.colors) {
      const amp = 0.5 * (1 + Math.sin(t * k.frequency + k.initial));
      r += k.r * amp; g += k.g * amp; b += k.b * amp;
    }
    peak = Math.max(peak, r, g, b);
    out[i] = [r, g, b];
  }
  const kk = peak > 1 ? 1 / peak : 1;
  for (const s of out) { s[0] *= kk; s[1] *= kk; s[2] *= kk; }
  return out;
}

function smoothstep01(t) { return t * t * (3 - 2 * t); }

function buildLUT(id) {
  const stops = CUSTOM.get(id) || stopTableFor(id) || STOPS.ice;
  const lut = new Uint8Array(LUT_SIZE * 4);
  const n = stops.length - 1;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = (i / LUT_SIZE) * n;
    const i0 = Math.floor(t);
    const f = smoothstep01(t - i0);
    const a = stops[Math.min(i0, n)];
    const b = stops[Math.min(i0 + 1, n)];
    lut[i * 4 + 0] = Math.round((a[0] + (b[0] - a[0]) * f) * 255);
    lut[i * 4 + 1] = Math.round((a[1] + (b[1] - a[1]) * f) * 255);
    lut[i * 4 + 2] = Math.round((a[2] + (b[2] - a[2]) * f) * 255);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

export function paletteLUT(id) {
  let lut = lutCache.get(id);
  if (!lut) { lut = buildLUT(id); lutCache.set(id, lut); }
  return lut;
}

export function LUT_RESOLUTION() { return LUT_SIZE; }

/** Used by the UI preview swatch */
export function paletteGradientCSS(id) {
  const stops = CUSTOM.get(id) || STOPS[id] || sampledStops(id) || STOPS.ice;
  const parts = stops.map((c, i) =>
    `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}) ${(i / (stops.length - 1) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${parts.join(',')})`;
}

/** Interpolated sampling (float t, wraps over 0..1) */
export function sampleLUT(lut, t, out) {
  let x = (t - Math.floor(t)) * LUT_SIZE;
  let i = x | 0;
  const f = x - i;
  i = i % LUT_SIZE;
  const j = (i + 1) % LUT_SIZE;
  out[0] = lut[i * 4] + (lut[j * 4] - lut[i * 4]) * f;
  out[1] = lut[i * 4 + 1] + (lut[j * 4 + 1] - lut[i * 4 + 1]) * f;
  out[2] = lut[i * 4 + 2] + (lut[j * 4 + 2] - lut[i * 4 + 2]) * f;
  return out;
}
