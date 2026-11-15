// Viewport — the recovered _VIEWPORT model (getzoomdelta / recalc).
//
// The original binary keeps the absolute centre and zoom in a viewport
// object, and derives two scales from it:
//   * precision  = guard digits proportional to log10(zoom)
//   * delta      = HFLOAT radius covering the frame, clamped to +/-2^25
//                  decimal exponent (getzoomdelta)
//
// This header is the readable, editable equivalent.  It is deliberately a
// value type: copy it, mutate it, call recalc(), and render from it.

#pragma once

#include "bigfloat.hpp"
#include "floatexp.hpp"
#include "reference.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>

struct Viewport {
    BigFloat center_re = BigFloat(-0.6);
    BigFloat center_im = BigFloat(0.0);
    double zoom_mantissa = 1.0;
    int64_t zoom_exp10 = 0;
    double span = 3.0;              // complex width at zoom = 1
    int width = 800;
    int height = 600;
    int precision_digits = 0;       // 0 = automatic
    int max_precision_digits = 1200000;
    mutable PrecisionPlan plan;

    Fexp zoom() const { return Fexp(zoom_mantissa, zoom_exp10); }
    Fexp complex_span() const { return Fexp(span) / zoom(); }
    Fexp pixel_scale() const { return complex_span() / Fexp((double)width); }

    // Same role as getzoomdelta: a radius that covers the frame diagonal,
    // clamped so a corrupt zoom cannot create a nonsensical HFLOAT.
    Fexp zoom_delta() const {
        Fexp diag(std::sqrt((double)width * width + (double)height * height) * 0.5 + 1.0);
        Fexp d = pixel_scale() * diag;
        constexpr int64_t kLimit = 0x2000000;  // 33,554,432 decimal decades
        if (d.e > kLimit) d = Fexp(d.m, kLimit);
        if (d.e < -kLimit) d = Fexp(d.m, -kLimit);
        return d;
    }

    void recalc() const {
        plan = plan_precision(zoom_mantissa, zoom_exp10, precision_digits,
                              max_precision_digits);
        BigFloat::precision_limbs = plan.limbs;
    }

    // Complex coordinate of pixel (x,y).  The pixel centre is used, matching
    // rendercanvas_hfloat.
    std::pair<BigFloat, BigFloat> point_at(int x, int y) const {
        recalc();
        double dx = ((double)x + 0.5) - (double)width * 0.5;
        double dy = (double)height * 0.5 - ((double)y + 0.5);
        Fexp offx = pixel_scale() * Fexp(dx);
        Fexp offy = pixel_scale() * Fexp(dy);
        BigFloat re = center_re + BigFloat::from_floatexp(offx.m, offx.e);
        BigFloat im = center_im + BigFloat::from_floatexp(offy.m, offy.e);
        return {re, im};
    }

    // Mouse-drag pan: move the centre by (dx,dy) screen pixels.
    void pan_pixels(double dx, double dy) {
        recalc();
        Fexp offx = pixel_scale() * Fexp(dx);
        Fexp offy = pixel_scale() * Fexp(-dy);
        center_re = center_re + BigFloat::from_floatexp(offx.m, offx.e);
        center_im = center_im + BigFloat::from_floatexp(offy.m, offy.e);
    }

    // Multiplicative zoom about the current centre.
    void zoom_by(double factor) {
        if (!(factor > 0.0)) return;
        zoom_mantissa *= factor;
        while (zoom_mantissa >= 10.0) { zoom_mantissa /= 10.0; ++zoom_exp10; }
        while (zoom_mantissa < 1.0) { zoom_mantissa *= 10.0; --zoom_exp10; }
        recalc();
    }

    double log10_zoom() const {
        return std::log10(zoom_mantissa) + (double)zoom_exp10;
    }
};
