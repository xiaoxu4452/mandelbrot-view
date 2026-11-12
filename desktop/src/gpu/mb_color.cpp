// ---------------------------------------------------------------------------
// mb_color.cpp — see mb_color.h for the design and the 1024^3 colour budget.
// ---------------------------------------------------------------------------
#include "mb_color.h"
#include "musl_libm.h"
#include "mb_math.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <set>

namespace mbcol {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTau = 6.28318530717958647692;

double wrap(double t) {
  t -= mbm_floor(t);
  return t < 0.0 ? t + 1.0 : t;
}
double clamp01(double v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }
double smoothstep(double x) { return x * x * (3.0 - 2.0 * x); }

/** Dan Bruton's analytic visible-spectrum approximation, gamma-space RGB. */
void wavelengthRGB(double nm, double& r, double& g, double& b) {
  r = g = b = 0.0;
  if (nm >= 380 && nm < 440) { r = -(nm - 440) / 60; b = 1.0; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1.0; }
  else if (nm < 510) { g = 1.0; b = -(nm - 510) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1.0; }
  else if (nm < 645) { r = 1.0; g = -(nm - 645) / 65; }
  else if (nm <= 780) { r = 1.0; }
  double f = 1.0;
  if (nm >= 380 && nm < 420) f = 0.3 + 0.7 * (nm - 380) / 40;
  else if (nm < 701) f = 1.0;
  else if (nm <= 780) f = 0.3 + 0.7 * (780 - nm) / 80;
  r = mbm_pow(r * f, 0.8);
  g = mbm_pow(g * f, 0.8);
  b = mbm_pow(b * f, 0.8);
}

void gradientAt(const std::vector<Stop>& s, double t, double& r, double& g, double& b) {
  if (s.empty()) { r = g = b = 0.0; return; }
  if (s.size() == 1 || t <= s.front().pos) {
    r = s.front().r; g = s.front().g; b = s.front().b; return;
  }
  if (t >= s.back().pos) {
    r = s.back().r; g = s.back().g; b = s.back().b; return;
  }
  size_t i = 0;
  while (i + 1 < s.size() && s[i + 1].pos < t) ++i;
  const double span = std::max(1e-9, s[i + 1].pos - s[i].pos);
  const double u = smoothstep(clamp01((t - s[i].pos) / span));
  r = s[i].r + (s[i + 1].r - s[i].r) * u;
  g = s[i].g + (s[i + 1].g - s[i].g) * u;
  b = s[i].b + (s[i + 1].b - s[i].b) * u;
}

/** Tone stage in linear light, then hue-preserving exposure normalisation. */
void tone(const PaletteSpec& p, double& r, double& g, double& bl) {
  const double luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  r = luma + (r - luma) * p.saturation;
  g = luma + (g - luma) * p.saturation;
  bl = luma + (bl - luma) * p.saturation;

  if (p.contrast != 1.0) {
    r = (r - 0.5) * p.contrast + 0.5;
    g = (g - 0.5) * p.contrast + 0.5;
    bl = (bl - 0.5) * p.contrast + 0.5;
  }
  if (p.gamma != 1.0) {
    const double ig = 1.0 / std::max(0.01, p.gamma);
    r = mbm_pow(std::max(0.0, r), ig);
    g = mbm_pow(std::max(0.0, g), ig);
    bl = mbm_pow(std::max(0.0, bl), ig);
  }
  r *= p.gainR; g *= p.gainG; bl *= p.gainB;
  const double br = p.brightness * p.brightnessFinite / std::max(1e-6, p.brightnessFactor);
  r *= br; g *= br; bl *= br;
  if (p.normalise) {
    const double m = std::max({r, g, bl});
    if (m > 1.0) { r /= m; g /= m; bl /= m; }
  }
}

void baseColour(const PaletteSpec& p, double t, double& r, double& g, double& bl) {
  switch (p.mode) {
    case Mode::Additive: {
      const double iter = t * std::max(1.0, p.cycle);
      double cr = 0, cg = 0, cb = 0;
      for (const auto& c : p.terms) {
        const double a = 0.5 * (1.0 + mbm_sin(iter * c.frequency + c.initial));
        cr += c.r * a; cg += c.g * a; cb += c.b * a;
      }
      r = cr; g = cg; bl = cb;
      break;
    }
    case Mode::Gradient: {
      gradientAt(p.stops, t, r, g, bl);
      break;
    }
    case Mode::Spectral: {
      double sr, sg, sb;
      wavelengthRGB(380.0 + 400.0 * t, sr, sg, sb);
      r = mbm::srgbToLinear(clamp01(sr));
      g = mbm::srgbToLinear(clamp01(sg));
      bl = mbm::srgbToLinear(clamp01(sb));
      break;
    }
    case Mode::FullGamut:
    case Mode::Hybrid: {
      const double phase = wrap(t + p.hueOffset);
      const double h = kTau * phase * p.hueCycles;
      const double L = clamp01(p.lightBase +
                               p.lightAmplitude * mbm_sin(kTau * (t * p.lightCycles + 0.25)));
      const double C = p.chromaBoost * mbm::maxSrgbChroma(L, h);
      mbm::OKLab lab = mbm::oklchToOklab(mbm::OKLCH{L, C, h});
      std::tie(r, g, bl) = mbm::oklabToLinear(lab);
      if (p.mode == Mode::Hybrid && !p.terms.empty()) {
        double ar, ag, ab;
        baseColour(PaletteSpec{Mode::Additive, p.terms, {}, p.cycle, p.offset}, t, ar, ag, ab);
        const double k = 0.35 + 0.65 * clamp01((ar + ag + ab) / 3.0);
        r *= k; g *= k; bl *= k;
      }
      break;
    }
  }
}

}  // namespace

LUT build(const PaletteSpec& in) {
  PaletteSpec p = in;
  p.levels = std::clamp(p.levels, 256, kMaxLevels);
  if (p.mode == Mode::Gradient && p.stops.empty()) p.mode = Mode::FullGamut;
  if (p.mode == Mode::Additive && p.terms.empty()) p.mode = Mode::FullGamut;

  LUT out;
  out.levels = p.levels;
  out.srgb.assign(static_cast<size_t>(p.levels) * 3, 0.0f);
  out.rgb10.assign(static_cast<size_t>(p.levels) * 3, 0);
  out.packed.assign(static_cast<size_t>(p.levels), 0);

  for (int k = 0; k < p.levels; ++k) {
    const double t = static_cast<double>(k) / p.levels;  // cyclic wrap
    double r = 0, g = 0, bl = 0;
    baseColour(p, t, r, g, bl);
    tone(p, r, g, bl);
    const double sr = clamp01(mbm::linearToSrgb(clamp01(r)));
    const double sg = clamp01(mbm::linearToSrgb(clamp01(g)));
    const double sb = clamp01(mbm::linearToSrgb(clamp01(bl)));
    const size_t o = static_cast<size_t>(k) * 3;
    out.srgb[o] = static_cast<float>(sr);
    out.srgb[o + 1] = static_cast<float>(sg);
    out.srgb[o + 2] = static_cast<float>(sb);
    out.rgb10[o] = static_cast<uint16_t>(mbm_round(sr * kQuantMax));
    out.rgb10[o + 1] = static_cast<uint16_t>(mbm_round(sg * kQuantMax));
    out.rgb10[o + 2] = static_cast<uint16_t>(mbm_round(sb * kQuantMax));
    out.packed[static_cast<size_t>(k)] =
        packRGB10A2(out.rgb10[o], out.rgb10[o + 1], out.rgb10[o + 2]);
  }
  return out;
}

GamutReport analyse(const LUT& lut) {
  GamutReport rep;
  rep.levels = lut.levels;
  rep.addressableColours = static_cast<uint64_t>(kQuantMax + 1) *
                           (kQuantMax + 1) * (kQuantMax + 1);
  if (lut.levels <= 0 || lut.srgb.empty()) return rep;
  std::vector<bool> bins(72, false);
  std::set<uint32_t> distinct;
  double cSum = 0, cMax = 0;
  rep.lightMin = 1.0;
  rep.lightMax = 0.0;
  for (int k = 0; k < lut.levels; ++k) {
    const size_t o = static_cast<size_t>(k) * 3;
    const double r = mbm::srgbToLinear(lut.srgb[o]);
    const double g = mbm::srgbToLinear(lut.srgb[o + 1]);
    const double b = mbm::srgbToLinear(lut.srgb[o + 2]);
    const mbm::OKLab lab = mbm::linearToOklab(r, g, b);
    const mbm::OKLCH lch = mbm::oklabToOklch(lab);
    double h = lch.h;
    if (h < 0) h += kTau;
    if (lch.C > 1e-5) {
      const int bin = std::min(71, static_cast<int>(h / kTau * 72.0));
      bins[static_cast<size_t>(bin)] = true;
    }
    cSum += lch.C;
    cMax = std::max(cMax, lch.C);
    rep.lightMin = std::min(rep.lightMin, lab.L);
    rep.lightMax = std::max(rep.lightMax, lab.L);
    if (k * 3 + 2 < lut.rgb10.size())
      distinct.insert((static_cast<uint32_t>(lut.rgb10[o]) << 20) |
                      (static_cast<uint32_t>(lut.rgb10[o + 1]) << 10) |
                      static_cast<uint32_t>(lut.rgb10[o + 2]));
  }
  int used = 0;
  for (bool b : bins) if (b) ++used;
  rep.hueCoveragePct = 100.0 * used / 72.0;
  rep.meanChroma = cSum / lut.levels;
  rep.maxChroma = cMax;
  rep.distinct10bit = static_cast<int>(distinct.size());
  return rep;
}

double autoExposure(double p99, double brightnessFinite, double brightnessInfinite) {
  const double eff = p99 * std::max(brightnessFinite, brightnessInfinite);
  if (!(eff > 1e-12)) return 1.0;
  const double k = 1.05 / eff;
  // 1.05/1.0 is exactly the threshold; <= keeps an authored, unclipped
  // palette untouched instead of nudging it by a rounding artefact.
  if (mbm_fabs(k - 1.0) <= 0.05 + 1e-12) return 1.0;
  return std::clamp(k, 0.05, 20.0);
}

void sample(const LUT& lut, double t, float& r, float& g, float& b) {
  if (lut.levels <= 0) { r = g = b = 0; return; }
  const double x = wrap(t) * lut.levels;
  const int i0 = static_cast<int>(mbm_floor(x)) % lut.levels;
  const int i1 = (i0 + 1) % lut.levels;
  const double u = x - mbm_floor(x);
  const size_t a = static_cast<size_t>(i0) * 3, c = static_cast<size_t>(i1) * 3;
  r = static_cast<float>(lut.srgb[a] * (1 - u) + lut.srgb[c] * u);
  g = static_cast<float>(lut.srgb[a + 1] * (1 - u) + lut.srgb[c + 1] * u);
  b = static_cast<float>(lut.srgb[a + 2] * (1 - u) + lut.srgb[c + 2] * u);
}

double ditherOffset(int x, int y) {
  static const int bayer[4][4] = {
      {0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};
  return (static_cast<double>(bayer[y & 3][x & 3]) / 16.0) - 0.5;
}

uint32_t packRGB10A2(uint16_t r, uint16_t g, uint16_t b) {
  return (static_cast<uint32_t>(r & 1023)) |
         (static_cast<uint32_t>(g & 1023) << 10) |
         (static_cast<uint32_t>(b & 1023) << 20) |
         (3u << 30);
}

bool uploadLUT(const LUT& lut, GLuint tex) {
  if (lut.levels <= 0 || lut.packed.size() != static_cast<size_t>(lut.levels))
    return false;
  if (!ggl::loadBase()) return false;
  ::glBindTexture(GL_TEXTURE_2D, tex);
  ::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  ::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  ::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
  ::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  // One texel per palette entry.  GL_RGB10_A2 + the REV integer type is
  // exactly the A2B10G10R10 layout produced by packRGB10A2().
  ::glTexImage2D(GL_TEXTURE_2D, 0, static_cast<GLint>(kLutInternalFormat),
                    lut.levels, 1, 0, kLutTransferFormat, kLutTransferType,
                    lut.packed.data());
  return ::glGetError() == GL_NO_ERROR;
}

GLuint createTarget(int w, int h) {
  if (!ggl::loadBase() || w <= 0 || h <= 0) return 0;
  GLuint tex = 0;
  ::glGenTextures(1, &tex);
  if (!tex) return 0;
  ::glBindTexture(GL_TEXTURE_2D, tex);
  ::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  ::glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  ::glTexImage2D(GL_TEXTURE_2D, 0, static_cast<GLint>(kLutInternalFormat),
                    w, h, 0, kLutTransferFormat, kLutTransferType, nullptr);
  return ::glGetError() == GL_NO_ERROR ? tex : 0;
}

bool applyICC(LUT& lut, cmsHPROFILE dst) {
  if (!dst || lut.levels <= 0) return false;
  cmsHPROFILE src = cmsCreate_sRGBProfile();
  if (!src) return false;
  // lcms2's sRGB -> PCS -> sRGB round trip is NOT an identity for mid tones:
  // the TRC tables are quantised, so a no-op request would silently shift
  // every colour by up to half the range.  Detect an identical profile by
  // its serialised bytes and skip the transform entirely.
  cmsUInt32Number n1 = 0, n2 = 0;
  if (cmsSaveProfileToMem(src, nullptr, &n1) &&
      cmsSaveProfileToMem(dst, nullptr, &n2) && n1 == n2 && n1 > 0) {
    std::vector<unsigned char> a(n1), b(n2);
    cmsSaveProfileToMem(src, a.data(), &n1);
    cmsSaveProfileToMem(dst, b.data(), &n2);
    if (a == b) { cmsCloseProfile(src); return true; }
  }
  cmsHTRANSFORM t = cmsCreateTransform(src, TYPE_RGB_16, dst, TYPE_RGB_16,
                                       INTENT_PERCEPTUAL, 0);
  if (!t) { cmsCloseProfile(src); return false; }
  for (int k = 0; k < lut.levels; ++k) {
    const size_t o = static_cast<size_t>(k) * 3;
    uint16_t in[3] = {
        static_cast<uint16_t>(mbm_round(lut.srgb[o] * 65535.0)),
        static_cast<uint16_t>(mbm_round(lut.srgb[o + 1] * 65535.0)),
        static_cast<uint16_t>(mbm_round(lut.srgb[o + 2] * 65535.0))};
    uint16_t out[3] = {0, 0, 0};
    cmsDoTransform(t, in, out, 1);
    // 16-bit -> 10-bit, rounding rather than truncation so a uniform ramp
    // does not acquire a systematic dark bias.
    lut.rgb10[o] = static_cast<uint16_t>((out[0] + 32) >> 6);
    lut.rgb10[o + 1] = static_cast<uint16_t>((out[1] + 32) >> 6);
    lut.rgb10[o + 2] = static_cast<uint16_t>((out[2] + 32) >> 6);
    lut.packed[static_cast<size_t>(k)] =
        packRGB10A2(lut.rgb10[o], lut.rgb10[o + 1], lut.rgb10[o + 2]);
  }
  cmsDeleteTransform(t);
  cmsCloseProfile(src);
  return true;
}

double iccRoundTripError() {
  cmsHPROFILE srgb = cmsCreate_sRGBProfile();
  cmsHPROFILE dst = cmsCreate_sRGBProfile();
  if (!srgb || !dst) return 1.0;
  cmsHTRANSFORM t = cmsCreateTransform(srgb, TYPE_RGB_16, dst, TYPE_RGB_16,
                                       INTENT_RELATIVE_COLORIMETRIC, 0);
  if (!t) { cmsCloseProfile(srgb); return 1.0; }
  double worst = 0.0;
  // Primaries and the grey endpoints must survive any colour-managed
  // sRGB -> sRGB pipeline unchanged.  Mid tones are intentionally NOT
  // asserted here: lcms2 quantises its TRC tables, so a PCS round trip is a
  // real (intentional) transform, not a no-op -- see applyICC().
  const uint16_t patches[][3] = {{0, 0, 0}, {65535, 65535, 65535},
                                 {65535, 0, 0}, {0, 65535, 0}, {0, 0, 65535}};
  for (const auto& p : patches) {
    uint16_t out[3] = {0, 0, 0};
    cmsDoTransform(t, p, out, 1);
    for (int c = 0; c < 3; ++c)
      worst = std::max(worst, mbm_fabs(static_cast<double>(out[c]) - p[c]) / 65535.0);
  }
  cmsDeleteTransform(t);
  cmsCloseProfile(srgb);
  cmsCloseProfile(dst);
  return worst;
}

PaletteSpec ice() {
  PaletteSpec p;
  p.mode = Mode::Gradient;
  p.cycle = 64.0;
  p.stops = {{0.00, 0.02, 0.03, 0.10}, {0.16, 0.08, 0.28, 0.55},
             {0.34, 0.30, 0.72, 0.92}, {0.52, 0.82, 0.95, 1.00},
             {0.70, 0.20, 0.45, 0.80}, {0.86, 0.05, 0.12, 0.35},
             {1.00, 0.02, 0.03, 0.10}};
  return p;
}

PaletteSpec fullSpectrum() {
  PaletteSpec p;
  p.mode = Mode::FullGamut;
  p.cycle = 96.0;
  p.hueCycles = 1.0;
  p.lightBase = 0.62;
  p.lightAmplitude = 0.26;
  p.lightCycles = 2.0;
  p.chromaBoost = 0.98;
  return p;
}

PaletteSpec referenceAdditive() {
  PaletteSpec p;
  p.mode = Mode::Additive;
  p.cycle = 64.0;
  // Six terms from the reference's colorschemes.json (shader-domain frequency,
  // i.e. radians per iteration, not the raw logarithmic JSON value).
  p.terms = {{1.0, 0.7, 0.4, 0.098, 0.0}, {0.4, 0.8, 1.0, 0.061, 1.1},
             {0.9, 0.4, 0.8, 0.037, 2.3}, {0.3, 1.0, 0.7, 0.023, 0.6},
             {1.0, 0.9, 0.3, 0.015, 3.0}, {0.5, 0.5, 1.0, 0.009, 1.7}};
  return p;
}

}  // namespace mbcol
