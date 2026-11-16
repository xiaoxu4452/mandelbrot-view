// GMP seed: mpf arithmetic that the engine's high-precision path calls.
//
// __gmpf_add, __gmpf_set_ui and __gmpf_mul are imported from libgmp-10;
// mpf_hi / mpf_lo are the engine-authored bridges used by the
// double-precision preview path.
//
// Semantics reproduced here: destination precision truncates the result
// (towards zero), the destination may alias either source, and mpf_hi/mpf_lo
// split a value into its leading double plus a residual (the "hi + lo == v"
// decomposition the preview uses to keep an error bound).

#include "gmp.hpp"
#include "../port.hpp"
#include <cmath>

namespace mset::port::gmp {

namespace {
// Run an operation under the destination's precision budget, as mpf_set_prec
// would, and restore the caller's budget afterwards.
class BudgetGuard {
public:
    explicit BudgetGuard(int limbs) : saved_(BigFloat::precision_limbs) {
        BigFloat::precision_limbs = limbs > 0 ? limbs : 1;
    }
    ~BudgetGuard() { BigFloat::precision_limbs = saved_; }
private:
    int saved_;
};
}  // namespace

void gmpf_init(Mpf* x, long bits) { gmpf_init2(x, bits); }

void gmpf_init2(Mpf* x, long bits) {
    if (!x) return;
    x->v = BigFloat();
    x->limbs = bits > 0 ? (int)((bits + 29) / 30) : 1;
}

void gmpf_set_ui(Mpf* dst, unsigned long value) {
    if (!dst) return;
    BudgetGuard guard(dst->limbs);
    dst->v = BigFloat((int64_t)value);
    dst->v.truncate_to_precision();
}

void gmpf_set(Mpf* dst, const Mpf* src) {
    if (!dst || !src) return;
    dst->v = src->v;
    dst->v.truncate_to_precision();
}

void gmpf_add(Mpf* dst, const Mpf* a, const Mpf* b) {
    if (!dst || !a || !b) return;
    BudgetGuard guard(dst->limbs);
    BigFloat sum = a->v + b->v;
    sum.truncate_to_precision();
    dst->v = sum;
}

void gmpf_sub(Mpf* dst, const Mpf* a, const Mpf* b) {
    if (!dst || !a || !b) return;
    BudgetGuard guard(dst->limbs);
    BigFloat diff = a->v - b->v;
    diff.truncate_to_precision();
    dst->v = diff;
}

void gmpf_mul(Mpf* dst, const Mpf* a, const Mpf* b) {
    if (!dst || !a || !b) return;
    BudgetGuard guard(dst->limbs);
    BigFloat prod = a->v * b->v;
    prod.truncate_to_precision();
    dst->v = prod;
}

double mpf_hi(const Mpf* src) {
    if (!src) return 0.0;
    return src->v.to_double();
}

double mpf_lo(const Mpf* src) {
    if (!src) return 0.0;
    // Residual = value - round-to-double(value), evaluated at the value's own
    // precision so the sum hi + lo reproduces the leading two doubles.
    double hi = src->v.to_double();
    BigFloat hi_bf = BigFloat::from_double(hi);
    BigFloat residual = src->v - hi_bf;
    return residual.to_double();
}

void mpf_initload(Mpf* dst, const Fexp& src) {
    if (!dst) return;
    BudgetGuard guard(dst->limbs);
    dst->v = BigFloat::from_floatexp(src.m, src.e);
    dst->v.truncate_to_precision();
}

}  // namespace mset::port::gmp

MSET_COV_ENTRY(e_gmpf_add_0054b7b0, "0054b7b0", "__gmpf_add", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gmp::gmpf_add)
MSET_COV_ENTRY(e_gmpf_sub_0054b700, "0054b700", "__gmpf_sub", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gmp::gmpf_sub)
MSET_COV_ENTRY(e_gmpf_mul_0054b740, "0054b740", "__gmpf_mul", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gmp::gmpf_mul)
MSET_COV_ENTRY(e_gmpf_setui_0054b708, "0054b708", "__gmpf_set_ui", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gmp::gmpf_set_ui)
MSET_COV_ENTRY(e_mpf_hi_004f8470, "004f8470", "mpf_hi", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gmp::mpf_hi)
MSET_COV_ENTRY(e_mpf_lo_004f84e0, "004f84e0", "mpf_lo", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gmp::mpf_lo)
