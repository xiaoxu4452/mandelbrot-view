#include "dive.hpp"

#include "gmp_bridge.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

namespace {

struct Var {
    gmpb::Mpf v;
    explicit Var(int bits) { gmpb::init(v, bits); }
    ~Var() { gmpb::clear(v); }
    Var(const Var&) = delete;
    Var& operator=(const Var&) = delete;
};

struct Cx {
    Var re, im;
    explicit Cx(int bits) : re(bits), im(bits) {}
};

/* log10 |v| for an mpf, from the top limb only.  Used for comparisons, not for
 * the arithmetic, so a few units in the last place of the exponent are fine. */
double log10_abs(const gmpb::Mpf& v) {
    int32_t e2 = 0;
    const double m = gmpb::get_d_2exp(&e2, v);
    if (m == 0.0) return -std::numeric_limits<double>::infinity();
    return std::log10(std::fabs(m)) + (double)e2 * 0.30102999566398119521;
}

/* (ar+i ai)*(br+i bi) -> (rr,ri).  t0..t3 are scratch; writing the result last
 * makes this safe even when the result aliases an input. */
void cmul(Var& rr, Var& ri, const Var& ar, const Var& ai, const Var& br, const Var& bi,
          Var& t0, Var& t1, Var& t2, Var& t3) {
    gmpb::mul(t0.v, ar.v, br.v);
    gmpb::mul(t1.v, ai.v, bi.v);
    gmpb::sub(rr.v, t0.v, t1.v);
    gmpb::mul(t2.v, ar.v, bi.v);
    gmpb::mul(t3.v, ai.v, br.v);
    gmpb::add(ri.v, t2.v, t3.v);
}

int bits_for(int digits) {
    return (int)((double)std::max(digits, 72) * 3.321928094887362) + 64;
}

}  // namespace

int atom_domain_period(const std::string& cre, const std::string& cim, int digits,
                       int maxiter, std::string* error) {
    if (!gmpb::available()) {
        if (error) *error = "libgmp-10.dll not available";
        return 0;
    }
    const int bits = bits_for(digits);
    Cx c(bits), z(bits);
    Var t0(bits), t1(bits), t2(bits), t3(bits), one(bits), two(bits), mag(bits);
    gmpb::set_str(c.re.v, cre);
    gmpb::set_str(c.im.v, cim);
    gmpb::set_d(one.v, 1.0);
    gmpb::set_d(two.v, 2.0);
    gmpb::set_d(z.re.v, 0.0);
    gmpb::set_d(z.im.v, 0.0);

    int best_n = 0;
    double best = std::numeric_limits<double>::infinity();
    for (int n = 1; n <= maxiter; ++n) {
        /* z <- z^2 + c, Re=(x+y)(x-y), Im=2xy */
        gmpb::add(t2.v, z.re.v, z.im.v);
        gmpb::sub(t3.v, z.re.v, z.im.v);
        gmpb::mul(t0.v, t2.v, t3.v);
        gmpb::mul(t1.v, z.re.v, z.im.v);
        gmpb::mul(t1.v, t1.v, two.v);
        gmpb::add(z.re.v, t0.v, c.re.v);
        gmpb::add(z.im.v, t1.v, c.im.v);

        gmpb::mul(t0.v, z.re.v, z.re.v);
        gmpb::mul(t1.v, z.im.v, z.im.v);
        gmpb::add(mag.v, t0.v, t1.v);
        const double l = log10_abs(mag.v);
        if (l < best) { best = l; best_n = n; }
        if (l > 4.0) break;  // well past the escape radius
    }
    return best_n;
}

NucleusResult find_nucleus(const std::string& cre, const std::string& cim, int period,
                           int digits, int max_newton, int maxiter) {
    NucleusResult r;
    if (!gmpb::available()) { r.error = "libgmp-10.dll not available"; return r; }
    if (period <= 0) {
        period = atom_domain_period(cre, cim, digits, maxiter, &r.error);
        if (period <= 0) { r.error = "could not find an atom-domain period"; return r; }
    }
    r.period = period;

    const int bits = bits_for(digits);
    Cx c(bits), z(bits), dz(bits), delta(bits);
    Var t0(bits), t1(bits), t2(bits), t3(bits);
    Var u0(bits), u1(bits), u2(bits), u3(bits);
    Var one(bits), two(bits), den(bits), tmp(bits);

    gmpb::set_str(c.re.v, cre);
    gmpb::set_str(c.im.v, cim);
    gmpb::set_d(one.v, 1.0);
    gmpb::set_d(two.v, 2.0);

    const double target = -(double)(digits - 6);
    for (int k = 0; k < std::max(1, max_newton); ++k) {
        gmpb::set_d(z.re.v, 0.0);
        gmpb::set_d(z.im.v, 0.0);
        gmpb::set_d(dz.re.v, 0.0);
        gmpb::set_d(dz.im.v, 0.0);

        for (int n = 1; n <= period; ++n) {
            /* dz <- 2*z*dz + 1, using the *old* z */
            cmul(u0, u1, z.re, z.im, dz.re, dz.im, t0, t1, t2, t3);
            gmpb::mul(dz.re.v, u0.v, two.v);
            gmpb::add(dz.re.v, dz.re.v, one.v);
            gmpb::mul(dz.im.v, u1.v, two.v);

            /* z <- z^2 + c, Re = (x+y)(x-y), Im = 2xy */
            gmpb::add(t0.v, z.re.v, z.im.v);
            gmpb::sub(t1.v, z.re.v, z.im.v);
            gmpb::mul(t2.v, t0.v, t1.v);
            gmpb::mul(t3.v, z.re.v, z.im.v);
            gmpb::mul(t3.v, t3.v, two.v);
            gmpb::add(z.re.v, t2.v, c.re.v);
            gmpb::add(z.im.v, t3.v, c.im.v);
        }

        /* delta = z / dz = z * conj(dz) / |dz|^2 */
        gmpb::mul(t0.v, dz.re.v, dz.re.v);
        gmpb::mul(t1.v, dz.im.v, dz.im.v);
        gmpb::add(den.v, t0.v, t1.v);
        /* z * conj(dz) = (zr*dzr + zi*dzi) + i(zi*dzr - zr*dzi) */
        gmpb::mul(t2.v, z.re.v, dz.re.v);
        gmpb::mul(t3.v, z.im.v, dz.im.v);
        gmpb::add(u0.v, t2.v, t3.v);
        gmpb::mul(t2.v, z.im.v, dz.re.v);
        gmpb::mul(t3.v, z.re.v, dz.im.v);
        gmpb::sub(u1.v, t2.v, t3.v);
        gmpb::div(delta.re.v, u0.v, den.v);
        gmpb::div(delta.im.v, u1.v, den.v);

        gmpb::sub(c.re.v, c.re.v, delta.re.v);
        gmpb::sub(c.im.v, c.im.v, delta.im.v);
        ++r.newton_steps;

        const double lre = log10_abs(delta.re.v), lim = log10_abs(delta.im.v);
        r.last_step_log10 = std::max(lre, lim);
        /* |dz_p/dc| sets the scale of the minibrot: c* + O(1/dz) is where the
         * copy of the set sits.  Report it so a caller can pick a span. */
        r.log10_size = -0.5 * log10_abs(den.v);
        if (r.last_step_log10 < target) break;
    }

    r.re = gmpb::to_decimal(c.re.v, digits);
    r.im = gmpb::to_decimal(c.im.v, digits);
    r.ok = !r.re.empty() && !r.im.empty();
    return r;
}

MisiurewiczResult find_misiurewicz(int m, int p, const std::string& cre,
                                   const std::string& cim, int digits, int max_newton) {
    MisiurewiczResult r;
    r.m = m;
    r.p = p;
    if (!gmpb::available()) { r.error = "libgmp-10.dll not available"; return r; }
    if (m < 0 || p <= 0 || m + p > 1000000) {
        r.error = "bad (m,p)"; return r;
    }

    const int bits = bits_for(digits);
    Cx c(bits), z(bits), dz(bits), zm(bits), dzm(bits), g(bits), dg(bits), delta(bits);
    Var t0(bits), t1(bits), t2(bits), t3(bits);
    Var u0(bits), u1(bits), one(bits), two(bits), den(bits);
    gmpb::set_str(c.re.v, cre);
    gmpb::set_str(c.im.v, cim);
    gmpb::set_d(one.v, 1.0);
    gmpb::set_d(two.v, 2.0);

    const int N = m + p;
    const double target = -(double)(digits - 6);
    for (int k = 0; k < std::max(1, max_newton); ++k) {
        gmpb::set_d(z.re.v, 0.0);
        gmpb::set_d(z.im.v, 0.0);
        gmpb::set_d(dz.re.v, 0.0);
        gmpb::set_d(dz.im.v, 0.0);
        gmpb::set_d(zm.re.v, 0.0);
        gmpb::set_d(zm.im.v, 0.0);
        gmpb::set_d(dzm.re.v, 0.0);
        gmpb::set_d(dzm.im.v, 0.0);

        for (int n = 1; n <= N; ++n) {
            /* dz <- 2*z*dz + 1 using the OLD z. */
            cmul(u0, u1, z.re, z.im, dz.re, dz.im, t0, t1, t2, t3);
            gmpb::mul(dz.re.v, u0.v, two.v);
            gmpb::add(dz.re.v, dz.re.v, one.v);
            gmpb::mul(dz.im.v, u1.v, two.v);

            /* z <- z^2 + c, Re=(x+y)(x-y), Im=2xy. */
            gmpb::add(t0.v, z.re.v, z.im.v);
            gmpb::sub(t1.v, z.re.v, z.im.v);
            gmpb::mul(t2.v, t0.v, t1.v);
            gmpb::mul(t3.v, z.re.v, z.im.v);
            gmpb::mul(t3.v, t3.v, two.v);
            gmpb::add(z.re.v, t2.v, c.re.v);
            gmpb::add(z.im.v, t3.v, c.im.v);

            if (n == m) {
                gmpb::set(zm.re.v, z.re.v);
                gmpb::set(zm.im.v, z.im.v);
                gmpb::set(dzm.re.v, dz.re.v);
                gmpb::set(dzm.im.v, dz.im.v);
            }
        }

        /* g = z_N - z_m, dg = dz_N - dz_m. */
        gmpb::sub(g.re.v, z.re.v, zm.re.v);
        gmpb::sub(g.im.v, z.im.v, zm.im.v);
        gmpb::sub(dg.re.v, dz.re.v, dzm.re.v);
        gmpb::sub(dg.im.v, dz.im.v, dzm.im.v);

        /* delta = g / dg = g * conj(dg) / |dg|^2. */
        gmpb::mul(t0.v, dg.re.v, dg.re.v);
        gmpb::mul(t1.v, dg.im.v, dg.im.v);
        gmpb::add(den.v, t0.v, t1.v);
        gmpb::mul(t2.v, g.re.v, dg.re.v);
        gmpb::mul(t3.v, g.im.v, dg.im.v);
        gmpb::add(u0.v, t2.v, t3.v);
        gmpb::mul(t2.v, g.im.v, dg.re.v);
        gmpb::mul(t3.v, g.re.v, dg.im.v);
        gmpb::sub(u1.v, t2.v, t3.v);
        gmpb::div(delta.re.v, u0.v, den.v);
        gmpb::div(delta.im.v, u1.v, den.v);

        gmpb::sub(c.re.v, c.re.v, delta.re.v);
        gmpb::sub(c.im.v, c.im.v, delta.im.v);
        ++r.newton_steps;

        r.last_step_log10 = std::max(log10_abs(delta.re.v), log10_abs(delta.im.v));
        r.log10_residual = std::max(log10_abs(g.re.v), log10_abs(g.im.v));
        if (r.last_step_log10 < target) break;
    }

    /* Below the requested precision a component is numerical noise, not a
     * coordinate: emitting it would turn c=i into "0.000...000263..." and
     * force a 92-digit string on a value that is analytically zero. */
    const double noise = -(double)(digits - 6);
    if (log10_abs(c.re.v) < noise) gmpb::set_d(c.re.v, 0.0);
    if (log10_abs(c.im.v) < noise) gmpb::set_d(c.im.v, 0.0);
    r.re = gmpb::to_decimal(c.re.v, digits);
    r.im = gmpb::to_decimal(c.im.v, digits);
    r.ok = !r.re.empty() && !r.im.empty();
    return r;
}
