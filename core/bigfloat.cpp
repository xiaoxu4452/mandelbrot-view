#include "bigfloat.hpp"

#include <algorithm>
#include <cassert>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

thread_local int BigFloat::precision_limbs = 128;

namespace {

int digits_in_limb(uint32_t v) {
    if (v >= 100000000u) return 9;
    if (v >= 10000000u) return 8;
    if (v >= 1000000u) return 7;
    if (v >= 100000u) return 6;
    if (v >= 10000u) return 5;
    if (v >= 1000u) return 4;
    if (v >= 100u) return 3;
    if (v >= 10u) return 2;
    return 1;
}

const uint32_t POW10[10] = {1u, 10u, 100u, 1000u, 10000u, 100000u,
                            1000000u, 10000000u, 100000000u, 1000000000u};

void add_mag_vec(std::vector<uint32_t>& a, const std::vector<uint32_t>& b) {
    if (b.size() > a.size()) a.resize(b.size(), 0);
    uint64_t carry = 0;
    size_t i = 0;
    for (; i < b.size(); ++i) {
        uint64_t cur = (uint64_t)a[i] + b[i] + carry;
        a[i] = (uint32_t)(cur % BigFloat::BASE);
        carry = cur / BigFloat::BASE;
    }
    while (carry && i < a.size()) {
        uint64_t cur = (uint64_t)a[i] + carry;
        a[i] = (uint32_t)(cur % BigFloat::BASE);
        carry = cur / BigFloat::BASE;
        ++i;
    }
    if (carry) a.push_back((uint32_t)carry);
}

// a >= b, both little-endian
std::vector<uint32_t> sub_mag_vec(const std::vector<uint32_t>& a,
                                  const std::vector<uint32_t>& b) {
    std::vector<uint32_t> r = a;
    int64_t borrow = 0;
    for (size_t i = 0; i < r.size(); ++i) {
        int64_t cur = (int64_t)r[i] - borrow - (i < b.size() ? (int64_t)b[i] : 0);
        if (cur < 0) {
            cur += (int64_t)BigFloat::BASE;
            borrow = 1;
        } else {
            borrow = 0;
        }
        r[i] = (uint32_t)cur;
    }
    while (!r.empty() && r.back() == 0) r.pop_back();
    return r;
}

std::vector<uint32_t> mul_school(const std::vector<uint32_t>& a,
                                 const std::vector<uint32_t>& b) {
    if (a.empty() || b.empty()) return {};
    std::vector<uint32_t> r(a.size() + b.size(), 0);
    for (size_t i = 0; i < a.size(); ++i) {
        uint64_t carry = 0;
        const uint64_t ai = a[i];
        for (size_t j = 0; j < b.size(); ++j) {
            uint64_t cur = (uint64_t)r[i + j] + carry + ai * b[j];
            r[i + j] = (uint32_t)(cur % BigFloat::BASE);
            carry = cur / BigFloat::BASE;
        }
        size_t k = i + b.size();
        while (carry) {
            uint64_t cur = (uint64_t)r[k] + carry;
            r[k] = (uint32_t)(cur % BigFloat::BASE);
            carry = cur / BigFloat::BASE;
            ++k;
        }
    }
    while (!r.empty() && r.back() == 0) r.pop_back();
    return r;
}

std::vector<uint32_t> add_vec(const std::vector<uint32_t>& a,
                              const std::vector<uint32_t>& b) {
    std::vector<uint32_t> r = a;
    add_mag_vec(r, b);
    return r;
}

std::vector<uint32_t> mul_karatsuba(const std::vector<uint32_t>& a,
                                    const std::vector<uint32_t>& b) {
    const size_t threshold = 32;
    if (a.empty() || b.empty()) return {};
    if (std::min(a.size(), b.size()) <= threshold) return mul_school(a, b);

    size_t n = std::max(a.size(), b.size());
    size_t m = n / 2;

    std::vector<uint32_t> a0, a1, b0, b1;
    a0.assign(a.begin(), a.begin() + std::min(m, a.size()));
    if (a.size() > m) a1.assign(a.begin() + m, a.end());
    b0.assign(b.begin(), b.begin() + std::min(m, b.size()));
    if (b.size() > m) b1.assign(b.begin() + m, b.end());

    auto z0 = mul_karatsuba(a0, b0);
    auto z2 = mul_karatsuba(a1, b1);
    auto z1 = mul_karatsuba(add_vec(a0, a1), add_vec(b0, b1));
    z1 = sub_mag_vec(z1, z0);
    z1 = sub_mag_vec(z1, z2);

    std::vector<uint32_t> r(n * 2 + 2, 0);
    auto add_shifted = [&](const std::vector<uint32_t>& v, size_t off) {
        if (v.empty()) return;
        if (r.size() < off + v.size()) r.resize(off + v.size(), 0);
        uint64_t carry = 0;
        size_t i = 0;
        for (; i < v.size(); ++i) {
            uint64_t cur = (uint64_t)r[off + i] + v[i] + carry;
            r[off + i] = (uint32_t)(cur % BigFloat::BASE);
            carry = cur / BigFloat::BASE;
        }
        size_t k = off + v.size();
        while (carry) {
            uint64_t cur = (uint64_t)r[k] + carry;
            r[k] = (uint32_t)(cur % BigFloat::BASE);
            carry = cur / BigFloat::BASE;
            ++k;
        }
    };
    add_shifted(z0, 0);
    add_shifted(z1, m);
    add_shifted(z2, 2 * m);

    while (!r.empty() && r.back() == 0) r.pop_back();
    return r;
}

}  // namespace

BigFloat::BigFloat(int64_t v) {
    if (v == 0) return;
    sign = v < 0 ? -1 : 1;
    uint64_t u = v < 0 ? (uint64_t)(-(v + 1)) + 1 : (uint64_t)v;
    while (u) {
        m.push_back((uint32_t)(u % BASE));
        u /= BASE;
    }
    s = 0;
    normalize();
}

BigFloat::BigFloat(double v) { *this = from_double(v); }

BigFloat BigFloat::from_string(const std::string& text) {
    BigFloat r;
    size_t begin = 0, end = text.size();
    while (begin < end && std::isspace((unsigned char)text[begin])) ++begin;
    while (end > begin && std::isspace((unsigned char)text[end - 1])) --end;
    if (begin == end) return r;

    size_t p = begin;
    int sgn = 1;
    if (text[p] == '+' || text[p] == '-') {
        if (text[p] == '-') sgn = -1;
        ++p;
    }

    std::string digits;
    int frac_digits = 0;
    bool seen_dot = false;
    bool any = false;
    for (; p < end; ++p) {
        char c = text[p];
        if (c == '.') {
            if (seen_dot) throw std::invalid_argument("BigFloat: two decimal points");
            seen_dot = true;
            continue;
        }
        if (c == 'e' || c == 'E') break;
        if (c >= '0' && c <= '9') {
            digits.push_back(c);
            if (seen_dot) ++frac_digits;
            any = true;
        } else if (c == '_' || c == '\'') {
            continue;
        } else {
            throw std::invalid_argument("BigFloat: invalid character in number");
        }
    }
    if (!any) throw std::invalid_argument("BigFloat: no digits");

    int64_t exp_part = 0;
    if (p < end && (text[p] == 'e' || text[p] == 'E')) {
        ++p;
        int esgn = 1;
        if (p < end && (text[p] == '+' || text[p] == '-')) {
            if (text[p] == '-') esgn = -1;
            ++p;
        }
        if (p >= end) throw std::invalid_argument("BigFloat: missing exponent");
        int64_t e = 0;
        for (; p < end; ++p) {
            char c = text[p];
            if (c < '0' || c > '9') throw std::invalid_argument("BigFloat: bad exponent");
            if (e > 1000000000000000LL) throw std::invalid_argument("BigFloat: exponent overflow");
            e = e * 10 + (c - '0');
        }
        exp_part = esgn * e;
    }

    // Strip leading zeros.  They do not change the integer value of `digits`.
    size_t first = 0;
    while (first < digits.size() && digits[first] == '0') ++first;
    if (first == digits.size()) return r;  // zero

    // Build limbs from the right in groups of nine decimal digits.
    size_t pos = digits.size();
    while (pos > first) {
        size_t take = std::min<size_t>(9, pos - first);
        size_t start = pos - take;
        uint32_t limb = 0;
        for (size_t i = start; i < pos; ++i) limb = limb * 10 + (uint32_t)(digits[i] - '0');
        r.m.push_back(limb);
        pos = start;
    }
    r.sign = sgn;
    r.s = exp_part - (int64_t)frac_digits;
    r.make_scale_multiple_of_nine();
    r.normalize();
    return r;
}

BigFloat BigFloat::from_double(double v) {
    if (!std::isfinite(v)) throw std::invalid_argument("BigFloat: non-finite double");
    if (v == 0.0) return BigFloat();
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return from_string(buf);
}

BigFloat BigFloat::from_floatexp(double mantissa, int64_t exp10) {
    if (mantissa == 0.0) return BigFloat();
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", mantissa);
    std::string s(buf);
    s += "e";
    s += std::to_string(exp10);
    return from_string(s);
}

void BigFloat::make_scale_multiple_of_nine() {
    if (m.empty()) { s = 0; return; }
    int rem = (int)(((s % 9) + 9) % 9);
    if (rem == 0) return;
    uint32_t mul = POW10[rem];
    uint64_t carry = 0;
    for (size_t i = 0; i < m.size(); ++i) {
        uint64_t cur = (uint64_t)m[i] * mul + carry;
        m[i] = (uint32_t)(cur % BASE);
        carry = cur / BASE;
    }
    if (carry) m.push_back((uint32_t)carry);
    s -= rem;
}

void BigFloat::trim_high() {
    while (!m.empty() && m.back() == 0) m.pop_back();
    if (m.empty()) { sign = 0; s = 0; }
}

void BigFloat::trim_low() {
    while (!m.empty() && m.front() == 0) {
        m.erase(m.begin());
        s += 9;
    }
    if (m.empty()) { sign = 0; s = 0; }
}

void BigFloat::truncate_to_precision() {
    if (precision_limbs < 1) precision_limbs = 1;
    while ((int)m.size() > precision_limbs) {
        m.erase(m.begin());
        s += 9;
    }
}

void BigFloat::normalize() {
    if (m.empty() || sign == 0) {
        sign = 0;
        m.clear();
        s = 0;
        return;
    }
    if (s % 9 != 0) make_scale_multiple_of_nine();
    trim_high();
    if (m.empty()) return;
    trim_low();
    if (m.empty()) return;
    truncate_to_precision();
    if (m.empty()) { sign = 0; s = 0; }
}

void BigFloat::to_floatexp(double& mantissa, int64_t& exp10) const {
    if (is_zero()) { mantissa = 0.0; exp10 = 0; return; }
    const int dt = digits_in_limb(m.back());
    /* Assemble as many leading limbs as a double can hold: the top limb carries
     * `dt` digits and each further limb nine more.  Reading only the top *two*
     * limbs -- which this used to do -- left every value whose leading digit is
     * 1 with just 10 significant digits (dt == 1 gives 1 + 9 = 10), and that
     * truncated mantissa went straight into the reference orbit.  Measured
     * against a 120-digit oracle at step 22 of the seahorse orbit: the reference
     * read -1.01996984799999990 instead of -1.01996984899423015. */
    double top = (double)m.back();
    double scale = 1.0;
    int have = dt;
    for (size_t i = m.size() - 1; i-- > 0 && have < 17;) {
        scale /= 1e9;
        top += (double)m[i] * scale;
        have += 9;
    }
    int d = dt;
    top /= (double)POW10[dt - 1];
    if (top >= 10.0) { top /= 10.0; ++d; }
    mantissa = (sign < 0 ? -top : top);
    exp10 = s + (int64_t)(9 * (m.size() - 1)) + (int64_t)(d - 1);
}

int64_t BigFloat::magnitude_exp10() const {
    if (is_zero()) return 0;
    return s + (int64_t)(9 * (m.size() - 1)) + (digits_in_limb(m.back()) - 1);
}

/* 10^k for integer k, without std::pow.
 *
 * This file is compiled into the desktop shell, whose CRT/libm mix returns
 * garbage for std::pow (pow(10,-3) came back as ~1.32).  Every deep-zoom
 * coordinate passes through to_double, so one bad pow turned the shallow CPU
 * path into a frame where every pixel escaped at iteration 1.  The literals are
 * exactly rounded and the loops only multiply or divide by ten. */
static double pow10_int(int64_t k) {
    static const double tab[23] = {
        1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
        1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};
    if (k >= 0) {
        if (k <= 22) return tab[k];
        double r = tab[22];
        for (int64_t i = 22; i < k; ++i) {
            r *= 10.0;
            if (!(r < 1e308)) return HUGE_VAL;
        }
        return r;
    }
    const int64_t n = -k;
    if (n <= 22) return 1.0 / tab[n];
    if (n > 330) return 0.0;
    double r = 1.0 / tab[22];
    for (int64_t i = 22; i < n; ++i) r /= 10.0;
    return r;
}

double BigFloat::to_double() const {
    if (is_zero()) return 0.0;
    int64_t exp10 = s + (int64_t)(9 * (m.size() - 1));
    double top = (double)m.back();
    if (m.size() >= 2) top += (double)m[m.size() - 2] * 1e-9;
    if (m.size() >= 3) top += (double)m[m.size() - 3] * 1e-18;
    double val = std::ldexp(top, 0);  // top is an integer <= 1e9
    // Scale by 10^exp10 without overflowing prematurely.
    if (exp10 > 308) return sign < 0 ? -HUGE_VAL : HUGE_VAL;
    if (exp10 < -340) return sign < 0 ? -0.0 : 0.0;
    // split exponent to stay inside double range
    const int64_t half = exp10 / 2;
    val = val * pow10_int(half) * pow10_int(exp10 - half);
    return sign < 0 ? -val : val;
}

std::string BigFloat::to_scientific(int max_digits) const {
    if (is_zero()) return "0";
    if (max_digits < 1) max_digits = 1;
    int64_t exp10 = magnitude_exp10();

    // Collect at most max_digits significant decimal digits, most significant first.
    std::string digits;
    digits.reserve((size_t)max_digits);
    bool started = false;
    for (size_t i = m.size(); i-- > 0;) {
        char buf[10];
        if (i == m.size() - 1) {
            std::snprintf(buf, sizeof(buf), "%u", (unsigned)m[i]);
        } else {
            std::snprintf(buf, sizeof(buf), "%09u", (unsigned)m[i]);
        }
        for (const char* p = buf; *p && (int)digits.size() < max_digits; ++p) {
            if (!started && *p == '0' && i == m.size() - 1) continue;
            started = true;
            digits.push_back(*p);
        }
        if ((int)digits.size() >= max_digits) break;
    }
    if (digits.empty()) digits = "0";

    std::string out;
    if (sign < 0) out += '-';
    out += digits[0];
    if (digits.size() > 1) {
        out += '.';
        out += digits.substr(1);
    }
    out += 'e';
    out += std::to_string(exp10);
    return out;
}

std::string BigFloat::to_fixed(int decimals) const {
    // Small-range helper intended for CLI/debug output.  For huge magnitudes
    // callers should use to_scientific().
    if (is_zero()) return "0";
    if (magnitude_exp10() > 1000 || magnitude_exp10() < -1000) {
        return to_scientific(decimals + 20);
    }
    if (decimals < 0) decimals = 0;
    // Render the integer part plus `decimals` fractional digits by digit query.
    auto digit_at = [&](int64_t pos) -> int {
        if (pos < s) return 0;
        uint64_t idx = (uint64_t)((pos - s) / 9);
        if (idx >= m.size()) return 0;
        int rem = (int)((pos - s) % 9);
        return (int)((m[(size_t)idx] / POW10[rem]) % 10);
    };
    std::string out;
    if (sign < 0) out += '-';
    int64_t highest = magnitude_exp10();
    if (highest < 0) out += '0';
    else for (int64_t p = highest; p >= 0; --p) out += char('0' + digit_at(p));
    if (decimals > 0) {
        out += '.';
        for (int64_t p = -1; p >= -(int64_t)decimals; --p) out += char('0' + digit_at(p));
    }
    return out;
}

BigFloat BigFloat::operator-() const {
    BigFloat r = *this;
    r.sign = -r.sign;
    return r;
}

BigFloat BigFloat::abs() const {
    BigFloat r = *this;
    if (r.sign < 0) r.sign = 1;
    return r;
}

BigFloat BigFloat::add(const BigFloat& other) const {
    if (is_zero()) return other;
    if (other.is_zero()) return *this;
    if (sign == other.sign) {
        // Magnitude addition.
        int64_t s0 = std::min(s, other.s);
        size_t q1 = (size_t)((s - s0) / 9);
        size_t q2 = (size_t)((other.s - s0) / 9);
        size_t n = std::max(m.size() + q1, other.m.size() + q2);
        std::vector<uint32_t> r(n, 0);
        for (size_t i = 0; i < m.size(); ++i) r[i + q1] = m[i];
        for (size_t i = 0; i < other.m.size(); ++i) {
            uint64_t cur = (uint64_t)r[i + q2] + other.m[i];
            r[i + q2] = (uint32_t)(cur % BASE);
            uint64_t carry = cur / BASE;
            size_t k = i + q2 + 1;
            while (carry) {
                if (k >= r.size()) r.push_back(0);
                cur = (uint64_t)r[k] + carry;
                r[k] = (uint32_t)(cur % BASE);
                carry = cur / BASE;
                ++k;
            }
        }
        BigFloat out;
        out.sign = sign;
        out.m = std::move(r);
        out.s = s0;
        out.normalize();
        return out;
    }

    int cmp = compare_abs(other);
    if (cmp == 0) return BigFloat();
    const BigFloat& larger = cmp > 0 ? *this : other;
    const BigFloat& smaller = cmp > 0 ? other : *this;
    int64_t s0 = std::min(larger.s, smaller.s);
    size_t q1 = (size_t)((larger.s - s0) / 9);
    size_t q2 = (size_t)((smaller.s - s0) / 9);
    std::vector<uint32_t> r(std::max(larger.m.size() + q1, smaller.m.size() + q2), 0);
    for (size_t i = 0; i < larger.m.size(); ++i) r[i + q1] = larger.m[i];
    int64_t borrow = 0;
    for (size_t i = 0; i < r.size(); ++i) {
        int64_t sub = (i >= q2 && i - q2 < smaller.m.size()) ? (int64_t)smaller.m[i - q2] : 0;
        int64_t cur = (int64_t)r[i] - borrow - sub;
        if (cur < 0) { cur += BASE; borrow = 1; } else borrow = 0;
        r[i] = (uint32_t)cur;
    }
    BigFloat out;
    out.sign = larger.sign;
    out.m = std::move(r);
    out.s = s0;
    out.normalize();
    return out;
}

BigFloat BigFloat::sub(const BigFloat& other) const { return add(-other); }

BigFloat BigFloat::mul(const BigFloat& other) const {
    if (is_zero() || other.is_zero()) return BigFloat();
    BigFloat out;
    out.sign = sign * other.sign;
    out.m = mul_karatsuba(m, other.m);
    out.s = s + other.s;
    out.normalize();
    return out;
}

BigFloat BigFloat::mul_ui(uint32_t k) const {
    if (k == 0 || is_zero()) return BigFloat();
    BigFloat out = *this;
    uint64_t carry = 0;
    for (size_t i = 0; i < out.m.size(); ++i) {
        uint64_t cur = (uint64_t)out.m[i] * k + carry;
        out.m[i] = (uint32_t)(cur % BASE);
        carry = cur / BASE;
    }
    if (carry) out.m.push_back((uint32_t)carry);
    out.normalize();
    return out;
}

int BigFloat::compare_abs(const BigFloat& other) const {
    if (is_zero()) return other.is_zero() ? 0 : -1;
    if (other.is_zero()) return 1;
    int64_t ea = magnitude_exp10();
    int64_t eb = other.magnitude_exp10();
    if (ea != eb) return ea > eb ? 1 : -1;

    int64_t common = std::min(s, other.s);
    size_t qa = (size_t)((s - common) / 9);
    size_t qb = (size_t)((other.s - common) / 9);
    size_t n = std::max(m.size() + qa, other.m.size() + qb);
    for (size_t idx = n; idx-- > 0;) {
        uint32_t da = (idx >= qa && idx - qa < m.size()) ? m[idx - qa] : 0;
        uint32_t db = (idx >= qb && idx - qb < other.m.size()) ? other.m[idx - qb] : 0;
        if (da != db) return da > db ? 1 : -1;
    }
    return 0;
}

int BigFloat::compare(const BigFloat& other) const {
    if (sign != other.sign) return sign < other.sign ? -1 : 1;
    if (sign == 0) return 0;
    int c = compare_abs(other);
    return sign > 0 ? c : -c;
}

BigFloat operator+(const BigFloat& a, const BigFloat& b) { return a.add(b); }
BigFloat operator-(const BigFloat& a, const BigFloat& b) { return a.sub(b); }
BigFloat operator*(const BigFloat& a, const BigFloat& b) { return a.mul(b); }

bool operator==(const BigFloat& a, const BigFloat& b) { return a.compare(b) == 0; }
bool operator<(const BigFloat& a, const BigFloat& b) { return a.compare(b) < 0; }
