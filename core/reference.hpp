// Reference orbit and series approximation (the "deep zoom" core).
//
// The original engine (newref_hfloat / makeref_hfloat / multaylor_hfloat /
// radtest_hfloat in the reference design notes) builds high-precision reference
// orbits, stores them in a canvas hierarchy, and uses local offsets in HFLOAT
// so that per-pixel arithmetic never needs the absolute precision.  This
// implementation keeps that separation explicitly:
//
//   absolute c, z_n  -> BigFloat (arbitrary precision)
//   z_n              -> CFexp  (double mantissa + 64-bit decimal exponent)
//   pixel offset d0  -> CFexp
//
// Series approximation uses coefficients A_k with
//   d_n = sum_k A_k(n) * d_0^k
// and a Cauchy-style radius test to choose a safe skip count.

#pragma once

#include "bigfloat.hpp"
#include "floatexp.hpp"

#include <cstdint>
#include <string>
#include <vector>

struct PrecisionPlan {
    int digits = 60;
    int limbs = 10;
    int64_t zoom_exp10 = 0;
};

// zoom = zoom_mantissa * 10^zoom_exp10.  `user_digits` <= 0 means automatic.
PrecisionPlan plan_precision(double zoom_mantissa, int64_t zoom_exp10, int user_digits,
                             int max_digits);

struct SeriesApprox {
    int order = 0;
    int skip = 0;                    // number of iterations safely skipped
    std::vector<CFexp> coef;         // A_1..A_order at iteration `skip`
    bool usable = false;
    double delta_log10 = 0.0;        // log10(max |d0| over the frame)
};

struct Orbit {
    BigFloat cr, ci;
    int digits = 0;
    int maxiter = 0;
    std::vector<CFexp> z;            // z_0 .. z_N (may stop early on escape)
    std::vector<CFexp> dz;           // optional derivative d z_n / d c
    bool escaped = false;
    bool julia = false;
    bool gmp = false;                // built through libgmp (see gmp_bridge)
    /* Exact eventual period found by orbit_gmp: the tail of z[] was tiled
     * analytically instead of being squared at full precision. */
    bool periodic = false;
    int escape_iter = -1;
    CFexp c;                         // c as CFexp (for convenience)
    SeriesApprox sa;
};

// Computes z_{n+1} = z_n^2 + c until maxiter or until the orbit is clearly
// unbounded.  Also builds the series-approximation snapshot when order > 0.
bool compute_orbit(Orbit& orbit, const BigFloat& cr, const BigFloat& ci, int maxiter,
                   bool need_derivative, int sa_order, const Fexp& delta_max,
                   std::string* error);

// Julia variant: z_0 = (z0r,z0i) is the viewport centre and c is a fixed
// parameter.  The Mandelbrot entry point above is the special case z_0 = 0.
bool compute_orbit_from(Orbit& orbit, const BigFloat& z0r, const BigFloat& z0i,
                        const BigFloat& cr, const BigFloat& ci, int maxiter,
                        bool need_derivative, int sa_order, const Fexp& delta_max,
                        std::string* error, bool julia = false);

// log10 of the relative truncation error the series approximation may leave
// before it stops being used for skipping.  Default -12 (1e-12), which is two
// orders below the double mantissa of the per-pixel perturbation.
void sa_set_epsilon(double log10_eps);

// Pin the reference-orbit backend: -1 auto (GMP when the DLL is present and
// the precision is high enough), 0 BigFloat, 1 GMP.  Used by the tests.
void orbit_set_backend(int which);

// "gmp" or "bigfloat" -- what the next orbit will actually use.
const char* orbit_backend_name();

// Re-integrate the series approximation on an orbit that was built with
// sa_order == 0.
//
// The coefficients A_k depend only on the already-stored z_n sequence (CFexp),
// never on the high-precision arithmetic that produced it.  Replaying them is
// O(len * order^2) cheap float-exp work; rebuilding the orbit just to carry
// coefficients costs a *second* full-precision orbit -- at 10^6000 that was
// 1.95 s of a 4.13 s frame.  Returns true when coefficients were produced.
bool sa_replay(Orbit& orbit, int sa_order, const Fexp& delta_max);

// Helper used by the renderer and tests.
CFexp cfexp_from_bigfloat(const BigFloat& re, const BigFloat& im);
