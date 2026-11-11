// ------------------------------------------------------------------
// mb_hf.h — 原版的 HFLOAT 原语族（伪代码 00446560 起）。
//
// 布局与反汇编一致：
//   HFLOAT        { int64 mantissa; int32 exponent; }   值 = m * 2^e
//   HFLOATCOMPLEX { int64 mx, my;  int32 exponent; }   值 = (mx + i·my) * 2^e
// 两个分量**共享一个指数**，尾数为 62 位有符号整数，规格化到
// |m| ∈ [2^61, 2^62)；指数夹在 ±0x2000000，溢出时取 0x3fffffffffffffff
// （饱和而不是 inf，原版 00446560 的规范化分支就是这个判据）。
//
// 这是原版做级数外推/饱和（accurateprec 的输入）用的定点浮点，
// 和 mpf 链是两套东西：mpf 管参考轨道，HF 管局部 Taylor 级数。
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
HFloat hfMul2(HFloat a);            // a * 2（改指数，不丢位）
HFloat hfAbs2(const HFloat& a);     // |a|^2，仍按 62 位尾数
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
