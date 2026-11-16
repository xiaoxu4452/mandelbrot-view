// bigmath.cpp — see bigmath.hpp.
#include "bigmath.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace bm {
namespace {

int guard_limbs() { return BigFloat::precision_limbs + 2; }

int digits_now() { return BigFloat::precision_limbs * BigFloat::LIMB_DIGITS; }

bool tiny(const BigFloat& a) {
    return a.is_zero() || a.magnitude_exp10() < -(digits_now() + 8);
}

BigFloat two() { return BigFloat((int64_t)2); }

/* value * 10^e, exactly, with the scale invariant restored by normalize(). */
BigFloat shift10(const BigFloat& a, int64_t e) {
    BigFloat r = a;
    r.s += e;
    r.normalize();
    return r;
}

BigFloat sqrt_seed(const BigFloat& a) {
    double mant = 0.0;
    int64_t e10 = 0;
    a.to_floatexp(mant, e10);
    int64_t e2 = e10 / 2;
    if (e10 < 0 && (e10 % 2) != 0) e2 -= 1;   // floor division
    const bool odd = (e10 - 2 * e2) != 0;
    const double m2 = odd ? mant * 10.0 : mant;
    BigFloat y = BigFloat::from_double(std::sqrt(m2));
    return shift10(y, e2);
}

/* atanh series for log of m in (0, 2): log(m) = 2*(t + t^3/3 + ...),
 * t = (m-1)/(m+1). */
BigFloat log_near_one(const BigFloat& m) {
    const BigFloat one((int64_t)1);
    BigFloat t = div(m.sub(one), m.add(one));
    if (t.is_zero()) return BigFloat();
    BigFloat t2 = t.mul(t);
    BigFloat term = t;
    BigFloat sum = t;
    for (int j = 3; j < 4000; j += 2) {
        term = term.mul(t2);
        const BigFloat add = div_ui(term, (uint32_t)j);
        sum = sum.add(add);
        if (tiny(add)) break;
    }
    return sum.mul_ui(2);
}

BigFloat atan_series_small(const BigFloat& x) {
    BigFloat x2 = x.mul(x);
    BigFloat term = x;
    BigFloat sum = x;
    for (int j = 3; j < 4000; j += 2) {
        term = term.mul(x2);
        BigFloat add = div_ui(term, (uint32_t)j);
        if ((j & 3) == 3) add = -add;
        sum = sum.add(add);
        if (tiny(add)) break;
    }
    return sum;
}

}  // namespace

ScopedPrecision::ScopedPrecision(int limbs) {
    saved = BigFloat::precision_limbs;
    if (limbs < 1) limbs = 1;
    BigFloat::precision_limbs = limbs;
}

ScopedPrecision::~ScopedPrecision() { BigFloat::precision_limbs = saved; }

BigFloat from_int(int64_t v) { return BigFloat(v); }
BigFloat from_double(double v) { return BigFloat::from_double(v); }
bool is_zero(const BigFloat& a) { return a.is_zero(); }
bool is_negative(const BigFloat& a) { return a.sign < 0; }
int cmp(const BigFloat& a, const BigFloat& b) { return a.compare(b); }
BigFloat abs(const BigFloat& a) { return a.abs(); }
BigFloat scale_pow10(const BigFloat& a, int64_t exp10) { return shift10(a, exp10); }

BigFloat div_ui(const BigFloat& a, uint32_t k) {
    if (k == 0 || a.is_zero()) return BigFloat();
    /* Long division with fractional limbs.  THE remainder must keep going:
     * stopping at the integer part turned 1/2 into 0, which made every series
     * term vanish and exp(1) return exactly 1. */
    std::vector<uint32_t> q;          // most significant first
    q.reserve(a.m.size() + 4);
    uint64_t rem = 0;
    for (int i = (int)a.m.size() - 1; i >= 0; --i) {
        const uint64_t cur = rem * (uint64_t)BigFloat::BASE + a.m[(size_t)i];
        q.push_back((uint32_t)(cur / k));
        rem = cur % k;
    }
    int64_t scale = a.s;
    const int limit = BigFloat::precision_limbs + 2;
    while (rem != 0 && (int)q.size() < limit) {
        rem *= (uint64_t)BigFloat::BASE;
        q.push_back((uint32_t)(rem / k));
        rem %= k;
        scale -= BigFloat::LIMB_DIGITS;
    }
    BigFloat out;
    out.sign = a.sign;
    out.s = scale;
    out.m.assign(q.rbegin(), q.rend());
    out.normalize();
    return out;
}

BigFloat recip(const BigFloat& b) {
    if (b.is_zero()) return BigFloat();
    const int saved = BigFloat::precision_limbs;
    const int target = saved + 2;
    double mant = 0.0;
    int64_t e10 = 0;
    b.to_floatexp(mant, e10);
    if (mant == 0.0) return BigFloat();
    BigFloat r = BigFloat::from_double(1.0 / mant);
    r = shift10(r, -e10);
    int p = 2;
    while (true) {
        BigFloat::precision_limbs = p;
        BigFloat br = b.mul(r);
        BigFloat corr = two().sub(br);
        r = r.mul(corr);
        if (p >= target) break;
        p *= 2;
        if (p > target) p = target;
    }
    BigFloat::precision_limbs = saved;
    r.truncate_to_precision();
    return r;
}

BigFloat div(const BigFloat& a, const BigFloat& b) {
    if (a.is_zero()) return BigFloat();
    if (b.is_zero()) return BigFloat();
    const int saved = BigFloat::precision_limbs;
    const int target = saved + 2;
    BigFloat::precision_limbs = target;
    BigFloat r = recip(b);
    BigFloat q = a.mul(r);
    BigFloat::precision_limbs = saved;
    q.truncate_to_precision();
    return q;
}

BigFloat sqrt(const BigFloat& a) {
    if (a.sign <= 0) return BigFloat();
    const int saved = BigFloat::precision_limbs;
    const int target = saved + 2;
    BigFloat y = sqrt_seed(a);
    int p = 4;
    while (true) {
        BigFloat::precision_limbs = p;
        BigFloat q = div(a, y);
        BigFloat next = div_ui(y.add(q), 2);
        y = next;
        if (p >= target) break;
        p *= 2;
        if (p > target) p = target;
    }
    BigFloat::precision_limbs = saved;
    y.truncate_to_precision();
    return y;
}

BigFloat exp(const BigFloat& a) {
    if (a.is_zero()) return BigFloat((int64_t)1);
    const int saved = BigFloat::precision_limbs;
    const int target = saved + 2;
    BigFloat::precision_limbs = target;
    const double ad = std::fabs(a.to_double());
    /* Clamp: exp(1e5) already has a 43430-digit exponent, far beyond any
     * escape radius.  Returning the clamp keeps the evaluator total. */
    if (!(ad < 1e5)) {
        BigFloat out = BigFloat((int64_t)10);
        out.s += 43429;
        out.normalize();
        if (a.sign < 0) out = recip(out);
        BigFloat::precision_limbs = saved;
        out.truncate_to_precision();
        return out;
    }
    int m = 0;
    double scaled = ad;
    while (scaled > 0.5) { scaled *= 0.5; ++m; }
    BigFloat y = a;
    for (int i = 0; i < m; ++i) y = div_ui(y, 2);

    BigFloat sum((int64_t)1), term((int64_t)1);
    for (int k = 1; k < 200000; ++k) {
        term = div_ui(term.mul(y), (uint32_t)k);
        sum = sum.add(term);
        if (tiny(term)) break;
    }
    for (int i = 0; i < m; ++i) sum = sum.mul(sum);
    BigFloat::precision_limbs = saved;
    sum.truncate_to_precision();
    return sum;
}

BigFloat ln10() {
    static thread_local BigFloat cached;
    static thread_local int cached_at = -1;
    const int p = BigFloat::precision_limbs;
    if (cached_at == p) return cached;
    ScopedPrecision g(p + 4);
    BigFloat ten((int64_t)10);
    BigFloat m = sqrt(ten);
    int k = 1;
    while (m.to_double() > 1.02 && k < 40) {
        m = sqrt(m);
        ++k;
    }
    BigFloat v = log_near_one(m);
    for (int i = 0; i < k; ++i) v = v.mul_ui(2);
    v.truncate_to_precision();
    cached = v;
    cached_at = p;
    return cached;
}

BigFloat log(const BigFloat& a) {
    if (a.sign <= 0) return BigFloat();
    const int saved = BigFloat::precision_limbs;
    const int target = saved + 2;
    BigFloat::precision_limbs = target;
    double mant = 0.0;
    int64_t e10 = 0;
    a.to_floatexp(mant, e10);
    BigFloat m = shift10(a, -e10);          // [1, 10)
    int k = 0;
    while (m.to_double() > 1.02 && k < 80) {
        m = sqrt(m);
        ++k;
    }
    BigFloat v = log_near_one(m);
    for (int i = 0; i < k; ++i) v = v.mul_ui(2);
    if (e10 != 0) {
        BigFloat e = BigFloat::from_double((double)e10);
        v = v.add(e.mul(ln10()));
    }
    BigFloat::precision_limbs = saved;
    v.truncate_to_precision();
    return v;
}

BigFloat pi() {
    static thread_local BigFloat cached;
    static thread_local int cached_at = -1;
    const int p = BigFloat::precision_limbs;
    if (cached_at == p) return cached;
    ScopedPrecision g(p + 4);
    /* Machin: pi = 16 atan(1/5) - 4 atan(1/239). */
    BigFloat a = atan_series_small(div(BigFloat((int64_t)1), BigFloat((int64_t)5)));
    BigFloat b = atan_series_small(div(BigFloat((int64_t)1), BigFloat((int64_t)239)));
    BigFloat v = a.mul_ui(16).sub(b.mul_ui(4));
    v.truncate_to_precision();
    cached = v;
    cached_at = p;
    return cached;
}

BigFloat sin(const BigFloat& a) {
    if (a.is_zero()) return BigFloat();
    const int saved = BigFloat::precision_limbs;
    BigFloat::precision_limbs = saved + 2;
    BigFloat x = a;
    const BigFloat half(0.5);
    if (half.compare(x.abs()) < 0) {
        BigFloat tp = pi().mul_ui(2);
        BigFloat q = trunc(div(x, tp));
        if (!q.is_zero()) x = x.sub(q.mul(tp));
    }
    BigFloat x2 = x.mul(x);
    BigFloat term = x;
    BigFloat sum = x;
    for (int k = 1; k < 20000; ++k) {
        const uint32_t d = (uint32_t)((uint64_t)(2 * k) * (uint64_t)(2 * k + 1));
        term = div_ui(term.mul(x2), (uint32_t)d);
        term = -term;
        sum = sum.add(term);
        if (tiny(term)) break;
    }
    BigFloat::precision_limbs = saved;
    sum.truncate_to_precision();
    return sum;
}

BigFloat cos(const BigFloat& a) {
    const int saved = BigFloat::precision_limbs;
    BigFloat::precision_limbs = saved + 2;
    BigFloat x = a;
    if (BigFloat(0.5).compare(x.abs()) < 0) {
        BigFloat tp = pi().mul_ui(2);
        BigFloat q = trunc(div(x, tp));
        if (!q.is_zero()) x = x.sub(q.mul(tp));
    }
    BigFloat x2 = x.mul(x);
    BigFloat term((int64_t)1);
    BigFloat sum((int64_t)1);
    for (int k = 1; k < 20000; ++k) {
        const uint32_t d = (uint32_t)((uint64_t)(2 * k - 1) * (uint64_t)(2 * k));
        term = div_ui(term.mul(x2), (uint32_t)d);
        term = -term;
        sum = sum.add(term);
        if (tiny(term)) break;
    }
    BigFloat::precision_limbs = saved;
    sum.truncate_to_precision();
    return sum;
}

BigFloat atan(const BigFloat& a) {
    if (a.is_zero()) return BigFloat();
    const int saved = BigFloat::precision_limbs;
    BigFloat::precision_limbs = saved + 2;
    int sign = 1;
    BigFloat x = a;
    if (x.sign < 0) { x = -x; sign = -1; }
    bool invert = false;
    if (BigFloat((int64_t)1).compare(x) < 0) {
        x = div(BigFloat((int64_t)1), x);
        invert = true;
    }
    int halvings = 0;
    while (BigFloat::from_string("0.05").compare(x) < 0 && halvings < 40) {
        /* atan(x) = 2 atan(x / (1 + sqrt(1+x^2))) */
        BigFloat s = sqrt(BigFloat((int64_t)1).add(x.mul(x)));
        x = div(x, BigFloat((int64_t)1).add(s));
        ++halvings;
    }
    BigFloat v = atan_series_small(x);
    for (int i = 0; i < halvings; ++i) v = v.mul_ui(2);
    if (invert) v = div_ui(pi(), 2).sub(v);        // pi/2 - atan(1/x)
    if (sign < 0) v = -v;
    BigFloat::precision_limbs = saved;
    v.truncate_to_precision();
    return v;
}

BigFloat atan2(const BigFloat& y, const BigFloat& x) {
    if (x.is_zero()) {
        if (y.is_zero()) return BigFloat();
        BigFloat half = div_ui(pi(), 2);
        return y.sign < 0 ? -half : half;
    }
    BigFloat r = atan(div(y, x));
    if (x.sign > 0) return r;
    BigFloat p = pi();
    return y.sign < 0 ? r.sub(p) : r.add(p);
}

BigFloat powi(const BigFloat& a, int64_t n) {
    if (n == 0) return BigFloat((int64_t)1);
    uint64_t e = (uint64_t)(n < 0 ? -n : n);
    BigFloat base = a;
    BigFloat r((int64_t)1);
    while (e) {
        if (e & 1) r = r.mul(base);
        e >>= 1;
        if (e) base = base.mul(base);
    }
    if (n < 0) return recip(r);
    return r;
}

BigFloat pow(const BigFloat& a, const BigFloat& b) {
    if (b.is_zero()) return BigFloat((int64_t)1);
    BigFloat bi = trunc(b);
    if (bi.compare(b) == 0) {
        const int64_t n = to_int64(b);
        if (n >= -1000000 && n <= 1000000) return powi(a, n);
    }
    if (a.sign <= 0) return BigFloat();
    return exp(b.mul(log(a)));
}

BigFloat trunc(const BigFloat& a) {
    if (a.is_zero()) return BigFloat();
    if (a.s >= 0) return a;
    const size_t drop = (size_t)((-a.s) / BigFloat::LIMB_DIGITS);
    if (drop >= a.m.size()) return BigFloat();
    BigFloat r;
    r.sign = a.sign;
    r.m.assign(a.m.begin() + (long)drop, a.m.end());
    r.s = 0;
    r.normalize();
    return r;
}

BigFloat floor(const BigFloat& a) {
    BigFloat t = trunc(a);
    if (a.sign < 0 && t.compare(a) != 0) return t.sub(BigFloat((int64_t)1));
    return t;
}

int64_t to_int64(const BigFloat& a) {
    const double d = a.to_double();
    if (!(d > -9.2e18 && d < 9.2e18)) return d < 0 ? INT64_MIN : INT64_MAX;
    return (int64_t)d;
}

}  // namespace bm
