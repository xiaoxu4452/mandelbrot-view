// adapter.cpp — the C ABI surface the web worker drives.
//
// The core is the desktop core's own source (C:\Users\harve\Desktop\mande\new\
// src, mirrored by build.mjs).  This file adds no algorithm: it fills the
// core's RenderRequest the way mset.exe's cmd_render does, calls the same
// render_image(), and copies the outcome (RGB image or 4-channel field) plus
// RenderStats out through flat module memory.
//
// It also owns the VIEW.  `mandelbrot-core`'s plan puts the view in
// src/viewport.hpp — point_at / zoom_by / pan_pixels, taken over from the
// recovered app_state.cpp — and the page used to reimplement that same
// arithmetic in JavaScript, so the two could disagree.  The page now posts raw
// input ("zoom about this pixel", "pan by these pixels") and reads the resulting
// centre back, exactly like the desktop shell.

#include "render.hpp"
#include "reference.hpp"
#include "viewport.hpp"
#include "mb_noexcept.hpp"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::atomic<bool> g_cancel{false};
Image g_img;
std::vector<float> g_field4;
std::string g_error;
int g_out_mode = 0;  // 0 = RGB bytes, 1 = f32 field4

struct StatsPOD {
    double seconds;
    int64_t pixels;
    int64_t glitches;
    int64_t sa_skipped;
    int64_t tile_refs;
    int32_t ref_len;
    int32_t prec_digits;
    double log10_zoom;
    double pixel_scale_log10;
    int64_t steps;
    int32_t max_esc;
    int32_t min_esc;
    int32_t cancelled;
    int32_t pad;
};
static_assert(sizeof(StatsPOD) == 88, "stats POD layout");
StatsPOD g_stats{};

const char* cstr(int32_t p) { return reinterpret_cast<const char*>(static_cast<uintptr_t>(p)); }

/* ---- the view ---------------------------------------------------------- */

/* Function-local statics, not namespace-scope objects.
 *
 * zig's wasm link produces a module with `_start` but no `_initialize`, and
 * nothing calls `_start`, so no static constructor ever runs: a global
 * `Viewport` is zeroed memory.  Measured symptom: `max_precision_digits` read
 * back as 0, the precision plan collapsed to 0 digits, and every centre was
 * printed with four decimals.  A function-local static is constructed on first
 * use, which is an ordinary runtime call and needs no host cooperation. */
Viewport& view() {
    static Viewport v;
    return v;
}
std::string& cre_txt() { static std::string s = "-0.6"; return s; }
std::string& cim_txt() { static std::string s = "0.0"; return s; }

/** Re-print the centre at the width the current zoom needs. */
void refresh_center_text() {
    view().recalc();
    const int dec = view().plan.digits + 4;
    cre_txt() = view().center_re.to_fixed(dec);
    cim_txt() = view().center_im.to_fixed(dec);
}

/* ---- render ------------------------------------------------------------ */

int32_t render_from(const std::string& cre, const std::string& cim,
                    double zoomMant, int64_t zoomExp10, int w, int h,
                    int32_t maxiter, bool julia, const std::string& jre,
                    const std::string& jim, const std::string& palette,
                    double paletteScale, int32_t colorMode, int32_t saOrder,
                    int32_t useSa, int32_t tileRebase, int32_t exact,
                    int32_t threads, double rotCos, double rotSin,
                    int32_t interiorPalette, double span) {
    g_error.clear();
    mbxx::clear_error();
    g_cancel.store(false);

    // Pin the self-contained backend: in wasm there is no DLL to dlopen.
    orbit_set_backend(0);

    RenderRequest req;
    req.center_re = cre;
    req.center_im = cim;
    req.zoom_mantissa = zoomMant > 0.0 ? zoomMant : 1.0;
    req.zoom_exp10 = zoomExp10;
    req.width = w;
    req.height = h;
    req.maxiter = maxiter;
    req.precision_digits = 0;   // automatic: digits = log10(zoom) + 50
    req.max_precision_digits = 1200000;
    req.threads = threads > 0 ? threads : 1;   // wasm: single-threaded
    req.tile_size = 64;
    req.sa_order = saOrder;
    req.use_sa = useSa != 0;
    req.use_distance = false;
    req.exact = exact != 0;
    req.tile_rebase = tileRebase != 0;
    req.invert = false;
    req.palette = palette;
    req.palette_scale = paletteScale;
    switch (colorMode) {
        case 1: req.color_mode = ColorMode::Iteration; break;
        case 2: req.color_mode = ColorMode::Distance; break;
        case 3: req.color_mode = ColorMode::Binary; break;
        default: req.color_mode = ColorMode::Smooth; break;
    }
    req.span = span > 0.0 ? span : 3.0;   // zoom = span / window width
    req.distance_param = 0.0;
    req.julia = julia;
    if (req.julia) {
        req.julia_re = jre;
        req.julia_im = jim;
    }
    req.interior_palette = interiorPalette != 0;
    req.rot_cos = rotCos;
    req.rot_sin = rotSin;
    req.band_iters = 0.0;       // auto: one band per 1/32 of the frame's span
    req.cancel = &g_cancel;
    req.on_tile = nullptr;

    // Empty palette name => field4 mode: the core writes the 4-channel field
    // and the viewer owns the gradient (the desktop shell's contract).
    const bool field_mode = req.palette.empty();
    if (field_mode) {
        g_field4.assign(static_cast<size_t>(w) * h * 4, 0.0f);
        req.field4 = g_field4.data();
        /* No derivative channels: the page shades the smooth iteration only,
         * so the distance would be computed and thrown away.  Leaving it off
         * also keeps the 4-wide perturbation loop eligible (`quad_usable`
         * refuses a reference that wants distance), measured 1.36x faster on
         * a 10^600 frame. */
        req.field_distance = false;
    } else {
        req.field4 = nullptr;
    }

    g_img = Image{};
    RenderStats st;
    const bool ok = render_image(req, g_img, st, &g_error);

    g_stats.seconds = st.seconds;
    g_stats.pixels = st.pixels;
    g_stats.glitches = st.glitches;
    g_stats.sa_skipped = st.sa_skipped_iters;
    g_stats.tile_refs = st.tile_references;
    g_stats.ref_len = st.reference_length;
    g_stats.prec_digits = st.precision_digits;
    g_stats.log10_zoom = st.log10_zoom;
    g_stats.pixel_scale_log10 = st.pixel_scale_log10;
    g_stats.steps = st.steps;
    g_stats.max_esc = st.max_escape_iter;
    g_stats.min_esc = st.min_escape_iter;
    g_stats.cancelled = st.cancelled ? 1 : 0;
    g_stats.pad = 0;

    g_out_mode = field_mode ? 1 : 0;
    return ok ? 0 : 1;
}

}  // namespace

extern "C" {

__attribute__((export_name("mb_alloc")))
void* mb_alloc(int32_t n) { return std::malloc(static_cast<size_t>(n)); }

__attribute__((export_name("mb_free")))
void mb_free(void* p, int32_t n) { std::free(p); (void)n; }

__attribute__((export_name("mb_cancel")))
void mb_cancel(int32_t v) { g_cancel.store(v != 0); }

__attribute__((export_name("mb_version")))
const char* mb_version() {
    // Same source tree as the desktop core; the desktop --version prints 0.9.
    return "mandelbrot-core 0.9 web (backend: bigfloat, view in core)";
}

__attribute__((export_name("mb_backend")))
const char* mb_backend() { return orbit_backend_name(); }

__attribute__((export_name("mb_error")))
const char* mb_error() { return g_error.c_str(); }

__attribute__((export_name("mb_out_mode")))
int32_t mb_out_mode() { return g_out_mode; }

__attribute__((export_name("mb_out_ptr")))
int32_t mb_out_ptr() {
    const void* p = (g_out_mode == 1) ? static_cast<const void*>(g_field4.data())
                                      : static_cast<const void*>(g_img.rgb.data());
    return static_cast<int32_t>(reinterpret_cast<uintptr_t>(p));
}

__attribute__((export_name("mb_out_size")))
int32_t mb_out_size() {
    const long long n = (g_out_mode == 1) ? static_cast<long long>(g_field4.size()) * 4
                                          : static_cast<long long>(g_img.rgb.size());
    return static_cast<int32_t>(n);
}

__attribute__((export_name("mb_stats_ptr")))
int32_t mb_stats_ptr() {
    return static_cast<int32_t>(reinterpret_cast<uintptr_t>(&g_stats));
}

/* ---- view: set / inspect ------------------------------------------------ */

/* mb_view_set(re, im, zoomMant, zoomExp10, w, h, span)
 *
 * Sets the whole view at once.  The precision plan is computed from the zoom
 * *before* the centre is parsed: BigFloat::from_string truncates to the current
 * thread-local width, so parsing a deep centre at a shallow width would drop
 * digits and the frame would drift (measured on the desktop: 180-digit centre
 * cut to 90). */
__attribute__((export_name("mb_view_set")))
int32_t mb_view_set(int32_t centerRe, int32_t centerIm, double zoomMant,
                    int32_t zoomExp10, int32_t w, int32_t h, double span) {
    mbxx::clear_error();
    view().zoom_mantissa = zoomMant > 0.0 ? zoomMant : 1.0;
    view().zoom_exp10 = static_cast<int64_t>(zoomExp10);
    view().width = w > 0 ? w : 1;
    view().height = h > 0 ? h : 1;
    if (span > 0.0) view().span = span;
    view().recalc();
    view().center_re = BigFloat::from_string(cstr(centerRe));
    if (mbxx::take_error()) return 1;
    view().center_im = BigFloat::from_string(cstr(centerIm));
    if (mbxx::take_error()) return 2;
    refresh_center_text();
    return 0;
}

__attribute__((export_name("mb_view_resize")))
void mb_view_resize(int32_t w, int32_t h) {
    view().width = w > 0 ? w : 1;
    view().height = h > 0 ? h : 1;
}

/* mb_view_zoom_at(x, y, factor) — out/src/app/app_state.cpp:40, three lines:
 *     before = point_at(x, y);  zoom_by(factor);  after = point_at(x, y);
 *     centre += before - after;
 * The anchor is the integer pixel that contains (x, y), which is what the
 * desktop does; anything finer would need a sub-pixel point_at the recovered
 * model does not have. */
__attribute__((export_name("mb_view_zoom_at")))
int32_t mb_view_zoom_at(double x, double y, double factor) {
    if (!(factor > 0.0) || !std::isfinite(factor)) return 1;
    const int px = static_cast<int>(std::floor(x));
    const int py = static_cast<int>(std::floor(y));
    auto before = view().point_at(px, py);
    view().zoom_by(factor);
    auto after = view().point_at(px, py);
    view().center_re = view().center_re + (before.first - after.first);
    view().center_im = view().center_im + (before.second - after.second);
    refresh_center_text();
    return 0;
}

__attribute__((export_name("mb_view_pan")))
void mb_view_pan(double dx, double dy) {
    view().pan_pixels(dx, dy);
    refresh_center_text();
}

/* A pinch is exactly two recovered operations, in this order:
 *   (1) zoom about the *new* midpoint:  centre += d*(1-f)
 *   (2) pan by the midpoint's own motion, measured at the new scale
 * Doing it here keeps the page from re-deriving geometry it should not own.
 * mid0 = midpoint at gesture start, (mx,my) = midpoint now, f = span ratio. */
__attribute__((export_name("mb_view_pinch")))
int32_t mb_view_pinch(double mid0x, double mid0y, double mx, double my,
                      double factor) {
    if (!(factor > 0.0) || !std::isfinite(factor)) return 1;
    if (mb_view_zoom_at(mx, my, factor) != 0) return 1;
    view().pan_pixels((mid0x - mx) / factor, (mid0y - my) / factor);
    refresh_center_text();
    return 0;
}

__attribute__((export_name("mb_view_center_re")))
const char* mb_view_center_re() { return cre_txt().c_str(); }

__attribute__((export_name("mb_view_center_im")))
const char* mb_view_center_im() { return cim_txt().c_str(); }

__attribute__((export_name("mb_view_zoom_mant")))
double mb_view_zoom_mant() { return view().zoom_mantissa; }

__attribute__((export_name("mb_view_zoom_exp10")))
int32_t mb_view_zoom_exp10() { return static_cast<int32_t>(view().zoom_exp10); }

__attribute__((export_name("mb_view_digits")))
int32_t mb_view_digits() { view().recalc(); return view().plan.digits; }

/* log10 of the complex span, i.e. how wide the frame is on the plane. */
__attribute__((export_name("mb_view_span_log10")))
double mb_view_span_log10() {
    const Fexp s = view().complex_span();
    return std::log10(s.m) + static_cast<double>(s.e);
}

/* Diagnostics for the view test: [digits, limbs, user_digits, max_digits]. */
__attribute__((export_name("mb_view_diag")))
int32_t mb_view_diag(int32_t which) {
    view().recalc();
    switch (which) {
        case 0: return view().plan.digits;
        case 1: return view().plan.limbs;
        case 2: return view().precision_digits;
        case 3: return view().max_precision_digits;
        default: return 0;
    }
}

/* ---- render the current view ------------------------------------------- */

__attribute__((export_name("mb_view_render")))
int32_t mb_view_render(int32_t w, int32_t h, int32_t maxiter, int32_t julia,
                       int32_t juliaRe, int32_t juliaIm, int32_t palette,
                       double paletteScale, int32_t colorMode, int32_t saOrder,
                       int32_t useSa, int32_t tileRebase, int32_t exact,
                       int32_t threads, double rotCos, double rotSin,
                       int32_t interiorPalette) {
    /* The frame may be smaller than the view's own size (a 0.36x gesture
     * preview), and that is fine: complex_span does not depend on the pixel
     * count, so the same zoom covers the same region at any resolution.  Only
     * point_at / pan_pixels need the full-resolution width. */
    return render_from(cre_txt(), cim_txt(), view().zoom_mantissa,
                       view().zoom_exp10,
                       w > 0 ? w : view().width, h > 0 ? h : view().height,
                       maxiter, julia != 0,
                       julia ? cstr(juliaRe) : std::string(),
                       julia ? cstr(juliaIm) : std::string(),
                       cstr(palette), paletteScale, colorMode, saOrder, useSa,
                       tileRebase, exact, threads, rotCos, rotSin,
                       interiorPalette, view().span);
}

/* ---- horizontal strips: one frame, several wasm instances --------------
 *
 * wasm here is single-threaded (GitHub Pages cannot send COOP/COEP, so no
 * SharedArrayBuffer and no pthreads).  The cheap way to use a phone's cores is
 * therefore N independent instances, each rendering a horizontal band of the
 * same frame: rows do not depend on each other, and the only shared piece —
 * the reference orbit — is a small fraction of the cost at every depth
 * measured (12 ms of a 1300 ms 10^600 frame).
 *
 * A band's centre is the frame centre shifted by half the band's offset at the
 * frame's own pixel scale, computed here in BigFloat; the page never
 * arithmetic-shifts a coordinate.
 */
Viewport& strip_view() { static Viewport v; return v; }

__attribute__((export_name("mb_render_strip")))
int32_t mb_render_strip(int32_t centerRe, int32_t centerIm, double zoomMant,
                        int32_t zoomExp10, int32_t width, int32_t heightFull,
                        int32_t y0, int32_t y1, int32_t maxiter, int32_t julia,
                        int32_t juliaRe, int32_t juliaIm, int32_t palette,
                        double paletteScale, int32_t colorMode, int32_t saOrder,
                        int32_t useSa, int32_t tileRebase, int32_t exact,
                        int32_t threads, double rotCos, double rotSin,
                        int32_t interiorPalette) {
    if (y1 <= y0 || heightFull <= 0 || width <= 0) return 3;
    mbxx::clear_error();
    Viewport& v = strip_view();
    v.zoom_mantissa = zoomMant > 0.0 ? zoomMant : 1.0;
    v.zoom_exp10 = static_cast<int64_t>(zoomExp10);
    v.width = width;
    v.height = heightFull;              // pixel scale comes from the full frame
    v.recalc();
    v.center_re = BigFloat::from_string(cstr(centerRe));
    if (mbxx::take_error()) return 1;
    v.center_im = BigFloat::from_string(cstr(centerIm));
    if (mbxx::take_error()) return 2;
    const double dy = 0.5 * (static_cast<double>(y0) + static_cast<double>(y1))
                    - 0.5 * static_cast<double>(heightFull);
    v.pan_pixels(0.0, dy);
    const int dec = v.plan.digits + 4;
    const std::string cre = v.center_re.to_fixed(dec);
    const std::string cim = v.center_im.to_fixed(dec);
    return render_from(cre, cim, v.zoom_mantissa, v.zoom_exp10,
                       width, y1 - y0, maxiter, julia != 0,
                       julia ? cstr(juliaRe) : std::string(),
                       julia ? cstr(juliaIm) : std::string(),
                       cstr(palette), paletteScale, colorMode, saOrder, useSa,
                       tileRebase, exact, threads, rotCos, rotSin,
                       interiorPalette, v.span);
}

/* ---- legacy ABI: explicit coordinates ---------------------------------- */

__attribute__((export_name("mb_render")))
int32_t mb_render(int32_t centerRe, int32_t centerIm,
                  double zoomMant, int32_t zoomExp10,
                  int32_t width, int32_t height, int32_t maxiter,
                  int32_t julia, int32_t juliaRe, int32_t juliaIm,
                  int32_t palette, double paletteScale, int32_t colorMode,
                  int32_t saOrder, int32_t useSa, int32_t tileRebase,
                  int32_t exact, int32_t threads,
                  double rotCos, double rotSin, int32_t interiorPalette) {
    return render_from(cstr(centerRe), cstr(centerIm), zoomMant, zoomExp10,
                       width, height, maxiter, julia != 0,
                       julia ? cstr(juliaRe) : std::string(),
                       julia ? cstr(juliaIm) : std::string(),
                       cstr(palette), paletteScale, colorMode, saOrder, useSa,
                       tileRebase, exact, threads, rotCos, rotSin,
                       interiorPalette, 3.0);
}

}  // extern "C"
