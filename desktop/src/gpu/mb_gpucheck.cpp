// ---------------------------------------------------------------------------
// mb_gpucheck.cpp — the A/B between the CPU core and the OpenCL kernel.
//
// Two independent implementations of the same iteration cannot be expected to
// agree in the last bit: the CPU vectorises four pixels at a time with FMA,
// the GPU runs scalar IEEE doubles with a different loop order.  What they
// MUST agree on is the *classification*, because that is what the picture is:
//
//   · does this pixel escape at iteration n?      (n is an integer, exact)
//   · is this pixel interior?                     (sign of the field)
//   · the smooth iteration count                (continuous, ±few ulp)
//   · the distance estimate                     (continuous, relative)
//
// So the pass criteria are stated per class instead of as a pixel hash, and
// the boundary pixels — where a one-ulp difference can flip an escape count —
// are reported separately rather than hidden.
//
//   mb_gpucheck            run the suite
//   mb_gpucheck bench      timing only
// ---------------------------------------------------------------------------
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "cl_field.h"
#include "mb_core.h"
#include "mb_internal.h"

namespace {

int g_pass = 0, g_fail = 0;

void Check(bool ok, const char* what, const std::string& detail) {
  std::printf("  [%s] %-52s %s\n", ok ? "PASS" : "FAIL", what, detail.c_str());
  if (ok) ++g_pass; else ++g_fail;
}

struct Scene {
  const char* name;
  const char* re;
  const char* im;
  double spanMant;
  int spanExp;
  int maxIter;
  int mode;        // 0 mandel, 1 julia
  int power;
  double jre, jim;
};

const Scene kScenes[] = {
    {"home view", "-0.6", "0", 1.6, 1, 2000, 0, 2, 0, 0},
    {"seahorse valley", "-0.7436438870371587", "0.1318259042053119", 4.0, -7, 4000, 0, 2, 0, 0},
    {"spiral bulb", "-0.745428", "0.113009", 4.0, -10, 6000, 0, 2, 0, 0},
    {"julia classic", "0", "0", 3.0, 0, 2000, 1, 2, -0.8, 0.156},
    {"cubic power 3", "-0.2", "0", 3.0, 0, 3000, 0, 3, 0, 0},
    {"rotated 30 deg", "-0.6", "0", 1.6, 1, 2000, 0, 2, 0, 0},
    /* Same shape as the home view but with a centre that is exactly
     * representable in binary, so the decimal -> double conversion cannot
     * introduce a one-ulp difference in c. */
    {"exact centre", "-0.5", "0", 1.5, 0, 2000, 0, 2, 0, 0},
};

mbc::Request RequestOf(const Scene& s, int w, int h) {
  mbc::Request req;
  req.centerRe = s.re;
  req.centerIm = s.im;
  req.spanMant = s.spanMant;
  req.spanExp = s.spanExp;
  req.width = w;
  req.height = h;
  req.viewWidth = w;
  req.viewHeight = h;
  req.maxIter = s.maxIter;
  req.quality = 2;
  req.aa = 1;
  req.fieldDist = true;
  req.rotation = std::strstr(s.name, "rotated") ? 0.5235987755982988 : 0.0;
  req.spec.mode = s.mode;
  req.spec.power = s.power;
  req.spec.juliaRe = s.jre;
  req.spec.juliaIm = s.jim;
  return req;
}

struct Diff {
  long long pixels = 0;
  long long escapedBoth = 0;
  long long escapeMismatch = 0;
  long long interiorMismatch = 0;
  long long interiorBoth = 0;
  long long periodMismatch = 0;
  int maxIterDelta = 0;
  double maxSmoothDelta = 0.0;
  double maxDistRel = 0.0;
  long long distCompared = 0;
};

bool RunScene(const Scene& sc, int w, int h, bool verbose, Diff* out) {
  const mbc::Request req = RequestOf(sc, w, h);

  mbc::Engine engine(0);
  mbc::Field cpu;
  cpu.resize(w, h, 4);
  mbc::Stats st;
  engine.renderField(req, cpu, st);

  clf::Tile t;
  t.w = w;
  t.h = h;
  t.fw = w;
  t.fh = h;
  t.cre = std::strtod(sc.re, nullptr);
  t.cim = std::strtod(sc.im, nullptr);
  t.px = mbc::pixelScale(req);
  t.rotC = std::cos(req.rotation);
  t.rotS = std::sin(req.rotation);
  t.julia = sc.mode;
  t.power = sc.power;
  t.maxIter = st.maxIterUsed > 0 ? st.maxIterUsed : sc.maxIter;
  t.wantDist = 1;
  t.jre = sc.jre;
  t.jim = sc.jim;

  std::vector<float> gpu((size_t)w * h * 4);
  if (!clf::compute(t, gpu.data())) {
    std::printf("  [FAIL] %-52s clf::compute: %s\n", sc.name, clf::lastError());
    ++g_fail;
    return false;
  }

  Diff d;
  d.pixels = (long long)w * h;
  std::vector<uint8_t> bad((size_t)w * h, 0);
  for (int y = 0; y < h; ++y) {
    const float* c = cpu.at(0, y);
    const float* g = &gpu[(size_t)y * w * 4];
    for (int x = 0; x < w; ++x, c += 4, g += 4) {
      const bool cIn = c[0] < 0.0f, gIn = g[0] < 0.0f;
      if (cIn != gIn) {
        ++d.interiorMismatch;
        bad[(size_t)y * w + x] = 1;
        continue;
      }
      if (cIn) {
        ++d.interiorBoth;
        if (std::fabs(c[0] - g[0]) > 1e-6f) ++d.periodMismatch;
        continue;
      }
      ++d.escapedBoth;
      const int ci = (int)lrintf(c[2]);
      const int gi = (int)lrintf(g[2]);
      const int delta = std::abs(ci - gi);
      if (delta != 0) {
        ++d.escapeMismatch;
        d.maxIterDelta = std::max(d.maxIterDelta, delta);
        bad[(size_t)y * w + x] = 1;
      }
    }
  }
  /* The continuous channels are compared only where the whole 3x3
   * neighbourhood escaped at the same iteration.  Next to a disagreement the
   * escape |z|^2 itself can differ by orders of magnitude (the orbit is one
   * squaring ahead), so including those pixels measures the disagreement
   * twice and says nothing about arithmetic accuracy. */
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      bool near = false;
      for (int dy = -1; dy <= 1 && !near; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
          const int nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (bad[(size_t)ny * w + nx]) { near = true; break; }
        }
      }
      if (near) continue;
      const float* c = cpu.at(0, y) + (size_t)x * 4;
      const float* g = &gpu[((size_t)y * w + x) * 4];
      if (c[0] < 0.0f || g[0] < 0.0f) continue;
      const double ds = std::fabs((double)c[0] - (double)g[0]);
      if (ds > d.maxSmoothDelta) d.maxSmoothDelta = ds;
      if (c[1] > 0.0f && g[1] > 0.0f) {
        const double rel = std::fabs((double)c[1] - (double)g[1]) / (double)c[1];
        if (rel > d.maxDistRel) d.maxDistRel = rel;
        ++d.distCompared;
      }
    }
  }
  if (out) *out = d;

  if (!verbose) return true;

  char buf[256];
  const double mismatchPct = 100.0 * (double)d.escapeMismatch / (double)std::max(1LL, d.escapedBoth);
  std::snprintf(buf, sizeof(buf), "%lld px, iter=%d, escape mismatch %.3f%% (max |dn|=%d)",
                d.pixels, t.maxIter, mismatchPct, d.maxIterDelta);
  Check(mismatchPct < 0.05, (std::string(sc.name) + ": escape count").c_str(), buf);

  std::snprintf(buf, sizeof(buf), "max |d smoothiter| = %.3g inside agreement regions",
                d.maxSmoothDelta);
  Check(d.maxSmoothDelta < 1e-6, (std::string(sc.name) + ": smooth iteration").c_str(), buf);

  std::snprintf(buf, sizeof(buf), "max rel = %.3g over %lld px", d.maxDistRel, d.distCompared);
  Check(d.distCompared == 0 || d.maxDistRel < 1e-6,
        (std::string(sc.name) + ": distance estimate").c_str(), buf);

  const double interiorPct = 100.0 * (double)d.interiorMismatch / (double)std::max(1LL, d.pixels);
  std::snprintf(buf, sizeof(buf), "%lld interior px, %lld disagree on region",
                d.interiorBoth, d.interiorMismatch);
  Check(interiorPct < 0.02, (std::string(sc.name) + ": interior region").c_str(), buf);

  if (d.interiorBoth > 0 && sc.power == 2 && sc.mode == 0) {
    const double perPct = 100.0 * (double)d.periodMismatch / (double)d.interiorBoth;
    std::snprintf(buf, sizeof(buf), "%lld of %lld interior px carry a different period",
                  d.periodMismatch, d.interiorBoth);
    // Only the analytic cardioid / period-2 bulbs are guaranteed; higher
    // periods come from the CPU's Brent finder, which the kernel does not run.
    Check(perPct < 1.0, (std::string(sc.name) + ": interior period").c_str(), buf);
  }
  return true;
}

/* A deliberately dumb scalar reference: the same recurrence, the same bailout,
 * the same smooth-iteration form, in plain C++ doubles.  If the kernel cannot
 * match THIS, the kernel is wrong; if it matches this but not the engine, the
 * engine is doing something cleverer than plain double (FMA contraction,
 * four-lane scheduling, canvas interpolation) and that is a known, measurable
 * difference rather than a bug. */
/* MSVC contracts a*b+c into FMA under /O2 /arch:AVX2 even at /fp:precise, and
 * a fused rounding is not the same function as two rounded operations.  Going
 * through a volatile forces the intermediate to be stored, which is exactly
 * "round after every operation" — the semantics the kernel gets for free
 * because OpenCL only fuses when told to. */
inline double Mul(double a, double b) {
  volatile double t = a * b;
  return t;
}
inline double Sub(double a, double b) {
  volatile double t = a - b;
  return t;
}
inline double Add(double a, double b) {
  volatile double t = a + b;
  return t;
}

void ScalarRef(const Scene& sc, int w, int h, int maxIter, float* out) {
  mbc::Request req;
  req.centerRe = sc.re;
  req.centerIm = sc.im;
  req.spanMant = sc.spanMant;
  req.spanExp = sc.spanExp;
  req.width = w;
  req.height = h;
  req.viewWidth = w;
  req.viewHeight = h;
  req.rotation = std::strstr(sc.name, "rotated") ? 0.5235987755982988 : 0.0;
  const double px = mbc::pixelScale(req);
  const double rot = req.rotation;
  const double rotC = std::cos(rot), rotS = std::sin(rot);
  const double cre = std::strtod(sc.re, nullptr);
  const double cim = std::strtod(sc.im, nullptr);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const double fx = (double)x;
      const double fy = (double)y;
      const double halfW = 0.5 * (double)w;
      const double halfH = 0.5 * (double)h;
      const double ax = Add(fx, 0.5);
      const double bx = Sub(ax, halfW);
      const double sx = Mul(bx, px);
      const double ay = Sub(halfH, fy);
      const double by = Sub(ay, 0.5);
      const double sy = Mul(by, px);
      const double sxr = Mul(sx, rotC);
      const double syr = Mul(sy, rotS);
      const double dr = Sub(sxr, syr);
      const double sxi = Mul(sx, rotS);
      const double syi = Mul(sy, rotC);
      const double di = Add(sxi, syi);
      double cr, ci, zr, zi, derr, deri;
      if (sc.mode) {
        cr = sc.jre; ci = sc.jim;
        zr = Add(cre, dr); zi = Add(cim, di);
        derr = 1.0; deri = 0.0;
      } else {
        cr = Add(cre, dr); ci = Add(cim, di);
        zr = zi = 0.0;
        derr = deri = 0.0;
      }
      /* The kernel applies the analytic cardioid / period-2 test before it
       * iterates anything.  The reference must do the same, otherwise it
       * "escapes" pixels the kernel correctly calls interior and the diff is
       * dominated by the main bulb instead of by arithmetic. */
      if (!sc.mode && sc.power == 2) {
        const double qx = cr - 0.25, qy2 = ci * ci;
        const double qq = qx * qx + qy2;
        int per = 0;
        if (qq * (qq + qx) <= 0.25 * qy2) per = 1;
        else if ((cr + 1.0) * (cr + 1.0) + qy2 <= 0.0625) per = 2;
        if (per) {
          float* f0 = out + ((size_t)y * w + x) * 4;
          f0[0] = -(float)per; f0[1] = 0.0f; f0[2] = -(float)per; f0[3] = 0.0f;
          continue;
        }
      }
      int n = 0;
      double m2 = 0.0;
      double pzr = zr, pzi = zi;
      for (; n < maxIter; ++n) {
        m2 = Add(Mul(zr, zr), Mul(zi, zi));
        if (m2 > 4294967296.0) break;
        const double odr = Add(Mul(2.0 * zr, derr), -Mul(2.0 * zi, deri)) +
                           (sc.mode ? 0.0 : 1.0);
        const double odi = Add(Mul(2.0 * zr, deri), Mul(2.0 * zi, derr));
        derr = odr; deri = odi;
        pzr = zr; pzi = zi;
        double nzr, nzi;
        if (sc.power == 2) {
          nzr = Add(Sub(Mul(zr, zr), Mul(zi, zi)), cr);
          nzi = Add(Mul(2.0 * zr, zi), ci);
        } else {
          double rr = 1.0, ri = 0.0, br = zr, bi = zi;
          int e = sc.power;
          while (e > 0) {
            if (e & 1) {
              const double t = Sub(Mul(rr, br), Mul(ri, bi));
              ri = Add(Mul(rr, bi), Mul(ri, br));
              rr = t;
            }
            const double t2 = Sub(Mul(br, br), Mul(bi, bi));
            bi = Mul(2.0 * br, bi);
            br = t2;
            e >>= 1;
          }
          nzr = Add(rr, cr); nzi = Add(ri, ci);
        }
        zr = nzr; zi = nzi;
      }
      float* f = out + ((size_t)y * w + x) * 4;
      if (n >= maxIter) {
        const double dzr = zr - pzr, dzi = zi - pzi;
        int per = 0;
        if (dzr * dzr + dzi * dzi < 1e-24 * (1.0 + m2)) per = 1;
        const float enc = per ? -(float)per : -1e-30f;
        f[0] = enc; f[1] = 0.0f; f[2] = enc; f[3] = 0.0f;
      } else {
        const double l2 = std::log2(m2);
        const double nu = (double)n - std::log2(std::max(l2, 1e-9));
        float dist = 0.0f;
        const double der2 = derr * derr + deri * deri;
        if (der2 > 0.0) {
          const double p = std::sqrt(m2) * (0.5 * std::log(m2)) / std::sqrt(der2) / px;
          if (std::isfinite(p) && p > 0.0) dist = (float)p;
        }
        f[0] = (float)nu; f[1] = dist; f[2] = (float)n; f[3] = 0.0f;
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * Deep-zoom stage: the perturbation kernel against the CPU core at 1e-660.
 *
 * The reference orbit is rebuilt here exactly the way the engine builds it
 * (same bit count, same Taylor series), but anchored at the frame centre so
 * the GPU tile can be compared against the engine's field pixel for pixel.
 * Pixels the GPU reference cannot describe are marked w = -1 and excluded;
 * the CPU engine repairs those with arbitrary precision instead.
 * ------------------------------------------------------------------------- */
struct DeepScene {
  const char* name;
  const char* re;
  const char* im;
  int spanExp;
  int kind;
  int power;
  int maxIter;
};

const DeepScene kDeepScenes[] = {
    {"seahorse 1e-660", "-0.7436438870371587", "0.1318259042053119",
     -2192, 0, 2, 6000},
    {"outside cusp 1e-660", "0.250001", "0", -2192, 0, 2, 6000},
    {"burning ship 1e-660", "-1.75", "0", -2192, 2, 2, 6000},
};

bool RunDeepScene(const DeepScene& s, int w, int h) {
  mbc::Request q;
  q.centerRe = s.re;
  q.centerIm = s.im;
  q.spanMant = 1.0;
  q.spanExp = s.spanExp;
  q.width = w;
  q.height = h;
  q.viewWidth = w;
  q.viewHeight = h;
  q.maxIter = s.maxIter;
  q.quality = 0;
  q.aa = 1;
  q.fieldDist = true;
  q.spec.kind = s.kind;
  q.spec.power = s.power;

  mbc::Engine engine(0);
  mbc::Field cpu;
  cpu.resize(w, h, 4);
  mbc::Stats st;
  engine.renderField(q, cpu, st);
  /* maxIterUsed is the largest escape count the engine wrote; the kernel is
   * allowed one more step to observe that escape. */
  const int maxIter =
      st.maxIterUsed > 0 ? st.maxIterUsed + 1 : s.maxIter;

  const double psLog2 = mbc::pixelScaleLog2(q);
  const int bits = mbc::requiredBits(psLog2, maxIter);
  mbc::detail::Ref R;
  if (mbc::detail::buildReference(q, bits, maxIter, 0.0, 0.0, &R, nullptr, 0) <
      0) {
    Check(false, (std::string(s.name) + ": reference orbit").c_str(),
          "buildReference failed");
    return false;
  }
  R.dRe = 0.0;
  R.dIm = 0.0;
  mbc::detail::buildFolds(R, s.kind);
  const bool fam = s.kind != 0 || s.power != 2;
  if (fam) mbc::detail::buildDevTable(R, s.power);
  const double dcMaxLog2 =
      psLog2 + std::log2(std::hypot((double)w, (double)h) + 1.0);
  mbc::detail::buildSeries(R, dcMaxLog2, true, s.power, s.kind);
  if (R.len <= 0) {
    Check(false, (std::string(s.name) + ": reference orbit").c_str(),
          "empty orbit");
    return false;
  }

  clf::PerturbTile t;
  t.w = w;
  t.h = h;
  t.fw = w;
  t.fh = h;
  t.maxIter = maxIter;
  t.rotC = 1.0;
  t.rotS = 0.0;
  t.kind = s.kind;
  t.power = s.power;
  t.dynSkip = 1;
  t.wantDist = 1;
  t.phoenixP = q.spec.phoenixP;
  mbc::pixelScaleParts(q, t.psMant, t.psExp);
  t.psPixels = mbc::pixelScale(q);
  t.dRe = R.dRe;
  t.dIm = R.dIm;
  t.orbit.re = R.re.data();
  t.orbit.im = R.im.data();
  t.orbit.ar = R.ar.data();
  t.orbit.ai = R.ai.data();
  t.orbit.br = R.br.data();
  t.orbit.bi = R.bi.data();
  t.orbit.cr = R.cr.data();
  t.orbit.ci = R.ci.data();
  t.orbit.aExp = R.aExp.data();
  t.orbit.bExp = R.bExp.data();
  t.orbit.cExp = R.cExp.data();
  t.orbit.dcthLog = R.dcthLog.data();
  t.orbit.jr = R.jr.data();
  t.orbit.ji = R.ji.data();
  t.orbit.hr = R.hr.data();
  t.orbit.hi = R.hi.data();
  t.orbit.kr = R.kr.data();
  t.orbit.ki = R.ki.data();
  t.orbit.fR = R.fR.data();
  t.orbit.fI = R.fI.data();
  t.orbit.len = R.len;
  t.orbit.skip = R.skip;
  t.orbit.derSkip = R.derSkip;
  t.orbit.z0r = R.z0r;
  t.orbit.z0i = R.z0i;

  std::vector<float> gpu((size_t)w * h * 4);
  int glitches = 0;
  if (!clf::computePerturb(t, gpu.data(), &glitches)) {
    Check(false, (std::string(s.name) + ": perturb kernel").c_str(),
          clf::lastError());
    return false;
  }
  const double gpuMs = clf::lastMs();
  if (std::getenv("MB_GPUCHECK_DIAG")) {
    const float* c0 = cpu.at(0, 0);
    std::printf("    diag: maxIterUsed=%d R.len=%d escaped=%d lastRef=(%g,%g)\n"
                "          cpu0=(%g,%g,%g) gpu0=(%g,%g,%g,%g)\n",
                st.maxIterUsed, R.len, (int)R.escaped,
                R.re.empty() ? 0.0 : R.re.back(),
                R.im.empty() ? 0.0 : R.im.back(),
                c0[0], c0[1], c0[2], gpu[0], gpu[1], gpu[2], gpu[3]);
  }

  long long compared = 0, escapeMismatch = 0, escapedBoth = 0;
  long long interiorBoth = 0, distCompared = 0;
  int maxIterDelta = 0;
  double maxSmoothDelta = 0.0, maxDistRel = 0.0;
  for (int y = 0; y < h; ++y) {
    const float* c = cpu.at(0, y);
    const float* g = &gpu[(size_t)y * w * 4];
    for (int x = 0; x < w; ++x, c += 4, g += 4) {
      if (g[3] == -1.0f) continue;   // GPU glitch, repaired by the CPU
      ++compared;
      const bool cIn = c[0] < 0.0f;
      const bool gIn = g[0] < 0.0f;
      if (cIn != gIn) {
        ++escapeMismatch;
        continue;
      }
      if (cIn) {
        ++interiorBoth;
        continue;
      }
      ++escapedBoth;
      const int ci = (int)lrintf(c[2]);
      const int gi = (int)lrintf(g[2]);
      const int delta = std::abs(ci - gi);
      if (delta != 0) {
        ++escapeMismatch;
        maxIterDelta = std::max(maxIterDelta, delta);
      }
      const double ds = std::fabs((double)c[0] - (double)g[0]);
      maxSmoothDelta = std::max(maxSmoothDelta, ds);
      if (c[1] > 0.0f && g[1] > 0.0f) {
        const double rel =
            std::fabs((double)c[1] - (double)g[1]) / (double)c[1];
        maxDistRel = std::max(maxDistRel, rel);
        ++distCompared;
      }
    }
  }

  const double pxTotal = (double)w * h;
  const double glitchPct = 100.0 * (double)glitches / pxTotal;
  const double escPct = 100.0 * (double)escapeMismatch / (double)compared;
  char buf[320];
  std::snprintf(buf, sizeof(buf),
                "bits=%d refLen=%d skip=%d glitch=%d (%.2f%%), %.1f ms GPU vs "
                "%.1f ms CPU",
                bits, R.len, R.skip, glitches, glitchPct, gpuMs, st.renderMs);
  std::printf("  %-24s %s\n", s.name, buf);
  std::snprintf(buf, sizeof(buf),
                "%lld px compared, %.3f%% escape disagreement (max |dn|=%d)",
                compared, escPct, maxIterDelta);
  Check(glitchPct < 1.0 && escPct < 0.1, (std::string(s.name) + ": classification").c_str(), buf);
  std::snprintf(buf, sizeof(buf), "max |d smoothiter| = %.3g", maxSmoothDelta);
  Check(maxSmoothDelta < 1e-4, (std::string(s.name) + ": smooth iteration").c_str(),
        buf);
  std::snprintf(buf, sizeof(buf), "max rel = %.3g over %lld px", maxDistRel,
                distCompared);
  Check(distCompared == 0 || maxDistRel < 1e-6,
        (std::string(s.name) + ": distance estimate").c_str(), buf);
  return true;
}

void Bench() {
  struct Case { const char* name; int w, h, iter; };
  const Case cases[] = {{"1280x800 home", 1280, 800, 2000},
                        {"1920x1080 home", 1920, 1080, 2000},
                        {"1280x800 deep", 1280, 800, 4000}};
  for (const Case& c : cases) {
    const bool deep = std::strstr(c.name, "deep") != nullptr;
    mbc::Request req;
    req.centerRe = deep ? "-0.7436438870371587" : "-0.6";
    req.centerIm = deep ? "0.1318259042053119" : "0";
    req.spanMant = deep ? 4.0 : 1.6;
    req.spanExp = deep ? -7 : 1;
    req.width = c.w;
    req.height = c.h;
    req.viewWidth = c.w;
    req.viewHeight = c.h;
    req.maxIter = c.iter;
    req.quality = 2;
    req.aa = 1;
    mbc::Engine engine(0);
    mbc::Field cpu;
    cpu.resize(c.w, c.h, 4);
    mbc::Stats st;
    engine.renderField(req, cpu, st);

    clf::Tile t;
    t.w = c.w;
    t.h = c.h;
    t.fw = c.w;
    t.fh = c.h;
    t.cre = std::strtod(req.centerRe.c_str(), nullptr);
    t.cim = std::strtod(req.centerIm.c_str(), nullptr);
    t.px = mbc::pixelScale(req);
    t.maxIter = st.maxIterUsed;
    std::vector<float> gpu((size_t)c.w * c.h * 4);
    double gpuMs = 0.0;
    for (int rep = 0; rep < 3; ++rep) {
      clf::compute(t, gpu.data());
      gpuMs = rep == 2 ? clf::lastMs() : gpuMs;
    }
    std::printf("  %-18s CPU %7.1f ms (%d thr)   GPU %7.1f ms (%lld px/s)\n",
                c.name, st.renderMs, st.threads, gpuMs,
                (long long)((double)c.w * c.h / (gpuMs * 1e-3)));
  }
}

}  // namespace

int main(int argc, char** argv) {
  std::printf("=== mb_gpucheck: CPU core vs OpenCL kernel ===\n\n");
  if (!clf::init(nullptr, nullptr)) {
    std::printf("  [SKIP] OpenCL unavailable: %s\n", clf::lastError());
    return 2;
  }
  const clf::Caps& c = clf::caps();
  std::printf("  device: %s\n  driver: %s\n  version: %s\n  CUs: %d @ %d MHz\n\n",
              c.device.c_str(), c.driver.c_str(), c.version.c_str(),
              c.computeUnits, c.clockMHz);

  if (argc > 1 && std::strcmp(argv[1], "bench") == 0) {
    Bench();
    clf::shutdown();
    return 0;
  }

  const int w = 512, h = 384;

  /* Stage 1: the kernel against a scalar double reference.  This is the test
   * that says whether the OpenCL code is CORRECT; everything after it is a
   * measurement of how far the engine's own optimisations move the picture. */
  std::printf("[kernel vs scalar reference] %dx%d\n", w, h);
  for (const Scene& s : kScenes) {
    std::vector<float> ref((size_t)w * h * 4);
    ScalarRef(s, w, h, s.maxIter, ref.data());
    const mbc::Request rq = RequestOf(s, w, h);
    clf::Tile t;
    t.w = w; t.h = h; t.fw = w; t.fh = h;
    t.cre = std::strtod(s.re, nullptr);
    t.cim = std::strtod(s.im, nullptr);
    t.px = mbc::pixelScale(rq);
    t.rotC = std::cos(rq.rotation);
    t.rotS = std::sin(rq.rotation);
    t.julia = s.mode; t.power = s.power; t.maxIter = s.maxIter; t.wantDist = 1;
    t.jre = s.jre; t.jim = s.jim;
    std::vector<float> gpu((size_t)w * h * 4);
    clf::compute(t, gpu.data());
    long long bad = 0, badSmooth = 0, badDist = 0;
    double worstS = 0.0, worstD = 0.0;
    int shown = 0;
    for (size_t i = 0; i < (size_t)w * h; ++i) {
      const float* a = &ref[i * 4];
      const float* b = &gpu[i * 4];
      if ((a[0] < 0.0f) != (b[0] < 0.0f) || (int)lrintf(a[2]) != (int)lrintf(b[2])) {
        if (shown < 6 && std::getenv("MB_GPUCHECK_DIAG")) {
          std::printf("      px(%d,%d) ref[%g %g %g] gpu[%g %g %g]\n",
                      (int)(i % (size_t)w), (int)(i / (size_t)w),
                      a[0], a[1], a[2], b[0], b[1], b[2]);
          ++shown;
        }
        ++bad;
        continue;
      }
      if (a[0] < 0.0f) continue;
      const double ds = std::fabs((double)a[0] - (double)b[0]);
      if (ds > 1e-4) ++badSmooth;
      if (ds > worstS) worstS = ds;
      if (a[1] > 0.0f && b[1] > 0.0f) {
        const double rd = std::fabs((double)a[1] - (double)b[1]) / (double)a[1];
        if (rd > 1e-9) ++badDist;
        if (rd > worstD) worstD = rd;
      }
    }
    char buf[256];
    std::snprintf(buf, sizeof(buf), "%lld px, %lld differ, smooth %g, dist rel %g",
                  (long long)w * h, bad, worstS, worstD);
    Check(bad == 0 && badSmooth == 0 && badDist == 0,
          (std::string(s.name) + ": kernel == scalar double").c_str(), buf);
  }

  std::printf("\n[fields] engine vs kernel, %dx%d per scene\n", w, h);
  for (const Scene& s : kScenes) RunScene(s, w, h, true, nullptr);

  std::printf("\n[deep perturbation] 1e-660, 256x192\n");
  if (!clf::supportsPerturb(0, 2) || !clf::supportsPerturb(2, 2)) {
    std::printf("  [SKIP] perturbation kernel unavailable: %s\n",
                clf::lastError());
  } else {
    for (const DeepScene& s : kDeepScenes) RunDeepScene(s, 256, 192);
  }

  std::printf("\n[precision envelope]\n");
  struct Lim { const char* what; double px; bool want; };
  const Lim lims[] = {{"2^-20 (deep-ish)", 9.5367431640625e-7, true},
                      {"2^-39", 1.8189894035458565e-12, true},
                      {"2^-41 (beyond double)", 4.5474735088646412e-13, false},
                      {"2^-60", 8.6736173798840355e-19, false}};
  for (const Lim& l : lims) {
    char buf[128];
    std::snprintf(buf, sizeof(buf), "supports(px=%.4g) = %s", l.px,
                  clf::supports(l.px, 2) ? "true" : "false");
    Check(clf::supports(l.px, 2) == l.want, l.what, buf);
  }

  std::printf("\n[throughput]\n");
  Bench();

  std::printf("\nRESULT: %d passed, %d failed\n", g_pass, g_fail);
  clf::shutdown();
  return g_fail == 0 ? 0 : 1;
}
