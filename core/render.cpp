#include "render.hpp"

#include "bigfloat.hpp"
#include "deep.hpp"
#include "exact.hpp"
#include "floatexp.hpp"
#include "palette.hpp"
#include "reference.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <limits>
#include <thread>
#include <vector>

namespace {

// Pixel (px, py) -> plane offset in pixels, rotated about the frame centre.
// The reference engine applies the view rotation to this mapping, so a view
// turned by theta is exactly the same frame with this basis turned; nothing
// else in the pipeline has to know about it.
inline void frame_offset(const RenderRequest& req, double px, double py,
                         double& ox, double& oy) {
    const double x = px - (double)req.width * 0.5;
    const double y = (double)req.height * 0.5 - py;
    if (req.rot_sin == 0.0 && req.rot_cos == 1.0) {
        ox = x;
        oy = y;
        return;
    }
    ox = req.rot_cos * x - req.rot_sin * y;
    oy = req.rot_sin * x + req.rot_cos * y;
}

// Shallow views: the pixel offsets are well inside double's absolute
// resolution, so iterating c directly is both simpler and faster.
PixelOut pixel_double(double cr, double ci, double scale, double dx, double dy, int maxiter,
                      bool want_distance) {
    PixelOut po;
    const double cre = cr + scale * dx;
    const double cim = ci + scale * dy;
    double zr = 0.0, zi = 0.0, dzr = 1.0, dzi = 0.0;
    const double bailout = want_distance ? 256.0 : 2.0;
    const double bail2 = bailout * bailout;
    for (int n = 0; n < maxiter; ++n) {
        const double z2 = zr * zr + zi * zi;
        if (z2 > bail2) {
            po.iter = n;
            const double logz = 0.5 * std::log(std::max(z2, 1e-300));
            double ratio = logz / std::log(bailout);
            if (ratio < 1e-15) ratio = 1e-15;
            po.smooth = (double)n + 1.0 - std::log2(ratio);
            if (po.smooth < 0.0) po.smooth = 0.0;
            if (want_distance) {
                const double zm = std::sqrt(z2);
                const double dzm = std::sqrt(dzr * dzr + dzi * dzi);
                if (dzm > 0.0) po.dist = zm * std::log(std::max(zm, 1e-300)) / dzm / scale;
            }
            return po;
        }
        const double nr = zr * zr - zi * zi + cre;
        const double ni = 2.0 * zr * zi + cim;
        const double ndr = 2.0 * (zr * dzr - zi * dzi) + 1.0;
        const double ndi = 2.0 * (zr * dzi + zi * dzr);
        zr = nr;
        zi = ni;
        dzr = ndr;
        dzi = ndi;
    }
    po.interior = true;
    po.iter = -1;
    po.smooth = -1.0;
    return po;
}

PixelOut pixel_julia_double(double z0r, double z0i, double cre, double cim, double scale,
                            double dx, double dy, int maxiter, bool want_distance) {
    PixelOut po;
    double zr = z0r + scale * dx;
    double zi = z0i + scale * dy;
    const double bailout = want_distance ? 256.0 : 2.0;
    const double bail2 = bailout * bailout;
    for (int n = 0; n < maxiter; ++n) {
        const double z2 = zr * zr + zi * zi;
        if (z2 > bail2) {
            po.iter = n;
            const double logz = 0.5 * std::log(std::max(z2, 1e-300));
            double ratio = logz / std::log(bailout);
            if (ratio < 1e-15) ratio = 1e-15;
            po.smooth = (double)n + 1.0 - std::log2(ratio);
            if (po.smooth < 0.0) po.smooth = 0.0;
            return po;
        }
        const double nr = zr * zr - zi * zi + cre;
        const double ni = 2.0 * zr * zi + cim;
        zr = nr;
        zi = ni;
    }
    po.interior = true;
    po.iter = -1;
    po.smooth = -1.0;
    return po;
}

double effective_palette_scale(const RenderRequest& req) {
    if (req.palette_scale > 0.0) return req.palette_scale;
    const double lz = std::log10(req.zoom_mantissa) + (double)req.zoom_exp10;
    if (lz < 3.0) return 1.0;
    return std::clamp(15.0 / (double)std::max(req.maxiter, 1), 0.0005, 0.05);
}

RGB paint(const RenderRequest& req, const Palette& pal, const PixelOut& p, double ps, double t) {
    if (req.color_mode == ColorMode::Binary) {
        if (p.interior) return {0, 0, 0};
        return {1, 1, 1};
    }
    if (p.interior) {
        if (!req.interior_palette) return {0, 0, 0};
        RGB c = pal.eval(std::abs((double)p.iter) * ps + 0.5);
        if (req.invert) { c.r = 1.0 - c.r; c.g = 1.0 - c.g; c.b = 1.0 - c.b; }
        return c;
    }
    if (req.color_mode == ColorMode::Distance && req.use_distance) {
        RGB c{0, 0, 0};
        const double rr = p.dist * fexp_exp(5.0 * req.distance_param);
        if (rr > 0.0 && rr < 1.0) {
            const RGB rim{1.0 - rr, 1.0 - rr, 1.0 - rr};
            c = {std::min(1.0, c.r + rim.r), std::min(1.0, c.g + rim.g),
                 std::min(1.0, c.b + rim.b)};
        }
        if (req.invert) { c.r = 1.0 - c.r; c.g = 1.0 - c.g; c.b = 1.0 - c.b; }
        return c;
    }
    RGB c = pal.eval(t);
    if (req.invert) { c.r = 1.0 - c.r; c.g = 1.0 - c.g; c.b = 1.0 - c.b; }
    return c;
}

}  // namespace

bool render_image(const RenderRequest& req, Image& out, RenderStats& stats, std::string* error) {
    const auto t0 = std::chrono::steady_clock::now();
    stats = RenderStats();

    if (req.width < 1 || req.height < 1) {
        if (error) *error = "width and height must be positive";
        return false;
    }
    if (req.zoom_mantissa <= 0.0) {
        if (error) *error = "zoom must be positive";
        return false;
    }

    // Precision has to be raised *before* the centre is parsed: a 10^-74 frame
    // needs every leading digit of the coordinate, and the default 60-digit
    // parse silently collapses the frame to a point.
    const PrecisionPlan plan =
        plan_precision(req.zoom_mantissa, req.zoom_exp10, req.precision_digits,
                       req.max_precision_digits);
    stats.precision_digits = plan.digits;
    stats.precision_limbs = plan.limbs;
    stats.log10_zoom = std::log10(req.zoom_mantissa) + (double)req.zoom_exp10;
    BigFloat::precision_limbs = plan.limbs;

    BigFloat cr, ci;
    try {
        cr = BigFloat::from_string(req.center_re);
        ci = BigFloat::from_string(req.center_im);
    } catch (const std::exception& e) {
        if (error) *error = std::string("invalid centre coordinate: ") + e.what();
        return false;
    }
    BigFloat jr(0.0), ji(0.0);
    if (req.julia) {
        try {
            jr = BigFloat::from_string(req.julia_re);
            ji = BigFloat::from_string(req.julia_im);
        } catch (const std::exception& e) {
            if (error) *error = std::string("invalid Julia parameter: ") + e.what();
            return false;
        }
    }

    const Fexp zoom(req.zoom_mantissa, req.zoom_exp10);
    if (zoom.m <= 0.0) {
        if (error) *error = "zoom must be positive";
        return false;
    }
    const Fexp span = Fexp(req.span) / zoom;
    const Fexp scale = span / Fexp((double)req.width);
    stats.pixel_scale_log10 = scale.log10_abs();

    const int threads = req.threads > 0 ? std::min(req.threads, 64)
                                        : std::max(1, (int)std::thread::hardware_concurrency());

    // At shallow zoom the pixel offsets are large enough that iterating c
    // directly is both faster and more accurate than perturbation.
    const double lz = stats.log10_zoom;
    const bool direct = !req.exact && lz < 8.0;
    /* A four-channel field always wants the distance channels, because the
     * viewer's scheme may select one; a one-float coordinate never does. */
    const bool want_dist = req.use_distance || (req.field4 && req.field_distance);

    std::vector<PixelOut> px((size_t)req.width * req.height);

    if (!req.exact && !direct) {
        DeepParams dp;
        dp.cr = &cr;
        dp.ci = &ci;
        dp.scale = scale;
        dp.width = req.width;
        dp.height = req.height;
        dp.maxiter = req.maxiter;
        dp.digits = plan.digits;
        dp.sa_order = req.use_sa ? req.sa_order : 0;
        dp.threads = threads;
        dp.use_distance = want_dist;
        dp.julia = req.julia;
        dp.jr = &jr;
        dp.ji = &ji;
        dp.rot_cos = req.rot_cos;
        dp.rot_sin = req.rot_sin;
        dp.cancel = req.cancel;
        DeepStats ds;
        deep_render(dp, px, &ds);
        stats.reference_length = ds.reference_len;
        stats.glitches = ds.glitches;
        stats.tile_references = ds.references;
        stats.sa_skipped_iters = (long long)ds.sa_skip * (long long)req.width * req.height;
        stats.steps = ds.steps;
        stats.max_escape_iter = ds.esc_max;
        stats.min_escape_iter = ds.esc_min;
        stats.cancelled = ds.cancelled;
        if (ds.cancelled) {
            if (error) *error = "cancelled";
            stats.seconds =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            return false;
        }
    } else {
        BigFloat::precision_limbs = plan.limbs;
        const double crd = cr.to_double();
        const double cid = ci.to_double();
        const double jrd = jr.to_double();
        const double jid = ji.to_double();
        const double scaled = scale.to_double();
        const bool exact = req.exact;

        std::atomic<int> next_row{0};
        auto body = [&]() {
            BigFloat::precision_limbs = plan.limbs;
            for (;;) {
                const int y = next_row.fetch_add(1);
                if (y >= req.height) break;
                for (int x = 0; x < req.width; ++x) {
                    double dx, dy;
                    frame_offset(req, (double)x + 0.5, (double)y + 0.5, dx, dy);
                    PixelOut p;
                    if (exact) {
                        p = req.julia ? pixel_julia_exact(cr, ci, jr, ji, scale, dx, dy,
                                                          req.maxiter)
                                      : pixel_exact(cr, ci, scale, dx, dy, req.maxiter);
                    } else {
                        p = req.julia ? pixel_julia_double(crd, cid, jrd, jid, scaled, dx, dy,
                                                           req.maxiter, want_dist)
                                      : pixel_double(crd, cid, scaled, dx, dy, req.maxiter,
                                                     want_dist);
                    }
                    px[(size_t)y * req.width + x] = p;
                }
            }
        };
        std::vector<std::thread> pool;
        for (int i = 1; i < threads; ++i) pool.emplace_back(body);
        body();
        for (auto& t : pool) t.join();
        stats.reference_length = exact ? 1 : 0;
    }

    // ---- painting -----------------------------------------------------------
    const Palette pal = Palette::by_name(req.palette);
    const double ps = effective_palette_scale(req);
    out.resize(req.width, req.height);
    // ---- escape range (direct path; the deep path already knows it) ----------
    if (stats.max_escape_iter == 0) {
        int lo = std::numeric_limits<int>::max(), hi = 0;
        for (const PixelOut& q : px) {
            if (q.interior || q.iter < 0) continue;
            if (q.iter < lo) lo = q.iter;
            if (q.iter > hi) hi = q.iter;
        }
        if (hi > 0) { stats.min_escape_iter = lo; stats.max_escape_iter = hi; }
    }

    // ---- palette band width -------------------------------------------------
    // Ten bands across the frame's own escape span, which is the exposure the
    // reference engine uses (effective_palette_scale: 15/maxiter on a frame
    // whose span is ~1.5x that).  A fixed coordinate cannot work at both ends:
    // an overview spends its whole range in the first few escapes, while a 1e38
    // frame spans ~129 iterations out of a 3000 iteration budget -- a fixed
    // 0.005/iteration scale would paint four thousandths of a single ramp
    // across the entire picture, which is the "all one colour" frame.
    double band = req.band_iters;
    if (!(band > 0.0) && req.palette_scale > 0.0) band = 1.0 / req.palette_scale;
    if (!(band > 0.0)) {
        const int span = stats.max_escape_iter - stats.min_escape_iter;
        band = span > 0 ? std::max(0.75, (double)span / 10.0) : 1.0;
    }
    const int base_iter = stats.min_escape_iter;

    auto coord_of = [&](const PixelOut& p) {
        const double v = (req.color_mode == ColorMode::Iteration)
                             ? (double)p.iter
                             : std::max(0.0, p.smooth);
        return (v - (double)base_iter) / band;
    };

    std::atomic<int> next_row{0};
    std::atomic<int> bounded_count{0};
    auto paint_body = [&]() {
        for (;;) {
            const int y = next_row.fetch_add(1);
            if (y >= req.height) break;
            int inside = 0;
            for (int x = 0; x < req.width; ++x) {
                const PixelOut& p = px[(size_t)y * req.width + x];
                if (p.interior) ++inside;
                if (req.field4) {
                    /* The shell's four-channel contract.  Interior pixels carry
                     * a negative smooth value so a shader can tell a region
                     * from the sign alone; -0.0 would compare as NOT negative,
                     * so a pixel with no known period gets the smallest
                     * negative float instead. */
                    float* q = req.field4 + ((size_t)y * (size_t)req.width + (size_t)x) * 4;
                    if (p.interior) {
                        q[0] = -1e-30f;
                        q[1] = 0.0f;
                        q[2] = -1e-30f;
                        q[3] = 0.0f;
                    } else {
                        q[0] = (float)p.smooth;
                        q[1] = (float)p.dist;
                        q[2] = (float)p.iter;
                        /* The linear estimate is clamped by this bail-out, so
                         * it is 0 for every escaped sample -- the same value
                         * the old kernel reported, not a stand-in. */
                        q[3] = 0.0f;
                    }
                    continue;
                }
                if (req.field) {
                    /* Shading is the caller's: hand over the coordinate and
                     * skip the built-in palette entirely. */
                    req.field[(size_t)y * (size_t)req.width + (size_t)x] =
                        p.interior ? std::numeric_limits<float>::quiet_NaN()
                                   : (float)coord_of(p);
                    continue;
                }
                const RGB c = paint(req, pal, p, ps, coord_of(p));
                uint8_t* q = out.pixel(x, y);
                q[0] = (uint8_t)std::lround(std::clamp(c.r, 0.0, 1.0) * 255.0);
                q[1] = (uint8_t)std::lround(std::clamp(c.g, 0.0, 1.0) * 255.0);
                q[2] = (uint8_t)std::lround(std::clamp(c.b, 0.0, 1.0) * 255.0);
            }
            bounded_count.fetch_add(inside, std::memory_order_relaxed);
        }
    };
    std::vector<std::thread> paint_pool;
    for (int i = 1; i < threads; ++i) paint_pool.emplace_back(paint_body);
    paint_body();
    for (auto& t : paint_pool) t.join();

    // Progressive delivery, one band of rows at a time.  A field render has not
    // painted `out` at all, so there is nothing to hand over.
    if (req.on_tile && !req.field) {
        const int band_h = std::max(1, std::min(64, req.height));
        for (int y = 0; y < req.height; y += band_h) {
            req.on_tile(out, 0, y, req.width, std::min(band_h, req.height - y));
        }
    }

    stats.pixels = (long long)req.width * req.height;
    stats.bounded = bounded_count.load();
    stats.band_iters = band;
    stats.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    (void)lz;
    return true;
}
