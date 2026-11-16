#include "reference.hpp"

#include "gmp_bridge.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <memory>
#include <vector>

namespace {

// log10 of the relative truncation error that still permits a skip.  1e-12 is
// two orders below the double mantissa of the per-pixel perturbation, so the
// skipped iterations are as accurate as the ones they replace.
double kSaEpsLog10 = -12.0;

double cfexp_log10_abs(const CFexp& a) {
    Fexp n = cfexp_abs2(a);
    if (n.m == 0.0) return -std::numeric_limits<double>::infinity();
    return 0.5 * n.log10_abs();
}

// ---------------------------------------------------------------------------
// Series approximation
//
// An Euler-series accumulator that is independent of the arithmetic used for
// the reference orbit itself: the coefficients A_k live in CFexp (double
// mantissa, decimal exponent) and are only ever combined with each other, so
// both the BigFloat and the GMP orbit loops drive exactly the same state
// machine.  Keeping it in one place is what makes the two paths comparable --
// earlier the same test was duplicated and the two copies drifted apart.
// ---------------------------------------------------------------------------
struct SaTracker {
    int order = 0;
    bool julia = false;
    std::vector<CFexp> A;
    std::vector<CFexp> best;
    int skip = 0;
    bool usable = false;
    bool closed = false;
    double logd = 0.0;

    void begin(int o, bool jl, const Fexp& delta_max) {
        order = o;
        julia = jl;
        logd = delta_max.log10_abs();
        if (order > 0) {
            A.assign((size_t)order + 1, CFexp(0.0, 0.0));
            A[1] = CFexp(1.0, 0.0);
            best = A;
        }
    }

    /** Called right after z_n was appended; `Z` is that z_n. */
    void step(const CFexp& Z, int n, int maxiter) {
        if (order <= 0 || closed || n + 1 >= maxiter) return;
        /* Once the reference itself has left the bailout disc, no pixel can
         * still be iterating.  The orbit loop keeps squaring until 1e40 so it
         * can serve the smooth-colouring tail, but extending the series over
         * those Z_n is meaningless: a Mandelbrot A_1 blows up and the error
         * test closes it, while a Julia A_1 can keep decaying so the test
         * stays "good" all the way to the cut -- skip then lands on the last
         * stored point and every pixel reports that iteration instead of its
         * real escape count (measured: esc 28..28 against an exact 21..21).
         * log10(2) = 0.30103; use a hair over it. */
        if (cfexp_log10_abs(Z) > 0.302) { closed = true; return; }
        std::vector<CFexp> next((size_t)order + 1, CFexp(0.0, 0.0));
        for (int k = 1; k <= order; ++k) {
            CFexp v = Z * A[(size_t)k] * Fexp(2.0);
            if (k == 1 && !julia) v = v + CFexp(1.0, 0.0);
            for (int i = 1; i < k; ++i) v = v + A[(size_t)i] * A[(size_t)(k - i)];
            next[(size_t)k] = v;
        }
        A.swap(next);

        /* Truncation-error test.  The series is
         *   d_n = sum_{k>=1} A_k d_0^{k-1},
         * so what decides whether it may be used to skip to n is the size of
         * the first neglected term *relative to the leading one*, at the
         * largest offset in the frame:  |A_k d^(k-1)| / |A_1| < eps.
         * Requiring every term to be below 1e-5 in absolute terms — which is
         * what this used to do — stops the skip at |A_2 d| ~ 1e-5, i.e. long
         * before the series has lost any accuracy, and makes the skip length
         * independent of the order.  The coefficient that matters is the
         * highest one computed, not the second one: taking the maximum over
         * all k charges the skip for the size of the quadratic term, which is
         * irrelevant to the accuracy of the truncated sum, and cuts the skip
         * by a factor of |A_1 d|^(order-2). */
        double err = -std::numeric_limits<double>::infinity();
        const double l1 = cfexp_log10_abs(A[1]);
        const double ltop = cfexp_log10_abs(A[(size_t)order]);
        if (ltop != -std::numeric_limits<double>::infinity()) {
            err = ltop - l1 + (double)(order - 1) * logd;
        }
        if (err < kSaEpsLog10) {
            skip = n + 1;
            best = A;
            usable = true;
        } else if (usable) {
            /* The series has left its radius of validity.  Stop evaluating it,
             * but keep integrating the reference orbit to maxiter. */
            closed = true;
        }
    }

    void finish(Orbit& orbit) const {
        orbit.sa.order = order;
        orbit.sa.skip = (usable && order > 0) ? skip : 0;
        orbit.sa.coef = best;
        orbit.sa.usable = usable && skip > 0;
        orbit.sa.delta_log10 = logd;
    }
};

// ---------------------------------------------------------------------------
// GMP path
// ---------------------------------------------------------------------------

/* MB_GMP=0 disables it, MB_GMP_MIN=<digits> sets the threshold.  A caller (and
 * the orbit-comparison test) can also pin the backend explicitly. */
int g_backend = -1;  // -1 auto, 0 BigFloat, 1 GMP

bool gmp_disabled() {
    if (g_backend >= 0) return g_backend == 0;
    static const bool v = [] {
        const char* e = std::getenv("MB_GMP");
        return e && std::atoi(e) == 0;
    }();
    return v;
}

int gmp_min_digits() {
    static const int v = [] {
        const char* e = std::getenv("MB_GMP_MIN");
        return e ? std::atoi(e) : 80;
    }();
    return v;
}

/* value (an mpf) -> CFexp.
 *
 * Only ~53 bits of mantissa survive into the reference, and that is all the
 * per-pixel kernel can use anyway; what matters is the *decimal exponent*,
 * which reaches -60000 long before the mantissa does.  `get_d_2exp` is O(1)
 * (it reads the top limbs), then the two exponents are applied in matched
 * chunks so nothing overflows: 2^996 ~ 10^300, and the value is pulled towards
 * 1 as it goes, so a 10^-6000 orbit value never has to be materialised. */
Fexp fexp_from_mpf(const gmpb::Mpf& v) {
    int32_t e2 = 0;
    const double m = gmpb::get_d_2exp(&e2, v);
    if (m == 0.0) return Fexp();

    double r = std::fabs(m);                       // [0.5, 1)
    int64_t E = (int64_t)std::floor(std::log10(r) + (double)e2 * 0.30102999566398119521);
    int64_t k = e2, ed = 0;                        // value = r * 2^k * 10^ed
    while (k > 996) {
        r = std::ldexp(r, 996) / 1e300;
        k -= 996;
        ed += 300;
    }
    while (k < -996) {
        r = std::ldexp(r, -996) * 1e300;
        k += 996;
        ed -= 300;
    }
    r = std::ldexp(r, (int)k) * Fexp::pow10i((int)(ed - E));
    while (r >= 10.0) { r /= 10.0; ++E; }
    while (r < 1.0) { r *= 10.0; --E; }
    return Fexp(m < 0.0 ? -r : r, E);
}

CFexp cfexp_from_mpf(const gmpb::Mpf& re, const gmpb::Mpf& im) {
    return CFexp(fexp_from_mpf(re), fexp_from_mpf(im));
}

bool orbit_gmp(Orbit& orbit, const BigFloat& z0r, const BigFloat& z0i,
               const BigFloat& cr, const BigFloat& ci, int maxiter,
               bool need_derivative, int sa_order, const Fexp& delta_max,
               std::string* error, bool julia) {
    orbit.cr = cr;
    orbit.ci = ci;
    orbit.maxiter = maxiter;
    orbit.escaped = false;
    orbit.julia = julia;
    orbit.periodic = false;
    orbit.escape_iter = -1;
    orbit.z.clear();
    orbit.dz.clear();
    orbit.z.reserve((size_t)maxiter + 1);
    if (need_derivative) orbit.dz.reserve((size_t)maxiter + 1);

    /* Same floor as the BigFloat path (8 limbs = 72 digits). */
    const int digits = std::max(orbit.digits, 72);
    const std::string sre = cr.to_fixed(digits + 6);
    const std::string sim = ci.to_fixed(digits + 6);
    const int bits = (int)((double)digits * 3.321928094887362) + 32;

    gmpb::Num zr(bits), zi(bits);
    gmpb::Num ar(bits), ai(bits);
    gmpb::Num sum(bits), dif(bits), pr(bits), pi(bits);

    gmpb::set_str(ar.v, sre);
    gmpb::set_str(ai.v, sim);
    if (julia) {
        gmpb::set_str(zr.v, z0r.to_fixed(digits + 6));
        gmpb::set_str(zi.v, z0i.to_fixed(digits + 6));
    }

    orbit.c = cfexp_from_bigfloat(cr, ci);

    SaTracker sa;
    sa.begin(sa_order, julia, delta_max);

    /* Eventually-periodic reference orbits -- the "FFT wall" workaround.
     *
     * At a Misiurewicz point the critical orbit repeats EXACTLY: c=i gives
     * z_2=-1+i, z_3=-i and z_4=z_2 forever.  Squaring that orbit 160000 times
     * in 60000-digit arithmetic (1.5 ms/step) is minutes of pure waste, and it
     * is the only reason 10^60000 did not finish.  Detect an exact repetition
     * inside the first kProbe steps with mpf_cmp (a double comparison would be
     * a guess), then tile the already-stored CFexp values.  The pixels still
     * iterate every step -- their d_n is not periodic -- but Z_n is now known
     * analytically, so no high-precision multiply is needed.
     *
     * MB_PERIOD=0 keeps the old behaviour for A/B runs. */
    const bool probe_period = !need_derivative && !julia &&
                              !(std::getenv("MB_PERIOD") &&
                                std::atoi(std::getenv("MB_PERIOD")) == 0);
    constexpr int kProbe = 64;
    std::vector<std::unique_ptr<gmpb::Num>> snap_r, snap_i;
    if (probe_period) {
        snap_r.reserve(kProbe);
        snap_i.reserve(kProbe);
    }
    int per_start = -1, per_len = 0;

    for (int n = 0;; ++n) {
        orbit.z.push_back(cfexp_from_mpf(zr.v, zi.v));

        if (probe_period && per_start < 0 && n <= kProbe) {
            /* A Newton-refined Misiurewicz point is only known to `digits`
             * places, so its orbit repeats to the 53-bit mantissa CFexp stores
             * but NOT bit-for-bit in mpf.  That low-digit difference is
             * numerical noise in c; the analytic orbit IS periodic, so tiling
             * the CFexp values is more accurate than integrating the noise
             * forward for 160000 steps.  Only allow the relaxed test on deep
             * frames, where the mpf orbit is actually the bottleneck, and
             * compare at exactly the precision the pixels consume.
             * OFF BY DEFAULT: a coordinate that merely LOOKS periodic
             * (c = i + 1e-6050) has a genuinely divergent orbit, and freezing
             * Z_n would be wrong.  MB_QUASI=1 is for centres produced by
             * `mset misiurewicz`, whose residual is noise in c rather than an
             * intentional offset.  Exact mpf repetition is always safe. */
            const bool quasi = digits >= 1000 && std::getenv("MB_QUASI") &&
                               std::atoi(std::getenv("MB_QUASI")) == 1;
            for (int j = 0; j < (int)snap_r.size(); ++j) {
                bool same = gmpb::cmp(zr.v, snap_r[(size_t)j]->v) == 0 &&
                            gmpb::cmp(zi.v, snap_i[(size_t)j]->v) == 0;
                if (!same && quasi) {
                    const CFexp& A = orbit.z[(size_t)n];
                    const CFexp& B = orbit.z[(size_t)j];
                    auto eq = [](const Fexp& x, const Fexp& y) {
                        if (x.e != y.e) return false;
                        if (x.m == y.m) return true;
                        return std::fabs(x.m - y.m) <= 1e-14 * std::fabs(x.m);
                    };
                    same = eq(A.re, B.re) && eq(A.im, B.im);
                }
                if (same) {
                    per_start = j;
                    per_len = n - j;
                    break;
                }
            }
            if (per_start < 0 && n < kProbe) {
                snap_r.push_back(std::make_unique<gmpb::Num>(bits));
                gmpb::set(snap_r.back()->v, zr.v);
                snap_i.push_back(std::make_unique<gmpb::Num>(bits));
                gmpb::set(snap_i.back()->v, zi.v);
            }
        }
        if (per_start >= 0) {
            /* orbit.z holds Z_0..Z_n.  Fill the rest by repetition and keep the
             * in-loop SA integration aligned with the unrolled loop: step(Z_k,k)
             * is what the last line of that loop would have called. */
            for (int k = n; k < maxiter; ++k) {
                orbit.z.push_back(
                    orbit.z[(size_t)(per_start + (k + 1 - per_start) % per_len)]);
                sa.step(orbit.z[(size_t)k], k, maxiter);
            }
            orbit.escaped = false;
            orbit.escape_iter = -1;
            orbit.periodic = true;
            break;
        }

        if (need_derivative) {
            if (n == 0) {
                orbit.dz.push_back(CFexp(1.0, 0.0));
            } else {
                orbit.dz.push_back(orbit.z[(size_t)n - 1] * orbit.dz[(size_t)n - 1] * Fexp(2.0) +
                                   (julia ? CFexp(0.0, 0.0) : CFexp(1.0, 0.0)));
            }
        }

        if (n >= maxiter) break;

        /* Stop before magnitudes get so large that the squaring spends time on
         * a tail no pixel can use. */
        if (gmpb::cmp_d(zr.v, 1e40) > 0 || gmpb::cmp_d(zr.v, -1e40) < 0 ||
            gmpb::cmp_d(zi.v, 1e40) > 0 || gmpb::cmp_d(zi.v, -1e40) < 0) {
            orbit.escaped = true;
            orbit.escape_iter = n;
            break;
        }

        /* z <- z^2 + c with two multiplications: Re = (x+y)(x-y), Im = 2xy. */
        gmpb::add(sum.v, zr.v, zi.v);
        gmpb::sub(dif.v, zr.v, zi.v);
        gmpb::mul(pr.v, sum.v, dif.v);
        gmpb::mul(pi.v, zr.v, zi.v);
        gmpb::mul_2exp(pi.v, pi.v, 1);
        gmpb::add(zr.v, pr.v, ar.v);
        gmpb::add(zi.v, pi.v, ai.v);

        sa.step(orbit.z.back(), n, maxiter);
    }

    sa.finish(orbit);
    if (error && orbit.z.empty()) *error = "empty orbit";
    orbit.gmp = true;
    return !orbit.z.empty();
}

}  // namespace

void sa_set_epsilon(double log10_eps) { kSaEpsLog10 = log10_eps; }

bool sa_replay(Orbit& orbit, int sa_order, const Fexp& delta_max) {
    if (sa_order <= 0 || orbit.z.size() < 2) return false;
    /* The in-loop integration calls step(z_n, n, maxiter) once per update,
     * i.e. for n = 0 .. len-2.  Reproduce that exactly: the same z values, the
     * same iteration indices and the same floating-point operation order give
     * byte-identical coefficients, so the rendered frame cannot change. */
    SaTracker sa;
    sa.begin(sa_order, orbit.julia, delta_max);
    const int n = (int)orbit.z.size() - 1;
    for (int i = 0; i < n; ++i) sa.step(orbit.z[(size_t)i], i, orbit.maxiter);
    sa.finish(orbit);
    return true;
}

void orbit_set_backend(int which) {
    g_backend = (which < 0) ? -1 : (which > 0 ? 1 : 0);
}

const char* orbit_backend_name() {
    if (gmp_disabled()) return "bigfloat";
    return gmpb::available() ? "gmp" : "bigfloat";
}

PrecisionPlan plan_precision(double zoom_mantissa, int64_t zoom_exp10, int user_digits,
                             int max_digits) {
    PrecisionPlan p;
    p.zoom_exp10 = zoom_exp10;
    double log10_zoom = std::log10(std::fabs(zoom_mantissa)) + (double)zoom_exp10;
    int needed = (int)std::ceil(log10_zoom) + 50;  // 50 decimal guard digits
    if (needed < 60) needed = 60;
    if (user_digits > 0) {
        if (user_digits > needed) needed = user_digits;
    }
    if (needed > max_digits) needed = max_digits;
    p.digits = needed;
    p.limbs = needed / BigFloat::LIMB_DIGITS + 4;
    return p;
}

CFexp cfexp_from_bigfloat(const BigFloat& re, const BigFloat& im) {
    double mr = 0.0, mi = 0.0;
    int64_t er = 0, ei = 0;
    re.to_floatexp(mr, er);
    im.to_floatexp(mi, ei);
    return CFexp(Fexp(mr, er), Fexp(mi, ei));
}

bool compute_orbit(Orbit& orbit, const BigFloat& cr, const BigFloat& ci, int maxiter,
                   bool need_derivative, int sa_order, const Fexp& delta_max,
                   std::string* error) {
    BigFloat z0r(0.0), z0i(0.0);
    return compute_orbit_from(orbit, z0r, z0i, cr, ci, maxiter, need_derivative,
                              sa_order, delta_max, error);
}

bool compute_orbit_from(Orbit& orbit, const BigFloat& z0r, const BigFloat& z0i,
                        const BigFloat& cr, const BigFloat& ci, int maxiter,
                        bool need_derivative, int sa_order, const Fexp& delta_max,
                        std::string* error, bool julia) {
    /* GMP is the fast path and the only one that reaches 10^6000 in useful
     * time; BigFloat stays as the reference implementation and the fallback
     * when the DLL is not shipped.  Both produce the same orbit to the ~53 bits
     * that survive into CFexp, which is all the perturbation kernel uses. */
    const int digits_floor = std::max(orbit.digits, 72);
    const bool want_gmp = g_backend == 1
                              ? gmpb::available()
                              : (g_backend == 0 ? false
                                                : (!gmp_disabled() &&
                                                   digits_floor >= gmp_min_digits() &&
                                                   gmpb::available()));
    if (want_gmp) {
        return orbit_gmp(orbit, z0r, z0i, cr, ci, maxiter, need_derivative, sa_order,
                         delta_max, error, julia);
    }

    orbit.cr = cr;
    orbit.ci = ci;
    orbit.maxiter = maxiter;
    orbit.escaped = false;
    orbit.julia = julia;
    orbit.periodic = false;
    orbit.escape_iter = -1;
    orbit.z.clear();
    orbit.dz.clear();
    orbit.z.reserve((size_t)maxiter + 1);
    if (need_derivative) orbit.dz.reserve((size_t)maxiter + 1);

    int limbs = orbit.digits / BigFloat::LIMB_DIGITS + 4;
    if (limbs < 8) limbs = 8;
    BigFloat::precision_limbs = limbs;

    BigFloat zr = z0r, zi = z0i;
    orbit.c = cfexp_from_bigfloat(cr, ci);

    SaTracker sa;
    sa.begin(sa_order, julia, delta_max);

    for (int n = 0;; ++n) {
        orbit.z.push_back(cfexp_from_bigfloat(zr, zi));

        if (need_derivative) {
            if (n == 0) {
                orbit.dz.push_back(CFexp(1.0, 0.0));
            } else {
                orbit.dz.push_back(orbit.z[(size_t)n - 1] * orbit.dz[(size_t)n - 1] * Fexp(2.0) +
                                   (julia ? CFexp(0.0, 0.0) : CFexp(1.0, 0.0)));
            }
        }

        if (n >= maxiter) break;

        // Stop before magnitudes get so large that the BigFloat squaring
        // spends time on a tail no pixel can use.
        if (zr.magnitude_exp10() > 40 || zi.magnitude_exp10() > 40) {
            orbit.escaped = true;
            orbit.escape_iter = n;
            break;
        }

        // z <- z^2 + c, using two BigFloat multiplications:
        //   Re = (x+y)(x-y),  Im = 2xy
        BigFloat sum = zr + zi;
        BigFloat dif = zr - zi;
        BigFloat re2 = sum * dif;
        BigFloat im2 = (zr * zi).mul_ui(2);
        zr = re2 + cr;
        zi = im2 + ci;

        sa.step(orbit.z.back(), n, maxiter);
    }

    sa.finish(orbit);
    if (error && orbit.z.empty()) *error = "empty orbit";
    return !orbit.z.empty();
}
