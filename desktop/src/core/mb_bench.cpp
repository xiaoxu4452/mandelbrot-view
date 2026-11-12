// ------------------------------------------------------------------
// mb_bench — render one frame to a BMP and print timings.
//
//     mb_bench out.bmp W H centerRe centerIm spanMant spanExp iter [palette [mode]]
//
//   palette  index into mbc::builtinPalette() (0 = Ice, 1 = Retina, ...)
//   mode     0 Smooth  1 Iteration  2 Distance  3 Distance+levels
//
// It exists so a frame can be inspected (and diffed against the web build's
// output) without running the window: the engine is the same code the shell
// calls, so what comes out here is what the screen shows.
// ------------------------------------------------------------------
#include "mb_boost.h"
#include "mb_core.h"
#include "mb_mpf.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

void writeBmp(const char* path, const std::vector<uint8_t>& rgba, int w, int h) {
  FILE* f = std::fopen(path, "wb");
  if (!f) return;
  const int rowBytes = w * 3 + ((4 - (w * 3) % 4) % 4);
  const int fsize = 54 + rowBytes * h;
  uint8_t hdr[54] = {0};
  hdr[0] = 'B';
  hdr[1] = 'M';
  std::memcpy(hdr + 2, &fsize, 4);
  int v = 54;
  std::memcpy(hdr + 10, &v, 4);
  v = 40;
  std::memcpy(hdr + 14, &v, 4);
  std::memcpy(hdr + 18, &w, 4);
  std::memcpy(hdr + 22, &h, 4);
  uint16_t one = 1;
  std::memcpy(hdr + 26, &one, 2);
  uint16_t bpp = 24;
  std::memcpy(hdr + 28, &bpp, 2);
  std::fwrite(hdr, 1, 54, f);
  std::vector<uint8_t> row((size_t)rowBytes, 0);
  for (int y = h - 1; y >= 0; --y) {
    const uint8_t* p = rgba.data() + (size_t)y * (size_t)w * 4;
    for (int x = 0; x < w; ++x) {
      row[(size_t)x * 3 + 0] = p[(size_t)x * 4 + 2];
      row[(size_t)x * 3 + 1] = p[(size_t)x * 4 + 1];
      row[(size_t)x * 3 + 2] = p[(size_t)x * 4 + 0];
    }
    std::fwrite(row.data(), 1, (size_t)rowBytes, f);
  }
  std::fclose(f);
}

}  // namespace

int main(int argc, char** argv) {
  if (std::getenv("MB_PREC_TEST")) {
    std::string log;
    const bool ok = mbc::precisionSelfTest(log);
    std::printf("[prec] %s\n", ok ? "ALL PASS" : "FAILURES");
    return ok ? 0 : 1;
  }
  if (std::getenv("MB_BOOSTCHECK")) {
    std::string log;
    const bool ok = mbc::boostSelfTest(log);
    std::printf("%s", log.c_str());
    return ok ? 0 : 1;
  }
  if (argc < 9) {
    std::printf(
        "usage: %s out.bmp W H centerRe centerIm spanMant spanExp iter [palette [mode [bands [cycle [kind [power [aa [juliaRe juliaIm]]]]]]]]\n",
        argv[0]);
    return 2;
  }
  const char* outPath = argv[1];
  const int W = std::atoi(argv[2]);
  const int H = std::atoi(argv[3]);
  const std::string cre = argv[4];
  const std::string cim = argv[5];
  const double mant = std::atof(argv[6]);
  const int sexp = std::atoi(argv[7]);
  const int iter = std::atoi(argv[8]);
  const int palId = argc > 9 ? std::atoi(argv[9]) : 0;
  const int mode = argc > 10 ? std::atoi(argv[10]) : 0;
  const int bands = argc > 11 ? std::atoi(argv[11]) : 0;
  const double cycle = argc > 12 ? std::atof(argv[12]) : 0.0;
  const int kind = argc > 13 ? std::atoi(argv[13]) : 0;
  const int power = argc > 14 ? std::atoi(argv[14]) : 2;
  const int aa = argc > 15 ? std::max(1, std::atoi(argv[15])) : 1;
  const bool julia = argc > 17;
  const std::string jre = julia ? argv[16] : std::string();
  const std::string jim = julia ? argv[17] : std::string();

  std::vector<uint8_t> img((size_t)W * (size_t)H * 4, 0);

  mbc::Engine engine(0);
  mbc::Request q;
  q.centerRe = cre;
  q.centerIm = cim;
  q.spanMant = mant;
  q.spanExp = sexp;
  q.width = W;
  q.height = H;
  q.viewWidth = W;
  q.viewHeight = H;
  q.maxIter = iter;
  q.colorMode = mode;
  q.bands = bands;
  q.cycle = cycle;
  q.pal = &mbc::builtinPalette(palId);
  q.spec.kind = kind;
  q.spec.power = power;
  q.aa = aa;
  /* MB_FIELDDIST_OFF=1 measures what a shader that declares no DIST/DIST2
   * channel saves: the derivative recurrence is skipped per pixel. */
  if (std::getenv("MB_FIELDDIST_OFF")) q.fieldDist = false;
  /* MB_FIELDVALUE=1 asks for the two VALUE channels (z at the escape
   * point) that the "Texture" colour scheme samples. */
  if (std::getenv("MB_FIELDVALUE")) q.fieldValue = true;
  /* MB_TRAPS=1..4 selects an orbit trap for the field's fourth channel. */
  if (const char* tr = std::getenv("MB_TRAPS")) q.traps = std::atoi(tr);
  int qualityFixed = 0;
  if (const char* qv = std::getenv("MB_QUALITY")) qualityFixed = std::atoi(qv);
  q.quality = qualityFixed;
  if (const char* dv = std::getenv("MB_DETAIL")) q.detail = std::max(0, std::min(3, std::atoi(dv)));
  if (julia) {
    q.spec.mode = 1;
    q.spec.juliaReS = jre;
    q.spec.juliaImS = jim;
    q.spec.juliaRe = std::atof(jre.c_str());
    q.spec.juliaIm = std::atof(jim.c_str());
  }

  /* MB_FIELD_AB=1 — regression test for the shell's direct-to-shared-buffer
   * field pass.
   *
   * The shell used to allocate a w*h*4 float vector, let the kernel fill it,
   * then memcpy the whole thing into a WebView2 shared buffer.  It now adopts
   * that buffer and the kernel writes into it directly.  This test renders the
   * same request through both backings and compares every float, then reports
   * the allocation / zero-fill / memcpy costs that disappeared.
   *
   * The two *render* times are not a speed comparison: the second render may
   * reuse the cached reference orbit.  The number that matters is identical
   * bits plus the deterministic overhead that is no longer paid. */
  if (std::getenv("MB_FIELD_AB")) {
    const size_t n = (size_t)W * (size_t)H * 4;
    const size_t bytes = n * sizeof(float);
    std::vector<float> external(n, -12345.0f);
    std::vector<float> published(n, -12345.0f);

    const auto a0 = std::chrono::steady_clock::now();
    mbc::Field a;
    a.resize(W, H);
    const auto a1 = std::chrono::steady_clock::now();
    mbc::Stats sa;
    engine.renderField(q, a, sa);
    const auto a2 = std::chrono::steady_clock::now();
    std::memcpy(published.data(), a.base(), bytes);
    const auto a3 = std::chrono::steady_clock::now();

    mbc::Field b;
    b.adopt(W, H, external.data(), external.size());
    mbc::Stats sb;
    engine.renderField(q, b, sb);
    const auto b1 = std::chrono::steady_clock::now();

    size_t diff = 0;
    uint64_t hashA = 1469598103934665603ull, hashB = hashA;
    const uint8_t* pa = reinterpret_cast<const uint8_t*>(published.data());
    const uint8_t* pb = reinterpret_cast<const uint8_t*>(external.data());
    for (size_t i = 0; i < bytes; ++i) {
      hashA = (hashA ^ pa[i]) * 1099511628211ull;
      hashB = (hashB ^ pb[i]) * 1099511628211ull;
    }
    for (size_t i = 0; i < n; ++i) if (published[i] != external[i]) ++diff;
    const auto ms = [](const auto& x, const auto& y) {
      return std::chrono::duration<double, std::milli>(y - x).count();
    };
    std::printf("[field-ab] %dx%d floats=%zu bytes=%zu diff=%zu %s\n",
                W, H, n, bytes, diff, diff ? "MISMATCH" : "IDENTICAL");
    std::printf("[field-ab] hash owned=0x%016llx adopted=0x%016llx\n",
                (unsigned long long)hashA, (unsigned long long)hashB);
    std::printf("[field-ab] alloc+zero=%.2fms render-owned=%.2fms "
                "memcpy=%.2fms render-adopted=%.2fms removed=%.2fms\n",
                ms(a0, a1), ms(a1, a2), ms(a2, a3), ms(a3, b1),
                ms(a0, a1) + ms(a2, a3));
    std::printf("[field-ab] stats bounded=%d/%d esc=[%d,%d]/[%d,%d]\n",
                sa.bounded, sb.bounded, sa.escapeMin, sa.escapeMax,
                sb.escapeMin, sb.escapeMax);
    return diff ? 2 : 0;
  }

  /* MB_REPEAT renders the same view several times with a different quality
   * pass id, which is how the canvas observation / idle continuation path is
   * exercised without a window. */
  const char* repEnv = std::getenv("MB_REPEAT");
  const int repeats = repEnv ? std::max(1, std::atoi(repEnv)) : 1;
  /* MB_FIELD=path dumps the iteration field instead of picking a colour.
   * The record is a 16-byte header (w, h, pitch, flags as int32) followed by
   * w*h*4 float32: smoothiter, distance-in-pixels, iter, dist2.  This is the exact payload
   * the GPU path uploads, so the shader can be developed and diffed offline. */
  const char* fieldEnv = std::getenv("MB_FIELD");
  for (int pass = 0; pass < repeats; ++pass) {
    /* MB_REPEAT still walks the progressive pass ids; a single run honours
     * MB_QUALITY so the final-pass canvas can be A/B'd offline. */
    q.quality = repEnv ? pass : qualityFixed;
    mbc::Stats st;
    const auto t0 = std::chrono::steady_clock::now();
    /* MB_TILES=N renders the frame the way the shell does: many independent
     * tile requests into one surface, in the same order.  Without this the
     * benchmark measures one big call and hides every per-tile cost. */
    const char* tileEnv = std::getenv("MB_TILES");
    const int tile = tileEnv ? std::max(8, std::atoi(tileEnv)) : 0;
    if (tile > 0) {
      for (int ty = 0; ty < H; ty += tile) {
        for (int tx = 0; tx < W; tx += tile) {
          mbc::Request tq = q;
          tq.tileX = tx;
          tq.tileY = ty;
          tq.width = std::min(tile, W - tx);
          tq.height = std::min(tile, H - ty);
          tq.outPitch = W;
          mbc::Stats ts;
          engine.render(tq, img.data() + ((size_t)ty * W + tx) * 4, ts);
          st = ts;
        }
      }
    } else {
      if (fieldEnv) {
        mbc::Field f;
        f.resize(W, H, q.fieldValue ? 6 : 4);
        std::printf("[bench] fieldValue=%d channels=%d\n",
                    (int)q.fieldValue, f.channels);
        engine.renderField(q, f, st);
        if (pass == repeats - 1) {
          FILE* fp = std::fopen(fieldEnv, "wb");
          if (fp) {
            int32_t hdr[4] = {(int32_t)f.w, (int32_t)f.h, (int32_t)f.pitch,
                              (int32_t)f.channels};
            std::fwrite(hdr, sizeof(int32_t), 4, fp);
            std::fwrite(f.base(), sizeof(float),
                        (size_t)f.w * f.h * (size_t)f.channels, fp);
            std::fclose(fp);
            std::printf("field=%s %dx%d ch=%d bounded=%d esc=[%d,%d]\n", fieldEnv,
                        f.w, f.h, f.channels, f.bounded, f.escapeMin,
                        f.escapeMax);
          }
        }
      } else {
        engine.render(q, img.data(), st);
      }
    }
    const double ms =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0)
            .count();
    if (!fieldEnv && pass == repeats - 1) writeBmp(outPath, img, W, H);
    std::printf(
        "pass=%d kind=%d p=%d style=%s psLog2=%.2f bits=%d iter=%d ceil=%d "
        "known=%d budget=%d obs=%d refine=%d refLen=%d refs=%d glitch=%d "
        "skip=%d maxIterUsed=%d esc=[%d,%d] bounded=%d interp=%d cells=%d "
        "cyc=%.3f direct=%d reb=%d "
        "orbit=%.1fms render=%.1fms wall=%.1fms %.2f Mpx/s\n",
        pass, q.spec.kind, q.spec.power, st.perturb ? "perturb" : "direct",
        st.psLog2, st.bits, st.baseIter, st.iterCeiling, st.cornerKnown,
        st.iterBudget, st.observedMax, st.refinePass, st.refLen, st.references,
        st.glitches, st.skip, st.maxIterUsed, st.escapeMin, st.escapeMax,
        st.bounded, st.interpolated, st.canvasCells, st.iterPerCycle,
        st.directFixed, st.rebases,
        st.orbitMs, st.renderMs, ms, (double)st.pixels / (ms * 1000.0));
  }
  return 0;
}
