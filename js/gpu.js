import { REFERENCE_COLORSCHEMES } from './colorschemes-data.js?v=28';

/* ------------------------------------------------------------------
 * gpu.js — the shading half of the renderer.
 *
 * The core computes an *iteration field*; this module turns that field into
 * pixels with GLSL.  That is the split the reference program uses, and it is
 * the reason its colour handling can be arbitrary: `color(Data)` in
 * `core_fractal.glsl` is a real shader fragment, and every preset shipped with
 * the program carries its own source in `parameters.colorscheme.codegl`.
 * A palette table can approximate those; only a shader can reproduce them.
 *
 * What lives here:
 *   - `buildFragment()`  assembles the reference's shader prefix, the
 *                        CHANNEL_* macros a scheme needs, its own color(),
 *                        and a main() that walks SAMPLES x SAMPLES subpixels.
 *   - `FieldRenderer`    owns the WebGL2 context, the field texture and the
 *                        program; draw() is one full-screen pass.
 *
 * Field layout (see mbc::Field): RGBA32F, one texel per frame pixel,
 *   r = smooth iteration, g = distance in pixels, b = escape count, a = dist2.
 * Interior pixels carry the negated period in r and b, which is exactly the
 * reference's `data.iter < 0` / `data.smoothiter < 0` convention.
 * ----------------------------------------------------------------*/

/* ---- Colorscheme objects -------------------------------------------------
 *
 * `colorscheme` (00531ab0) allocates the holder, `addcs` gives it its defaults,
 * `attachcs`/`detachcs` are the reference count, and `UniformsColorEqual`
 * (00545e20) is what tells the renderer it can skip an upload.  The JS objects
 * are garbage collected, but the *defaults* and the equality test are part of
 * the colour library's behaviour: a scheme created without a mask gets channel
 * 1 (iteration only), not "everything", and a colour table that did not change
 * is not re-uploaded.
 * ------------------------------------------------------------------------- */
export const COLORSCHEME_DEFAULTS = Object.freeze({
  name: '',
  codegl: '',
  nparam: 0,
  samples: 1,
  builtin: 0,
  channels: 0x1,             // addcs: channels = 1
  timedependent: false,      // addcs: false
  positiondependent: true,   // addcs: true
  auxfile: null
});

/** newColorscheme (005465d0) + addcs (00527c70). */
export function newColorscheme(fields = {}) {
  return { ...COLORSCHEME_DEFAULTS, refs: 1, active: 0, ...fields };
}

/** attachcs (00527cb0): one more owner, never clones the shader. */
export function attachColorscheme(cs) {
  cs.refs = (cs.refs | 0) + 1;
  return cs;
}

/** detachcs (00527cc0): drop an owner; the last one frees the scheme. */
export function detachColorscheme(cs) {
  cs.refs = (cs.refs | 0) - 1;
  if (cs.refs > 0) return cs;
  cs.active = 0;
  cs.program = null;
  return null;
}

/**
 * UniformsColorEqual (00545e20): exact equality of the three per-colour
 * members.  Bit-for-bit, because a tolerance would let a slider settle on a
 * value the shader never received.
 *
 * The reference's UniformsColor is { vec3 c; float initial; float frequency; };
 * our table entries carry the same three numbers flat (r/g/b, initial,
 * frequency), so this compares the fields, not the nesting.
 */
export function colorTableEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].frequency !== b[i].frequency || a[i].initial !== b[i].initial) return false;
    if (a[i].r !== b[i].r || a[i].g !== b[i].g || a[i].b !== b[i].b) return false;
  }
  return true;
}

/* ---- the scheme dictionary ----------------------------------------------
 *
 * `readColorschemes` (00547860) opens the library file, and when it is missing
 * or empty it seeds the dictionary with the program's five built-in schemes and
 * writes them straight back (00545cb0).  Every entry is a `Colorscheme` built by
 * `ColorschemeFromDictionary` (00547070), which rejects anything that is not a
 * dict with a string `name`, a string `codegl`, an optional string `aux`, and
 * numeric `samples` / `nparam` / `builtin` / `channels`; the mask is not
 * optional, because `compileColorscheme` needs it to emit the `CHANNEL_*`
 * block.  `DictionaryFromColorscheme` (00545b90) is the inverse, and it is
 * deliberately sparse the same way: `name`/`codegl` are omitted when empty,
 * `nparam` when zero, `aux` when there is no auxfile.
 *
 * The only thing that changes here is where the bytes live: the reference
 * writes a path, we write the same JSON array to localStorage, so a scheme the
 * user built survives a restart with the same round-trip semantics.
 * ------------------------------------------------------------------------- */

/** DictionaryFromColorscheme (00545b90): the on-disk shape of one scheme. */
export function dictionaryFromColorscheme(cs) {
  const d = {};
  if (cs.name != null && cs.name !== '') d.name = cs.name;
  if (cs.codegl != null && cs.codegl !== '') d.codegl = cs.codegl;
  if (cs.nparam) d.nparam = cs.nparam | 0;
  d.samples = cs.samples | 0 || 1;
  /* The reference writes DAT_0056bdd0 (1.0) for builtin and 0.0 otherwise. */
  d.builtin = cs.builtin ? 1 : 0;
  d.channels = cs.channels >>> 0;
  if (cs.auxfile != null && cs.auxfile !== '') d.aux = cs.auxfile;
  return d;
}

/**
 * ColorschemeFromDictionary (00547070): build a Colorscheme, or null.
 *
 * `opts.compile(cs)` stands in for `compileColorscheme`: the reference only
 * accepts a scheme whose shader compiles, so a caller with a live GL context
 * passes a compile callback and a rejected shader drops the entry.
 */
export function colorschemeFromDictionary(dict, opts = {}) {
  if (!dict || typeof dict !== 'object') return null;
  if (typeof dict.name !== 'string' || typeof dict.codegl !== 'string') return null;
  if (dict.aux != null && typeof dict.aux !== 'string') return null;
  const intOf = (key, dflt) => {
    const v = dict[key];
    if (v == null) return dflt;
    if (typeof v !== 'number' || !isFinite(v)) return NaN;
    return Math.trunc(v);
  };
  const samples = intOf('samples', 1);
  const nparam = intOf('nparam', 0);
  const channels = intOf('channels', NaN);
  const builtin = intOf('builtin', 0);
  /* `channels` has no default in the reference: a dict without a numeric mask
   * is rejected outright, because compileColorscheme cannot build its defines. */
  if (![samples, nparam, channels, builtin].every(Number.isFinite)) return null;
  const cs = newColorscheme({
    name: dict.name,
    codegl: dict.codegl,
    nparam: Math.max(0, nparam),
    samples: Math.max(1, samples),
    builtin: builtin !== 0 ? 1 : 0,
    channels: channels >>> 0,
    auxfile: dict.aux == null ? null : dict.aux
  });
  if (opts.compile && !opts.compile(cs)) return null;
  return cs;
}

/**
 * The schemes `readColorschemes` seeds an empty library with.
 *
 * These are the reference's own entries, taken from the library file it ships
 * (`00_原始项目副本/colorschemes.json`, carried verbatim in
 * `colorschemes-data.js`) rather than re-typed here: the six names, their
 * `samples`/`builtin`/`channels` numbers and the Texture entry's `aux` path are
 * exactly what that file states.  Going through `colorschemeFromDictionary`
 * also means the seed obeys the same validation as a library the user loads —
 * a hand-built list could drift from it without anyone noticing.
 */
export function referenceBuiltins(opts = {}) {
  const out = [];
  for (const dict of REFERENCE_COLORSCHEMES) {
    const cs = colorschemeFromDictionary(dict, opts);
    if (cs) out.push(cs);
  }
  return out;
}

/**
 * readColorschemes (00547860): parse the library, seeding it when empty.
 *
 * @param {string} json  the library text ('' when there is no file yet)
 * @param {object} opts  { textureFile, compile }
 * @returns {{dict: Map<string,object>, json: string|null, seeded: boolean}}
 *          `json` is the text to write back; null means "file was fine".
 */
export function readColorschemes(json, opts = {}) {
  const dict = new Map();
  let parsed = null;
  if (json) {
    try { parsed = JSON.parse(json); } catch { parsed = null; }
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const cs = colorschemeFromDictionary(item, opts);
      if (cs) dict.set(cs.name, cs);      // addjdict: later entries win
    }
  }
  if (dict.size === 0) {
    for (const cs of referenceBuiltins(opts)) dict.set(cs.name, cs);
    return { dict, json: writeColorschemes(dict), seeded: true };
  }
  return { dict, json: null, seeded: false };
}

/** writeColorschemes (00545cb0): the whole dictionary as one JSON array. */
export function writeColorschemes(dict) {
  const out = [];
  for (const cs of dict.values()) out.push(dictionaryFromColorscheme(cs));
  return JSON.stringify(out, null, 2) + '\n';
}

/* ---- channel mask ---------------------------------------------------------
 *
 * `compileColorscheme` (00546cd0) turns a scheme's `channels` bitfield into
 * preprocessor defines before it appends the scheme's own `codegl`:
 *
 *      1    -> CHANNEL_ITER          8    -> CHANNEL_ITERINT
 *      6    -> CHANNEL_VALUE         0x10 -> CHANNEL_DIST
 *      0x60 -> CHANNEL_DERIVATIVE    0x1000 -> CHANNEL_COORD
 *      0x100-> CHANNEL_SITER         0x80 -> CHANNEL_DIST2
 *      auxfile present -> AUX
 *
 * Two of those tests are wider than one bit (6 and 0x60), and reproducing the
 * test rather than tidying it into a single flag is what makes a preset's own
 * `channels` number mean the same thing it meant in the original program: a
 * preset that declares 2 or 4 also gets `data.value`, and one that declares
 * 32 or 64 also gets `data.derivative`.  The bitfield is a contract: a scheme
 * that reads a channel it did not declare does not compile, exactly as in the
 * reference.
 * ------------------------------------------------------------------------- */
export const CHANNEL = {
  ITER: 0x1,
  ITERINT: 0x8,
  VALUE: 0x6,
  DIST: 0x10,
  DERIVATIVE: 0x60,
  DIST2: 0x80,
  SITER: 0x100,
  COORD: 0x1000,
  AUX: 0x2000
};

/** The reference's `#define` block for one bitfield, in its own order. */
export function channelDefines(channels, opts = {}) {
  if (channels == null) return '';
  const c = channels >>> 0;
  const out = [];
  if (c & 1) out.push('#define CHANNEL_ITER');
  if (c & 8) out.push('#define CHANNEL_ITERINT');
  if (c & 6) out.push('#define CHANNEL_VALUE');
  if (c & 0x10) out.push('#define CHANNEL_DIST');
  if (c & 0x60) out.push('#define CHANNEL_DERIVATIVE');
  if (c & 0x1000) out.push('#define CHANNEL_COORD');
  if (c & 0x100) out.push('#define CHANNEL_SITER');
  if (c & 0x80) out.push('#define CHANNEL_DIST2');
  if (opts.aux) out.push('#define AUX');
  return out.join('\n');
}

/**
 * Recover a mask from a scheme body that shipped without one.
 *
 * Every preset in the reference carries `colorscheme.channels`, so this is a
 * fallback for hand-written schemes only.  It cannot express the wide-bit
 * aliases (a body reading `data.value` gets bit 2, which opens the same
 * macro), so it never disagrees with a real mask about which macros appear.
 */
export function inferChannels(src) {
  const s = String(src || '');
  let c = 0;
  if (/\bdata\s*\.\s*iter\b/.test(s)) c |= 1;
  if (/\bdata\s*\.\s*value\b/.test(s)) c |= 2;
  if (/\bdata\s*\.\s*derivative\b/.test(s)) c |= 0x20;
  if (/\bdata\s*\.\s*dist2\b/.test(s)) c |= 0x80;
  if (/\bdata\s*\.\s*dist\b/.test(s)) c |= 0x10;
  if (/\bdata\s*\.\s*smoothiter\b/.test(s)) c |= 0x100;
  if (/\bdata\s*\.\s*(coord|screencoord)\b/.test(s)) c |= 0x1000;
  return c;
}

/* The reference's own shader prefix, verbatim.  `M_PI_H` is spelled the way
 * the program spells it (3.1415926538, not Math.PI): pal()'s phase is
 * `mod(x, 2*M_PI_H)`, and using a different constant shifts every band by a
 * fraction of a cycle at high iteration counts.
 *
 * `Data` and the channel samplers are gated by exactly the macros above, so a
 * scheme sees only the members it declared. */
const PROLOGUE = `#version 300 es
precision highp float;
precision highp int;
`;

const PREFIX = `#define NCOLOR 20
#define NPARAM 10

#define M_PI_H 3.1415926538

struct UniformsColor
{
    vec3 c;
    float frequency;
    float initial;
};

struct Params
{
    int ncolor;
    UniformsColor color[NCOLOR];
    float brightnessfinite;
    float brightnessinfinite;
    float brightnessfactor;
    float param[NPARAM];
    float time;
    int auxwidth;
    int auxheight;
};

struct Uniforms
{
    vec2 p;
    vec2 j;
    vec2 d;
    float globalcorrection;
    bool julia;

    vec2 screencoordoffset;
    bool inverse;
};

uniform Params params;
uniform Uniforms uniforms;

struct Data
{
#ifdef CHANNEL_DIST
    float dist;
#endif
#ifdef CHANNEL_DIST2
    float dist2;
#endif
#ifdef CHANNEL_VALUE
    vec2 value;
#endif
#if defined(CHANNEL_ITER)||defined(CHANNEL_ITERINT)
    int iter;
#endif
#ifdef CHANNEL_SITER
    float smoothiter;
#endif
#ifdef CHANNEL_DERIVATIVE
    vec2 derivative;
#endif
#ifdef CHANNEL_II
    int ii;
#endif
#ifdef CHANNEL_COORD
    vec2 coord;
    vec2 screencoord;
#endif
    float pixelsize;
};

/* ---- channel storage ---------------------------------------------------
 * The reference keeps one single-channel texture per channel (tex_iter,
 * tex_smoothiter, tex_dist, tex_dist2, tex_value_x/y, tex_derivative_x/y) and
 * binds them in setup_shader (00404040).  We keep the same numbers packed in
 * two RGBA32F fields instead of eight textures:
 *
 *   tex_field   r = smoothiter   g = dist   b = iter   a = dist2
 *   tex_field2  r = value.x      g = value.y   (b/a unused: the reference
 *               reads derivative from the value textures, see main())
 *
 * Every accessor below returns exactly what texture2D(tex_x, tc).r returned
 * in the reference, so the template body is unchanged; only the storage is.
 * pixelsize is the reference's own encoding (see main()), so data.dist and
 * data.dist2 arrive in pixels in both programs.
 * ----------------------------------------------------------------------- */
uniform sampler2D tex_field;
uniform sampler2D tex_field2;
uniform vec2 uFieldSize;
uniform vec2 uScreenSize;
uniform vec2 uTileOrigin;
/* The reference's per-vertex colour alpha: pixelsize is
 * 4294967296 * gl_Color.a * globalcorrection.  Our field stores distance in
 * pixel units directly, which is this product evaluated at 1.0. */
uniform float uFieldAlpha;

/* AUX is the scheme's optional auxiliary image (colorscheme.auxfile).  The
 * reference enables it when that file is present; we enable it when the body
 * actually samples tex_aux, because the embedded scheme table does not carry
 * the file.  See the renderer for what is bound today. */
#ifdef AUX
uniform sampler2D tex_aux;
#endif

/* Gradient ramps (the editor's own colour model) travel as a small table.
 * It is declared unconditionally and simply optimised away by every scheme
 * that does not call ramp(). */
uniform vec4 uStops[32];
uniform int uStopN;

vec4 color(Data data);

/* One bilinear tap of a packed field, with the row order flipped: field row 0
 * is the top of the image, gl_FragCoord.y = 0 is the bottom. */
vec4 fieldAtEx(sampler2D tex, vec2 pixel)
{
    vec2 t = vec2(pixel.x, uFieldSize.y - 1.0 - pixel.y);
    t = clamp(t, vec2(0.0), uFieldSize - vec2(1.0));
    vec2 i0 = floor(t);
    vec2 f = t - i0;
    ivec2 a = ivec2(i0);
    ivec2 b = ivec2(min(i0 + 1.0, uFieldSize - 1.0));
    vec4 v00 = texelFetch(tex, ivec2(a.x, a.y), 0);
    vec4 v10 = texelFetch(tex, ivec2(b.x, a.y), 0);
    vec4 v01 = texelFetch(tex, ivec2(a.x, b.y), 0);
    vec4 v11 = texelFetch(tex, ivec2(b.x, b.y), 0);
    return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

vec3 pal(float iter, float brightness)
{
    vec3 c = vec3(0.0,0.0,0.0);
    for(int i=0;i<params.ncolor;i++)
    {
        float amplitude = 0.5*(1.0+sin(mod(iter*params.color[i].frequency+params.color[i].initial, 2.0*M_PI_H)));
        c += params.color[i].c*amplitude;
    }
    c*=brightness;
    float m = max(max(c.r,c.g),c.b);
    if(m>1.0)c /= m;
    return c;
}
`;

/* The reference loops `for(xx<SAMPLES) for(yy<SAMPLES)` and offsets the texture
 * coordinate by the *derivative* of the texture coordinate, i.e. by one pixel
 * divided by SAMPLES.  With a field texture that is a bilinear tap per sample,
 * which is what makes its filaments read as lines instead of stair steps. */
const MAIN = `
out vec4 fragColor;

void main()
{
    vec2 fc = gl_FragCoord.xy + uTileOrigin;
    vec4 acc = vec4(0.0);
    for(int yy=0;yy<SAMPLES;yy++)
    for(int xx=0;xx<SAMPLES;xx++)
    {
        vec2 off = (vec2(float(xx), float(yy)) + 0.5) / float(SAMPLES) - 0.5;
        vec2 tc = fc + off;
        vec4 f = fieldAtEx(tex_field, tc);

        Data data;

#ifdef CHANNEL_COORD
        vec2 z = tc;
        z.y *= -1.0;
        data.screencoord = z + uniforms.screencoordoffset;
        if(uniforms.julia)
            data.coord = uniforms.j;
        else
            data.coord = uniforms.p
            + vec2(uniforms.d.x*z.x, -uniforms.d.x*z.y)
            + vec2(uniforms.d.y*z.y, uniforms.d.y*z.x);
#endif

        /* Our iter channel is a float32 holding the count itself, so the
         * reference's fixed-point encode/decode pair is the identity here;
         * the sign convention (negative = negated period) is preserved. */
#if defined(CHANNEL_ITER)||defined(CHANNEL_ITERINT)
        data.iter = int(f.b);
#endif
#ifdef CHANNEL_SITER
        data.smoothiter = f.r;
#endif
        data.pixelsize = 4294967296.0*uFieldAlpha*uniforms.globalcorrection;
#ifdef CHANNEL_DIST
        data.dist = f.g*data.pixelsize;
#endif
#ifdef CHANNEL_DIST2
        data.dist2 = f.a*data.pixelsize;
#endif
#if defined(CHANNEL_VALUE)||defined(CHANNEL_DERIVATIVE)
        vec4 f2 = fieldAtEx(tex_field2, tc);
#endif
#ifdef CHANNEL_VALUE
        data.value = f2.rg;
#endif
        /* The reference reads data.derivative from *the value textures*
         * (core_fractal.glsl:161-164 reads tex_value_x/tex_value_y into both
         * members; tex_derivative_x/y are declared in setup_shader but never
         * sampled).  Reproducing the alias rather than "fixing" it: a scheme
         * written against the reference's behaviour sees the same numbers. */
#ifdef CHANNEL_DERIVATIVE
        data.derivative = f2.rg;
#endif
        acc += color(data);
    }
    acc /= float(SAMPLES*SAMPLES);
    if(uniforms.inverse) acc.rgb = vec3(1.0,1.0,1.0)-acc.rgb;
    fragColor = acc;
}
`;

/* ---- the schemes ---------------------------------------------------------
 *
 * The first four are the reference's own `color()` bodies, transcribed from
 * 02_还原的着色器源码/complete/*.frag.  They run unchanged because the field
 * carries exactly the channels they read.
 * ------------------------------------------------------------------------*/
export const BUILTIN = {
  /* The gradient ramp, expressed as a shader so it lives on the same footing
   * as everything else.  param[0] = iterations per cycle, param[1] = phase
   * offset in cycles.  Without this the editor's ramps would need a second
   * colour path on the GPU, and two paths is how the two halves drift. */
  ramp: {
    name: 'Gradient ramp',
    channels: CHANNEL.SITER,
    src: `vec3 ramp(float t)
{
    t = fract(t);
    if(uStopN <= 1) return uStops[0].yzw;
    for(int i=0;i<uStopN-1;i++)
    {
        float a = uStops[i].x;
        float b = uStops[i+1].x;
        if(t >= a && t <= b)
        {
            float u = (b > a) ? (t - a) / (b - a) : 0.0;
            return mix(uStops[i].yzw, uStops[i+1].yzw, u);
        }
    }
    return uStops[uStopN-1].yzw;
}

vec4 color(Data data)
{
    float ipc = max(params.param[0], 0.02);
    float it = (data.smoothiter >= 0.0) ? data.smoothiter : -data.smoothiter;
    float bri = (data.smoothiter >= 0.0) ? params.brightnessfinite
                                         : params.brightnessinfinite;
    vec3 c = ramp(it / ipc + params.param[1]) * bri;
    float m = max(max(c.r,c.g),c.b);
    if(m > 1.0) c /= m;
    return vec4(c, 1.0);
}`
  },
  iteration: {
    name: 'Iteration',
    channels: CHANNEL.ITER,
    src: `vec4 color(Data data)
{
    vec3 c;
    if(data.iter>=0)
        c = pal(float(data.iter)+0.5, params.brightnessfinite/params.brightnessfactor);
    else
        c = pal(float(-data.iter)+0.5, params.brightnessinfinite/params.brightnessfactor);
    return vec4(c, 1.0);
}`
  },
  smooth: {
    name: 'Smooth',
    channels: CHANNEL.SITER,
    src: `vec4 color(Data data)
{
    vec3 c;
    if(data.smoothiter>=0.0)
        c = pal(data.smoothiter+0.5, params.brightnessfinite/params.brightnessfactor);
    else
        c = pal(-data.smoothiter+0.5, params.brightnessinfinite/params.brightnessfactor);
    return vec4(c, 1.0);
}`
  },
  distance: {
    name: 'Distance',
    channels: CHANNEL.ITER | CHANNEL.DIST,
    src: `vec4 color(Data data)
{
    vec3 color;
    if(data.iter<0)
        color = pal(float(-data.iter)+0.5, params.brightnessinfinite/params.brightnessfactor);
    else
        color = vec3(0.0,0.0,0.0);

    vec3 color2;
    float rr = data.dist*exp(5.0*params.param[0]);
    if(rr<1.0&&rr!=0.0)color2 = vec3(1.0-rr, 1.0-rr, 1.0-rr); else color2 = vec3(0.0,0.0,0.0);

    vec3 c = color+color2*params.brightnessfinite;
    return vec4(c, 1.0);
}`
  },
  distanceLevels: {
    name: 'Distance and iteration levels',
    channels: CHANNEL.ITER | CHANNEL.DIST | CHANNEL.DIST2,
    src: `vec4 color(Data data)
{
    vec3 color, color2;
    if(data.iter<0)
    {
        color = pal(float(-data.iter)+0.5, params.brightnessinfinite/params.brightnessfactor);
    }
    else
    {
        float rr = data.dist2*exp(5.0*params.param[1]-1.5);
        if(rr<1.0&&rr!=0.0)color = (1.0-rr)*pal(float(data.iter)+0.5, params.brightnessfinite/params.brightnessfactor); else color = vec3(0.0,0.0,0.0);
    }

    float rr2 = data.dist*exp(5.0*params.param[0]);
    if(rr2<1.0&&rr2!=0.0)color2 = vec3(1.0-rr2, 1.0-rr2, 1.0-rr2); else color2 = vec3(0.0,0.0,0.0);

    vec3 c = color+color2*params.brightnessfinite;
    return vec4(c, 1.0);
}`
  },
  /* The reference's fifth built-in (`Texture`, channels 0x1007): the only one
   * that reads `data.value`, the orbit's own z at the escape iteration, and
   * `data.coord`, its c.  It keeps iterating z^2+c for twenty more steps and
   * maps (log|z|, arg z) onto one tile of the 4x4 auxiliary image, so the
   * colour is a property of *where the orbit was*, not how long it took. */
  texture: {
    name: 'Texture',
    channels: CHANNEL.ITER | CHANNEL.VALUE | CHANNEL.COORD,
    samples: 1,
    src: `#define NTEXTURE 15

vec4 color(Data data)
{

    vec3 c;
    if(data.iter>=0)
    {
        vec2 value = data.value;
        float x1s, y1s, len; int i;

        float limit = exp((-params.param[0]+0.33)*5.0);

        x1s = value.x*value.x; y1s = value.y*value.y;
        len = x1s+y1s;

        for(i=data.iter;i<data.iter+20;i++)
        {
            if(len>limit)break;
            value.y = value.x*value.y*2.0;
            value.x = x1s - y1s;
            value += data.coord;

            x1s = value.x*value.x; y1s = value.y*value.y;
            len = x1s+y1s;
        }

        vec2 v; float fi = mod(float(i),float(NTEXTURE));
        v.y = atan(value.y,value.x)/M_PI_H*6.0;
        v.x = -0.5*(log(len)-log(limit))/M_PI_H*6.0;
        v.x = fract(v.x); v.y = fract(v.y);
        v.x = (v.x+mod(fi,4.0))/4.0;
        v.y = (v.y+3.0-float(int(fi)/4))/4.0;

        c = vec3(texture(tex_aux, v).rgb);
    }
    else
        c = pal(float(-data.iter)+0.5, params.brightnessinfinite/params.brightnessfactor);
    return vec4(c, 1.0);
}`
  },
  /* Orbit-trap colouring.
   *
   * Everything above is a function of *how long* the orbit took to escape.
   * A trap is a function of *where the orbit went*, so its level sets follow
   * the orbit's near-misses rather than the escape time — that is what keeps
   * the filigree readable at any zoom instead of dissolving into one hue.  The
   * kernel accumulates the statistic in the field's fourth channel (see
   * Ctx::wantTrap), which is why this costs no extra pass.
   *
   * param[0] = trap gain (how tight the bands hug the trap)
   * param[1] = ring count
   */
  trap: {
    name: 'Orbit trap',
    channels: CHANNEL.ITER | CHANNEL.SITER | CHANNEL.DIST2,
    src: `vec4 color(Data data)
{
    if(data.iter < 0)
    {
        /* Inside, the period is the only structure there is. */
        vec3 ic = pal(float(-data.iter)+0.5, params.brightnessinfinite/params.brightnessfactor);
        return vec4(ic*0.45, 1.0);
    }
    float t = abs(data.dist2);
    float gain = max(params.param[0], 0.02)*6.0;
    float a = pow(clamp(t*gain, 0.0, 1.0), 0.22);
    float rings = params.param[1] > 0.0 ? params.param[1]*8.0 + 2.0 : 5.0;
    float band = fract(a*rings + params.time*0.02);

    vec3 c1 = pal(data.smoothiter*0.35 + a*26.0, params.brightnessfinite/params.brightnessfactor);
    vec3 c2 = pal(a*47.0 + data.smoothiter*0.07 + 0.5, params.brightnessinfinite/params.brightnessfactor);
    vec3 c = mix(c2, c1, smoothstep(0.0, 1.0, band));

    /* Glow where the orbit came closest: that is the trap surface itself, and
     * it is the line the eye reads as a filament. */
    c *= 0.30 + 0.70*pow(1.0 - a, 2.5);
    return vec4(c, 1.0);
}`
  }
};

/* ------------------------------------------------------------------
 * Shader assembly.
 *
 * `codegl` sources from the reference's own presets are GLSL 1.10 written for
 * the same `Params`/`Data`/`pal()` surroundings, so they compile here with two
 * mechanical rewrites: `float3/float4/float2` (the HLSL twin is stored next to
 * it under `code`) are normalised to vec*, and `texture2D` becomes `texture`.
 * Anything the scheme itself would have needed from an older GLSL is left
 * alone — if it does not compile, `compile()` reports the log verbatim.
 * ----------------------------------------------------------------*/
export function normaliseScheme(src) {
  let s = String(src || '');
  if (!s.trim()) return '';
  // Strip a HlslShader `float4 color(constant Params &params, Data input)`
  // body if it slipped in; only the GLSL half is usable.
  if (/constant\s+Params/.test(s) && !/vec4\s+color\s*\(\s*Data/.test(s)) return '';
  s = s.replace(/\bfloat4\b/g, 'vec4').replace(/\bfloat3\b/g, 'vec3')
       .replace(/\bfloat2\b/g, 'vec2');
  s = s.replace(/\btexture2D\s*\(/g, 'texture(');
  /* GLSL 1.10 lets a precision qualifier stand in front of a type *inside an
   * expression* — `highp float(data.iter)` — which ES 3.00 rejects.  Dropping
   * the qualifier is what the reference's own compiler did implicitly by
   * defaulting to highp for float, so this changes no arithmetic.  A
   * `precision highp float;` statement is a different construct and is kept. */
  s = s.split('\n').map(line => /^\s*precision\s/.test(line) ? line
    : line.replace(/\b(?:highp|mediump|lowp)\s+(?=(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234])\b)/g, '')
  ).join('\n');
  return s;
}

/**
 * Build a complete fragment shader for one scheme source.
 *
 * @param {string} schemeSrc  body containing `vec4 color(Data data)`
 * @param {object} opts       { samples, channels, aux, canvasSize }
 * @returns {string} GLSL ES 3.00 source
 */
export function buildFragment(schemeSrc, opts = {}) {
  const samples = Math.max(1, Math.min(4, opts.samples | 0 || 1));
  const src = normaliseScheme(schemeSrc);
  if (!/vec4\s+color\s*\(\s*Data/.test(src)) {
    throw new Error('scheme has no `vec4 color(Data data)` definition');
  }
  /* A scheme that ships no mask is inferred from the members it reads; the
   * reference never needs this because every Colorscheme in its dictionary
   * carries `channels`. */
  const channels = opts.channels == null ? inferChannels(src) : opts.channels;
  let defines = channelDefines(channels, { aux: opts.aux || /\btex_aux\b/.test(src) });
  defines += `\n#define SAMPLES ${samples}`;
  if (opts.canvasSize) defines += `\n#define CANVASSIZE ${opts.canvasSize | 0}`;
  return PROLOGUE + defines + '\n' + PREFIX + src + '\n' + MAIN;
}

/* ------------------------------------------------------------------
 * FieldRenderer
 * ----------------------------------------------------------------*/
export class FieldRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      /* true so the 2D fallback can snapshot this canvas with drawImage()
       * (gesture feedback and PNG export both go through the 2D path). */
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    });
    this.ok = !!this.gl;
    this.program = null;
    this.tex = null;
    this.fieldW = 0;
    this.fieldH = 0;
    this.samples = 1;
    this.schemeKey = '';
    this.uniformCache = new Map();
    this.lastError = '';
    if (this.ok) {
      const gl = this.gl;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      /* tex_field2 carries the value plane: two floats per texel (z at the
       * escape point), so RG32F rather than RGBA32F.  Both halves of a field
       * arrive as one buffer and are uploaded as subarray views.  It starts as
       * a 1x1 zero so a scheme that declares those channels while the kernel
       * supplied no value plane reads zero instead of whatever the driver
       * leaves in an unbound unit. */
      this.tex2 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex2);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 1, 1, 0, gl.RG, gl.FLOAT,
                    new Float32Array(2));
      this.auxW = 0;
      this.auxH = 0;
      /* tex_aux stands in for a Colorscheme's auxfile image.  The embedded
       * scheme table does not carry those files, so the unit holds a 1x1
       * opaque white texel: a scheme that samples it still compiles and its
       * non-texture terms are exact. */
      this.texAux = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texAux);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA,
                    gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }
  }

  /** Compile a scheme.  Returns '' on success, the driver log otherwise. */
  setScheme(schemeSrc, samples, channels) {
    if (!this.ok) return 'no webgl2';
    const gl = this.gl;
    const s = Math.max(1, Math.min(4, samples | 0 || 1));
    const ch = channels == null ? inferChannels(normaliseScheme(schemeSrc)) : channels;
    const key = String(schemeSrc) + '|' + s + '|' + (ch >>> 0);
    if (key === this.schemeKey && this.program) return '';
    const frag = buildFragment(schemeSrc, { samples: s, channels: ch });
    const vs = `#version 300 es
void main()
{
    /* One oversized triangle covers the viewport with no vertex buffer. */
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const v = this._shader(gl.VERTEX_SHADER, vs);
    const f = this._shader(gl.FRAGMENT_SHADER, frag);
    if (!v || !f) {
      this.lastError = this._log;
      if (v) gl.deleteShader(v);
      if (f) gl.deleteShader(f);
      return this.lastError;
    }
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      this.lastError = gl.getProgramInfoLog(p) || 'link failed';
      gl.deleteProgram(p);
      return this.lastError;
    }
    if (this.program) gl.deleteProgram(this.program);
    this.program = p;
    this.schemeKey = key;
    this.samples = s;
    this.uniformCache.clear();
    /* Every uniform of a freshly linked program starts at zero, so the colour
     * table has to be uploaded to it even when its contents did not change.
     * `colorTableEqual` only pins which table the *previous* program was given
     * (a 2546x1324 pass links a second program because its sample count
     * differs from the preview's), so without this reset that pass keeps the
     * zeroed table and `pal()` returns black for the whole frame. */
    this.colorN = -1;
    this.colorCache = null;
    this.lastError = '';
    return '';
  }

  _shader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      this._log = (gl.getShaderInfoLog(sh) || 'compile failed');
      // Keep the numbered source around: a driver log without it is useless.
      this._log += '\n--- source ---\n' +
        src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' ' + l).join('\n');
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  /** Upload a whole-frame field (Float32Array, w*h*4, row-major top first). */
  uploadField(data, w, h) {
    if (!this.ok) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (w !== this.fieldW || h !== this.fieldH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
      this.fieldW = w;
      this.fieldH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data);
    }
  }

  /**
   * Upload the value plane (Float32Array, w*h*2: z.r, z.i at the escape point).
   * The reference keeps value_x and value_y as two single-channel textures and
   * reads both into `data.value` and `data.derivative`; one RG32F holds the same
   * numbers.
   */
  uploadAux(data, w, h) {
    if (!this.ok || !data) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex2);
    if (w !== this.auxW || h !== this.auxH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, data);
      this.auxW = w;
      this.auxH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RG, gl.FLOAT, data);
    }
  }

  /**
   * Upload the auxfile image — the reference's 2048x2048 texturesgl.jpg, which
   * the Texture scheme carves into a 4x4 grid of 15 tiles.  Tiling happens in
   * the scheme's own uv arithmetic, so the sampler must clamp, not repeat.
   * Returns false when the context is not up yet.
   */
  uploadAuxImage(img) {
    if (!this.ok || !img || !img.width) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texAux);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.auxImage = { w: img.width, h: img.height };
    return true;
  }

  resize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  _loc(name) {
    let l = this.uniformCache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.uniformCache.set(name, l);
    }
    return l;
  }

  /**
   * Draw the field.
   *
   * `p` mirrors the reference's Params/Uniforms pair:
   *   colors      [{r,g,b,frequency,initial}]  the scheme's own palette terms
   *   briFinite / briInfinite / briFactor
   *   param       number[10]
   *   time
   *   julia, inverse
   *   p, d        centre and scale, for schemes that read data.coord
   *   screencoordoffset
   */
  draw(p = {}) {
    if (!this.ok || !this.program || !this.fieldW) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const cols = p.colors || [];
    const n = Math.min(20, cols.length);
    const L = this._loc('params.ncolor');
    if (L) gl.uniform1i(L, n);
    /* UniformsColorEqual: a table that has not changed is not uploaded again.
     * This is the reference's own test, and it is what keeps a slider drag from
     * rewriting sixty uniforms per frame. */
    if (n !== this.colorN || !colorTableEqual(this.colorCache, cols.slice(0, n))) {
      for (let i = 0; i < n; i++) {
        const c = cols[i];
        const lc = this._loc('params.color[' + i + '].c');
        if (lc) gl.uniform3f(lc, c.r, c.g, c.b);
        const lf = this._loc('params.color[' + i + '].frequency');
        if (lf) gl.uniform1f(lf, c.frequency != null ? c.frequency : 0);
        const li = this._loc('params.color[' + i + '].initial');
        if (li) gl.uniform1f(li, c.initial != null ? c.initial : 0);
      }
      this.colorCache = cols.slice(0, n);
      this.colorN = n;
    }
    const set1 = (name, v) => {
      const l = this._loc(name);
      if (l) gl.uniform1f(l, v);
    };
    set1('params.brightnessfinite', p.briFinite != null ? p.briFinite : 1);
    set1('params.brightnessinfinite', p.briInfinite != null ? p.briInfinite : 1);
    set1('params.brightnessfactor', p.briFactor != null ? p.briFactor : 1);
    set1('params.time', p.time != null ? p.time : 0);
    const lp = p.param || [];
    for (let i = 0; i < 10; i++) {
      const l = this._loc('params.param[' + i + ']');
      if (l) gl.uniform1f(l, lp[i] != null ? lp[i] : 0);
    }
    const lb = this._loc('uniforms.julia');
    if (lb) gl.uniform1i(lb, p.julia ? 1 : 0);
    const linv = this._loc('uniforms.inverse');
    if (linv) gl.uniform1i(linv, p.inverse ? 1 : 0);
    const lgc = this._loc('uniforms.globalcorrection');
    /* 2^-32 is the value that turns the reference's encoding into a no-op on a
     * field whose distance channel is already in pixels. */
    if (lgc) gl.uniform1f(lgc, p.globalCorrection != null ? p.globalCorrection
                                                       : 2.3283064365386963e-10);
    const lsc = this._loc('uniforms.screencoordoffset');
    if (lsc) {
      const o = p.screencoordoffset || [0, 0];
      gl.uniform2f(lsc, o[0], o[1]);
    }
    const lpp = this._loc('uniforms.p');
    if (lpp) gl.uniform2f(lpp, p.centerRe || 0, p.centerIm || 0);
    const ld = this._loc('uniforms.d');
    if (ld) gl.uniform2f(ld, p.scaleX || 0, p.scaleY || 0);
    const lj = this._loc('uniforms.j');
    if (lj) gl.uniform2f(lj, p.juliaRe || 0, p.juliaIm || 0);

    /* `pixelsize` is the reference's 4294967296 * gl_Color.a *
     * globalcorrection.  Our field stores the distance in pixel units already,
     * so the product has to come out at exactly 1: gl_Color.a is 1 and
     * globalcorrection is 2^-32 (the default set below).  A caller may shift
     * either factor, and `data.dist` then scales with it, which is the
     * reference's behaviour too. */
    const lfa = this._loc('uFieldAlpha');
    if (lfa) gl.uniform1f(lfa, p.fieldAlpha != null ? p.fieldAlpha : 1);
    const fs = this._loc('uFieldSize');
    if (fs) gl.uniform2f(fs, this.fieldW, this.fieldH);
    const ss = this._loc('uScreenSize');
    if (ss) gl.uniform2f(ss, this.canvas.width, this.canvas.height);
    const to = this._loc('uTileOrigin');
    if (to) gl.uniform2f(to, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const lt = this._loc('tex_field');
    if (lt) gl.uniform1i(lt, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex2);
    const lt2 = this._loc('tex_field2');
    if (lt2) gl.uniform1i(lt2, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texAux);
    const lta = this._loc('tex_aux');
    if (lta) gl.uniform1i(lta, 2);

    /* Gradient ramp table: [pos, r, g, b] x n, already sorted by the caller. */
    const stops = p.stops || [];
    const ns = Math.min(32, stops.length);
    const lu = this._loc('uStops');
    if (lu && ns > 0) {
      const flat = new Float32Array(ns * 4);
      for (let i = 0; i < ns; i++) {
        const st = stops[i];
        flat[i * 4 + 0] = st.pos;
        flat[i * 4 + 1] = st.r;
        flat[i * 4 + 2] = st.g;
        flat[i * 4 + 3] = st.b;
      }
      gl.uniform4fv(lu, flat);
    }
    const lsn = this._loc('uStopN');
    if (lsn) gl.uniform1i(lsn, ns);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read the canvas back as RGBA bytes (for PNG export / thumbnails). */
  readPixels() {
    if (!this.ok) return null;
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { data: buf, w, h };
  }
}
