// adapter.cpp — the C ABI surface the web worker drives.
//
// This file contains zero algorithm logic. It fills the desktop core's
// RenderRequest exactly the way mset.exe's cmd_render does, calls the same
// render_image() the desktop CLI and the desktop shell call, and copies the
// outcome (RGB image or 4-channel field) plus RenderStats out through flat
// module memory. Same core, same numbers, same tiles.

#include "render.hpp"
#include "reference.hpp"
#include "mb_noexcept.hpp"

#include <atomic>
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
    return "mandelbrot-core 0.9 web (backend: bigfloat)";
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

__attribute__((export_name("mb_render")))
int32_t mb_render(int32_t centerRe, int32_t centerIm,
                  double zoomMant, int32_t zoomExp10,
                  int32_t width, int32_t height, int32_t maxiter,
                  int32_t julia, int32_t juliaRe, int32_t juliaIm,
                  int32_t palette, double paletteScale, int32_t colorMode,
                  int32_t saOrder, int32_t useSa, int32_t tileRebase,
                  int32_t exact, int32_t threads,
                  double rotCos, double rotSin, int32_t interiorPalette) {
    g_error.clear();
    mbxx::clear_error();
    g_cancel.store(false);

    // Pin the self-contained backend: in wasm there is no DLL to dlopen.
    orbit_set_backend(0);

    RenderRequest req;
    req.center_re = cstr(centerRe);
    req.center_im = cstr(centerIm);
    req.zoom_mantissa = zoomMant > 0.0 ? zoomMant : 1.0;
    req.zoom_exp10 = static_cast<int64_t>(zoomExp10);
    req.width = width;
    req.height = height;
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
    req.palette = cstr(palette);
    req.palette_scale = paletteScale;
    switch (colorMode) {
        case 1: req.color_mode = ColorMode::Iteration; break;
        case 2: req.color_mode = ColorMode::Distance; break;
        case 3: req.color_mode = ColorMode::Binary; break;
        default: req.color_mode = ColorMode::Smooth; break;
    }
    req.span = 3.0;             // desktop CLI default: zoom = 3 / window width
    req.distance_param = 0.0;
    req.julia = julia != 0;
    if (req.julia) {
        req.julia_re = cstr(juliaRe);
        req.julia_im = cstr(juliaIm);
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
        g_field4.assign(static_cast<size_t>(width) * height * 4, 0.0f);
        req.field4 = g_field4.data();
        req.field_distance = true;
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

    if (field_mode) {
        g_out_mode = 1;
    } else {
        g_out_mode = 0;
    }
    return ok ? 0 : 1;
}

}  // extern "C"
