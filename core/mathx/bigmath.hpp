// ---------------------------------------------------------------------------
// bigmath.hpp — the elementary-function layer on top of BigFloat.
//
// BigFloat carries +, -, * and a decimal exponent; that is enough for z^2+c
// and for reference orbits of polynomial maps, but not for a formula such as
// "sin(z)^2 + exp(-z*c)".  This header adds division, square root, exp, log,
// sin/cos, atan and pow at arbitrary precision, plus the small set of
// helpers a numeric core wants (floor, trunc, int conversion).
//
// All functions are total: division by zero returns zero, log of a
// non-positive value returns zero, exp clamps its argument.  A fractal
// iteration must not throw on a single bad pixel; the escape test does the
// classification.  Callers that need domain errors can check the arguments.
//
// Precision is the thread-local BigFloat::precision_limbs.  Every routine
// computes with two guard limbs and truncates on the way out, matching the
// truncating arithmetic of BigFloat itself.
// ---------------------------------------------------------------------------
#pragma once

#include "bigfloat.hpp"

#include <cstdint>

namespace bm {

using ::BigFloat;

// RAII guard for the thread-local limb budget.
struct ScopedPrecision {
    int saved;
    explicit ScopedPrecision(int limbs);
    ~ScopedPrecision();
};

BigFloat from_int(int64_t v);
BigFloat from_double(double v);
bool is_zero(const BigFloat& a);
bool is_negative(const BigFloat& a);
int cmp(const BigFloat& a, const BigFloat& b);
BigFloat abs(const BigFloat& a);
BigFloat scale_pow10(const BigFloat& a, int64_t exp10);

BigFloat div_ui(const BigFloat& a, uint32_t k);
BigFloat div(const BigFloat& a, const BigFloat& b);
BigFloat recip(const BigFloat& b);
BigFloat sqrt(const BigFloat& a);

BigFloat exp(const BigFloat& a);
BigFloat log(const BigFloat& a);
BigFloat sin(const BigFloat& a);
BigFloat cos(const BigFloat& a);
BigFloat atan(const BigFloat& a);
BigFloat atan2(const BigFloat& y, const BigFloat& x);
BigFloat pow(const BigFloat& a, const BigFloat& b);
BigFloat powi(const BigFloat& a, int64_t n);

BigFloat floor(const BigFloat& a);
BigFloat trunc(const BigFloat& a);
int64_t to_int64(const BigFloat& a);

BigFloat pi();
BigFloat ln10();

}  // namespace bm
