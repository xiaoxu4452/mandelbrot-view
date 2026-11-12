// ------------------------------------------------------------------
// mb_hf.h — the HFLOAT primitive family from the original binary (pseudocode
// 00446560 onwards).
//
// The layout matches the disassembly:
//   HFLOAT        { int64 mantissa; int32 exponent; }   value = m * 2^e
//   HFLOATCOMPLEX { int64 mx, my;  int32 exponent; }   value = (mx + i·my) * 2^e
// Both components **share one exponent**; the mantissas are signed 62-bit
// integers normalised to |m| in [2^61, 2^62).  The exponent is clamped to
// ±0x2000000 and saturates to 0x3fffffffffffffff on overflow (saturation
// rather than inf; that is the normalisation branch at 00446560).
//
// This is the fixed-point float the original uses for series extrapolation and
// saturation (the input to accurateprec).  It is a separate path from the mpf
// chain: mpf carries the reference orbit, HF carries the local Taylor series.
// ------------------------------------------------------------------
#pragma once

#include <cstdint>

namespace mbc {

struct HFloat {
  int64_t m = 0;
  int32_t e = 0;
};

struct HFComplex {
  int64_t mx = 0;
  int64_t my = 0;
  int32_t e = 0;
};

constexpr int64_t kHfUnit = 0x2000000000000000LL;   // 2^61
constexpr int64_t kHfMax = 0x3fffffffffffffffLL;    // 2^62 - 1
constexpr int32_t kHfExpMax = 0x2000000;
constexpr int32_t kHfExpMin = -0x2000000;

void hfNorm(HFloat& a);
void hfNormC(HFComplex& a);

HFloat hfAdd(const HFloat& a, const HFloat& b);
HFloat hfSub(const HFloat& a, const HFloat& b);
HFloat hfMul(const HFloat& a, const HFloat& b);
HFloat hfMul2(HFloat a);            // a * 2 (exponent bump, no bits lost)
HFloat hfAbs2(const HFloat& a);     // |a|^2, still on the 62-bit mantissa
HFloat hfFromDouble(double v);
double hfToDouble(const HFloat& a);

HFComplex hfcAdd(const HFComplex& a, const HFComplex& b);
HFComplex hfcSub(const HFComplex& a, const HFComplex& b);
HFComplex hfcMul(const HFComplex& a, const HFComplex& b);
HFComplex hfcSqr(const HFComplex& a);
HFloat hfcAbs2(const HFComplex& a);
HFComplex hfcFromDoubles(double re, double im);
void hfcToDoubles(const HFComplex& a, double& re, double& im);

}  // namespace mbc
