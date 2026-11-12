// ------------------------------------------------------------------
// mb_kernels.cpp — one pixel, one recurrence.
//
// Three paths, all producing the same three numbers (escape count, |z|^2 and
// the relative deviation that keeps the low bits of it):
//
//   perturbPixel   deviation iteration around a reference orbit (deep zoom)
//   perturbFam     the same, with the family's per-iteration fold applied
//   directPixel    plain double iteration (any formula, shallow zoom)
//   bigPixel       full arbitrary precision, last resort for the pixels the
//                  reference cannot describe
//
// plus the AVX2 kernel that runs four adjacent pixels through the deviation
// recurrence together.
// ------------------------------------------------------------------
#include "mb_internal.h"


namespace mbc {
namespace detail {

/* --- pixel kernels -------------------------------------------------- */

/* Perturbation.  Returns n >= 0 for an escaped pixel, -1 for one that stays
 * bounded, -2 for one the reference could not describe (a glitch). */
/* Deep perturbation: the same recurrence as perturbPixel, with the deviation
 * carried as a normalised complex (mantissa + binary exponent).
 *
 * The plain-double kernel needs dc as a double, and dc is the pixel offset
 * from the anchor — at a 1e6000 view that is 2^-19940, exactly zero.  Every
 * pixel would then be the anchor's own orbit and the frame would come back as
 * one flat colour.  Carrying the exponent separately fixes that at both ends:
 * dc starts at 2^-19940, the series turns it into a deviation of whatever
 * magnitude the geometry implies, and the recurrence grows it until |Z+d|
 * crosses the bailout.  Mantissa arithmetic is the same 53-bit double work as
 * before; only the alignment adds a few ldexp per step, which is why the
 * shallow path keeps the old kernel untouched. */
static int perturbPixelDeep(const Ctx& g, const Ref& R, double fx, double fy,
                            double& m2Out, double& relOut, double& der2Out,
                            ValueProbe* probe) {
  SC dc;
  screenDeltaScaled(g, fx, fy, dc);
  /* The anchor's own offset from the frame centre is a double; at this depth
   * it is either zero or representable, so subtracting it is exact. */
  dc.r -= R.dRe;
  dc.i -= R.dIm;
  scNorm(dc);

  /* Dynamic start, in the log domain: |dc| itself is below the double range,
   * so the threshold table is compared as log|dc|. */
  int sk = R.skip;
  if (g.dynSkip && R.skip > 0 && R.len > 3 &&
      R.dcthLog.size() >= (size_t)R.len) {
    const double ad = std::hypot(dc.r, dc.i);
    const double logAd = ad > 0.0 ? std::log(ad) + (double)dc.e * kLn2 : -1e300;
    int lo = 1, hi = R.len - 2;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if (R.dcthLog[(size_t)mid] >= logAd) lo = mid; else hi = mid - 1;
    }
    sk = lo;
  }

  const bool walkDer = (g.wantDist && !g.skipDeriv) || (probe != nullptr && !g.zOnly);
  if (walkDer && sk > R.derSkip) sk = R.derSkip;

  SC d;
  int ridx;
  if (sk > 0) {
    d = seriesDeviationScaled(R, sk, dc);
    ridx = sk;
  } else {
    /* z_0 is a constant; the first update adds dc. */
    d = SC{0.0, 0.0, 0};
    ridx = 0;
  }

  double derR = 0.0, derI = 0.0;
  if (walkDer) {
    if (sk > 0) { derR = R.ar[(size_t)sk]; derI = R.ai[(size_t)sk]; }
  }
  double chkR = 0.0, chkI = 0.0;
  bool chkOn = false;
  double rollR = 0.0, rollI = 0.0;
  CycleFinder cyc;
  const int chkStart = ridx > kCycleChk ? ridx : kCycleChk;
  const bool doFixed = ridx <= kCycleChk;

  /* Convert a scaled component to a double, saturating at zero below the
   * double range.  Everything that is compared against |Z|~1 tolerates that:
   * a deviation that small changes no decision yet. */
  auto toD = [](const SC& a, double& r, double& i) {
    r = a.e > -900 ? std::ldexp(a.r, a.e) : 0.0;
    i = a.e > -900 ? std::ldexp(a.i, a.e) : 0.0;
  };

  for (int n = ridx; n < g.maxIter; ++n) {
    if (ridx >= R.len) {
      m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
      return kGlitch;
    }
    double Zr = R.re[(size_t)ridx], Zi = R.im[(size_t)ridx];
    double dr, di;
    toD(d, dr, di);
    const double Z2 = Zr * Zr + Zi * Zi;
    double cross = 2.0 * (Zr * dr + Zi * di);
    double d2 = dr * dr + di * di;
    double m2 = Z2 + cross + d2;
    if (d2 > m2) {
      SC zR{Zr, Zi, 0}, z0{-R.z0r, -R.z0i, 0};
      d = scAdd(scAdd(zR, d), z0);
      ridx = 0;
      cyc.reset();
      Zr = R.re[0];
      Zi = R.im[0];
      toD(d, dr, di);
      const double Z2n = Zr * Zr + Zi * Zi;
      cross = 2.0 * (Zr * dr + Zi * di);
      d2 = dr * dr + di * di;
      m2 = Z2n + cross + d2;
    }
    if (probe && g.zOnly && !probe->valid && m2 > 4.0) {
      probe->zr = Zr + dr;
      probe->zi = Zi + di;
      probe->valid = true;
    }
    if (m2 > kBail2) {
      m2Out = m2;
      relOut = Z2 > 0.0 ? (cross + d2) / Z2 : 0.0;
      der2Out = g.skipDeriv ? 0.0 : derR * derR + derI * derI;
      if (probe) {
        if (!g.zOnly) { probe->zr = Zr + dr; probe->zi = Zi + di; }
        probe->dr = derR;
        probe->di = derI;
        probe->valid = true;
        probe->hasDer = walkDer;
      }
      return n;
    }
    if (g.wantTrap && d.e > -900) {
      const double zrT = Zr + dr, ziT = Zi + di;
      if (g.trapMode == 2) {
        const double dd = ziT * ziT;
        if (dd < trapAcc()) trapAcc() = dd;
      } else if (g.trapMode == 4) {
        trapAcc() += 0.5 * std::log(zrT * zrT + ziT * ziT + 1e-300);
      } else {
        const double r2T = zrT * zrT + ziT * ziT;
        double dd = r2T;
        if (g.trapMode == 3) {
          const double r = std::sqrt(r2T);
          dd = (r - 1.0) * (r - 1.0);
        }
        if (dd < trapAcc()) trapAcc() = dd;
      }
    }
    {
      const int per = cyc.step(Zr + dr, Zi + di, m2);
      if (per > 0) { m2Out = 0.0; relOut = 0.0; der2Out = 0.0; return -1 - per; }
    }
    if (walkDer) {
      const double zrD = Zr + dr, ziD = Zi + di;
      const double odr = 2.0 * (zrD * derR - ziD * derI) + 1.0;
      const double odi = 2.0 * (zrD * derI + ziD * derR);
      derR = odr;
      derI = odi;
    }
    const SC lin = scMulC(d, 2.0 * Zr, 2.0 * Zi);
    const SC quad = scMul(d, d);
    d = scAdd(scAdd(lin, quad), dc);
    ++ridx;
    if (n == chkStart || (chkOn && (n & 31) == 0)) {
      const int zi = ridx < R.len ? ridx : R.len - 1;
      toD(d, dr, di);
      const double zrNow = R.re[(size_t)zi] + dr;
      const double ziNow = R.im[(size_t)zi] + di;
      if (n == chkStart) {
        chkR = zrNow; chkI = ziNow; chkOn = true;
        rollR = zrNow; rollI = ziNow;
      } else {
        if (doFixed) {
          const double dx = zrNow - chkR, dy = ziNow - chkI;
          const double zz = zrNow * zrNow + ziNow * ziNow;
          if (dx * dx + dy * dy < 1e-24 * (zz + 1.0)) {
            m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
            return -1 - (n - kCycleChk);
          }
        }
        const double rx = zrNow - rollR, ry = ziNow - rollI;
        const double z2 = zrNow * zrNow + ziNow * ziNow;
        if (rx * rx + ry * ry < 1e-24 * (z2 + 1.0)) {
          m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
          return -1;
        }
        rollR = zrNow; rollI = ziNow;
      }
    }
  }
  m2Out = 0.0;
  relOut = 0.0;
  der2Out = 0.0;
  return -1;
}

/* Deep counterpart of perturbFam.  Every quantity that used to be a plain
 * double offset is carried as a scaled complex {double,double,int exponent},
 * so a frame at 1e-660 keeps its per-pixel structure instead of collapsing to
 * dc = 0.  The family itself (fold, conjugation, power, Phoenix memory) is the
 * same recurrence the double kernel and buildSeries use. */
static int perturbFamDeep(const Ctx& g, const Ref& R, double fx, double fy,
                          double& m2Out, double& relOut, double& der2Out) {
  SC dc;
  screenDeltaScaled(g, fx, fy, dc);
  dc.r -= R.dRe;
  dc.i -= R.dIm;
  scNorm(dc);

  /* Constant the map adds each step.  Burning ship subtracts c (real part
   * negated), perpendicular conjugates it, everything else adds it. */
  SC cc = dc;
  if (g.kind == 2) cc.r = -cc.r;
  else if (g.kind == 4) cc.i = -cc.i;

  int sk = R.skip;
  if (g.dynSkip && R.skip > 0 && R.len > 3 &&
      R.dcthLog.size() >= (size_t)R.len) {
    const double ad = std::hypot(dc.r, dc.i);
    const double logAd = ad > 0.0 ? std::log(ad) + (double)dc.e * kLn2 : -1e300;
    int lo = 1, hi = R.len - 2;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if (R.dcthLog[(size_t)mid] >= logAd) lo = mid; else hi = mid - 1;
    }
    sk = lo;
  }

  SC d;
  int ridx;
  if (sk > 0) {
    /* Perpendicular's series variable is conj(dc), same as the double path. */
    d = seriesDeviationScaled(R, sk, g.kind == 4 ? cc : dc);
    ridx = sk;
  } else {
    /* z_0 is a constant, so d_0 = 0; the first update adds dc. */
    d = SC{0.0, 0.0, 0};
    ridx = 0;
  }
  SC dPrev{0.0, 0.0, 0};

  auto toD = [](const SC& a, double& r, double& i) {
    r = a.e > -900 ? std::ldexp(a.r, a.e) : 0.0;
    i = a.e > -900 ? std::ldexp(a.i, a.e) : 0.0;
  };

  for (int n = ridx; n < g.maxIter; ++n) {
    if (ridx >= R.len) {
      m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
      return kGlitch;
    }
    const double Zr = R.re[(size_t)ridx], Zi = R.im[(size_t)ridx];
    double dr, di;
    toD(d, dr, di);
    const double Z2 = Zr * Zr + Zi * Zi;
    double cross = 2.0 * (Zr * dr + Zi * di);
    double d2 = dr * dr + di * di;
    double m2 = Z2 + cross + d2;
    if (d2 > m2) {
      const SC zR{Zr, Zi, 0}, z0{-R.z0r, -R.z0i, 0};
      d = scAdd(scAdd(zR, d), z0);
      ridx = 0;
      dPrev = SC{0.0, 0.0, 0};
      continue;
    }
    if (m2 > kBail2) {
      m2Out = m2;
      relOut = Z2 > 0.0 ? (cross + d2) / Z2 : 0.0;
      der2Out = 0.0;
      return n;
    }
    if (g.wantTrap) {
      const double zrT = Zr + dr, ziT = Zi + di;
      if (g.trapMode == 2) {
        const double dd = ziT * ziT;
        if (dd < trapAcc()) trapAcc() = dd;
      } else if (g.trapMode == 4) {
        trapAcc() += 0.5 * std::log(zrT * zrT + ziT * ziT + 1e-300);
      } else {
        const double r2T = zrT * zrT + ziT * ziT;
        double dd = r2T;
        if (g.trapMode == 3) {
          const double r = std::sqrt(r2T);
          dd = (r - 1.0) * (r - 1.0);
        }
        if (dd < trapAcc()) trapAcc() = dd;
      }
    }

    double jr, ji, hr, hi, kr, ki;
    if (g.power == 2) {
      jr = 2.0 * Zr; ji = 2.0 * Zi;
      hr = 1.0; hi = 0.0;
      kr = 0.0; ki = 0.0;
    } else {
      jr = R.jr[(size_t)ridx]; ji = R.ji[(size_t)ridx];
      hr = R.hr[(size_t)ridx]; hi = R.hi[(size_t)ridx];
      kr = R.kr[(size_t)ridx]; ki = R.ki[(size_t)ridx];
    }
    /* d' = J d + H d^2 + K d^3 + (Phoenix memory) + dc, all in the scaled
     * complex type.  |d| can be 1e-600, so no term is dropped. */
    SC w = scMulC(d, jr, ji);
    SC q2 = scMul(d, d);
    w = scAdd(w, scMulC(q2, hr, hi));
    if (g.power != 2) {
      SC q3 = scMul(q2, d);
      w = scAdd(w, scMulC(q3, kr, ki));
    }
    if (g.kind == 5) w = scAdd(w, scMulC(dPrev, g.phoenixP, 0.0));

    const double qr = dr * dr - di * di;
    switch (g.kind) {
      case 1:
        w.i = -w.i;
        break;
      case 2:
        if ((Zr + dr) * (Zi + di) < 0.0) w.i = -w.i;
        break;
      case 3:
        if ((Zr * Zr - Zi * Zi) + cross + qr < 0.0) w.r = -w.r;
        break;
      default:
        break;
    }
    if (g.kind == 5) dPrev = d;
    d = scAdd(w, cc);
    ++ridx;
  }
  m2Out = 0.0;
  relOut = 0.0;
  der2Out = 0.0;
  return -1;
}

int perturbPixel(const Ctx& g, double fx, double fy, int refIdx,
                        double& m2Out, double& relOut, double& der2Out,
                        ValueProbe* probe) {
  const Ref& R = (*g.refs)[(size_t)refIdx];
  /* A pixel pitch below the double range: the plain-double kernel cannot see
   * its own offset from the anchor, so the normalised one takes over.  Julia
   * keeps the old path (its deviation starts at the pixel offset itself and
   * the seed is a double by construction, so nothing is lost that this path
   * could recover). */
  if (g.deepScale && !g.julia)
    return perturbPixelDeep(g, R, fx, fy, m2Out, relOut, der2Out, probe);
  /* dc is measured from the *anchor* the orbit belongs to.  Using the frame
   * centre instead puts every pixel on the orbit of (anchor + dc), which
   * shifts the whole picture by the anchor offset and was the reason the
   * bands looked displaced whenever the probe found its point off-centre. */
  double dcr, dci;
  screenDelta(g, fx, fy, dcr, dci);
  dcr -= R.dRe;
  dci -= R.dIm;

  /* ---- dynamic start -------------------------------------------------
   * The series is valid to `R.skip` for the farthest pixel, but a pixel near
   * the anchor has a much smaller |dc| and can start later.  `dcth[]` holds,
   * for every index, the largest |dc| that is still inside the tolerance, so
   * one binary search gives this pixel its own start.  This is the per-place
   * iteration count: two pixels of the same frame no longer run the same
   * number of steps from the same point. */
  int sk = R.skip;
  if (g.dynSkip && R.skip > 0 && R.len > 3 && R.dcth.size() >= (size_t)R.len) {
    const double ad = std::hypot(dcr, dci);
    int lo = 1, hi = R.len - 2;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if ((double)R.dcth[(size_t)mid] >= ad)
        lo = mid;
      else
        hi = mid - 1;
    }
    sk = lo;
  }

  const bool walkDer =
      (g.wantDist && !g.skipDeriv) || (probe != nullptr && !g.zOnly);
  /* The derivative recurrence is seeded with A_sk as a plain double.  Past
   * derSkip the coefficient only exists as (mantissa, exponent), so a frame
   * that needs |z'| starts earlier instead of seeding with infinity. */
  if (walkDer && sk > R.derSkip) sk = R.derSkip;

  double dr, di;
  int ridx;
  if (g.julia) {
    dr = dcr;
    di = dci;
    ridx = 0;
  } else if (sk > 0) {
    seriesDeviation(R, sk, dcr, dci, dr, di);
    ridx = sk;
  } else {
    dr = 0.0;
    di = 0.0;
    ridx = 0;
  }

  const double cSign = (g.kind == 2) ? -1.0 : 1.0;
  const double dcrC = g.julia ? 0.0 : cSign * dcr;
  const double dciC = g.julia ? 0.0 : dci;

  /* Distance estimate: the derivative that matters is dd/d(dc) — how the
   * *deviation from the reference* responds to a change of the pixel's own
   * constant — not dZ/dc of the reference orbit.
   *
   * The two are not interchangeable.  z_n = Z_n + d_n exactly, with Z held
   * fixed, so dz_n/dc = dd_n/d(dc) and nothing else.  The reference orbit sits
   * in or next to the filled set: its own derivative never blows up, while the
   * escaping pixel's does.  Using the reference's derivative made every
   * deep-view distance about twelve orders of magnitude too large, so the
   * Distance schemes saw `rr >> 1` everywhere and painted an empty frame.
   *
   * The recurrence is the full one, driven by z = Z + d, which is what makes
   * it track the escaping orbit:
   *     D_0 = 0 (Mandelbrot) / 1 (Julia, the seed is the parameter)
   *     D_{n+1} = 2 z_n D_n + 1 (Mandelbrot) / 2 z_n D_n (Julia)
   * After the series approximation the deviation already carries its linear
   * term A_sk, and A_n is identically dZ_n/dc, so D starts there. */
  double derR = 0.0, derI = 0.0;
  if (walkDer) {
    if (g.julia) derR = 1.0;
    else if (sk > 0) { derR = R.ar[(size_t)sk]; derI = R.ai[(size_t)sk]; }
  }
  double chkR = 0.0, chkI = 0.0;
  bool chkOn = false;
  double rollR = 0.0, rollI = 0.0;      // last periodic snapshot (moves on)
  /* Exact cycle detection for the pixels that never escape.  Runs alongside
   * the orbit, so the period is available the moment the cycle closes and
   * the interior can be coloured by it (see CycleFinder). */
  CycleFinder cyc;
  /* Series approximation starts the loop at n = ridx, often far past
   * kCycleChk.  Arm the snapshots at the loop's own first iteration instead. */
  const int chkStart = ridx > kCycleChk ? ridx : kCycleChk;
  const bool doFixed = ridx <= kCycleChk;

  for (int n = ridx; n < g.maxIter; ++n) {
    if (ridx >= R.len) {            // the reference ran out before the pixel
      m2Out = 0.0;
      relOut = 0.0;
      der2Out = 0.0;
      return kGlitch;
    }
    double Zr = R.re[(size_t)ridx], Zi = R.im[(size_t)ridx];
    /* |Z + d|^2 assembled from its parts instead of from the sum.  Once |Z| is
     * large the sum Zr + dr has already rounded dr away, and the smooth
     * iteration — the only thing still varying across a deep frame — would
     * come out identical for every pixel.  This form keeps the deviation. */
    double Z2 = Zr * Zr + Zi * Zi;
    double cross = 2.0 * (Zr * dr + Zi * di);
    double d2 = dr * dr + di * di;
    double m2 = Z2 + cross + d2;
    if (d2 > m2) {
      /* The reference has stopped dominating: re-anchor the deviation at the
       * start of the orbit.  z_0 is 0 for Mandelbrot and the Julia seed
       * otherwise, so it is read from the orbit rather than assumed. */
      dr = Zr + dr - R.z0r;
      di = Zi + di - R.z0i;
      ridx = 0;
      /* The orbit we were following has been replaced by a new one, so the
       * cycle finder's saved tortoise no longer belongs to it. */
      cyc.reset();
      Zr = R.re[0];
      Zi = R.im[0];
      Z2 = Zr * Zr + Zi * Zi;
      cross = 2.0 * (Zr * dr + Zi * di);
      d2 = dr * dr + di * di;
      m2 = Z2 + cross + d2;
    }
    /* Same value-at-radius-2 rule as directPixel: the Texture scheme
     * continues this z itself and compares it against a limit near 2. */
    if (probe && g.zOnly && !probe->valid && m2 > 4.0) {
      probe->zr = Zr + dr;
      probe->zi = Zi + di;
      probe->valid = true;
    }
    if (m2 > kBail2) {
      m2Out = m2;
      relOut = Z2 > 0.0 ? (cross + d2) / Z2 : 0.0;
      der2Out = g.skipDeriv ? 0.0 : derR * derR + derI * derI;
      if (probe) {
        if (!g.zOnly) {
          probe->zr = Zr + dr;
          probe->zi = Zi + di;
        }
        probe->dr = derR;
        probe->di = derI;
        probe->valid = true;
        probe->hasDer = walkDer;
      }
      return n;
    }
    /* Orbit traps: accumulate while the orbit is being walked anyway.  Four
     * classic traps, all of them taken over the whole orbit.
     *   1 point  — closest approach to the origin
     *   2 line   — closest approach to the real axis
     *   3 circle — closest approach to the unit circle
     *   4 TIA    — triangle-inequality average, the sum of log|z_n|
     * The engine seeds trapVal before the call and reads it after, so nothing
     * has to be threaded through the returns below. */
    if (g.wantTrap) {
      const double zrT = Zr + dr, ziT = Zi + di;
      if (g.trapMode == 2) {
        const double d = ziT * ziT;
        if (d < trapAcc()) trapAcc() = d;
      } else if (g.trapMode == 4) {
        trapAcc() += 0.5 * std::log(zrT * zrT + ziT * ziT + 1e-300);
      } else {
        const double r2T = zrT * zrT + ziT * ziT;
        double d = r2T;
        if (g.trapMode == 3) { const double r = std::sqrt(r2T); d = (r - 1.0) * (r - 1.0); }
        if (d < trapAcc()) trapAcc() = d;
      }
    }
    /* Still inside |z| <= 2, so this pixel may be interior.  Brent's finder
     * tells us the exact period the first time the orbit repeats a value; the
     * reference encodes that as -1 - period and its schemes colour by it. */
    {
      const int per = cyc.step(Zr + dr, Zi + di, m2);
      if (per > 0) { m2Out = 0.0; relOut = 0.0; der2Out = 0.0; return -1 - per; }
    }
    if (walkDer) {
      /* 2z·D + [1], with z the pixel's own point (Z + d).  Using Z alone is
       * the reference's derivative again, which is the bug described at the
       * top of this function. */
      const double zrD = Zr + dr, ziD = Zi + di;
      const double odr = 2.0 * (zrD * derR - ziD * derI) + (g.julia ? 0.0 : 1.0);
      const double odi = 2.0 * (zrD * derI + ziD * derR);
      derR = odr;
      derI = odi;
    }
    const double nr = 2.0 * (Zr * dr - Zi * di) + (dr * dr - di * di) + dcrC;
    const double ni = 2.0 * (Zr * di + Zi * dr) + 2.0 * dr * di + dciC;
    dr = nr;
    di = ni;
    ++ridx;
    /* Two snapshots.  `chk` is the reference program's fixed one (taken at
     * kCycleChk); `roll` moves forward every 32 iterations.  An orbit that
     * converges to a fixed point never returns to its early value, so the
     * fixed check alone made every interior pixel burn the entire iteration
     * limit.  The rolling check sees a stationary orbit and stops it early,
     * returning exactly the -1 that running to the limit would have returned:
     * the picture is unchanged, the deep frame is several times faster. */
    if (n == chkStart || (chkOn && (n & 31) == 0)) {
      const int zi = ridx < R.len ? ridx : R.len - 1;
      const double zrNow = R.re[(size_t)zi] + dr;
      const double ziNow = R.im[(size_t)zi] + di;
      if (n == chkStart) {
        chkR = zrNow; chkI = ziNow; chkOn = true;
        rollR = zrNow; rollI = ziNow;
      } else {
        if (doFixed) {
          const double dx = zrNow - chkR, dy = ziNow - chkI;
          const double zz = zrNow * zrNow + ziNow * ziNow;
          if (dx * dx + dy * dy < 1e-24 * (zz + 1.0)) {
            m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
            return -1 - (n - kCycleChk);
          }
        }
        const double rx = zrNow - rollR, ry = ziNow - rollI;
        const double z2 = zrNow * zrNow + ziNow * ziNow;
        if (rx * rx + ry * ry < 1e-24 * (z2 + 1.0)) {
          m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
          return -1;
        }
        rollR = zrNow; rollI = ziNow;
      }
    }
  }
  m2Out = 0.0;
  relOut = 0.0;
  der2Out = 0.0;
  return -1;
}

/* ---- general family kernel ------------------------------------------
 *
 * Same loop as above, with the family step generalised to
 *     d' = F ( J d + H d^2 ) + dc
 * where J, H and the fold F come from the stored per-iteration table.  For
 * z^2 this is exactly the Mandelbrot recurrence above; for tricorn F is a
 * conjugate, for burning ship and celtic one component is mirrored, and for
 * p > 2 the coefficients carry the power.  The cost per iteration is the same
 * two complex products, so a burning-ship deep zoom runs at Mandelbrot speed
 * instead of falling back to arbitrary precision.
 */
int perturbFam(const Ctx& g, double fx, double fy, int refIdx,
                      double& m2Out, double& relOut, double& der2Out) {
  const Ref& R = (*g.refs)[(size_t)refIdx];
  /* Below the double range the plain-double offset is exactly zero for every
   * pixel; the scaled kernel keeps the per-pixel dc and the family recurrence.
   * Julia's seed is the pixel itself, so that mode stays on the double path. */
  if (g.deepScale && !g.julia)
    return perturbFamDeep(g, R, fx, fy, m2Out, relOut, der2Out);
  const double dcr = (fx + 0.5 - g.halfW) * g.ps - R.dRe;
  const double dci = (g.halfH - fy - 0.5) * g.ps - R.dIm;
  static const bool dbgFam = std::getenv("MB_DEBUGFAM") != nullptr;
  if (dbgFam) {
    std::fprintf(stderr,
                 "[fam] kind=%d p=%d f=(%.3f,%.3f) dc=(%.3g,%.3g) len=%d skip=%d "
                 "maxIter=%d\n",
                 g.kind, g.power, fx, fy, dcr, dci, R.len, R.skip, g.maxIter);
  }

  /* Same dynamic start as the z^2 kernel: the series of this family was built
   * through the reference's own fold pattern, so a pixel near the anchor can
   * begin at its own index instead of at zero. */
  int sk = R.skip;
  if (g.dynSkip && R.skip > 0 && R.len > 3 && R.dcth.size() >= (size_t)R.len) {
    const double ad = std::hypot(dcr, dci);
    int lo = 1, hi = R.len - 2;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if ((double)R.dcth[(size_t)mid] >= ad)
        lo = mid;
      else
        hi = mid - 1;
    }
    sk = lo;
  }

  double dr, di;
  int ridx = 0;
  if (g.julia) {
    dr = dcr;
    di = dci;
  } else if (sk > 0) {
    /* Includes the third-order term: a p > 2 frame that started here with
     * only two of its terms used to drift from the first pixel onwards.
     * Perpendicular's constant is conj(c), so the series variable is the
     * conjugate of the pixel offset. */
    if (g.kind == 4)
      seriesDeviation(R, sk, dcr, -dci, dr, di);
    else
      seriesDeviation(R, sk, dcr, dci, dr, di);
    ridx = sk;
  } else {
    dr = 0.0;
    di = 0.0;
  }
  const double cSign = (g.kind == 2) ? -1.0 : 1.0;
  const double dcrC = g.julia ? 0.0 : cSign * dcr;
  const double dciC = g.julia ? 0.0 : (g.kind == 4 ? -dci : dci);
  /* Phoenix's deviation at n-1; rebasing resets it, which is the only place
   * the one-step memory is genuinely lost and is accepted (rebases happen at
   * |d| ~ |Z|, long after the structure of the frame is decided). */
  double dPrevR = 0.0, dPrevI = 0.0;
  double derR = g.julia ? 1.0 : 0.0, derI = 0.0;
  double chkR = 0.0, chkI = 0.0;
  double chkDR = 0.0, chkDI = 0.0;
  bool chkOn = false;
  double rollR = 0.0, rollI = 0.0;      // last periodic snapshot (moves on)
  double rollDR = 0.0, rollDI = 0.0;
  const int chkStart = ridx > kCycleChk ? ridx : kCycleChk;
  const bool doFixed = ridx <= kCycleChk;

  for (int n = ridx; n < g.maxIter; ++n) {
    if (ridx >= R.len) {
      m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
      return kGlitch;
    }
    double Zr = R.re[(size_t)ridx], Zi = R.im[(size_t)ridx];
    double Z2 = Zr * Zr + Zi * Zi;
    double cross = 2.0 * (Zr * dr + Zi * di);
    double d2 = dr * dr + di * di;
    double m2 = Z2 + cross + d2;
    if (d2 > m2) {

      dr = Zr + dr - R.z0r;
      di = Zi + di - R.z0i;
      ridx = 0;
      dPrevR = 0.0;
      dPrevI = 0.0;
      Zr = R.re[0]; Zi = R.im[0];
      Z2 = Zr * Zr + Zi * Zi;
      cross = 2.0 * (Zr * dr + Zi * di);
      d2 = dr * dr + di * di;
      m2 = Z2 + cross + d2;
    }
    if (m2 > kBail2) {
      m2Out = m2;
      relOut = Z2 > 0.0 ? (cross + d2) / Z2 : 0.0;
      der2Out = g.skipDeriv ? 0.0 : derR * derR + derI * derI;
      return n;
    }
    /* Orbit traps, exactly as in the z^2 kernel.  This family kernel never
     * accumulated them, so a trap pattern on a non-polynomial or p > 2
     * formula read its accumulator's seed instead of the orbit — the
     * "Triangle average (TIA)" pattern came out blank on a custom formula. */
    if (g.wantTrap) {
      const double zrT = Zr + dr, ziT = Zi + di;
      if (g.trapMode == 2) {
        const double d = ziT * ziT;
        if (d < trapAcc()) trapAcc() = d;
      } else if (g.trapMode == 4) {
        trapAcc() += 0.5 * std::log(zrT * zrT + ziT * ziT + 1e-300);
      } else {
        const double r2T = zrT * zrT + ziT * ziT;
        double d = r2T;
        if (g.trapMode == 3) {
          const double r = std::sqrt(r2T);
          d = (r - 1.0) * (r - 1.0);
        }
        if (d < trapAcc()) trapAcc() = d;
      }
    }
    if (g.wantDist && !g.skipDeriv) {
      /* Same correction as perturbPixel: the deviation's own derivative,
       * driven by z = Z + d. */
      const double zrD = Zr + dr, ziD = Zi + di;
      const double odr = 2.0 * (zrD * derR - ziD * derI) + (g.julia ? 0.0 : 1.0);
      const double odi = 2.0 * (zrD * derI + ziD * derR);
      derR = odr; derI = odi;
    }
    const double qr = dr * dr - di * di;
    const double qi = 2.0 * dr * di;
    /* For p = 2 the Jacobian is just 2Z and the Hessian is 1, so the table is
     * not read at all: the loop then streams the two orbit arrays only, which
     * is what makes a burning-ship frame as fast as a Mandelbrot one.
     *
     * p > 2 also needs the cubic term K d^3.  Dropping it is why a multibrot
     * frame at depth rendered a slightly displaced copy of the set: the step
     * was only correct to O(d^2) while |d| was still large right after the
     * skip.  With K in, p = 3 is exact and p = 4..8 is exact through d^3. */
    double jr, ji, hr, hi, kr, ki;
    if (g.power == 2) {
      jr = 2.0 * Zr;
      ji = 2.0 * Zi;
      hr = 1.0;
      hi = 0.0;
      kr = 0.0;
      ki = 0.0;
    } else {
      jr = R.jr[(size_t)ridx];
      ji = R.ji[(size_t)ridx];
      hr = R.hr[(size_t)ridx];
      hi = R.hi[(size_t)ridx];
      kr = R.kr[(size_t)ridx];
      ki = R.ki[(size_t)ridx];
    }
    const double w0 = jr * dr - ji * di;      // 2 Re(Z d)
    const double v0 = jr * di + ji * dr;      // 2 Im(Z d)
    double wr = w0 + hr * qr - hi * qi;
    double wi = v0 + hr * qi + hi * qr;
    if (g.power != 2) {
      const double q3r = qr * dr - qi * di;
      const double q3i = qr * di + qi * dr;
      wr += kr * q3r - ki * q3i;
      wi += kr * q3i + ki * q3r;
    }
    /* The fold is decided by *this pixel's* orbit, not by the reference's.
     * Cheap: Re(Z d) and |d|^2 are already in hand, so Re(z^2) and the sign of
     * Re(z)Im(z) cost one add / one multiply.  Using the reference's sign
     * instead made every folded family quietly render as the Mandelbrot set
     * whenever the anchor happened to sit in one sign quadrant.
     *
     * If this pixel sits in a *different* sign cell than the reference, the
     * linearisation describes a different map and the answer would be wrong:
     * handle it honestly instead of drawing a plausible-looking lie.  Down to
     * 1e-13 a plain double orbit is still exact, so that path is taken; below
     * it the pixel is flagged and goes through the arbitrary-precision
     * fallback. */
    if ((g.kind == 2 || g.kind == 3) && Z2 > d2) {
      /* Only meaningful where the reference term dominates: at n = 0 the
       * reference is exactly 0 and the sign is degenerate, which would flag
       * half the frame as a glitch before anything has even happened. */
      const bool neg = (g.kind == 2)
                           ? ((Zr + dr) * (Zi + di) < 0.0)
                           : ((Zr * Zr - Zi * Zi) + w0 + qr < 0.0);
      const bool refNeg = (g.kind == 2) ? (R.fI[(size_t)ridx] < 0)
                                        : (R.fR[(size_t)ridx] < 0);
      if (neg != refNeg) {
        if (g.ps > 1e-13) return directPixel(g, fx, fy, m2Out, relOut, der2Out);
        m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
        return kGlitch;
      }
    }
    switch (g.kind) {
      case 1:                                  // tricorn: constant conjugate
        wi = -wi;
        break;
      case 2:                                  // burning ship
        if ((Zr + dr) * (Zi + di) < 0.0) wi = -wi;
        break;
      case 3:                                  // celtic
        if ((Zr * Zr - Zi * Zi) + w0 + qr < 0.0) wr = -wr;
        break;
      case 5:                                  // phoenix: one-step memory
        wr += g.phoenixP * dPrevR;
        wi += g.phoenixP * dPrevI;
        break;
      default:
        break;
    }
    const double oldDr = dr, oldDi = di;
    dr = wr + dcrC;
    di = wi + dciC;
    dPrevR = oldDr;
    dPrevI = oldDi;
    ++ridx;
    /* Same fixed + rolling interior check as the standard kernel, but scaled by
     * the deviation.  The old absolute 1e-24 test compared z at n and n+32; at
     * depth the deviation is still 1e-23 there, so a *repelling* anchor whose
     * orbit grows by 4x per step was pronounced stationary and the whole frame
     * came back "interior".  A cycle now has to be stationary relative to the
     * deviation it is measured against, which is scale-free. */
    if (n == chkStart || (chkOn && (n & 31) == 0)) {
      if (ridx < R.len) {
        const double zrNow = R.re[(size_t)ridx] + dr;
        const double ziNow = R.im[(size_t)ridx] + di;
        const double dScale = dr * dr + di * di + 1e-300;
        const double tol = 1e-24 * dScale;
        if (n == chkStart) {
          chkR = zrNow; chkI = ziNow;
          chkDR = dr;   chkDI = di;
          chkOn = true;
          rollR = zrNow; rollI = ziNow;
          rollDR = dr;   rollDI = di;
        } else {
          if (doFixed) {
            const double dx = zrNow - chkR, dy = ziNow - chkI;
            const double ddx = dr - chkDR, ddy = di - chkDI;
            if (dx * dx + dy * dy < tol && ddx * ddx + ddy * ddy < tol) {
              m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
              return -1 - (n - kCycleChk);
            }
          }
          const double rx = zrNow - rollR, ry = ziNow - rollI;
          const double rdx = dr - rollDR, rdy = di - rollDI;
          if (rx * rx + ry * ry < tol && rdx * rdx + rdy * rdy < tol) {
            m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
            return -1;
          }
          rollR = zrNow; rollI = ziNow;
          rollDR = dr;   rollDI = di;
        }
      }
    }
  }
  m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
  return -1;
}

/* One entry point for both kernels: `g.fam` was decided once for the frame,
 * so the branch is perfectly predictable and costs nothing per pixel. */
int pertPixel(const Ctx& g, double fx, double fy, int refIdx,
              double& m2Out, double& relOut, double& der2Out,
              ValueProbe* probe) {
  /* One place seeds the trap accumulator: a minimum starts at +inf, the TIA
   * sum starts at zero.  Every kernel path reads and writes trapAcc(), so no
   * return statement has to remember to publish it. */
  if (g.wantTrap) trapAcc() = (g.trapMode == 4) ? 0.0 : 1e30;
  if (g.fam) {
    /* The family maps are not holomorphic: there is no dz/dc to interpolate
     * and no value the canvas may use.  Leave the probe invalid so the canvas
     * stays on the count for these kinds. */
    return perturbFam(g, fx, fy, refIdx, m2Out, relOut, der2Out);
  }
  return perturbPixel(g, fx, fy, refIdx, m2Out, relOut, der2Out, probe);
}

/* ---- four pixels at a time (AVX2) -----------------------------------
 *
 * The per-pixel recurrence is a dependency chain, so one pixel at a time
 * leaves most of the FP units idle.  Four adjacent pixels run four independent
 * chains, which is what AVX2 wants: the same instruction count per iteration
 * now advances four pixels.
 *
 * The obstacle to vectorising perturbation is re-anchoring.  A pixel whose
 * deviation has grown as large as its reference has to restart at index 0, and
 * then four lanes would need four different reference indices — a gather per
 * step, which costs more than the arithmetic saves.
 *
 * The way out: re-anchoring is a *change of variables*, not a correction.
 * d = z - Z_0 describes the same z wherever it is applied, so when any lane
 * needs it, all four re-anchor together and the group keeps one shared index.
 * Z_n then stays a scalar broadcast instead of a gather.
 *
 * The loop below is a transliteration of `perturbPixel`: same expressions, same
 * order, with V4 standing in for double.  Writing it that way is deliberate —

 * an earlier hand-expanded version had a sign error that produced a plausible
 * but wrong picture.
 */
#if defined(__AVX2__)
struct V4 {
  __m256d v;
  V4() : v(_mm256_setzero_pd()) {}
  explicit V4(__m256d x) : v(x) {}
};
inline V4 v4(double x) { return V4(_mm256_set1_pd(x)); }
inline V4 blend(V4 a, V4 b, int mask) {
  return V4(_mm256_blendv_pd(a.v, b.v,
                             _mm256_castsi256_pd(_mm256_set_epi64x(
                                 (mask & 8) ? -1 : 0, (mask & 4) ? -1 : 0,
                                 (mask & 2) ? -1 : 0, (mask & 1) ? -1 : 0))));
}
inline V4 operator+(V4 a, V4 b) { return V4(_mm256_add_pd(a.v, b.v)); }
inline V4 operator-(V4 a, V4 b) { return V4(_mm256_sub_pd(a.v, b.v)); }
inline V4 operator*(V4 a, V4 b) { return V4(_mm256_mul_pd(a.v, b.v)); }
inline V4 operator*(double s, V4 a) { return a * V4(_mm256_set1_pd(s)); }
inline V4 operator*(V4 a, double s) { return a * V4(_mm256_set1_pd(s)); }
inline V4 operator+(V4 a, double s) { return a + V4(_mm256_set1_pd(s)); }
inline V4 operator-(V4 a, double s) { return a - V4(_mm256_set1_pd(s)); }

/* The comparison predicate must be a literal: the intrinsic takes it as an
 * immediate, so a runtime flag would not compile. */
inline int laneGt(V4 a, V4 b) {
  return _mm256_movemask_pd(_mm256_cmp_pd(a.v, b.v, _CMP_GT_OQ));
}
inline int laneLt(V4 a, V4 b) {
  return _mm256_movemask_pd(_mm256_cmp_pd(a.v, b.v, _CMP_LT_OQ));
}

long long perturbQuad(const Ctx& g, const Ref& R, const double* fxs, double fy,
                             int count, int* nOut, double* m2Out, double* relOut,
                             double* zrOut, double* ziOut) {
  if (count < 1) return 0;
  /* Kept in a register and returned, rather than written through a pointer:
   * an out-parameter makes MSVC assume it may alias the orbit arrays and
   * reload them on every iteration, which cost ~2x on deep frames. */
  long long rebCount = 0;
  /* Per-lane geometry, seeded with exactly the scalar expressions.  Every
   * caller passes four valid coordinates — a row tail repeats its last column
   * — so all four slots are written before the V4 loads. */
  double dcrA[4], dciA[4], drA[4], diA[4];
  int ridxA[4];
  /* The y offset used to be shared by all four lanes (it had no x term), but a
   * rotated view couples the two axes, so each lane now converts its own x.
   * That costs one subtract per lane against a loop that runs thousands of
   * iterations. */

  int sk = R.skip;
  int skA[4];
  for (int k = 0; k < count; ++k) {
    double aa, bb;
    screenDelta(g, fxs[k], fy, aa, bb);
    dcrA[k] = aa - R.dRe;
    dciA[k] = bb - R.dIm;
    skA[k] = R.skip;
    if (g.dynSkip && R.skip > 0 && R.len > 3 && R.dcth.size() >= (size_t)R.len) {
      const double ad = std::hypot(dcrA[k], dciA[k]);
      int lo = 1, hi = R.len - 2;
      while (lo < hi) {
        const int mid = (lo + hi + 1) >> 1;
        if ((double)R.dcth[(size_t)mid] >= ad) lo = mid; else hi = mid - 1;
      }
      skA[k] = lo;
    }
    /* The lanes share the loop counter, so they must share a start.  Taking
     * the earliest start means a lane may carry one or two more series terms
     * than it needs, which is strictly more accurate, never less. */
    if (skA[k] < sk || k == 0) sk = (k == 0 ? skA[k] : sk);
  }
  for (int k = 0; k < count; ++k) if (skA[k] < sk) sk = skA[k];

  for (int k = 0; k < count; ++k) {
    const double dcr = dcrA[k], dci = dciA[k];
    if (g.julia) {
      drA[k] = dcr;
      diA[k] = dci;
      ridxA[k] = 0;
    } else if (sk > 0) {
      seriesDeviation(R, sk, dcr, dci, drA[k], diA[k]);
      ridxA[k] = sk;
    } else {
      drA[k] = 0.0;
      diA[k] = 0.0;
      ridxA[k] = 0;
    }
  }
  /* All four lanes carry a real pixel, so every reference index below is in
   * range.  Leaving these lanes uninitialised was the crash on row tails. */
  V4 dr = V4(_mm256_loadu_pd(drA));
  V4 di = V4(_mm256_loadu_pd(diA));
  const V4 dcrV = V4(_mm256_loadu_pd(dcrA));
  const V4 dciV = V4(_mm256_loadu_pd(dciA));
  const V4 dcC = g.julia ? v4(0.0) : dcrV;
  const V4 dcI = g.julia ? v4(0.0) : dciV;
  const V4 z0r = v4(R.z0r), z0i = v4(R.z0i);

  V4 chkR = v4(0.0), chkI = v4(0.0);
  V4 rollR = v4(0.0), rollI = v4(0.0);
  bool chkOn = false;
  const int chkStart = sk > kCycleChk ? sk : kCycleChk;
  const bool doFixed = sk <= kCycleChk;
  int active = (1 << count) - 1;
  int esc[4] = {-1, -1, -1, -1};
  double escM2[4] = {0, 0, 0, 0};
  double escRel[4] = {0, 0, 0, 0};
  int cycleRes[4] = {-1, -1, -1, -1};
  /* CHANNEL_VALUE: z at the moment the lane first crosses |z| = 2 — the seed
   * the Texture scheme continues for twenty steps of its own.  Captured in the
   * vector loop because the alternative (the scalar kernel) costs 3.4x on a
   * mid-depth view, where this kernel is the whole reason the field is cheap.
   * The check costs one compare + one movemask per step and only blends on the
   * step that actually crosses. */
  V4 capR = v4(0.0), capI = v4(0.0);
  int capMask = 0;

  for (int n = sk; n < g.maxIter && active; ++n) {
    /* Reference values, one load per lane: after a per-lane re-anchor the four
     * indices differ, and a gather costs more than four scalar loads.  The
     * vectors are assembled with set_pd, not through a stack array — writing
     * four doubles and reading them back costs a store-forwarding stall in the
     * middle of the loop, which measured as the whole speed-up. */
    double zr0, zr1, zr2, zr3, zi0, zi1, zi2, zi3;
    int dead = 0;
    const double* reP = R.re.data();
    const double* imP = R.im.data();
    {
      const int i0 = ridxA[0], i1 = ridxA[1], i2 = ridxA[2], i3 = ridxA[3];
      if (i0 >= R.len || i1 >= R.len || i2 >= R.len || i3 >= R.len) {
        for (int k = 0; k < count; ++k)
          if (ridxA[k] >= R.len) dead |= 1 << k;
        if (dead & active) {
          for (int k = 0; k < count; ++k) {
            if (!(dead & active & (1 << k))) continue;
            esc[k] = kGlitch;
            active &= ~(1 << k);
          }
          if (!active) break;
        }
      }
      const int a0 = i0 < R.len ? i0 : 0, a1 = i1 < R.len ? i1 : 0;
      const int a2 = i2 < R.len ? i2 : 0, a3 = i3 < R.len ? i3 : 0;
      zr0 = reP[a0]; zi0 = imP[a0];
      zr1 = reP[a1]; zi1 = imP[a1];
      zr2 = reP[a2]; zi2 = imP[a2];
      zr3 = reP[a3]; zi3 = imP[a3];
    }

    V4 Zr(_mm256_set_pd(zr3, zr2, zr1, zr0));
    V4 Zi(_mm256_set_pd(zi3, zi2, zi1, zi0));
    V4 Z2 = Zr * Zr + Zi * Zi;
    V4 cross = 2.0 * (Zr * dr + Zi * di);
    V4 d2 = dr * dr + di * di;
    V4 m2 = Z2 + cross + d2;

    const int rb = laneGt(d2, m2) & active;
    if (rb) {
      ++rebCount;
      /* Only the lanes that need it, so every lane keeps the schedule the
       * scalar kernel would have used. */
      dr = blend(dr, Zr + dr - z0r, rb);
      di = blend(di, Zi + di - z0i, rb);
      for (int k = 0; k < count; ++k) if (rb & (1 << k)) ridxA[k] = 0;
      Zr = blend(Zr, z0r, rb);
      Zi = blend(Zi, z0i, rb);
      Z2 = Zr * Zr + Zi * Zi;
      cross = 2.0 * (Zr * dr + Zi * di);
      d2 = dr * dr + di * di;
      m2 = Z2 + cross + d2;
    }

    const int em = laneGt(m2, v4(kBail2)) & active;
    if (zrOut) {
      const int hit = laneGt(m2, v4(4.0)) & active & ~capMask;
      if (hit) {
        capR = blend(capR, Zr + dr, hit);
        capI = blend(capI, Zi + di, hit);
        capMask |= hit;
      }
    }
    if (em) {
      double mv[4], mvv[4], zz[4], zz2[4];
      _mm256_storeu_pd(mv, m2.v);
      _mm256_storeu_pd(mvv, cross.v);
      _mm256_storeu_pd(zz, d2.v);
      _mm256_storeu_pd(zz2, Z2.v);
      for (int k = 0; k < count; ++k) {
        if (!(em & (1 << k))) continue;
        esc[k] = n;
        escM2[k] = mv[k];
        escRel[k] = zz2[k] > 0.0 ? (mvv[k] + zz[k]) / zz2[k] : 0.0;
        active &= ~(1 << k);
      }
      if (!active) break;
    }

    const V4 nr = 2.0 * (Zr * dr - Zi * di) + (dr * dr - di * di) + dcC;
    const V4 ni = 2.0 * (Zr * di + Zi * dr) + 2.0 * dr * di + dcI;
    dr = nr;
    di = ni;
    for (int k = 0; k < count; ++k) ++ridxA[k];

    /* Fixed + rolling orbit snapshots.  A lane whose orbit has stopped
     * changing over the last 32 iterations is interior; dropping it from
     * `active` here simply stops its iterations, and the fallthrough below
     * already reports -1 for such a lane — exactly what running to the limit
     * would have produced.  Snapshots use the *current* reference index
     * (ridxA was just advanced), not the pre-step Zr/Zi.
     *
     * With series approximation the loop starts at n = sk (often thousands),
     * so `n == kCycleChk` never happens and the fixed check would silently
     * never arm.  The first snapshot is therefore taken at the loop's own
     * first iteration; the fixed check stays disabled in that case, since it
     * never ran before either. */
    if (n == chkStart || (chkOn && (n & 31) == 0)) {
      double ck[4], cki[4];
      for (int k = 0; k < count; ++k) {
        const int r2 = ridxA[k] < R.len ? ridxA[k] : R.len - 1;
        ck[k] = R.re[(size_t)r2];
        cki[k] = R.im[(size_t)r2];
      }
      const V4 zrNow = V4(_mm256_loadu_pd(ck)) + dr;
      const V4 ziNow = V4(_mm256_loadu_pd(cki)) + di;
      if (n == chkStart) {
        chkR = zrNow; chkI = ziNow; chkOn = true;
        rollR = zrNow; rollI = ziNow;
      } else {
        if (doFixed) {
          const V4 dx = zrNow - chkR, dy = ziNow - chkI;
          const int cm = laneLt(dx * dx + dy * dy, v4(1e-30)) & active;
          if (cm) {
            for (int k = 0; k < count; ++k) {
              if (!(cm & (1 << k))) continue;
              cycleRes[k] = -1 - (n - kCycleChk);
              active &= ~(1 << k);
            }
            if (!active) break;
          }
        }
        /* Relative tolerance: |z| itself can be huge near the bailout, so an
         * absolute 1e-14 there would never be reached in double precision. */
        const V4 rx = zrNow - rollR, ry = ziNow - rollI;
        const V4 z2 = zrNow * zrNow + ziNow * ziNow;
        const int rm = laneLt(rx * rx + ry * ry,
                              v4(1e-24) * (z2 + v4(1.0))) & active;
        if (rm) {
          for (int k = 0; k < count; ++k)
            if (rm & (1 << k)) active &= ~(1 << k);
        }
        rollR = zrNow; rollI = ziNow;
        if (!active) break;
      }
    }
  }

  for (int k = 0; k < count; ++k) {
    if (esc[k] == kGlitch) {
      nOut[k] = kGlitch; m2Out[k] = 0.0; relOut[k] = 0.0;
    } else if (esc[k] >= 0) {
      nOut[k] = esc[k]; m2Out[k] = escM2[k]; relOut[k] = escRel[k];
    } else if (cycleRes[k] != -1) {
      nOut[k] = cycleRes[k]; m2Out[k] = 0.0; relOut[k] = 0.0;
    } else {
      /* Bounded, but this lane's cycle did not close inside the 32-step
       * snapshot grid (or it was judged stationary by the rolling compare).
       * Hand it back so the caller can name the period exactly. */
      nOut[k] = kRecheck; m2Out[k] = 0.0; relOut[k] = 0.0;
    }
  }
  if (zrOut) {
    double cr4[4], ci4[4];
    _mm256_storeu_pd(cr4, capR.v);
    _mm256_storeu_pd(ci4, capI.v);
    for (int k = 0; k < count; ++k) {
      zrOut[k] = (capMask & (1 << k)) ? cr4[k] : 0.0;
      ziOut[k] = (capMask & (1 << k)) ? ci4[k] : 0.0;
    }
  }
  return rebCount;
}

/* Four independent pixels of the plain z^2+c map, side by side.
 *
 * The direct path is what every shallow view runs — the home frame, the
 * thumbnail strip, every preset until the zoom crosses 2^-42 — and it used to
 * be strictly scalar: one pixel per pass over the pipeline, with the branch on
 * `kind` inside the loop.  Here the four lanes are four *pixels*, not four
 * terms of one pixel, so there is no reference orbit to share and no
 * re-anchoring to schedule: each lane just runs its own orbit and drops out
 * when it escapes.  That is the whole trick, and it is worth roughly 3.5x on
 * the frames the user sees most. */
void directQuad2(const Ctx& g, const double* fxs, double fy, int count,
                        int* nOut, double* m2Out, double* zrOut,
                        double* ziOut) {
  double crA[4], ciA[4], zrA[4], ziA[4];
  /* Four valid pixels per call; a row tail repeats its last column.  Each lane
   * converts its own screen x, so a rotated view costs the same code path —
   * the rotation lives inside screenDelta() and nowhere else. */
  for (int k = 0; k < count; ++k) {
    double pxr, pxi;
    screenDelta(g, fxs[k], fy, pxr, pxi);
    if (g.julia) {
      crA[k] = g.jr;
      ciA[k] = g.ji;
      zrA[k] = g.cre + pxr;
      ziA[k] = g.cim + pxi;
    } else {
      crA[k] = g.cre + pxr;
      ciA[k] = g.cim + pxi;
      zrA[k] = 0.0;
      ziA[k] = 0.0;
    }
  }
  /* Every lane holds a finite c; no wild V4 loads on a short row tail. */
  const V4 cr = V4(_mm256_loadu_pd(crA));
  const V4 ci = V4(_mm256_loadu_pd(ciA));
  V4 zr = V4(_mm256_loadu_pd(zrA));
  V4 zi = V4(_mm256_loadu_pd(ziA));

  V4 chkR = v4(0.0), chkI = v4(0.0);
  V4 rollR = v4(0.0), rollI = v4(0.0);
  bool chkOn = false;
  /* Lanes whose c lies in the main cardioid / period-2 disc are already done:
   * no orbit to integrate, no periodicity check to run. */
  int active = 0;
  if (!g_noBulb && !g.julia) {
    for (int k = 0; k < count; ++k) {
      const int per = interiorPeriod(crA[k], ciA[k]);
      if (per) {
        nOut[k] = -1 - per;
        m2Out[k] = 0.0;
      } else {
        active |= 1 << k;
      }
    }
  } else {
    active = (1 << count) - 1;
  }
  const int live0 = active;
  int esc[4] = {-1, -1, -1, -1};
  int cyc[4] = {-1, -1, -1, -1};
  double escM2[4] = {0, 0, 0, 0};
  /* See perturbQuad: CHANNEL_VALUE wants z at the first |z| = 2 crossing. */
  V4 capR = v4(0.0), capI = v4(0.0);
  int capMask = 0;

  for (int n = 0; n < g.maxIter && active; ++n) {
    const V4 m2 = zr * zr + zi * zi;
    const int em = laneGt(m2, v4(kBail2)) & active;
    if (zrOut) {
      const int hit = laneGt(m2, v4(4.0)) & active & ~capMask;
      if (hit) {
        capR = blend(capR, zr, hit);
        capI = blend(capI, zi, hit);
        capMask |= hit;
      }
    }
    if (em) {
      double mv[4];
      _mm256_storeu_pd(mv, m2.v);
      for (int k = 0; k < count; ++k) {
        if (!(em & (1 << k))) continue;
        esc[k] = n;
        escM2[k] = mv[k];
        active &= ~(1 << k);
      }
      if (!active) break;
    }
    const V4 nr = zr * zr - zi * zi + cr;
    const V4 ni = 2.0 * zr * zi + ci;
    zr = nr;
    zi = ni;

    if (n == kCycleChk || (chkOn && (n & 3) == 0)) {
      if (n == kCycleChk) {
        chkR = zr; chkI = zi; chkOn = true;
        rollR = zr; rollI = zi;
      } else {
        const V4 dx = zr - chkR;
        const V4 dy = zi - chkI;
        const int cm = laneLt(dx * dx + dy * dy, v4(1e-30)) & active;
        if (cm) {
          for (int k = 0; k < count; ++k) {
            if (!(cm & (1 << k))) continue;
            cyc[k] = -1 - (n - kCycleChk);
            active &= ~(1 << k);
          }
          if (!active) break;
        }
        const V4 rx = zr - rollR, ry = zi - rollI;
        const V4 z2 = zr * zr + zi * zi;
        const int rm = laneLt(rx * rx + ry * ry,
                              v4(1e-24) * (z2 + v4(1.0))) & active;
        if (rm) {
          for (int k = 0; k < count; ++k)
            if (rm & (1 << k)) active &= ~(1 << k);
        }
        rollR = zr; rollI = zi;
        if (!active) break;
      }
    }
  }

  for (int k = 0; k < count; ++k) {
    if (!(live0 & (1 << k))) continue;    // analytic interior, filled above
    if (esc[k] >= 0) {
      nOut[k] = esc[k];
      m2Out[k] = escM2[k];
    } else if (cyc[k] != -1) {
      nOut[k] = cyc[k];
      m2Out[k] = 0.0;
    } else {
      /* Bounded, but neither the analytic bulb test nor the four-step cycle
       * check could name the period.  The caller re-runs this one pixel
       * through directPixel, which has the full Brent finder. */
      nOut[k] = kRecheck;
      m2Out[k] = 0.0;
    }
  }
  if (zrOut) {
    double cr4[4], ci4[4];
    _mm256_storeu_pd(cr4, capR.v);
    _mm256_storeu_pd(ci4, capI.v);
    for (int k = 0; k < count; ++k) {
      zrOut[k] = (capMask & (1 << k)) ? cr4[k] : 0.0;
      ziOut[k] = (capMask & (1 << k)) ? ci4[k] : 0.0;
    }
  }
}

#endif

/* Direct iteration in plain double.  Covers every formula kind and is the
 * right tool whenever one pixel still holds thousands of double steps of
 * resolution. */
int directPixel(const Ctx& g, double fx, double fy, double& m2Out,
                double& relOut, double& der2Out, ValueProbe* probe) {
  /* One place seeds the trap accumulator: a minimum starts at +inf, the TIA
   * sum starts at zero.  pertPixel does this too; this kernel needs its own
   * because the accumulator is thread-local and has to be reset per pixel,
   * not per frame. */
  if (g.wantTrap) trapAcc() = (g.trapMode == 4) ? 0.0 : 1e30;
  double pxr, pxi;
  screenDelta(g, fx, fy, pxr, pxi);
  double cr, ci, zr, zi;
  if (g.julia) {
    cr = g.jr;
    ci = g.ji;
    zr = g.cre + pxr;
    zi = g.cim + pxi;
  } else {
    cr = g.cre + pxr;
    ci = g.cim + pxi;
    zr = 0.0;
    zi = 0.0;
  }
  /* Phoenix keeps z_{n-1}; z_{-1} = 0 in both modes. */
  double prevR = 0.0, prevI = 0.0;
  /* dz/dc exists only for the holomorphic forms (kind 0); the conjugate and
   * absolute-value variants have no complex derivative, so distance-based
   * schemes draw no rim there rather than a wrong one. */
  const bool wantDer =
      g.kind == 0 &&
      ((g.wantDist && !g.skipDeriv) || (probe != nullptr && !g.zOnly));
  double derR = g.julia ? 1.0 : 0.0, derI = 0.0;
  double chkR = 0.0, chkI = 0.0;
  bool chkOn = false;
  double rollR = 0.0, rollI = 0.0;
  if (!g_noBulb && !g.julia && g.kind == 0 && g.power == 2) {
    const int per = interiorPeriod(cr, ci);
    if (per) {
      m2Out = 0.0;
      relOut = 0.0;
      der2Out = 0.0;
      return -1 - per;
    }
  }
  for (int n = 0; n < g.maxIter; ++n) {
    const double m2 = zr * zr + zi * zi;
    /* CHANNEL_VALUE wants the z at the *reference's* bailout radius, not at
     * ours.  The reference stops at |z|^2 > 4; this kernel keeps going to
     * 2^16 because a larger radius gives a smoother smooth-iteration, but the
     * Texture scheme continues that z itself and compares |z|^2 against
     * limit = exp((-param+0.33)*5), a number near 2.  Feeding it 2^32 would
     * put every pixel at the end of the loop and turn the texture into noise.
     * So the first crossing of radius 2 is the value that gets published. */
    if (probe && g.zOnly && !probe->valid && m2 > 4.0) {
      probe->zr = zr;
      probe->zi = zi;
      probe->valid = true;
    }
    if (m2 > kBail2) {
      m2Out = m2;
      relOut = 0.0;
      der2Out = g.skipDeriv ? 0.0 : derR * derR + derI * derI;
      if (probe) {
        if (!g.zOnly) {
          probe->zr = zr;
          probe->zi = zi;
        }
        probe->dr = derR;
        probe->di = derI;
        probe->valid = true;
        probe->hasDer = wantDer;
      }
      return n;
    }
    if (wantDer) {
      const double odr = 2.0 * (zr * derR - zi * derI) + (g.julia ? 0.0 : 1.0);
      const double odi = 2.0 * (zr * derI + zi * derR);
      derR = odr;
      derI = odi;
    }
    /* Orbit traps.  This kernel — the one every shallow frame runs — never
     * accumulated them either; only the perturbed kernel did.  A trap pattern
     * therefore read its seed on the home view and on every direct-iteration
     * formula, which is why "Triangle average (TIA)" arrived blank. */
    if (g.wantTrap) {
      if (g.trapMode == 2) {
        const double d = zi * zi;
        if (d < trapAcc()) trapAcc() = d;
      } else if (g.trapMode == 4) {
        trapAcc() += 0.5 * std::log(zr * zr + zi * zi + 1e-300);
      } else {
        const double r2T = zr * zr + zi * zi;
        double d = r2T;
        if (g.trapMode == 3) {
          const double r = std::sqrt(r2T);
          d = (r - 1.0) * (r - 1.0);
        }
        if (d < trapAcc()) trapAcc() = d;
      }
    }
    switch (g.kind) {
      case 1: {                       // tricorn: z -> conj(z)^p + c
        double tr = zr, ti = -zi;
        cpow(tr, ti, g.power);
        zr = tr + cr;
        zi = ti + ci;
        break;
      }
      case 2: {                       // burning ship: |Re|,|Im|
        double tr = std::fabs(zr), ti = std::fabs(zi);
        cpow(tr, ti, g.power);
        zr = tr - cr;
        zi = ti + ci;
        break;
      }
      case 3: {                       // celtic: |Re(z^p)|
        double tr = zr, ti = zi;
        cpow(tr, ti, g.power);
        zr = std::fabs(tr) + cr;
        zi = ti + ci;
        break;
      }
      case 4: {                       // perpendicular: z^p - conj(c)
        double tr = zr, ti = zi;
        cpow(tr, ti, g.power);
        zr = tr + cr;
        zi = ti - ci;
        break;
      }
      case 5: {                       // phoenix: z^2 + P*z_prev + c
        const double tr = zr * zr - zi * zi + g.phoenixP * prevR + cr;
        const double ti = 2.0 * zr * zi + g.phoenixP * prevI + ci;
        prevR = zr;
        prevI = zi;
        zr = tr;
        zi = ti;
        break;
      }
      default: {                      // z^p + c  (Mandelbrot / Julia)
        double tr = zr, ti = zi;
        cpow(tr, ti, g.power);
        zr = tr + cr;
        zi = ti + ci;
        break;
      }
    }
    if (n == kCycleChk || (chkOn && (n & 3) == 0)) {
      if (n == kCycleChk) {
        chkR = zr; chkI = zi; chkOn = true;
        rollR = zr; rollI = zi;
      } else {
        const double dx = zr - chkR, dy = zi - chkI;
        const double zz = zr * zr + zi * zi;
        if (dx * dx + dy * dy < 1e-24 * (zz + 1.0)) {
          m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
          return -1 - (n - kCycleChk);
        }
        const double rx = zr - rollR, ry = zi - rollI;
        const double z2 = zr * zr + zi * zi;
        if (rx * rx + ry * ry < 1e-24 * (z2 + 1.0)) {
          m2Out = 0.0; relOut = 0.0; der2Out = 0.0;
          return -1;
        }
        rollR = zr; rollI = zi;
      }
    }
  }
  m2Out = zr * zr + zi * zi;
  relOut = 0.0;
  der2Out = 0.0;
  return -1;
}

int bigPixel(const Ctx& g, const BigSeed& B, int bits, double fx,
                    double fy, double& m2Out, double& relOut) {
  Big zr(bits), zi(bits);
  Big cr = B.cRe, ci = B.cIm;
  /* The pixel's offset from the frame centre.  Below the double range the
   * double form is exactly zero and every pixel would iterate the centre's
   * own orbit; the scaled form builds the same value in the Big domain,
   * where `bits` fractional bits is exactly what this path exists for. */
  Big offR(bits), offI(bits);
  if (g.deepScale) {
    SC s;
    screenDeltaScaled(g, fx, fy, s);
    offR = Big::fromDouble(s.r, bits);
    offI = Big::fromDouble(s.i, bits);
    if (s.e != 0) { offR = offR.shifted(s.e); offI = offI.shifted(s.e); }
  } else {
    double dcr = 0.0, dci = 0.0;
    screenDelta(g, fx, fy, dcr, dci);
    offR = Big::fromDouble(dcr, bits);
    offI = Big::fromDouble(dci, bits);
  }
  if (B.julia) {
    zr = B.zRe.add(offR);
    zi = B.zIm.add(offI);
  } else {
    cr = cr.add(offR);
    ci = ci.add(offI);
  }
  Big prevR(bits), prevI(bits);
  Big* const prevP = g.kind == 5 ? &prevR : nullptr;
  Big* const prevQ = g.kind == 5 ? &prevI : nullptr;
  for (int n = 0; n < g.maxIter; ++n) {
    if (expOf(zr) > kEscapeExp || expOf(zi) > kEscapeExp) {
      const double ar = zr.toDouble(), ai = zi.toDouble();
      m2Out = ar * ar + ai * ai;
      relOut = 0.0;
      return n;
    }
    if (g.kind == 0 && g.power == 2) {
      const Big zr2 = zr.mul(zr);
      const Big zi2 = zi.mul(zi);
      const Big nr = zr2.sub(zi2).add(cr);
      const Big ni = zr.mul(zi).shifted(1).add(ci);
      zr = nr;
      zi = ni;
    } else {
      famStepBig(g.kind, g.power, zr, zi, cr, ci, g.phoenixP, prevP, prevQ);
    }
  }
  m2Out = 0.0;
  relOut = 0.0;
  return -1;
}

}  // namespace detail
}  // namespace mbc
