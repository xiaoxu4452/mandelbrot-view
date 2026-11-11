// ------------------------------------------------------------------
// kernel.cpp — fractal pixel kernel (C++ → WebAssembly, wasm SIMD f64x2)
//
// Keeps exactly the same ABI as kernel.ts: a single render(paramPtr) entry point,
// the parameter block is an f64 array, index × 8 gives the byte offset:
//  0 mode(0 direct /1 perturb /2 newton)
//  1 kind(0 poly 1 tricorn 2 burningship 3 celtic 4 perpendicular 5 phoenix)
//  2 power  3 julia  4 tileX 5 tileY 6 tileW 7 tileH 8 imgW 9 imgH
// 10 centerRe 11 centerIm 12 ps 13 juliaRe 14 juliaIm
// 15 maxIter 16 cycle 17 offset 18 outPtr 19 lutPtr
// 20 refPtr 21 refLen 22 refPx 23 refPy 24 phoenixP 25 samples
// 26 newtonDegree 27 rootsPtr 28 orbitStride
// 29..37 series approximation (skip, ar, ai, br, bi, cr, ci, radius, on)
// 38 glitchPtr 39 glitchCap 40 ddRef (reference orbit carries hi/lo words)
//
// The hot paths (power-2 direct / power-2 perturbation) advance two pixels at a time with f64x2.
// Build: zig c++ -target wasm32-freestanding -O3 -msimd128 ...
// ------------------------------------------------------------------

#include <wasm_simd128.h>
#include <stdint.h>

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static const double BAIL2 = 1e20;
static const double LOGBAIL = 23.025850929940457;  // ln(1e10)
static const double SQRT2 = 1.4142135623730951;

static inline double ldf(int p, int i) { return *(double *)(p + (i << 3)); }
static inline int ldi(int p, int i) { return (int)*(double *)(p + (i << 3)); }

/* Self-contained logarithm (avoids linking libm): frexp + atanh series, error < 1e-13 */
static inline double fastlog(double x) {
  if (!(x > 0.0)) return -745.0;
  uint64_t bits;
  __builtin_memcpy(&bits, &x, 8);
  int e = (int)((bits >> 52) & 0x7ff) - 1023;
  uint64_t mant = (bits & 0x000fffffffffffffULL) | 0x3ff0000000000000ULL;
  double m;
  __builtin_memcpy(&m, &mant, 8);
  if (m > SQRT2) { m *= 0.5; e += 1; }
  const double s = (m - 1.0) / (m + 1.0);
  const double s2 = s * s;
  const double t = s2 * (1.0 / 3.0 + s2 * (1.0 / 5.0 + s2 * (1.0 / 7.0 +
                   s2 * (1.0 / 9.0 + s2 * (1.0 / 11.0 + s2 * (1.0 / 13.0))))));
  return (double)e * 0.6931471805599453 + 2.0 * s * (1.0 + t);
}

static inline double smoothOf(int k, double m2, double invLogPower) {
  double nu = fastlog(0.5 * fastlog(m2) / LOGBAIL) * invLogPower;
  if (nu != nu) nu = 0.0;
  return (double)k + 1.0 - nu;
}

/* KF colour.h::dither — 8x8 ordered dither, returns [0,1) added to the
 * 0..255 colour before quantisation: (((x+c*67)+y*236)*119)&255.
 * It is a pure function of (x, y, channel): no state, so it cannot trail
 * across frames. */
static inline double ditherVal(int x, int y, int ch) {
  return (double)(((((x + ch * 67) + y * 236) * 119) & 255)) / 256.0;
}

static inline uint8_t q8(double v) {
  if (!(v > 0.0)) return 0;
  return v > 255.0 ? (uint8_t)255 : (uint8_t)v;
}

static inline void putColor(int outPtr, int o, int lutPtr, double t,
                            int x, int y, int dither) {
  double u = t - __builtin_floor(t);
  int i0 = (int)(u * 512.0);
  if (i0 >= 512) i0 = 511;
  if (i0 < 0) i0 = 0;
  const double f = u * 512.0 - (double)i0;
  const int j0 = (i0 + 1) & 511;
  const uint8_t *a = (const uint8_t *)(lutPtr + (i0 << 2));
  const uint8_t *b = (const uint8_t *)(lutPtr + (j0 << 2));
  const double d0 = dither ? ditherVal(x, y, 0) : 0.0;
  const double d1 = dither ? ditherVal(x, y, 1) : 0.0;
  const double d2 = dither ? ditherVal(x, y, 2) : 0.0;
  uint8_t *o8 = (uint8_t *)(outPtr + o);
  o8[0] = q8((double)a[0] + ((double)b[0] - (double)a[0]) * f + d0);
  o8[1] = q8((double)a[1] + ((double)b[1] - (double)a[1]) * f + d1);
  o8[2] = q8((double)a[2] + ((double)b[2] - (double)a[2]) * f + d2);
  o8[3] = 255;
}

static inline void putInterior(int outPtr, int o) {
  uint8_t *o8 = (uint8_t *)(outPtr + o);
  o8[0] = 5; o8[1] = 6; o8[2] = 9; o8[3] = 255;
}

/* Analytic interior of z^2+c (main cardioid + period-2 disc).  A quarter of
 * the home frame lives here and can never escape; iterating it to maxIter is
 * pure waste.  Inherited from the desktop C++ core, where it cut a 2K frame
 * from 88 ms to 70 ms.  Interior pixels have a fixed colour, so skipping the
 * orbit is bit-exact. */
static inline int insideBulbs(double cr, double ci) {
  const double x = cr - 0.25;
  const double y2 = ci * ci;
  const double q = x * x + y2;
  if (q * (q + x) <= 0.25 * y2) return 1;
  const double u = cr + 1.0;
  return (u * u + y2) <= 0.0625;
}

/* ---- distance estimate --------------------------------------------------
 * |z|·ln|z| / |z'| is the standard escape-time distance estimate; dividing
 * by the pixel size turns it into "how many pixels away is the set", so a
 * one-pixel rim stays one pixel wide at every zoom level.  Filled pixels
 * whose estimate is below `width` are blended towards white: that is the
 * outline that makes the body, branches and tendrils readable. */
static inline double dePixels(double m2, double derMag, double ps, int legacy) {
  if (!(derMag > 0.0) || !(m2 > 0.0)) return 1e12;
  /* Exact reference formula (distm_double @0x4C9980), same as the native
     kernel: 0.5·|z|·ln|z|²/|z'|.  The derivative arrives as its magnitude,
     never as |z'|²: the square overflows past |z'| > 1e154 (~500 iterations
     at depth, the filament regime), which made the spacing collapse there.
     p[51] restores the squared form so before/after can be measured on the
     same build. */
  const double der = legacy ? __builtin_sqrt(derMag * derMag) : derMag;
  const double de = 0.5 * __builtin_sqrt(m2) * fastlog(m2) / der;
  const double px = de / ps;
  return px == px ? px : 1e12;
}

/* Overflow-safe |a+bi|: scale by the larger component instead of squaring
 * both (the SIMD version is below). */
static inline double hypotD(double a, double b) {
  const double aa = __builtin_fabs(a), ab = __builtin_fabs(b);
  const double hi = aa > ab ? aa : ab, lo = aa > ab ? ab : aa;
  if (!(hi > 0.0)) return 0.0;
  const double r = lo / hi;
  return hi * __builtin_sqrt(1.0 + r * r);
}

static inline v128_t hypotV(v128_t a, v128_t b) {
  const v128_t aa = wasm_f64x2_abs(a), ab = wasm_f64x2_abs(b);
  const v128_t hi = wasm_f64x2_max(aa, ab), lo = wasm_f64x2_min(aa, ab);
  const v128_t r = wasm_f64x2_div(lo, hi);
  const v128_t m = wasm_f64x2_mul(
      hi, wasm_f64x2_sqrt(wasm_f64x2_add(wasm_f64x2_splat(1.0), wasm_f64x2_mul(r, r))));
  return wasm_v128_bitselect(m, wasm_f64x2_splat(0.0),
                             wasm_f64x2_gt(hi, wasm_f64x2_splat(0.0)));
}

/* ---- shading parameters (KF Stretched + fixed band phase) ---------------
 * Stretched: KF fraktal_sft.cpp:773-777 maps the frame's iteration span onto
 * 1024 palette slots, and iterDiv 0.1 stretches it to 10240 = ten full palette
 * loops across the span.  In this palette t is measured in cycles (the LUT is
 * one loop), so the translation is exactly "u * 10".
 * Without a stretch range the legacy fixed phase rawIter/cycle + offset is
 * used, which is what the previous frames used. */
struct Shade {
  double lo, hi, levels, bandScale, offset;
  int stretchOn;
};

static inline Shade loadShade(int p) {
  Shade s;
  s.lo = ldf(p, 46);
  s.hi = ldf(p, 47);
  s.stretchOn = ldi(p, 48);
  s.levels = ldf(p, 49);
  if (!(s.levels > 0.0)) s.levels = 10.0;   // KF iterDiv 0.1: ten loops
  s.bandScale = 1.0 / (ldf(p, 16) > 1.0 ? ldf(p, 16) : 1.0);
  s.offset = ldf(p, 17);
  return s;
}

static inline double colorT(const Shade &s, double raw) {
  if (s.stretchOn && s.hi > s.lo) {
    const double u = (raw - s.lo) / (s.hi - s.lo);
    return (u >= 0.0 && u < 1e9 ? u : 0.0) * s.levels + s.offset;
  }
  return raw * s.bandScale + s.offset;
}

/* ---- frame statistics (KF GetIterations / GetMaxExceptCenter) -----------
 * The worker aggregates these per tile into frame-wide nMin/nMax; the next
 * pass then uses the sample as its Stretched interval.  Escaped pixels only,
 * saturated ones (n >= maxIter-1) excluded like KF. */
struct Stats { double mn, mx, mxnc; };

static inline void statAdd(Stats &s, double raw, int gx, int gy, int W, int H, int maxIter) {
  if (!(raw >= 0.0) || raw > 1e9 || raw >= maxIter - 1) return;  // saturated excluded (KF)
  if (raw < s.mn) s.mn = raw;
  if (raw > s.mx) s.mx = raw;
  const int dx = gx * 2 - W, dy = gy * 2 - H;
  const int hw = W / 2, hh = H / 2;
  const bool centre = dx > -hw && dx < hw && dy > -hh && dy < hh;
  if (!centre && raw > s.mxnc) s.mxnc = raw;
}

static inline void writeStats(int p, const Stats &s) {
  const int sp = ldi(p, 45);
  if (!sp) return;
  double *d = (double *)sp;
  d[0] = s.mn; d[1] = s.mx; d[2] = s.mxnc;
}

static inline void rimShade(int outPtr, int o, double distPx, double widthPx, double strength) {
  if (!(strength > 0.0) || !(widthPx > 0.0)) return;
  double rr = distPx / widthPx;
  if (!(rr < 1.0)) return;
  if (!(rr > 0.0)) rr = 0.0;
  const double v = (1.0 - rr) * 255.0;
  uint8_t *q = (uint8_t *)(outPtr + o);
  q[0] = (uint8_t)(q[0] + (v - q[0]) * strength);
  q[1] = (uint8_t)(q[1] + (v - q[1]) * strength);
  q[2] = (uint8_t)(q[2] + (v - q[2]) * strength);
}

/* Same contract as mbc::shadeEscaped in native/core/mb_core.cpp: scheme 1 is
 * the reference "Distance" scheme — empty field black, one-pixel white rim,
 * interior keeps its colour. */
static inline void shadeEscaped(int outPtr, int o, int lutPtr, double raw, const Shade &sh,
                                double distPx, int scheme, double widthPx, double strength,
                                int x, int y, int dither) {
  if (scheme == 1) {
    uint8_t *q = (uint8_t *)(outPtr + o);
    q[0] = q[1] = q[2] = 0; q[3] = 255;
    rimShade(outPtr, o, distPx, widthPx > 0.0 ? widthPx : 1.0, 1.0);
    return;
  }
  putColor(outPtr, o, lutPtr, colorT(sh, raw), x, y, dither);
  rimShade(outPtr, o, distPx, widthPx, strength);
}

/* ------------------------------------------------------------------
 * Glitch reporting.
 *
 * A pixel is "glitched" when the perturbation recursion loses precision
 * (|Z+dz| collapses towards |dz|, or the reference orbit is exhausted).
 * Such pixels must not be coloured from the perturbed value: the host
 * repairs them with secondary reference orbits.  The kernel therefore
 * writes their coordinates into a caller-provided buffer so the repair
 * only touches the affected pixels instead of re-rendering whole tiles.
 * ------------------------------------------------------------------ */
static inline void emitGlitch(int ptr, int cap, int idx, int gx, int gy) {
  if (!ptr || idx >= cap) return;
  int *q = (int *)(ptr + ((long)idx << 3));
  q[0] = gx;
  q[1] = gy;
}

/* ================= Direct · power 2 (SIMD, two pixels) ================= */

static int renderDirect2(int p) {
  const bool isJulia = ldi(p, 3) != 0;
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const double halfW = ldf(p, 8) * 0.5, halfH = ldf(p, 9) * 0.5;
  const double cre = ldf(p, 10), cim = ldf(p, 11), ps = ldf(p, 12);
  const double jre = ldf(p, 13), jim = ldf(p, 14);
  const int maxIter = ldi(p, 15);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const int deOn = ldi(p, 41);
  const double deW = ldf(p, 42), deS = ldf(p, 43);
  const int scheme = ldi(p, 44);
  const Shade sh = loadShade(p);
  const int dither = ldi(p, 50);
  const int legacyDe = ldi(p, 51);
  Stats st{1e300, -1e300, -1e300};

  const v128_t vbail = wasm_f64x2_splat(BAIL2);
  const v128_t vhuge = wasm_f64x2_splat(1e30);
  const v128_t vzero = wasm_f64x2_splat(0.0);
  const v128_t vone = wasm_f64x2_splat(1.0);
  const v128_t vtwo = wasm_f64x2_splat(2.0);
  int o = 0;

  for (int py = 0; py < th; py++) {
    const double gy = (double)(ty + py) + 0.5;
    int px = 0;
    for (; px + 1 < tw; px += 2) {
      const double gx0 = (double)(tx + px) + 0.5;
      const double gx1 = gx0 + 1.0;
      const double cr0 = isJulia ? jre : cre + (gx0 - halfW) * ps;
      const double cr1 = isJulia ? jre : cre + (gx1 - halfW) * ps;
      const double ci0 = isJulia ? jim : cim - (gy - halfH) * ps;

      v128_t zr = wasm_f64x2_make(isJulia ? cre + (gx0 - halfW) * ps : 0.0,
                                  isJulia ? cre + (gx1 - halfW) * ps : 0.0);
      v128_t zi = wasm_f64x2_make(isJulia ? cim - (gy - halfH) * ps : 0.0,
                                  isJulia ? cim - (gy - halfH) * ps : 0.0);
      const v128_t vcr = wasm_f64x2_make(cr0, cr1);
      const v128_t vci = wasm_f64x2_splat(ci0);
      /* Both lanes inside the analytic interior: no orbit to integrate. */
      if (!isJulia && insideBulbs(cr0, ci0) && insideBulbs(cr1, ci0)) {
        putInterior(outPtr, o); o += 4;
        putInterior(outPtr, o); o += 4;
        continue;
      }
      /* z' = dz/dc: 0 for Mandelbrot, 1 for Julia (derivative in z0). */
      v128_t derR = isJulia ? vone : vzero;
      v128_t derI = vzero;

      int n0 = -1, n1 = -1;
      double m20 = 0.0, m21 = 0.0;
      double d20 = 0.0, d21 = 0.0;
      v128_t esc = wasm_i64x2_splat(0);
      v128_t chkR = vzero, chkI = vzero;
      int chkOn = 0;
      int period0 = 0, period1 = 0;

      for (int n = 0; n < maxIter; n++) {
        const v128_t zr2 = wasm_f64x2_mul(zr, zr);
        const v128_t zi2 = wasm_f64x2_mul(zi, zi);
        const v128_t m2 = wasm_f64x2_add(zr2, zi2);
        const v128_t hit = wasm_f64x2_gt(m2, vbail);

        const v128_t t = wasm_f64x2_sub(zr2, zi2);
        const v128_t u = wasm_f64x2_mul(wasm_f64x2_mul(wasm_f64x2_splat(2.0), zr), zi);

        if (wasm_v128_any_true(hit)) {
          const v128_t fresh = wasm_v128_andnot(hit, esc);
          if (wasm_v128_any_true(fresh)) {
            const v128_t dmag = hypotV(derR, derI);
            if (n0 < 0 && wasm_f64x2_extract_lane(fresh, 0) != 0) {
              n0 = n; m20 = wasm_f64x2_extract_lane(m2, 0);
              d20 = wasm_f64x2_extract_lane(dmag, 0);
            }
            if (n1 < 0 && wasm_f64x2_extract_lane(fresh, 1) != 0) {
              n1 = n; m21 = wasm_f64x2_extract_lane(m2, 1);
              d21 = wasm_f64x2_extract_lane(dmag, 1);
            }
          }
          esc = wasm_v128_or(esc, hit);
          if (n0 >= 0 && n1 >= 0) break;
          zr = wasm_v128_bitselect(vhuge, zr, esc);
          zi = wasm_v128_bitselect(vzero, zi, esc);
        }

        /* Lanes that have not escaped keep iterating */
        {
          const v128_t nzr = wasm_f64x2_add(t, vcr);
          const v128_t nzi = wasm_f64x2_add(u, vci);
          /* d' = 2·z·d + 1, evaluated on the pre-step z */
          const v128_t nderR = wasm_f64x2_add(
              wasm_f64x2_mul(vtwo, wasm_f64x2_sub(wasm_f64x2_mul(zr, derR), wasm_f64x2_mul(zi, derI))), vone);
          const v128_t nderI = wasm_f64x2_mul(vtwo, wasm_f64x2_add(wasm_f64x2_mul(zr, derI), wasm_f64x2_mul(zi, derR)));
          zr = wasm_v128_bitselect(vhuge, nzr, esc);
          zi = wasm_v128_bitselect(vzero, nzi, esc);
          derR = wasm_v128_bitselect(vzero, nderR, esc);
          derI = wasm_v128_bitselect(vzero, nderI, esc);
        }

        /* Rolling interior check.  The old fixed snapshot (taken at n=12)
         * can never be reached again by an orbit converging to a fixed point,
         * so every interior pixel burned the full iteration limit.  Moving
         * the snapshot forward every 64 iterations detects a stationary orbit;
         * interior colour is constant, so stopping early is bit-exact. */
        if (n == 12) { chkR = zr; chkI = zi; chkOn = 1; }
        else if (chkOn && ((n & 63) == 0)) {
          const v128_t dxv = wasm_f64x2_sub(zr, chkR);
          const v128_t dyv = wasm_f64x2_sub(zi, chkI);
          const v128_t d2 = wasm_f64x2_add(wasm_f64x2_mul(dxv, dxv), wasm_f64x2_mul(dyv, dyv));
          const v128_t z2 = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
          const v128_t tol = wasm_f64x2_mul(wasm_f64x2_splat(1e-24),
                                            wasm_f64x2_add(z2, vone));
          const v128_t per = wasm_f64x2_lt(d2, tol);
          if (wasm_v128_any_true(per)) {
            if (period0 == 0 && n0 < 0 && wasm_f64x2_extract_lane(per, 0) != 0) period0 = 1;
            if (period1 == 0 && n1 < 0 && wasm_f64x2_extract_lane(per, 1) != 0) period1 = 1;
            if ((n0 >= 0 || period0) && (n1 >= 0 || period1)) break;
          }
          chkR = zr; chkI = zi;
        }
      }

      const double invLogPower = 1.4426950408889634;
      const int gxi = tx + px;
      if (n0 >= 0) {
        const double raw = smoothOf(n0, m20, invLogPower);
        statAdd(st, raw, gxi, ty + py, ldi(p, 8), ldi(p, 9), maxIter);
        shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m20, d20, ps, legacyDe),
                     deOn ? scheme : 0, deW, deS, gxi, ty + py, dither);
      } else putInterior(outPtr, o);
      o += 4;
      if (n1 >= 0) {
        const double raw = smoothOf(n1, m21, invLogPower);
        statAdd(st, raw, gxi + 1, ty + py, ldi(p, 8), ldi(p, 9), maxIter);
        shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m21, d21, ps, legacyDe),
                     deOn ? scheme : 0, deW, deS, gxi + 1, ty + py, dither);
      } else putInterior(outPtr, o);
      o += 4;
    }
    /* Trailing pixel at the end of the row */
    if (px < tw) {
      const double gx = (double)(tx + px) + 0.5;
      const double cr = isJulia ? jre : cre + (gx - halfW) * ps;
      const double ci = isJulia ? jim : cim - (gy - halfH) * ps;
      if (!isJulia && insideBulbs(cr, ci)) {
        putInterior(outPtr, o); o += 4;
        continue;
      }
      double zr = isJulia ? cre + (gx - halfW) * ps : 0.0;
      double zi = isJulia ? cim - (gy - halfH) * ps : 0.0;
      double derR = isJulia ? 1.0 : 0.0, derI = 0.0;
      int n = 0;
      double m2 = 0.0, derMag = 0.0;
      bool esc = false;
      double chkR = 0.0, chkI = 0.0;
      bool chkOn = false;
      for (; n < maxIter; n++) {
        const double zr2 = zr * zr, zi2 = zi * zi;
        m2 = zr2 + zi2;
        if (m2 > BAIL2) { esc = true; derMag = hypotD(derR, derI); break; }
        const double oder = 2.0 * (zr * derR - zi * derI) + 1.0;
        const double odei = 2.0 * (zr * derI + zi * derR);
        derR = oder; derI = odei;
        zi = 2.0 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        if (n == 12) { chkR = zr; chkI = zi; chkOn = true; }
        else if (chkOn && ((n & 63) == 0)) {
          const double dx = zr - chkR, dy = zi - chkI;
          const double z2 = zr * zr + zi * zi;
          if (dx * dx + dy * dy < 1e-24 * (z2 + 1.0)) { esc = false; n = maxIter; break; }
          chkR = zr; chkI = zi;          // rolling snapshot
        }
      }
      if (esc) {
        const double raw = smoothOf(n, m2, 1.4426950408889634);
        statAdd(st, raw, tx + px, ty + py, ldi(p, 8), ldi(p, 9), maxIter);
        shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m2, derMag, ps, legacyDe),
                     deOn ? scheme : 0, deW, deS, tx + px, ty + py, dither);
      } else putInterior(outPtr, o);
      o += 4;
    }
  }
  writeStats(p, st);
  return 0;
}

/* ================= Direct · generic families (scalar) ================= */

static int renderDirectGeneric(int p) {
  const int kind = ldi(p, 1), power = ldi(p, 2);
  const bool isJulia = ldi(p, 3) != 0;
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const double halfW = ldf(p, 8) * 0.5, halfH = ldf(p, 9) * 0.5;
  const double cre = ldf(p, 10), cim = ldf(p, 11), ps = ldf(p, 12);
  const double jre = ldf(p, 13), jim = ldf(p, 14);
  const int maxIter = ldi(p, 15);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const double ph = ldf(p, 24);
  const double invLogPower = power == 2 ? 1.4426950408889634 : 1.0 / fastlog((double)power);
  const Shade sh = loadShade(p);
  const int dither = ldi(p, 50);
  Stats st{1e300, -1e300, -1e300};
  int o = 0;

  for (int py = 0; py < th; py++) {
    const double gy = (double)(ty + py) + 0.5;
    for (int px = 0; px < tw; px++) {
      const double gx = (double)(tx + px) + 0.5;
      const double cr = isJulia ? jre : cre + (gx - halfW) * ps;
      const double ci = isJulia ? jim : cim - (gy - halfH) * ps;
      double zr = isJulia ? cre + (gx - halfW) * ps : 0.0;
      double zi = isJulia ? cim - (gy - halfH) * ps : 0.0;
      double pr = 0.0, pi = 0.0;
      int n = 0;
      double m2 = 0.0;
      bool esc = false;

      for (; n < maxIter; n++) {
        double nr, ni;
        if (kind == 0) {
          if (power == 3) {
            const double a = zr * zr - zi * zi, b = 2.0 * zr * zi;
            nr = a * zr - b * zi;
            ni = a * zi + b * zr;
          } else {
            double tr = zr, ti = zi;
            for (int k = 2; k <= power; k++) {
              const double r2 = tr * zr - ti * zi, i2 = tr * zi + ti * zr;
              tr = r2; ti = i2;
            }
            nr = tr; ni = ti;
          }
        } else if (kind == 1) {
          nr = zr * zr - zi * zi; ni = -2.0 * zr * zi;
        } else if (kind == 2) {
          const double ax = __builtin_fabs(zr), ay = __builtin_fabs(zi);
          nr = ax * ax - ay * ay; ni = 2.0 * ax * ay;
        } else if (kind == 3) {
          nr = __builtin_fabs(zr * zr - zi * zi); ni = 2.0 * zr * zi;
        } else if (kind == 4) {
          nr = zr * zr - zi * zi; ni = 2.0 * __builtin_fabs(zr) * __builtin_fabs(zi);
        } else {
          nr = zr * zr - zi * zi + ph * pr;
          ni = 2.0 * zr * zi + ph * pi;
          pr = zr; pi = zi;
        }
        zr = nr + cr;
        zi = ni + ci;
        m2 = zr * zr + zi * zi;
        if (m2 > BAIL2) { esc = true; break; }
      }
      if (esc) {
        const double raw = smoothOf(n, m2, invLogPower);
        statAdd(st, raw, tx + px, ty + py, ldi(p, 8), ldi(p, 9), maxIter);
        putColor(outPtr, o, lutPtr, colorT(sh, raw), tx + px, ty + py, dither);
      } else putInterior(outPtr, o);
      o += 4;
    }
  }
  writeStats(p, st);
  return 0;
}

/* ================= Perturbation · power 2 (SIMD, two pixels) ================= */

static int renderPerturb2(int p) {
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const int W = ldi(p, 8), H = ldi(p, 9);
  const int maxIter = ldi(p, 15);
  const Shade sh = loadShade(p);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const int refPtr = ldi(p, 20);
  const int refLen = ldi(p, 21);
  const double refPx = ldf(p, 22), refPy = ldf(p, 23);
  const double ps = ldf(p, 12);
  const int stride = ldi(p, 28);
  const double *Zr = (const double *)refPtr;
  const double *Zi = (const double *)(refPtr + ((long)stride << 3));
  const int deOn = ldi(p, 41);
  const double deW = ldf(p, 42), deS = ldf(p, 43);
  const int scheme = ldi(p, 44);
  const int isJulia = ldi(p, 3);
  const int dither = ldi(p, 50);
  const int legacyDe = ldi(p, 51);
  /* KF singleref rebase (perturbation_simple1.cpp.xsl:128-135): when
     |Z+dz|² < |dz|² the deviation becomes the actual z and the local index
     restarts at 0, so a pixel is never limited by the reference orbit's
     length and no glitch marker is needed.  Julia keeps a fixed reference.
     p[52] restores the old "stop at the orbit end and flag a glitch". */
  const int rebase = (isJulia || ldi(p, 52)) ? 0 : 1;
  Stats st{1e300, -1e300, -1e300};

  const v128_t vbail = wasm_f64x2_splat(BAIL2);
  const v128_t vhuge = wasm_f64x2_splat(1e30);
  const v128_t vzero = wasm_f64x2_splat(0.0);
  const v128_t vone = wasm_f64x2_splat(1.0);
  const v128_t vtwo = wasm_f64x2_splat(2.0);
  /* Series-approximation parameters */
  const int saOn = ldi(p, 37);
  const int skip = ldi(p, 29);
  const double saAr = ldf(p, 30), saAi = ldf(p, 31);
  const double saBr = ldf(p, 32), saBi = ldf(p, 33);
  const double saCr = ldf(p, 34), saCi = ldf(p, 35);
  int o = 0;
  int glitches = 0;

  for (int py = 0; py < th; py++) {
    const double gy = (double)(ty + py) + 0.5;
    for (int px = 0; px < tw; px += 2) {
      const bool pair = (px + 1 < tw);
      const double gx0 = (double)(tx + px) + 0.5;
      const double gx1 = gx0 + 1.0;
      const double dcr0 = (gx0 - refPx) * ps;
      const double dcr1 = (gx1 - refPx) * ps;
      const double dci0 = -(gy - refPy) * ps;

      const v128_t poR = wasm_f64x2_make(dcr0, pair ? dcr1 : dcr0);
      const v128_t poI = wasm_f64x2_splat(dci0);
      /* Julia: c is fixed, the perturbation constant is 0, and the initial perturbation is the pixel offset */
      const v128_t vdcr = isJulia ? vzero : poR;
      const v128_t vdci = isJulia ? vzero : poI;
      v128_t dr = poR;
      v128_t di = poI;
      /* z' = dz/dc, tracked per pixel for the distance estimate */
      v128_t derR = isJulia ? wasm_f64x2_splat(1.0) : vzero;
      v128_t derI = vzero;

      int n0 = -1, n1 = -1;
      double m20 = 0.0, m21 = 0.0;
      double d20 = 0.0, d21 = 0.0;
      int g0 = 0, g1 = 0;
      int p0 = 0, p1 = 0;                 // periodicity (interior point) flags
      v128_t esc = wasm_i64x2_splat(0);
      v128_t chkR = vzero, chkI = vzero;
      int chkOn = 0;
      int n = 0;
      int i0 = 0, i1 = 0;                 // per-lane reference index (rebase resets it)

      if (saOn && skip > 8 && skip + 8 < refLen && skip < maxIter) {
        const v128_t d2r = wasm_f64x2_sub(wasm_f64x2_mul(poR, poR), wasm_f64x2_mul(poI, poI));
        const v128_t d2i = wasm_f64x2_add(wasm_f64x2_mul(poR, poI), wasm_f64x2_mul(poR, poI));
        const v128_t d3r = wasm_f64x2_sub(wasm_f64x2_mul(d2r, poR), wasm_f64x2_mul(d2i, poI));
        const v128_t d3i = wasm_f64x2_add(wasm_f64x2_mul(d2r, poI), wasm_f64x2_mul(d2i, poR));
        const v128_t vAr = wasm_f64x2_splat(saAr), vAi = wasm_f64x2_splat(saAi);
        const v128_t vBr = wasm_f64x2_splat(saBr), vBi = wasm_f64x2_splat(saBi);
        const v128_t vCr = wasm_f64x2_splat(saCr), vCi = wasm_f64x2_splat(saCi);
        const v128_t linR = wasm_f64x2_sub(wasm_f64x2_mul(vAr, poR), wasm_f64x2_mul(vAi, poI));
        const v128_t linI = wasm_f64x2_add(wasm_f64x2_mul(vAr, poI), wasm_f64x2_mul(vAi, poR));
        const v128_t qudR = wasm_f64x2_sub(wasm_f64x2_mul(vBr, d2r), wasm_f64x2_mul(vBi, d2i));
        const v128_t qudI = wasm_f64x2_add(wasm_f64x2_mul(vBr, d2i), wasm_f64x2_mul(vBi, d2r));
        const v128_t cubR = wasm_f64x2_sub(wasm_f64x2_mul(vCr, d3r), wasm_f64x2_mul(vCi, d3i));
        const v128_t cubI = wasm_f64x2_add(wasm_f64x2_mul(vCr, d3i), wasm_f64x2_mul(vCi, d3r));
        dr = wasm_f64x2_add(wasm_f64x2_add(linR, qudR), cubR);
        di = wasm_f64x2_add(wasm_f64x2_add(linI, qudI), cubI);
        /* The same polynomial gives the derivative at the skipped step:
           d = A + 2B·dc + 3C·dc² */
        {
          const v128_t qdR = wasm_f64x2_sub(wasm_f64x2_mul(vBr, poR), wasm_f64x2_mul(vBi, poI));
          const v128_t qdI = wasm_f64x2_add(wasm_f64x2_mul(vBr, poI), wasm_f64x2_mul(vBi, poR));
          const v128_t cdR = wasm_f64x2_sub(wasm_f64x2_mul(vCr, d2r), wasm_f64x2_mul(vCi, d2i));
          const v128_t cdI = wasm_f64x2_add(wasm_f64x2_mul(vCr, d2i), wasm_f64x2_mul(vCi, d2r));
          derR = wasm_f64x2_add(wasm_f64x2_add(vAr, wasm_f64x2_mul(vtwo, qdR)),
                                wasm_f64x2_mul(wasm_f64x2_splat(3.0), cdR));
          derI = wasm_f64x2_add(wasm_f64x2_add(vAi, wasm_f64x2_mul(vtwo, qdI)),
                                wasm_f64x2_mul(wasm_f64x2_splat(3.0), cdI));
        }
        n = skip;
        i0 = skip; i1 = skip;

        /* If the pixel has already escaped at the skipped step, it in fact escaped much earlier:
           the series cannot give the right step count, so fall back to iterating from 0 */
        const v128_t zsk = wasm_f64x2_add(wasm_f64x2_splat(Zr[skip]), dr);
        const v128_t zskI = wasm_f64x2_add(wasm_f64x2_splat(Zi[skip]), di);
        const v128_t msk = wasm_f64x2_add(wasm_f64x2_mul(zsk, zsk), wasm_f64x2_mul(zskI, zskI));
        if (wasm_v128_any_true(wasm_f64x2_gt(msk, vbail))) {
          dr = poR; di = poI; n = 0; i0 = 0; i1 = 0;
          derR = isJulia ? wasm_f64x2_splat(1.0) : vzero; derI = vzero;
        }
      }

      for (; n < maxIter; n++) {
        /* Per-lane reference sample.  A lane whose local index has run past the
           orbit is rebased in this same step (X = 0), so the loop is no longer
           bounded by refLen. */
        const double Xr0 = (i0 < refLen ? Zr[i0] : 0.0);
        const double Xi0 = (i0 < refLen ? Zi[i0] : 0.0);
        const double Xr1 = (i1 < refLen ? Zr[i1] : 0.0);
        const double Xi1 = (i1 < refLen ? Zi[i1] : 0.0);
        v128_t vZr = wasm_f64x2_make(Xr0, Xr1);
        v128_t vZi = wasm_f64x2_make(Xi0, Xi1);
        const v128_t zr = wasm_f64x2_add(vZr, dr);
        const v128_t zi = wasm_f64x2_add(vZi, di);
        const v128_t m2 = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
        const v128_t hit = wasm_f64x2_gt(m2, vbail);

        /* KF singleref rebase: |Z+dz|² < |dz|² (or the orbit ran out). */
        v128_t rb = wasm_i64x2_splat(0);
        if (rebase) {
          const v128_t dm2 = wasm_f64x2_add(wasm_f64x2_mul(dr, dr), wasm_f64x2_mul(di, di));
          const v128_t outm = wasm_i64x2_make(i0 >= refLen ? -1LL : 0LL,
                                              i1 >= refLen ? -1LL : 0LL);
          rb = wasm_v128_or(wasm_f64x2_lt(m2, dm2), outm);
          dr = wasm_v128_bitselect(zr, dr, rb);
          di = wasm_v128_bitselect(zi, di, rb);
          vZr = wasm_v128_bitselect(vzero, vZr, rb);   // this step adds X = 0
          vZi = wasm_v128_bitselect(vzero, vZi, rb);
          if (wasm_i64x2_extract_lane(rb, 0) != 0) i0 = 0;
          if (wasm_i64x2_extract_lane(rb, 1) != 0) i1 = 0;
        }

        const v128_t t = wasm_f64x2_add(wasm_f64x2_add(vZr, vZr), dr);
        const v128_t u = wasm_f64x2_add(wasm_f64x2_add(vZi, vZi), di);
        const v128_t ndr = wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_mul(t, dr), wasm_f64x2_mul(u, di)), vdcr);
        const v128_t ndi = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(t, di), wasm_f64x2_mul(u, dr)), vdci);
        /* d' = 2·(Z+dz)·d + 1 — derivative of z with respect to c */
        const v128_t nderR = wasm_f64x2_add(
            wasm_f64x2_mul(vtwo, wasm_f64x2_sub(wasm_f64x2_mul(zr, derR), wasm_f64x2_mul(zi, derI))), vone);
        const v128_t nderI = wasm_f64x2_mul(vtwo, wasm_f64x2_add(wasm_f64x2_mul(zr, derI), wasm_f64x2_mul(zi, derR)));
        const v128_t dmag = hypotV(derR, derI);
        dr = ndr;
        di = ndi;
        derR = wasm_v128_bitselect(vzero, nderR, esc);
        derI = wasm_v128_bitselect(vzero, nderI, esc);

        if (wasm_v128_any_true(hit)) {
          const v128_t fresh = wasm_v128_andnot(hit, esc);
          if (wasm_v128_any_true(fresh)) {
            if (n0 < 0 && wasm_f64x2_extract_lane(fresh, 0) != 0) {
              n0 = n; m20 = wasm_f64x2_extract_lane(m2, 0); d20 = wasm_f64x2_extract_lane(dmag, 0);
            }
            if (n1 < 0 && wasm_f64x2_extract_lane(fresh, 1) != 0) {
              n1 = n; m21 = wasm_f64x2_extract_lane(m2, 1); d21 = wasm_f64x2_extract_lane(dmag, 1);
            }
          }
          esc = wasm_v128_or(esc, hit);
          if ((n0 >= 0 || p0) && (n1 >= 0 || p1)) break;
          dr = wasm_v128_bitselect(vhuge, dr, esc);
          di = wasm_v128_bitselect(vzero, di, esc);
        }

        /* A rebased lane keeps index 0 for the next step (KF's rantal reset
           makes the anchor Z_0 participate in the following step too). */
        if ((!rebase || wasm_i64x2_extract_lane(rb, 0) == 0) && i0 < refLen) i0++;
        if ((!rebase || wasm_i64x2_extract_lane(rb, 1) == 0) && i1 < refLen) i1++;
        if (!rebase && i0 >= refLen && i1 >= refLen) break;

        /* Periodicity check: interior orbits repeat, so the loop can end early */
        if (chkOn == 0) { if (n >= 12) { chkR = zr; chkI = zi; chkOn = 1; } }
        else if ((n & 63) == 0) {
          const v128_t ddx = wasm_f64x2_sub(zr, chkR);
          const v128_t ddy = wasm_f64x2_sub(zi, chkI);
          const v128_t dd = wasm_f64x2_add(wasm_f64x2_mul(ddx, ddx), wasm_f64x2_mul(ddy, ddy));
          const v128_t zz = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
          const v128_t tol = wasm_f64x2_mul(wasm_f64x2_splat(1e-24),
                                            wasm_f64x2_add(zz, wasm_f64x2_splat(1.0)));
          const v128_t per = wasm_f64x2_lt(dd, tol);
          if (wasm_v128_any_true(per)) {
            const v128_t lane0 = wasm_i64x2_make(-1LL, 0);
            const v128_t lane1 = wasm_i64x2_make(0, -1LL);
            if (!p0 && n0 < 0 && wasm_f64x2_extract_lane(per, 0) != 0) { p0 = 1; dr = wasm_v128_bitselect(vhuge, dr, lane0); }
            if (!p1 && n1 < 0 && wasm_f64x2_extract_lane(per, 1) != 0) { p1 = 1; dr = wasm_v128_bitselect(vhuge, dr, lane1); }
            if ((n0 >= 0 || p0) && (n1 >= 0 || p1)) break;
          }
          chkR = zr; chkI = zi;      // rolling snapshot: a converging orbit
        }                            // never returns to its first value
      }

      /* Reference orbit exhausted (non-rebasing path only) */
      if (!rebase && i0 >= refLen && i1 >= refLen && (n0 < 0 || n1 < 0)) {
        const v128_t zr = wasm_f64x2_add(wasm_f64x2_splat(Zr[refLen]), dr);
        const v128_t zi = wasm_f64x2_add(wasm_f64x2_splat(Zi[refLen]), di);
        const v128_t m2 = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
        if (n0 < 0) { if (wasm_f64x2_extract_lane(m2, 0) > BAIL2) { n0 = refLen; m20 = wasm_f64x2_extract_lane(m2, 0); } else g0 = 1; }
        if (n1 < 0) { if (wasm_f64x2_extract_lane(m2, 1) > BAIL2) { n1 = refLen; m21 = wasm_f64x2_extract_lane(m2, 1); } else g1 = 1; }
      }

      const int gptr = ldi(p, 38), gcap = ldi(p, 39);
      const int gbase = glitches;
      glitches += g0 + (pair ? g1 : 0);
      if (g0) emitGlitch(gptr, gcap, gbase, tx + px, ty + py);
      if (pair && g1) emitGlitch(gptr, gcap, gbase + g0, tx + px + 1, ty + py);
      const double invLogPower = 1.4426950408889634;
      const int gxi = tx + px, gyi = ty + py;
      if (n0 >= 0 && !p0) {
        const double raw = smoothOf(n0, m20, invLogPower);
        statAdd(st, raw, gxi, gyi, W, H, maxIter);
        shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m20, d20, ps, legacyDe),
                     deOn ? scheme : 0, deW, deS, gxi, gyi, dither);
      } else putInterior(outPtr, o);
      o += 4;
      if (pair) {
        if (n1 >= 0 && !p1) {
          const double raw = smoothOf(n1, m21, invLogPower);
          statAdd(st, raw, gxi + 1, gyi, W, H, maxIter);
          shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m21, d21, ps, legacyDe),
                       deOn ? scheme : 0, deW, deS, gxi + 1, gyi, dither);
        } else putInterior(outPtr, o);
        o += 4;
      }
    }
  }
  writeStats(p, st);
  return glitches;
}

/* ============ Perturbation · power 2 · double-double reference ============
 *
 * Why this exists
 * ---------------
 * The plain perturbation path stores the reference orbit as doubles, i.e. each
 * Z_n is a 53-bit rounding of the true orbit value.  That rounding is not a
 * valid orbit: every step contributes an additive kick of ~eps*|Z| ≈ 1e-16 to
 * the perturbation recursion, and the orbit derivative amplifies those kicks
 * along the iteration (a near-parabolic orbit at 1e20 zoom amplified them by
 * ~1e12 over 9000 steps).  Once the pixel spacing is below ~1e-16 — which is
 * exactly the 1e17 zoom limit — the kick is thousands of times larger than the
 * signal, tiles turn into mosaics and colour bands, and raising `bits` cannot
 * help because the *stored* values are still doubles.
 *
 * Here the reference is kept as an (hi, lo) pair and the perturbation itself is
 * carried in double-double, i.e. ~106 significant bits.  The kicks drop to
 * ~1e-32 and the same failure point moves out to ~1e30 zoom.  Cost is about
 * 4-5x the plain double loop, which is why the host only selects it once the
 * pixel spacing actually needs it (psLog2 <= -46).
 */
static inline void ddTwoSumV(v128_t a, v128_t b, v128_t &s, v128_t &e) {
  s = wasm_f64x2_add(a, b);
  v128_t bb = wasm_f64x2_sub(s, a);
  e = wasm_f64x2_add(wasm_f64x2_sub(a, wasm_f64x2_sub(s, bb)),
                     wasm_f64x2_sub(b, bb));
}
static inline void ddQuickSumV(v128_t a, v128_t b, v128_t &s, v128_t &e) {
  s = wasm_f64x2_add(a, b);
  e = wasm_f64x2_sub(b, wasm_f64x2_sub(s, a));
}
/* Dekker product: p + e == a * b exactly (no FMA needed) */
static inline void ddTwoProdV(v128_t a, v128_t b, v128_t &p, v128_t &e) {
  p = wasm_f64x2_mul(a, b);
  const v128_t sp = wasm_f64x2_splat(134217729.0);  // 2^27 + 1
  v128_t ta = wasm_f64x2_mul(sp, a);
  v128_t ah = wasm_f64x2_sub(ta, wasm_f64x2_sub(ta, a));
  v128_t al = wasm_f64x2_sub(a, ah);
  v128_t tb = wasm_f64x2_mul(sp, b);
  v128_t bh = wasm_f64x2_sub(tb, wasm_f64x2_sub(tb, b));
  v128_t bl = wasm_f64x2_sub(b, bh);
  v128_t ahbh = wasm_f64x2_mul(ah, bh);
  // Dekker residual: ah*bh == p + e.  (ahbh - p) is the rounding error of
  // p; writing ahbh + (p - ahbh) instead would give e == p and double the
  // product.
  e = wasm_f64x2_add(wasm_f64x2_sub(ahbh, p),
                     wasm_f64x2_add(wasm_f64x2_mul(ah, bl), wasm_f64x2_mul(al, bh)));
  e = wasm_f64x2_add(e, wasm_f64x2_mul(al, bl));
}
static inline void ddAddV(v128_t ah, v128_t al, v128_t bh, v128_t bl,
                          v128_t &h, v128_t &l) {
  v128_t s, e;
  ddTwoSumV(ah, bh, s, e);
  e = wasm_f64x2_add(e, wasm_f64x2_add(al, bl));
  ddQuickSumV(s, e, h, l);
}
static inline void ddMulV(v128_t ah, v128_t al, v128_t bh, v128_t bl,
                          v128_t &h, v128_t &l) {
  v128_t p, e;
  ddTwoProdV(ah, bh, p, e);
  e = wasm_f64x2_add(e, wasm_f64x2_add(wasm_f64x2_mul(ah, bl), wasm_f64x2_mul(al, bh)));
  ddQuickSumV(p, e, h, l);
}

static int renderPerturb2dd(int p) {
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const int W = ldi(p, 8), H = ldi(p, 9);
  const int maxIter = ldi(p, 15);
  const Shade sh = loadShade(p);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const int refPtr = ldi(p, 20);
  const int refLen = ldi(p, 21);
  const double refPx = ldf(p, 22), refPy = ldf(p, 23);
  const double ps = ldf(p, 12);
  const int stride = ldi(p, 28);
  const double *Zr = (const double *)refPtr;
  const double *Zi = (const double *)(refPtr + ((long)stride << 3));
  const int deOn = ldi(p, 41);
  const double deW = ldf(p, 42), deS = ldf(p, 43);
  const int scheme = ldi(p, 44);
  const int dither = ldi(p, 50);
  const int legacyDe = ldi(p, 51);
  const int rebase = ldi(p, 3) || ldi(p, 52) ? 0 : 1;
  Stats st{1e300, -1e300, -1e300};
  const double *ZrLo = (const double *)(refPtr + ((long)stride << 4));
  const double *ZiLo = (const double *)(refPtr + ((long)stride << 4) + ((long)stride << 3));

  const v128_t vbail = wasm_f64x2_splat(BAIL2);
  const v128_t vhuge = wasm_f64x2_splat(1e30);
  const v128_t vzero = wasm_f64x2_splat(0.0);
  const int saOn = ldi(p, 37);
  const int skip = ldi(p, 29);
  const double saAr = ldf(p, 30), saAi = ldf(p, 31);
  const double saBr = ldf(p, 32), saBi = ldf(p, 33);
  const double saCr = ldf(p, 34), saCi = ldf(p, 35);
  const int isJulia = ldi(p, 3);
  int o = 0;
  int glitches = 0;

  for (int py = 0; py < th; py++) {
    const double gy = (double)(ty + py) + 0.5;
    for (int px = 0; px < tw; px += 2) {
      const bool pair = (px + 1 < tw);
      const double gx0 = (double)(tx + px) + 0.5;
      const double gx1 = gx0 + 1.0;
      const double dcr0 = (gx0 - refPx) * ps;
      const double dcr1 = (gx1 - refPx) * ps;
      const double dci0 = -(gy - refPy) * ps;

      const v128_t poR = wasm_f64x2_make(dcr0, pair ? dcr1 : dcr0);
      const v128_t poI = wasm_f64x2_splat(dci0);
      const v128_t vdcr = isJulia ? vzero : poR;
      const v128_t vdci = isJulia ? vzero : poI;
      v128_t drh = poR, drl = vzero;
      v128_t dih = poI, dil = vzero;
      /* derivative of z wrt c, tracked in double (range is ample) */
      v128_t derR = isJulia ? wasm_f64x2_splat(1.0) : vzero;
      v128_t derI = vzero;

      int n0 = -1, n1 = -1;
      double m20 = 0.0, m21 = 0.0;
      double d20 = 0.0, d21 = 0.0;
      int g0 = 0, g1 = 0;
      int p0 = 0, p1 = 0;
      v128_t esc = wasm_i64x2_splat(0);
      v128_t chkR = vzero, chkI = vzero;
      int chkOn = 0;
      int n = 0;
      int i0 = 0, i1 = 0;                 // per-lane reference index (rebase resets it)

      if (saOn && skip > 8 && skip + 8 < refLen && skip < maxIter) {
        const v128_t d2r = wasm_f64x2_sub(wasm_f64x2_mul(poR, poR), wasm_f64x2_mul(poI, poI));
        const v128_t d2i = wasm_f64x2_add(wasm_f64x2_mul(poR, poI), wasm_f64x2_mul(poR, poI));
        const v128_t d3r = wasm_f64x2_sub(wasm_f64x2_mul(d2r, poR), wasm_f64x2_mul(d2i, poI));
        const v128_t d3i = wasm_f64x2_add(wasm_f64x2_mul(d2r, poI), wasm_f64x2_mul(d2i, poR));
        const v128_t vAr = wasm_f64x2_splat(saAr), vAi = wasm_f64x2_splat(saAi);
        const v128_t vBr = wasm_f64x2_splat(saBr), vBi = wasm_f64x2_splat(saBi);
        const v128_t vCr = wasm_f64x2_splat(saCr), vCi = wasm_f64x2_splat(saCi);
        const v128_t linR = wasm_f64x2_sub(wasm_f64x2_mul(vAr, poR), wasm_f64x2_mul(vAi, poI));
        const v128_t linI = wasm_f64x2_add(wasm_f64x2_mul(vAr, poI), wasm_f64x2_mul(vAi, poR));
        const v128_t qudR = wasm_f64x2_sub(wasm_f64x2_mul(vBr, d2r), wasm_f64x2_mul(vBi, d2i));
        const v128_t qudI = wasm_f64x2_add(wasm_f64x2_mul(vBr, d2i), wasm_f64x2_mul(vBi, d2r));
        const v128_t cubR = wasm_f64x2_sub(wasm_f64x2_mul(vCr, d3r), wasm_f64x2_mul(vCi, d3i));
        const v128_t cubI = wasm_f64x2_add(wasm_f64x2_mul(vCr, d3i), wasm_f64x2_mul(vCi, d3r));
        drh = wasm_f64x2_add(wasm_f64x2_add(linR, qudR), cubR);
        dih = wasm_f64x2_add(wasm_f64x2_add(linI, qudI), cubI);
        drl = vzero; dil = vzero;
        {
          const v128_t qdR = wasm_f64x2_sub(wasm_f64x2_mul(vBr, poR), wasm_f64x2_mul(vBi, poI));
          const v128_t qdI = wasm_f64x2_add(wasm_f64x2_mul(vBr, poI), wasm_f64x2_mul(vBi, poR));
          const v128_t cdR = wasm_f64x2_sub(wasm_f64x2_mul(vCr, d2r), wasm_f64x2_mul(vCi, d2i));
          const v128_t cdI = wasm_f64x2_add(wasm_f64x2_mul(vCr, d2i), wasm_f64x2_mul(vCi, d2r));
          derR = wasm_f64x2_add(wasm_f64x2_add(vAr, wasm_f64x2_mul(wasm_f64x2_splat(2.0), qdR)),
                                wasm_f64x2_mul(wasm_f64x2_splat(3.0), cdR));
          derI = wasm_f64x2_add(wasm_f64x2_add(vAi, wasm_f64x2_mul(wasm_f64x2_splat(2.0), qdI)),
                                wasm_f64x2_mul(wasm_f64x2_splat(3.0), cdI));
        }
        n = skip;
        i0 = skip; i1 = skip;

        const v128_t zsk = wasm_f64x2_add(wasm_f64x2_splat(Zr[skip]), drh);
        const v128_t zskI = wasm_f64x2_add(wasm_f64x2_splat(Zi[skip]), dih);
        const v128_t msk = wasm_f64x2_add(wasm_f64x2_mul(zsk, zsk), wasm_f64x2_mul(zskI, zskI));
        if (wasm_v128_any_true(wasm_f64x2_gt(msk, vbail))) {
          drh = poR; dih = poI; drl = vzero; dil = vzero; n = 0; i0 = 0; i1 = 0;
          derR = isJulia ? wasm_f64x2_splat(1.0) : vzero; derI = vzero;
        }
      }

      for (; n < maxIter; n++) {
        const double Xr0 = (i0 < refLen ? Zr[i0] : 0.0);
        const double Xi0 = (i0 < refLen ? Zi[i0] : 0.0);
        const double XrLo0 = (i0 < refLen ? ZrLo[i0] : 0.0);
        const double XiLo0 = (i0 < refLen ? ZiLo[i0] : 0.0);
        const double Xr1 = (i1 < refLen ? Zr[i1] : 0.0);
        const double Xi1 = (i1 < refLen ? Zi[i1] : 0.0);
        const double XrLo1 = (i1 < refLen ? ZrLo[i1] : 0.0);
        const double XiLo1 = (i1 < refLen ? ZiLo[i1] : 0.0);
        v128_t vZr = wasm_f64x2_make(Xr0, Xr1);
        v128_t vZi = wasm_f64x2_make(Xi0, Xi1);
        v128_t vZrLo = wasm_f64x2_make(XrLo0, XrLo1);
        v128_t vZiLo = wasm_f64x2_make(XiLo0, XiLo1);
        const v128_t zr = wasm_f64x2_add(vZr, drh);
        const v128_t zi = wasm_f64x2_add(vZi, dih);
        const v128_t m2 = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
        const v128_t hit = wasm_f64x2_gt(m2, vbail);

        /* KF singleref rebase: |Z+dz|² < |dz|² (high words carry the test). */
        v128_t rb = wasm_i64x2_splat(0);
        if (rebase) {
          const v128_t dm2 = wasm_f64x2_add(wasm_f64x2_mul(drh, drh), wasm_f64x2_mul(dih, dih));
          const v128_t outm = wasm_i64x2_make(i0 >= refLen ? -1LL : 0LL,
                                              i1 >= refLen ? -1LL : 0LL);
          rb = wasm_v128_or(wasm_f64x2_lt(m2, dm2), outm);
          drh = wasm_v128_bitselect(zr, drh, rb);
          dih = wasm_v128_bitselect(zi, dih, rb);
          drl = wasm_v128_bitselect(vzero, drl, rb);
          dil = wasm_v128_bitselect(vzero, dil, rb);
          vZr = wasm_v128_bitselect(vzero, vZr, rb);     // this step adds X = 0
          vZi = wasm_v128_bitselect(vzero, vZi, rb);
          vZrLo = wasm_v128_bitselect(vzero, vZrLo, rb);
          vZiLo = wasm_v128_bitselect(vzero, vZiLo, rb);
          if (wasm_i64x2_extract_lane(rb, 0) != 0) i0 = 0;
          if (wasm_i64x2_extract_lane(rb, 1) != 0) i1 = 0;
        }

        /* t = 2*Z + dz, carried as a double-double pair */
        v128_t tzh, tzl, tih, til;
        ddAddV(wasm_f64x2_add(vZr, vZr), wasm_f64x2_add(vZrLo, vZrLo),
               drh, drl, tzh, tzl);
        ddAddV(wasm_f64x2_add(vZi, vZi), wasm_f64x2_add(vZiLo, vZiLo),
               dih, dil, tih, til);

        v128_t prh, prl, qrh, qrl, arh, arl, ndrh, ndrl, ndih, ndil;
        /* real part: tz*dz - ti*di + dcr */
        ddMulV(tzh, tzl, drh, drl, prh, prl);
        ddMulV(tih, til, dih, dil, qrh, qrl);
        ddAddV(prh, prl, wasm_f64x2_neg(qrh), wasm_f64x2_neg(qrl), arh, arl);
        ddAddV(arh, arl, vdcr, vzero, ndrh, ndrl);
        /* imaginary part: tz*di + ti*dz + dci */
        ddMulV(tzh, tzl, dih, dil, prh, prl);
        ddMulV(tih, til, drh, drl, qrh, qrl);
        ddAddV(prh, prl, qrh, qrl, arh, arl);
        ddAddV(arh, arl, vdci, vzero, ndih, ndil);
        const v128_t nderR = wasm_f64x2_add(
            wasm_f64x2_mul(wasm_f64x2_splat(2.0), wasm_f64x2_sub(wasm_f64x2_mul(zr, derR), wasm_f64x2_mul(zi, derI))),
            wasm_f64x2_splat(1.0));
        const v128_t nderI = wasm_f64x2_mul(
            wasm_f64x2_splat(2.0), wasm_f64x2_add(wasm_f64x2_mul(zr, derI), wasm_f64x2_mul(zi, derR)));
        const v128_t dmag = hypotV(derR, derI);
        drh = ndrh; drl = ndrl;
        dih = ndih; dil = ndil;

        if (wasm_v128_any_true(hit)) {
          const v128_t fresh = wasm_v128_andnot(hit, esc);
          if (wasm_v128_any_true(fresh)) {
            if (n0 < 0 && wasm_f64x2_extract_lane(fresh, 0) != 0) {
              n0 = n; m20 = wasm_f64x2_extract_lane(m2, 0); d20 = wasm_f64x2_extract_lane(dmag, 0);
            }
            if (n1 < 0 && wasm_f64x2_extract_lane(fresh, 1) != 0) {
              n1 = n; m21 = wasm_f64x2_extract_lane(m2, 1); d21 = wasm_f64x2_extract_lane(dmag, 1);
            }
          }
          esc = wasm_v128_or(esc, hit);
          if ((n0 >= 0 || p0) && (n1 >= 0 || p1)) break;
          drh = wasm_v128_bitselect(vhuge, drh, esc);
          drl = wasm_v128_bitselect(vzero, drl, esc);
          dih = wasm_v128_bitselect(vzero, dih, esc);
          dil = wasm_v128_bitselect(vzero, dil, esc);
        }
        derR = wasm_v128_bitselect(vzero, nderR, esc);
        derI = wasm_v128_bitselect(vzero, nderI, esc);

        if ((!rebase || wasm_i64x2_extract_lane(rb, 0) == 0) && i0 < refLen) i0++;
        if ((!rebase || wasm_i64x2_extract_lane(rb, 1) == 0) && i1 < refLen) i1++;
        if (!rebase && i0 >= refLen && i1 >= refLen) break;

        if (chkOn == 0) { if (n >= 12) { chkR = zr; chkI = zi; chkOn = 1; } }
        else if ((n & 63) == 0) {
          const v128_t ddx = wasm_f64x2_sub(zr, chkR);
          const v128_t ddy = wasm_f64x2_sub(zi, chkI);
          const v128_t dd = wasm_f64x2_add(wasm_f64x2_mul(ddx, ddx), wasm_f64x2_mul(ddy, ddy));
          const v128_t zz = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
          const v128_t tol = wasm_f64x2_mul(wasm_f64x2_splat(1e-24),
                                            wasm_f64x2_add(zz, wasm_f64x2_splat(1.0)));
          const v128_t per = wasm_f64x2_lt(dd, tol);
          if (wasm_v128_any_true(per)) {
            const v128_t lane0 = wasm_i64x2_make(-1LL, 0);
            const v128_t lane1 = wasm_i64x2_make(0, -1LL);
            if (!p0 && n0 < 0 && wasm_f64x2_extract_lane(per, 0) != 0) { p0 = 1; drh = wasm_v128_bitselect(vhuge, drh, lane0); }
            if (!p1 && n1 < 0 && wasm_f64x2_extract_lane(per, 1) != 0) { p1 = 1; drh = wasm_v128_bitselect(vhuge, drh, lane1); }
            if ((n0 >= 0 || p0) && (n1 >= 0 || p1)) break;
          }
          chkR = zr; chkI = zi;      // rolling snapshot: a converging orbit
        }                            // never returns to its first value
      }

      if (!rebase && i0 >= refLen && i1 >= refLen && (n0 < 0 || n1 < 0)) {
        const v128_t zr = wasm_f64x2_add(wasm_f64x2_splat(Zr[refLen]), drh);
        const v128_t zi = wasm_f64x2_add(wasm_f64x2_splat(Zi[refLen]), dih);
        const v128_t m2 = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
        if (n0 < 0) { if (wasm_f64x2_extract_lane(m2, 0) > BAIL2) { n0 = refLen; m20 = wasm_f64x2_extract_lane(m2, 0); } else g0 = 1; }
        if (n1 < 0) { if (wasm_f64x2_extract_lane(m2, 1) > BAIL2) { n1 = refLen; m21 = wasm_f64x2_extract_lane(m2, 1); } else g1 = 1; }
      }

      const int gptr = ldi(p, 38), gcap = ldi(p, 39);
      const int gbase = glitches;
      glitches += g0 + (pair ? g1 : 0);
      if (g0) emitGlitch(gptr, gcap, gbase, tx + px, ty + py);
      if (pair && g1) emitGlitch(gptr, gcap, gbase + g0, tx + px + 1, ty + py);
      const double invLogPower = 1.4426950408889634;
      const int gxi = tx + px, gyi = ty + py;
      if (n0 >= 0 && !p0) {
        const double raw = smoothOf(n0, m20, invLogPower);
        statAdd(st, raw, gxi, gyi, W, H, maxIter);
        shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m20, d20, ps, legacyDe),
                     deOn ? scheme : 0, deW, deS, gxi, gyi, dither);
      } else putInterior(outPtr, o);
      o += 4;
      if (pair) {
        if (n1 >= 0 && !p1) {
          const double raw = smoothOf(n1, m21, invLogPower);
          statAdd(st, raw, gxi + 1, gyi, W, H, maxIter);
          shadeEscaped(outPtr, o, lutPtr, raw, sh, dePixels(m21, d21, ps, legacyDe),
                       deOn ? scheme : 0, deW, deS, gxi + 1, gyi, dither);
        } else putInterior(outPtr, o);
        o += 4;
      }
    }
  }
  writeStats(p, st);
  return glitches;
}

/* ================= Perturbation · generic power (scalar) ================= */

static int renderPerturbN(int p) {
  const int power = ldi(p, 2);
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const int maxIter = ldi(p, 15);
  const double bandScale = 1.0 / (ldf(p, 16) > 1.0 ? ldf(p, 16) : 1.0);
  const double offset = ldf(p, 17);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const int refPtr = ldi(p, 20);
  const int refLen = ldi(p, 21);
  const double refPx = ldf(p, 22), refPy = ldf(p, 23);
  const double ps = ldf(p, 12);
  const int stride = ldi(p, 28);
  const double *Zr = (const double *)refPtr;
  const double *Zi = (const double *)(refPtr + ((long)stride << 3));
  const int deOn = ldi(p, 41);
  const double deW = ldf(p, 42), deS = ldf(p, 43);
  const int scheme = ldi(p, 44);
  const double invLogPower = 1.0 / fastlog((double)power);
  const Shade sh = loadShade(p);
  const int dither = ldi(p, 50);
  const int W = ldi(p, 8), H = ldi(p, 9);
  Stats st{1e300, -1e300, -1e300};
  int o = 0;
  int glitches = 0;

  for (int py = 0; py < th; py++) {
    const double gy = (double)(ty + py) + 0.5;
    for (int px = 0; px < tw; px++) {
      const double gx = (double)(tx + px) + 0.5;
      const double dcr = (gx - refPx) * ps;
      const double dci = -(gy - refPy) * ps;
      double dr = dcr, di = dci;
      int n = 0;
      double m2 = 0.0;
      bool esc = false, glitch = false;

      for (; n < maxIter && n < refLen; n++) {
        const double zrS = Zr[n], ziS = Zi[n];
        const double zr = zrS + dr, zi = ziS + di;
        m2 = zr * zr + zi * zi;
        if (m2 > BAIL2) { esc = true; break; }
        const double d2 = dr * dr + di * di;
        /* See renderPerturb2: a collision alone is not a defect, so it is
           measured but not reported as a glitch. */
        (void)d2;

        double zpr = 1.0, zpi = 0.0;
        for (int k = 0; k < power - 1; k++) {
          const double r2 = zpr * zrS - zpi * ziS, i2 = zpr * ziS + zpi * zrS;
          zpr = r2; zpi = i2;
        }
        double dkr = dr, dki = di;
        double sr = 0.0, si = 0.0, binom = 1.0;
        for (int k = 1; k <= power; k++) {
          binom = binom * (double)(power - k + 1) / (double)k;
          sr += binom * (zpr * dkr - zpi * dki);
          si += binom * (zpr * dki + zpi * dkr);
          if (k < power) {
            const double r2 = dkr * dr - dki * di, i2 = dkr * di + dki * dr;
            dkr = r2; dki = i2;
            const double za = zpr * zrS - zpi * ziS, zb = zpr * ziS + zpi * zrS;
            zpr = za; zpi = zb;
          }
        }
        dr = sr + dcr; di = si + dci;
      }

      if (n >= refLen && !esc) {
        const double zr = Zr[refLen] + dr, zi = Zi[refLen] + di;
        m2 = zr * zr + zi * zi;
        if (m2 > BAIL2) { esc = true; n = refLen; } else glitch = true;
      }
      if (glitch) {
        emitGlitch(ldi(p, 38), ldi(p, 39), glitches, tx + px, ty + py);
        glitches++;
      }
      if (esc) {
        const double raw = smoothOf(n, m2, invLogPower);
        statAdd(st, raw, tx + px, ty + py, W, H, maxIter);
        putColor(outPtr, o, lutPtr, colorT(sh, raw), tx + px, ty + py, dither);
      } else putInterior(outPtr, o);
      o += 4;
    }
  }
  writeStats(p, st);
  return glitches;
}

/* ================= Newton sets (scalar) ================= */

static int renderNewton(int p) {
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const double halfW = ldf(p, 8) * 0.5, halfH = ldf(p, 9) * 0.5;
  const double cre = ldf(p, 10), cim = ldf(p, 11), ps = ldf(p, 12);
  const int maxIter = ldi(p, 15);
  const double bandScale = 1.0 / (ldf(p, 16) > 1.0 ? ldf(p, 16) : 1.0);
  const double offset = ldf(p, 17);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const int deg = ldi(p, 26);
  const int rootsPtr = ldi(p, 27);
  const double *roots = (const double *)rootsPtr;
  const double eps = 1e-12;
  const int dither = ldi(p, 50);
  int o = 0;

  for (int py = 0; py < th; py++) {
    const double gy = (double)(ty + py) + 0.5;
    for (int px = 0; px < tw; px++) {
      const double gx = (double)(tx + px) + 0.5;
      double zr = cre + (gx - halfW) * ps;
      double zi = cim - (gy - halfH) * ps;
      int n = 0, root = -1;
      double dist = 1.0;
      for (; n < maxIter; n++) {
        double pr = 1.0, pi = 0.0;
        for (int k = 0; k < deg - 1; k++) {
          const double r2 = pr * zr - pi * zi, i2 = pr * zi + pi * zr;
          pr = r2; pi = i2;
        }
        const double qr = pr * zr - pi * zi - 1.0;
        const double qi = pr * zi + pi * zr;
        const double drr = (double)deg * pr, dii = (double)deg * pi;
        const double den = drr * drr + dii * dii;
        if (den < 1e-300) break;
        const double numR = qr * drr + qi * dii;
        const double numI = qi * drr - qr * dii;
        zr -= numR / den;
        zi -= numI / den;
        if (n > 3) {
          for (int k = 0; k < deg; k++) {
            const double ex = zr - roots[k * 2], ey = zi - roots[k * 2 + 1];
            const double dd = ex * ex + ey * ey;
            if (dd < eps) { root = k; dist = __builtin_sqrt(dd); break; }
          }
          if (root >= 0) break;
        }
      }
      if (root >= 0) {
        const double v = (double)n + 1.0 - fastlog(dist > 1e-15 ? dist : 1e-15) * 1.4426950408889634 / 8.0;
        putColor(outPtr, o, lutPtr, v * bandScale + (double)root * 0.173 + offset,
                 tx + px, ty + py, dither);
      } else {
        putInterior(outPtr, o);
      }
      o += 4;
    }
  }
  return 0;
}

/* ================= Entry point ================= */

EXPORT(render) int render(int p) {
  const int mode = ldi(p, 0);
  if (mode == 2) { renderNewton(p); return 0; }
  if (mode == 0) {
    if (ldi(p, 1) == 0 && ldi(p, 2) == 2) return renderDirect2(p);
    return renderDirectGeneric(p);
  }
  if (ldi(p, 2) == 2) {
    if (ldi(p, 40) != 0) return renderPerturb2dd(p);
    return renderPerturb2(p);
  }
  return renderPerturbN(p);
}
