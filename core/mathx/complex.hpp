// ---------------------------------------------------------------------------
// complex.hpp — arbitrary-precision complex numbers over BigFloat.
//
// This is the numeric type the expression evaluator runs on.  Every function
// is defined everywhere (division by zero is zero, log(0) is zero), because a
// fractal iteration cannot abort on one bad pixel: the escape test classifies
// the value afterwards.
// ---------------------------------------------------------------------------
#pragma once

#include "bigmath.hpp"

namespace mx {

struct BC {
    BigFloat re;
    BigFloat im;
};

inline BC bc_zero() { return BC{}; }
inline BC bc_from(double re, double im = 0.0) {
    return BC{BigFloat::from_double(re), BigFloat::from_double(im)};
}
inline BC bc_int(int64_t re, int64_t im = 0) { return BC{BigFloat(re), BigFloat(im)}; }

inline BC bc_add(const BC& a, const BC& b) { return BC{a.re.add(b.re), a.im.add(b.im)}; }
inline BC bc_sub(const BC& a, const BC& b) { return BC{a.re.sub(b.re), a.im.sub(b.im)}; }
inline BC bc_neg(const BC& a) { return BC{-a.re, -a.im}; }
inline BC bc_mul(const BC& a, const BC& b) {
    return BC{a.re.mul(b.re).sub(a.im.mul(b.im)),
              a.re.mul(b.im).add(a.im.mul(b.re))};
}
inline BC bc_conj(const BC& a) { return BC{a.re, -a.im}; }
inline BigFloat bc_abs2(const BC& a) { return a.re.mul(a.re).add(a.im.mul(a.im)); }
inline BigFloat bc_abs(const BC& a) { return bm::sqrt(bc_abs2(a)); }
inline BigFloat bc_arg(const BC& a) { return bm::atan2(a.im, a.re); }

inline BC bc_div(const BC& a, const BC& b) {
    const BigFloat d = bc_abs2(b);
    if (d.is_zero()) return BC{};
    const BigFloat nr = a.re.mul(b.re).add(a.im.mul(b.im));
    const BigFloat ni = a.im.mul(b.re).sub(a.re.mul(b.im));
    return BC{bm::div(nr, d), bm::div(ni, d)};
}

inline BC bc_exp(const BC& a) {
    const BigFloat e = bm::exp(a.re);
    return BC{e.mul(bm::cos(a.im)), e.mul(bm::sin(a.im))};
}

inline BC bc_log(const BC& a) {
    return BC{bm::log(bc_abs(a)), bc_arg(a)};
}

inline BC bc_sqrt(const BC& a) {
    /* Principal branch, written so the negative real axis is handled: the
     * earlier version took sqrt((r-|x|)/2) for the imaginary part, which is
     * zero exactly where the answer is purely imaginary -- sqrt(-1) came back
     * as 0 and every formula using it silently lost the term. */
    const BigFloat r = bc_abs(a);
    if (r.is_zero()) return BC{};
    if (a.re.sign >= 0) {
        const BigFloat re = bm::sqrt(bm::div_ui(a.re.add(r), 2));
        const BigFloat im = re.is_zero() ? BigFloat()
                                        : bm::div(bm::div_ui(a.im, 2), re);
        return BC{re, im};
    }
    const BigFloat mag = bm::sqrt(bm::div_ui(r.sub(a.re), 2));
    const BigFloat im = a.im.sign < 0 ? -mag : mag;
    const BigFloat re = bm::div(bm::div_ui(a.im, 2), im);
    return BC{re, im};
}

inline BC bc_sinh(const BC& a) {
    const BC e = bc_exp(a);
    const BC m = bc_exp(bc_neg(a));
    return BC{bm::div_ui(e.re.sub(m.re), 2), bm::div_ui(e.im.sub(m.im), 2)};
}
inline BC bc_cosh(const BC& a) {
    const BC e = bc_exp(a);
    const BC m = bc_exp(bc_neg(a));
    return BC{bm::div_ui(e.re.add(m.re), 2), bm::div_ui(e.im.add(m.im), 2)};
}
inline BC bc_sin(const BC& a) {
    const BigFloat sr = bm::sin(a.re), cr = bm::cos(a.re);
    const BigFloat sh = bm::exp(a.im), em = bm::exp(-a.im);
    const BigFloat ch = bm::div_ui(sh.add(em), 2);
    const BigFloat shh = bm::div_ui(sh.sub(em), 2);
    return BC{sr.mul(ch), cr.mul(shh)};
}
inline BC bc_cos(const BC& a) {
    const BigFloat sr = bm::sin(a.re), cr = bm::cos(a.re);
    const BigFloat sh = bm::exp(a.im), em = bm::exp(-a.im);
    const BigFloat ch = bm::div_ui(sh.add(em), 2);
    const BigFloat shh = bm::div_ui(sh.sub(em), 2);
    return BC{cr.mul(ch), -sr.mul(shh)};
}
inline BC bc_tan(const BC& a) { return bc_div(bc_sin(a), bc_cos(a)); }
inline BC bc_tanh(const BC& a) { return bc_div(bc_sinh(a), bc_cosh(a)); }
inline BC bc_asin(const BC& a) {
    /* -i log(i z + sqrt(1 - z^2)) */
    const BC iz = BC{-a.im, a.re};
    const BC one = bc_int(1);
    const BC s = bc_sqrt(bc_sub(one, bc_mul(a, a)));
    const BC l = bc_log(bc_add(iz, s));
    return BC{l.im, -l.re};
}
inline BC bc_acos(const BC& a) {
    const BC half_pi{bm::div_ui(bm::pi(), 2), BigFloat()};
    return bc_sub(half_pi, bc_asin(a));
}
inline BC bc_atan(const BC& a) {
    /* (i/2) log((i+z)/(i-z)) */
    const BC i = bc_int(0, 1);
    const BC l = bc_log(bc_div(bc_add(i, a), bc_sub(i, a)));
    /* (i/2)(x+iy) = (-y/2, x/2) */
    return BC{bm::div_ui(-l.im, 2), bm::div_ui(l.re, 2)};
}

inline BC bc_powi(const BC& a, int64_t n) {
    if (n == 0) return bc_int(1);
    const uint64_t e = (uint64_t)(n < 0 ? -n : n);
    BC base = a, r = bc_int(1);
    uint64_t k = e;
    while (k) {
        if (k & 1) r = bc_mul(r, base);
        k >>= 1;
        if (k) base = bc_mul(base, base);
    }
    if (n < 0) return bc_div(bc_int(1), r);
    return r;
}

inline BC bc_pow(const BC& a, const BC& b) {
    if (b.im.is_zero() && b.re.is_zero()) return bc_int(1);
    if (b.im.is_zero()) {
        const BigFloat t = bm::trunc(b.re);
        if (t.compare(b.re) == 0) {
            const int64_t n = bm::to_int64(b.re);
            if (n > -1000000 && n < 1000000) return bc_powi(a, n);
        }
    }
    if (a.re.is_zero() && a.im.is_zero()) return BC{};
    return bc_exp(bc_mul(b, bc_log(a)));
}

inline BC bc_scale(const BC& a, const BigFloat& s) {
    return BC{a.re.mul(s), a.im.mul(s)};
}

}  // namespace mx
