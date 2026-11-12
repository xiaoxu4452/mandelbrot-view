// ---------------------------------------------------------------------------
// mb_math.h — rigorous numerical kernel for the GPU path.
//
// The old CPU/CUDA-less code relied on plain doubles: at 1e-14 a pixel's
// coordinate loses its last bits, and the smooth-iteration / series tests
// quietly degrade.  This layer provides
//
//   * DD — double-double (106-bit mantissa) with Dekker two-sum / two-prod
//          and an explicit error bound for every operation.  two_prod uses
//          fma() with a volatile product so a compiler cannot fuse a*b - p
//          away (the exact residual is what makes DD accurate).
//   * exact decimal -> DD splitting of a preset centre (30+ digits survive),
//     plus the scale helper span = mant * 2^exp.
//   * analytic interior tests, smooth iteration and the scale-invariant
//     series tolerance, all with documented error bounds.
//   * colour-science primitives (linear light, OKLab/OKLCH) shared with
//     mb_color, so the palette works in a perceptual space rather than by
//     pushing RGB channels around.
//
// Arbitrary-precision reference orbits still come from mbc::Mpf (GMP mpf
// semantics, up to 16384 bits).  The division of labour is deliberate: the
// CPU builds the orbit once, OpenCL iterates the *deviation* in DD, and hence
// 1e350 zooms do not need 1163-bit arithmetic on the GPU at all.
// ---------------------------------------------------------------------------
#pragma once

#include <cstdint>
#include <string>
#include <tuple>

namespace mbm {

/** Unevaluated sum hi + lo, with |lo| <= 0.5 ulp(hi). */
struct DD {
  double hi = 0.0, lo = 0.0;
};

struct DDC {
  DD re, im;
};

// ---- error-free transformations -----------------------------------------
DD quickTwoSum(double a, double b);   // requires |a| >= |b|
DD twoSum(double a, double b);
DD twoProd(double a, double b);      // fma-based, contraction-safe

DD dd(double a);
DD ddNeg(DD a);
DD ddAdd(DD a, DD b);
DD ddSub(DD a, DD b);
DD ddAddD(DD a, double b);
DD ddMul(DD a, DD b);
DD ddMulD(DD a, double b);
DD ddSqr(DD a);
DD ddDiv(DD a, DD b);
DD ddDivD(DD a, double b);
DD ddLdexp(DD a, int e);
DD ddSqrt(DD a);
double ddToDouble(DD a);
bool ddFinite(DD a);

DDC cAdd(DDC a, DDC b);
DDC cSub(DDC a, DDC b);
DDC cMul(DDC a, DDC b);
DDC cSqr(DDC a);
DD cAbs2(DDC a);

/**
 * Conservative absolute error bound of one DD multiply, in units of the
 * product's magnitude.  For non-overlapping inputs, ddMul is accurate to
 * ~2^-104 relative; the bound below is deliberately looser (2^-100) so it
 * can be used as a hard acceptance test without ever being optimistic.
 */
double ddMulRelErrorBound();
double ddAddRelErrorBound();
/** True when the DD result satisfies |lo| <= 0.5 ulp(hi) (non-overlapping). */
bool ddNormalised(DD a);

// ---- decimal / view splitting -------------------------------------------
/** Parse a signed decimal string (possibly 30+ digits, with an exponent)
 *  into a DD without ever going through a single strtod round-trip. */
DD ddFromDecimal(const std::string& s);
/** span = mant * 2^exp2, exactly representable as a DD for |exp2| < 1020. */
DD ddScale(double mant, int exp2);
/**
 * Pixel *offset* from the frame centre, in DD.
 *
 * Deliberately returns a delta, not centre+delta: at 1e-30 a DD cannot hold
 * both the ~0.7 centre and a 1e-30 displacement (its 106-bit mantissa gives
 * ~1e-32 resolution there, so the displacement is swallowed).  Deep views
 * use perturbation, where only delta-c enters the deviation recurrence and
 * the reference orbit carries the centre at full Mpf precision.  Keeping the
 * two separate is what makes 1e350 possible without 1163-bit GPU arithmetic.
 */
DDC ddPixelDelta(DD pixel, double dx, double dy, double rotC, double rotS);

// ---- fractal predicates -------------------------------------------------
/** Exact main-cardioid / period-2 bulb tests (q = (x-1/4)^2 + y^2). */
bool inMainCardioid(double cr, double ci);
bool inPeriod2Bulb(double cr, double ci);
/**
 * Smooth iteration count.  The reference bails at |z| = 2 with log-power p:
 *   nu = log2( log|z| / log(bail) ),  t = n + 1 - nu.
 * Using log(m2) directly (rather than log(|z|)) halves the rounding error and
 * avoids a sqrt.  bailLog2 is precomputed as log2(log(bail)).
 */
double smoothIteration(int n, double m2, double logBail, double invLogPower);
/** Relative-threshold Brent period comparison (avoids the 1e-14 absolute
 *  threshold that misses high-period bulbs near a deep reference orbit). */
bool periodClose(double zr, double zi, double hr, double hi, double relTol);
/** Scale-invariant cubic-series acceptance, evaluated in the log domain. */
bool seriesTolerance(double logA, double logB, double logC, double logDc,
                     double relTol);

// ---- colour-science primitives (linear light) ---------------------------
double srgbToLinear(double c);
double linearToSrgb(double c);
struct OKLab {
  double L = 0.0, a = 0.0, b = 0.0;
};
struct OKLCH {
  double L = 0.0, C = 0.0, h = 0.0;  // h in radians
};
OKLab linearToOklab(double r, double g, double bl);
std::tuple<double, double, double> oklabToLinear(const OKLab& c);
OKLCH oklabToOklch(const OKLab& c);
OKLab oklchToOklab(const OKLCH& c);
/** Largest chroma at (L, h) that still lands inside the sRGB gamut.
 *  Bisection on OKLCH chroma, so a full-gamut palette never clips a hue. */
double maxSrgbChroma(double L, double h);

}  // namespace mbm
