#include "deep.hpp"

#include "reference.hpp"

#include <algorithm>
#include <atomic>
#if defined(__AVX2__)
#include <immintrin.h>
#endif
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// Binary float-exp: value = m * 2^e with |m| in [0.5, 1), or m == 0.
//
// Binary rather than decimal because every step here is a multiply or a sum of
// like magnitudes: renormalising costs one comparison instead of a log10 call.
// ---------------------------------------------------------------------------
struct F2 {
    double m = 0.0;
    int e = 0;
};

inline F2 f2_zero() { return F2{0.0, 0}; }

inline F2 f2_from(double v) {
    if (v == 0.0 || !std::isfinite(v)) return f2_zero();
    int e = 0;
    double m = std::frexp(v, &e);
    return F2{m, e};
}

inline F2 f2_from_mant_exp2(double mant, int e2) {
    if (mant == 0.0 || !std::isfinite(mant)) return f2_zero();
    int e = 0;
    double m = std::frexp(mant, &e);
    return F2{m, e + e2};
}

// mant * 10^e10, with mant in the decimal-floatexp range [1,10).
inline F2 f2_from_pow10(double mant, int64_t e10) {
    if (mant == 0.0) return f2_zero();
    const double t = (double)e10 * 3.32192809488736234787;  // log2(10)
    const double fl = std::floor(t);
    const double fr = t - fl;
    return f2_from_mant_exp2(mant * fexp_pow2_frac(fr), (int)fl);
}

inline F2 f2_mul(const F2& a, const F2& b) {
    if (a.m == 0.0 || b.m == 0.0) return f2_zero();
    const double mm = a.m * b.m;   // magnitude in [0.25, 1)
    const int ee = a.e + b.e;
    if (mm >= 0.5 || mm <= -0.5) return F2{mm, ee};
    return F2{mm * 2.0, ee - 1};
}

// 2^k for |k| < 1023, built by writing the exponent field directly.
inline double f2_pow2(int k) {
    const uint64_t bits = (uint64_t)(k + 1023) << 52;
    double d;
    std::memcpy(&d, &bits, sizeof d);
    return d;
}

// Renormalises an arbitrary double to |m| in [0.5,1) by rewriting the IEEE
// exponent field, so it costs a few instructions and no branch.  A single
// compare-and-scale is *not* enough: adding two nearly opposite numbers leaves
// the sum arbitrarily small (that is the whole point of the cancellation test),
// and an unnormalised mantissa silently breaks every later magnitude compare.
inline F2 f2_norm(double v, int e) {
    if (v == 0.0) return f2_zero();
    uint64_t b;
    std::memcpy(&b, &v, sizeof b);
    const int be = (int)((b >> 52) & 0x7FFu);
    if (be == 0) {                     // subnormal: rare, let the CRT do it
        int k = 0;
        const double m = std::frexp(v, &k);
        return F2{m, e + k};
    }
    b = (b & ~(0x7FFULL << 52)) | (1022ULL << 52);
    double m;
    std::memcpy(&m, &b, sizeof m);
    return F2{m, e + be - 1022};
}

// The addition is the hot operation, so it must not call frexp/ldexp: both are
// CRT calls and the step loop does several per iteration.
inline F2 f2_add(const F2& a, const F2& b) {
    if (a.m == 0.0) return b;
    if (b.m == 0.0) return a;
    const int d = a.e - b.e;
    if (d > 60) return a;
    if (d < -60) return b;
    return f2_norm(a.m + b.m * f2_pow2(-d), a.e);
}

inline F2 f2_sub(const F2& a, const F2& b) { return f2_add(a, F2{-b.m, b.e}); }
inline F2 f2_scale2(const F2& a) { return F2{a.m, a.e + 1}; }

inline F2 f2_abs2(const F2& a) {
    if (a.m == 0.0) return f2_zero();
    const double mm = a.m * a.m;   // in [0.25, 1)
    const int ee = a.e + a.e;
    if (mm >= 0.5) return F2{mm, ee};
    return F2{mm * 2.0, ee - 1};
}

inline F2 f2_abs(const F2& a) {
    if (a.m == 0.0) return f2_zero();
    return F2{std::fabs(a.m), a.e};
}

inline F2 f2_sqrt(const F2& a) {
    if (a.m <= 0.0) return f2_zero();
    const int half = (int)std::floor((double)a.e * 0.5);
    const int rem = a.e - 2 * half;             // 0 or 1
    return f2_from_mant_exp2(std::sqrt(a.m * (rem ? 2.0 : 1.0)), half);
}

// |a| <=> |b|
inline int f2_cmp_abs(const F2& a, const F2& b) {
    if (a.m == 0.0) return b.m == 0.0 ? 0 : -1;
    if (b.m == 0.0) return 1;
    const F2 x = f2_abs(a), y = f2_abs(b);
    if (x.e != y.e) return x.e < y.e ? -1 : 1;
    if (x.m != y.m) return x.m < y.m ? -1 : 1;
    return 0;
}

inline double f2_log_abs(const F2& a) {
    if (a.m == 0.0) return -std::numeric_limits<double>::infinity();
    return std::log(std::fabs(a.m)) + (double)a.e * 0.69314718055994530942;
}

struct C2 {
    F2 re, im;
};

inline C2 c2_add(const C2& a, const C2& b) { return C2{f2_add(a.re, b.re), f2_add(a.im, b.im)}; }

inline C2 c2_mul(const C2& a, const C2& b) {
    return C2{f2_sub(f2_mul(a.re, b.re), f2_mul(a.im, b.im)),
              f2_add(f2_mul(a.re, b.im), f2_mul(a.im, b.re))};
}

inline C2 c2_scale2(const C2& a) { return C2{f2_scale2(a.re), f2_scale2(a.im)}; }
inline F2 c2_abs2(const C2& a) { return f2_add(f2_abs2(a.re), f2_abs2(a.im)); }
inline int c2_cmp_abs(const C2& a, const C2& b) { return f2_cmp_abs(c2_abs2(a), c2_abs2(b)); }

// ---------------------------------------------------------------------------
// Reference orbit cached in the per-pixel arithmetic type, so the step loop
// never pays for a decimal conversion.
// ---------------------------------------------------------------------------
struct RefCache {
    std::vector<C2> z;
    std::vector<F2> zabs2;   // |Z_n|^2, invariant across pixels
    std::vector<C2> dz;
    int len = 0;
    bool escaped = false;
    int rdx = 0, rdy = 0;
    /* Plane anchor in *pixel* coordinates (may be fractional when the exact
     * frame centre is used).  d0 = (pixel - anchor) * scale. */
    double anchor_x = 0.0, anchor_y = 0.0;
    bool periodic = false;
    bool sa_usable = false;
    int sa_order = 0;
    int sa_skip = 0;
    /* True when the orbit stopped at a step cap rather than by escaping or by
     * reaching the iteration budget.  Such a reference is NOT known to be
     * interior, so pixels that run off its end are unresolved, not inside. */
    bool truncated = false;
    /* Julia sets have the same c for every pixel, so the perturbation has the
     * pixel offset as its INITIAL condition and no constant term:
     *   d_0 = delta,             d_{n+1} = 2 Z_n d_n + d_n^2
     * Mandelbrot sets vary c, so instead
     *   d_0 = 0 (delta here),    d_{n+1} = 2 Z_n d_n + d_n^2 + delta.
     * The series coefficients are already integrated with this distinction
     * (SaTracker skips its +1 term for Julia).  The pixel kernels must agree,
     * or a frame with series skipping is wrong even though one without it
     * looks fine (the extra delta is too small to move an escape count). */
    bool julia = false;
    std::vector<CFexp> sa_coef;
    /* The same coefficients in the per-pixel arithmetic.  Evaluating the
     * series in CFexp costs four decimal normalisations per complex multiply
     * *per pixel*, which at 1.6 Mpx and 16 terms is a third of a second;
     * the binary form is one multiply and a bit-twiddle. */
    std::vector<C2> sa_coef2;

    /* Double fast path.  Valid while the pixel offsets are inside double's
     * exponent range; `zr`/`zi` are the same orbit the C2 arrays hold, and
     * `sa_r`/`sa_i` the same series coefficients, both in plain doubles. */
    bool dbl_ok = false;
    int sa_dbl_order = 0;          // series terms double can hold
    std::vector<double> zr, zi;
    std::vector<double> sa_r, sa_i;
};

// |z| > 2 normally; |z| > 256 when the distance estimator is wanted.
constexpr double kEscape2 = 4.0;
constexpr double kEscape2Dist = 65536.0;

// (2^-20)^2: how far |Z+d|^2 may fall below max(|Z|^2,|d|^2) before the
// addition is considered to have lost its significant digits.
inline int g_cancel_bits = 20;
inline F2 f2_cancel2() { return F2{0.5, -2 * g_cancel_bits - 1}; }   // exactly 2^-2b

struct PxResult {
    int steps = 0;
    int iter = -1;
    double smooth = -1.0;
    double dist = 0.0;
    bool interior = false;
    int glitch = 0;    // first iteration where the sum lost its significant digits
};

// Per-pixel state carried across repair rounds, so a round can resume instead
// of restarting from zero.
inline C2 series_value(const RefCache& ref, const C2& d0) {
    C2 sum{f2_zero(), f2_zero()};
    C2 p{f2_from(1.0), f2_zero()};
    for (int k = 1; k <= ref.sa_order; ++k) {
        sum = c2_add(sum, c2_mul(ref.sa_coef2[(size_t)k], p));
        p = c2_mul(p, d0);
    }
    return sum;
}

// z_n = Z_n + d_n with d_{n+1} = 2 Z_n d_n + d_n^2 + d_0.
inline void iterate_pixel(const RefCache& ref, const C2& d0,
                          bool want_distance, const F2& scale2, PxResult& out) {
    const double bail2 = want_distance ? kEscape2Dist : kEscape2;
    const F2 bail2f = f2_from(bail2);

    int n0 = 0;
    C2 d = d0;
    if (ref.sa_usable && ref.sa_skip > 0 && ref.sa_skip < ref.len) {
        n0 = ref.sa_skip;
        const C2 s = series_value(ref, d0);
        // d_skip = d_0 * s
        d = c2_mul(d0, s);
    }

    C2 E{f2_from(1.0), f2_zero()};

    for (int n = n0; n < ref.len; ++n) {
        ++out.steps;
        const C2 z = c2_add(ref.z[(size_t)n], d);
        const F2 z2 = c2_abs2(z);

        if (f2_cmp_abs(z2, bail2f) > 0) {
            out.iter = n;
            const double lz = 0.5 * f2_log_abs(z2);       // log|z|
            const double lb = 0.5 * std::log(bail2);      // log(bailout)
            double ratio = lz / lb;
            if (ratio < 1e-15) ratio = 1e-15;
            out.smooth = (double)n + 1.0 - std::log2(ratio);
            if (out.smooth < 0.0) out.smooth = 0.0;
            if (want_distance && E.re.m != 0.0) {
                // de = |z| log|z| / |dz|, converted to pixel units.
                const F2 za = f2_sqrt(z2);
                const double lza = 0.5 * f2_log_abs(z2);
                const F2 num = f2_mul(za, f2_from(lza));
                const F2 den = f2_mul(f2_sqrt(c2_abs2(E)), scale2);
                if (den.m != 0.0) {
                    const double ln = f2_log_abs(num) - f2_log_abs(den);
                    out.dist = fexp_exp(ln);
                }
            }
            return;
        }

        // Catastrophic cancellation.  The test is *not* |z| < |d|: the
        // perturbation normally grows until it is as large as the reference
        // far from any cancellation (at 1e38 that crossing happens at n~1711
        // while the pixels only escape at 1780+, so |z| < |d| flags the whole
        // frame).  What actually destroys the sum is |z| becoming negligible
        // next to the two numbers being added, so compare against
        // max(|d|, |Z|) and demand 20 bits of headroom.
        if (n > 0) {
            const F2 d2 = c2_abs2(d);
            const F2& Z2 = ref.zabs2[(size_t)n];
            const F2& bg = (f2_cmp_abs(d2, Z2) > 0) ? d2 : Z2;
            // comparing against bg * 2^-40 is just an exponent shift
            if (f2_cmp_abs(F2{z2.m, z2.e + 2 * g_cancel_bits}, bg) < 0) {
                out.glitch = n;
                return;
            }
        }

        if (n + 1 >= ref.len) break;

        C2 nd = c2_add(c2_scale2(c2_mul(ref.z[(size_t)n], d)), c2_mul(d, d));
        if (!ref.julia) nd = c2_add(nd, d0);
        d = nd;

        if (want_distance) {
            E = c2_scale2(c2_mul(z, E));
            if (!ref.julia) E = c2_add(E, C2{f2_from(1.0), f2_zero()});
        }
    }

    if (!ref.escaped && !ref.truncated) {
        out.interior = true;
        out.iter = -1;
        out.smooth = -1.0;
        return;
    }
    // The reference died before this pixel did: unresolved, and the only cure
    // is a reference anchored further out.
    out.glitch = ref.len - 1;
}

// ---------------------------------------------------------------------------
// Double fast path
//
// Above ~1e-250 the pixel offsets, the perturbation and the reference all sit
// inside double's exponent range, and the binary float-exp machinery is pure
// overhead: it costs 88 ns per step against ~10 ns for the same arithmetic in
// plain doubles.  The algorithm is identical -- same reference, same series
// skip, same cancellation test -- so the two paths agree to the last bit of the
// mantissa; only the exponent bookkeeping is gone.
//
// Below that depth the offsets themselves leave double's range and this path is
// skipped (ref.dbl_ok), leaving the float-exp kernel in charge.
// ---------------------------------------------------------------------------
inline double f2_to_double(const F2& a) {
    if (a.m == 0.0) return 0.0;
    return std::ldexp(a.m, a.e);
}

// ---------------------------------------------------------------------------
// Four pixels at a time
//
// Every pixel in a row shares the reference orbit, so the per-step work is
// Z_n * d_n with Z_n a broadcast scalar and d_n a 4-lane vector: exactly the
// shape AVX2 wants.  Four lanes take one pass over the reference instead of
// four, and the step is 6 multiplies and 4 adds wide.
//
// The lanes leave the loop at different iterations, so the mask is the state:
// `active` holds the lanes still running, a compare of |z|^2 against the bailout
// retires the ones that escaped, and the cancellation test retires the ones
// that lost their digits.  Both are rare events -- the loop runs at one
// `movemask` per step otherwise, which is a single instruction.
//
// Only the double path is vectorised: the float-exp kernel spends its time in
// exponent bookkeeping rather than arithmetic, and the deep frames that need it
// are dominated by orbit construction anyway.
// ---------------------------------------------------------------------------
#if defined(__AVX2__)
inline void iterate_quad_d(const RefCache& ref, const double* d0r, const double* d0i,
                           PxResult* out, long long& steps) {
    /* Smooth colouring only: the distance estimator needs dz/dc per lane and is
     * the rarer mode, so it stays on the scalar kernel rather than doubling the
     * width of every register here. */
    const double bail2 = kEscape2;
    const __m256d vbail = _mm256_set1_pd(bail2);
    const __m256d vcancel = _mm256_set1_pd(std::ldexp(1.0, -2 * g_cancel_bits));
    const __m256d vtwo = _mm256_set1_pd(2.0);

    int n0 = 0;
    alignas(32) double dr[4], di[4];
    for (int k = 0; k < 4; ++k) { dr[k] = d0r[k]; di[k] = d0i[k]; }
    if (ref.sa_usable && ref.sa_skip > 0 && ref.sa_skip < ref.len) {
        n0 = ref.sa_skip;
        for (int k = 0; k < 4; ++k) {
            double sr = 0.0, si = 0.0, pr = 1.0, pi = 0.0;
            for (int j = 1; j <= ref.sa_dbl_order; ++j) {
                const double ar = ref.sa_r[(size_t)j], ai = ref.sa_i[(size_t)j];
                sr += ar * pr - ai * pi;
                si += ar * pi + ai * pr;
                const double nr = pr * d0r[k] - pi * d0i[k];
                pi = pr * d0i[k] + pi * d0r[k];
                pr = nr;
            }
            dr[k] = d0r[k] * sr - d0i[k] * si;
            di[k] = d0r[k] * si + d0i[k] * sr;
        }
    }

    __m256d vr = _mm256_load_pd(dr), vi = _mm256_load_pd(di);
    __m256d vr0 = _mm256_load_pd(d0r), vi0 = _mm256_load_pd(d0i);
    /* Julia's recursion has no +d_0 term (see RefCache::julia).  The series
     * still uses d0r/d0i directly; only the per-step constant is zeroed. */
    if (ref.julia) {
        vr0 = _mm256_setzero_pd();
        vi0 = _mm256_setzero_pd();
    }

    int active = 0xF;
    alignas(32) double z2buf[4];
    int last_n = n0;

    for (int n = n0; n < ref.len && active; ++n) {
        last_n = n;
        const __m256d Zr = _mm256_set1_pd(ref.zr[(size_t)n]);
        const __m256d Zi = _mm256_set1_pd(ref.zi[(size_t)n]);
        const __m256d zr = _mm256_add_pd(Zr, vr);
        const __m256d zi = _mm256_add_pd(Zi, vi);
        const __m256d z2 = _mm256_add_pd(_mm256_mul_pd(zr, zr), _mm256_mul_pd(zi, zi));

        /* Retire the lanes whose orbit escaped, in the same arithmetic the
         * scalar kernel uses so the two paths agree on the iteration count. */
        int esc = _mm256_movemask_pd(_mm256_cmp_pd(z2, vbail, _CMP_GT_OQ)) & active;
        if (esc) {
            _mm256_store_pd(z2buf, z2);
            for (int k = 0; k < 4; ++k) {
                if (!(esc & (1 << k))) continue;
                PxResult& o = out[k];
                const double lz = 0.5 * std::log(std::max(z2buf[k], 1e-300));
                double ratio = lz / (0.5 * std::log(bail2));
                if (ratio < 1e-15) ratio = 1e-15;
                o.iter = n;
                o.smooth = (double)n + 1.0 - std::log2(ratio);
                if (o.smooth < 0.0) o.smooth = 0.0;
            }
            active &= ~esc;
            if (!active) break;
        }

        /* Same cancellation test as the scalar path, four lanes at once. */
        if (n > 0) {
            const __m256d d2 = _mm256_add_pd(_mm256_mul_pd(vr, vr), _mm256_mul_pd(vi, vi));
            const __m256d Z2 = _mm256_set1_pd(ref.zr[(size_t)n] * ref.zr[(size_t)n] +
                                              ref.zi[(size_t)n] * ref.zi[(size_t)n]);
            const __m256d bg = _mm256_max_pd(d2, Z2);
            const int cxl = _mm256_movemask_pd(_mm256_cmp_pd(z2, _mm256_mul_pd(bg, vcancel),
                                                             _CMP_LT_OQ)) & active;
            if (cxl) {
                for (int k = 0; k < 4; ++k) {
                    if (cxl & (1 << k)) out[k].glitch = n;
                }
                active &= ~cxl;
                if (!active) break;
            }
        }

        if (n + 1 >= ref.len) break;

        // d_{n+1} = 2 Z_n d_n + d_n^2 + d_0
        const __m256d t1r = _mm256_mul_pd(vtwo, _mm256_sub_pd(_mm256_mul_pd(Zr, vr),
                                                             _mm256_mul_pd(Zi, vi)));
        const __m256d t1i = _mm256_mul_pd(vtwo, _mm256_add_pd(_mm256_mul_pd(Zr, vi),
                                                             _mm256_mul_pd(Zi, vr)));
        const __m256d sqr = _mm256_sub_pd(_mm256_mul_pd(vr, vr), _mm256_mul_pd(vi, vi));
        const __m256d sqi = _mm256_mul_pd(vtwo, _mm256_mul_pd(vr, vi));
        vr = _mm256_add_pd(_mm256_add_pd(t1r, sqr), vr0);
        vi = _mm256_add_pd(_mm256_add_pd(t1i, sqi), vi0);

    }
    steps += (long long)(last_n - n0 + 1) * 4;   // upper bound; stats only

    for (int k = 0; k < 4; ++k) {
        if (active & (1 << k)) {
            /* Still running when the reference ran out: unresolved, exactly as
             * the scalar kernel reports it. */
            if (!ref.escaped && !ref.truncated) {
                out[k].interior = true;
                out[k].iter = -1;
                out[k].smooth = -1.0;
            } else {
                out[k].glitch = ref.len - 1;
            }
        }
    }
}
#endif  // __AVX2__

inline void iterate_pixel_d(const RefCache& ref, double d0r, double d0i,
                            bool want_distance, double scale, PxResult& out) {
    const double bail2 = want_distance ? kEscape2Dist : kEscape2;

    int n0 = 0;
    double dr = d0r, di = d0i;
    if (ref.sa_usable && ref.sa_skip > 0 && ref.sa_skip < ref.len) {
        n0 = ref.sa_skip;
        /* s(d0) = sum a_k d0^(k-1).  d0 is ~1e-40 here, so every term past the
         * first underflows to zero -- which is its true value, not a loss. */
        double sr = 0.0, si = 0.0, pr = 1.0, pi = 0.0;
        for (int k = 1; k <= ref.sa_dbl_order; ++k) {
            const double ar = ref.sa_r[(size_t)k], ai = ref.sa_i[(size_t)k];
            sr += ar * pr - ai * pi;
            si += ar * pi + ai * pr;
            const double nr = pr * d0r - pi * d0i;
            pi = pr * d0i + pi * d0r;
            pr = nr;
        }
        dr = d0r * sr - d0i * si;
        di = d0r * si + d0i * sr;
    }

    double er = 1.0, ei = 0.0;      // dz/dc

    for (int n = n0; n < ref.len; ++n) {
        ++out.steps;
        const double Zr = ref.zr[(size_t)n], Zi = ref.zi[(size_t)n];
        const double zr = Zr + dr, zi = Zi + di;
        const double z2 = zr * zr + zi * zi;

        if (z2 > bail2) {
            out.iter = n;
            const double lz = 0.5 * std::log(std::max(z2, 1e-300));
            double ratio = lz / (0.5 * std::log(bail2));
            if (ratio < 1e-15) ratio = 1e-15;
            out.smooth = (double)n + 1.0 - std::log2(ratio);
            if (out.smooth < 0.0) out.smooth = 0.0;
            if (want_distance) {
                const double dr2 = er * er + ei * ei;
                const double den = std::sqrt(dr2) * scale;
                if (den > 0.0) {
                    const double za = std::sqrt(z2);
                    out.dist = za * std::log(std::max(za, 1e-300)) / den;
                }
            }
            return;
        }

        /* Same cancellation test as the float-exp path: |z| next to nothing
         * beside the two numbers being added.  |d|^2 = d0^2 |D|^2 and D is
         * what the recursion grows, so compare those directly. */
        if (n > 0) {
            const double mag2 = zr * zr + zi * zi;
            const double d2 = dr * dr + di * di;
            const double Z2 = Zr * Zr + Zi * Zi;
            const double bg = d2 > Z2 ? d2 : Z2;
            if (mag2 < bg * std::ldexp(1.0, -2 * g_cancel_bits)) {
                out.glitch = n;
                return;
            }
        }

        if (n + 1 >= ref.len) break;

        // Julia has no constant term; see RefCache::julia.
        // d_{n+1} = 2 Z_n d_n + d_n^2 (+ d_0 for Mandelbrot)
        const double t1r = 2.0 * (Zr * dr - Zi * di);
        const double t1i = 2.0 * (Zr * di + Zi * dr);
        const double sqr = dr * dr - di * di;
        const double sqi = 2.0 * dr * di;
        dr = t1r + sqr + (ref.julia ? 0.0 : d0r);
        di = t1i + sqi + (ref.julia ? 0.0 : d0i);

        if (want_distance) {
            const double ner = 2.0 * (zr * er - zi * ei) + (ref.julia ? 0.0 : 1.0);
            const double nei = 2.0 * (zr * ei + zi * er);
            er = ner;
            ei = nei;
        }
    }

    if (!ref.escaped && !ref.truncated) {
        out.interior = true;
        out.iter = -1;
        out.smooth = -1.0;
        return;
    }
    out.glitch = ref.len - 1;
}

// ---------------------------------------------------------------------------
// Frame geometry
// ---------------------------------------------------------------------------
struct View {
    const DeepParams* p;

    // Plane offset (complex, in plane units) of a pixel offset in the screen
    // basis.  With rotation the basis is turned about the frame centre, which
    // is the same map the recovered program applies; every other stage of the
    // pipeline is then unaware that the view is rotated.
    void offset_px(double nx, double ny, Fexp& sx, Fexp& sy) const {
        if (!p->rotated()) {
            sx = p->scale * Fexp(nx);
            sy = p->scale * Fexp(ny);
            return;
        }
        sx = p->scale * Fexp(p->rot_cos * nx) - p->scale * Fexp(p->rot_sin * ny);
        sy = p->scale * Fexp(p->rot_sin * nx) + p->scale * Fexp(p->rot_cos * ny);
    }

    void pixel_c(int x, int y, BigFloat& re, BigFloat& im) const {
        Fexp sx, sy;
        offset_px(((double)x + 0.5) - (double)p->width * 0.5,
                  (double)p->height * 0.5 - ((double)y + 0.5), sx, sy);
        re = *p->cr + BigFloat::from_floatexp(sx.m, sx.e);
        im = *p->ci + BigFloat::from_floatexp(sy.m, sy.e);
    }

    // Exact when unrotated: the offset is an integer number of pixels times the
    // pixel scale, so no addition ever touches it.  A rotated view composes the
    // same integer offset through the turned basis; the extra additions cost a
    // few percent and stay relative to the pixel scale, i.e. they move a point
    // by far less than one pixel even at 1e-60000.
    // The same offset in plain doubles, for the fast path.
    void delta_d(int x, int y, double anchor_x, double anchor_y, double& dr, double& di) const {
        const double nx = (double)x - anchor_x;
        const double ny = anchor_y - (double)y;
        const double s = p->scale.to_double();
        if (!p->rotated()) { dr = s * nx; di = s * ny; return; }
        dr = s * (p->rot_cos * nx - p->rot_sin * ny);
        di = s * (p->rot_sin * nx + p->rot_cos * ny);
    }

    void delta(int x, int y, double anchor_x, double anchor_y, CFexp& d0, C2& d2) const {
        Fexp sx, sy;
        const double nx = (double)x - anchor_x;
        const double ny = anchor_y - (double)y;
        offset_px(nx, ny, sx, sy);
        d0 = CFexp(sx, sy);
        d2 = C2{f2_from_pow10(sx.m, sx.e), f2_from_pow10(sy.m, sy.e)};
    }
};

/* A/B switch: with the replay disabled the ladder falls back to the old
 * "rebuild the anchor with coefficients" path.  Both must render identically. */
bool sa_replay_enabled() {
    static const bool v = [] {
        const char* e = std::getenv("B2_SA_REPLAY");
        return !e || std::atoi(e) != 0;
    }();
    return v;
}

/* Fill the series / double caches from a finished orbit.
 *
 * Split out of build_reference() so the ladder can attach the series to an
 * orbit it has already built.  A_k depends only on the stored z_n sequence,
 * never on the high-precision arithmetic that produced it, so the old "rebuild
 * the anchor with coefficients" step was paying for a whole second mpf orbit
 * (1.95 s of a 4.13 s frame at 1e6000) to recompute something that a replay
 * over CFexp values produces in milliseconds. */
void apply_series(RefCache& ref, const Orbit& orb, double log10_scale) {
    ref.julia = orb.julia;
    ref.sa_usable = orb.sa.usable && orb.sa.order > 0 && orb.sa.skip > 0;
    ref.sa_order = std::max(0, std::min<int>(orb.sa.order, (int)orb.sa.coef.size() - 1));
    ref.sa_skip = orb.sa.skip;
    ref.sa_coef = orb.sa.coef;
    ref.sa_coef2.assign(ref.sa_coef.size(), C2{f2_zero(), f2_zero()});
    for (size_t k = 1; k < ref.sa_coef.size(); ++k) {
        const CFexp& c = ref.sa_coef[k];
        ref.sa_coef2[k] = C2{c.re.m != 0.0 ? f2_from_pow10(c.re.m, c.re.e) : f2_zero(),
                             c.im.m != 0.0 ? f2_from_pow10(c.im.m, c.im.e) : f2_zero()};
    }
    if (ref.sa_order < 1) ref.sa_usable = false;

    /* Is the double path usable?  The pixel scale is the offset unit: once it
     * is below 1e-250 a few hundred terms of the perturbation would leave
     * double's exponent range, so the float-exp kernel keeps the frame. */
    ref.dbl_ok = log10_scale > -250.0;
    if (ref.dbl_ok) {
        ref.zr.resize((size_t)ref.len);
        ref.zi.resize((size_t)ref.len);
        for (int i = 0; i < ref.len; ++i) {
            ref.zr[(size_t)i] = f2_to_double(ref.z[(size_t)i].re);
            ref.zi[(size_t)i] = f2_to_double(ref.z[(size_t)i].im);
        }
        ref.sa_r.assign(ref.sa_coef2.size(), 0.0);
        ref.sa_i.assign(ref.sa_coef2.size(), 0.0);
        int last = 0;
        for (size_t k = 1; k < ref.sa_coef2.size(); ++k) {
            const double ar = f2_to_double(ref.sa_coef2[k].re);
            const double ai = f2_to_double(ref.sa_coef2[k].im);
            /* A term double cannot hold is a term whose contribution at this
             * depth is astronomically small (d0^k underflows long before), so
             * stopping the series there is exact, not an approximation.  An
             * inf would poison every pixel instead. */
            if (!std::isfinite(ar) || !std::isfinite(ai)) break;
            ref.sa_r[k] = ar;
            ref.sa_i[k] = ai;
            last = (int)k;
        }
        ref.sa_dbl_order = last;
        if (last == 0 && ref.sa_usable) ref.dbl_ok = false;
    }
    if (std::getenv("B2_DBL") && std::atoi(std::getenv("B2_DBL")) == 0) ref.dbl_ok = false;
}

bool build_reference(const View& v, int rdx, int rdy, int sa_order, const Fexp& delta_max,
                     int cap_steps, RefCache& ref, Orbit& orb) {
    /* The exact frame centre is the natural perturbation anchor, and the only
     * one whose critical orbit is EXACTLY periodic at a Misiurewicz point
     * (c=i repeats from z_2).  A pixel anchor sits half a pixel away, so its
     * orbit only looks periodic and the mpf_cmp test never fires.  Using the
     * centre lets orbit_gmp tile the tail analytically instead of squaring a
     * 60000-digit number 160000 times.  MB_CENTER_REF=0 keeps the pixel anchor. */
    const bool center_ref = !v.p->julia &&
        rdx == v.p->width / 2 && rdy == v.p->height / 2 &&
        !(std::getenv("MB_CENTER_REF") && std::atoi(std::getenv("MB_CENTER_REF")) == 0);
    BigFloat re, im;
    if (center_ref) { re = *v.p->cr; im = *v.p->ci; }
    else v.pixel_c(rdx, rdy, re, im);
    orb.digits = v.p->digits;
    std::string err;
    const int cap = std::max(1, std::min(v.p->maxiter, cap_steps));
    /* Always integrate the orbit WITHOUT coefficients; the series is replayed
     * over the stored z_n afterwards (see sa_replay).  This is what makes every
     * probe / repair / candidate orbit cost just one high-precision pass. */
    const int orb_order = sa_replay_enabled() ? 0 : sa_order;
    const bool ok = v.p->julia
                        ? compute_orbit_from(orb, re, im, *v.p->jr, *v.p->ji, cap,
                                             false, orb_order, delta_max, &err, true)
                        : compute_orbit(orb, re, im, cap, false, orb_order, delta_max, &err);
    if (!ok) return false;
    if (sa_replay_enabled() && sa_order > 0) sa_replay(orb, sa_order, delta_max);

    ref.rdx = rdx;
    ref.rdy = rdy;
    ref.anchor_x = center_ref ? (double)v.p->width * 0.5 - 0.5 : (double)rdx;
    ref.anchor_y = center_ref ? (double)v.p->height * 0.5 - 0.5 : (double)rdy;
    ref.periodic = orb.periodic;
    ref.len = (int)orb.z.size();
    ref.escaped = orb.escaped;
    /* A reference that stopped at the cap is not known to be interior. */
    ref.truncated = !orb.escaped && ref.len < v.p->maxiter;
    ref.z.resize((size_t)ref.len);
    ref.zabs2.resize((size_t)ref.len);
    for (int i = 0; i < ref.len; ++i) {
        const CFexp& zi = orb.z[(size_t)i];
        F2 re2{f2_zero()}, im2{f2_zero()};
        if (zi.re.m != 0.0) re2 = f2_from_pow10(zi.re.m, zi.re.e);
        if (zi.im.m != 0.0) im2 = f2_from_pow10(zi.im.m, zi.im.e);
        ref.z[(size_t)i] = C2{re2, im2};
        ref.zabs2[(size_t)i] = c2_abs2(ref.z[(size_t)i]);
    }
    apply_series(ref, orb, v.p->scale.log10_abs());
    return true;
}

// One pixel through whichever kernel this reference allows.
inline void render_pixel(const View& v, const RefCache& ref, int x, int y,
                         bool want_dist, const F2& scale2, PxResult& r) {
    if (ref.dbl_ok) {
        double dr = 0.0, di = 0.0;
        v.delta_d(x, y, ref.anchor_x, ref.anchor_y, dr, di);
        iterate_pixel_d(ref, dr, di, want_dist, v.p->scale.to_double(), r);
        return;
    }
    CFexp d0;
    C2 d2;
    v.delta(x, y, ref.anchor_x, ref.anchor_y, d0, d2);
    iterate_pixel(ref, d2, want_dist, scale2, r);
}

/* Is the four-wide kernel legal for this frame?  It needs the double path
 * (the float-exp kernel is a different beast) and no distance channel. */
inline bool quad_usable(const RefCache& ref, bool want_dist) {
#if defined(__AVX2__)
    return ref.dbl_ok && !want_dist;
#else
    (void)ref; (void)want_dist;
    return false;
#endif
}

#if defined(__AVX2__)
inline void render_quad(const View& v, const RefCache& ref, int x, int y,
                        long long& steps, PxResult* r) {
    double d0r[4], d0i[4];
    for (int k = 0; k < 4; ++k) v.delta_d(x + k, y, ref.anchor_x, ref.anchor_y, d0r[k], d0i[k]);
    iterate_quad_d(ref, d0r, d0i, r, steps);
}
#endif

template <typename Fn>
void parallel_range(int n, int threads, Fn fn) {
    if (n <= 0) return;
    if (threads < 2) { fn(0, n); return; }
    std::atomic<int> next{0};
    const int chunk = std::max(1, n / (threads * 8));
    auto body = [&]() {
        for (;;) {
            const int a = next.fetch_add(chunk);
            if (a >= n) break;
            fn(a, std::min(n, a + chunk));
        }
    };
    std::vector<std::thread> pool;
    pool.reserve((size_t)threads);
    for (int i = 0; i < threads; ++i) pool.emplace_back(body);
    for (auto& t : pool) t.join();
}

template <typename Fn>
void parallel_rows(int height, int threads, Fn fn) {
    if (threads < 2) { fn(0, height); return; }
    std::atomic<int> next{0};
    auto body = [&]() {
        for (;;) {
            const int y = next.fetch_add(1);
            if (y >= height) break;
            fn(y, y + 1);
        }
    };
    std::vector<std::thread> pool;
    pool.reserve((size_t)threads);
    for (int i = 0; i < threads; ++i) pool.emplace_back(body);
    for (auto& t : pool) t.join();
}

}  // namespace

void deep_render(const DeepParams& p, std::vector<PixelOut>& out, DeepStats* st) {
    DeepStats stats;
    if (p.width < 1 || p.height < 1) { out.clear(); if (st) *st = stats; return; }

    std::vector<PixelOut> px((size_t)p.width * p.height);
    if (const char* cb = getenv("B2_CANCEL")) g_cancel_bits = atoi(cb);
    if (const char* se = getenv("B2_SA_EPS")) sa_set_epsilon(atof(se));

    /* Experiment knobs.  They exist so a regression can be bisected from the
     * command line instead of by rebuilding with a different constant. */
    int ref_rounds = p.max_ref_rounds;
    int repair_rounds = p.max_repair_rounds;
    int sa_order_req = p.sa_order;
    int thread_req = p.threads;
    if (const char* r = getenv("B2_REF")) ref_rounds = atoi(r);
    if (const char* r = getenv("B2_REPAIR")) repair_rounds = atoi(r);
    if (const char* r = getenv("B2_SA")) sa_order_req = atoi(r);
    if (const char* r = getenv("B2_THREADS")) thread_req = atoi(r);

    View v{&p};
    /* The series costs O(order^2) per step of the reference orbit and saves
     * O(pixels) steps of the first pass.  Measured at 1e38 (1 922-step orbit):
     * order 8 -> 62 ms and order 16 -> 72 ms on a 426x240 preview, while on a
     * 1498x844 frame order 16 wins 263 ms against 316 ms.  So a preview gets
     * the cheaper orbit and a full frame gets the longer skip. */
    int sa_order = std::max(0, std::min(sa_order_req, 64));
    if (sa_order > 8 && (long long)p.width * p.height < 400000) sa_order = 8;
    /* The orbit stops the moment it escapes, so allowing the full iteration
     * budget costs nothing for an escaping reference and is *cheaper* than a
     * small cap that has to be rebuilt.  The old x4 ladder (4096 -> 16384 ->
     * 65536 -> maxiter) recomputed its own prefix three times; at 1e6000 that
     * was 54 303 mpf steps to produce a 33 821-step orbit.  Measured on the
     * same frame: 5.50 s with the ladder, 2.75 s with one full-budget orbit,
     * and the PNG is byte-identical.
     *
     * A reference that genuinely never escapes still stops at maxiter, and
     * because ref.truncated is false at that point the ladder correctly treats
     * the view as interior instead of guessing.  B2_REFCAP keeps the old
     * behaviour available for A/B runs. */
    int ref_cap = p.maxiter;
    bool ref_cap_fixed = false;
    if (const char* r = getenv("B2_REFCAP")) {
        ref_cap = std::max(1, std::min(p.maxiter, atoi(r)));
        ref_cap_fixed = true;
    }
    const Fexp delta_max = p.scale * Fexp(std::sqrt((double)p.width * p.width +
                                                    (double)p.height * p.height) * 0.5 + 1.0);
    const F2 scale2 = f2_from_pow10(p.scale.m, p.scale.e);

    const bool timing = std::getenv("B2_TIME") != nullptr;
    const auto t_ladder = std::chrono::steady_clock::now();
    /* Wall time spent inside build_reference, split off from the passes: at
     * 1e38 a single 89-digit orbit is a few milliseconds and the repair loop
     * used to build eight of them, so "how much of the frame is orbits" is the
     * number every decision here hinges on. */
    double build_ms = 0.0;
    int build_n = 0;
    double probe_ms = 0.0;

    // ---- 1. reference ladder -------------------------------------------------
    // A reference that escapes before the pixels do is the worst failure mode:
    // every pixel past its end collapses onto one iteration count, which is
    // exactly the "terraces" the frame showed.  Promote the longest-lived probe
    // to be the reference until nothing outlives it.
    const int threads = std::max(1, thread_req);
    RefCache ref;
    Orbit orb;
    int rdx = p.width / 2, rdy = p.height / 2;
    bool have_ref = false;
    bool built = false;      // ref already holds the anchor chosen last round
    std::atomic<bool> stopped{false};
    std::set<std::pair<int, int>> used;
    auto build = [&](int bx, int by, int order) {
        const auto t0 = std::chrono::steady_clock::now();
        const bool ok = build_reference(v, bx, by, order, delta_max, ref_cap, ref, orb);
        const double el = std::chrono::duration<double, std::milli>(
                              std::chrono::steady_clock::now() - t0).count();
        build_ms += el;
        ++build_n;
        if (timing) {
            std::fprintf(stderr, "[orbit] %6.1fms (%3d,%3d) sa=%d len=%d esc=%d trunc=%d\n", el,
                         bx, by, order, ref.len, (int)ref.escaped, (int)ref.truncated);
        }
        return ok;
    };
    /* Build several candidate orbits in parallel and keep the longest-lived.
     *
     * A single reference cannot cover a frame whose escapes are spread over
     * thousands of iterations, and that spread is the normal state of a deep
     * frame, not an accident: at 1e73 the pixels escape between 28 026 and
     * 39 815, so a reference anchored anywhere on the centre leaves most of the
     * frame running off its end.  The cure is more references -- but at 130
     * digits one 34 000-step orbit is ~200 ms of wall time, and building them
     * one at a time is exactly what made the deep frames take tens of seconds.
     *
     * Sixteen candidates cost one orbit's wall time on sixteen cores, so the
     * ladder can afford to *sample* the frame instead of guessing once.  Only
     * the orbit is built here (no series): the caller rebuilds the winner with
     * coefficients if it needs the skip. */
    std::vector<RefCache> cand_ref;
    std::vector<Orbit> cand_orb;
    auto build_best = [&](const std::vector<std::pair<int, int>>& pts, int order) -> int {
        const int n = (int)pts.size();
        if (n <= 0) return -1;
        const auto t_batch = std::chrono::steady_clock::now();
        cand_ref.assign((size_t)n, RefCache());
        cand_orb.assign((size_t)n, Orbit());
        std::vector<char> ok((size_t)n, 0);
        parallel_range(n, threads, [&](int a, int b) {
            for (int i = a; i < b; ++i) {
                ok[(size_t)i] = build_reference(v, pts[(size_t)i].first, pts[(size_t)i].second, order,
                                                delta_max, ref_cap, cand_ref[(size_t)i],
                                                cand_orb[(size_t)i]);
            }
        });
        int pick = -1, best_len = -1;
        for (int i = 0; i < n; ++i) {
            if (!ok[(size_t)i]) continue;
            if (cand_ref[(size_t)i].len > best_len) {
                best_len = cand_ref[(size_t)i].len;
                pick = i;
            }
        }
        if (pick < 0) return -1;
        ref = std::move(cand_ref[(size_t)pick]);
        orb = std::move(cand_orb[(size_t)pick]);
        ++build_n;
        /* Charged to the same counter as a single build so "[time] orbits="
         * stays honest: this path is where most of a deep frame's orbit time
         * goes, and leaving it out made the repair loop look pixel-bound. */
        build_ms += std::chrono::duration<double, std::milli>(
                        std::chrono::steady_clock::now() - t_batch).count();
        if (timing) {
            std::fprintf(stderr, "[orbit] best-of-%d (%3d,%3d) sa=%d len=%d esc=%d\n", n,
                         pts[(size_t)pick].first, pts[(size_t)pick].second, order, ref.len,
                         (int)ref.escaped);
        }
        return pick;
    };

    for (int round = 0; round < std::max(1, ref_rounds); ++round) {
        if (p.cancel && p.cancel->load(std::memory_order_relaxed)) {
            stopped.store(true, std::memory_order_relaxed);
            break;
        }
        /* Probe orbits are built WITHOUT the series.  The orbit itself does not
         * depend on the series -- only the per-pixel skip does, and the probes
         * do not use it.  Integrating the coefficients costs 6us/step against
         * 1.4us without, and the ladder builds one orbit per promotion round,
         * so this is most of the ladder's cost.  The reference the pass uses is
         * rebuilt with the series once the anchor stops moving. */
        for (;;) {
            if (built) break;   // build_best already left this anchor's orbit in ref
            if (!build(rdx, rdy, 0)) { have_ref = false; break; }
            ++stats.references;
            have_ref = true;
            if (ref.escaped || ref_cap_fixed || ref_cap >= p.maxiter) break;
            ref_cap = std::min(p.maxiter, ref_cap * 4);
        }
        built = false;
        if (!have_ref) break;
        used.insert({rdx, rdy});
        // Only a reference that ran the whole budget without escaping is known
        // to be interior; one that stopped at the step cap proves nothing.
        if (!ref.escaped && !ref.truncated) break;

        const int gx = 24, gy = 16;
        const auto t_probe = std::chrono::steady_clock::now();
        /* Probe in parallel: without the series each probe runs the whole
         * orbit, and 384 of them serially was 28 ms of a 90 ms ladder. */
        std::vector<std::pair<int, int>> pts;
        pts.reserve((size_t)gx * gy);
        for (int j = 0; j < gy; ++j) {
            for (int i = 0; i < gx; ++i) {
                int x = (int)(((double)i + 0.5) * (double)p.width / (double)gx);
                int y = (int)(((double)j + 0.5) * (double)p.height / (double)gy);
                pts.emplace_back(std::min(x, p.width - 1), std::min(y, p.height - 1));
            }
        }
        std::vector<int> pn(pts.size(), -1);
        parallel_range((int)pts.size(), threads, [&](int a, int b) {
            for (int i = a; i < b; ++i) {
                PxResult r;
                render_pixel(v, ref, pts[(size_t)i].first, pts[(size_t)i].second, false, scale2, r);
                pn[(size_t)i] = r.interior ? p.maxiter + 1 : (r.iter >= 0 ? r.iter : ref.len - 1);
            }
        });
        int best_n = -1;
        for (int q : pn) best_n = std::max(best_n, q);
        if (best_n < 0) break;
        probe_ms += std::chrono::duration<double, std::milli>(
                        std::chrono::steady_clock::now() - t_probe).count();
        if (best_n < ref.len - 2) break;                 // nothing outlives it

        /* Rank the probes by how far they got, then keep a *spread* of the
         * leaders.  Every pixel that ran off the end reports the same value, so
         * a plain top-K would hand back K copies of one corner and learn
         * nothing; requiring the candidates to sit apart is what makes the
         * sample represent the frame. */
        std::vector<int> rank(pts.size());
        for (size_t i = 0; i < rank.size(); ++i) rank[i] = (int)i;
        std::stable_sort(rank.begin(), rank.end(),
                         [&](int a, int b) { return pn[(size_t)a] > pn[(size_t)b]; });
        const int cand_cap = std::max(2, std::min(threads, 8));
        const int min_sep = std::max(4, std::min(p.width, p.height) / 12);
        std::vector<std::pair<int, int>> top;
        for (int i : rank) {
            if ((int)top.size() >= cand_cap) break;
            const std::pair<int, int> q = pts[(size_t)i];
            if (used.count(q)) continue;
            bool apart = true;
            for (const auto& t : top) {
                if (std::abs(t.first - q.first) < min_sep && std::abs(t.second - q.second) < min_sep) {
                    apart = false;
                    break;
                }
            }
            if (apart) top.push_back(q);
        }
        if (top.empty()) break;
        const int before = ref.len;
        const int pick = build_best(top, 0);
        /* Any longer orbit is worth having: stopping early to save a batch was
         * measured at 1e73 and made the frame 48% slower, because a shorter
         * primary reference sends far more pixels into the repair loop. */
        if (pick < 0 || ref.len <= before) break;
        rdx = top[(size_t)pick].first;
        rdy = top[(size_t)pick].second;
        used.insert({rdx, rdy});
        built = true;
    }
    /* The anchor has stopped moving.  Attach the series to the orbit we
     * already have instead of paying for a second full-precision pass.
     *
     * Only valid when ref/orb still belong to (rdx,rdy).  A build_best() batch
     * whose winner is rejected overwrote ref on its way out, and the old code's
     * unconditional rebuild silently restored the previous anchor; replaying
     * that stray orbit changes which pixels glitch (measured 7456 vs 5913 at
     * 1e73).  Keep the rebuild for that case, which costs nothing extra. */
    if (have_ref && sa_order > 0) {
        if (sa_replay_enabled() && ref.rdx == rdx && ref.rdy == rdy) {
            sa_replay(orb, sa_order, delta_max);
            apply_series(ref, orb, v.p->scale.log10_abs());
        } else {
            if (build(rdx, rdy, sa_order)) ++stats.references;
            else have_ref = false;
        }
    }
    stats.reference_len = ref.len;
    /* The pass's series skip, kept apart from the repair references, which are
     * built without coefficients and would otherwise report zero. */
    const int primary_sa_skip = ref.sa_usable ? ref.sa_skip : 0;
    const auto t_ladder_end = std::chrono::steady_clock::now();
    if (!have_ref) {
        out.assign((size_t)p.width * p.height, PixelOut());
        if (st) *st = stats;
        return;
    }

    // ---- 2. first pass ------------------------------------------------------
    /* The four-wide kernel is the whole point of the pass, so it is worth a
     * runtime switch for A/B runs: B2_SIMD=0 forces the scalar path and the
     * two frames then have to agree pixel for pixel. */
    bool simd = quad_usable(ref, p.use_distance);
    if (const char* e = getenv("B2_SIMD")) simd = simd && atoi(e) != 0;
    std::atomic<long long> total_steps{0};
    parallel_rows(p.height, threads, [&](int y0, int y1) {
        long long steps = 0;
        for (int y = y0; y < y1; ++y) {
            if (p.cancel && p.cancel->load(std::memory_order_relaxed)) {
                stopped.store(true, std::memory_order_relaxed);
                break;
            }
            int x = 0;
#if defined(__AVX2__)
            if (simd) {
                for (; x + 4 <= p.width; x += 4) {
                    PxResult r[4];
                    long long qs = 0;
                    render_quad(v, ref, x, y, qs, r);
                    steps += qs;
                    for (int k = 0; k < 4; ++k) {
                        PixelOut& o = px[(size_t)y * p.width + x + k];
                        o.iter = r[k].iter;
                        o.smooth = r[k].smooth;
                        o.dist = r[k].dist;
                        o.interior = r[k].interior;
                        o.glitch = r[k].glitch;
                        o.skipped = (r[k].glitch == 0 && ref.sa_usable) ? ref.sa_skip : 0;
                    }
                }
            }
#endif
            for (; x < p.width; ++x) {
                PxResult r;
                render_pixel(v, ref, x, y, p.use_distance, scale2, r);
                PixelOut& o = px[(size_t)y * p.width + x];
                o.iter = r.iter;
                o.smooth = r.smooth;
                o.dist = r.dist;
                o.interior = r.interior;
                o.glitch = r.glitch;
                o.skipped = (r.glitch == 0 && ref.sa_usable) ? ref.sa_skip : 0;
                steps += r.steps;
            }
        }
        total_steps.fetch_add(steps, std::memory_order_relaxed);
    });

    const auto t_pass = std::chrono::steady_clock::now();

    // ---- 3. glitch repair ---------------------------------------------------
    std::vector<int> bad;
    for (size_t i = 0; i < px.size(); ++i) {
        if (px[i].glitch) bad.push_back((int)i);
    }
    stats.glitches = (long long)bad.size();

    /* Where the damage sits.  One reference per glitch cluster is the whole
     * idea of a block-local reference, so the first question is whether the
     * glitches form a few clusters or lie all over the frame. */
    if (timing) {
        const int tw = 64, th = 64;
        const int gx = (p.width + tw - 1) / tw, gy = (p.height + th - 1) / th;
        std::vector<int> cell((size_t)gx * gy, 0);
        for (int idx : bad) {
            const int x = idx % p.width, y = idx / p.width;
            ++cell[(size_t)(y / th) * gx + (x / tw)];
        }
        int occupied = 0, biggest = 0;
        for (int c : cell) { if (c) ++occupied; biggest = std::max(biggest, c); }
        std::fprintf(stderr, "[map] %dx%d tiles, %d of %d carry glitches, largest=%d\n", gx, gy,
                     occupied, gx * gy, biggest);
        for (int j = 0; j < gy; ++j) {
            std::string line = "  ";
            for (int i = 0; i < gx; ++i) {
                const int c = cell[(size_t)j * gx + i];
                line += c == 0 ? '.' : (c < 10 ? (char)('0' + c) : (c < 100 ? '+' : '#'));
            }
            std::fprintf(stderr, "%s\n", line.c_str());
        }
    }

    int rounds = 0;
    while (!bad.empty() && rounds < repair_rounds) {
        if (p.cancel && p.cancel->load(std::memory_order_relaxed)) {
            stopped.store(true, std::memory_order_relaxed);
            break;
        }
        ++rounds;
        /* Repair anchors, sampled the same way as the ladder: take a spread of
         * the pixels that broke furthest and build up to eight orbits in
         * parallel, keeping the longest.  Picking one anchor per round is what
         * made a 1e76 frame spend five seconds rebuilding orbits -- twelve
         * serial 200 ms builds to cover a 400-iteration escape spread. */
        std::vector<int> rank(bad);
        std::stable_sort(rank.begin(), rank.end(), [&](int a, int b) {
            const int na = px[(size_t)a].glitch, nb = px[(size_t)b].glitch;
            return na != nb ? na > nb : a < b;
        });
        const int cand_cap = std::max(2, std::min(threads, 8));
        std::vector<std::pair<int, int>> top;
        const int min_sep = std::max(4, std::min(p.width, p.height) / 16);
        for (int idx : rank) {
            if ((int)top.size() >= cand_cap) break;
            const std::pair<int, int> q{idx % p.width, idx / p.width};
            if (used.count(q)) continue;
            bool apart = true;
            for (const auto& t : top) {
                if (std::abs(t.first - q.first) < min_sep && std::abs(t.second - q.second) < min_sep) {
                    apart = false;
                    break;
                }
            }
            if (apart) top.push_back(q);
        }
        if (top.empty()) break;
        /* Repair orbits carry no series: only the glitched pixels are
         * re-rendered, a few thousand at most, so running them the whole way
         * is cheaper than integrating coefficients for a fresh orbit. */
        const int pick = build_best(top, 0);
        if (pick < 0) break;
        ++stats.references;
        used.insert(top[(size_t)pick]);

        std::vector<char> dead(bad.size(), 0);
        /* The four-wide kernel does not care that these pixels are scattered:
         * it takes four perturbations, not four neighbours.  Repair is exactly
         * where that matters, because every round re-runs the whole orbit of
         * each unresolved pixel against a fresh reference. */
        const bool rsimd = quad_usable(ref, p.use_distance);
        parallel_range((int)bad.size(), threads, [&](int a, int b) {
            int i = a;
#if defined(__AVX2__)
            if (rsimd) {
                for (; i + 4 <= b; i += 4) {
                    int idx[4];
                    double d0r[4], d0i[4];
                    for (int k = 0; k < 4; ++k) {
                        idx[k] = bad[(size_t)(i + k)];
                        v.delta_d(idx[k] % p.width, idx[k] / p.width, ref.anchor_x, ref.anchor_y, d0r[k],
                                  d0i[k]);
                    }
                    PxResult r[4];
                    long long qs = 0;
                    iterate_quad_d(ref, d0r, d0i, r, qs);
                    for (int k = 0; k < 4; ++k) {
                        PixelOut& o = px[(size_t)idx[k]];
                        if (r[k].glitch) {
                            o.glitch = r[k].glitch;
                            dead[(size_t)(i + k)] = 0;
                        } else {
                            o.iter = r[k].iter;
                            o.smooth = r[k].smooth;
                            o.dist = r[k].dist;
                            o.interior = r[k].interior;
                            o.glitch = 0;
                            o.skipped = ref.sa_usable ? ref.sa_skip : 0;
                            dead[(size_t)(i + k)] = 1;
                        }
                    }
                }
            }
#endif
            for (; i < b; ++i) {
                const int idx = bad[(size_t)i];
                const int x = idx % p.width, y = idx / p.width;
                PxResult r;
                render_pixel(v, ref, x, y, p.use_distance, scale2, r);
                PixelOut& o = px[(size_t)idx];
                if (r.glitch) {
                    o.glitch = r.glitch;
                    dead[(size_t)i] = 0;
                } else {
                    o.iter = r.iter;
                    o.smooth = r.smooth;
                    o.dist = r.dist;
                    o.interior = r.interior;
                    o.glitch = 0;
                    o.skipped = ref.sa_usable ? ref.sa_skip : 0;
                    dead[(size_t)i] = 1;
                }
            }
        });
        std::vector<int> still;
        still.reserve(bad.size());
        for (size_t i = 0; i < bad.size(); ++i) {
            if (!dead[i]) still.push_back(bad[i]);
        }
        bad.swap(still);
    }
    const auto t_end = std::chrono::steady_clock::now();
    if (timing) {
        auto ms = [](auto a, auto b) {
            return std::chrono::duration<double, std::milli>(b - a).count();
        };
        std::fprintf(stderr,
                     "[time] ladder=%.1fms pass=%.1fms repair=%.1fms orbits=%.1fms/%d probes=%.1fms "
                     "refs=%d dbl=%d backend=%s\n",
                     ms(t_ladder, t_ladder_end), ms(t_ladder_end, t_pass), ms(t_pass, t_end),
                     build_ms, build_n, probe_ms, (int)stats.references, (int)ref.dbl_ok,
                     orbit_backend_name());
    }
    /* Whatever survived every repair round ran past the step cap without
     * escaping, which is what an interior point does.  Leaving them labelled
     * "escaped at -1" would paint them from a negative coordinate; calling
     * them interior is both the honest reading and the page's convention. */
    for (int idx : bad) {
        PixelOut& o = px[(size_t)idx];
        o.interior = true;
        o.iter = -1;
        o.smooth = -1.0;
        o.glitch = 0;
    }
    stats.rounds_used = rounds;
    stats.steps = total_steps.load();
    stats.sa_skip = primary_sa_skip;
    stats.cancelled = stopped.load();

    // The frame's own escape range.  A palette coordinate anchored on it is the
    // only one that survives depth: at 1e38 the whole picture spans 129
    // iterations out of 3000, so any fixed coordinate paints a sliver of one
    // ramp.  Interior pixels are excluded -- they never escape, by definition.
    int lo = std::numeric_limits<int>::max(), hi = 0;
    for (const PixelOut& q : px) {
        if (q.interior || q.iter < 0) continue;
        if (q.iter < lo) lo = q.iter;
        if (q.iter > hi) hi = q.iter;
    }
    if (hi > 0) { stats.esc_min = lo; stats.esc_max = hi; }

    out = std::move(px);
    if (st) *st = stats;
}
