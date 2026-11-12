// ---------------------------------------------------------------------------
// musl_libm.h — public declarations of the prefixed musl libm build.
//
// third_party/musl is the upstream musl sources (ifduyue/musl mirror) compiled
// with zig's clang for x86_64-windows-gnu.  Its public symbols are prefixed
// with mbm_ at compile time so the static library can coexist with the MSVC
// CRT, which also defines sin/log/exp/...  Nothing here is a reimplementation:
// every routine is the upstream, ULP-documented musl algorithm.
//
// The one exception is fma(): the DD layer uses std::fma, i.e. the IEEE-754
// hardware fused multiply-add.  That is an exact primitive, not an
// approximation, and musl's software fma() would be strictly slower.
// ---------------------------------------------------------------------------
#pragma once

extern "C" {

double mbm_sin(double);
double mbm_cos(double);
double mbm_tan(double);
double mbm_asin(double);
double mbm_acos(double);
double mbm_atan(double);
double mbm_atan2(double, double);
double mbm_exp(double);
double mbm_exp2(double);
double mbm_expm1(double);
double mbm_log(double);
double mbm_log2(double);
double mbm_log10(double);
double mbm_log1p(double);
double mbm_pow(double, double);
double mbm_cbrt(double);
double mbm_sqrt(double);
double mbm_hypot(double, double);
double mbm_fma(double, double, double);
double mbm_fabs(double);
double mbm_floor(double);
double mbm_ceil(double);
double mbm_trunc(double);
double mbm_round(double);
double mbm_rint(double);
double mbm_ldexp(double, int);
double mbm_frexp(double, int*);
double mbm_scalbn(double, int);
int    mbm_ilogb(double);
double mbm_fmod(double, double);
double mbm_remainder(double, double);
double mbm_copysign(double, double);
double mbm_remquo(double, double, int*);

}  // extern "C"
