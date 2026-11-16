// Floatexp — a floating point with a double mantissa and a 64-bit decimal
// exponent:  value = mantissa * 10^exponent, 1 <= |mantissa| < 10.
//
// This is the functional equivalent of the original binary's HFLOAT /
// HFLOATCOMPLEX (a ~62-bit mantissa with a 32-bit binary exponent, see
// _HFLOAT in the recovered DWARF types).  A double mantissa gives ~16
// significant digits; the 64-bit exponent removes every overflow/underflow
// limit, so a coordinate at 10^-800000 is as representable as one at 10^-8.
//
// All deep-zoom per-pixel arithmetic runs in this type.  Reference-orbit
// values are computed in BigFloat and then converted to Floatexp.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

struct Fexp {
    double m = 0.0;      // normalized: 1 <= |m| < 10, or exactly 0
    int64_t e = 0;       // decimal exponent

    Fexp() = default;
    Fexp(double v) : m(v) { normalize(); }
    Fexp(double mantissa, int64_t exp10) : m(mantissa), e(exp10) { normalize(); }

    bool is_zero() const { return m == 0.0; }

    /* 10^k without std::pow.
     *
     * This header is compiled both into mset.exe (MSVC + its own libm) and into
     * the desktop shell, whose CRT/libm mix has a defective std::pow/std::exp2:
     * there std::pow(10.0, -3.0) returned ~1.32 instead of 0.001.  Every
     * deep-zoom coordinate is built from 10^k, so one bad pow turns the whole
     * frame into a uniform colour at any zoom (the "10^0 already flat" bug).
     * The literals below are exactly rounded and the loops only multiply or
     * divide by ten, which is exact up to the final rounding. */
    static double pow10i(int k) {
        static const double tab[23] = {
            1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
            1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};
        if (k >= 0) {
            if (k <= 22) return tab[k];
            double r = tab[22];
            for (int i = 22; i < k; ++i) {
                r *= 10.0;
                if (!std::isfinite(r)) return r;
            }
            return r;
        }
        const int n = -k;
        if (n <= 22) return 1.0 / tab[n];
        if (n > 330) return 0.0;
        double r = 1.0 / tab[22];
        for (int i = 22; i < n; ++i) r /= 10.0;
        return r;
    }

    void normalize() {
        if (m == 0.0) { e = 0; return; }
        if (!std::isfinite(m)) { m = std::numeric_limits<double>::infinity(); return; }
        double a = std::fabs(m);
        if (a >= 10.0 || a < 1.0) {
            int k = (int)std::floor(std::log10(a));
            if (k != 0) {
                m /= pow10i(k);
                e += k;
            }
            a = std::fabs(m);
            while (a >= 10.0) { m /= 10.0; ++e; a = std::fabs(m); }
            while (a < 1.0) { m *= 10.0; --e; a = std::fabs(m); }
        }
    }

    double to_double() const {
        if (m == 0.0) return 0.0;
        if (e > 308) return m < 0 ? -HUGE_VAL : HUGE_VAL;
        if (e < -340) return m < 0 ? -0.0 : 0.0;
        return m * pow10i((int)e);
    }

    double log10_abs() const {
        if (m == 0.0) return -std::numeric_limits<double>::infinity();
        return std::log10(std::fabs(m)) + (double)e;
    }
};

/* 2^f for f in [0,1), to double precision, without std::pow/exp2.
 *
 * The desktop shell's CRT/libm returns garbage for those (exp2(-9.6359) came
 * back as 0.0345), and every decimal-to-binary conversion goes through here, so
 * a broken libm turns a whole frame into noise. */
inline double fexp_pow2_frac(double f) {
    /* exp(f*ln2/2) by Horner, then squared: halving the argument is what lets a
     * degree-12 series reach the last bit of the mantissa (the naive degree-9
     * fit is only good to ~1e-8, which shows up as a different escape count on
     * boundary pixels). */
    const double x = f * 0.34657359027997265;   // f * ln2 / 2
    static const double inv[13] = {0.0, 1.0, 1.0 / 2, 1.0 / 3, 1.0 / 4, 1.0 / 5,
                                   1.0 / 6, 1.0 / 7, 1.0 / 8, 1.0 / 9, 1.0 / 10,
                                   1.0 / 11, 1.0 / 12};
    double r = 1.0;
    for (int k = 12; k >= 1; --k) r = 1.0 + r * x * inv[k];
    return r * r;
}

/* exp(x) through 2^(x/ln2); the integer part is exact (ldexp), the fraction
 * uses the polynomial above. */
inline double fexp_exp(double x) {
    if (!(x > -700.0)) return 0.0;
    if (x > 700.0) return HUGE_VAL;
    const double t = x * 1.4426950408889634;   // x / ln2
    const double fl = std::floor(t);
    return std::ldexp(fexp_pow2_frac(t - fl), (int)fl);
}

inline Fexp operator-(const Fexp& a) { Fexp r = a; r.m = -r.m; return r; }

inline Fexp fexp_add(const Fexp& a, const Fexp& b) {
    if (a.m == 0.0) return b;
    if (b.m == 0.0) return a;
    Fexp x = a, y = b;
    if (x.e < y.e) std::swap(x, y);
    int64_t d = x.e - y.e;
    if (d > 22) return x;
    Fexp r;
    r.m = x.m + y.m * Fexp::pow10i(-(int)d);
    r.e = x.e;
    r.normalize();
    return r;
}

inline Fexp operator+(const Fexp& a, const Fexp& b) { return fexp_add(a, b); }
inline Fexp operator-(const Fexp& a, const Fexp& b) { return fexp_add(a, -b); }
inline Fexp operator*(const Fexp& a, const Fexp& b) {
    if (a.m == 0.0 || b.m == 0.0) return Fexp();
    Fexp r;
    r.m = a.m * b.m;
    r.e = a.e + b.e;
    r.normalize();
    return r;
}
inline Fexp operator/(const Fexp& a, const Fexp& b) {
    if (a.m == 0.0) return Fexp();
    Fexp r;
    r.m = a.m / b.m;
    r.e = a.e - b.e;
    r.normalize();
    return r;
}

inline int fexp_cmp(const Fexp& a, const Fexp& b) {
    if (a.m == 0.0) return b.m == 0.0 ? 0 : -1;
    if (b.m == 0.0) return 1;
    if (a.e != b.e) return a.e < b.e ? -1 : 1;
    if (a.m != b.m) return a.m < b.m ? -1 : 1;
    return 0;
}
inline bool operator<(const Fexp& a, const Fexp& b) { return fexp_cmp(a, b) < 0; }
inline bool operator==(const Fexp& a, const Fexp& b) { return fexp_cmp(a, b) == 0; }

inline Fexp fexp_abs2(const Fexp& a) {
    return Fexp(a.m * a.m, a.e * 2);
}

inline Fexp fexp_abs(const Fexp& a) {
    if (a.m == 0.0) return Fexp();
    double m = std::fabs(a.m);
    int64_t e = a.e;
    int64_t half = e / 2;
    int64_t rem = e - half * 2;  // 0 or 1 (C++ truncates toward zero for negatives)
    if (rem < 0) { rem += 2; --half; }
    Fexp r(std::sqrt(m * Fexp::pow10i((int)rem)), half);
    return r;
}

inline Fexp fexp_powi(Fexp a, int k) {
    Fexp r(1.0);
    if (k < 0) { a = Fexp(1.0) / a; k = -k; }
    while (k) {
        if (k & 1) r = r * a;
        a = a * a;
        k >>= 1;
    }
    return r;
}

struct CFexp {
    Fexp re, im;

    CFexp() = default;
    CFexp(double r, double i) : re(r), im(i) {}
    CFexp(Fexp r, Fexp i) : re(r), im(i) {}

    bool is_zero() const { return re.m == 0.0 && im.m == 0.0; }
};

inline CFexp operator+(const CFexp& a, const CFexp& b) { return {a.re + b.re, a.im + b.im}; }
inline CFexp operator-(const CFexp& a, const CFexp& b) { return {a.re - b.re, a.im - b.im}; }
inline CFexp operator-(const CFexp& a) { return {-a.re, -a.im}; }
inline CFexp operator*(const CFexp& a, const CFexp& b) {
    return {a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re};
}
inline CFexp operator*(const CFexp& a, const Fexp& s) { return {a.re * s, a.im * s}; }
inline CFexp operator*(const Fexp& s, const CFexp& a) { return a * s; }

inline Fexp cfexp_abs2(const CFexp& a) { return a.re * a.re + a.im * a.im; }
inline Fexp cfexp_abs(const CFexp& a) { return fexp_abs(cfexp_abs2(a)); }

inline CFexp cfexp_pow(const CFexp& a, int k) {
    CFexp r(1.0, 0.0);
    CFexp base = a;
    while (k) {
        if (k & 1) r = r * base;
        base = base * base;
        k >>= 1;
    }
    return r;
}

// Conversion helper used by the renderer and by SA evaluation.
inline CFexp cfexp_from_double(double r, double i) { return CFexp(Fexp(r), Fexp(i)); }
