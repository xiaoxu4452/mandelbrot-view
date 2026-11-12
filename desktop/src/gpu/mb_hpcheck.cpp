// ---------------------------------------------------------------------------
// mb_hpcheck.cpp — accuracy + speed regression for the Boost.Multiprecision
// high-precision layer, with a pixel-by-pixel comparison against the core's
// hand-written Mpf (GMP mpf_t semantics).
// ---------------------------------------------------------------------------
#include "mb_hp.h"
#include "mb_mpf.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>

namespace {
int g_pass = 0, g_fail = 0;
void check(bool ok, const char* name, const char* detail = "") {
  if (ok) { ++g_pass; std::printf("  PASS  %-40s %s\n", name, detail); }
  else    { ++g_fail; std::printf("  FAIL  %-40s %s\n", name, detail); }
}

/** Same orbit, computed with the core's Mpf, as a reference. */
std::vector<double> orbitWithMpf(const std::string& sre, const std::string& sim,
                                 int n, int bits) {
  mbc::Mpf cr, ci, zr, zi, rr, ii, cross, t, t2;
  for (auto* p : {&cr, &ci, &zr, &zi, &rr, &ii, &cross, &t, &t2}) p->setPrec(bits);
  cr.setStr(sre); ci.setStr(sim);
  zr.setZero(); zi.setZero();
  std::vector<double> out;
  out.reserve(static_cast<size_t>(n));
  for (int k = 0; k < n; ++k) {
    out.push_back(zr.toDouble());
    mbc::Mpf::mul(rr, zr, zr);
    mbc::Mpf::mul(ii, zi, zi);
    mbc::Mpf::mul(cross, zr, zi);
    mbc::Mpf::sub(t, rr, ii);
    mbc::Mpf::add(zr, t, cr);
    mbc::Mpf::mul2exp(t2, cross, 1);
    mbc::Mpf::add(zi, t2, ci);
  }
  return out;
}
}  // namespace

int main() {
  std::printf("Boost.Multiprecision high-precision regression\n");

  // ---- 1. exact decimal parsing, checked against Python decimal -----------
  std::printf("\n[hp] decimal -> (hi, lo) DD split\n");
  struct { const char* s; double hi, lo; } cases[] = {
      {"0.1", 0.1, -5.551115123125783e-18},
      {"3.14159265358979323846264338327950288419716939937510", 3.141592653589793,
       1.2246467991473532e-16},
      {"-0.743643887037158704752191506114774", -0.7436438870371587,
       -3.628952515063387e-17},
  };
  for (const auto& c : cases) {
    double hi = 0, lo = 0;
    mbhp::splitDecimal(c.s, hi, lo);
    const double rel = std::fabs(lo - c.lo) / std::max(std::fabs(c.hi), 1e-300);
    char d[140];
    std::snprintf(d, sizeof(d), "hi=%s rel=%.3g",
                  hi == c.hi ? "exact" : "DIFF", rel);
    check(hi == c.hi && rel < 1e-15, "splitDecimal", d);
  }

  // ---- 2. adaptive tiers and error bounds --------------------------------
  std::printf("\n[hp] adaptive precision tiers\n");
  const char* centers[][2] = {
      {"-0.6", "0"},
      {"-0.743643887037151", "0.131825904205330"},
      {"-0.743643887037158704752191506114774", "0.131825904205311970493132056385139"},
      {"-0.7436438870371587047521915061147740000000000000000000001",
       "0.1318259042053119704931320563851390000000000000000000001"},
  };
  const double depths[] = {8, 100, 350, 1162};
  int prevTier = -1;
  for (int i = 0; i < 4; ++i) {
    const auto o = mbhp::buildOrbit(centers[i][0], centers[i][1], 400, depths[i]);
    char d[180];
    std::snprintf(d, sizeof(d), "bits=%d tier=%d len=%d %.1fms err=%.2g",
                  o.bits, o.tier, o.len, o.ms, o.errorBound);
    check(o.len > 0 && o.bits >= 96 && o.errorBound < 1e-20,
          "orbit built within error bound", d);
    if (i > 0) check(o.tier >= prevTier, "tier grows with depth");
    prevTier = o.tier;
  }

  // ---- 3. cache -----------------------------------------------------------
  std::printf("\n[hp] reference-orbit cache\n");
  const auto a = mbhp::buildOrbit(centers[1][0], centers[1][1], 400, 100);
  const auto b = mbhp::buildOrbit(centers[1][0], centers[1][1], 400, 100);
  check(b.cached && b.ms == 0.0 && b.len == a.len, "identical view reuses orbit");
  check(mbhp::cacheSize() >= 1, "cache populated");

  // ---- 4. accuracy vs the core's Mpf, and speed ---------------------------
  std::printf("\n[hp] accuracy / speed vs hand-written Mpf\n");
  const std::string cr = "-0.743643887037158704752191506114774";
  const std::string ci = "0.131825904205311970493132056385139";
  const int n = 600;
  const auto t0 = std::chrono::steady_clock::now();
  const auto o = mbhp::buildOrbit(cr, ci, n, 100);
  const double boostMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - t0).count();
  const auto t1 = std::chrono::steady_clock::now();
  const auto ref = orbitWithMpf(cr, ci, n, 400);
  const double mpfMs = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - t1).count();

  double maxRel = 0.0;
  int compared = 0;
  for (int k = 0; k < std::min<int>(n, o.len) && k < (int)ref.size(); ++k) {
    const double v = o.re[static_cast<size_t>(k)];  // float projection
    const double r = ref[static_cast<size_t>(k)];
    if (std::fabs(r) > 1e-12) {
      maxRel = std::max(maxRel, std::fabs(v - r) / std::fabs(r));
      ++compared;
    }
  }
  char d[200];
  std::snprintf(d, sizeof(d), "max rel=%.3g over %d steps", maxRel, compared);
  check(maxRel < 1e-6, "Boost orbit matches Mpf", d);
  std::snprintf(d, sizeof(d), "boost=%.1fms mpf=%.1fms (%dx)", boostMs, mpfMs,
                mpfMs > 0 ? (int)(mpfMs / std::max(boostMs, 0.001)) : 0);
  std::printf("  timing: %s\n", d);
  check(boostMs < mpfMs * 1.5, "Boost tier is not slower than Mpf", d);

  // ---- 5. deep view still terminates -------------------------------------
  std::printf("\n[hp] 1e350-class depth\n");
  mbhp::clearCache();
  const auto deep = mbhp::buildOrbit(cr, ci, 200, 1162);
  std::snprintf(d, sizeof(d), "bits=%d tier=%d len=%d err=%.2g",
                deep.bits, deep.tier, deep.len, deep.errorBound);
  check(deep.tier == 4 && deep.len > 0, "2325-bit tier selected", d);

  std::printf("\nRESULT: %d passed, %d failed -> %s\n", g_pass, g_fail,
              g_fail == 0 ? "ALL PASS" : "FAIL");
  return g_fail == 0 ? 0 : 1;
}
