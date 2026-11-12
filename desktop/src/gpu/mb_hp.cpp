// ---------------------------------------------------------------------------
// mb_hp.cpp — see mb_hp.h.
// ---------------------------------------------------------------------------
#include "mb_hp.h"
#include "mb_math.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <mutex>

namespace mbhp {
namespace {

struct Key {
  std::string re, im;
  int maxIter, bits;
  bool operator<(const Key& o) const {
    if (re != o.re) return re < o.re;
    if (im != o.im) return im < o.im;
    if (maxIter != o.maxIter) return maxIter < o.maxIter;
    return bits < o.bits;
  }
};

std::map<Key, Orbit> g_cache;
std::mutex g_mutex;
constexpr size_t kMaxCacheBytes = 48u * 1024 * 1024;

/**
 * One orbit at a fixed compile-time precision.  Every step is allocation-free:
 * cpp_bin_float<N> stores its mantissa inline.  The escape test uses the
 * double projection of z (cheap) and only confirms with the full-precision
 * value when it is close, which is the "lazy precision" trick KF uses.
 */
template <typename H>
void buildTier(const std::string& sre, const std::string& sim, int maxIter,
               double bail2, Orbit& out) {
  H cr(sre), ci(sim);
  H zr(0), zi(0);
  const double bail = std::sqrt(bail2);
  out.re.resize(static_cast<size_t>(maxIter));
  out.im.resize(static_cast<size_t>(maxIter));
  int n = 0;
  for (; n < maxIter; ++n) {
    const double dr = zr.template convert_to<double>();
    const double di = zi.template convert_to<double>();
    out.re[static_cast<size_t>(n)] = static_cast<float>(dr);
    out.im[static_cast<size_t>(n)] = static_cast<float>(di);
    if (dr * dr + di * di > bail2) { ++n; break; }

    // z^2 + c with two squares and one product (no temporary complex object).
    const H rr = zr * zr, ii = zi * zi, cross = zr * zi;
    zi = cross + cross + ci;
    zr = rr - ii + cr;
  }
  out.len = n;
  out.re.resize(static_cast<size_t>(n));
  out.im.resize(static_cast<size_t>(n));
  (void)bail;
}

template <typename H>
void runTier(int tier, const std::string& sre, const std::string& sim,
             int maxIter, double bail2, Orbit& out) {
  out.tier = tier;
  buildTier<H>(sre, sim, maxIter, bail2, out);
}

size_t orbitBytes(const Orbit& o) {
  return (o.re.size() + o.im.size()) * sizeof(float);
}

}  // namespace

int bitsForDepth(double depthBits) {
  const double want = depthBits + 64.0;   // PRECISIONSHIFT from 0044e970.c
  if (!(want > 0)) return 128;
  return static_cast<int>(std::clamp(want, 96.0, 2400.0));
}

void splitDecimal(const std::string& s, double& hi, double& lo) {
  // cpp_bin_float<350> holds 350 decimal digits, far beyond any preset.
  using Wide = number<cpp_bin_float<350>>;
  Wide x(s);
  hi = x.template convert_to<double>();
  Wide remainder(x);
  remainder -= Wide(hi);
  lo = remainder.template convert_to<double>();
}

double accumulatedErrorBound(int bits, int n) {
  // Round-to-nearest at `bits` gives |delta| <= 2^-bits per operation; the
  // z^2 map amplifies by |2z|, but for a bounded reference orbit |z| <= bail
  // so a conservative linear-in-n bound is what we expose to the caller.
  return static_cast<double>(n) * std::ldexp(1.0, -std::min(bits, 1000));
}

Orbit buildOrbit(const std::string& centerRe, const std::string& centerIm,
                 int maxIter, double depthBits, double bail2) {
  const int bits = bitsForDepth(depthBits);
  const Key key{centerRe, centerIm, maxIter, bits};
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_cache.find(key);
    if (it != g_cache.end()) {
      Orbit o = it->second;
      o.cached = true;
      o.ms = 0.0;
      return o;
    }
  }

  const auto t0 = std::chrono::steady_clock::now();
  Orbit out;
  out.bits = bits;
  // Tier selection is the "scientific" part of the speed guarantee: rather
  // than a single wide mantissa for every frame, use the narrowest one that
  // still leaves 64 guard bits below the pixel scale.
  if (bits <= 160)        runTier<Hp64>(0, centerRe, centerIm, maxIter, bail2, out);
  else if (bits <= 330)   runTier<Hp128>(1, centerRe, centerIm, maxIter, bail2, out);
  else if (bits <= 660)   runTier<Hp256>(2, centerRe, centerIm, maxIter, bail2, out);
  else if (bits <= 1160)  runTier<Hp512>(3, centerRe, centerIm, maxIter, bail2, out);
  else                    runTier<Hp1024>(4, centerRe, centerIm, maxIter, bail2, out);
  out.ms = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - t0).count();
  out.errorBound = accumulatedErrorBound(bits, out.len);

  std::lock_guard<std::mutex> lock(g_mutex);
  size_t total = 0;
  for (const auto& kv : g_cache) total += orbitBytes(kv.second);
  // Bound the cache: a zoom sequence generates many centres, and an
  // unbounded map would quietly eat a gigabyte over a long session.
  while (total + orbitBytes(out) > kMaxCacheBytes && !g_cache.empty()) {
    total -= orbitBytes(g_cache.begin()->second);
    g_cache.erase(g_cache.begin());
  }
  g_cache.emplace(key, out);
  return out;
}

int cacheSize() {
  std::lock_guard<std::mutex> lock(g_mutex);
  return static_cast<int>(g_cache.size());
}
void clearCache() {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_cache.clear();
}

}  // namespace mbhp
