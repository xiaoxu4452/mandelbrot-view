// ---------------------------------------------------------------------------
// mb_hp.h — arbitrary-precision reference orbits on Boost.Multiprecision.
//
// The hand-written Mpf in the core emulates GMP's mpf_t with a heap vector;
// it is correct but allocates, and its precision tier has to be chosen by the
// caller for the whole frame.  This layer is built on Boost.Multiprecision
// (official Boost 1.87 headers in third_party/boost) instead:
//
//   * cpp_bin_float<N> has a *compile-time fixed* mantissa (a std::array), so
//     an orbit step allocates nothing.  N is decimal digits.
//   * Five tiers are instantiated and the smallest sufficient one is chosen
//     from the pixel scale at runtime.  A 1e-30 frame never pays for a
//     2300-bit mantissa, while 1e350 still gets one.
//   * The reference orbit is cached by (centre, iteration cap, bits), which
//     is what makes a zoom sequence cheap: consecutive views share a centre.
//   * An explicit accumulated error bound is reported alongside the orbit.
//
// If a GMP/MPFR build is available (MB_HAS_MPFR), the same API switches to
// boost::multiprecision::mpf_float / mpfr_float backends: those are the
// native GMP+MPFR implementations with correctly-rounded arithmetic and a
// runtime-settable precision.  The cpp_bin_float tier is the header-only
// fallback so the project always builds without a GMP/MPFR runtime.
// ---------------------------------------------------------------------------
#pragma once

#include <boost/multiprecision/cpp_bin_float.hpp>

#include <cstdint>
#include <string>
#include <vector>

namespace mbhp {

using boost::multiprecision::cpp_bin_float;
using boost::multiprecision::number;

/** Compile-time mantissa tiers.  Digits are decimal; bits ~= digits*log2(10). */
using Hp64 = number<cpp_bin_float<50>>;    // ~166 bits
using Hp128 = number<cpp_bin_float<100>>;   // ~332 bits
using Hp256 = number<cpp_bin_float<200>>;   // ~664 bits
using Hp512 = number<cpp_bin_float<350>>;   // ~1163 bits (1e350)
using Hp1024 = number<cpp_bin_float<700>>;  // ~2325 bits

struct Orbit {
  std::vector<float> re, im;   // GPU-facing reference orbit
  int len = 0;
  int bits = 0;
  int tier = 0;                // which compile-time tier was used
  double ms = 0.0;
  bool cached = false;
  double errorBound = 0.0;    // accumulated relative bound, 2^-bits * n
};

/** Smallest precision that keeps a pixel of this size meaningful.
 *  Follows the reference program's PRECISIONSHIFT = 64 (depth + 64 bits),
 *  clamped so shallow views never allocate a wide mantissa. */
int bitsForDepth(double depthBits);

/** Parse a 30+ digit decimal exactly into a Boost number and return hi/lo
 *  doubles (the DD split the OpenCL kernel consumes). */
void splitDecimal(const std::string& s, double& hi, double& lo);

/** Build (or reuse) the reference orbit for a view. */
Orbit buildOrbit(const std::string& centerRe, const std::string& centerIm,
                 int maxIter, double depthBits, double bail2 = 1e20);

/** Number of cached orbits / bytes held (diagnostics). */
int cacheSize();
void clearCache();

/** Theoretical relative error bound after n iterations at `bits` precision. */
double accumulatedErrorBound(int bits, int n);

}  // namespace mbhp
