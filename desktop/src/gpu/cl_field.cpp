// ---------------------------------------------------------------------------
// cl_field.cpp — OpenCL implementation of the direct iteration kernel.
//
// The kernel mirrors core/mb_kernels.cpp:directPixel() operation for
// operation, so a GPU tile and a CPU tile can be diffed pixel by pixel:
//
//   · the same screen -> plane mapping (mb_internal.h:screenDelta), rotation
//     included, with the half-pixel centring term;
//   · the same escape test (|z|^2 > 2^32, i.e. radius 2^16) evaluated at the
//     *top* of the loop, so `n` counts completed steps;
//   · the same derivative recurrence 2*z*dz (+1 for Mandelbrot);
//   · the same smooth-iteration form  n - log2(log2(|z|^2));
//   · the same analytic cardioid / period-2 interior, which is what makes the
//     home frame cheap on both sides.
//
// Anything the kernel cannot reproduce exactly — the Brent cycle finder for
// higher-order bulbs, the arbitrary-precision perturbation path — is left to
// the CPU and reported as such.
// ---------------------------------------------------------------------------
#include "cl_field.h"

#include "cl_api.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>

namespace {

const char* kKernel = R"CLC(
#pragma OPENCL EXTENSION cl_khr_fp64 : enable

#define BAIL2 4294967296.0   /* (2^16)^2, the CPU core's escape radius squared */

typedef struct { double x, y; } d2;

static inline d2 cmul(d2 a, d2 b) {
  /* Split into two-operand statements for the same reason as the main loop:
   * `a.x*b.x - a.y*b.y` in one statement may be contracted into an FMA, which
   * rounds once instead of twice. */
  const double p1 = a.x * b.x;
  const double p2 = a.y * b.y;
  const double p3 = a.x * b.y;
  const double p4 = a.y * b.x;
  d2 r;
  r.x = p1 - p2;
  r.y = p3 + p4;
  return r;
}

/* z -> z^p by binary exponentiation, the same routine mb_internal.h:cpow uses.
 * Polar form would need atan2+pow per iteration and is measurably slower for
 * the small exponents the product ships. */
static inline d2 cpowi(d2 z, int p) {
  d2 r; r.x = 1.0; r.y = 0.0;
  d2 b = z;
  int e = p;
  while (e > 0) {
    if (e & 1) r = cmul(r, b);
    b = cmul(b, b);
    e >>= 1;
  }
  return r;
}

/* Analytic interior of z^2+c: main cardioid and period-2 disc.  Transcribed
 * from mb_internal.h:interiorPeriod so the two engines agree bit for bit on
 * which pixels are interior. */
static inline int interior_period(double cr, double ci) {
  const double x = cr - 0.25;
  const double y2 = ci * ci;
  const double q = x * x + y2;
  if (q * (q + x) <= 0.25 * y2) return 1;
  const double u = cr + 1.0;
  if ((u * u + y2) <= 0.0625) return 2;
  return 0;
}

__kernel void mb_field(__global float4* out,
                       const int tw, const int th,
                       const int ox, const int oy,
                       const int fw, const int fh,
                       const double cre, const double cim,
                       const double pixsize,
                       const double rotc, const double rots,
                       const int julia, const double jre, const double jim,
                       const int power, const int maxIter, const int wantDist)
{
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  if (x >= tw || y >= th) return;

  /* screenDelta(): half-pixel centring, y measured downwards on screen and
   * upwards on the plane.  Each step is its own statement so nothing can be
   * contracted — the reference evaluates exactly this sequence. */
  const double fx = (double)(ox + x);
  const double fy = (double)(oy + y);
  const double halfW = 0.5 * (double)fw;
  const double halfH = 0.5 * (double)fh;
  const double ax = fx + 0.5;
  const double bx = ax - halfW;
  const double sx = bx * pixsize;
  const double ay = halfH - fy;
  const double by = ay - 0.5;
  const double sy = by * pixsize;
  const double dr1 = sx * rotc;
  const double dr2 = sy * rots;
  const double dr = dr1 - dr2;
  const double di1 = sx * rots;
  const double di2 = sy * rotc;
  const double di = di1 + di2;

  double cr, ci, zr, zi, derr, deri;
  if (julia) {
    cr = jre; ci = jim;
    zr = cre + dr; zi = cim + di;
    derr = 1.0; deri = 0.0;
  } else {
    cr = cre + dr; ci = cim + di;
    zr = 0.0; zi = 0.0;
    derr = 0.0; deri = 0.0;
  }

  if (!julia && power == 2) {
    const int per = interior_period(cr, ci);
    if (per) {
      out[(size_t)y * tw + x] = (float4)(-(float)per, 0.0f, -(float)per, 0.0f);
      return;
    }
  }

  int n = 0;
  double m2 = 0.0;
  double pzr = zr, pzi = zi;
  for (; n < maxIter; ++n) {
    /* Every step is split into explicit two-operand statements.  A compiler is
     * allowed to contract `a*b + c` into one fused rounding *within a single
     * statement*; across statements it is not.  Splitting them therefore makes
     * the kernel round exactly once per operation — the same function the CPU
     * reference evaluates — which is what makes a bit-for-bit comparison
     * possible at all.  A chaotic orbit diverges from a one-ulp difference
     * within a few hundred iterations, so "close enough" is not a thing here. */
    const double zr2 = zr * zr;
    const double zi2 = zi * zi;
    const double m2v = zr2 + zi2;
    m2 = m2v;
    if (m2 > BAIL2) break;
    if (wantDist) {
      const double dr1 = zr * derr;
      const double dr2 = zi * deri;
      const double di1 = zr * deri;
      const double di2 = zi * derr;
      const double t = dr1 - dr2;
      const double s2 = di1 + di2;
      const double tw = t + t;
      const double s2w = s2 + s2;
      derr = tw + (julia ? 0.0 : 1.0);
      deri = s2w;
    }
    pzr = zr; pzi = zi;
    if (power == 2) {
      const double re = zr2 - zi2;
      const double im = zr * zi;
      zr = re + cr;
      zi = (im + im) + ci;
    } else {
      d2 zz; zz.x = zr; zz.y = zi;
      d2 p = cpowi(zz, power);
      zr = p.x + cr;
      zi = p.y + ci;
    }
  }

  if (n >= maxIter) {
    /* Bounded.  The cardioid/disc test above already named the two dominant
     * bulbs; a fixed point that the orbit has settled on is period 1.  Higher
     * periods need the CPU's Brent finder, and reporting -1 (period unknown)
     * is what the shader treats as "interior, colour it by zero". */
    const double dzr = zr - pzr, dzi = zi - pzi;
    const double d2n = dzr * dzr + dzi * dzi;
    int per = 0;
    if (d2n < 1e-24 * (1.0 + m2)) per = 1;
    /* -0.0 compares as not-negative, and every shader picks the interior
     * colour from `smoothiter < 0`.  A tiny negative value carries "interior,
     * period unknown" so the region still reads as interior. */
    const float enc = per ? -(float)per : -1e-30f;
    out[(size_t)y * tw + x] = (float4)(enc, 0.0f, enc, 0.0f);
    return;
  }

  const double l2 = log2(m2);
  const double nu = (double)n - log2(fmax(l2, 1e-9));
  float dist = 0.0f;
  if (wantDist) {
    const double der2 = derr * derr + deri * deri;
    if (der2 > 0.0) {
      const double pxd = sqrt(m2) * (0.5 * log(m2)) / sqrt(der2) / pixsize;
      if (isfinite(pxd) && pxd > 0.0) dist = (float)pxd;
    }
  }
  /* dist2 is the linear distance to the radius-2 circle; at a 2^16 escape
   * radius its numerator is always negative, which the CPU core also clamps
   * to zero. */
  out[(size_t)y * tw + x] = (float4)((float)nu, dist, (float)n, 0.0f);
}
)CLC";

/* ---------------------------------------------------------------------------
 * The deep-zoom perturbation kernel.
 *
 * Same contract as the scalar core's perturbPixelDeep()/perturbFamDeep(): the
 * host hands in one high-precision reference orbit and its Taylor tables, and
 * each pixel iterates only its deviation
 *
 *     d' = F ( J d + H d^2 + K d^3 + P d_prev ) + dc
 *
 * in the scaled complex type { double mantissa, double mantissa, int exponent }.
 * The exponent is what keeps a 1e-660 pixel pitch alive: dc is built from the
 * exact pair psMant * 2^psExp, and sc_norm() renormalises by powers of two so
 * the mantissa never leaves [1e-120, 1e120].  That is the same representation
 * the CPU kernel uses, which is why the two fields can be diffed.
 *
 * No cycle finder: the CPU's deep scalar kernel does not run one either, so a
 * bounded pixel is written as -1e-30 ("interior, period unknown") on both
 * sides.  A pixel whose index runs past the reference is marked with w = -1
 * and counted; the caller repairs those exactly like the CPU engine does.
 * ------------------------------------------------------------------------- */
const char* kPerturbKernel = R"CLC(
#pragma OPENCL EXTENSION cl_khr_fp64 : enable

#define BAIL2 4294967296.0
#define LN2 0.6931471805599453

typedef struct { double r, i; int e; } sc;

static sc sc_norm(sc a) {
  const double m = fmax(fabs(a.r), fabs(a.i));
  if (!(m > 0.0)) { a.e = 0; return a; }
  if (m >= 1e-120 && m <= 1e120) return a;
  int k = 0;
  frexp(m, &k);
  const double s = ldexp(1.0, -k);
  a.r *= s;
  a.i *= s;
  a.e += k;
  return a;
}

static sc sc_mulc(sc a, double jr, double ji) {
  sc c;
  c.r = a.r * jr - a.i * ji;
  c.i = a.r * ji + a.i * jr;
  c.e = a.e;
  return sc_norm(c);
}

static sc sc_mul(sc a, sc b) {
  sc c;
  c.r = a.r * b.r - a.i * b.i;
  c.i = a.r * b.i + a.i * b.r;
  c.e = a.e + b.e;
  return sc_norm(c);
}

static sc sc_add(sc a, sc b) {
  if (a.r == 0.0 && a.i == 0.0) return b;
  if (b.r == 0.0 && b.i == 0.0) return a;
  const int e = max(a.e, b.e);
  sc c;
  c.r = ldexp(a.r, a.e - e) + ldexp(b.r, b.e - e);
  c.i = ldexp(a.i, a.e - e) + ldexp(b.i, b.e - e);
  c.e = e;
  return sc_norm(c);
}

static void sc_to_d(sc a, double* r, double* i) {
  if (a.e > -900) {
    *r = ldexp(a.r, a.e);
    *i = ldexp(a.i, a.e);
  } else {
    *r = 0.0;
    *i = 0.0;
  }
}

/* A_sk dc + B_sk dc^2 + C_sk dc^3, coefficients in (mantissa, exponent) form. */
static sc series_dev(__global const double* ar, __global const double* ai,
                     __global const double* br, __global const double* bi,
                     __global const double* cr, __global const double* ci,
                     __global const int* aExp, __global const int* bExp,
                     __global const int* cExp, int sk, sc dc) {
  const size_t i = (size_t)sk;
  const double qr = dc.r * dc.r - dc.i * dc.i;
  const double qi = 2.0 * dc.r * dc.i;
  sc l1;
  l1.r = ar[i] * dc.r - ai[i] * dc.i;
  l1.i = ar[i] * dc.i + ai[i] * dc.r;
  l1.e = aExp[i] + dc.e;
  sc l2;
  l2.r = br[i] * qr - bi[i] * qi;
  l2.i = br[i] * qi + bi[i] * qr;
  l2.e = bExp[i] + 2 * dc.e;
  sc c2;
  c2.r = cr[i] * qr - ci[i] * qi;
  c2.i = cr[i] * qi + ci[i] * qr;
  c2.e = cExp[i] + 2 * dc.e;
  sc l3;
  l3.r = c2.r * dc.r - c2.i * dc.i;
  l3.i = c2.r * dc.i + c2.i * dc.r;
  l3.e = c2.e + dc.e;
  return sc_add(sc_add(l1, l2), l3);
}

__kernel void mb_perturb(
    __global float4* out,
    __global const double* re,
    __global const double* im,
    __global const double* ar,
    __global const double* ai,
    __global const double* br,
    __global const double* bi,
    __global const double* cr,
    __global const double* ci,
    __global const int* aExp,
    __global const int* bExp,
    __global const int* cExp,
    __global const double* dcthLog,
    __global const double* jrA,
    __global const double* jiA,
    __global const double* hrA,
    __global const double* hiA,
    __global const double* krA,
    __global const double* kiA,
    __global const char* foldR,
    __global const char* foldI,
    __global int* glitchCount,
    const int refLen,
    const int refSkip,
    const int derSkip,
    const int tw, const int th,
    const int ox, const int oy,
    const int fw, const int fh,
    const double psMant,
    const int psExp,
    const double dRe,
    const double dIm,
    const double rotC, const double rotS,
    const double z0r, const double z0i,
    const int kind, const int power,
    const int maxIter,
    const int dynSkip,
    const int wantDist,
    const double psPixels,
    const double phoenixP,
    const int useFolds) {
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  if (x >= tw || y >= th) return;
  const int idx = (oy + y) * fw + (ox + x);

  const double fx = (double)(ox + x);
  const double fy = (double)(oy + y);
  const double hw = 0.5 * (double)fw;
  const double hh = 0.5 * (double)fh;
  const double ax = fx + 0.5;
  const double bx = ax - hw;
  const double sx = bx * psMant;
  const double ay = hh - fy;
  const double by = ay - 0.5;
  const double sy = by * psMant;
  sc dc;
  dc.r = sx * rotC - sy * rotS;
  dc.i = sx * rotS + sy * rotC;
  dc.e = psExp;
  dc = sc_norm(dc);
  dc.r -= dRe;
  dc.i -= dIm;
  dc = sc_norm(dc);

  /* Constant added each step: burning ship subtracts c, perpendicular
   * conjugates it, everything else adds it. */
  sc cc = dc;
  if (kind == 2) cc.r = -cc.r;
  else if (kind == 4) cc.i = -cc.i;

  /* Dynamic start: |dc| is below the double range, so the threshold table is
   * compared in the log domain. */
  int sk = refSkip;
  if (dynSkip && refSkip > 0 && refLen > 3) {
    const double ad = hypot(dc.r, dc.i);
    const double logAd = ad > 0.0 ? log(ad) + (double)dc.e * LN2 : -1e300;
    int lo = 1, hi = refLen - 2;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if (dcthLog[mid] >= logAd) lo = mid;
      else hi = mid - 1;
    }
    sk = lo;
  }
  const int walkDer = wantDist;
  if (walkDer && sk > derSkip) sk = derSkip;

  sc d;
  int ridx;
  if (sk > 0) {
    d = series_dev(ar, ai, br, bi, cr, ci, aExp, bExp, cExp, sk,
                   kind == 4 ? cc : dc);
    ridx = sk;
  } else {
    d.r = 0.0; d.i = 0.0; d.e = 0;
    ridx = 0;
  }
  sc dPrev;
  dPrev.r = 0.0; dPrev.i = 0.0; dPrev.e = 0;

  double derR = 0.0, derI = 0.0;
  if (walkDer && sk > 0) {
    derR = ar[(size_t)sk];
    derI = ai[(size_t)sk];
  }

  for (int n = ridx; n < maxIter; ++n) {
    if (ridx >= refLen) {
      out[idx] = (float4)(-1e-30f, 0.0f, 0.0f, -1.0f);
      atomic_inc(glitchCount);
      return;
    }
    double Zr = re[(size_t)ridx];
    double Zi = im[(size_t)ridx];
    double dr, di;
    sc_to_d(d, &dr, &di);
    double Z2 = Zr * Zr + Zi * Zi;
    double cross = 2.0 * (Zr * dr + Zi * di);
    double d2 = dr * dr + di * di;
    double m2 = Z2 + cross + d2;
    if (d2 > m2) {
      sc zR; zR.r = Zr; zR.i = Zi; zR.e = 0;
      sc z0; z0.r = -z0r; z0.i = -z0i; z0.e = 0;
      d = sc_add(sc_add(zR, d), z0);
      ridx = 0;
      dPrev.r = 0.0; dPrev.i = 0.0; dPrev.e = 0;
      if (kind == 0 && power == 2) {
        Zr = re[0];
        Zi = im[0];
        sc_to_d(d, &dr, &di);
        Z2 = Zr * Zr + Zi * Zi;
        cross = 2.0 * (Zr * dr + Zi * di);
        d2 = dr * dr + di * di;
        m2 = Z2 + cross + d2;
      } else {
        continue;
      }
    }
    if (m2 > BAIL2) {
      const double rel = Z2 > 0.0 ? (cross + d2) / Z2 : 0.0;
      const double der2 = wantDist ? derR * derR + derI * derI : 0.0;
      const double z2 = m2 / (1.0 + rel);
      const double l2 = log2(fmax(z2, 1e-300)) +
                        log2(fmax(1.0 + rel, 1e-300));
      double nu = (double)n - log2(fmax(l2, 1e-9));
      if (!isfinite(nu)) nu = (double)n;
      double dist = 0.0;
      if (wantDist && psPixels > 0.0 && der2 > 0.0) {
        const double lz = 0.5 * log(fmax(m2 / (1.0 + rel), 1e-300)) +
                          0.5 * log1p(rel);
        dist = sqrt(fmax(m2, 0.0)) * lz / sqrt(der2) / psPixels;
      }
      out[idx] = (float4)((float)nu, (float)dist, (float)n, 0.0f);
      return;
    }

    double jr, ji, hr, hi, kr, ki;
    if (power == 2) {
      jr = 2.0 * Zr; ji = 2.0 * Zi;
      hr = 1.0; hi = 0.0;
      kr = 0.0; ki = 0.0;
    } else {
      jr = jrA[(size_t)ridx]; ji = jiA[(size_t)ridx];
      hr = hrA[(size_t)ridx]; hi = hiA[(size_t)ridx];
      kr = krA[(size_t)ridx]; ki = kiA[(size_t)ridx];
    }

    if (walkDer) {
      const double zrD = Zr + dr;
      const double ziD = Zi + di;
      const double odr = 2.0 * (zrD * derR - ziD * derI) + 1.0;
      const double odi = 2.0 * (zrD * derI + ziD * derR);
      derR = odr;
      derI = odi;
    }

    sc w = sc_mulc(d, jr, ji);
    sc q2 = sc_mul(d, d);
    w = sc_add(w, sc_mulc(q2, hr, hi));
    if (power != 2) {
      sc q3 = sc_mul(q2, d);
      w = sc_add(w, sc_mulc(q3, kr, ki));
    }
    if (kind == 5) w = sc_add(w, sc_mulc(dPrev, phoenixP, 0.0));

    if (useFolds) {
      if (kind == 1) {
        w.i = -w.i;
      } else if (kind == 2) {
        if ((Zr + dr) * (Zi + di) < 0.0) w.i = -w.i;
      } else if (kind == 3) {
        const double qr = dr * dr - di * di;
        if ((Zr * Zr - Zi * Zi) + cross + qr < 0.0) w.r = -w.r;
      }
    }
    if (kind == 5) dPrev = d;
    d = sc_add(w, cc);
    ++ridx;
  }

  out[idx] = (float4)(-1e-30f, 0.0f, -1e-30f, 0.0f);
}
)CLC";


cl_platform_id g_plat = nullptr;
cl_device_id g_dev = nullptr;
cl_context g_ctx = nullptr;
cl_command_queue g_q = nullptr;
cl_program g_prog = nullptr;
cl_kernel g_kernel = nullptr;
cl_program g_progP = nullptr;
cl_kernel g_kernelP = nullptr;
bool g_ready = false;
std::string g_err;
clf::Caps g_caps;
double g_lastMs = 0.0;
std::mutex g_mu;

std::string InfoStr(cl_device_id d, cl_device_info p) {
  size_t n = 0;
  if (clGetDeviceInfo(d, p, 0, nullptr, &n) != CL_SUCCESS || n == 0)
    return std::string();
  std::vector<char> b(n);
  if (clGetDeviceInfo(d, p, n, b.data(), nullptr) != CL_SUCCESS)
    return std::string();
  return std::string(b.data());
}

bool BuildProgram() {
  const char* src = kKernel;
  const size_t len = std::strlen(kKernel);
  cl_int rc = CL_SUCCESS;
  g_prog = clCreateProgramWithSource(g_ctx, 1, &src, &len, &rc);
  if (rc != CL_SUCCESS || !g_prog) {
    g_err = std::string("clCreateProgramWithSource: ") + ocl::lastError();
    return false;
  }
  // No -cl-mad-enable and no -cl-fast-relaxed-math: a fused multiply-add here
  // would round z*z - zi*zi + c once instead of twice, and over a few thousand
  // chaotic iterations that is enough to move pixels across the escape
  // boundary.  Every operation rounds exactly once, which is what makes the
  // kernel comparable to a scalar reference at all.
  rc = clBuildProgram(g_prog, 1, &g_dev, "", nullptr, nullptr);
  if (rc != CL_SUCCESS) {
    size_t n = 0;
    clGetProgramBuildInfo(g_prog, g_dev, CL_PROGRAM_BUILD_LOG, 0, nullptr, &n);
    std::vector<char> log(n + 1, 0);
    clGetProgramBuildInfo(g_prog, g_dev, CL_PROGRAM_BUILD_LOG, n, log.data(),
                          nullptr);
    g_err = std::string("build failed: ") + log.data();
    return false;
  }
  g_kernel = clCreateKernel(g_prog, "mb_field", &rc);
  if (rc != CL_SUCCESS || !g_kernel) {
    g_err = std::string("clCreateKernel: ") + ocl::lastError();
    return false;
  }

  /* The perturbation kernel is optional: a device/driver that cannot build it
   * leaves the direct kernel working, and computePerturb() reports why. */
  const char* psrc = kPerturbKernel;
  const size_t plen = std::strlen(kPerturbKernel);
  g_progP = clCreateProgramWithSource(g_ctx, 1, &psrc, &plen, &rc);
  if (rc != CL_SUCCESS || !g_progP) return true;
  rc = clBuildProgram(g_progP, 1, &g_dev, "", nullptr, nullptr);
  if (rc != CL_SUCCESS) {
    size_t n = 0;
    clGetProgramBuildInfo(g_progP, g_dev, CL_PROGRAM_BUILD_LOG, 0, nullptr, &n);
    std::vector<char> log(n + 1, 0);
    clGetProgramBuildInfo(g_progP, g_dev, CL_PROGRAM_BUILD_LOG, n, log.data(),
                          nullptr);
    g_err = std::string("perturb build failed: ") + log.data();
    clReleaseProgram(g_progP);
    g_progP = nullptr;
    return true;
  }
  g_kernelP = clCreateKernel(g_progP, "mb_perturb", &rc);
  if (rc != CL_SUCCESS || !g_kernelP) {
    g_err = std::string("perturb clCreateKernel: ") + ocl::lastError();
    clReleaseProgram(g_progP);
    g_progP = nullptr;
  }
  return true;
}

}  // namespace

namespace clf {

bool init(void* glContext, void* glDc) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (g_ready) return true;
  if (!ocl::available()) {
    g_err = "no OpenCL device";
    return false;
  }
  const ocl::Caps& c = ocl::capabilities();
  if (!c.ok || !c.deviceId) {
    g_err = "OpenCL probe failed";
    return false;
  }
  if (!c.fp64) {
    g_err = "device has no fp64";
    return false;
  }
  g_plat = c.platformId;
  g_dev = c.deviceId;

  cl_int rc = CL_SUCCESS;
  cl_context_properties props[16];
  int np = 0;
  props[np++] = CL_CONTEXT_PLATFORM;
  props[np++] = (cl_context_properties)g_plat;
  bool interop = false;
  if (glContext && glDc && c.glSharing) {
    props[np++] = CL_GL_CONTEXT_KHR;
    props[np++] = (cl_context_properties)glContext;
    props[np++] = CL_WGL_HDC_KHR;
    props[np++] = (cl_context_properties)glDc;
    interop = true;
  }
  props[np] = 0;
  g_ctx = clCreateContext(props, 1, &g_dev, nullptr, nullptr, &rc);
  if (rc != CL_SUCCESS || !g_ctx) {
    // The interop context can fail even when plain CL works; retry without.
    if (interop) {
      np = 0;
      props[np++] = CL_CONTEXT_PLATFORM;
      props[np++] = (cl_context_properties)g_plat;
      props[np] = 0;
      g_ctx = clCreateContext(props, 1, &g_dev, nullptr, nullptr, &rc);
      interop = false;
    }
    if (rc != CL_SUCCESS || !g_ctx) {
      g_err = std::string("clCreateContext: ") + ocl::lastError();
      return false;
    }
  }
#if defined(CL_VERSION_2_0)
  g_q = clCreateCommandQueueWithProperties(g_ctx, g_dev, nullptr, &rc);
#else
  g_q = clCreateCommandQueue(g_ctx, g_dev, 0, &rc);
#endif
  if (rc != CL_SUCCESS || !g_q) {
    g_err = std::string("clCreateCommandQueue: ") + ocl::lastError();
    return false;
  }
  if (!BuildProgram()) return false;

  g_caps.ok = true;
  g_caps.fp64 = true;
  g_caps.interop = interop;
  g_caps.device = InfoStr(g_dev, CL_DEVICE_NAME);
  g_caps.driver = InfoStr(g_dev, CL_DRIVER_VERSION);
  g_caps.version = InfoStr(g_dev, CL_DEVICE_VERSION);
  cl_uint u = 0;
  clGetDeviceInfo(g_dev, CL_DEVICE_MAX_COMPUTE_UNITS, sizeof(u), &u, nullptr);
  g_caps.computeUnits = (int)u;
  clGetDeviceInfo(g_dev, CL_DEVICE_MAX_CLOCK_FREQUENCY, sizeof(u), &u, nullptr);
  g_caps.clockMHz = (int)u;
  cl_ulong mem = 0;
  clGetDeviceInfo(g_dev, CL_DEVICE_GLOBAL_MEM_SIZE, sizeof(mem), &mem, nullptr);
  g_caps.globalMem = (size_t)mem;
  size_t wg = 0;
  clGetDeviceInfo(g_dev, CL_DEVICE_MAX_WORK_GROUP_SIZE, sizeof(wg), &wg,
                  nullptr);
  g_caps.maxWorkGroup = wg;
  g_ready = true;
  return true;
}

void shutdown() {
  std::lock_guard<std::mutex> lk(g_mu);
  if (g_kernelP) clReleaseKernel(g_kernelP);
  if (g_progP) clReleaseProgram(g_progP);
  if (g_kernel) clReleaseKernel(g_kernel);
  if (g_prog) clReleaseProgram(g_prog);
  if (g_q) clReleaseCommandQueue(g_q);
  if (g_ctx) clReleaseContext(g_ctx);
  g_kernelP = nullptr;
  g_progP = nullptr;
  g_kernel = nullptr;
  g_prog = nullptr;
  g_q = nullptr;
  g_ctx = nullptr;
  g_ready = false;
}

bool ready() { return g_ready; }
const char* lastError() { return g_err.empty() ? "ok" : g_err.c_str(); }
const Caps& caps() { return g_caps; }
double lastMs() { return g_lastMs; }

bool supports(double px, int power) {
  // One double step costs about one bit of precision (the derivative doubles
  // the error every iteration for a chaotic orbit); 2^-40 leaves ~12 bits of
  // margin over the pixel size.  Beyond that the CPU perturbation path is the
  // only correct one.
  if (power < 2 || power > 16) return false;
  const double a = px < 0.0 ? -px : px;
  return a >= 9.094947017729282e-13;   // 2^-40
}

bool compute(const Tile& t, float* out) {
  if (!g_ready || !out) return false;
  if (t.w <= 0 || t.h <= 0) return false;
  const auto t0 = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(g_mu);
  const size_t bytes = (size_t)t.w * (size_t)t.h * 4 * sizeof(float);
  cl_int rc = CL_SUCCESS;
  cl_mem buf = clCreateBuffer(g_ctx, CL_MEM_WRITE_ONLY, bytes, nullptr, &rc);
  if (rc != CL_SUCCESS) {
    g_err = std::string("clCreateBuffer: ") + ocl::lastError();
    return false;
  }
  int i = 0;
  rc = clSetKernelArg(g_kernel, i++, sizeof(cl_mem), &buf);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.w);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.h);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.ox);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.oy);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.fw);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.fh);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.cre);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.cim);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.px);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.rotC);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.rotS);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.julia);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.jre);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(double), &t.jim);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.power);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.maxIter);
  rc |= clSetKernelArg(g_kernel, i++, sizeof(int), &t.wantDist);
  if (rc != CL_SUCCESS) {
    clReleaseMemObject(buf);
    g_err = std::string("clSetKernelArg: ") + ocl::lastError();
    return false;
  }
  const size_t gx = ((size_t)t.w + 15) / 16 * 16;
  const size_t gy = ((size_t)t.h + 15) / 16 * 16;
  const size_t global[2] = {gx, gy};
  const size_t local[2] = {16, 16};
  rc = clEnqueueNDRangeKernel(g_q, g_kernel, 2, nullptr, global, local, 0,
                              nullptr, nullptr);
  if (rc != CL_SUCCESS) {
    clReleaseMemObject(buf);
    g_err = std::string("clEnqueueNDRangeKernel: ") + ocl::lastError();
    return false;
  }
  rc = clEnqueueReadBuffer(g_q, buf, CL_TRUE, 0, bytes, out, 0, nullptr,
                           nullptr);
  clReleaseMemObject(buf);
  if (rc != CL_SUCCESS) {
    g_err = std::string("clEnqueueReadBuffer: ") + ocl::lastError();
    return false;
  }
  g_lastMs = std::chrono::duration<double, std::milli>(
                 std::chrono::steady_clock::now() - t0).count();
  return true;
}

bool supportsPerturb(int kind, int power) {
  if (!g_ready || !g_kernelP) return false;
  if (kind == 0) return power >= 2 && power <= 8;
  if (kind >= 1 && kind <= 4) return power == 2;
  if (kind == 5) return power == 2;
  return false;
}

namespace {

/* Upload `count` elements of `elem` bytes, or a single zero element when the
 * table is not used by this map.  Some drivers reject a null kernel argument,
 * so "absent" is uploaded as a valid one-element buffer instead. */
cl_mem Upload(const void* p, size_t count, size_t elem,
              std::vector<cl_mem>& keep) {
  static const double kZero[2] = {0.0, 0.0};
  const size_t bytes = count ? count * elem : sizeof(kZero);
  cl_int rc = CL_SUCCESS;
  cl_mem b = clCreateBuffer(g_ctx, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR,
                            bytes, const_cast<void*>(count ? p
                                                           : (const void*)kZero),
                            &rc);
  if (rc == CL_SUCCESS) keep.push_back(b);
  return rc == CL_SUCCESS ? b : nullptr;
}

}  // namespace

bool computePerturb(const PerturbTile& t, float* out, int* glitches) {
  if (!g_ready || !g_kernelP || !out) return false;
  if (t.w <= 0 || t.h <= 0 || t.orbit.len <= 0 || !t.orbit.re || !t.orbit.im)
    return false;
  if (!supportsPerturb(t.kind, t.power)) {
    g_err = "perturbation kernel unavailable for this map";
    return false;
  }
  const auto t0 = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(g_mu);
  std::vector<cl_mem> keep;
  keep.reserve(24);
  const size_t n = (size_t)t.orbit.len;
  const size_t outBytes = (size_t)t.w * (size_t)t.h * 4 * sizeof(float);
  cl_int rc = CL_SUCCESS;
  cl_mem buf = clCreateBuffer(g_ctx, CL_MEM_WRITE_ONLY, outBytes, nullptr, &rc);
  if (rc != CL_SUCCESS) {
    g_err = std::string("clCreateBuffer: ") + ocl::lastError();
    return false;
  }
  keep.push_back(buf);
  cl_mem gbuf = clCreateBuffer(g_ctx, CL_MEM_READ_WRITE, sizeof(cl_int),
                               nullptr, &rc);
  if (rc != CL_SUCCESS) {
    for (cl_mem m : keep) clReleaseMemObject(m);
    g_err = std::string("clCreateBuffer: ") + ocl::lastError();
    return false;
  }
  keep.push_back(gbuf);
  const cl_int zero = 0;
  clEnqueueWriteBuffer(g_q, gbuf, CL_TRUE, 0, sizeof(cl_int), &zero, 0, nullptr,
                       nullptr);

  const clf::OrbitView& o = t.orbit;
  struct Src {
    const void* p;
    size_t count;
    size_t elem;
  };
  const Src srcs[] = {
      {o.re, n, sizeof(double)},     {o.im, n, sizeof(double)},
      {o.ar, n, sizeof(double)},     {o.ai, n, sizeof(double)},
      {o.br, n, sizeof(double)},     {o.bi, n, sizeof(double)},
      {o.cr, n, sizeof(double)},     {o.ci, n, sizeof(double)},
      {o.aExp, n, sizeof(int)},      {o.bExp, n, sizeof(int)},
      {o.cExp, n, sizeof(int)},      {o.dcthLog, n, sizeof(double)},
      {o.jr, n, sizeof(double)},     {o.ji, n, sizeof(double)},
      {o.hr, n, sizeof(double)},     {o.hi, n, sizeof(double)},
      {o.kr, n, sizeof(double)},     {o.ki, n, sizeof(double)},
      {o.fR, n, sizeof(signed char)}, {o.fI, n, sizeof(signed char)},
  };
  std::vector<cl_mem> orbitBufs;
  orbitBufs.reserve(20);
  for (const Src& s : srcs) {
    cl_mem b = Upload(s.p, s.p ? s.count : 0, s.elem, keep);
    if (!b) {
      for (cl_mem m : keep) clReleaseMemObject(m);
      g_err = std::string("clCreateBuffer(orbit): ") + ocl::lastError();
      return false;
    }
    orbitBufs.push_back(b);
  }

  int ai = 0;
  auto arg = [&](size_t bytes, const void* p) {
    if (rc == CL_SUCCESS)
      rc = clSetKernelArg(g_kernelP, ai++, bytes, p);
  };
  arg(sizeof(cl_mem), &buf);
  for (cl_mem b : orbitBufs) arg(sizeof(cl_mem), &b);
  arg(sizeof(cl_mem), &gbuf);
  const int refLen = t.orbit.len;
  const int refSkip = t.orbit.skip;
  const int derSkip = t.orbit.derSkip;
  const int tw = t.w, th = t.h, ox = t.ox, oy = t.oy;
  const int fw = t.fw, fh = t.fh;
  const int psExp = t.psExp;
  const double dRe = t.dRe, dIm = t.dIm;
  const double z0r = t.orbit.z0r, z0i = t.orbit.z0i;
  const int kind = t.kind, power = t.power, maxIter = t.maxIter;
  const int dynSkip = t.dynSkip, wantDist = t.wantDist;
  const double phoenixP = t.phoenixP;
  const int useFolds = (t.kind >= 1 && t.kind <= 3) ? 1 : 0;
  arg(sizeof(int), &refLen);
  arg(sizeof(int), &refSkip);
  arg(sizeof(int), &derSkip);
  arg(sizeof(int), &tw);
  arg(sizeof(int), &th);
  arg(sizeof(int), &ox);
  arg(sizeof(int), &oy);
  arg(sizeof(int), &fw);
  arg(sizeof(int), &fh);
  arg(sizeof(double), &t.psMant);
  arg(sizeof(int), &psExp);
  arg(sizeof(double), &dRe);
  arg(sizeof(double), &dIm);
  arg(sizeof(double), &t.rotC);
  arg(sizeof(double), &t.rotS);
  arg(sizeof(double), &z0r);
  arg(sizeof(double), &z0i);
  arg(sizeof(int), &kind);
  arg(sizeof(int), &power);
  arg(sizeof(int), &maxIter);
  arg(sizeof(int), &dynSkip);
  arg(sizeof(int), &wantDist);
  arg(sizeof(double), &t.psPixels);
  arg(sizeof(double), &phoenixP);
  arg(sizeof(int), &useFolds);
  if (rc != CL_SUCCESS) {
    for (cl_mem m : keep) clReleaseMemObject(m);
    g_err = std::string("clSetKernelArg: ") + ocl::lastError();
    return false;
  }
  const size_t gx = ((size_t)t.w + 15) / 16 * 16;
  const size_t gy = ((size_t)t.h + 15) / 16 * 16;
  const size_t global[2] = {gx, gy};
  const size_t local[2] = {16, 16};
  rc = clEnqueueNDRangeKernel(g_q, g_kernelP, 2, nullptr, global, local, 0,
                              nullptr, nullptr);
  if (rc == CL_SUCCESS)
    rc = clEnqueueReadBuffer(g_q, buf, CL_TRUE, 0, outBytes, out, 0, nullptr,
                             nullptr);
  cl_int gl = 0;
  if (rc == CL_SUCCESS)
    rc = clEnqueueReadBuffer(g_q, gbuf, CL_TRUE, 0, sizeof(cl_int), &gl, 0,
                             nullptr, nullptr);
  for (cl_mem m : keep) clReleaseMemObject(m);
  if (rc != CL_SUCCESS) {
    g_err = std::string("perturb enqueue: ") + ocl::lastError();
    return false;
  }
  if (glitches) *glitches = (int)gl;
  g_lastMs = std::chrono::duration<double, std::milli>(
                 std::chrono::steady_clock::now() - t0).count();
  return true;
}

}  // namespace clf
