#include "mb_hf.h"

#include <intrin.h>

#include <cmath>

namespace mbc {
namespace {

int64_t abs64(int64_t v) { return v < 0 ? -v : v; }

/* (a*b) >> 62，MSVC 没有 __int128，用 64x64->128 的 hi/lo 拼。 */
int64_t mulShift62(int64_t a, int64_t b) {
  const int64_t hi = __mulh(a, b);
  const uint64_t lo = (uint64_t)a * (uint64_t)b;
  return (hi << 2) | (int64_t)(lo >> 62);
}

/* 饱和：指数越界时按原版取极值（00446560 的 clamp 分支）。 */
void saturate(HFloat& a) {
  if (a.e > kHfExpMax) {
    a.e = kHfExpMax;
    a.m = a.m < 0 ? -kHfMax : kHfMax;
  } else if (a.e < kHfExpMin) {
    a.e = kHfExpMin;
    a.m = 0;
  }
}

/* 共享指数的尾数对按同一方向规格化：|mx|,|my| 的最大者进 [2^61, 2^62)。 */
void normPair(int64_t& mx, int64_t& my, int32_t& e) {
  int64_t ax = abs64(mx), ay = abs64(my);
  int64_t a = ax > ay ? ax : ay;
  if (a == 0) {
    e = 0;
    return;
  }
  while (a < kHfUnit && e > kHfExpMin) {
    mx <<= 1;
    my <<= 1;
    a <<= 1;
    --e;
  }
  while (a > kHfMax) {
    mx >>= 1;
    my >>= 1;
    a >>= 1;
    ++e;
  }
}

}  // namespace

void hfNorm(HFloat& a) {
  int64_t m = abs64(a.m);
  if (m == 0) {
    a.m = 0;
    a.e = 0;
    return;
  }
  while (m < kHfUnit && a.e > kHfExpMin) {
    a.m <<= 1;
    m <<= 1;
    --a.e;
  }
  while (m > kHfMax) {
    a.m >>= 1;
    m >>= 1;
    ++a.e;
  }
  saturate(a);
}

void hfNormC(HFComplex& a) { normPair(a.mx, a.my, a.e); }

HFloat hfAdd(const HFloat& a, const HFloat& b) {
  if (a.m == 0) return b;
  if (b.m == 0) return a;
  HFloat r;
  r.e = a.e > b.e ? a.e : b.e;
  const int32_t da = a.e - r.e;
  const int32_t db = b.e - r.e;
  const int64_t am = da >= 63 ? 0 : (a.m >> da);
  const int64_t bm = db >= 63 ? 0 : (b.m >> db);
  r.m = am + bm;
  hfNorm(r);
  return r;
}

HFloat hfSub(const HFloat& a, const HFloat& b) {
  HFloat nb = b;
  nb.m = -nb.m;
  return hfAdd(a, nb);
}

HFloat hfMul(const HFloat& a, const HFloat& b) {
  HFloat r;
  if (a.m == 0 || b.m == 0) return r;
  r.m = mulShift62(a.m, b.m);
  r.e = a.e + b.e + 62;
  hfNorm(r);
  return r;
}

HFloat hfMul2(HFloat a) {
  a.e += 1;
  saturate(a);
  return a;
}

HFloat hfAbs2(const HFloat& a) { return hfMul(a, a); }

HFloat hfFromDouble(double v) {
  HFloat r;
  if (!(v != 0.0)) return r;
  int ex = 0;
  const double m = std::frexp(std::fabs(v), &ex);  // |v| = m * 2^ex
  r.m = (int64_t)std::ldexp(m, 62) * (v < 0.0 ? -1 : 1);
  r.e = ex - 62;
  hfNorm(r);
  return r;
}

double hfToDouble(const HFloat& a) {
  if (a.m == 0) return 0.0;
  return (double)a.m * std::ldexp(1.0, a.e);
}

HFComplex hfcAdd(const HFComplex& a, const HFComplex& b) {
  if (a.mx == 0 && a.my == 0) return b;
  if (b.mx == 0 && b.my == 0) return a;
  HFComplex r;
  r.e = a.e > b.e ? a.e : b.e;
  const int32_t da = a.e - r.e;
  const int32_t db = b.e - r.e;
  r.mx = (da >= 63 ? 0 : (a.mx >> da)) + (db >= 63 ? 0 : (b.mx >> db));
  r.my = (da >= 63 ? 0 : (a.my >> da)) + (db >= 63 ? 0 : (b.my >> db));
  hfNormC(r);
  return r;
}

HFComplex hfcSub(const HFComplex& a, const HFComplex& b) {
  HFComplex nb = b;
  nb.mx = -nb.mx;
  nb.my = -nb.my;
  return hfcAdd(a, nb);
}

HFComplex hfcMul(const HFComplex& a, const HFComplex& b) {
  HFComplex r;
  if ((a.mx == 0 && a.my == 0) || (b.mx == 0 && b.my == 0)) return r;
  r.mx = mulShift62(a.mx, b.mx) - mulShift62(a.my, b.my);
  r.my = mulShift62(a.mx, b.my) + mulShift62(a.my, b.mx);
  r.e = a.e + b.e + 62;
  hfNormC(r);
  return r;
}

HFComplex hfcSqr(const HFComplex& a) {
  HFComplex r;
  if (a.mx == 0 && a.my == 0) return r;
  r.mx = mulShift62(a.mx, a.mx) - mulShift62(a.my, a.my);
  r.my = 2 * mulShift62(a.mx, a.my);
  r.e = 2 * a.e + 62;
  hfNormC(r);
  return r;
}

HFloat hfcAbs2(const HFComplex& a) {
  HFloat r;
  const int64_t s1 = mulShift62(a.mx, a.mx);
  const int64_t s2 = mulShift62(a.my, a.my);
  r.m = s1 + s2;
  r.e = 2 * a.e + 62;
  hfNorm(r);
  return r;
}

HFComplex hfcFromDoubles(double re, double im) {
  HFComplex r;
  HFloat hr = hfFromDouble(re);
  HFloat hi = hfFromDouble(im);
  const int32_t e = hr.e > hi.e ? hr.e : hi.e;  // 共享指数取较大者
  r.e = e;
  /* 指数较小的分量右移到公共指数（共享指数格式的固有截断）。 */
  const int32_t dr = e - hr.e;
  const int32_t di = e - hi.e;
  r.mx = (hr.m == 0 || dr >= 63) ? 0 : (hr.m >> dr);
  r.my = (hi.m == 0 || di >= 63) ? 0 : (hi.m >> di);
  hfNormC(r);
  return r;
}

void hfcToDoubles(const HFComplex& a, double& re, double& im) {
  re = (double)a.mx * std::ldexp(1.0, a.e);
  im = (double)a.my * std::ldexp(1.0, a.e);
}

}  // namespace mbc
