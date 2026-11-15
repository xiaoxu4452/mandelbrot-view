// Exact per-pixel iteration in BigFloat at the planned precision.
//
// This is the oracle: whatever the perturbation engine claims, these numbers
// are what the pixel actually does.  It is far too slow to render with (a
// BigFloat square per iteration, per pixel), so it lives behind --exact and
// behind the B2 acceptance tests.
#pragma once

#include "bigfloat.hpp"
#include "floatexp.hpp"
#include "render.hpp"

#include <algorithm>
#include <cmath>

inline PixelOut pixel_exact(const BigFloat& cr, const BigFloat& ci, const Fexp& scale,
                            double dx, double dy, int maxiter) {
    PixelOut po;
    const Fexp ox = scale * Fexp(dx);
    const Fexp oy = scale * Fexp(dy);
    BigFloat cre = cr + BigFloat::from_floatexp(ox.m, ox.e);
    BigFloat cim = ci + BigFloat::from_floatexp(oy.m, oy.e);
    BigFloat zr(0.0), zi(0.0);
    for (int n = 0; n < maxiter; ++n) {
        const double zrd = zr.to_double();
        const double zid = zi.to_double();
        const double z2 = zrd * zrd + zid * zid;
        if (z2 > 4.0) {
            po.iter = n;
            const double logz = 0.5 * std::log(std::max(z2, 1e-300));
            double ratio = logz / std::log(2.0);
            if (ratio < 1e-15) ratio = 1e-15;
            po.smooth = (double)n + 1.0 - std::log2(ratio);
            if (po.smooth < 0.0) po.smooth = 0.0;
            return po;
        }
        const BigFloat sum = zr + zi;
        const BigFloat dif = zr - zi;
        const BigFloat re2 = sum * dif;
        const BigFloat im2 = (zr * zi).mul_ui(2);
        zr = re2 + cre;
        zi = im2 + cim;
    }
    po.interior = true;
    po.iter = -1;
    po.smooth = -1.0;
    return po;
}

inline PixelOut pixel_julia_exact(const BigFloat& zr0, const BigFloat& zi0, const BigFloat& cr,
                                  const BigFloat& ci, const Fexp& scale, double dx, double dy,
                                  int maxiter) {
    PixelOut po;
    const Fexp ox = scale * Fexp(dx);
    const Fexp oy = scale * Fexp(dy);
    BigFloat zr = zr0 + BigFloat::from_floatexp(ox.m, ox.e);
    BigFloat zi = zi0 + BigFloat::from_floatexp(oy.m, oy.e);
    for (int n = 0; n < maxiter; ++n) {
        const double zrd = zr.to_double();
        const double zid = zi.to_double();
        const double z2 = zrd * zrd + zid * zid;
        if (z2 > 4.0) {
            po.iter = n;
            const double logz = 0.5 * std::log(std::max(z2, 1e-300));
            double ratio = logz / std::log(2.0);
            if (ratio < 1e-15) ratio = 1e-15;
            po.smooth = (double)n + 1.0 - std::log2(ratio);
            if (po.smooth < 0.0) po.smooth = 0.0;
            return po;
        }
        const BigFloat sum = zr + zi;
        const BigFloat dif = zr - zi;
        const BigFloat re2 = sum * dif;
        const BigFloat im2 = (zr * zi).mul_ui(2);
        zr = re2 + cr;
        zi = im2 + ci;
    }
    po.interior = true;
    po.iter = -1;
    po.smooth = -1.0;
    return po;
}
