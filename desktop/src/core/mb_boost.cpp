// ------------------------------------------------------------------
// mb_boost.cpp — see mb_boost.h.
// ------------------------------------------------------------------
#include "mb_boost.h"

#include "mb_mpf.h"
#include "mb_precision.h"

#include <boost/math/constants/constants.hpp>
#include <boost/multiprecision/cpp_bin_float.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_set>
#include <vector>

namespace mbc {
namespace {

// 800 decimal digits ≈ 2658 bits: enough to referee a 2304-bit fixed-point
// reference orbit at 1e-660 with ~350 bits of headroom.
using BF =
    boost::multiprecision::number<boost::multiprecision::cpp_bin_float<800>>;

BF limbsToBoost(const std::vector<uint32_t>& limbs, long expBits, bool neg) {
  BF acc = 0;
  const BF two32 = BF(4294967296ULL);
  for (size_t i = limbs.size(); i-- > 0;) {
    acc *= two32;
    acc += limbs[i];
  }
  if (expBits != 0) acc = boost::multiprecision::ldexp(acc, (int)expBits);
  return neg ? -acc : acc;
}

BF fromBig(const Big& v) {
  return limbsToBoost(v.limbs(), -(long)v.fracBits(), v.isNegative());
}

BF fromMpf(const Mpf& v) {
  return limbsToBoost(v.limbs(), v.limbExponent(), v.isNeg());
}

double log10Abs(const BF& v) {
  if (v == 0) return -999.0;
  const double e = (double)boost::multiprecision::log10(boost::multiprecision::abs(v));
  return std::max(-999.0, std::min(999.0, e));
}

double relLog10(const BF& got, const BF& ref) {
  if (got == ref) return -999.0;
  const BF den = boost::multiprecision::abs(ref) + BF("1e-300");
  return log10Abs(boost::multiprecision::abs(got - ref) / den);
}

struct BoostOrbit {
  BF x = 0, y = 0;
};

void step(BoostOrbit& z, const BF& cr, const BF& ci) {
  const BF nx = z.x * z.x - z.y * z.y + cr;
  const BF ny = 2 * z.x * z.y + ci;
  z.x = nx;
  z.y = ny;
}

bool checkBigOrbit(std::string& log) {
  const int frac = 2304;  // 1e-660 needs 2193 bits + guard
  const int iters = 40;
  Big bx = Big::fromInteger(0, frac), by = Big::fromInteger(0, frac);
  // Non-dyadic centre: every digit below 1e-694 comes from the arithmetic,
  // so an exact match is impossible unless both implementations are correct.
  const Big bcr = Big::fromString("0.1", frac);
  const Big bci = Big::fromString("0.2", frac);
  BoostOrbit bz;
  const BF cr("0.1"), ci("0.2");

  double worst = -999.0;
  int worstAt = 0;
  for (int n = 1; n <= iters; ++n) {
    Big nx = bx.mul(bx).sub(by.mul(by)).add(bcr);
    Big ny = bx.mul(by).shifted(1).add(bci);
    bx = nx;
    by = ny;
    step(bz, cr, ci);
    if (n == 1 || n == 2 || n == 5 || n == 10 || n == 20 || n == 40) {
      const double ex = relLog10(fromBig(bx), bz.x);
      const double ey = relLog10(fromBig(by), bz.y);
      const double e = std::max(ex, ey);
      if (e > worst) {
        worst = e;
        worstAt = n;
      }
      char line[192];
      std::snprintf(line, sizeof line,
                    "[boost] Big@%d c=0.1+0.2i n=%-2d relErr x=1e%.1f y=1e%.1f",
                    frac, n, ex, ey);
      log += line;
      log += '\n';
    }
  }
  const bool ok = worst < -600.0;
  char line[192];
  std::snprintf(line, sizeof line,
                "[boost] Big orbit check: worst=1e%.1f at n=%d -> %s", worst,
                worstAt, ok ? "PASS" : "FAIL");
  log += line;
  log += '\n';
  return ok;
}

bool checkMpfOrbit(std::string& log) {
  const int prec = 2304;
  const int iters = 40;
  Mpf mx(prec), my(prec), mcx(prec), mcy(prec);
  mx.setZero();
  my.setZero();
  mcx.setStr("0.1");
  mcy.setStr("0.2");
  BoostOrbit bz;
  const BF cr("0.1"), ci("0.2");

  double worst = -999.0;
  for (int n = 1; n <= iters; ++n) {
    Mpf xx(prec), yy(prec), xy(prec), nx(prec), ny(prec), t(prec);
    Mpf::mul(xx, mx, mx);
    Mpf::mul(yy, my, my);
    Mpf::sub(t, xx, yy);
    Mpf::add(nx, t, mcx);
    Mpf::mul(xy, mx, my);
    Mpf::mul2exp(t, xy, 1);
    Mpf::add(ny, t, mcy);
    mx = nx;
    my = ny;
    step(bz, cr, ci);
    if (n == 1 || n == 2 || n == 5 || n == 10 || n == 20 || n == 40) {
      const double ex = relLog10(fromMpf(mx), bz.x);
      const double ey = relLog10(fromMpf(my), bz.y);
      worst = std::max(worst, std::max(ex, ey));
      char line[192];
      std::snprintf(line, sizeof line,
                    "[boost] Mpf@%d c=0.1+0.2i n=%-2d relErr x=1e%.1f y=1e%.1f",
                    prec, n, ex, ey);
      log += line;
      log += '\n';
    }
  }
  const bool ok = worst < -600.0;
  char line[192];
  std::snprintf(line, sizeof line,
                "[boost] Mpf orbit check: worst=1e%.1f -> %s", worst,
                ok ? "PASS" : "FAIL");
  log += line;
  log += '\n';
  return ok;
}

// GL_RGB10_A2 + GL_UNSIGNED_INT_2_10_10_10_REV packing:
//   bits 0..9 red, 10..19 green, 20..29 blue, 30..31 alpha.
uint32_t pack10(int r, int g, int b) {
  return ((uint32_t)r & 1023u) | (((uint32_t)g & 1023u) << 10) |
         (((uint32_t)b & 1023u) << 20) | (3u << 30);
}

bool checkColor(std::string& log) {
  const BF twoPi = 2 * boost::math::constants::pi<BF>();
  std::unordered_set<uint32_t> codes;
  bool packOk = true;
  bool rangeOk = true;
  int samples = 4096;
  for (int i = 0; i < samples; ++i) {
    const BF t = BF(i) / samples;
    // IQ cosine palette, evaluated with Boost.Math at full precision.
    const BF r = BF("0.5") + BF("0.5") * boost::multiprecision::cos(twoPi * (t * 6 + BF("0.0")));
    const BF g = BF("0.5") + BF("0.5") * boost::multiprecision::cos(twoPi * (t * 6 + BF("0.33")));
    const BF b = BF("0.5") + BF("0.5") * boost::multiprecision::cos(twoPi * (t * 6 + BF("0.67")));
    const auto q = [](const BF& v) {
      long n = (long)boost::multiprecision::floor(v * 1024);
      if (n < 0) n = 0;
      if (n > 1023) n = 1023;
      return (int)n;
    };
    const int ri = q(r), gi = q(g), bi = q(b);
    if (ri < 0 || ri > 1023 || gi < 0 || gi > 1023 || bi < 0 || bi > 1023)
      rangeOk = false;
    const uint32_t code = pack10(ri, gi, bi);
    const int ur = (int)(code & 1023u);
    const int ug = (int)((code >> 10) & 1023u);
    const int ub = (int)((code >> 20) & 1023u);
    const int ua = (int)((code >> 30) & 3u);
    if (ur != ri || ug != gi || ub != bi || ua != 3) packOk = false;
    codes.insert(code);
  }
  const bool ok = packOk && rangeOk && codes.size() > 1000;
  char line[256];
  std::snprintf(line, sizeof line,
                "[boost] rgb10a2 levels=1024 codes=%lld distinct=%zu "
                "pack/unpack=%s range=%s -> %s",
                1024ll * 1024ll * 1024ll, codes.size(),
                packOk ? "PASS" : "FAIL", rangeOk ? "PASS" : "FAIL",
                ok ? "PASS" : "FAIL");
  log += line;
  log += '\n';
  return ok;
}

}  // namespace

bool boostSelfTest(std::string& log) {
  log += "[boost] backend=boost::multiprecision::cpp_bin_float<800> "
         "boost_math=cos/pi\n";
  const bool a = checkBigOrbit(log);
  const bool b = checkMpfOrbit(log);
  const bool c = checkColor(log);
  log += a && b && c ? "[boost] ALL PASS\n" : "[boost] FAILURES\n";
  return a && b && c;
}

}  // namespace mbc
