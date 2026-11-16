// Small, directly testable numerical algorithms derived from the
// reference implementation:
//   radtest_hfloat        — series-approximation radius test
//   checkperiodgeneral    — cycle / periodicity detection
//   findmisiurewicz       — pre-periodic point test
//
// These are kept separate from the hot render loop so they can be read,
// unit-tested and reused by tools without pulling in the whole renderer.

#pragma once

#include "floatexp.hpp"
#include "reference.hpp"

#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

// log10 of |a-b|, with a relative floor so equal large values behave.
inline double cfexp_distance_log10(const CFexp& a, const CFexp& b) {
    CFexp d = a - b;
    Fexp n = cfexp_abs2(d);
    if (n.m == 0.0) return -std::numeric_limits<double>::infinity();
    return 0.5 * n.log10_abs();
}

// radtest_hfloat: the series is valid while the largest non-linear term is
// below the requested relative error.  Returns the log10 error bound.
inline double series_error_log10(const SeriesApprox& sa, const Fexp& delta_max) {
    if (sa.order <= 1 || sa.coef.size() < 2) return 0.0;
    double logd = delta_max.log10_abs();
    double worst = -std::numeric_limits<double>::infinity();
    for (int k = 2; k <= sa.order && k < (int)sa.coef.size(); ++k) {
        Fexp n = cfexp_abs2(sa.coef[(size_t)k]);
        if (n.m == 0.0) continue;
        double term = 0.5 * n.log10_abs() + (double)(k - 1) * logd;
        if (term > worst) worst = term;
    }
    return worst;
}

inline bool radtest(const SeriesApprox& sa, const Fexp& delta_max, double tolerance_log10 = -5.0) {
    return series_error_log10(sa, delta_max) < tolerance_log10;
}

// checkperiodgeneral: Brent's cycle detection on a stored orbit.  A point is
// periodic when |z_n - z_m| is below `relative_tol` times the magnitude.
// Returns 0 when no cycle is found within max_period.
inline int detect_period(const std::vector<CFexp>& z, int max_period,
                         double relative_tol = 1e-12) {
    if (z.size() < 3 || max_period < 1) return 0;
    int power = 1;
    int lam = 1;
    size_t tortoise = 1;
    size_t hare = 2;
    while (hare < z.size() && lam <= max_period) {
        double d = cfexp_distance_log10(z[tortoise], z[hare]);
        double scale = 0.5 * cfexp_abs2(z[hare]).log10_abs();
        if (d < scale + std::log10(relative_tol)) {
            return lam;
        }
        if (power == lam) {
            tortoise = hare;
            power *= 2;
            lam = 0;
        }
        ++hare;
        ++lam;
    }
    return 0;
}

// findmisiurewicz: true when z_{preperiod} and z_{preperiod+period} agree.
inline bool is_misiurewicz(const std::vector<CFexp>& z, int preperiod, int period,
                           double relative_tol = 1e-10) {
    if (preperiod < 0 || period < 1) return false;
    size_t a = (size_t)preperiod;
    size_t b = (size_t)preperiod + (size_t)period;
    if (b >= z.size()) return false;
    double d = cfexp_distance_log10(z[a], z[b]);
    double scale = 0.5 * cfexp_abs2(z[b]).log10_abs();
    return d < scale + std::log10(relative_tol);
}

// Pre-period: first index whose next `period` points repeat, or -1.
inline int find_preperiod(const std::vector<CFexp>& z, int period,
                          double relative_tol = 1e-10) {
    for (int i = 0; i + period < (int)z.size(); ++i) {
        if (is_misiurewicz(z, i, period, relative_tol)) return i;
    }
    return -1;
}
