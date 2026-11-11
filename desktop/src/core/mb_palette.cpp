// ------------------------------------------------------------------
// mb_palette.cpp — field value in, RGBA out.
//
// Two palette models share one tone stage:
//
//   additive   c = sum_i rgb_i * 0.5*(1 + sin(iter*freq_i + init_i))
//   ramp       c = gradient(iter / cycle)
//
// Both are baked into a lookup table once per frame (one entry per iteration,
// or a 256-entry ramp) and sampled per pixel, because the sinusoid sums are
// otherwise the most expensive arithmetic in the frame.  Each table also
// carries a mip chain: sampling a level instead of level 0 is how a band
// thinner than a pixel becomes its own average colour instead of moire.
//
// The fourteen built-in schemes live at the bottom, transcribed from the
// reference program's own examples rather than invented here.
// ------------------------------------------------------------------
#include "mb_internal.h"

namespace mbc {
namespace detail {

/* Mip chain of a palette table.  Level 0 is the exact table; level k is the
 * box average of 2^k neighbouring entries.  Sampling level k is how the
 * renderer asks for "the mean colour of the phase interval this pixel covers"
 * in constant time, which is what stops bands finer than a pixel from turning
 * into moiré.  Averaging in *palette phase* (rather than in screen space) is
 * the right domain: the aliasing comes from the palette being sampled below
 * its own frequency, not from the geometry. */

void buildMip(const std::vector<float>& src, bool cyclic, Mip& m) {
  m.lv.clear();
  m.cyclic = cyclic;
  m.base = (int)(src.size() / 3);
  if (m.base < 4) return;
  m.lv.push_back(src);
  while ((int)(m.lv.back().size() / 3) > 4) {
    const std::vector<float>& s = m.lv.back();
    const int n = (int)(s.size() / 3);
    const int hn = std::max(1, n / 2);
    std::vector<float> d((size_t)hn * 3, 0.0f);
    for (int i = 0; i < hn; ++i) {
      int a = 2 * i, b = 2 * i + 1;
      if (cyclic) { a %= n; b %= n; }
      else { a = std::min(a, n - 1); b = std::min(b, n - 1); }
      d[(size_t)i * 3 + 0] = 0.5f * (s[(size_t)a * 3 + 0] + s[(size_t)b * 3 + 0]);
      d[(size_t)i * 3 + 1] = 0.5f * (s[(size_t)a * 3 + 1] + s[(size_t)b * 3 + 1]);
      d[(size_t)i * 3 + 2] = 0.5f * (s[(size_t)a * 3 + 2] + s[(size_t)b * 3 + 2]);
    }
    m.lv.push_back(std::move(d));
  }
}

/* Bilinear read of one mip level.  `x` is a position in level-0 units. */
void mipAt(const Mip& m, int level, double x, double& r, double& g,
                  double& b) {
  const std::vector<float>& t = m.lv[(size_t)level];
  const int n = (int)(t.size() / 3);
  double y = x / (double)(1 << level);
  int i, j;
  double u;
  if (m.cyclic) {
    y -= std::floor(y / (double)n) * (double)n;
    i = (int)y;
    if (i >= n) i = n - 1;
    j = (i + 1) % n;
    u = y - (double)i;
  } else {
    if (!(y >= 0.0)) y = 0.0;
    const double last = (double)n - 1.000001;
    if (y > last) y = last;
    i = (int)y;
    j = i + 1 < n ? i + 1 : n - 1;
    u = y - (double)i;
  }
  const float* a = t.data() + (size_t)i * 3;
  const float* c = t.data() + (size_t)j * 3;
  r = (double)a[0] + ((double)c[0] - a[0]) * u;
  g = (double)a[1] + ((double)c[1] - a[1]) * u;
  b = (double)a[2] + ((double)c[2] - a[2]) * u;
}

/* Sample the table with a box of half-width `half` level-0 entries centred on
 * `x`.  Half-width 0 is plain bilinear; larger widths blend towards the
 * matching mip level, so the cost stays at two taps no matter how wide the
 * kernel is. */
void mipSample(const Mip& m, double x, double half, double& r, double& g,
                      double& b) {
  if (m.lv.empty()) { r = g = b = 0.0; return; }
  if (m.lv.size() < 2 || !(half > 0.5)) { mipAt(m, 0, x, r, g, b); return; }
  double level = std::log2(2.0 * half);
  const double top = (double)(m.lv.size() - 1);
  if (level > top) level = top;
  if (level < 0.0) level = 0.0;
  const int k0 = (int)level;
  const double f = level - (double)k0;
  double r0, g0, b0;
  mipAt(m, k0, x, r0, g0, b0);
  if (f < 1e-4) { r = r0; g = g0; b = b0; return; }
  double r1, g1, b1;
  mipAt(m, k0 + 1 > (int)top ? (int)top : k0 + 1, x, r1, g1, b1);
  r = r0 + (r1 - r0) * f;
  g = g0 + (g1 - g0) * f;
  b = b0 + (b1 - b0) * f;
}


/* --- colour ----------------------------------------------------------
 *
 * Two palette models share one tone stage:
 *
 *   mode 0  c = sum_i rgb_i * 0.5*(1 + sin(iter*freq_i + init_i))
 *   mode 1  c = ramp(iter / cycle mod 1)          <- gradient handles
 *
 * followed by  saturation -> contrast -> gamma -> gain -> brightness ->
 * hue-preserving normalise.  The normalise is the reference program's own
 * `m = max(c); if (m > 1) c /= m` and is the reason a bright scheme never
 * turns into flat white blobs: dividing by the largest component keeps the
 * hue and the relative contrast, where a per-channel clamp would not.
 * ------------------------------------------------------------------- */

/* Tone that does not depend on the region: baked into the gradient LUT once
 * per frame, and applied per pixel on the sinusoid path. */
inline void tonePrep(const Palette& P, double& r, double& g, double& b) {
  if (P.saturation != 1.0f) {
    const double lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const double s = (double)P.saturation;
    r = lum + (r - lum) * s;
    g = lum + (g - lum) * s;
    b = lum + (b - lum) * s;
  }
  if (P.contrast != 1.0f) {
    const double c = (double)P.contrast;
    r = (r - 0.5) * c + 0.5;
    g = (g - 0.5) * c + 0.5;
    b = (b - 0.5) * c + 0.5;
  }
  if (P.gamma != 1.0f) {
    const double ig = 1.0 / (double)P.gamma;
    r = std::pow(std::max(r, 0.0), ig);
    g = std::pow(std::max(g, 0.0), ig);
    b = std::pow(std::max(b, 0.0), ig);
  }
  r *= (double)P.gainR;
  g *= (double)P.gainG;
  b *= (double)P.gainB;
}

/* Region brightness, then the hue-preserving normalise and the clamp. */
inline void toneFinish(double brightness, double& r, double& g, double& b) {
  r *= brightness;
  g *= brightness;
  b *= brightness;
  const double m = std::max(r, std::max(g, b));
  if (m > 1.0) {
    r /= m;
    g /= m;
    b /= m;
  }
  if (!(r >= 0.0)) r = 0.0;
  if (!(g >= 0.0)) g = 0.0;
  if (!(b >= 0.0)) b = 0.0;
}

/* Last-resort kernel: iterate one pixel directly at arbitrary precision.


/* sin() on the palette's phase is the single most expensive call in the frame
 * (P.n calls per pixel).  The phase is already reduced to [0,2pi); folding it
 * into [-pi/2,pi/2] makes a degree-13 Taylor polynomial accurate to <1e-9,
 * which is three orders of magnitude below one 8-bit colour step.  The
 * reduction is exact in the GLSL sense (sin(pi - x) = sin(x)). */
inline double fastSin(double a) {
  if (a > 1.5707963267948966) a = 3.141592653589793 - a;
  else if (a < -1.5707963267948966) a = -3.141592653589793 - a;
  const double z = a * a;
  return a * (1.0 + z * (-1.0 / 6.0 + z * (1.0 / 120.0 + z * (
         -1.0 / 5040.0 + z * (1.0 / 362880.0 + z * (
         -1.0 / 39916800.0 + z * (1.0 / 6227020800.0)))))));
}

/* pal() — the reference's additive palette, evaluated at `iter` iterations. */
inline void palRGB(const Palette& P, double iter, double brightness,
                   double& r, double& g, double& b) {
  const double twoPi = 6.283185307179586;
  const double invTwoPi = 0.15915494309189535;
  r = g = b = 0.0;
  for (int i = 0; i < P.n; ++i) {
    const PaletteColor& c = P.c[i];
    double a = (double)c.frequency * iter + (double)c.initial;
    a -= twoPi * std::floor(a * invTwoPi);       // mod(a, 2pi), GLSL semantics
    if (a > 3.141592653589793) a -= twoPi;       // [-pi, pi] for the fold
    const double amp = 0.5 * (1.0 + fastSin(a));
    r += (double)c.r * amp;
    g += (double)c.g * amp;
    b += (double)c.b * amp;
  }
  tonePrep(P, r, g, b);
  toneFinish(brightness, r, g, b);
}

/* A gradient ramp sampled from a 256-entry LUT: the LUT is built once per
 * frame with the tone already baked in, so a pixel only pays a lerp. */
inline void gradRGB(const float* lut, double t, double brightness,
                    double& r, double& g, double& b) {
  double f = t - std::floor(t);
  if (!(f >= 0.0) || f >= 1.0) f = 0.0;
  const double x = f * 256.0;
  int i = (int)x;
  if (i > 255) i = 255;
  const double u = x - (double)i;
  const int j = (i + 1) & 255;
  r = lut[i * 3 + 0] + ((double)lut[j * 3 + 0] - lut[i * 3 + 0]) * u;
  g = lut[i * 3 + 1] + ((double)lut[j * 3 + 1] - lut[i * 3 + 1]) * u;
  b = lut[i * 3 + 2] + ((double)lut[j * 3 + 2] - lut[i * 3 + 2]) * u;
  toneFinish(brightness, r, g, b);
}

/* Bake the additive palette over the whole iteration range of this frame.
 *
 * pal() is a sum of sinusoids in `iterations`, so it is a one-dimensional
 * function; evaluating it per pixel costs P.n sin() calls plus the tone stage.
 * Twelve samples per iteration resolves the fastest component (a ~6-iteration
 * wave) more than seventy times per cycle, so a linear interpolation between
 * neighbours is accurate to well under one 8-bit step.  The table is built
 * once per frame and only ever read, which also keeps it out of the threads'
 * cache-line traffic. */
void buildAdditiveLut(const Palette& P, double ipc, double offset, int maxIter,
                      int visLo, int visHi, std::vector<float>& lut,
                      double& scale) {
  const double range = (double)maxIter + 3.0;
  int n = (int)std::ceil(range * 12.0);
  if (n > (1 << 20)) n = 1 << 20;         // 12 MB ceiling
  if (n < 256) n = 256;
  scale = (double)n / range;
  lut.assign((size_t)n * 3, 0.0f);
  const double twoPi = 6.283185307179586;
  const double invTwoPi = 0.15915494309189535;
  const double ipcSafe = ipc > 0.0 ? ipc : 1.0;
  for (int i = 0; i < n; ++i) {
    const double iters = (double)i / scale;
    const double iterArg = (iters / ipcSafe + offset) * (double)P.cycleRef;
    double r = 0.0, g = 0.0, b = 0.0;
    for (int k = 0; k < P.n; ++k) {
      const PaletteColor& c = P.c[k];
      double a = (double)c.frequency * iterArg + (double)c.initial;
      a -= twoPi * std::floor(a * invTwoPi);
      if (a > 3.141592653589793) a -= twoPi;
      const double amp = 0.5 * (1.0 + fastSin(a));
      r += (double)c.r * amp;
      g += (double)c.g * amp;
      b += (double)c.b * amp;
    }
    tonePrep(P, r, g, b);
    lut[(size_t)i * 3 + 0] = (float)r;
    lut[(size_t)i * 3 + 1] = (float)g;
    lut[(size_t)i * 3 + 2] = (float)b;
  }

  /* A scheme whose components all happen to sit near their troughs for the
   * whole frame reads as a flat dark wash, which is what a raw pal() with
   * small amplitudes does — the shipped examples compensate with
   * brightnessfinite above 1.  Rather than hand-tuning every transcription,
   * lift a genuinely dim table to the same peak the tuned schemes have,
   * using the 99th percentile so one stray peak cannot darken the rest.
   * Bright schemes are left alone: toneFinish still clips them. */
  if (n > 8) {
    int lo = std::max(0, (int)((double)visLo * scale));
    int hi = (int)((double)visHi * scale);
    if (hi <= lo + 8 || hi > n) { lo = 0; hi = n - 1; }
    std::vector<float> peaks((size_t)(hi - lo + 1));
    for (int i = lo; i <= hi; ++i) {
      const float* p = lut.data() + (size_t)i * 3;
      peaks[(size_t)(i - lo)] = std::max(p[0], std::max(p[1], p[2]));
    }
    const size_t k99 = (size_t)((double)(peaks.size() - 1) * 0.99);
    std::nth_element(peaks.begin(), peaks.begin() + k99, peaks.end());
    const double p99 = (double)peaks[k99];
    /* One global exposure per frame: the 99th percentile lands just below
     * clipping.  A multi-term pal() either saturates (sum > 1 for most of the
     * cycle, which is what "washed out" looks like) or sits in the troughs,
     * and neither is a property worth shipping per palette.  Scaling the whole
     * table by one factor keeps every hue and every relative brightness. */
    /* One exposure per palette, measured on the table the frame actually
     * uses.  `brightness` is applied later, per region, so it belongs in the
     * figure: a scheme designed to peak at 0.55 of the sum must not be
     * "corrected" as if it were meant to be white-hot.
     *
     * Without this, a six-term pal() spends most of its cycle above 1 and
     * every crest normalises to the same white — that is what "washed out"
     * looked like; a nine-term one (Example 7) is worse still.  A scheme that
     * sits in its troughs gets lifted by the same rule.  The scale is global,
     * so every hue and every relative brightness survives. */
    const double regBri = std::max((double)P.brightnessFinite,
                                   (double)P.brightnessInfinite);
    const double eff = p99 * (double)P.brightness * regBri;
    if (std::getenv("MB_DEBUGPAL"))
      std::fprintf(stderr, "[pal] n=%d p99=%.3f bri=%.2f reg=%.2f k=%.3f\n",
                   P.n, p99, (double)P.brightness, regBri,
                   eff > 1e-4 ? 1.05 / eff : 1.0);
    if (eff > 1e-4) {
      double k = 1.05 / eff;
      if (k > 4.0) k = 4.0;
      if (k < 0.15) k = 0.15;
      if (k < 0.95 || k > 1.05)
        for (auto& v : lut) v = (float)((double)v * k);
    }
  }
}

/* Bake one cycle of the ramp into 256 RGB triples, tone included.  Sampling
 * the ramp once per pixel would cost a search through the stop list; a table
 * costs 3 KB and turns the inner loop into a lerp. */
void buildGradientLut(const Palette& P, std::vector<float>& lut) {
  lut.assign(256 * 3, 0.0f);
  if (P.ns <= 0) return;
  int k = 0;
  for (int i = 0; i < 256; ++i) {
    const double t = (double)i / 256.0;
    while (k + 1 < P.ns && (double)P.s[k + 1].pos <= t) ++k;
    const GradientStop& a = P.s[k];
    const GradientStop& b = P.s[k + 1 < P.ns ? k + 1 : k];
    double u = 0.0;
    if (k + 1 < P.ns && b.pos > a.pos) u = (t - a.pos) / (double)(b.pos - a.pos);
    u = std::min(1.0, std::max(0.0, u));
    u = u * u * (3.0 - 2.0 * u);            // smoothstep, same as the editor
    double r = a.r + ((double)b.r - a.r) * u;
    double g = a.g + ((double)b.g - a.g) * u;
    double bl = a.b + ((double)b.b - a.b) * u;
    tonePrep(P, r, g, bl);
    lut[i * 3 + 0] = (float)r;
    lut[i * 3 + 1] = (float)g;
    lut[i * 3 + 2] = (float)bl;
  }
}

inline void putRGB(uint8_t* o, double r, double g, double b) {  o[0] = (uint8_t)(std::min(1.0, std::max(0.0, r)) * 255.0 + 0.5);
  o[1] = (uint8_t)(std::min(1.0, std::max(0.0, g)) * 255.0 + 0.5);
  o[2] = (uint8_t)(std::min(1.0, std::max(0.0, b)) * 255.0 + 0.5);
  o[3] = 255;
}

/* Smooth iteration count of an escaped sample.
 *
 * `m2` is |z|^2 assembled from the reference's |Z|^2 plus the deviation, so
 * the deviation is already inside it; `rel` repeats it as a *relative* figure
 * so the part that the sum rounded away stays available.  Both are used, but
 * each exactly once: dividing the sum back out by (1+rel) recovers |Z|^2, and
 * log1p(rel) adds the deviation at full relative precision.  Adding log1p(rel)
 * on top of the *sum* (which is what this did) counted the deviation twice and
 * shifted the count by up to half an iteration — spatially irregular, which is
 * exactly the source of the extra colour edges that appear at depth. */
double smoothIteration(int n, double m2, double rel) {
  /* Exactly the reference's form, from the disassembly of smoothiter_double
   * (004c98e0.c:39-45):
   *     log2(log2(|z|^2) * K)      with K folded into the palette phase
   *     smooth = iter - that
   * The |z|^2 handed in is the reference's |Z|^2 plus the deviation, so the
   * log is taken in two pieces for the same reason as before: dividing the
   * sum back out keeps the deviation at full relative precision. */
  const double z2 = m2 / (1.0 + rel);
  const double l2 = std::log2(std::max(z2, 1e-300)) +
                    std::log2(std::max(1.0 + rel, 1e-300));
  const double nu = (double)n - std::log2(std::max(l2, 1e-9));
  return std::isfinite(nu) ? nu : (double)n;
}

/* Shade one sample.  `n` is >= 0 for escaped pixels (with `m2` = |z|^2 and
 * `rel` = the relative deviation of |z|^2 from the reference's |Z|^2) and
 * negative for interior ones, where n = -1 - cycleLength encodes the period
 * exactly like the reference's `-iter`.
 *
 * `blurCycles` is how much of a palette cycle this pixel's footprint covers.
 * Anything above zero is a box filter in palette phase, which is the only
 * correct place to filter: the signal that aliases is pal(iteration), not the
 * screen-space colour.  Callers pass the local iteration gradient, so flat
 * areas stay exactly as sharp as before and only the parts that are finer than
 * a pixel get averaged. */
void shade(uint8_t* o, const Ctx& g, int n, double m2, double rel,
                  double der2, double blurCycles) {
  const Palette& P = g.pal ? *g.pal : kFallbackPalette;
  /* Region brightness (the scheme's own finite/infinite figure) times the
   * user's brightness: both end up as one multiply before the normalise. */
  const double regBri = (double)P.brightness;
  const double bf = (double)P.brightnessFinite * regBri /
                    ((double)P.brightnessFactor > 0.0 ? (double)P.brightnessFactor : 1.0);
  const double bi = (double)P.brightnessInfinite * regBri /
                    ((double)P.brightnessFactor > 0.0 ? (double)P.brightnessFactor : 1.0);
  const double ipc = g.iterPerCycle > 0.0 ? g.iterPerCycle : 1.0;

  /* `iters` -> colour: one place decides what a palette cycle means. */
  const bool ramp = (P.mode == 1 && g.grad != nullptr);
  const bool additiveLut = !ramp && g.palLut && g.palLutN > 1;
  double r, gg, b;
  auto sample = [&](double iters, double bri) {
    if (ramp) {
      if (g.gradMip && g.gradMip->base > 0) {
        double t = iters / ipc + g.offset;
        t = (t - std::floor(t)) * (double)g.gradMip->base;
        mipSample(*g.gradMip, t, blurCycles * (double)g.gradMip->base, r, gg, b);
        toneFinish(bri, r, gg, b);
      } else {
        gradRGB(g.grad, iters / ipc + g.offset, bri, r, gg, b);
      }
    } else if (additiveLut) {
      double x = iters * g.palLutScale;
      if (g.palMip && g.palMip->base > 1 && g.palMipPerCycle > 0.0) {
        mipSample(*g.palMip, x, blurCycles * g.palMipPerCycle, r, gg, b);
      } else {
        const double last = (double)g.palLutN - 1.000001;
        if (!(x >= 0.0)) x = 0.0;
        if (x > last) x = last;
        const int i = (int)x;
        const float* a = g.palLut + (size_t)i * 3;
        const double u = x - (double)i;
        r = (double)a[0] + ((double)a[3] - a[0]) * u;
        gg = (double)a[1] + ((double)a[4] - a[1]) * u;
        b = (double)a[2] + ((double)a[5] - a[2]) * u;
      }
      toneFinish(bri, r, gg, b);
    } else {
      palRGB(P, (iters / ipc + g.offset) * (double)P.cycleRef, bri, r, gg, b);
    }
  };

  if (n < 0) {                              // interior: pal(-iter + 0.5)
    const double cyc = (n < -1) ? (double)(-n - 1) : 0.0;
    sample(cyc + 0.5, bi);
    putRGB(o, r, gg, b);
    return;
  }

  const double lz = 0.5 * std::log(std::max(m2 / (1.0 + rel), 1e-300)) +
                    0.5 * std::log1p(rel);
  const double nu = smoothIteration(n, m2, rel);

  switch (g.colorMode) {
    case 1:                                 // Iteration
      sample((double)n + 0.5, bf);
      break;
    case 2: {                               // Distance: black field + white rim
      double px = 0.0;
      if (der2 > 0.0) px = std::sqrt(std::max(m2, 0.0)) * lz / std::sqrt(der2) / g.ps;
      const double rr = px;                 // param[0] defaults to 0
      const double wht = (rr < 1.0 && rr != 0.0) ? (1.0 - rr) * bf : 0.0;
      r = gg = b = wht;
      break;
    }
    case 3: {                               // Distance + iteration levels
      double px = 0.0;
      if (der2 > 0.0) px = std::sqrt(std::max(m2, 0.0)) * lz / std::sqrt(der2) / g.ps;
      const double rr2 = px * std::exp(-1.5);
      if (rr2 < 1.0 && rr2 != 0.0) sample((double)n + 0.5, bf);
      else r = gg = b = 0.0;
      const double wht = (px < 1.0 && px != 0.0) ? (1.0 - px) * bf : 0.0;
      r = r * (rr2 < 1.0 ? (1.0 - rr2) : 0.0) + wht;
      gg = gg * (rr2 < 1.0 ? (1.0 - rr2) : 0.0) + wht;
      b = b * (rr2 < 1.0 ? (1.0 - rr2) : 0.0) + wht;
      break;
    }
    default:                                // Smooth (the default)
      sample(nu + 0.5, bf);
      break;
  }
  putRGB(o, r, gg, b);
}

/* --- public helpers ------------------------------------------------- */

/* --- built-in palettes ----------------------------------------------
 *
 * Every number below is copied from the reference distribution
 * (`examples/*.json`), not invented here.  A colour entry may omit `rgb`,
 * which leaves it black (so it contributes nothing), and may omit `frequency`,
 * which leaves it a DC term.
 *
 * `cycleRef` is the number of iterations one unit of the palette argument
 * covers.  It is 1.0 for every scheme transcribed from the reference, because
 * the reference feeds `iter` straight into pal() — `iter*frequency` is the
 * phase, in radians, with no extra scaling.  Only the app's own "Ice" scheme
 * keeps a larger figure, which is just how its look was tuned.
 * ------------------------------------------------------------------- */

Palette makePalette(const PaletteColor* src, int n, float bf, float bi,
                    float cycleRef) {
  Palette p;
  p.n = n < 20 ? n : 20;
  for (int i = 0; i < p.n; ++i) p.c[i] = src[i];
  p.brightnessFinite = bf;
  p.brightnessInfinite = bi;
  p.brightnessFactor = 1.0f;
  p.cycleRef = cycleRef;
  return p;
}

Palette g_palettes[14];
bool g_palettesReady = false;

void initPalettes() {
  if (g_palettesReady) return;
  g_palettesReady = true;

  /* 0 — "Ice", the app's default.  Three components one third of a cycle
   * apart sweep a closed loop through navy -> steel blue -> pale ice, plus one
   * faster component that only shows up where the iteration count changes
   * quickly, i.e. in the filigree along the contour. */
  {
    /* The three ramp components share a phase on purpose: a common phase makes
     * the *sum* swing from black to pale, whereas phases a third of a cycle
     * apart would keep the luminance constant and only rotate the hue (a flat
     * pastel wash).  The fourth component runs three times faster and is
     * dimmer: it is what draws the fine rings inside the bands. */
    /* Phases are deliberately NOT one third of a cycle apart: that spacing
     * makes the three amplitudes sum to a constant, so only the hue rotates
     * (a flat pastel wash).  Uneven phases let the luminance swing, which is
     * what a palette that reads as "dark field, bright crest" needs.
     *
     * The brightness stays below the point where the max-normalisation starts
     * to bite: at 0.62 the peak lands at ~0.9 instead of clamping a whole
     * third of the cycle to white. */
    /* Three slow components carry the light, three faster ones carry the
     * texture.  The fast terms are not decoration: with a slow term alone,
     * the iteration range *across the screen* shrinks as you zoom, so a deep
     * frame can land entirely inside one crest and read as flat grey.  The
     * 13- and 6-iteration terms keep banding the field at every depth.  The
     * peak is a pale blue rather than pure white for the same reason: equal
     * channels at low brightness read as beige, not ice. */
    static const PaletteColor ice[] = {
        {0.00f, 0.01f, 0.05f, -0.0787402f, 0.0f},
        {0.03f, 0.28f, 0.56f, -0.0787402f, 2.0f},
        {0.55f, 0.78f, 0.92f, -0.0787402f, 4.0f},
        {0.34f, 0.46f, 0.55f, -0.4778543f, 0.7f},
        {0.18f, 0.24f, 0.30f, -1.0137795f, 3.4f}};
    g_palettes[0] = makePalette(ice, 5, 0.55f, 0.14f, 12.7f);
  }

  /* 1 — examples/Retinamandelbrot Example 2.json.  This is the scheme the
   * reference screenshots were taken with: three white components for the
   * field, then yellow / cyan / magenta at higher frequency for the fine
   * structure. */
  {
    static const PaletteColor e2[] = {
        /* these three carry no `rgb` in the file, so they stay black and only
         * matter if the user gives them a colour */
        {0.0f, 0.0f, 0.0f, -0.0393701f, -0.6246355f},
        {0.0f, 0.0f, 0.0f, -0.4778543f, -1.7178748f},
        {0.0f, 0.0f, 0.0f, -1.0137795f, -0.6637004f},
        {1.0f, 0.9851013f, 0.0f, -2.7081692f, -2.1216540f},
        {0.0f, 1.0f, 0.9913976f, -2.2859251f, -1.8925469f},
        {1.0f, 0.0f, 0.9428220f, -1.9448819f, -1.6133239f}};
    g_palettes[1] = makePalette(e2, 6, 1.40f, 0.55f);
  }

  /* 2 — examples/Retinamandelbrot Example 10.json */
  {
    static const PaletteColor e10[] = {
        {0.0f, 0.0f, 0.0f, -1.8250487f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0f, 0.0f},
        {0.0f, 0.0f, 0.0f, 0.0833333f, 0.0f},
        {1.0f, 0.9503002f, 0.0f, -0.5706628f, 1.0832013f},
        {0.9978633f, 0.0f, 1.0f, -1.5087719f, 0.2565166f},
        {0.0f, 1.0f, 0.9523754f, -0.5867447f, 0.2513278f}};
    g_palettes[2] = makePalette(e10, 6, 1.00f, 0.55f);
  }

  /* 3 — examples/Retinamandelbrot Example 11.json: a single green sinusoid
   * stretched by a 1.4 brightness, i.e. a narrow, high-contrast band. */
  {
    static const PaletteColor e11[] = {
        {0.0f, 0.0f, 0.0f, 0.0f, -0.9357696f},
        {0.0f, 1.0f, 0.9306729f, -1.1174464f, -2.5748634f},
        {0.0f, 0.0f, 0.0f, 0.0f, -0.9959077f}};
    g_palettes[3] = makePalette(e11, 3, 1.40f, 0.45f);
  }

  /* 4 — monochrome slate, for a quiet picture. */
  {
    static const PaletteColor mono[] = {
        {0.55f, 0.58f, 0.62f, -0.0393701f, 0.0f},
        {0.35f, 0.38f, 0.44f, -0.1500000f, 1.5f},
        {0.12f, 0.13f, 0.16f, -0.3200000f, 3.0f}};
    g_palettes[4] = makePalette(mono, 3, 1.00f, 0.85f);
  }

  /* 5 — ember: warm low frequencies, the classic complement of Ice. */
  {
    static const PaletteColor ember[] = {
        {0.10f, 0.02f, 0.01f, -0.0393701f, 0.0f},
        {0.70f, 0.20f, 0.03f, -0.0393701f, 2.0943951f},
        {1.00f, 0.78f, 0.36f, -0.0393701f, 4.1887902f},
        {0.90f, 0.55f, 0.20f, -0.4778543f, 1.0f}};
    g_palettes[5] = makePalette(ember, 4, 1.05f, 0.95f);
  }

  /* 6 — the same field as Ice, shifted a third of a cycle: violet. */
  {
    static const PaletteColor vio[] = {
        {0.06f, 0.02f, 0.14f, -0.0393701f, 0.0f},
        {0.28f, 0.10f, 0.62f, -0.0393701f, 2.0943951f},
        {0.80f, 0.70f, 0.98f, -0.0393701f, 4.1887902f},
        {0.85f, 0.80f, 0.95f, -0.4778543f, 1.0f}};
    g_palettes[6] = makePalette(vio, 4, 1.00f, 0.90f);
  }

  /* ---- the reference's own palettes, verbatim ----------------------
   *
   * These are the schemes the shipped examples were saved with.  Frequencies
   * are radians per iteration, so a term at -2.1 completes a cycle every
   * three iterations: that is what keeps a deep frame banded when the whole
   * picture spans only a handful of iterations.  Nothing here is scaled,
   * fitted or normalised by zoom — pal() is exactly the reference's pal().
   */

  /* 7 — Retinamandelbrot Example 3 / Retinajulia Example 1: pure RGB, the
   *     oldest scheme in the set.  Red and green run fast, blue is almost a
   *     DC term, so the field is a red/green ribbon over a blue floor. */
  {
    static const PaletteColor rgb[] = {
        {1.0f, 0.0f, 0.0f, -2.1202636f, -1.0f},
        {0.0f, 1.0f, 0.0f, -1.1363142f, -1.5f},
        {0.0f, 0.0f, 1.0f, -0.0232686f, -0.5f}};
    g_palettes[7] = makePalette(rgb, 3, 1.0f, 0.55f);
  }

  /* 8 — examples/Amethyst Crown.json: deep purple into orchid with a gold
   *     crest.  Two terms an octave apart, so gold returns every third band. */
  {
    static const PaletteColor am[] = {
        {0.55f, 0.25f, 0.85f, -2.0f, 0.0f},
        {1.00f, 0.75f, 0.15f, -1.5f, -0.3f}};
    g_palettes[8] = makePalette(am, 2, 1.0f, 0.45f);
  }

  /* 9 — examples/Nebula Bloom.json: cyan against hot pink. */
  {
    static const PaletteColor neb[] = {
        {0.0f, 0.85f, 1.0f, -1.8f, 0.0f},
        {1.0f, 0.15f, 0.6f, -2.2f, -0.4f}};
    g_palettes[9] = makePalette(neb, 2, 1.0f, 0.40f);
  }

  /* 10 — examples/Rainbow Veins.json: violet with a green vein. */
  {
    static const PaletteColor vei[] = {
        {0.8f, 0.2f, 1.0f, -1.6f, 0.0f},
        {0.0f, 1.0f, 0.7f, -2.2f, -0.4f}};
    g_palettes[10] = makePalette(vei, 2, 1.0f, 0.40f);
  }

  /* 11 — Retinajulia Example 4, "Chinese Remainder Clock": electric blue and
   *      pure red beating against each other (2.2057 vs 1.2836 rad/iter). */
  {
    static const PaletteColor clk[] = {
        {0.0f, 0.0298922f, 1.0f, -2.2056529f, 0.0f},
        {1.0f, 0.0f, 0.0000005f, -1.2836257f, -0.5f}};
    g_palettes[11] = makePalette(clk, 2, 1.0f, 0.498f);
  }

  /* 12 — Retinamandelbrot Example 14/15: the six-term scheme every deep
   *      example ships with.  Three dim grey terms carry the wide field,
   *      three fast ones (2.4 / 3.5 / 2.1 iterations per cycle) draw the
   *      fine rainbow filigree.  At depth the fast terms are what you see. */
  {
    static const PaletteColor sp[] = {
        {0.0f, 0.0f, 0.0f, -1.0400593f, -1.6567906f},
        {0.0f, 0.0f, 0.0f, -0.4688427f, -1.9316331f},
        {0.0f, 0.0f, 0.0f, 0.2492582f, -0.3547057f},
        {1.0f, 0.9851013f, 0.0f, -2.6394658f, -2.1216540f},
        {0.0f, 1.0f, 0.9913976f, -1.8071216f, -1.5025265f},
        {1.0f, 0.0f, 0.9428220f, -3.0393176f, -2.2120402f}};
    g_palettes[12] = makePalette(sp, 6, 1.02f, 0.45f);
  }

  /* 13 — Retinamandelbrot Example 7: nine grey terms at walking pace with one
   *      magenta accent.  Reads as engraved metal, not as neon. */
  {
    static const PaletteColor gr[] = {
        {0.5f, 0.5f, 0.5f, -1.7339181f, 0.0f},
        {0.5f, 0.5f, 0.5f, -1.1228070f, 0.0f},
        {0.5f, 0.5f, 0.5f, -0.0721248f, 0.0f},
        {0.5f, 0.5f, 0.5f, -0.4634503f, -1.5707964f},
        {0.5f, 0.5f, 0.5f, 0.7909357f, -1.5707964f},
        {0.5f, 0.5f, 0.5f, 0.3245614f, -1.5707964f},
        {0.9651463f, 0.0302470f, 0.8837509f, -0.2007797f, -1.0543925f},
        {0.5f, 0.5f, 0.5f, 0.4049708f, -1.5707964f},
        {0.5f, 0.5f, 0.5f, -0.0989279f, -1.5707964f}};
    g_palettes[13] = makePalette(gr, 9, 1.0f, 0.55f);
  }
}

}  // namespace detail

using namespace detail;

/* A frame with no palette at all still has to be drawn. */
namespace detail {
const Palette kFallbackPalette;
}

constexpr int kPaletteCount = 14;

int paletteCount() { return kPaletteCount; }

const char* paletteName(int index) {
  static const char* kNames[] = {"Ice",      "Retina", "Aurora",  "Emerald",
                                 "Slate",    "Ember",  "Violet",  "Prism",
                                 "Amethyst", "Bloom",  "Veins",   "Clock",
                                 "Spectrum", "Graphite"};
  if (index < 0 || index >= kPaletteCount) index = 0;
  return kNames[index];
}

const Palette& builtinPalette(int index) {
  initPalettes();
  if (index < 0 || index >= kPaletteCount) index = 0;
  return g_palettes[index];
}

}  // namespace mbc
