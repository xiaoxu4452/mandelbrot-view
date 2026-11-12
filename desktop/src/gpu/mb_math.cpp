// ---------------------------------------------------------------------------
// mb_math.cpp — see mb_math.h for the contract and the error analysis.
// ---------------------------------------------------------------------------
#include "musl_libm.h"
#include "mb_math.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace mbm {

DD quickTwoSum(double a, double b) {
  const double s = a + b;
  return DD{s, b - (s - a)};
}

DD twoSum(double a, double b) {
  const double s = a + b;
  const double bb = s - a;
  return DD{s, (a - (s - bb)) + (b - bb)};
}

DD twoProd(double a, double b) {
  // volatile defeats contraction: the product must be rounded to a double
  // before fma() computes the exact residual, otherwise the error term is 0.
  volatile double p = a * b;
  const double e = std::fma(a, b, -p);
  return DD{p, e};
}

DD dd(double a) { return DD{a, 0.0}; }
DD ddNeg(DD a) { return DD{-a.hi, -a.lo}; }

DD ddAdd(DD a, DD b) {
  DD s = twoSum(a.hi, b.hi);
  const DD t = twoSum(a.lo, b.lo);
  s.lo += t.hi;
  s = quickTwoSum(s.hi, s.lo);
  s.lo += t.lo;
  return quickTwoSum(s.hi, s.lo);
}

DD ddSub(DD a, DD b) { return ddAdd(a, ddNeg(b)); }
DD ddAddD(DD a, double b) { return ddAdd(a, dd(b)); }

DD ddMul(DD a, DD b) {
  DD p = twoProd(a.hi, b.hi);
  // Cross terms are exact enough in double: their contribution is already at
  // the 2^-106 level, and a.lo*b.lo is below the representation limit.
  p.lo += a.hi * b.lo + a.lo * b.hi;
  p.lo += a.lo * b.lo;
  return quickTwoSum(p.hi, p.lo);
}

DD ddMulD(DD a, double b) { return ddMul(a, dd(b)); }
DD ddSqr(DD a) { return ddMul(a, a); }

DD ddDiv(DD a, DD b) {
  if (b.hi == 0.0) return DD{0.0, 0.0};
  double q1 = a.hi / b.hi;
  DD q = dd(q1);
  // Newton correction in DD.  Three iterations recover the full 106 bits;
  // a fourth only moves the last bit and is not worth the flops in a kernel.
  for (int i = 0; i < 3; ++i) {
    const DD r = ddSub(a, ddMul(b, q));
    const double dq = (r.hi + r.lo) / b.hi;
    if (!std::isfinite(dq)) break;
    q = ddAdd(q, dd(dq));
  }
  return q;
}

DD ddDivD(DD a, double b) { return ddDiv(a, dd(b)); }

DD ddLdexp(DD a, int e) {
  return DD{mbm_ldexp(a.hi, e), mbm_ldexp(a.lo, e)};
}

DD ddSqrt(DD a) {
  if (a.hi <= 0.0) return DD{0.0, 0.0};
  DD x = dd(mbm_sqrt(a.hi));
  for (int i = 0; i < 3; ++i)
    x = ddMulD(ddAdd(x, ddDiv(a, x)), 0.5);
  return x;
}

double ddToDouble(DD a) { return a.hi + a.lo; }
bool ddFinite(DD a) { return std::isfinite(a.hi) && std::isfinite(a.lo); }

DDC cAdd(DDC a, DDC b) { return DDC{ddAdd(a.re, b.re), ddAdd(a.im, b.im)}; }
DDC cSub(DDC a, DDC b) { return DDC{ddSub(a.re, b.re), ddSub(a.im, b.im)}; }
DDC cMul(DDC a, DDC b) {
  return DDC{ddSub(ddMul(a.re, b.re), ddMul(a.im, b.im)),
             ddAdd(ddMul(a.re, b.im), ddMul(a.im, b.re))};
}
DDC cSqr(DDC a) { return cMul(a, a); }
DD cAbs2(DDC a) { return ddAdd(ddSqr(a.re), ddSqr(a.im)); }

double ddMulRelErrorBound() { return mbm_ldexp(1.0, -100); }
double ddAddRelErrorBound() { return mbm_ldexp(1.0, -104); }

bool ddNormalised(DD a) {
  if (a.hi == 0.0) return a.lo == 0.0;
  if (!std::isfinite(a.hi) || !std::isfinite(a.lo)) return false;
  const int e = mbm_ilogb(a.hi);
  return mbm_fabs(a.lo) <= mbm_ldexp(1.0, e - 53);
}

namespace {
/** Powers of ten up to 10^15 are exact in a double (< 2^53). */
double pow10Exact(int k) {
  static const double t[16] = {1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7,
                               1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15};
  return t[k];
}
void scaleBy10(DD& v, int exp10) {
  // The value must be multiplied by 10^exp10.  Positive exponents multiply,
  // negative ones divide.  Getting this backwards turns "0.1" into 10 and
  // makes every deep preset centre meaningless.
  while (exp10 >= 15) { v = ddMulD(v, pow10Exact(15)); exp10 -= 15; }
  if (exp10 > 0) v = ddMulD(v, pow10Exact(exp10));
  while (exp10 <= -15) { v = ddDivD(v, pow10Exact(15)); exp10 += 15; }
  if (exp10 < 0) v = ddDivD(v, pow10Exact(-exp10));
}
}  // namespace

DD ddFromDecimal(const std::string& s) {
  // Accumulate *every* digit into an exact DD integer first; only then apply
  // the decimal scaling.  A strtod round-trip would throw away all digits past
  // the 17th, which is precisely what a 30-digit preset centre is made of.
  size_t i = 0;
  bool neg = false;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) neg = s[i++] == '-';
  DD v{0.0, 0.0};
  size_t total = 0, integerDigits = std::string::npos;
  while (i < s.size()) {
    const char c = s[i];
    if (c >= '0' && c <= '9') {
      v = ddAdd(ddMulD(v, 10.0), dd(static_cast<double>(c - '0')));
      ++total;
    } else if (c == '.' && integerDigits == std::string::npos) {
      integerDigits = total;
    } else break;
    ++i;
  }
  const int frac = integerDigits == std::string::npos
                       ? 0
                       : static_cast<int>(total - integerDigits);
  int e10 = -frac;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    ++i;
    int sign = 1;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) sign = s[i++] == '-' ? -1 : 1;
    int ev = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9')
      ev = ev * 10 + (s[i++] - '0');
    e10 += sign * ev;
  }
  scaleBy10(v, e10);
  return neg ? ddNeg(v) : v;
}

DD ddScale(double mant, int exp2) {
  return ddLdexp(dd(mant), exp2);
}

DDC ddPixelDelta(DD pixel, double dx, double dy, double rotC, double rotS) {
  const DD ox = ddMul(pixel, dd(dx));
  const DD oy = ddMul(pixel, dd(dy));
  return DDC{ddSub(ddMul(ox, dd(rotC)), ddMul(oy, dd(rotS))),
             ddAdd(ddMul(ox, dd(rotS)), ddMul(oy, dd(rotC)))};
}

bool inMainCardioid(double cr, double ci) {
  const double x = cr - 0.25;
  const double q = x * x + ci * ci;
  return q * (q + x) <= 0.25 * ci * ci;
}
bool inPeriod2Bulb(double cr, double ci) {
  const double x = cr + 1.0;
  return x * x + ci * ci <= 0.0625;
}

double smoothIteration(int n, double m2, double logBail, double invLogPower) {
  if (!(m2 > 1.0) || !std::isfinite(m2)) return static_cast<double>(n);
  const double logz = 0.5 * mbm_log(m2);
  const double nu = mbm_log(logz / logBail) * invLogPower;
  return static_cast<double>(n) + 1.0 - nu;
}

bool periodClose(double zr, double zi, double hr, double hi, double relTol) {
  const double dr = zr - hr, di = zi - hi;
  const double d2 = dr * dr + di * di;
  const double ref = std::max(zr * zr + zi * zi, hr * hr + hi * hi);
  return d2 <= relTol * relTol * std::max(ref, 1e-300);
}

bool seriesTolerance(double logA, double logB, double logC, double logDc,
                     double relTol) {
  const double lt = mbm_log(relTol) + logA;
  return (logB + logDc <= lt) && (logC + 2.0 * logDc <= lt);
}

// ---- colour science -----------------------------------------------------
double srgbToLinear(double c) {
  return c <= 0.04045 ? c / 12.92 : mbm_pow((c + 0.055) / 1.055, 2.4);
}
double linearToSrgb(double c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * mbm_pow(c, 1.0 / 2.4) - 0.055;
}

namespace {
struct Mat3 { double v[3][3]; };

/** Exact (to double precision) inverse of a 3x3 matrix by cofactors. */
Mat3 inverse3(const Mat3& A) {
  const double a = A.v[0][0], b = A.v[0][1], d = A.v[0][2];
  const double e = A.v[1][0], f = A.v[1][1], g = A.v[1][2];
  const double h = A.v[2][0], i = A.v[2][1], j = A.v[2][2];
  const double c00 = f * j - g * i, c01 = g * h - e * j, c02 = e * i - f * h;
  const double r = 1.0 / (a * c00 + b * c01 + d * c02);
  Mat3 I{};
  I.v[0][0] = c00 * r;
  I.v[0][1] = (d * i - b * j) * r;
  I.v[0][2] = (b * g - d * f) * r;
  I.v[1][0] = c01 * r;
  I.v[1][1] = (a * j - d * h) * r;
  I.v[1][2] = (d * e - a * g) * r;
  I.v[2][0] = c02 * r;
  I.v[2][1] = (b * h - a * i) * r;
  I.v[2][2] = (a * f - b * e) * r;
  return I;
}

// Bjorn Ottosson's forward OKLab matrices, quoted at their published
// precision.  The reverse transforms are *computed inverses of these very
// matrices*, not his separately rounded 10-decimal inverse constants: using
// those constants round-trips at ~1e-7 in linear RGB, which is a visible
// error once the output is quantised to 10 bits.
const Mat3 kRgbToLms{{{0.4122214708, 0.5363325363, 0.0514459929},
                      {0.2119034982, 0.6806995451, 0.1073969566},
                      {0.0883024619, 0.2817188376, 0.6299787005}}};
const Mat3 kLmsToOklab{{{0.2104542553, 0.7936177850, -0.0040720468},
                        {1.9779984951, -2.4285922050, 0.4505937099},
                        {0.0259040371, 0.7827717662, -0.8086757660}}};
const Mat3 kOklabToLms = inverse3(kLmsToOklab);
const Mat3 kLmsToRgb = inverse3(kRgbToLms);

double dot3(const double row[3], double x, double y, double z) {
  return row[0] * x + row[1] * y + row[2] * z;
}
}  // namespace

OKLab linearToOklab(double r, double g, double bl) {
  const double l = mbm_cbrt(dot3(kRgbToLms.v[0], r, g, bl));
  const double m = mbm_cbrt(dot3(kRgbToLms.v[1], r, g, bl));
  const double s = mbm_cbrt(dot3(kRgbToLms.v[2], r, g, bl));
  return OKLab{dot3(kLmsToOklab.v[0], l, m, s),
               dot3(kLmsToOklab.v[1], l, m, s),
               dot3(kLmsToOklab.v[2], l, m, s)};
}

std::tuple<double, double, double> oklabToLinear(const OKLab& c) {
  const double l = dot3(kOklabToLms.v[0], c.L, c.a, c.b);
  const double m = dot3(kOklabToLms.v[1], c.L, c.a, c.b);
  const double s = dot3(kOklabToLms.v[2], c.L, c.a, c.b);
  const double l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return std::make_tuple(dot3(kLmsToRgb.v[0], l3, m3, s3),
                         dot3(kLmsToRgb.v[1], l3, m3, s3),
                         dot3(kLmsToRgb.v[2], l3, m3, s3));
}

OKLCH oklabToOklch(const OKLab& c) {
  return OKLCH{c.L, mbm_hypot(c.a, c.b), mbm_atan2(c.b, c.a)};
}
OKLab oklchToOklab(const OKLCH& c) {
  return OKLab{c.L, c.C * mbm_cos(c.h), c.C * mbm_sin(c.h)};
}

double maxSrgbChroma(double L, double h) {
  auto inside = [&](double C) {
    auto [r, g, b] = oklabToLinear(oklchToOklab(OKLCH{L, C, h}));
    const double eps = 1e-9;
    return r >= -eps && g >= -eps && b >= -eps && r <= 1 + eps &&
           g <= 1 + eps && b <= 1 + eps;
  };
  double lo = 0.0, hi = 0.5;
  if (inside(hi)) return hi;
  for (int i = 0; i < 40; ++i) {
    const double mid = 0.5 * (lo + hi);
    if (inside(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

}  // namespace mbm
