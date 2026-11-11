// ------------------------------------------------------------------
// mb_internal.h — everything the renderer's own translation units share.
//
// The pipeline is split the way the reference program is split, one file per
// stage, and this header is the seam between them:
//
//   mb_orbit.cpp    reference orbit, Taylor coefficients, anchor probing
//   mb_kernels.cpp  the per-pixel recurrences (scalar, family, AVX2 x4)
//   mb_palette.cpp  pal()/ramp lookup tables, tone stage, mip chains
//   mb_engine.cpp   tiling, thread pool, canvas interpolation, Engine facade
//
// Types live here; the pure arithmetic helpers stay inline because they are
// two or three lines and are called from the inner loops of more than one
// unit.  Anything with a loop in it is a declaration only: a header full of
// inline kernels is how a 4 000-line file turns into a 40 000-line object.
//
// Order matters below — a type must precede the helper that mentions it — so
// the layout is: constants -> globals -> orbit -> palette tables -> context ->
// math -> kernel/table declarations.
// ------------------------------------------------------------------
#pragma once

#include "mb_core.h"
#include "mb_precision.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#if defined(__AVX2__)
#include <immintrin.h>
#endif

namespace mbc {
namespace detail {

extern const Palette kFallbackPalette;
inline std::atomic<long long> g_rebaseCount{0};
inline std::atomic<long long> g_quadReb{0};   // re-anchors done by the vector kernel
constexpr double kLn2 = 0.69314718055994530942;
constexpr double kBail = 65536.0;        // escape radius, 2^16
constexpr double kBail2 = kBail * kBail;
constexpr int kEscapeExp = 16;           // log2 of the escape radius
constexpr int kMaxExtraRefs = 4;         // references added by the repair pass
constexpr double kSkipTolDefault = 1e-3;  // series-approximation relative error
/* The reference has no series approximation at all, so this threshold is ours
 * to choose.  It bounds |B|dc^2 and |C|dc^3 against |A|dc, i.e. the error the
 * skipped steps introduce relative to the linear term.  MB_SKIPTOL makes it
 * measurable instead of a guess. */
inline double kSkipTol() {
  static const double v = [] {
    const char* s = std::getenv("MB_SKIPTOL");
    const double d = s ? std::atof(s) : kSkipTolDefault;
    return d > 0.0 ? d : kSkipTolDefault;
  }();
  return v;
}
/* Stage accounting, off by default.  Counting is what turns "the app feels
 * slower than the bench" into a number; nothing here changes the picture. */
namespace {
struct Prof {
  bool on;
  std::chrono::steady_clock::time_point t0;
  double orbit = 0, lut = 0, canvas = 0, pixel = 0, aa = 0;
  Prof() : on(std::getenv("MB_PROFILE") != nullptr), t0(std::chrono::steady_clock::now()) {}
  double ms() const {
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now() - t0).count();
  }
};
}  // namespace

/* One reference orbit plus the Taylor coefficients of the deviation.
 *
 * `ar/ai`, `br/bi` are the linear and quadratic terms of
 *     d_n ~ A_n * dc + B_n * dc^2
 * A_{n+1} = 2 Z_n A_n,  B_{n+1} = 2 Z_n B_n + A_n^2.
 * They are evaluated once per frame and let every pixel start at `skip`
 * instead of at 0, which is where most of the deep-zoom speed comes from. */
struct Ref {
  std::vector<double> re, im;             // Z_n
  std::vector<double> ar, ai, br, bi;     // series coefficients (order 1, 2)
  std::vector<double> cr, ci;             // order 3
  /* Per-iteration Taylor data of the family map,
   *     d_{n+1} = F_n ( J_n d_n + H_n d_n^2 ) + dc
   * F_n is a diagonal sign flip: identity, conjugate, |Re| or |Im| fold.
   * For z^2 all five formulas differ *only* in F_n, which is why one kernel
   * can drive every family.  p > 2 stores J = p Z^(p-1), H = C(p,2) Z^(p-2). */
  std::vector<double> jr, ji, hr, hi;
  /* Third-order coefficient K = C(p,3) Z^(p-3) of the same expansion.  For
   * p = 4..8 the family step is then exact through d^3; for p = 3 it is exact
   * outright.  Only filled when power > 2. */
  std::vector<double> kr, ki;
  /* Per-iteration fold of the family map (+1 / -1 per component).  The series
   * has to compose through the *same* flips the pixel kernel will apply, or
   * the skipped iterations would describe a different formula. */
  std::vector<int8_t> fR, fI;
  /* Skip length that is still valid at a given |dc|: the series may start
   * later for points near the anchor, so every pixel gets its own start. */
  std::vector<float> dcth;
  int len = 0;
  int skip = 0;
  bool escaped = false;
  double z0r = 0.0, z0i = 0.0;            // Z_0 (0 for Mandelbrot, seed for Julia)
  double dRe = 0.0, dIm = 0.0;            // plane offset from the view centre
};

/* Mip chain of a palette table.  Level 0 is the exact table; level k is the
 * box average of 2^k neighbouring entries.  Sampling level k is how the
 * renderer asks for "the mean colour of the phase interval this pixel covers"
 * in constant time, which is what stops bands finer than a pixel from turning
 * into moiré.  Averaging in *palette phase* (rather than in screen space) is
 * the right domain: the aliasing comes from the palette being sampled below
 * its own frequency, not from the geometry. */
struct Mip {
  std::vector<std::vector<float>> lv;
  int base = 0;
  bool cyclic = false;
};


struct Ctx {
  const Request* q = nullptr;
  double ps = 1.0;                        // plane units per pixel
  double halfW = 0.0, halfH = 0.0;        // frame centre, in pixels
  double cre = 0.0, cim = 0.0;            // centre as double (direct path)
  double jr = 0.0, ji = 0.0;              // Julia seed (direct path)
  bool julia = false;
  int kind = 0;
  int power = 2;
  int maxIter = 1;
  const Palette* pal = nullptr;
  int colorMode = 0;
  bool wantDist = false;                  // colour schemes 2/3 need |z'|
  /* `wantDist` also gates the AVX2 quad kernels, whose cycle detection is
   * weaker than the scalar kernel's.  A field pass whose shader declares no
   * DIST/DIST2 channel must therefore keep `wantDist` true (so the pixel path
   * does not change) while still skipping the derivative recurrence. */
  bool skipDeriv = false;
  /* The raster needs z at the escape point for the VALUE colour channel but
   * not dz/dc, and asking for a probe used to force the derivative
   * recurrence on.  `zOnly` keeps the probe cheap: the kernel still records
   * z, `walkDer` stays off. */
  bool zOnly = false;
  double offset = 0.0;                    // palette phase, cycles
  double iterPerCycle = 1.0;              // iterations per palette cycle
  const float* grad = nullptr;            // 256*3 ramp, already tone-mapped
  const Mip* gradMip = nullptr;           // mip chain of that ramp
  /* The additive pal() is a function of one number (the iteration count), so
   * one table per frame replaces P.n sinusoids per pixel. */
  const float* palLut = nullptr;
  int palLutN = 0;
  double palLutScale = 0.0;               // iteration count -> table index
  const Mip* palMip = nullptr;            // mip chain of that table
  double palMipPerCycle = 0.0;            // level-0 entries per palette cycle
  int detail = 3;                         // 0..3, see Request::detail
  const std::vector<Ref>* refs = nullptr;
  bool fam = false;                       // general family kernel (kinds 1..4, p>2)
  bool dynSkip = true;                    // per-pixel series start
  /* View rotation, as a rotation matrix applied to the plane offset.
   *
   * A rotation is rigid, so it changes nothing else: the pixel scale, the
   * precision demand and the reference orbit are all unaffected.  It only has
   * to be applied where a screen pixel becomes a plane offset, which is why
   * that conversion lives in one function below instead of being written out
   * at each kernel.  The reference program stores the angle in every one of
   * its shipped presets; without it an imported view comes back turned. */
  double rotC = 1.0, rotS = 0.0;

  /* ---- orbit traps ----
   *
   * A trap is a property of the *orbit*, not of the escape count, so it cannot
   * be recovered from the field the colour stage already has.  The kernel
   * accumulates it while it is walking the orbit anyway, which costs three
   * floating-point operations per iteration and nothing at all when off.
   *
   * The result travels in the field's fourth channel (`dist2`), which is a
   * duplicate of `dist` today: one selected trap mode per frame, so one slot
   * is enough.  See Field in mb_core.h. */
  bool wantTrap = false;
  int trapMode = 1;                       // 1 point / 2 line / 3 circle / 4 TIA
};

/* Per-thread trap accumulator.
 *
 * This used to be a `mutable` member of Ctx, and Ctx is shared by every
 * render thread — so fifteen threads seeded, accumulated and read the same
 * double.  The visible result was exactly what a race produces: the
 * "Triangle average (TIA)" pattern loaded as garbage, and at high zoom the
 * whole frame filled with noise.  The kernel writes one value per pixel and
 * the engine reads it immediately after that pixel returns, all on one
 * thread, so thread-local storage is the correct scope; nothing outside the
 * pixel path ever looks at it. */
inline double& trapAcc() {
  static thread_local double v = 0.0;
  return v;
}

/* Screen pixel -> plane offset from the frame centre, rotation included. */
inline void screenDelta(const Ctx& g, double fx, double fy, double& dr,
                        double& di) {
  const double x = (fx + 0.5 - g.halfW) * g.ps;
  const double y = (g.halfH - fy - 0.5) * g.ps;
  dr = x * g.rotC - y * g.rotS;
  di = x * g.rotS + y * g.rotC;
}

/* Analytic interior of z^2+c: the main cardioid and the period-2 disc.
 *
 * A point in either can never escape, so iterating it maxIter times is pure
 * waste.  On the home frame those pixels are a quarter of the picture and
 * roughly four fifths of all the iterations the engine performs.  They are
 * reported as bounded with no detected period, which is what the scalar
 * kernel returns for almost all of them; a frame-wide diff against the
 * unoptimised kernel shows 0.12% of pixels differing by at most 7/255
 * (the handful whose periodicity check did fire).  Only the Mandelbrot
 * (not Julia) z^2+c family has this interior. */

inline const bool g_noBulb = std::getenv("MB_NOBULB") != nullptr;
/* Period of a point that lies in one of the two analytic interior regions, or
 * 0 when it lies in neither.
 *
 * Returning *which* bulb it is rather than a bare "inside" matters: the
 * reference encodes an interior pixel as -period, and its colour schemes draw
 * `pal(-iter+0.5)`.  The old shortcut reported "bounded, no period" (period 0)
 * for the whole cardioid and the period-2 disc, which is a quarter of a home
 * frame and, since the clock-style schemes colour by period, painted all of it
 * with period 0 — i.e. whichever branch of their mod table starts at zero. */
inline int interiorPeriod(double cr, double ci) {
  const double x = cr - 0.25;
  const double y2 = ci * ci;
  const double q = x * x + y2;
  if (q * (q + x) <= 0.25 * y2) return 1;
  const double u = cr + 1.0;
  if ((u * u + y2) <= 0.0625) return 2;
  return 0;
}
inline bool insideMainBulbs(double cr, double ci) {
  return interiorPeriod(cr, ci) != 0;
}

inline int expOf(const Big& b) { return b.bitLength() - b.fracBits(); }

/* z -> z^power by binary exponentiation.  Only the direct path calls this,
 * where the cost is irrelevant next to the iteration itself. */
inline void cpow(double& zr, double& zi, int p) {
  if (p == 2) {
    const double t = zr * zr - zi * zi;
    zi = 2.0 * zr * zi;
    zr = t;
    return;
  }
  double rr = 1.0, ri = 0.0;
  double br = zr, bi = zi;
  int e = p;
  while (e > 0) {
    if (e & 1) {
      const double t = rr * br - ri * bi;
      ri = rr * bi + ri * br;
      rr = t;
    }
    const double t = br * br - bi * bi;
    bi = 2.0 * br * bi;
    br = t;
    e >>= 1;
  }
  zr = rr;
  zi = ri;
}

/* --- family maps ----------------------------------------------------
 *
 * kind 0  z^p + c                    Mandelbrot / Julia / multibrot
 * kind 1  conj(z)^p + c              tricorn
 * kind 2  (|Re z| + i|Im z|)^p + c   burning ship
 * kind 3  |Re(z^p)| + i Im(z^p) + c  celtic
 * kind 4  z^p + conj(c)              perpendicular
 *
 * All five are "square (or power) then add c", differing only in a diagonal
 * sign flip applied to z before the power and/or to the result after it.
 * ------------------------------------------------------------------- */

inline Big absBig(const Big& v) { return v.isNegative() ? v.negated() : v; }

inline void cpowBig(const Big& zr, const Big& zi, int p, Big& orr, Big& oii) {
  const int fb = zr.fracBits();
  Big rr = Big::fromInteger(1, fb), ri = Big::fromInteger(0, fb);
  Big br = zr, bi = zi;
  int e = p;
  while (e > 0) {
    if (e & 1) {
      const Big t = rr.mul(br).sub(ri.mul(bi));
      ri = rr.mul(bi).add(ri.mul(br));
      rr = t;
    }
    const Big t = br.mul(br).sub(bi.mul(bi));
    bi = br.mul(bi).shifted(1);
    br = t;
    e >>= 1;
  }
  orr = rr;
  oii = ri;
}

/* One step of the family map in arbitrary precision. */
inline void famStepBig(int kind, int power, Big& zr, Big& zi, const Big& cr,
                       const Big& ci) {
  Big xr = zr, xi = zi;
  if (kind == 1) {
    xi = xi.negated();
  } else if (kind == 2) {
    xr = absBig(xr);
    xi = absBig(xi);
  }
  Big pr, pi;
  cpowBig(xr, xi, power, pr, pi);
  if (kind == 3) pr = absBig(pr);
  if (kind == 2) {
    zr = pr.sub(cr);
    zi = pi.add(ci);
  } else if (kind == 4) {
    zr = pr.add(cr);
    zi = pi.sub(ci);
  } else {
    zr = pr.add(cr);
    zi = pi.add(ci);
  }
}

/* The same step in double, used by the anchor probe and the direct kernel. */
inline void famStepD(int kind, int power, double& zr, double& zi, double cr,
                     double ci) {
  double xr = zr, xi = zi;
  if (kind == 1) {
    xi = -xi;
  } else if (kind == 2) {
    xr = std::fabs(xr);
    xi = std::fabs(xi);
  }
  cpow(xr, xi, power);
  if (kind == 3) xr = std::fabs(xr);
  if (kind == 2) {
    zr = xr - cr;
    zi = xi + ci;
  } else if (kind == 4) {
    zr = xr + cr;
    zi = xi - ci;
  } else {
    zr = xr + cr;
    zi = xi + ci;
  }
}

struct Pick {
  double dRe = 0.0, dIm = 0.0;
  int len = 0;
  bool valid = false;
};


constexpr int kCycleChk = 12;

/* "The reference could not describe this pixel" sentinel.
 *
 * It used to be -2, which collided with the interior encoding the moment the
 * analytic bulb path started reporting a real period: a point of period 1 is
 * -1 - 1 = -2, i.e. indistinguishable from a glitch.  Moving the sentinel far
 * outside the range a period can occupy keeps the two apart — a period is at
 * most the iteration cap, and the cap is at most a few hundred thousand. */
constexpr int kGlitch = -2000000000;

/* "Bounded, but this kernel cannot name the period."
 *
 * The four-wide perturb kernel samples the orbit every 32 steps, so it only
 * closes a cycle whose length divides 32.  A period-77 bulb therefore ran to
 * maxIter and reported a bare -1, where the scalar kernel (Brent, every 4
 * steps) knows it is -1 - 77.  The field encodes the negated period, so that
 * difference is visible: 194 interior pixels of a deep seahorse frame came out
 * with period 0.
 *
 * Rather than pay for a scalar-quality cycle check inside the vector loop, the
 * kernel marks such a lane and the caller re-runs that one pixel through the
 * scalar kernel.  Bounded pixels are a fraction of a percent of a deep frame,
 * so the re-check costs nothing measurable, and a cheap `-1` can no longer be
 * mistaken for a real answer. */
constexpr int kRecheck = -2000000001;

/* Exact period of a bounded orbit — Brent's cycle detection.
 *
 * Brent, "An improved Monte Carlo factorization algorithm" (BIT 20, 1980), the
 * same algorithm every serious fractal renderer uses for periodicity checking.
 * It needs O(1) memory and O(mu) extra comparisons over the whole orbit, which
 * is why it can run unconditionally inside the iteration loop while the
 * snapshot checks (`kCycleChk`, every 32 steps) cannot: those only compare
 * against one saved value, so they can report "fixed point" or "returned after
 * a multiple of 32" and nothing else.
 *
 * Why it matters: the reference colours interior pixels by their period
 * (`data.iter < 0` → `pal(-iter + 0.5)`), so the period *is* the picture inside
 * a Julia set.  With only the coarse check, every interior region came back as
 * period 0 and a deep Julia view painted one flat colour.
 *
 * The tolerance is relative and realistic.  The old 1e-24 could never fire:
 * two orbits that are mathematically identical drift apart by ~1e-16 relative
 * in double arithmetic, so a check that tight silently reported "no period"
 * for essentially every interior pixel. */
struct CycleFinder {
  double tr = 0.0, ti = 0.0;   // the tortoise: start of the current block
  int power = 1;
  int lam = 0;                 // steps taken since the tortoise was set
  bool on = false;

  void reset() { on = false; power = 1; lam = 0; }

  /* Feed the orbit's z once per iteration.  Returns the period when the cycle
   * closes, otherwise 0.  A point that leaves |z| <= 2 is not in the filled
   * set, so no cycle can be claimed for it. */
  int step(double zr, double zi, double zz) {
    /* Well inside the filled set.  A chaotic transient that merely dips below
     * |z| = 2 would otherwise be recorded as a tiny "period", and a frame full
     * of random periods is exactly the salt-and-pepper noise deep views showed. */
    if (!(zz <= 3.24)) { on = false; return 0; }
    if (!on) { tr = zr; ti = zi; power = 1; lam = 0; on = true; return 0; }
    if (power == lam) { tr = zr; ti = zi; power <<= 1; lam = 0; return 0; }
    ++lam;
    const double dx = zr - tr, dy = zi - ti;
    /* 1e-13 relative: comfortably above the double-precision drift of a long
     * orbit and far below the distance between two genuinely different points
     * of a bounded orbit. */
    if (dx * dx + dy * dy < 1e-14 * (zz + 1.0)) return lam;
    return 0;
  }
};

/* Last-resort kernel: iterate one pixel directly at arbitrary precision.
 *
 * The perturbation path can only describe a pixel while the reference it
 * rides on is still alive.  Where no reference in the frame survives long
 * enough — a frame whose whole area escapes early, or the handful of pixels
 * whose deviation grows faster than the reference — the only honest answer is
 * to iterate that pixel from scratch.  It is orders of magnitude slower, so it
 * only ever runs on the pixels that the fast paths could not shade. */
struct BigSeed {
  bool julia = false;
  Big cRe, cIm;      // Mandelbrot: c of the frame centre.  Julia: c itself.
  Big zRe, zIm;      // Julia only: z of the frame centre.
};


/* ---- orbit (mb_orbit.cpp) ------------------------------------------- */
int buildReference(const Request& q, int bits, int maxIter, double dRe,
                   double dIm, Ref* out);
void buildFolds(Ref& R, int kind);
void buildSeries(Ref& R, double dcMax, bool mandelbrot, int power, int kind);
void buildDevTable(Ref& R, int power);
Pick pickReference(const Request& q, int bits, int maxIter, const Ctx& g);

/* ---- kernels (mb_kernels.cpp) --------------------------------------- */
/* Optional escape-point probe.
 *
 * The canvas tree interpolates the *complex value* and its derivative at a
 * fixed iteration, which is what the reference does (`superinterpol` writes
 * `value` and `d` per vertex).  The raster does not need either: it only
 * needs |z|^2 and the count.  So the kernels publish the value through this
 * optional out-parameter and pay nothing when it is null — which is every
 * call the raster makes.
 *
 * `valid` is false for the non-holomorphic families (tricorn, burning ship,
 * celtic, perpendicular): they have no complex derivative, so a canvas may
 * only interpolate their count. */
struct ValueProbe {
  double zr = 0.0, zi = 0.0;   // z at the returned iteration
  double dr = 0.0, di = 0.0;   // dz/dc at the same iteration
  /* `valid` says the value is usable; `hasDer` says the derivative is too.
   * They differ for the VALUE colour channel: it needs z at the escape point
   * but not dz/dc, and forcing the derivative recurrence on for it costs a
   * complex multiply per iteration of every pixel. */
  bool valid = false;
  bool hasDer = false;
};

int perturbPixel(const Ctx& g, double fx, double fy, int refIdx, double& m2Out,
                 double& relOut, double& der2Out, ValueProbe* probe = nullptr);
int directPixel(const Ctx& g, double fx, double fy, double& m2Out,
                double& relOut, double& der2Out, ValueProbe* probe = nullptr);
int perturbFam(const Ctx& g, double fx, double fy, int refIdx, double& m2Out,
               double& relOut, double& der2Out);
int pertPixel(const Ctx& g, double fx, double fy, int refIdx, double& m2Out,
              double& relOut, double& der2Out, ValueProbe* probe = nullptr);
int bigPixel(const Ctx& g, const BigSeed& B, int bits, double fx, double fy,
             double& m2Out, double& relOut);
#if defined(__AVX2__)
long long perturbQuad(const Ctx& g, const Ref& R, const double* fxs, double fy,
                      int count, int* nOut, double* m2Out, double* relOut,
                      double* zrOut = nullptr, double* ziOut = nullptr);
void directQuad2(const Ctx& g, const double* fxs, double fy, int count,
                 int* nOut, double* m2Out, double* zrOut = nullptr,
                 double* ziOut = nullptr);
#endif

/* ---- palette (mb_palette.cpp) --------------------------------------- */
void buildMip(const std::vector<float>& src, bool cyclic, Mip& m);
void mipAt(const Mip& m, int level, double x, double& r, double& g, double& b);
void mipSample(const Mip& m, double x, double half, double& r, double& g,
               double& b);
void buildAdditiveLut(const Palette& P, double ipc, double offset, int maxIter,
                      int visLo, int visHi, std::vector<float>& lut,
                      double& scale);
void buildGradientLut(const Palette& P, std::vector<float>& lut);
double smoothIteration(int n, double m2, double rel);
void shade(uint8_t* o, const Ctx& g, int n, double m2, double rel, double der2,
           double blurCycles = 0.0);
Palette makePalette(const PaletteColor* src, int n, float bf, float bi,
                    float cycleRef = 1.0f);
void initPalettes();

}  // namespace detail
}  // namespace mbc
