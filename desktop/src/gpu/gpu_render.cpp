// ---------------------------------------------------------------------------
// gpu_render.cpp — glue between the shell's request stream and the two GPU
// halves (OpenCL iteration, OpenGL presentation).
//
// The colour stage is deliberately *not* reimplemented here: it lives in
// gl_canvas.cpp as a GLSL program, and this file only decides which side
// produces the field and when a pass is presentable.
// ---------------------------------------------------------------------------
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "gpu_render.h"

#include "cl_field.h"
#include "gl_canvas.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <mutex>
#include <vector>

namespace {

bool g_gl = false;
bool g_cl = false;
gpur::Info g_info;
std::mutex g_mu;

/* The palette state the shader needs.  Held here rather than in gl_canvas so
 * that a palette edit does not have to reach into the GL module's internals. */
mbc::Palette g_pal;
bool g_palSet = false;
double g_offset = 0.0;
double g_iterPerCycle = 1.0;
int g_colorMode = 0;
int g_samples = 1;

std::vector<float> g_field;   // tile staging for the CL path

/* Cheap glReadPixels substitute: gl_canvas keeps the shaded texture, so the
 * export path reads it while it is still bound. */

}  // namespace

namespace gpur {

bool init(HWND host) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (g_gl || g_cl) return g_gl || g_cl;
  g_gl = glc::Init(host);
  if (g_gl) {
    g_info.gl = true;
    g_info.glRenderer = glc::RendererString();
    g_info.glVersion = glc::VersionString();
    g_cl = clf::init(nullptr, nullptr);
  } else {
    g_info.why = std::string("GL: ") + glc::lastError();
    // Without GL there is nothing to shade into, so CL alone is not useful.
    g_cl = false;
  }
  if (g_cl) {
    g_info.cl = true;
    g_info.clDevice = clf::caps().device;
    g_info.clVersion = clf::caps().version;
  } else if (g_info.why.empty()) {
    g_info.why = clf::lastError();
  }
  return g_gl;
}

void shutdown() {
  std::lock_guard<std::mutex> lk(g_mu);
  if (g_cl) clf::shutdown();
  if (g_gl) glc::Shutdown();
  g_cl = false;
  g_gl = false;
}

bool ready() { return g_gl; }
bool cl() { return g_cl; }
const Info& info() { return g_info; }

void setBounds(int x, int y, int w, int h) {
  if (g_gl) glc::SetBounds(x, y, w, h);
}

HWND hwnd() { return g_gl ? glc::Hwnd() : nullptr; }

void beginPass(int passW, int passH, int ss, int cw, int ch) {
  if (!g_gl) return;
  glc::BeginPass(passW, passH, ss, cw, ch);
}

bool uploadField(const float* f, int w, int h) {
  if (!g_gl) return false;
  return glc::UploadFieldTile(f, w, h, 0, 0);
}

bool uploadRGBA(const uint8_t* rgba, int fw, int fh, int x, int y) {
  if (!g_gl) return false;
  return glc::UploadRGBATile(rgba, fw, fh, x, y, true);
}

bool commit(bool keepPreview, double sx, double ox, double sy, double oy) {
  if (!g_gl) return false;
  return keepPreview ? glc::CommitPassWithPreview(sx, ox, sy, oy)
                     : glc::CommitPass();
}

void preview(double scale, double dx, double dy, double cx, double cy) {
  if (g_gl) glc::Preview(scale, dx, dy, cx, cy);
}

void setPreview(double sx, double ox, double sy, double oy) {
  if (g_gl) glc::SetPreview(sx, ox, sy, oy);
}

void resetPreview() {
  if (g_gl) glc::ResetPreview();
}

void setPalette(const mbc::Palette& pal, double offset, double iterPerCycle,
                int colorMode, int samples) {
  std::lock_guard<std::mutex> lk(g_mu);
  g_pal = pal;
  g_palSet = true;
  g_offset = offset;
  g_iterPerCycle = iterPerCycle > 0.0 ? iterPerCycle : 1.0;
  g_colorMode = colorMode;
  g_samples = samples;
  if (g_gl) glc::SetPalette(pal, offset, iterPerCycle, colorMode, samples);
}

bool renderFieldTile(const mbc::Request& req, double pixelScale,
                     mbc::Stats& st) {
  (void)pixelScale;
  auto bail = [](const char* why) {
    g_info.why = std::string("field declined: ") + why;
    return false;
  };
  if (!g_cl || !g_gl) return bail("no GPU backend");
  if (req.spec.mode != 0 && req.spec.mode != 1) return bail("mode");
  if (req.spec.kind != 0) return bail("formula kind");
  if (req.traps != 0) return bail("orbit trap");
  /* The pixel size is derived here, from the same log-space definition the
   * core uses.  Taking it as an argument let a caller pass a value that had
   * already gone through an unrelated guard, which is how a perfectly ordinary
   * 2^-7 view was being declined as "outside double". */
  /* spanMant * 2^spanExp / max(vw, vh), evaluated by scaling rather than by
   * log2/exp2: the pixel size must be exact, and a round trip through the
   * logarithm costs a few ulps that show up as a one-pixel shift at depth.
   * (It also keeps this TU free of the CRT's transcendental helpers.) */
  double ps = req.spanMant > 0.0 ? req.spanMant : 1.0;
  {
    const int vw = req.viewWidth > 0 ? req.viewWidth : req.width;
    const int vh = req.viewHeight > 0 ? req.viewHeight : req.height;
    const int longer = vw > vh ? vw : vh;
    ps /= (double)(longer > 1 ? longer : 1);
    int e = req.spanExp;
    for (; e > 0; --e) ps *= 2.0;
    for (; e < 0; ++e) ps *= 0.5;
  }
  if (!(ps > 0.0) || !std::isfinite(ps)) {
    char b[160];
    std::snprintf(b, sizeof(b), "bad pixel scale (px=%.9g sm=%g se=%d vw=%d)",
                  ps, req.spanMant, req.spanExp, req.viewWidth);
    return bail(b);
  }
  if (!clf::supports(ps, req.spec.power)) {
    char b[128];
    std::snprintf(b, sizeof(b), "outside double (px=%.9g log2=%.3f)",
                  ps, mbc::pixelScaleLog2(req));
    return bail(b);
  }
  if (!g_palSet) return bail("palette not set");

  clf::Tile t;
  t.w = req.width;
  t.h = req.height;
  t.ox = req.tileX;
  t.oy = req.tileY;
  t.fw = req.viewWidth > 0 ? req.viewWidth : req.width;
  t.fh = req.viewHeight > 0 ? req.viewHeight : req.height;
  t.cre = std::strtod(req.centerRe.c_str(), nullptr);
  t.cim = std::strtod(req.centerIm.c_str(), nullptr);
  t.px = ps;
  t.rotC = std::cos(req.rotation);
  t.rotS = std::sin(req.rotation);
  t.julia = req.spec.mode == 1 ? 1 : 0;
  t.power = req.spec.power;
  t.maxIter = req.maxIter;
  t.wantDist = req.fieldDist ? 1 : 0;
  if (t.julia) {
    t.jre = req.spec.juliaRe;
    t.jim = req.spec.juliaIm;
    if (!req.spec.juliaReS.empty())
      t.jre = std::strtod(req.spec.juliaReS.c_str(), nullptr);
    if (!req.spec.juliaImS.empty())
      t.jim = std::strtod(req.spec.juliaImS.c_str(), nullptr);
  }

  const size_t need = (size_t)t.w * (size_t)t.h * 4;
  {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_field.size() < need) g_field.resize(need);
  }
  float* buf = nullptr;
  {
    std::lock_guard<std::mutex> lk(g_mu);
    buf = g_field.data();
  }
  const auto t0 = std::chrono::steady_clock::now();
  if (!clf::compute(t, buf)) {
    g_info.why = std::string("kernel: ") + clf::lastError();
    return false;
  }
  glc::SetPalette(g_pal, g_offset, g_iterPerCycle, g_colorMode, g_samples);
  if (!glc::UploadFieldTile(buf, t.w, t.h, req.tileX, req.tileY)) {
    int fw = 0, fh = 0;
    glc::FieldSize(&fw, &fh);
    char b[200];
    std::snprintf(b, sizeof(b),
                  "upload failed (%dx%d at %d,%d; field=%dx%d ready=%d)",
                  t.w, t.h, req.tileX, req.tileY, fw, fh,
                  glc::Ready() ? 1 : 0);
    return bail(b);
  }

  /* Frame statistics, measured from the field itself rather than estimated.
   * These are what the HUD shows and what the band fit consumes. */
  int bounded = 0, lo = INT32_MAX, hi = 0;
  long long work = 0;
  for (size_t i = 0; i < need; i += 4) {
    const float it = buf[i + 2];
    if (it < 0.0f) {
      ++bounded;
    } else {
      const int n = (int)it;
      if (n < lo) lo = n;
      if (n > hi) hi = n;
      work += n;
    }
  }
  st.bounded = bounded;
  st.escapeMin = lo == INT32_MAX ? 0 : lo;
  st.escapeMax = hi;
  /* The band fit the CPU core performs for the same request.  Leaving this at
   * zero made the shell's shader keep the palette's authored cycle on a frame
   * whose visible range is a few iterations wide: the picture came out as one
   * or two flat bands plus a bright rim. */
  {
    double ipc = req.cycle > 0.0
                     ? req.cycle
                     : (g_pal.cycleRef > 0.05f ? (double)g_pal.cycleRef : 1.0);
    if (g_pal.mode == 1) {
      if (!(ipc > 0.0)) ipc = 8.0;
      if (ipc < 0.02) ipc = 0.02;
    } else if (req.bands > 0 && hi > lo) {
      /* Band density, only ever lengthening the cycle (see mb_engine.cpp). */
      const double want = (double)(hi - lo) / (double)req.bands;
      if (want > ipc) ipc = want;
    }
    st.iterPerCycle = ipc;
  }
  st.maxIterUsed = req.maxIter;
  st.iterPixels = work;
  st.pixels = t.w * t.h;
  st.bits = 53;
  st.perturb = false;
  st.threads = clf::caps().computeUnits;
  st.renderMs = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - t0).count();
  st.orbitMs = 0.0;
  st.frameMs = st.renderMs;
  g_info.why.clear();
  return true;
}

bool readback(uint8_t* rgba, int w, int h) {
  if (!g_gl || !rgba) return false;
  return glc::ReadPresented(rgba, w, h);
}

const float* fieldData() {
  std::lock_guard<std::mutex> lk(g_mu);
  return g_field.empty() ? nullptr : g_field.data();
}

size_t fieldFloats() {
  std::lock_guard<std::mutex> lk(g_mu);
  return g_field.size();
}

double lastKernelMs() { return clf::lastMs(); }
double lastPresentMs() { return glc::LastPresentMs(); }
int frames() { return glc::FrameCount(); }

}  // namespace gpur
