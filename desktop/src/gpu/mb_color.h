// ---------------------------------------------------------------------------
// mb_color.h — full-gamut colour library for the OpenGL field shader.
//
// "1024 levels per channel" gives 1024^3 = 1,073,741,824 addressable colours
// (the ~1e9 the spec asks for).  Everything is computed in linear light at
// float64 precision, transformed perceptually in OKLab/OKLCH, encoded to sRGB
// only at the very end, and quantised to 10 bits with a per-pixel ordered
// dither in the shader.  Quantising RGB early is what produces the flat grey
// washes and banding the old 8-bit LUT suffered from.
//
// FullGamut mode walks the *entire* hue circle within one palette cycle and
// pushes chroma to the sRGB boundary at each (L, h) by bisection, so a single
// fractal frame spans every hue family instead of one narrow ramp.
// ---------------------------------------------------------------------------
#pragma once

// windows.h defines min/max macros that break std::max in the tone stage.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

// The colour library's output contract IS GL_RGB10_A2.  Khronos' official
// glext.h/wglext.h (third_party/khronos) supplies the constants and the GL
// entry points; lcms2 (third_party/lcms2) supplies the colour management.
#include "gl_api.h"
#include <lcms2.h>

#include <cstdint>
#include <vector>

namespace mbcol {

/** 10 bits per channel -> 1024^3 = 1,073,741,824 addressable colours.
 *  These are the *actual* GL enums, not local aliases: a LUT built here can be
 *  handed straight to glTexImage2D with no repacking. */
constexpr GLenum kLutInternalFormat = GL_RGB10_A2;
constexpr GLenum kLutTransferFormat = GL_RGBA;
constexpr GLenum kLutTransferType = GL_UNSIGNED_INT_2_10_10_10_REV;

/** 1024 levels per channel -> 1,073,741,824 RGB colours. */
constexpr int kLevels = 1024;
constexpr int kMaxLevels = 65536;
constexpr int kQuantMax = 1023;  // 10-bit code space

enum class Mode {
  Additive,   // the reference program's pal(): sum of sinusoids
  Gradient,   // smoothstep between author-authored stops
  FullGamut,  // OKLCH full hue circle, chroma at the sRGB boundary
  Spectral,   // visible spectrum 380..780 nm
  Hybrid      // additive structure over a full-gamut hue sweep
};

struct Term {
  double r = 1.0, g = 1.0, b = 1.0;
  double frequency = 0.1;  // radians per iteration (shader domain)
  double initial = 0.0;
};

struct Stop {
  double pos = 0.0, r = 0.0, g = 0.0, b = 0.0;
};

struct PaletteSpec {
  Mode mode = Mode::FullGamut;
  std::vector<Term> terms;
  std::vector<Stop> stops;

  // Palette-space phase.  cycle is iterations per full trip along the ramp;
  // offset is in cycles.  The reference's `frequency` is in iterations, not
  // "cycles per frame": compressing it here is what caused fan-shaped moire.
  double cycle = 64.0;
  double offset = 0.0;

  double brightnessFinite = 1.0;
  double brightnessInfinite = 1.0;
  double brightnessFactor = 1.0;

  // Tone stage, applied in linear light in this same order.
  double brightness = 1.0;
  double contrast = 1.0;
  double gamma = 1.0;
  double saturation = 1.0;
  double gainR = 1.0, gainG = 1.0, gainB = 1.0;

  // FullGamut shaping.
  double hueOffset = 0.0;       // cycles
  double hueCycles = 1.0;       // hue turns per palette cycle
  double lightBase = 0.62;
  double lightAmplitude = 0.24;
  double lightCycles = 2.0;
  double chromaBoost = 0.96;    // fraction of the sRGB-gamut boundary

  int levels = kLevels;         // LUT resolution (per channel quantisation is 10-bit)
  bool normalise = true;        // hue-preserving max-channel normalisation
};

struct LUT {
  int levels = 0;
  /** 3*levels floats, sRGB-encoded 0..1 (analysis / high-precision paths). */
  std::vector<float> srgb;
  /** 3*levels 10-bit codes. */
  std::vector<uint16_t> rgb10;
  /** levels GL_RGB10_A2 texels, already packed as A2B10G10R10.  This is the
   *  array uploadLUT() passes to glTexImage2D with
   *  GL_UNSIGNED_INT_2_10_10_10_REV -- zero copies, zero repacking. */
  std::vector<uint32_t> packed;
};

struct GamutReport {
  int levels = 0;
  double hueCoveragePct = 0.0;   // % of 72 hue bins (5 degrees each) visited
  double meanChroma = 0.0;
  double maxChroma = 0.0;
  double lightMin = 0.0, lightMax = 0.0;
  int distinct10bit = 0;         // distinct quantised RGB triples
  uint64_t addressableColours = 0;
};

/** Build the LUT.  Never throws: a bad spec falls back to FullGamut. */
LUT build(const PaletteSpec& spec);

/** Measure how much of the perceptual colour space the LUT actually spans. */
GamutReport analyse(const LUT& lut);

/**
 * Uniform exposure from the frame's own smooth-iteration distribution.
 * Returns a multiplier; |k-1| < 0.05 is deliberately left at 1 so authored
 * palettes keep their look when nothing is clipped (the Ice default must not
 * change).  `p99` is the 99th percentile of |colour position| * brightness.
 */
double autoExposure(double p99, double brightnessFinite, double brightnessInfinite);

/** One colour out of the LUT, in sRGB 0..1.  t is already phase-wrapped. */
void sample(const LUT& lut, double t, float& r, float& g, float& b);

/** Ordered dither offset in [-0.5, 0.5] for a pixel, in 10-bit codes. */
double ditherOffset(int x, int y);

/** 10-bit sRGB triple packed for GL_RGB10_A2 (A = 3). */
uint32_t packRGB10A2(uint16_t r, uint16_t g, uint16_t b);

/** Bind `tex` as a GL_TEXTURE_2D LUT using the GL_RGB10_A2 contract. */
bool uploadLUT(const LUT& lut, GLuint tex);

/** Allocate a GL_RGB10_A2 render target (the colour stage's framebuffer). */
GLuint createTarget(int w, int h);

/** Colour-manage the LUT through lcms2: sRGB -> `dst` ICC profile, then
 *  re-quantise into the packed GL_RGB10_A2 texels.  Returns false on a bad
 *  profile.  This is the only place where gamut conversion happens. */
bool applyICC(LUT& lut, cmsHPROFILE dst);

/** Verify the lcms2 pipeline on a known patch (diagnostics / regression). */
double iccRoundTripError();

/** A few shipped looks; all are expressed through PaletteSpec, not raw bytes. */
PaletteSpec ice();
PaletteSpec fullSpectrum();
PaletteSpec referenceAdditive();

}  // namespace mbcol
