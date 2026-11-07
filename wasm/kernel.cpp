// ------------------------------------------------------------------
// kernel.cpp — 分形像素内核（C++ → WebAssembly，wasm SIMD f64x2）
//
// 与 kernel.ts 保持完全相同的 ABI：单个 render(paramPtr) 入口，
// 参数块为 f64 数组，索引 × 8 即字节偏移：
//  0 mode(0 direct /1 perturb /2 newton)
//  1 kind(0 poly 1 tricorn 2 burningship 3 celtic 4 perpendicular 5 phoenix)
//  2 power  3 julia  4 tileX 5 tileY 6 tileW 7 tileH 8 imgW 9 imgH
// 10 centerRe 11 centerIm 12 ps 13 juliaRe 14 juliaIm
// 15 maxIter 16 cycle 17 offset 18 outPtr 19 lutPtr
// 20 refPtr 21 refLen 22 refPx 23 refPy 24 phoenixP 25 samples
// 26 newtonDegree 27 rootsPtr 28 orbitStride
//
// 热路径（二次幂直算 / 二次幂扰动）用 f64x2 一次推进两个像素。
// 编译：zig c++ -target wasm32-freestanding -O3 -msimd128 ...
// ------------------------------------------------------------------

#include <wasm_simd128.h>
#include <stdint.h>

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static const double BAIL2 = 1e20;
static const double LOGBAIL = 23.025850929940457;  // ln(1e10)
static const double SQRT2 = 1.4142135623730951;

static inline double ldf(int p, int i) { return *(double *)(p + (i << 3)); }
static inline int ldi(int p, int i) { return (int)*(double *)(p + (i << 3)); }

/* 自带对数（避免链接 libm）：frexp + atanh 级数，误差 < 1e-13 */
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

static inline void putColor(int outPtr, int o, int lutPtr, double t) {
  double u = t - __builtin_floor(t);
  int i0 = (int)(u * 512.0);
  if (i0 >= 512) i0 = 511;
  if (i0 < 0) i0 = 0;
  const double f = u * 512.0 - (double)i0;
  const int j0 = (i0 + 1) & 511;
  const uint8_t *a = (const uint8_t *)(lutPtr + (i0 << 2));
  const uint8_t *b = (const uint8_t *)(lutPtr + (j0 << 2));
  uint8_t *o8 = (uint8_t *)(outPtr + o);
  o8[0] = (uint8_t)((double)a[0] + ((double)b[0] - (double)a[0]) * f + 0.5);
  o8[1] = (uint8_t)((double)a[1] + ((double)b[1] - (double)a[1]) * f + 0.5);
  o8[2] = (uint8_t)((double)a[2] + ((double)b[2] - (double)a[2]) * f + 0.5);
  o8[3] = 255;
}

static inline void putInterior(int outPtr, int o) {
  uint8_t *o8 = (uint8_t *)(outPtr + o);
  o8[0] = 5; o8[1] = 6; o8[2] = 9; o8[3] = 255;
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

/* ================= 直算 · 二次幂（SIMD 双像素） ================= */

static int renderDirect2(int p) {
  const bool isJulia = ldi(p, 3) != 0;
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const double halfW = ldf(p, 8) * 0.5, halfH = ldf(p, 9) * 0.5;
  const double cre = ldf(p, 10), cim = ldf(p, 11), ps = ldf(p, 12);
  const double jre = ldf(p, 13), jim = ldf(p, 14);
  const int maxIter = ldi(p, 15);
  const double bandScale = 1.0 / (ldf(p, 16) > 1.0 ? ldf(p, 16) : 1.0);
  const double offset = ldf(p, 17);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);

  const v128_t vbail = wasm_f64x2_splat(BAIL2);
  const v128_t vhuge = wasm_f64x2_splat(1e30);
  const v128_t vzero = wasm_f64x2_splat(0.0);
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

      int n0 = -1, n1 = -1;
      double m20 = 0.0, m21 = 0.0;
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
            if (n0 < 0 && wasm_f64x2_extract_lane(fresh, 0) != 0) {
              n0 = n; m20 = wasm_f64x2_extract_lane(m2, 0);
            }
            if (n1 < 0 && wasm_f64x2_extract_lane(fresh, 1) != 0) {
              n1 = n; m21 = wasm_f64x2_extract_lane(m2, 1);
            }
          }
          esc = wasm_v128_or(esc, hit);
          if (n0 >= 0 && n1 >= 0) break;
          zr = wasm_v128_bitselect(vhuge, zr, esc);
          zi = wasm_v128_bitselect(vzero, zi, esc);
        }

        /* 未逃逸通道继续迭代 */
        {
          const v128_t nzr = wasm_f64x2_add(t, vcr);
          const v128_t nzi = wasm_f64x2_add(u, vci);
          zr = wasm_v128_bitselect(vhuge, nzr, esc);
          zi = wasm_v128_bitselect(vzero, nzi, esc);
        }

        /* 周期检测：内部点提前退出 */
        if (n == 12) { chkR = zr; chkI = zi; chkOn = 1; }
        else if (chkOn && ((n & 63) == 0)) {
          const v128_t dxv = wasm_f64x2_sub(zr, chkR);
          const v128_t dyv = wasm_f64x2_sub(zi, chkI);
          const v128_t d2 = wasm_f64x2_add(wasm_f64x2_mul(dxv, dxv), wasm_f64x2_mul(dyv, dyv));
          const v128_t per = wasm_f64x2_lt(d2, wasm_f64x2_splat(1e-26));
          if (wasm_v128_any_true(per)) {
            if (period0 == 0 && n0 < 0 && wasm_f64x2_extract_lane(per, 0) != 0) period0 = 1;
            if (period1 == 0 && n1 < 0 && wasm_f64x2_extract_lane(per, 1) != 0) period1 = 1;
            if ((n0 >= 0 || period0) && (n1 >= 0 || period1)) break;
          }
        }
      }

      const double invLogPower = 1.4426950408889634;
      if (n0 >= 0) putColor(outPtr, o, lutPtr, smoothOf(n0, m20, invLogPower) * bandScale + offset);
      else putInterior(outPtr, o);
      o += 4;
      if (n1 >= 0) putColor(outPtr, o, lutPtr, smoothOf(n1, m21, invLogPower) * bandScale + offset);
      else putInterior(outPtr, o);
      o += 4;
    }
    /* 行尾单独像素 */
    if (px < tw) {
      const double gx = (double)(tx + px) + 0.5;
      const double cr = isJulia ? jre : cre + (gx - halfW) * ps;
      const double ci = isJulia ? jim : cim - (gy - halfH) * ps;
      double zr = isJulia ? cre + (gx - halfW) * ps : 0.0;
      double zi = isJulia ? cim - (gy - halfH) * ps : 0.0;
      int n = 0;
      double m2 = 0.0;
      bool esc = false;
      double chkR = 0.0, chkI = 0.0;
      bool chkOn = false;
      for (; n < maxIter; n++) {
        const double zr2 = zr * zr, zi2 = zi * zi;
        m2 = zr2 + zi2;
        if (m2 > BAIL2) { esc = true; break; }
        zi = 2.0 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        if (n == 12) { chkR = zr; chkI = zi; chkOn = true; }
        else if (chkOn && ((n & 63) == 0)) {
          const double dx = zr - chkR, dy = zi - chkI;
          if (dx * dx + dy * dy < 1e-26) { esc = false; n = maxIter; break; }
        }
      }
      if (esc) putColor(outPtr, o, lutPtr, smoothOf(n, m2, 1.4426950408889634) * bandScale + offset);
      else putInterior(outPtr, o);
      o += 4;
    }
  }
  return 0;
}

/* ================= 直算 · 通用族（标量） ================= */

static int renderDirectGeneric(int p) {
  const int kind = ldi(p, 1), power = ldi(p, 2);
  const bool isJulia = ldi(p, 3) != 0;
  const int tx = ldi(p, 4), ty = ldi(p, 5), tw = ldi(p, 6), th = ldi(p, 7);
  const double halfW = ldf(p, 8) * 0.5, halfH = ldf(p, 9) * 0.5;
  const double cre = ldf(p, 10), cim = ldf(p, 11), ps = ldf(p, 12);
  const double jre = ldf(p, 13), jim = ldf(p, 14);
  const int maxIter = ldi(p, 15);
  const double bandScale = 1.0 / (ldf(p, 16) > 1.0 ? ldf(p, 16) : 1.0);
  const double offset = ldf(p, 17);
  const int outPtr = ldi(p, 18), lutPtr = ldi(p, 19);
  const double ph = ldf(p, 24);
  const double invLogPower = power == 2 ? 1.4426950408889634 : 1.0 / fastlog((double)power);
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
      if (esc) putColor(outPtr, o, lutPtr, smoothOf(n, m2, invLogPower) * bandScale + offset);
      else putInterior(outPtr, o);
      o += 4;
    }
  }
  return 0;
}

/* ================= 扰动 · 二次幂（SIMD 双像素） ================= */

static int renderPerturb2(int p) {
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

  const v128_t vbail = wasm_f64x2_splat(BAIL2);
  const v128_t vhuge = wasm_f64x2_splat(1e30);
  const v128_t vzero = wasm_f64x2_splat(0.0);
  const v128_t vone = wasm_f64x2_splat(1.0);
  /* 级数近似参数 */
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
      /* Julia：c 固定，扰动常数为 0，初始扰动就是像素偏移 */
      const v128_t vdcr = isJulia ? vzero : poR;
      const v128_t vdci = isJulia ? vzero : poI;
      v128_t dr = poR;
      v128_t di = poI;

      int n0 = -1, n1 = -1;
      double m20 = 0.0, m21 = 0.0;
      int g0 = 0, g1 = 0;
      int p0 = 0, p1 = 0;                 // 周期（内部点）标记
      v128_t esc = wasm_i64x2_splat(0);
      v128_t chkR = vzero, chkI = vzero;
      int chkOn = 0;
      int n = 0;

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
        n = skip;

        /* 跳到第 skip 步时若已经逃逸，说明该像素其实很早就逃逸了：
           级数无法给出正确步数，退回从 0 开始逐次迭代 */
        const v128_t zsk = wasm_f64x2_add(wasm_f64x2_splat(Zr[skip]), dr);
        const v128_t zskI = wasm_f64x2_add(wasm_f64x2_splat(Zi[skip]), di);
        const v128_t msk = wasm_f64x2_add(wasm_f64x2_mul(zsk, zsk), wasm_f64x2_mul(zskI, zskI));
        if (wasm_v128_any_true(wasm_f64x2_gt(msk, vbail))) {
          dr = poR; di = poI; n = 0;
        }
      }

      for (; n < maxIter && n < refLen; n++) {
        const double zrS = Zr[n], ziS = Zi[n];
        const v128_t vZr = wasm_f64x2_splat(zrS);
        const v128_t vZi = wasm_f64x2_splat(ziS);
        const v128_t zr = wasm_f64x2_add(vZr, dr);
        const v128_t zi = wasm_f64x2_add(vZi, di);
        const v128_t m2 = wasm_f64x2_add(wasm_f64x2_mul(zr, zr), wasm_f64x2_mul(zi, zi));
        const v128_t hit = wasm_f64x2_gt(m2, vbail);
        const v128_t d2 = wasm_f64x2_add(wasm_f64x2_mul(dr, dr), wasm_f64x2_mul(di, di));
        const v128_t gl = wasm_f64x2_lt(m2, wasm_f64x2_mul(d2, wasm_f64x2_splat(1e-6)));

        /* A transient "collision" (|Z+dz| collapsing towards |dz|) does not
           by itself invalidate the result: the recursion recovers and the
           pixel is still coloured correctly.  Only pixels that never get a
           verdict -- reference orbit exhausted while |z| stays bounded -- are
           reported for repair.  Those are the ones that used to turn into
           black blobs.  Flagging every collision caught >80% of a deep tile,
           and the repair pass then replaced good pixels by slightly different
           ones, which is exactly what produced the speckle noise. */
        if (wasm_v128_any_true(gl)) {
          if (!g0 && wasm_f64x2_extract_lane(gl, 0) != 0) g0 = 1;
          if (!g1 && wasm_f64x2_extract_lane(gl, 1) != 0) g1 = 1;
        }

        const v128_t t = wasm_f64x2_add(wasm_f64x2_add(vZr, vZr), dr);
        const v128_t u = wasm_f64x2_add(wasm_f64x2_add(vZi, vZi), di);
        const v128_t ndr = wasm_f64x2_add(wasm_f64x2_sub(wasm_f64x2_mul(t, dr), wasm_f64x2_mul(u, di)), vdcr);
        const v128_t ndi = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(t, di), wasm_f64x2_mul(u, dr)), vdci);
        dr = ndr;
        di = ndi;

        if (wasm_v128_any_true(hit)) {
          const v128_t fresh = wasm_v128_andnot(hit, esc);
          if (wasm_v128_any_true(fresh)) {
            if (n0 < 0 && wasm_f64x2_extract_lane(fresh, 0) != 0) { n0 = n; m20 = wasm_f64x2_extract_lane(m2, 0); }
            if (n1 < 0 && wasm_f64x2_extract_lane(fresh, 1) != 0) { n1 = n; m21 = wasm_f64x2_extract_lane(m2, 1); }
          }
          esc = wasm_v128_or(esc, hit);
          if ((n0 >= 0 || p0) && (n1 >= 0 || p1)) break;
          dr = wasm_v128_bitselect(vhuge, dr, esc);
          di = wasm_v128_bitselect(vzero, di, esc);
        }

        /* 周期检测：内部点的轨道会重复，可提前结束 */
        if (chkOn == 0) { if (n >= 12) { chkR = zr; chkI = zi; chkOn = 1; } }
        else if ((n & 63) == 0) {
          const v128_t ddx = wasm_f64x2_sub(zr, chkR);
          const v128_t ddy = wasm_f64x2_sub(zi, chkI);
          const v128_t dd = wasm_f64x2_add(wasm_f64x2_mul(ddx, ddx), wasm_f64x2_mul(ddy, ddy));
          const v128_t per = wasm_f64x2_lt(dd, wasm_f64x2_splat(1e-26));
          if (wasm_v128_any_true(per)) {
            const v128_t lane0 = wasm_i64x2_make(-1LL, 0);
            const v128_t lane1 = wasm_i64x2_make(0, -1LL);
            if (!p0 && n0 < 0 && wasm_f64x2_extract_lane(per, 0) != 0) { p0 = 1; dr = wasm_v128_bitselect(vhuge, dr, lane0); }
            if (!p1 && n1 < 0 && wasm_f64x2_extract_lane(per, 1) != 0) { p1 = 1; dr = wasm_v128_bitselect(vhuge, dr, lane1); }
            if ((n0 >= 0 || p0) && (n1 >= 0 || p1)) break;
          }
        }
      }

      /* 参考轨道耗尽 */
      if (n >= refLen && (n0 < 0 || n1 < 0)) {
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
      if (n0 >= 0 && !p0) putColor(outPtr, o, lutPtr, smoothOf(n0, m20, invLogPower) * bandScale + offset);
      else putInterior(outPtr, o);
      o += 4;
      if (pair) {
        if (n1 >= 0 && !p1) putColor(outPtr, o, lutPtr, smoothOf(n1, m21, invLogPower) * bandScale + offset);
        else putInterior(outPtr, o);
        o += 4;
      }
    }
  }
  return glitches;
}

/* ================= 扰动 · 通用幂（标量） ================= */

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
  const double invLogPower = 1.0 / fastlog((double)power);
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
           measured but no longer reported as a glitch. */
        if (m2 < d2 * 1e-6) glitch = true;

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
      if (esc) putColor(outPtr, o, lutPtr, smoothOf(n, m2, invLogPower) * bandScale + offset);
      else putInterior(outPtr, o);
      o += 4;
    }
  }
  return glitches;
}

/* ================= 牛顿集（标量） ================= */

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
        putColor(outPtr, o, lutPtr, v * bandScale + (double)root * 0.173 + offset);
      } else {
        putInterior(outPtr, o);
      }
      o += 4;
    }
  }
  return 0;
}

/* ================= 入口 ================= */

EXPORT(render) int render(int p) {
  const int mode = ldi(p, 0);
  if (mode == 2) { renderNewton(p); return 0; }
  if (mode == 0) {
    if (ldi(p, 1) == 0 && ldi(p, 2) == 2) return renderDirect2(p);
    return renderDirectGeneric(p);
  }
  if (ldi(p, 2) == 2) return renderPerturb2(p);
  return renderPerturbN(p);
}
