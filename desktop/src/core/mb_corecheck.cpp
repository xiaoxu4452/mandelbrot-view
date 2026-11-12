// ------------------------------------------------------------------
// mb_corecheck.cpp — two numerical regressions for the reference orbit.
//
//   1. series: a synthetic orbit with Z_n = 1 makes A_n = 2^n - 1 and
//      B_n ~ A_n^2, C_n ~ A_n^3.  Bare doubles overflow B and C after a few
//      hundred steps even though the series tolerance still holds for almost
//      a thousand; the normalised coefficients must keep the skip going and
//      must reproduce A_sk * dc in exponent space.
//   2. cancel: cancel() must interrupt a 16384-bit reference orbit, not wait
//      for it to finish.  RFF-2.0 checks every 1024 reference steps; before
//      that hook only the pixel passes were cancellable.
// ------------------------------------------------------------------
#include "mb_internal.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

static int seriesTest() {
  using namespace mbc::detail;
  Ref R;
  const int N = 4000;
  R.len = N;
  R.re.assign(N, 1.0);          // Z_n == 1 for every n
  R.im.assign(N, 0.0);
  R.dRe = R.dIm = 0.0;
  buildFolds(R, 0);
  buildSeries(R, -996.6, true, 2, 0);   // log2(1e-300)

  int maxA = 0, maxB = 0, maxC = 0;
  for (int e : R.aExp) if (e > maxA) maxA = e;
  for (int e : R.bExp) if (e > maxB) maxB = e;
  for (int e : R.cExp) if (e > maxC) maxC = e;

  const int sk = R.skip;
  double dr = 0.0, di = 0.0;
  seriesDeviation(R, sk, 1e-301, 0.0, dr, di);
  /* A_sk ~ 2^sk, so log10(A_sk*dc) = sk*log10(2) - 301.  B and C contribute
   * less than the tolerance, hence less than 0.001 in relative terms. */
  const double expect = (double)sk * std::log10(2.0) - 301.0;
  const double got = std::log10(std::max(std::fabs(dr), 1e-300));
  std::printf("[series] len=%d skip=%d derSkip=%d exp(A,B,C)max=(%d,%d,%d)\n",
              R.len, sk, R.derSkip, maxA, maxB, maxC);
  std::printf("[series] log10(d)=%.4f expected=%.4f (diff %.4f)\n",
              got, expect, std::fabs(got - expect));
  /* The old bare-double recurrence stopped where C crossed 1e308, around
   * step 340.  The log-domain criterion permits roughly 980 steps here. */
  const bool ok = sk > 700 && maxB > 0 && maxC > 0 &&
                  std::fabs(got - expect) < 0.02 && std::isfinite(dr);
  std::printf("[series] %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}

static int cancelTest() {
  mbc::Engine eng(2);
  mbc::Request q;
  q.centerRe = "-0.743643887037151";
  q.centerIm = "0.131825904205330";
  q.spanMant = 1.0;
  q.spanExp = -500;            // forces the 16384-bit tier
  q.width = q.height = 64;
  q.viewWidth = q.viewHeight = 64;
  q.maxIter = 200000;
  q.pal = &mbc::builtinPalette(0);
  q.aa = 1;
  std::vector<uint8_t> out((size_t)64 * 64 * 4, 0);
  mbc::Stats st;

  const auto t0 = std::chrono::steady_clock::now();
  std::thread th([&] { eng.render(q, out.data(), st); });
  std::this_thread::sleep_for(std::chrono::milliseconds(80));
  eng.cancel();
  th.join();
  const double ms = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - t0).count();
  std::printf("[cancel] render returned %.1f ms after an 80 ms start\n", ms);
  /* Without the hook this is minutes: a 200000-step arbitrary-precision
   * orbit has to finish before the pixel passes even look at the generation. */
  const bool ok = ms < 5000.0;
  std::printf("[cancel] %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}

int main() {
  int rc = seriesTest();
  rc |= cancelTest();
  std::printf("[corecheck] %s\n", rc ? "FAILURES" : "ALL PASS");
  return rc;
}
