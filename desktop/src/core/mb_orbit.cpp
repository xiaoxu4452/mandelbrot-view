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

/* GMP mpf 链版本的参考轨道（原版 computergroup + iter 链，004f8d20）。
 * 只覆盖经典曼德博（kind 0 / power 2 / 非 Julia）；其它族返回 -1 让调用方
 * 回退到 Big 定点路径。返回 -1 表示"没接管"，>=0 是轨道长度。 */
int buildReferenceMpf(const Request& q, int bits, int maxIter, double dRe,
                      double dIm, Ref* out) {
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
  /* 顺序同伪代码：先平方，再用**旧** x,y 算 ny，最后写 nx。 */
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

/* MB_ORBITMPF=0 关掉新路径；默认接管经典曼德博。 */
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
                   double dRe, double dIm, Ref* out) {
  if (orbitMpfEnabled()) {
    const int n = buildReferenceMpf(q, bits, maxIter, dRe, dIm, out);
    if (n >= 0) return n;
  }
  const bool julia = q.spec.mode == 1;
  Big cr(bits), ci(bits), zr(bits), zi(bits);

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
  for (; n < maxIter; ++n) {
    if (out) {
      out->re[(size_t)n] = zr.toDouble();
      out->im[(size_t)n] = zi.toDouble();
    }
    /* |z| > 2^16 is decided on the exponents alone, so the test is free and
     * never rounds.  Past this point the orbit carries no information a
     * perturbation pixel can use. */
    if (expOf(zr) > kEscapeExp || expOf(zi) > kEscapeExp) {
      if (out) out->escaped = true;
      ++n;
      break;
    }
    famStepBig(q.spec.kind, q.spec.power, zr, zi, cr, ci);
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

/* Taylor series of the deviation.  `dcMax` is the largest |dc| in the frame;
 * the skip length is the last n whose quadratic and cubic terms are still
 * negligible there — the same criterion KF uses (relative error 1e-3). */

void buildSeries(Ref& R, double dcMax, bool mandelbrot, int power, int kind) {
  const size_t n = (size_t)std::max(1, R.len);
  R.ar.assign(n, 0.0);
  R.ai.assign(n, 0.0);
  R.br.assign(n, 0.0);
  R.bi.assign(n, 0.0);
  R.cr.assign(n, 0.0);
  R.ci.assign(n, 0.0);
  R.dcth.assign(n, 0.0f);
  R.skip = 0;
  /* A folded family is only polynomial inside one sign cell.  Tricorn's flip
   * is the same at every step (a constant conjugation), so its series is
   * exact; burning ship and celtic flip somewhere along the orbit and the
   * series would then describe a different map, so they start at n = 0 and
   * rely on the native kernel alone.
   *
   * Any power p >= 2 is allowed now: the step coefficients J, H, K come from
   * buildDevTable, so the series is the same three recurrences for every
   * multibrot instead of only for z^2. */
  if (R.len < 2) return;
  if (kind != 0 && kind != 1) return;
  static const bool noSeries = std::getenv("MB_NOSERIES") != nullptr;

  /* d z_n / d c is 0 at n = 0 for the Mandelbrot set (z_0 is a constant),
   * and 1 for Julia (z_0 is the pixel).  The +1 in the recurrence is the
   * derivative of the additive constant: dropping it makes A identically
   * zero and silently disables the whole skip. */
  const double add = mandelbrot ? ((kind == 2) ? -1.0 : 1.0) : 0.0;
  double ar = mandelbrot ? 0.0 : 1.0, ai = 0.0, br = 0.0, bi = 0.0;
  double crc = 0.0, cci = 0.0;
  R.ar[0] = ar;
  int skip = 0;
  for (int k = 0; k + 1 < R.len; ++k) {
    const double zr = R.re[(size_t)k], zi = R.im[(size_t)k];
    /* Step coefficients of d' = F ( J d + H d^2 + K d^3 ) + dc.  For p = 2 the
     * table is not built, because J = 2Z, H = 1, K = 0 in closed form. */
    double jr, ji, hr, hi, kr, ki;
    if (power == 2) {
      jr = 2.0 * zr; ji = 2.0 * zi;
      hr = 1.0; hi = 0.0;
      kr = 0.0; ki = 0.0;
    } else {
      jr = R.jr[(size_t)k]; ji = R.ji[(size_t)k];
      hr = R.hr[(size_t)k]; hi = R.hi[(size_t)k];
      kr = R.kr[(size_t)k]; ki = R.ki[(size_t)k];
    }
    /* d' = F ( 2Z d + d^2 ) + dc, composed through the fold of step k. */
    const double fr = R.fR.empty() ? 1.0 : (double)R.fR[(size_t)k];
    const double fi = R.fI.empty() ? 1.0 : (double)R.fI[(size_t)k];
    const double a2r = ar * ar - ai * ai;
    const double a2i = 2.0 * ar * ai;
    const double nar = (jr * ar - ji * ai) * fr + add;
    const double nai = (jr * ai + ji * ar) * fi;
    const double nbr = (jr * br - ji * bi + hr * a2r - hi * a2i) * fr;
    const double nbi = (jr * bi + ji * br + hr * a2i + hi * a2r) * fi;
    /* Cubic term: J C + 2 H A B + K A^3, with A^3 = A^2 * A. */
    const double a3r = a2r * ar - a2i * ai;
    const double a3i = a2r * ai + a2i * ar;
    const double abr = ar * br - ai * bi;
    const double abi = ar * bi + ai * br;
    const double ncr = (jr * crc - ji * cci + 2.0 * (hr * abr - hi * abi) +
                        kr * a3r - ki * a3i) * fr;
    const double nci = (jr * cci + ji * crc + 2.0 * (hr * abi + hi * abr) +
                        kr * a3i + ki * a3r) * fi;
    ar = nar; ai = nai;
    br = nbr; bi = nbi;
    crc = ncr; cci = nci;
    if (!std::isfinite(ar) || !std::isfinite(ai) || !std::isfinite(br) ||
        !std::isfinite(bi) || !std::isfinite(crc) || !std::isfinite(cci))
      break;
    R.ar[(size_t)k + 1] = ar;
    R.ai[(size_t)k + 1] = ai;
    R.br[(size_t)k + 1] = br;
    R.bi[(size_t)k + 1] = bi;
    R.cr[(size_t)k + 1] = crc;
    R.ci[(size_t)k + 1] = cci;
    const double amag = std::hypot(ar, ai);
    const double bmag = std::hypot(br, bi);
    const double cmag = std::hypot(crc, cci);
    /* Scale-invariant test: the quadratic and cubic terms must be negligible
     * *relative* to the linear one everywhere in the frame.  There is
     * deliberately no cap on |A| — a large A only means the linear image of the
     * frame is large, which the pixel kernel scales out again; capping it here
     * was what kept the skip at ~1000 iterations on deep views. */
    if (amag < 1e300 && bmag < 1e300 && cmag < 1e300 &&
        bmag * dcMax <= kSkipTol() * amag &&
        cmag * dcMax * dcMax <= kSkipTol() * amag)
      skip = k + 1;
    /* Largest |dc| for which a start at this index is still within tolerance:
     * the quadratic term allows dc <= tol|A|/|B|, the cubic one
     * dc <= sqrt(tol|A|/|C|).  Kept monotone (running minimum) so a pixel can
     * binary-search it: the tolerance is a *prefix* property — every earlier
     * step has to hold too. */
    double th = bmag > 0.0 ? kSkipTol() * amag / bmag : 1e300;
    if (cmag > 0.0) {
      const double tc = std::sqrt(kSkipTol() * amag / cmag);
      if (tc < th) th = tc;
    }
    if (!(th > 0.0) || th > 1e300) th = 1e300;
    if (k > 0) {
      const double prev = (double)R.dcth[(size_t)k];
      if (prev < th) th = prev;
    }
    R.dcth[(size_t)k + 1] = (float)th;
  }
  R.skip = noSeries ? 0 : std::min(skip, R.len - 1);
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

Pick pickReference(const Request& q, int bits, int maxIter, const Ctx& g) {
  const bool bigProbe = g.ps < 1e-17;
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
  const double cRe = std::strtod(q.centerRe.c_str(), nullptr);
  const double cIm = std::strtod(q.centerIm.c_str(), nullptr);
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
          len = buildReference(q, bits, rc, dRe, dIm, nullptr);
        } else {
          double zr, zi, cr, ci;
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
            const double m2 = zr * zr + zi * zi;
            if (m2 > kBail2) {
              len = n;
              break;
            }
            famStepD(g.kind, g.power, zr, zi, cr, ci);
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
