// ------------------------------------------------------------------
// mb_orbit.cpp — the reference orbit and everything derived from it.
//
// One arbitrary-precision iteration of the frame's anchor point, its Taylor
// series in the deviation, and the per-iteration tables the pixel kernels
// compose through.  This is the part of the algorithm that costs one pass per
// frame regardless of how many pixels there are, so it is also the part where
// the cache matters: `Impl` keeps the last orbit and rebuilds it only when the
// anchor moves.
// ------------------------------------------------------------------
#include "mb_internal.h"

#include "mb_mpf.h"


namespace mbc {
namespace detail {

/* --- reference orbit ------------------------------------------------ */

/* The GMP mpf-chain reference orbit (the original's computergroup + iter
 * chain, 004f8d20).  Covers classic Mandelbrot only (kind 0 / power 2 /
 * non-Julia); other families return -1 so the caller falls back to the Big
 * fixed-point path.  Returns -1 when it does not take over, otherwise the
 * orbit length (>= 0). */
static int buildReferenceMpf(const Request& q, int bits, int maxIter,
                             double dRe, double dIm, Ref* out,
                             const std::atomic<uint64_t>* gen,
                             uint64_t myGen) {
  if (q.spec.mode == 1 || q.spec.kind != 0 || q.spec.power != 2) return -1;
  const int prec = bits + 32;
  ComputerGroup g;
  g.init(6, prec);
  g.slot(4).setStr(q.centerRe);
  g.slot(5).setStr(q.centerIm);
  if (dRe != 0.0 || dIm != 0.0) {
    Mpf d(prec);
    d.setD(dRe);
    Mpf::add(g.slot(4), g.slot(4), d);
    d.setD(dIm);
    Mpf::add(g.slot(5), g.slot(5), d);
  }
  g.setConstantSlots(4, 5);
  /* Same order as the pseudocode: square first, then compute ny from the
   * **old** x,y, and write nx last. */
  g.add(COp::Sqr, 2, 0, 0);
  g.add(COp::Sqr, 3, 1, 1);
  g.add(COp::ImagIter2, 1, 0, 1);
  g.add(COp::RealIter, 0, 2, 3);

  if (out) {
    out->re.assign((size_t)maxIter + 1, 0.0);
    out->im.assign((size_t)maxIter + 1, 0.0);
    out->escaped = false;
    out->z0r = 0.0;
    out->z0i = 0.0;
  }
  int n = 0;
  for (; n < maxIter; ++n) {
    /* RFF-2.0's HOTPATH_INTERRUPT_CHECK_INTERVAL.  A 16384-bit orbit can
     * take minutes; without this the render thread ignores cancel() until
     * the whole orbit is done, which is the freeze at deep zoom. */
    if ((n & (kOrbitCancelCheckInterval - 1)) == 0 &&
        orbitCancelled(gen, myGen)) {
      if (out) out->len = n;
      return kOrbitCancelled;
    }
    if (out) {
      out->re[(size_t)n] = g.slot(0).toDouble();
      out->im[(size_t)n] = g.slot(1).toDouble();
    }
    if (g.slot(0).expBits() > kEscapeExp || g.slot(1).expBits() > kEscapeExp) {
      if (out) out->escaped = true;
      ++n;
      break;
    }
    g.run();
  }
  if (out) out->len = n;
  return n;
}

/* MB_ORBITMPF=0 disables the new path; classic Mandelbrot uses it by default. */
bool orbitMpfEnabled() {
  static const bool on = [] {
    const char* s = std::getenv("MB_ORBITMPF");
    return !(s && s[0] == '0');
  }();
  return on;
}

/* Build the orbit of the point `dRe/dIm` away from the frame centre.
 * `out` = nullptr only asks for the length, which is what the reference
 * search uses.  Returns the orbit length. */
int buildReference(const Request& q, int bits, int maxIter,
                   double dRe, double dIm, Ref* out,
                   const std::atomic<uint64_t>* gen, uint64_t myGen) {
  if (orbitMpfEnabled()) {
    const int n = buildReferenceMpf(q, bits, maxIter, dRe, dIm, out, gen, myGen);
    if (n >= 0 || n == kOrbitCancelled) return n;
  }
  if (orbitCancelled(gen, myGen)) return kOrbitCancelled;
  const bool julia = q.spec.mode == 1;
  Big cr(bits), ci(bits), zr(bits), zi(bits);
  /* Phoenix keeps one step of memory.  z_{-1} = 0, so the first step is the
   * ordinary z^2 + c; after that prev follows the orbit. */
  Big prevR(bits), prevI(bits);
  Big* const prevP = q.spec.kind == 5 ? &prevR : nullptr;
  Big* const prevQ = q.spec.kind == 5 ? &prevI : nullptr;

  if (julia) {
    const std::string js = q.spec.juliaReS.empty()
                               ? std::to_string(q.spec.juliaRe)
                               : q.spec.juliaReS;
    const std::string jsi = q.spec.juliaImS.empty()
                                ? std::to_string(q.spec.juliaIm)
                                : q.spec.juliaImS;
    cr = Big::fromString(js, bits);
    ci = Big::fromString(jsi, bits);
    zr = Big::fromString(q.centerRe, bits);
    zi = Big::fromString(q.centerIm, bits);
    if (dRe != 0.0 || dIm != 0.0) {
      zr = zr.add(Big::fromDouble(dRe, bits));
      zi = zi.add(Big::fromDouble(dIm, bits));
    }
  } else {
    cr = Big::fromString(q.centerRe, bits);
    ci = Big::fromString(q.centerIm, bits);
    if (dRe != 0.0 || dIm != 0.0) {
      cr = cr.add(Big::fromDouble(dRe, bits));
      ci = ci.add(Big::fromDouble(dIm, bits));
    }
  }

  if (out) {
    out->re.assign((size_t)maxIter + 1, 0.0);
    out->im.assign((size_t)maxIter + 1, 0.0);
    out->escaped = false;
  }
  if (out) {
    out->z0r = zr.toDouble();
    out->z0i = zi.toDouble();
  }
  int n = 0;
  static const bool dbgRef = std::getenv("MB_DEBUGREF") != nullptr;
  if (dbgRef) {
    std::fprintf(stderr, "[ref] kind=%d p=%d c=(%s,%s) d=(%.3g,%.3g) bits=%d\n",
                 q.spec.kind, q.spec.power, q.centerRe.c_str(),
                 q.centerIm.c_str(), dRe, dIm, bits);
  }
  for (; n < maxIter; ++n) {
    if ((n & (kOrbitCancelCheckInterval - 1)) == 0 &&
        orbitCancelled(gen, myGen)) {
      if (out) out->len = n;
      return kOrbitCancelled;
    }
    if (out) {
      out->re[(size_t)n] = zr.toDouble();
      out->im[(size_t)n] = zi.toDouble();
    }
    if (dbgRef && (n % 16 == 0 || n < 4)) {
      std::fprintf(stderr, "[ref] n=%d z=(%.17g,%.17g) exp=(%d,%d)\n", n,
                   zr.toDouble(), zi.toDouble(), expOf(zr), expOf(zi));
    }
    /* |z| > 2^16 is decided on the exponents alone, so the test is free and
     * never rounds.  Past this point the orbit carries no information a
     * perturbation pixel can use. */
    if (expOf(zr) > kEscapeExp || expOf(zi) > kEscapeExp) {
      if (out) out->escaped = true;
      if (dbgRef) std::fprintf(stderr, "[ref] escaped at n=%d\n", n);
      ++n;
      break;
    }
    famStepBig(q.spec.kind, q.spec.power, zr, zi, cr, ci,
               q.spec.phoenixP, prevP, prevQ);
  }
  if (out) out->len = n;
  return n;
}

/* Sign flips of the family map along the reference orbit.  Each of the five
 * formulas is "power, then add c" behind a diagonal sign flip, and the flip is
 * piecewise constant: storing it per iteration lets the deviation series and
 * the pixel kernel compose through exactly the same map. */

void buildFolds(Ref& R, int kind) {
  R.fR.clear();
  R.fI.clear();
  if (kind == 0 || kind == 4) return;      // no flip at all
  const size_t n = (size_t)std::max(1, R.len);
  R.fR.assign(n, 1);
  R.fI.assign(n, 1);
  for (size_t k = 0; k < (size_t)R.len; ++k) {
    const double zr = R.re[k], zi = R.im[k];
    if (kind == 1) {
      R.fI[k] = -1;                        // tricorn: conjugate
    } else if (kind == 2) {
      R.fI[k] = (zr < 0.0) != (zi < 0.0) ? -1 : 1;
    } else if (kind == 3) {
      R.fR[k] = (zr * zr - zi * zi) < 0.0 ? -1 : 1;
    }
  }
}

/* The normalised complex pair (SC, scNorm, scMulC, ...) lives in
 * mb_internal.h now: the pixel kernels need the same primitive for the scaled
 * pixel offset, and one definition keeps the two uses identical. */

/* Taylor series of the deviation.  `dcMaxLog2` is log2 of the largest |dc| in
 * the frame; the skip length is the last n whose quadratic and cubic terms are
 * still negligible there — the same criterion KF uses (relative error 1e-3).
 *
 * The tolerance test is done in the log domain.  In the linear domain
 * `bmag * dcMax` and `cmag * dcMax*dcMax` both underflow at deep zoom (dc^2
 * is 1e-600), so the cubic term was silently declared harmless forever; and
 * amag itself overflowed at 1e308.  Logs keep both comparisons meaningful
 * across the entire orbit.  The caller passes log2 rather than the value for
 * the same reason: at 1e6000 the value itself is zero in a double. */

void buildSeries(Ref& R, double dcMaxLog2, bool mandelbrot, int power, int kind) {
  const size_t n = (size_t)std::max(1, R.len);
  R.ar.assign(n, 0.0);
  R.ai.assign(n, 0.0);
  R.br.assign(n, 0.0);
  R.bi.assign(n, 0.0);
  R.cr.assign(n, 0.0);
  R.ci.assign(n, 0.0);
  R.aExp.assign(n, 0);
  R.bExp.assign(n, 0);
  R.cExp.assign(n, 0);
  R.dcth.assign(n, 0.0);
  R.dcthLog.assign(n, 0.0);
  R.skip = 0;
  R.derSkip = 0;
  /* The folded families can use the series too: its coefficients are built
   * through the *reference's* own fold pattern, and a pixel this close to the
   * anchor sits in that same sign cell until |d| has grown to the point where
   * the series stops anyway (the kernel then follows the pixel's own fold).
   * Perpendicular (kind 4) is holomorphic in z with the constant conjugated,
   * so its series is exact when evaluated at conj(dc).
   *
   * Phoenix has a one-step memory term; its series needs a companion prev
   * coefficient, which is not implemented, so it starts at n = 0 and lets the
   * native kernel do the work. */
  if (R.len < 2) return;
  if (kind == 5) return;
  static const bool noSeries = std::getenv("MB_NOSERIES") != nullptr;

  /* d z_n / d c is 0 at n = 0 for the Mandelbrot set (z_0 is a constant),
   * and 1 for Julia (z_0 is the pixel). */
  const double add = mandelbrot ? ((kind == 2) ? -1.0 : 1.0) : 0.0;
  SC A{mandelbrot ? 0.0 : 1.0, 0.0, 0};
  SC B{0.0, 0.0, 0}, C{0.0, 0.0, 0};
  scNorm(A);

  auto store = [&](size_t idx) {
    R.ar[idx] = A.r;   R.ai[idx] = A.i;   R.aExp[idx] = A.e;
    R.br[idx] = B.r;   R.bi[idx] = B.i;   R.bExp[idx] = B.e;
    R.cr[idx] = C.r;   R.ci[idx] = C.i;   R.cExp[idx] = C.e;
  };
  store(0);

  const double logTol = std::log(kSkipTol());
  const double logDc = dcMaxLog2 * kLn2;   // dcMax = 2^dcMaxLog2, always finite
  const double logThMax = std::log(1e300);
  int skip = 0, derSkip = 0;
  for (int k = 0; k + 1 < R.len; ++k) {
    const double zr = R.re[(size_t)k], zi = R.im[(size_t)k];
    /* Step coefficients of d' = F ( J d + H d^2 + K d^3 ) + dc.  For p = 2
     * the table is not built, because J = 2Z, H = 1, K = 0 in closed form. */
    double jr, ji, hr, hi, kr, ki;
    if (power == 2) {
      jr = 2.0 * zr; ji = 2.0 * zi;
      hr = 1.0;      hi = 0.0;
      kr = 0.0;      ki = 0.0;
    } else {
      jr = R.jr[(size_t)k]; ji = R.ji[(size_t)k];
      hr = R.hr[(size_t)k]; hi = R.hi[(size_t)k];
      kr = R.kr[(size_t)k]; ki = R.ki[(size_t)k];
    }
    const double fr = R.fR.empty() ? 1.0 : (double)R.fR[(size_t)k];
    const double fi = R.fI.empty() ? 1.0 : (double)R.fI[(size_t)k];

    /* Every recurrence below reads the *old* A, B, C, exactly like the
     * scalar-kernel's series did before the exponents were added. */
    const SC Ap = A, Bp = B, Cp = C;
    const SC A2 = scMul(Ap, Ap);
    const SC AB = scMul(Ap, Bp);
    const SC A3 = scMul(A2, Ap);

    SC JA = scMulC(Ap, jr, ji);   scFold(JA, fr, fi);
    A = scAdd(JA, scReal(add));

    SC JB = scMulC(Bp, jr, ji);   scFold(JB, fr, fi);
    SC HA2 = scMulC(A2, hr, hi);  scFold(HA2, fr, fi);
    B = scAdd(JB, HA2);

    SC JC = scMulC(Cp, jr, ji);   scFold(JC, fr, fi);
    SC T2 = scMulC(AB, 2.0 * hr, 2.0 * hi); scFold(T2, fr, fi);
    SC T3 = scMulC(A3, kr, ki);   scFold(T3, fr, fi);
    C = scAdd(scAdd(JC, T2), T3);
    store((size_t)k + 1);

    const double logA = scLogAbs(A);
    const double logB = scLogAbs(B);
    const double logC = scLogAbs(C);
    /* Scale-invariant test: the quadratic and cubic terms must be negligible
     * *relative* to the linear one everywhere in the frame.  No cap on |A|:
     * a large A only means the linear image of the frame is large, which the
     * pixel kernel scales out again. */
    if (logB + logDc <= logTol + logA &&
        logC + 2.0 * logDc <= logTol + logA)
      skip = k + 1;
    /* Largest |dc| for which a start at this index is still inside tolerance.
     * exp() is guarded: a coefficient ratio of 1e500 is perfectly legal in
     * the log domain and must not turn the threshold into +inf. */
    double logTh = logThMax;
    if (logB > -1e299) logTh = std::min(logTh, logTol + logA - logB);
    if (logC > -1e299)
      logTh = std::min(logTh, 0.5 * (logTol + logA - logC));
    double th = logTh <= -745.0 ? 0.0 : std::exp(std::min(logTh, logThMax));
    if (!(th > 0.0) || th > 1e300) th = 1e300;
    if (k > 0 && R.dcth[(size_t)k] < th) th = R.dcth[(size_t)k];
    R.dcth[(size_t)k + 1] = th;
    /* The same threshold in the log domain, clamped monotonically to match:
     * dcth[] never increases with k, so neither may dcthLog[]. */
    double thLog = std::min(logTh, logThMax);
    if (k > 0 && R.dcthLog[(size_t)k] < thLog) thLog = R.dcthLog[(size_t)k];
    R.dcthLog[(size_t)k + 1] = thLog;

    /* The derivative recurrence is seeded with A_sk itself, with no exponent
     * companion; remember where that still fits in a double. */
    if (A.e == 0) derSkip = k + 1;
  }
  R.skip = noSeries ? 0 : std::min(skip, R.len - 1);
  R.derSkip = std::min(derSkip, R.len - 1);
}

/* Where to anchor the frame.
 *
 * The reference must be a point whose orbit lasts at least as long as the
 * frame needs.  Anchoring at the frame centre is the obvious choice and the
 * wrong one: if that point escapes after 3000 iterations, every pixel gets
 * "escaped" on iteration 3000 because the reference term dominates the sum,
 * and the frame collapses to one flat colour.  So the anchor is the point of
 * longest orbit on a coarse grid — an interior point if the frame contains
 * one, which is what KF's AddReference search converges to as well.
 *
 * Probing is done in double while a pixel is still resolvable there; below
 * that it has to go through Big, which is slower but is also only paid when
 * the cached orbit cannot be reused. */

Pick pickReference(const Request& q, int bits, int maxIter, const Ctx& g,
                   const std::atomic<uint64_t>* gen, uint64_t myGen) {
  /* A double's ulp near |c| ~ 0.74 is 1.1e-16.  The old fixed 1e-17 switch
   * meant that between 1e-14 and 1e-17 every probe grid point rounded to the
   * *same* double: the search could not see the frame at all.  Require ~64
   * ulps of headroom for a 3x3/5x5 grid, then switch to the exact centre. */
  const double cRe = std::strtod(q.centerRe.c_str(), nullptr);
  const double cIm = std::strtod(q.centerIm.c_str(), nullptr);
  const double cAbs = std::max(1.0, std::max(std::fabs(cRe), std::fabs(cIm)));
  const double ulp = std::ldexp(1.0, -52) * cAbs;
  const bool bigProbe = g.ps < 64.0 * ulp;
  const int G = bigProbe ? 3 : 5;
  /* The probe cap has to grow with the view.
   *
   * A deep frame needs 6k-100k iterations per pixel, and a reference that
   * escapes before the pixels do is useless: everything below the escape point
   * collapses onto the reference's own orbit and the frame comes back as one
   * flat colour.  The cap used to be a flat 4096, which is fine at 1e20 and
   * fatal at 1e28 — measured: at zoom 1e28 every pixel was reported interior
   * with the same period, and the whole frame was one hue.
   *
   * So: probe, and while the winner is still sitting on the cap (i.e. the
   * probe was cut off and we do not know whether it survives), raise the cap
   * and probe again.  Four doublings reach 32k with nine 200-bit orbits, which
   * costs a fraction of a second — small next to the frame that follows. */
  int cap = std::min(maxIter, 2048);
  const double w = (double)std::max(1, q.width);
  const double h = (double)std::max(1, q.height);

  if (std::getenv("MB_ANCHORCENTER")) return Pick{0.0, 0.0, 1, true};
  static const bool cornerPick = std::getenv("MB_PICKCORNER") != nullptr;
  if (cornerPick) {
    // force a known anchor: the top-left probe
    const double fx = (double)q.tileX + 0.5 * w / (double)G;
    const double fy = (double)q.tileY + 0.5 * h / (double)G;
    Pick pk;
    screenDelta(g, fx, fy, pk.dRe, pk.dIm);
    pk.len = 1;
    pk.valid = true;
    return pk;
  }
  /* One probe round.  `hit` reports whether any grid point was still running
   * when the cap ran out, which is the only thing the caller needs: it means
   * the answer is unknown at this cap, not that the point is interior. */
  auto probeRound = [&](int rc, bool& hit) {
    Pick bestR;
    hit = false;
    for (int gy = 0; gy < G; ++gy) {
      for (int gx = 0; gx < G; ++gx) {
        const double fx = (double)q.tileX + ((double)gx + 0.5) * w / (double)G;
        const double fy = (double)q.tileY + ((double)gy + 0.5) * h / (double)G;
        double dRe, dIm;
        screenDelta(g, fx, fy, dRe, dIm);
        int len;
        if (bigProbe) {
          len = buildReference(q, bits, rc, dRe, dIm, nullptr, gen, myGen);
          if (len == kOrbitCancelled) return Pick{};
        } else {
          double zr, zi, cr, ci;
          double prevR = 0.0, prevI = 0.0;
          if (g.julia) {                // seed orbit: z_0 is the pixel, c fixed
            zr = cRe + dRe;
            zi = cIm + dIm;
            cr = q.spec.juliaRe;
            ci = q.spec.juliaIm;
          } else {
            zr = 0.0;
            zi = 0.0;
            cr = cRe + dRe;
            ci = cIm + dIm;
          }
          len = -1;
          for (int n = 0; n < rc; ++n) {
            if ((n & (kOrbitCancelCheckInterval - 1)) == 0 &&
                orbitCancelled(gen, myGen)) return Pick{};
            const double m2 = zr * zr + zi * zi;
            if (m2 > kBail2) {
              len = n;
              break;
            }
            famStepD(g.kind, g.power, zr, zi, cr, ci, q.spec.phoenixP,
                     &prevR, &prevI);
          }
          if (len < 0) len = rc;
        }
        if (len >= rc) {
          hit = true;
          return Pick{dRe, dIm, len, true};   // still running: good anchor
        }
        if (!bestR.valid || len > bestR.len) bestR = Pick{dRe, dIm, len, true};
      }
    }
    return bestR;
  };

  Pick best;
  for (int round = 0; round < 4; ++round) {
    bool hit = false;
    best = probeRound(cap, hit);
    if (hit) return best;                   // the winner outlived the cap
    if (best.len < cap) break;              // every point escaped: real answer
    if (cap >= maxIter) break;
    cap = std::min(maxIter, cap * 4);
  }
  return best;
}

/* Per-iteration Taylor coefficients of the family map.  Built once per
 * reference orbit; see the family block above for the five formulas. */
void buildDevTable(Ref& R, int power) {
  const size_t n = (size_t)std::max(1, R.len);
  if (power == 2) return;              // J = 2Z, H = 1: computed, not stored
  R.jr.assign(n, 0.0);
  R.ji.assign(n, 0.0);
  R.hr.assign(n, 0.0);
  R.hi.assign(n, 0.0);
  R.kr.assign(n, 0.0);
  R.ki.assign(n, 0.0);
  const double c2 = 0.5 * (double)power * (double)(power - 1);
  const double c3 = (double)power * (double)(power - 1) * (double)(power - 2) / 6.0;
  for (size_t k = 0; k < (size_t)R.len; ++k) {
    const double zr = R.re[k], zi = R.im[k];
    double pr = zr, pi = zi;
    cpow(pr, pi, power - 1);
    R.jr[k] = (double)power * pr;
    R.ji[k] = (double)power * pi;
    double qr = zr, qi = zi;
    cpow(qr, qi, power - 2);
    R.hr[k] = c2 * qr;
    R.hi[k] = c2 * qi;
    /* K = C(p,3) Z^(p-3).  cpow with exponent 0 returns 1, which is the right
     * constant for p = 3. */
    double sr = zr, si = zi;
    cpow(sr, si, power - 3);
    R.kr[k] = c3 * sr;
    R.ki[k] = c3 * si;
  }
}

}  // namespace detail
}  // namespace mbc
