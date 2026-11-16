// GMP mpf equivalent layer.
//
// The reference engine links libgmp-10 and uses only the mpf (multi-precision
// float) entry points, plus four HFLOAT<->mpf bridge helpers derived from
// the engine (mpf_store / mpf_load / mpf_hi / mpf_lo).  Our BigFloat already
// provides base-10^9 limbs, so the bridge is:
//
//   mpf_t  ->  { BigFloat value, precision in limbs }
//   prec   ->  the limb budget used for the operation (BigFloat::precision_limbs)
//   store/load -> convert the engine's HFLOAT (Fexp) to/from mpf
//
// The four arithmetic entry points keep GMP's aliasing rule (destination may
// alias either operand), its rounding (towards zero, truncated to the
// destination precision) and its return conventions.
//
// Register every row with MSET_COV_ENTRY.

#pragma once

#include "bigfloat.hpp"
#include "floatexp.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace mset::port::gmp {

struct Mpf {
    BigFloat v;
    int limbs = 16;  // destination precision, in base-10^9 limbs
};

// __gmpf_* --- what libgmp exports under the __gmpf_ prefix.
void gmpf_init(Mpf* x, long bits);
void gmpf_init2(Mpf* x, long bits);
void gmpf_clear(Mpf* x);
void gmpf_set(Mpf* dst, const Mpf* src);
void gmpf_set_ui(Mpf* dst, unsigned long value);
void gmpf_set_d(Mpf* dst, double value);
int  gmpf_set_str(Mpf* dst, const char* text, int base);
void gmpf_add(Mpf* dst, const Mpf* a, const Mpf* b);
void gmpf_sub(Mpf* dst, const Mpf* a, const Mpf* b);
void gmpf_mul(Mpf* dst, const Mpf* a, const Mpf* b);
void gmpf_div(Mpf* dst, const Mpf* a, const Mpf* b);   // own long division
void gmpf_add_ui(Mpf* dst, const Mpf* a, unsigned long v);
void gmpf_mul_2exp(Mpf* dst, const Mpf* a, unsigned long bits);
void gmpf_div_2exp(Mpf* dst, const Mpf* a, unsigned long bits);
int  gmpf_cmp_ui(const Mpf* a, unsigned long v);
int  gmpf_cmp_si(const Mpf* a, long v);
double gmpf_get_d(const Mpf* a);
double gmpf_get_d_2exp(long* exp2, const Mpf* a);
std::string gmpf_get_str(const Mpf* a, int base, std::size_t digits);
long gmpf_get_prec(const Mpf* a);
void gmpf_set_prec(Mpf* a, long bits);
void gmpf_set_prec_raw(Mpf* a, long bits);
void gmpf_clears(Mpf* first, ...);   // variadic clear list

// Engine bridge: HFLOAT (Fexp) storage in an mpf.
void mpf_store(Mpf* dst, const Fexp& src);
Fexp mpf_load(const Mpf* src);
double mpf_hi(const Mpf* src);   // leading double of the value
double mpf_lo(const Mpf* src);   // residual after subtracting the leading double
void mpf_initload(Mpf* dst, const Fexp& src);

}  // namespace mset::port::gmp
