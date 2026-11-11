// ------------------------------------------------------------------
// mb_core.h — the renderer interface.
//
// This header is deliberately small: a view description in, RGBA out.
// There is exactly ONE rendering pipeline (see mb_core.cpp); the only
// branch is the precision mode, and that branch is chosen from the pixel
// scale, never from a user option or an environment variable.
//
//   direct        pixel scale > 2^-42   plain double iteration
//   perturbation  pixel scale <= 2^-42  reference orbit + rebasing
//
// Provenance of the algorithm: Kalles Fraktaler 2.15.5.2 (Karl Runmo,
// Claude Heiland-Allen, AGPL-3.0).  The reference orbit is computed at
// arbitrary precision, every pixel carries only its deviation from it, and
// that deviation is periodically re-anchored to the reference ("rebasing")
// so it never has to outgrow double precision.  A Taylor series of the
// deviation (series approximation) lets whole frames start thousands of
// iterations in, which is what makes deep zoom feel like video instead of
// a wait.
// ------------------------------------------------------------------
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace mbc {

struct Spec {
  int mode = 0;            // 0 = Mandelbrot, 1 = Julia
  int kind = 0;            // 0 poly, 1 tricorn, 2 burning ship, 3 celtic,
                           // 4 perpendicular, 5 phoenix
  int power = 2;
  double juliaRe = 0.0;
  double juliaIm = 0.0;
  std::string juliaReS;    // full-precision Julia seed, kept as text so its
  std::string juliaImS;    // reference orbit can be built in Big
};

/* One term of the reference palette: pal() is the sum of
 *   rgb_i * 0.5*(1 + sin(iter*frequency_i + initial_i))
 * over i = 0..n-1.  These are the original program's palette parameters,
 * read straight out of `colorschemes.json`; `frequency` is in *iterations*,
 * so the band density is a property of the scheme, not of the frame. */
struct PaletteColor {
  float r = 1.0f, g = 1.0f, b = 1.0f;
  float frequency = -0.0393701f;
  float initial = 0.0f;
};

/* One handle of a gradient ramp: `pos` is 0..1 within the cycle, and the
 * colour at a position between two handles is a smoothstep blend — the same
 * interpolation the page draws in its gradient bar, so what the editor shows
 * is what the renderer paints. */
struct GradientStop {
  float pos = 0.0f;
  float r = 0.0f, g = 0.0f, b = 0.0f;
};

struct Palette {
  /* 0 = additive sinusoids (the reference program's own schemes)
   * 1 = gradient ramp (everything the editor produces) */
  int mode = 0;
  int n = 0;
  PaletteColor c[20];
  int ns = 0;
  GradientStop s[32];
  float brightnessFinite = 1.0f;
  float brightnessInfinite = 1.0f;
  float brightnessFactor = 1.0f;
  /* Iterations per natural cycle of this scheme.  For mode 0 it is the
   * period of the dominant sinusoid (1/|frequency|); for mode 1 it is how
   * many iterations one trip along the ramp nominally covers.  The frame
   * fit (see Request::bands) may shrink it, never grow it. */
  float cycleRef = 12.7f;

  /* Tone stage, applied after the palette in this order:
   * saturation -> contrast -> gamma -> per-channel gain -> brightness ->
   * hue-preserving normalise.  Identity values reproduce the original
   * program's look exactly. */
  float brightness = 1.0f;
  float contrast = 1.0f;
  float gamma = 1.0f;
  float saturation = 1.0f;
  float gainR = 1.0f, gainG = 1.0f, gainB = 1.0f;
};

/* Built-in schemes.  0 = "Ice" (the app's default), 1..6 = the six schemes
 * shipped with the reference program (Iteration, Smooth, Distance,
 * Distance+levels, Texture, Iteration copy). */
int paletteCount();
const char* paletteName(int index);
const Palette& builtinPalette(int index);

struct Request {
  // View.  The centre is a decimal string because a preset written with 30
  // digits cannot survive a double round-trip; span = spanMant * 2^spanExp.
  std::string centerRe = "-0.6";
  std::string centerIm = "0";
  double spanMant = 1.6;
  int spanExp = 1;

  // Geometry.  width/height is the rectangle to fill; viewWidth/viewHeight
  // is the frame it belongs to and tileX/tileY its origin there.  A pixel's
  // value depends on its *frame* coordinate only, so tiles are seamless by
  // construction and may be rendered in any order.
  int width = 1;
  int height = 1;
  int viewWidth = 0;
  int viewHeight = 0;
  int tileX = 0;
  int tileY = 0;
  int outPitch = 0;        // row stride in pixels; 0 = width

  /* Explicit per-pixel iteration ceiling supplied by the caller.  The engine
   * never derives it from the zoom: the reference program has no
   * maxiter = f(zoom), it drives the limit from observed pixel work instead
   * (see IterState in mb_core.cpp). */
  int maxIter = 600;
  double offset = 0.0;     // palette phase, in *cycles* (0..1 = one full ramp)
  /* View rotation in radians, counter-clockwise, about the frame centre.  Every
   * one of the reference program's presets carries this angle; a view imported
   * without it comes back turned, which is the most visible difference between
   * "the same view" and "some other view". */
  double rotation = 0.0;
  int bits = 0;            // 0 = derive from the pixel scale
  int quality = 1;         // 0 preview, 1 normal, 2 final
  int aa = 1;              // samples per pixel; 1 = off

  /* Detail level, 0..3.  It sets the smallest feature the frame is asked to
   * resolve: 3 = one pixel (the reference's own behaviour, samples = 2),
   * 2 = two pixels, 1 = four, 0 = eight.  Everything below that size is
   * averaged instead of drawn, which is what the reference program does
   * implicitly — its fine structure only appears once you zoom in far enough
   * for it to be bigger than a pixel.  Without it a deep frame turns into a
   * field of sub-pixel speckle ("密密麻麻") where no line is readable. */
  int detail = 3;

  /* Band density.  The visible iteration range of a frame collapses as you
   * zoom — a deep frame can span two iterations where the palette cycle is
   * two hundred, which paints the whole thing one flat colour.  With
   * `bands` > 0 the engine measures the frame's own range on a coarse grid
   * and fits that many palette cycles into it, so every position keeps the
   * banding it had further out (the reference program does the same).  The
   * fit only ever *raises* the local density: it never goes below the
   * palette's natural cycle, so shallow views keep their original look.
   * `cycle` > 0 overrides the fit with an explicit iterations-per-cycle. */
  int bands = 0;
  double cycle = 0.0;

  /* Colour model, transcribed from the reference's GLSL:
   *   0 Smooth            pal(smoothiter + 0.5)
   *   1 Iteration         pal(iter + 0.5)
   *   2 Distance          black field + white distance rim
   *   3 Distance+levels   both
   * Interior pixels always use pal(-iter + 0.5) with brightnessInfinite,
   * where -iter is the cycle length. */
  int colorMode = 0;
  const Palette* pal = nullptr;
  Spec spec;

  /* Orbit trap requested for this frame, 0 = none:
   *   1 point (closest approach to the origin), 2 line (real axis),
   *   3 circle (unit circle), 4 TIA (triangle-inequality average).
   * The statistic is accumulated by the kernel and delivered in the field's
   * fourth channel instead of the duplicate `dist2`, because the colour stage
   * has no way to recover it from an escape count. */
  int traps = 0;

  /* Whether a field pass needs the two distance channels.  The derivative
   * recurrence D_{n+1} = 2 z_n D_n + 1 is a second complex multiply on every
   * iteration of every pixel; only the two Distance schemes (and any custom
   * codegl declaring CHANNEL_DIST / CHANNEL_DIST2) read the result.  Smooth,
   * Iteration, Gradient ramp and the shipped art shaders do not, so the page
   * tells the kernel to skip it.  Defaults to true for any caller that does
   * not use the GPU field path. */
  bool fieldDist = true;

  /* Whether the field carries z at the escape point (channels 4 and 5).
   *
   * The "Texture" scheme is the only shipped one that reads it, and it costs
   * two extra floats per pixel — 50% more shared-buffer bandwidth — so it is
   * opt-in per request rather than always on.  The reference always has the
   * value in its CVALUE; this field is a flattened equivalent, and a flattened
   * field should not pay for a channel nobody samples. */
  bool fieldValue = false;
};

/* ------------------------------------------------------------------
 * Field — the iteration field, with the colour left out.
 *
 * The reference program does not compute colours on the CPU.  Its kernel
 * produces a *field* (`tex_iter` / `tex_smoothiter` / `tex_dist`), and a GLSL
 * fragment shader turns that field into pixels (`core_fractal.glsl`).  Two
 * consequences, both of which the flat RGBA pipeline cannot express:
 *
 *   - changing a colour scheme costs nothing, because the field is unchanged;
 *   - the shader may be *any* GLSL, including the per-preset `codegl` sources
 *     shipped with the reference's own examples (Amethyst Crown, Nebula
 *     Bloom, Rainbow Veins, Chinese Remainder Clock, High Precision Rainbow),
 *     which are not expressible as `pal()` parameters at all.
 *
 * The layout is one texel per frame pixel, four float channels:
 *
 *   r = smooth iteration count.  Escaped pixels carry the count itself
 *       (`iter - log2(log2|z|²)`, see smoothiter_double 004c98e0.c:39-45);
 *       interior pixels carry the negated period, exactly as the reference's
 *       `data.smoothiter < 0` convention, so the shader decides the region
 *       from the sign alone.
 *   g = distance estimate in *pixels* (already multiplied by the pixel size,
 *       which is what the reference's `pixelsize` uniform does).  Only the
 *       Distance and Distance+levels schemes read it; 0 elsewhere.
 *   b = the raw escape count as a float (negative = negated period).  The
 *       reference keeps this in its own texture (`tex_iter`) because it is NOT
 *       derivable from r: rounding r gives the count only when the bailout
 *       radius happens to be exactly 2.
 *   a = the second distance estimate (`tex_dist2`), same units as g.
 *
 * Four 32-bit floats, not the reference's eight-bit textures: a deep frame
 * spans a handful of iterations over millions of pixels, and quantising the
 * count is what turns a smooth ramp into visible steps.
 * ------------------------------------------------------------------ */
struct Field {
  int w = 0, h = 0;
  int pitch = 0;                  // texels per row; 0 = w
  /* 4 by default: smoothiter / dist / iter / dist2, the channels the colour
   * shader has always read.  The VALUE scheme (colorschemes.json "Texture",
   * channels 0x1007) also samples z at the escape point, which is two more
   * floats — 50% more bandwidth — so they are only produced when a scheme
   * actually declares CHANNEL_VALUE. */
  int channels = 4;
  /* Planar, not interleaved: the first 4 floats of every texel form one plane
   * (smoothiter / dist / iter / dist2) and the value texel — z at the escape
   * point — forms a second plane right after it.  That is exactly the split
   * the shader wants (tex_field is RGBA32F, tex_field2 is RG32F), so the page
   * can hand both halves to the GPU as subarray views without repacking a
   * single float.  An interleaved layout would force a 15 M float rewrite per
   * frame on a 2.5 Mpx window. */
  std::vector<float> data;        // pitch*h*channels floats, row-major, top first

  /* Caller-owned storage.
   *
   * The desktop shell publishes the field through a WebView2 shared buffer that
   * the page reads directly.  Writing into that buffer from the kernel removes
   * a whole 47 MB vector allocation, its zero-fill and a 47 MB memcpy for every
   * field pass — three of which happen on a progressive frame.  `adopt()` is
   * the seam: the kernel writes through `at()` exactly as before, only the
   * backing memory changes.  `externalFloats` is the capacity in floats, so a
   * short buffer can never become a heap overrun. */
  float* external = nullptr;
  size_t externalFloats = 0;

  /* Counts, for the HUD: how much of the frame is interior, and the escape
   * range the shader will see.  Filled by renderField(). */
  int bounded = 0, escapeMin = 0, escapeMax = 0;

  void resize(int width, int height, int ch = 4) {
    w = width;
    h = height;
    pitch = width;
    channels = ch;
    external = nullptr;
    externalFloats = 0;
    data.assign((size_t)pitch * (size_t)height * (size_t)ch, 0.0f);
  }

  /** Write straight into `ptr`, which must hold at least w*h*ch floats. */
  void adopt(int width, int height, void* ptr, size_t capacityFloats,
             int ch = 4) {
    w = width;
    h = height;
    pitch = width;
    channels = ch;
    external = static_cast<float*>(ptr);
    externalFloats = capacityFloats;
    /* swap(), unlike clear()+shrink_to_fit(), is guaranteed to release the
     * allocation — this object may be reused across frames. */
    std::vector<float>().swap(data);
  }

  float* base() { return external ? external : data.data(); }
  const float* base() const { return external ? external : data.data(); }
  /* The colour plane: always four floats per texel, whatever `channels` is. */
  float* at(int x, int y) {
    return base() + ((size_t)y * pitch + x) * 4;
  }
  /* The value plane (CHANNEL_VALUE): two floats per texel, immediately after
   * the colour plane.  Only valid when channels > 4. */
  float* atValue(int x, int y) {
    return base() + (size_t)pitch * (size_t)h * 4 +
           ((size_t)y * pitch + x) * 2;
  }

  /** Is the current backing store big enough for this frame? */
  bool fits(int width, int height, int ch = 4) const {
    const size_t need = (size_t)width * (size_t)height * (size_t)ch;
    if (w != width || h != height || pitch != width || channels != ch)
      return false;
    return external ? externalFloats >= need : data.size() >= need;
  }
};

struct Stats {
  int bits = 0;
  bool perturb = false;
  int refLen = 0;
  int skip = 0;            // series-approximation depth used
  int references = 1;
  int glitchFixed = 0;
  int glitches = 0;
  int baseIter = 0;        // the per-pixel limit actually used this frame
  int maxIterUsed = 0;
  /* Observed iteration control, transcription of processcanvasfinite_hfloat
   * (0046f630.c:81-114,197-205) and checkcanvas_hfloat (00498570.c).
   * `iterCeiling` is the caller's explicit ceiling; `cornerKnown` is the
   * largest iteration of the four corner vertices; `iterBudget` is
   * cornerKnown*3+3000; `observedMax` is canvas->maxiter, the largest
   * iteration actually observed so far; `refinePass` counts idle passes. */
  int iterCeiling = 0;
  int cornerKnown = 0;
  int iterBudget = 0;
  int observedMax = 0;
  int refinePass = 0;
  int interpolated = 0;    // pixels filled from the canvas instead of iterated
  int canvasCells = 0;     // cells accepted for interpolation
  /* Measured work, not an estimate.
   *
   * `iterPixels` is the number of *map iterations actually performed* on this
   * tile: every pixel the raster integrated contributes its escape count (or
   * its limit, for an interior pixel), and every canvas vertex contributes
   * what its own orbit cost.  The ratio to `pixels` is the quantity the
   * canvas is supposed to move, so it is counted rather than inferred. */
  long long iterPixels = 0;
  int canvasVerts = 0;     // vertices integrated by the quadtree canvas
  int canvasFilled = 0;    // pixels written by canvas interpolation
  int canvasRejects = 0;   // cells that could not be interpolated at tolerance
  int canvasCacheHit = 0;  // 1 = this tile came from the per-area texture cache
  int aaPixels = 0;        // pixels resampled by the adaptive supersampler
  int pixels = 0;
  /* What the frame actually needed, as opposed to what it was allowed.
   * `escapeMin/Max` is the range of escape counts over the escaped pixels;
   * the colour cycle is fitted to it so a smooth region still shows bands
   * instead of one flat wash.  `bounded` counts the interior pixels. */
  int escapeMin = 0;
  int escapeMax = 0;
  int bounded = 0;
  int directFixed = 0;     // pixels recomputed because no reference described them
  double iterPerCycle = 0; // palette cycle the frame was actually fitted with
  int rebases = 0;         // how often a pixel had to re-anchor (diagnostic)
  double psLog2 = 0.0;
  double orbitMs = 0.0;
  double renderMs = 0.0;
  double frameMs = 0.0;
  int threads = 1;
  bool orbitReused = false;
};

class Engine {
public:
  explicit Engine(int threads = 0);   // 0 = hardware concurrency
  ~Engine();

  /** Render one rectangle into `out` (RGBA, width*height*4, top row first). */
  void render(const Request& req, uint8_t* out, Stats& stats);

  /** Compute the iteration field for one rectangle, with no colour work at all.
   *
   *  This is the reference program's actual split: the CPU produces the field,
   *  the shader produces the pixels.  `field` must already be sized to
   *  req.width x req.height (`Field::resize`), and its origin corresponds to
   *  the request's tile origin.  The stats are the same ones render() reports,
   *  so the two paths can be compared frame for frame. */
  void renderField(const Request& req, Field& field, Stats& stats);

  /** Ask the render in flight to stop at the next strip. */
  void cancel();

  /** Workers park while paused (minimised window). */
  void setPaused(bool paused);

  int threadCount() const;
  int lastRefLen() const;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

/* Vertex recalculation budget of the original program.
 *   0046f630.c:104-114  maxiter = known*3 + 3000
 *                       no known corner -> canvas->maxiter*5, else 0x2aaaa2da
 *   0046f630.c:197      recalc gate      cvalue->maxiter < known*3 + 1000
 * `known` is the largest iteration among the four corner vertices, never a
 * function of the zoom.  The result is clamped to a practical hard cap. */
int vertexIterBudget(int known, int observedMax);

/* Bits needed to place one pixel at this scale, with the orbit-accuracy and
 * guard allowances folded in. */
int requiredBits(double psLog2, int maxIter);

}  // namespace mbc
