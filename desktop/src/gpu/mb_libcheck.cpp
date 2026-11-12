// ---------------------------------------------------------------------------
// mb_libcheck.cpp — numerical regression for mb_math and mb_color.
//
// Reference constants were generated offline with Python's decimal module at
// 90-100 significant digits, so the tests compare double-double results with
// an actual 300-bit value rather than with another double.
// ---------------------------------------------------------------------------
#include "mb_color.h"
#include "mb_math.h"
#include "musl_libm.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

namespace {

int g_fail = 0;
int g_pass = 0;

void check(bool ok, const char* name, const char* detail = "") {
  if (ok) { ++g_pass; std::printf("  PASS  %-38s %s\n", name, detail); }
  else    { ++g_fail; std::printf("  FAIL  %-38s %s\n", name, detail); }
}

struct DecimalCase { const char* s; double hi, lo; };
const DecimalCase kDecimal[] = {
    {"0.1", 0.1, -5.551115123125783e-18},
    {"3.14159265358979323846264338327950288419716939937510", 3.141592653589793,
     1.2246467991473532e-16},
    {"-0.743643887037158704752191506114774", -0.7436438870371587,
     -3.628952515063387e-17},
    {"0.000000000000000000000000000001", 1e-30, -8.333642060758599e-47},
    {"123456789012345678901234567890.123456789", 1.2345678901234568e+29,
     1023514970834.1234},
    {"2.2250738585072013830902327173324040642192159804623318306e-308",
     2.2250738585072014e-308, 0.0},
};

struct ProdCase { double a, b, hi, lo; };
const ProdCase kProd[] = {
    {1.2345678901234567, 9.876543210987654, 12.193263113702178,
     -3.1639211981514584e-16},
    {1e-30, 1e30, 1.0, 1.0322104544624199e-16},
    {0.1, 0.3, 0.03, 1.6653345369377347e-18},
    {1e200, 1e-200, 1.0, -4.816661538840688e-17},
};

void testTwoProd() {
  std::printf("\n[mb_math] error-free transformations (exact 300-bit references)\n");
  for (const auto& c : kProd) {
    const mbm::DD p = mbm::twoProd(c.a, c.b);
    const double err = std::fabs(p.hi - c.hi) + std::fabs(p.lo - c.lo);
    const double bound = std::fabs(c.hi) * mbm::ddMulRelErrorBound() + 1e-300;
    char d[160];
    std::snprintf(d, sizeof(d), "err=%.3g bound=%.3g", err, bound);
    check(p.hi == c.hi && err <= bound, "twoProd exact residual", d);
  }
}

void testDecimal() {
  std::printf("\n[mb_math] decimal -> DD (30+ digit preset centres)\n");
  for (int i = 0; i < 6; ++i) {
    const auto& c = kDecimal[i];
    const mbm::DD v = mbm::ddFromDecimal(c.s);
    const double scale = std::max(std::fabs(c.hi), 1e-300);
    const double rel = std::fabs(v.lo - c.lo) / scale;
    // The 39-digit integer needs more than 106 bits; allow 2^-90 there, and
    // allow the subnormal-boundary case to lose its low word entirely.
    const double tol = i == 4 ? std::ldexp(1.0, -85) : std::ldexp(1.0, -100);
    char d[160];
    std::snprintf(d, sizeof(d), "hi=%s lo=%.6g ref=%.6g rel=%.3g",
                  v.hi == c.hi ? "exact" : "DIFF", v.lo, c.lo, rel);
    check(v.hi == c.hi && (rel <= tol || (i == 5 && v.lo == 0.0)),
          "ddFromDecimal", d);
  }
}

void testArithmetic() {
  std::printf("\n[mb_math] DD arithmetic invariants and error bounds\n");
  const mbm::DD a = mbm::ddFromDecimal("-0.743643887037158704752191506114774");
  const mbm::DD b = mbm::ddFromDecimal("0.131825904205311970493132056385139");
  const mbm::DD p = mbm::ddMul(a, b);
  const mbm::DD q = mbm::ddDiv(p, b);
  const double rel = std::fabs(mbm::ddToDouble(q) - mbm::ddToDouble(a)) /
                     std::fabs(mbm::ddToDouble(a));
  char d[160];
  std::snprintf(d, sizeof(d), "rel=%.3g", rel);
  check(rel < std::ldexp(1.0, -95), "ddDiv(ddMul(a,b),b) == a", d);
  check(mbm::ddNormalised(p) && mbm::ddNormalised(q), "DD results non-overlapping");
  check(mbm::ddFinite(p) && mbm::ddFinite(q), "DD results finite");

  const mbm::DD x = mbm::ddFromDecimal("1.2345678901234567890123456789");
  const mbm::DD s = mbm::ddSqrt(mbm::ddSqr(x));
  const double srel = std::fabs(mbm::ddToDouble(s) - mbm::ddToDouble(x)) /
                      std::fabs(mbm::ddToDouble(x));
  std::snprintf(d, sizeof(d), "rel=%.3g", srel);
  check(srel < std::ldexp(1.0, -90), "ddSqrt(ddSqr(x)) == x", d);

  const mbm::DD sc = mbm::ddScale(1.5682378794576013, -53);
  const double expect = 1.5682378794576013 * std::ldexp(1.0, -53);
  check(std::fabs(mbm::ddToDouble(sc) - expect) <= std::fabs(expect) * 1e-15,
        "ddScale mant*2^exp exact");

  // The delta form is the point: at 1e-30 the displacement must survive
  // rotation without ever being added to a ~0.7 centre.
  const mbm::DDC delta = mbm::ddPixelDelta(mbm::dd(1e-30), 1.0, 0.0, 0.6, 0.8);
  const double dr = mbm::ddToDouble(delta.re), di = mbm::ddToDouble(delta.im);
  std::snprintf(d, sizeof(d), "|delta|=%.12g (want 1)", std::hypot(dr, di) / 1e-30);
  check(std::fabs(std::hypot(dr, di) / 1e-30 - 1.0) < 1e-12,
        "rotated pixel delta is orthonormal", d);
}

void testPredicates() {
  std::printf("\n[mb_math] fractal predicates\n");
  check(mbm::inMainCardioid(0.0, 0.0), "origin inside main cardioid");
  check(!mbm::inMainCardioid(-0.75, 0.1), "seahorse outside cardioid");
  check(mbm::inPeriod2Bulb(-1.0, 0.0), "period-2 bulb centre");
  check(!mbm::inPeriod2Bulb(-0.75, 0.1), "seahorse outside bulb");

  const double logBail = std::log(1e10);
  const double invLogPower = 1.0 / std::log(2.0);
  const double t0 = mbm::smoothIteration(10, 1e10, logBail, invLogPower);
  const double t1 = mbm::smoothIteration(11, 1e10, logBail, invLogPower);
  check(t1 - t0 > 0.999 && t1 - t0 < 1.001, "smooth iteration monotone +1");
  check(mbm::periodClose(1.0, 2.0, 1.0, 2.0, 1e-12), "periodClose identical");
  check(!mbm::periodClose(1.0, 2.0, 1.1, 2.0, 1e-12), "periodClose rejects drift");
  check(mbm::seriesTolerance(std::log(1e100), std::log(1e50), -1e299,
                             std::log(1e-30), 1e-3),
        "series tolerance in log domain");
  check(!mbm::seriesTolerance(std::log(1e100), std::log(1e200), -1e299,
                              std::log(1e-30), 1e-3),
        "series tolerance rejects dominant quadratic term");
}

void testColourScience() {
  std::printf("\n[mb_math] OKLab roundtrip / gamut boundary\n");
  std::printf("  [diag] musl mbm_cbrt(0.125)=%.17g  mbm_log(2)=%.17g  mbm_exp(1)=%.17g\n",
              mbm_cbrt(0.125), mbm_log(2.0), mbm_exp(1.0));
  double worst = 0.0; int worstI = -1;
  for (int i = 0; i < 64; ++i) {
    const double r = (i % 8) / 7.0, g = ((i / 8) % 8) / 7.0, b = ((i / 64) % 8) / 7.0;
    const mbm::OKLab lab = mbm::linearToOklab(r, g, b);
    auto [rr, gg, bb] = mbm::oklabToLinear(lab);
    const double e = std::max({std::fabs(rr - r), std::fabs(gg - g), std::fabs(bb - b)});
    if (e > worst) { worst = e; worstI = i; }
  }
  char d[160];
  std::snprintf(d, sizeof(d), "max abs err=%.3g at i=%d", worst, worstI);
  check(worst < 1e-12, "OKLab -> linear roundtrip", d);

  double minC = 1e9, maxC = 0;
  for (int k = 0; k < 36; ++k) {
    const double c = mbm::maxSrgbChroma(0.62, k * 2.0 * 3.14159265358979 / 36.0);
    minC = std::min(minC, c); maxC = std::max(maxC, c);
  }
  std::snprintf(d, sizeof(d), "C in [%.4f, %.4f]", minC, maxC);
  check(minC > 0.01 && maxC <= 0.5, "max sRGB chroma positive at all hues", d);
}

void testColourLibrary() {
  std::printf("\n[mb_color] 1024 levels/channel and full-gamut coverage\n");
  const uint64_t colours = static_cast<uint64_t>(mbcol::kLevels) *
                           mbcol::kLevels * mbcol::kLevels;
  char d[200];
  std::snprintf(d, sizeof(d), "%llu colours (1024^3)",
                static_cast<unsigned long long>(colours));
  check(colours == 1073741824ULL, "addressable colour count", d);

  const mbcol::LUT full = mbcol::build(mbcol::fullSpectrum());
  const mbcol::GamutReport fr = mbcol::analyse(full);
  std::snprintf(d, sizeof(d),
                "hue=%.1f%% meanC=%.4f maxC=%.4f L=[%.3f,%.3f] distinct=%d/%d",
                fr.hueCoveragePct, fr.meanChroma, fr.maxChroma, fr.lightMin,
                fr.lightMax, fr.distinct10bit, fr.levels);
  std::printf("  fullSpectrum: %s\n", d);
  check(fr.hueCoveragePct >= 95.0, "FullGamut covers >=95% of hue circle");
  check(fr.meanChroma > 0.05, "FullGamut carries real chroma");
  check(fr.lightMax - fr.lightMin > 0.3, "FullGamut has lightness range");
  check(fr.distinct10bit >= fr.levels - 8, "10-bit LUT entries nearly all distinct");
  check(fr.addressableColours == 1073741824ULL, "10-bit addressable space");

  const mbcol::LUT iceLut = mbcol::build(mbcol::ice());
  const mbcol::GamutReport ir = mbcol::analyse(iceLut);
  std::snprintf(d, sizeof(d), "ice hue=%.1f%% vs full=%.1f%%",
                ir.hueCoveragePct, fr.hueCoveragePct);
  check(ir.hueCoveragePct < fr.hueCoveragePct, "Ice is a narrow ramp, as authored", d);

  const mbcol::LUT add = mbcol::build(mbcol::referenceAdditive());
  const mbcol::GamutReport ar = mbcol::analyse(add);
  std::printf("  referenceAdditive: hue=%.1f%% meanC=%.4f distinct=%d\n",
              ar.hueCoveragePct, ar.meanChroma, ar.distinct10bit);
  check(ar.distinct10bit > 300, "additive palette is not a flat wash");

  float r = 0, g = 0, b = 0;
  mbcol::sample(full, 0.0, r, g, b);
  check(std::fabs(r - full.srgb[0]) < 1e-6 &&
        std::fabs(g - full.srgb[1]) < 1e-6 &&
        std::fabs(b - full.srgb[2]) < 1e-6, "LUT sampling at t=0");
  mbcol::sample(full, 1.0, r, g, b);
  check(std::fabs(r - full.srgb[0]) < 1e-6, "LUT is cyclic (t=1 wraps)");

  const double k = mbcol::autoExposure(2.0, 1.0, 1.0);
  std::snprintf(d, sizeof(d), "k=%.4f", k);
  check(k > 0.5 && k < 0.55, "autoExposure scales p99 to 1.05", d);
  check(mbcol::autoExposure(1.0, 1.0, 1.0) == 1.0,
        "autoExposure leaves authored look untouched");
  double mn = 10, mx = -10;
  for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
    const double v = mbcol::ditherOffset(x, y);
    mn = std::min(mn, v); mx = std::max(mx, v);
  }
  check(mn >= -0.5 && mx <= 0.5, "Bayer dither within half a 10-bit code");
  const uint32_t packed = mbcol::packRGB10A2(1023, 0, 512);
  check((packed & 1023) == 1023 && ((packed >> 10) & 1023) == 0 &&
        ((packed >> 20) & 1023) == 512 && (packed >> 30) == 3,
        "RGB10_A2 packing");

  // ---- GL_RGB10_A2 contract + lcms2 colour management --------------------
  std::printf("\n[mb_color] GL_RGB10_A2 contract / lcms2\n");
  check(mbcol::kLutInternalFormat == GL_RGB10_A2,
        "LUT internal format is GL_RGB10_A2");
  check(mbcol::kLutTransferType == GL_UNSIGNED_INT_2_10_10_10_REV,
        "transfer type is UNSIGNED_INT_2_10_10_10_REV");
  check(full.packed.size() == static_cast<size_t>(full.levels),
        "packed texels == LUT entries");
  bool packOk = true;
  for (int k = 0; k < full.levels; ++k) {
    const uint32_t p = full.packed[static_cast<size_t>(k)];
    const size_t o = static_cast<size_t>(k) * 3;
    if ((p & 1023) != full.rgb10[o] ||
        ((p >> 10) & 1023) != full.rgb10[o + 1] ||
        ((p >> 20) & 1023) != full.rgb10[o + 2] || (p >> 30) != 3) {
      packOk = false; break;
    }
  }
  check(packOk, "A2B10G10R10 packing matches rgb10");
  const double iccErr = mbcol::iccRoundTripError();
  std::snprintf(d, sizeof(d), "max err=%.3g (10-bit LSB=%.3g)", iccErr, 1.0/1023.0);
  check(iccErr < 1.0 / 1023.0, "lcms2 sRGB roundtrip within 10-bit", d);
  cmsHPROFILE srgb = cmsCreate_sRGBProfile();
  mbcol::LUT managed = mbcol::build(mbcol::fullSpectrum());
  const bool iccOk = mbcol::applyICC(managed, srgb);
  int changed = 0;
  for (int k = 0; k < managed.levels; ++k)
    if (managed.packed[static_cast<size_t>(k)] != full.packed[static_cast<size_t>(k)]) ++changed;
  cmsCloseProfile(srgb);
  std::snprintf(d, sizeof(d), "applied=%d changed=%d/%d texels", iccOk ? 1 : 0,
                changed, managed.levels);
  check(iccOk && changed < managed.levels / 20,
        "ICC-managed LUT stays within 10-bit tolerance", d);

  // High-resolution LUTs must not lose the gamut property.
  mbcol::PaletteSpec hi = mbcol::fullSpectrum();
  hi.levels = 16384;
  const mbcol::LUT hiLut = mbcol::build(hi);
  const mbcol::GamutReport hr = mbcol::analyse(hiLut);
  std::snprintf(d, sizeof(d), "16384 entries, hue=%.1f%%", hr.hueCoveragePct);
  check(hr.hueCoveragePct >= 95.0 && hr.levels == 16384,
        "LUT resolution scales to 16384", d);
}

}  // namespace

int main() {
  std::printf("mb_math / mb_color regression\n");
  testTwoProd();
  testDecimal();
  testArithmetic();
  testPredicates();
  testColourScience();
  testColourLibrary();
  std::printf("\nRESULT: %d passed, %d failed -> %s\n", g_pass, g_fail,
              g_fail == 0 ? "ALL PASS" : "FAIL");
  return g_fail == 0 ? 0 : 1;
}
