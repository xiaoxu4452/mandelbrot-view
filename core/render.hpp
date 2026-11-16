// Scientific Mandelbrot renderer.
//
// Pipeline per tile:
//   1. reference orbit  z_{n+1} = z_n^2 + c   in BigFloat at planned precision
//   2. per-pixel normalized perturbation
//        D_0 = 1,  d_0 = pixel offset
//        z_n = Z_n + d_0 D_n
//        D_{n+1} = 2 Z_n D_n + d_0 D_n^2 + 1
//   3. optional series-approximation skip (A_k from multaylor/radtest)
//   4. smooth iteration + optional distance estimate
//
// A tile that reports cancellation glitches is re-rendered with a reference
// orbit anchored at the tile centre, mirroring newref_hfloat's hierarchy of
// local high-precision references.

#pragma once

#include "bigfloat.hpp"
#include "floatexp.hpp"
#include "image.hpp"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

enum class ColorMode { Smooth, Iteration, Distance, Binary };

// One pixel's result.  Exposed so tests and tools can compare the direct,
// perturbation and exact kernels on the same input.
struct PixelOut {
    int iter = -1;          // -1 => reached maxiter (interior)
    double smooth = -1.0;
    double dist = 0.0;
    bool interior = false;
    int glitch = 0;
    int skipped = 0;
};

struct RenderRequest {
    std::string center_re = "-0.6";
    std::string center_im = "0.0";
    double zoom_mantissa = 1.0;
    int64_t zoom_exp10 = 0;        // zoom = mantissa * 10^exp10
    int width = 800;
    int height = 600;
    int maxiter = 2000;
    int precision_digits = 0;      // 0 = automatic from zoom
    int max_precision_digits = 1200000;
    int threads = 0;               // 0 = hardware concurrency
    int tile_size = 64;
    int sa_order = 16;             // 0 disables series approximation
    bool use_sa = true;
    bool use_distance = false;
    bool exact = false;            // direct BigFloat per pixel (validation)
    bool tile_rebase = true;       // retry glitched tiles with a local reference
    bool invert = false;
    std::string palette = "rainbow";
    ColorMode color_mode = ColorMode::Smooth;
    double span = 3.0;             // complex width at zoom = 1
    // The reference shader feeds raw iteration counts to pal(); at deep zoom
    // that cycles thousands of times.  A positive value is used literally;
    // 0 (default) selects an automatic scale by zoom depth.
    double palette_scale = 0.0;
    double distance_param = 0.0;   // distance scheme param[0], exp(5*param)
    bool julia = false;            // Julia mode: z0 = pixel, c = fixed parameter
    std::string julia_re = "0.0"; // fixed c for Julia mode
    std::string julia_im = "0.0";
    bool interior_palette = false; // original iter<0 colouring for interior points

    // ---- integration hooks (consumed by the desktop shell) -----------------
    // View rotation.  The reference engine rotates the whole view plane about
    // the frame centre; the renderer here maps pixels to plane offsets, so the
    // rotation belongs in that map and nowhere else.  Identity by default, and
    // the identity path is bit-for-bit the unrotated code.
    double rot_cos = 1.0;
    double rot_sin = 0.0;

    // Colour-coordinate field.  When non-null, one float per pixel is written
    // here -- the palette coordinate t, or NaN for interior pixels -- and no
    // palette is applied.  A viewer that owns its own gradient then shades
    // from the field, so changing colours costs a shading pass (milliseconds)
    // instead of another perturbation render.
    float* field = nullptr;

    // Four-channel field, the desktop shell's contract:
    //   [0] smooth iteration   (interior: negative, so a shader can test < 0)
    //   [1] distance in pixels (|z| log|z| / |dz/dc| / pixel scale)
    //   [2] integer iteration  (same interior encoding)
    //   [3] linear distance to the escape circle (0 with this bail-out)
    // Interleaved, four floats per pixel.  Used instead of `field` when set.
    float* field4 = nullptr;
    bool field_distance = true;    // compute channels 1 and 3

    // Iterations per palette band.  A fixed value is used literally; 0 selects
    // one band per ~1/32 of the frame's own escape span, which is the only
    // scale that keeps deep frames from collapsing into a single colour band
    // (at 1e38 the whole frame spans 129 iterations, so a fixed 0.005/iteration
    // coordinate would put four thousandths of one ramp across the picture).
    double band_iters = 0.0;

    // Cooperative cancellation.  Checked once per row block: a frame that is
    // already running stops within a few milliseconds instead of holding the
    // view hostage until it finishes.
    const std::atomic<bool>* cancel = nullptr;

    // Progressive delivery.  Called on the painting thread as soon as a band
    // of rows has been written; the rect is exclusive to that thread, so a
    // callback may copy it directly.  Concurrent calls are possible.
    std::function<void(const Image&, int x0, int y0, int w, int h)> on_tile;
};

struct RenderStats {
    double seconds = 0.0;
    long long pixels = 0;
    long long glitches = 0;
    long long sa_skipped_iters = 0;
    long long tile_references = 0;
    int reference_length = 0;
    int precision_digits = 0;
    int precision_limbs = 0;
    double log10_zoom = 0.0;
    double pixel_scale_log10 = 0.0;
    long long steps = 0;            // perturbation steps actually executed

    // Largest escape count among pixels that actually escaped.  If this equals
    // maxiter-1 the budget was too small for the frame, which is the only
    // evidence that raising the ceiling is justified (interior pixels are not
    // evidence: they never escape by definition).
    int max_escape_iter = 0;
    int min_escape_iter = 0;
    // Set when `cancel` fired: `out` holds the rows finished before the stop.
    bool cancelled = false;
    // Iterations per palette band actually used (0 when the field is 4-channel
    // and the viewer owns the palette).  A shader that fits its own cycle needs
    // this number or the picture collapses to one band at depth.
    double band_iters = 0.0;
    int bounded = 0;               // interior pixel count
};

bool render_image(const RenderRequest& req, Image& out, RenderStats& stats, std::string* error);
