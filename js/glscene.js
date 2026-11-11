/* ------------------------------------------------------------------
 * glscene.js — the whole fractal in one fragment shader.
 *
 * The reference program is a *volume shader* benchmark in spirit: every pixel
 * traces its own orbit inside the fragment shader, and the CPU never touches
 * a pixel.  The web build up to now has been the opposite — one JS worker per
 * tile, palette LUT inside the tile loop — which is why a phone spends a
 * second on a frame the GPU finishes in ten milliseconds.
 *
 * What this module owns:
 *   - a full-screen triangle and two fragment programs, one iterating in
 *     float32 (`fast`, every formula family) and one in double-float (`df64`,
 *     two floats = 48 bits, z^2+c only);
 *   - the screen→plane transform, including the view rotation the CPU tile
 *     path never implemented;
 *   - the exact smooth-iteration normalisation of drawlib.js and the exact
 *     512-entry palette table the workers build, so a GL frame and a CPU frame
 *     of the same view are the same picture, not merely a similar one.
 *
 * The `df64` program exists because a float32 coordinate cannot even hold
 * `center + pixel*ps` once ps < 1e-7: the offset is smaller than the ulp of
 * the centre and every pixel of the frame collapses onto one value.  Two
 * floats per component carry ~2^-48, which reaches a 1e-14 pixel size — the
 * point where the perturbed CPU path (reference orbit + series) takes over.
 *
 * `precision highp float` is mandatory: without it the driver may evaluate the
 * orbit in fp16 and the set dissolves.
 * ----------------------------------------------------------------*/

import { paletteLUT } from './palettes.js';

const BAIL2 = 1e20;                        // drawlib.BAIL2
const LOG_BAIL = 23.025850929940457;       // ln(1e10), drawlib.LOG_BAIL
const LUT_SIZE = 512;

const VERT = `#version 300 es
void main()
{
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* Shared GLSL.  `DF` selects the double-float program. */
function fragSrc(df) {
  return `#version 300 es
precision highp float;
precision highp int;

uniform vec2  uRes;        // canvas size in device pixels
uniform vec4  uCen;        // centre: hi.re, hi.im, lo.re, lo.im
uniform float uPixel;      // plane units per device pixel
uniform vec2  uRot;        // cos, sin of the view rotation
uniform float uMaxIter;
uniform int   uPower;
uniform int   uKind;       // 0 poly 1 tricorn 2 burning 3 celtic 4 perp 5 phoenix
uniform int   uJulia;
uniform vec4  uSeed;       // Julia seed, same hi/lo packing
uniform float uCycle;
uniform float uOffset;
uniform float uInvLogPower;
uniform float uPhoenix;
uniform vec3  uInterior;
uniform sampler2D uLut;
uniform int   uSamples;
uniform int   uDebug;      // 1: paint (n, nu+64, m2*1e-20) instead of colour

out vec4 outColor;

#if ${df ? 1 : 0}
/* ---- double-float (df64) ------------------------------------------------
 * A value is a vec2 (hi, lo) with |lo| <= ulp(hi)/2: 48 significant bits.
 * Dekker's split keeps the product error exact without an FMA (GLSL ES has
 * none).  GLSL forbids reassociation, which is the only reason these survive
 * the optimiser. */
vec2 dfSet(float a) { return vec2(a, 0.0); }
vec2 dfSplit(float a) {
  float t = a * 4097.0;                 // 2^12 + 1
  float hi = t - (t - a);
  return vec2(hi, a - hi);
}
vec2 dfTwoProd(float a, float b) {
  float p = a * b;
  vec2 A = dfSplit(a), B = dfSplit(b);
  float e = ((A.x * B.x - p) + A.x * B.y + A.y * B.x) + A.y * B.y;
  return vec2(p, e);
}
vec2 dfQuickTwoSum(float a, float b) {
  float s = a + b;
  return vec2(s, b - (s - a));
}
vec2 dfTwoSum(float a, float b) {
  float s = a + b;
  float bb = s - a;
  float e = (a - (s - bb)) + (b - bb);
  return vec2(s, e);
}
vec2 dfAdd(vec2 a, vec2 b) {
  vec2 s = dfTwoSum(a.x, b.x);
  return dfQuickTwoSum(s.x, s.y + a.y + b.y);
}
vec2 dfSub(vec2 a, vec2 b) {
  vec2 s = dfTwoSum(a.x, -b.x);
  return dfQuickTwoSum(s.x, s.y + a.y - b.y);
}
vec2 dfMul(vec2 a, vec2 b) {
  vec2 p = dfTwoProd(a.x, b.x);
  return dfQuickTwoSum(p.x, p.y + a.x * b.y + a.y * b.x);
}
vec2 dfMulF(vec2 a, float b) { return dfMul(a, dfSet(b)); }
bool dfLt(vec2 a, vec2 b) {
  if (a.x != b.x) return a.x < b.x;
  return a.y < b.y;
}

/* Main cardioid (period 1) and the period-2 disc.  A quarter of the home frame
 * lives here and can never escape, so iterating it is pure waste.  Evaluated
 * in df because a float32 boundary is a visible staircase at depth. */
bool insideBulb(vec2 cr, vec2 ci) {
  vec2 x  = dfSub(cr, dfSet(0.25));
  vec2 y2 = dfMul(ci, ci);
  vec2 q  = dfAdd(dfMul(x, x), y2);
  vec2 l  = dfMul(q, dfAdd(q, x));
  if (dfLt(l, dfMulF(y2, 0.25))) return true;
  vec2 u = dfAdd(cr, dfSet(1.0));
  return dfLt(dfAdd(dfMul(u, u), y2), dfSet(0.0625));
}
#else
vec2 dfSet(float a) { return vec2(a, 0.0); }
bool insideBulb(vec2 c) {
  float x = c.x - 0.25;
  float y2 = c.y * c.y;
  float q = x * x + y2;
  if (q * (q + x) <= 0.25 * y2) return true;
  float u = c.x + 1.0;
  return (u * u + y2) <= 0.0625;
}
#endif

/* ---- palette ------------------------------------------------------------
 * One 512x1 RGBA8 texture: the same table the workers build (paletteLUT), so
 * a shader frame and a CPU frame cannot drift apart in colour. */
vec3 lut(float t) {
  float u = t - floor(t);
  float ix = u * ${LUT_SIZE}.0;
  int i0 = int(ix);
  if (i0 >= ${LUT_SIZE}) i0 = ${LUT_SIZE - 1};
  if (i0 < 0) i0 = 0;
  float f = ix - float(i0);
  int j0 = (i0 + 1) & ${LUT_SIZE - 1};
  vec3 a = texelFetch(uLut, ivec2(i0, 0), 0).rgb;
  vec3 b = texelFetch(uLut, ivec2(j0, 0), 0).rgb;
  return mix(a, b, f);
}

float gNu = 0.0;
vec3 shadeEscape(int n, float m2)
{
  float nu = log(0.5 * log(max(m2, 1e-30)) / ${LOG_BAIL.toFixed(15)}) * uInvLogPower;
  gNu = nu;
  float t = float(n) + 1.0 - (nu == nu ? nu : 0.0);
  t = t * (1.0 / max(uCycle, 1.0)) + uOffset;
  return lut(t);
}

/* ---- one sub-pixel sample ----------------------------------------------
 * Interior pixels keep the CPU's flat colour; the every-32-steps period check
 * is the tile kernel's own shortcut, kept so a bounded orbit never burns the
 * whole iteration budget. */
vec3 sampleAt(vec2 pix)
{
  vec2 d = (pix - 0.5 * uRes) * uPixel;
  d = vec2(d.x * uRot.x - d.y * uRot.y, d.x * uRot.y + d.y * uRot.x);

#if ${df ? 1 : 0}
  /* z^2 + c only: the folded families have no closed-form screen offset to
   * preserve, so they stay on the float program (and on the CPU past its
   * precision). */
  vec2 cr = dfAdd(dfTwoSum(uCen.x, d.x), dfSet(uCen.z));
  vec2 ci = dfAdd(dfTwoSum(uCen.y, d.y), dfSet(uCen.w));
  if (uDebug == 4) return vec3((cr.x + cr.y) * 0.25 + 0.5, (ci.x + ci.y) * 0.25 + 0.5, 0.0);
  if (uJulia == 0 && insideBulb(cr, ci)) return uInterior;

  vec2 zr = uJulia == 1 ? cr : dfSet(0.0);
  vec2 zi = uJulia == 1 ? ci : dfSet(0.0);
  vec2 chR = dfSet(0.0), chI = dfSet(0.0);
  bool chkOn = false;
  float m2 = 0.0;
  int limit = int(uMaxIter);
  int n = 0;
  for (; n < limit; ++n) {
    vec2 nr = dfSub(dfMul(zr, zr), dfMul(zi, zi));
    vec2 ni = dfMulF(dfMul(zr, zi), 2.0);
    zr = dfAdd(nr, cr);
    zi = dfAdd(ni, ci);
    m2 = zr.x * zr.x + zi.x * zi.x;
    if (m2 > ${BAIL2.toExponential(1)}) break;
    if (n == 7) { chR = zr; chI = zi; chkOn = true; }
    else if (chkOn && (n & 31) == 0) {
      if (dfLt(dfAdd(dfMul(dfSub(zr, chR), dfSub(zr, chR)),
                     dfMul(dfSub(zi, chI), dfSub(zi, chI))), dfSet(1e-30)))
        return uInterior;
    }
  }
  if (n >= limit) return uInterior;
#else
  vec2 c = uCen.xy + d;
  if (uDebug == 4) return vec3(c.x * 0.25 + 0.5, c.y * 0.25 + 0.5, 0.0);
  vec2 z = uJulia == 1 ? c : vec2(0.0);
  vec2 k = uJulia == 1 ? uSeed.xy : c;
  if (uKind == 0 && uJulia == 0 && insideBulb(c)) return uInterior;

  vec2 prev = vec2(0.0);
  vec2 chk = vec2(0.0);
  bool chkOn = false;
  float m2 = 0.0;
  int limit = int(uMaxIter);
  int n = 0;
  for (; n < limit; ++n) {
    vec2 z0 = z;
    if (uPower == 2) z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
    else {
      vec2 acc = z;
      for (int e = 2; e < 8; ++e) {
        if (e >= uPower) break;
        acc = vec2(acc.x * z.x - acc.y * z.y, acc.x * z.y + acc.y * z.x);
      }
      z = acc;
    }
    if (uKind == 1) z.y = -z.y;                       // tricorn: conj(z)^p
    else if (uKind == 2) z = vec2(abs(z.x), abs(z.y)); // burning ship
    else if (uKind == 3) z.x = abs(z.x);               // celtic
    if (uKind == 5) z += prev * uPhoenix;              // phoenix
    prev = z0;
    if (uKind == 2) z += vec2(-k.x, k.y);
    else if (uKind == 4) z += vec2(k.x, -k.y);         // perpendicular
    else z += k;
    m2 = z.x * z.x + z.y * z.y;
    if (m2 > ${BAIL2.toExponential(1)}) break;
    if (n == 7) { chk = z; chkOn = true; }
    else if (chkOn && (n & 31) == 0) {
      vec2 dd = z - chk;
      if (dot(dd, dd) < 1e-30) return uInterior;
    }
  }
  if (n >= limit) return uInterior;
#endif
  if (uDebug == 3) {
    /* n in [0,2048] over one byte, nu (which lives in [0,1]) over the next. */
    float nu3 = log(0.5 * log(max(m2, 1e-30)) / ${LOG_BAIL.toFixed(15)}) * uInvLogPower;
    return vec3(clamp(float(n) / 2048.0, 0.0, 1.0), nu3, 0.0);
  }
  if (uDebug == 2) {
    /* fract(t) is what the palette actually consumes; if this matches the CPU
     * and the picture still differs, the table is the suspect. */
    float nu2 = log(0.5 * log(max(m2, 1e-30)) / ${LOG_BAIL.toFixed(15)}) * uInvLogPower;
    float tt = (float(n) + 1.0 - nu2) * (1.0 / max(uCycle, 1.0)) + uOffset;
    float fr = tt - floor(tt);
    return vec3(fr, float(n & 255) / 255.0, float(n >> 8) / 255.0);
  }
  if (uDebug == 1) {
    /* Two bytes of n plus nu in [0,1]: 8-bit channels lose everything if the
     * value is scaled, so n is split instead of divided. */
    shadeEscape(n, m2);
    return vec3(float(n & 255) / 255.0, float(n >> 8) / 255.0, clamp(gNu, 0.0, 1.0));
  }
  /* A single squaring can jump from just under the bail-out to Inf, and
   * log(Inf) turns the palette index into NaN — which the driver writes as
   * pure black.  Clamping the magnitude is exact for every pixel that is
   * actually finite and keeps the impossible ones a colour. */
  return shadeEscape(n, min(m2, 1e30));
}

/* Interleaved gradient noise (Jimenez 2014): a screen-space dither sequence
 * with no texture lookups and no visible pattern at one-LSB amplitude.
 *
 * The canvas is 8-bit, and a smooth gradient quantised to 256 levels shows
 * Mach bands — evenly spaced "steps" the eye invents at low contrast, which is
 * exactly what a deep palette ramp looks like without this.  Adding half a
 * level of IGN noise before the write breaks the bands up into a dither the
 * eye integrates back into a smooth ramp.  Amplitude is deliberately 1/255:
 * any larger and a still frame reads as grainy, which is a different defect. */
float ditherNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main()
{
  vec3 acc = vec3(0.0);
  int s = uSamples;
  for (int sy = 0; sy < 2; ++sy) {
    if (sy >= s) break;
    for (int sx = 0; sx < 2; ++sx) {
      if (sx >= s) break;
      vec2 off = (s == 1) ? vec2(0.0)
                          : (vec2(float(sx), float(sy)) + 0.5) / float(s) - 0.5;
      acc += sampleAt(gl_FragCoord.xy + off);
    }
  }
  vec3 c = acc / float(s * s);
  c += (ditherNoise(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}`;
}

export class SceneRenderer {
  constructor(gl) {
    this.gl = gl;
    this.ok = !!gl;
    this.progs = { fast: null, df: null };
    this.uni = { fast: {}, df: {} };
    this.lutTex = null;
    this.lutKey = '';
    this.lastError = '';
    this.canvasW = 0;
    this.canvasH = 0;
    /* Past ~20k iterations one frame stops being interactive, and the CPU
     * kernel has the series approximation the shader lacks. */
    this.maxIterCap = 20000;
    if (this.ok) this.vao = gl.createVertexArray();
  }

  _compile(df) {
    const gl = this.gl;
    const key = df ? 'df' : 'fast';
    if (this.progs[key]) return this.progs[key];
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        this.lastError = (gl.getShaderInfoLog(s) || 'compile failed').slice(0, 600);
        gl.deleteShader(s);
        return null;
      }
      return s;
    };
    const v = sh(gl.VERTEX_SHADER, VERT);
    const f = sh(gl.FRAGMENT_SHADER, fragSrc(df));
    if (!v || !f) { if (v) gl.deleteShader(v); if (f) gl.deleteShader(f); return null; }
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      this.lastError = (gl.getProgramInfoLog(p) || 'link failed').slice(0, 600);
      gl.deleteProgram(p);
      return null;
    }
    this.progs[key] = p;
    this.uni[key] = {};
    return p;
  }

  _u(key, name) {
    const c = this.uni[key];
    if (c[name] === undefined) c[name] = this.gl.getUniformLocation(this.progs[key], name);
    return c[name];
  }

  /** Upload the 512x1 palette table (RGBA8, exactly paletteLUT's bytes). */
  setPalette(lut, key) {
    if (!this.ok) return false;
    if (key && key === this.lutKey && this.lutTex) return true;
    const gl = this.gl;
    if (!this.lutTex) {
      this.lutTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, 1, 0, gl.RGBA,
                  gl.UNSIGNED_BYTE, lut);
    this.lutKey = key || '';
    return true;
  }

  /**
   * Draw one frame.
   *
   * view = { centerRe, centerIm, pixel, rot, width, height, maxIter, power,
   *          kind, julia, seedRe, seedIm, cycle, offset, phoenix, samples }
   * The centre and seed arrive as doubles; the hi/lo split happens here so the
   * shader gets the bits it cannot derive from a float.
   */
  draw(view) {
    if (!this.ok) return { ok: false, why: 'no-webgl2' };
    const gl = this.gl;
    const t0 = performance.now();

    /* Precision tier: float32 holds 24 bits, so `center + k*pixel` survives
     * only while pixel > ulp(center) ~ 1e-7.  Below that the df64 program runs,
     * and past its 1e-14 reach the caller keeps the CPU path. */
    const needDf = Math.abs(view.pixel) < 1e-4;
    const kind = view.kind | 0;
    if (needDf && kind !== 0) return { ok: false, why: 'df-kind' };
    const key = needDf ? 'df' : 'fast';
    const prog = this._compile(needDf);
    if (!prog) return { ok: false, why: 'shader: ' + this.lastError };

    const W = Math.max(1, view.width | 0), H = Math.max(1, view.height | 0);
    this.canvasW = W; this.canvasH = H;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);

    const U = (n) => this._u(key, n);
    const split = (v) => {
      const hi = Math.fround(v || 0);
      return [hi, Math.fround((v || 0) - hi)];
    };
    gl.uniform2f(U('uRes'), W, H);
    const [crH, crL] = split(view.centerRe);
    const [ciH, ciL] = split(view.centerIm);
    gl.uniform4f(U('uCen'), crH, ciH, crL, ciL);
    const [srH, srL] = split(view.seedRe);
    const [siH, siL] = split(view.seedIm);
    gl.uniform4f(U('uSeed'), srH, siH, srL, siL);
    gl.uniform1f(U('uPixel'), Math.abs(view.pixel) || 1e-3);
    const rot = view.rot || 0;
    gl.uniform2f(U('uRot'), Math.cos(rot), Math.sin(rot));
    const iter = Math.max(1, Math.min(this.maxIterCap, view.maxIter | 0));
    gl.uniform1f(U('uMaxIter'), iter);
    const pw = Math.max(2, Math.min(8, (view.power | 0) || 2));
    gl.uniform1i(U('uPower'), pw);
    gl.uniform1i(U('uKind'), Math.max(0, Math.min(5, kind)));
    gl.uniform1i(U('uJulia'), view.julia ? 1 : 0);
    gl.uniform1f(U('uCycle'), Math.max(1, +view.cycle || 1));
    gl.uniform1f(U('uOffset'), +view.offset || 0);
    gl.uniform1f(U('uInvLogPower'), 1 / Math.log(pw));
    gl.uniform1f(U('uPhoenix'), view.phoenix == null ? 0.5667 : +view.phoenix);
    gl.uniform3f(U('uInterior'), 5 / 255, 6 / 255, 9 / 255);
    gl.uniform1i(U('uSamples'), Math.max(1, Math.min(2, (view.samples | 0) || 1)));
    gl.uniform1i(U('uDebug'), view.debug | 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(U('uLut'), 0);

    /* A previous pass may have left an error in the queue; a stale one would
     * report this frame as failed. */
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const err = gl.getError();
    const ms = performance.now() - t0;
    if (err) return { ok: false, why: 'gl ' + err, ms };
    return { ok: true, ms, program: key, iter };
  }
}

/** Palette bytes for a palette descriptor. */
export function lutFor(palette) {
  return paletteLUT(palette);
}
