// ---------------------------------------------------------------------------
// gl_canvas.cpp — OpenGL 3.3 core product canvas.
//
// Two passes per commit:
//
//   shade   field texture (RGBA32F)  ->  GL_RGB10_A2 framebuffer
//           The colour stage is the reference program's own `pal()` plus the
//           tone stage, transcribed from core/mb_palette.cpp so the desktop
//           and the CPU renderer agree on what a palette means.
//
//   present GL_RGB10_A2 texture      ->  window
//           Box-filters the supersampled pass down to the window size and
//           applies the gesture preview transform (scale + offset).
//
// The GL context is created on the UI thread during Init() and re-made
// current on whichever thread calls in; `wglGetCurrentContext()` is
// thread-local, so the compare below is enough to migrate safely.
// ---------------------------------------------------------------------------
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX   // std::min/max must survive windows.h
#endif
#include <windows.h>

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "gl_canvas.h"
#include "gl_api.h"
#include "mb_color.h"

#pragma comment(lib, "opengl32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

namespace {

const char* kShadeVS = R"(#version 330 core
void main() {
  // Fullscreen triangle from gl_VertexID — no vertex buffer, no attributes.
  vec2 q = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);
}
)";

const char* kShadeFS = R"(#version 330 core
out vec4 fragColor;

uniform sampler2D tex_field;
uniform sampler2D tex_ramp;
uniform int   uRamp;
uniform vec2  uFieldSize;
uniform int   uColorMode;
uniform int   uNColor;
uniform vec3  uColorC[20];
uniform float uColorF[20];
uniform float uColorI[20];
uniform float uBriFinite;
uniform float uBriInfinite;
uniform float uIterPerCycle;
uniform float uOffset;
uniform float uCycleRef;
uniform int   uSamples;
uniform float uExposure;
uniform vec4  uTone;      // saturation, contrast, gamma, brightness
uniform vec4  uGain;      // gainR, gainG, gainB, unused
uniform int   uInvert;

const float M_PI_H = 3.1415926538;

/* Row order is flipped: field row 0 is the top of the image, gl_FragCoord.y
 * 0 is the bottom.  Bilinear, with the same clamp the page's fieldAtEx uses
 * so a tile edge never samples across the frame boundary. */
vec4 fieldAt(vec2 pixel) {
  vec2 t = vec2(pixel.x, uFieldSize.y - 1.0 - pixel.y);
  t = clamp(t, vec2(0.0), uFieldSize - vec2(1.0));
  vec2 i0 = floor(t);
  vec2 f = t - i0;
  ivec2 a = ivec2(i0);
  ivec2 b = ivec2(min(i0 + 1.0, uFieldSize - 1.0));
  vec4 v00 = texelFetch(tex_field, ivec2(a.x, a.y), 0);
  vec4 v10 = texelFetch(tex_field, ivec2(b.x, a.y), 0);
  vec4 v01 = texelFetch(tex_field, ivec2(a.x, b.y), 0);
  vec4 v11 = texelFetch(tex_field, ivec2(b.x, b.y), 0);
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

/* tonePrep: saturation -> contrast -> gamma -> gain.  Identical to
 * core/mb_palette.cpp:tonePrep(), applied before the region brightness. */
vec3 tonePrep(vec3 c) {
  if (uTone.x != 1.0) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = vec3(lum) + (c - vec3(lum)) * uTone.x;
  }
  if (uTone.y != 1.0) c = (c - vec3(0.5)) * uTone.y + vec3(0.5);
  if (uTone.z != 1.0) c = pow(max(c, vec3(0.0)), vec3(1.0 / uTone.z));
  return c * uGain.rgb;
}

/* toneFinish: brightness, then the reference's hue-preserving normalise. */
vec3 toneFinish(vec3 c, float bri) {
  c *= bri;
  float m = max(max(c.r, c.g), c.b);
  if (m > 1.0) c /= m;
  return clamp(c, vec3(0.0), vec3(1.0));
}

vec3 palRaw(float phase, float bri) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 20; ++i) {
    if (i >= uNColor) break;
    float a = mod(phase * uColorF[i] + uColorI[i], 2.0 * M_PI_H);
    c += uColorC[i] * (0.5 * (1.0 + sin(a)));
  }
  return toneFinish(tonePrep(c), bri);
}

vec3 rampRaw(float t, float bri) {
  float f = t - floor(t);
  if (!(f >= 0.0) || f >= 1.0) f = 0.0;
  // Half-texel inset so GL_LINEAR never blends the last entry with the first
  // by accident; the ramp is periodic, so wrap-exactness matters.
  float n = float(textureSize(tex_ramp, 0).x);
  vec3 c = texture(tex_ramp, vec2((f * n + 0.5) / n, 0.5)).rgb;
  return toneFinish(c, bri);
}

vec3 sampleIters(float iters, float bri) {
  float phase = (iters / uIterPerCycle + uOffset) * uCycleRef;
  return uRamp != 0 ? rampRaw(iters / uIterPerCycle + uOffset, bri)
                    : palRaw(phase, bri);
}

vec3 shadePixel(vec4 f) {
  // Interior pixels carry the negated period in both smoothiter and iter.
  if (f.r < 0.0) {
    float cyc = f.r < -0.5 ? -f.r : 0.0;
    return sampleIters(cyc + 0.5, uBriInfinite);
  }
  float n = f.b;
  float nu = f.r;
  if (uColorMode == 1) {
    return sampleIters(n + 0.5, uBriFinite);
  }
  if (uColorMode == 2 || uColorMode == 3) {
    float px = f.g;                       // already in pixels
    if (uColorMode == 2) {
      float wht = (px < 1.0 && px != 0.0) ? (1.0 - px) * uBriFinite : 0.0;
      return clamp(vec3(wht), vec3(0.0), vec3(1.0));
    }
    float rr2 = px * exp(-1.5);
    vec3 c = vec3(0.0);
    if (rr2 < 1.0 && rr2 != 0.0) c = sampleIters(n + 0.5, uBriFinite) * (1.0 - rr2);
    float wht = (px < 1.0 && px != 0.0) ? (1.0 - px) * uBriFinite : 0.0;
    return clamp(c + vec3(wht), vec3(0.0), vec3(1.0));
  }
  return sampleIters(nu + 0.5, uBriFinite);
}

void main() {
  vec4 acc = vec4(0.0);
  for (int yy = 0; yy < 4; ++yy) {
    if (yy >= uSamples) break;
    for (int xx = 0; xx < 4; ++xx) {
      if (xx >= uSamples) break;
      vec2 off = (vec2(float(xx), float(yy)) + 0.5) / float(uSamples) - 0.5;
      acc += vec4(shadePixel(fieldAt(gl_FragCoord.xy + off)), 1.0);
    }
  }
  acc /= float(uSamples * uSamples);
  vec3 c = acc.rgb * uExposure;
  if (uInvert != 0) c = vec3(1.0) - c;
  fragColor = vec4(clamp(c, vec3(0.0), vec3(1.0)), 1.0);
}
)";

const char* kPresentVS = R"(#version 330 core
out vec2 vUV;
void main() {
  vec2 q = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = vec2(q.x, 1.0 - q.y);
  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);
}
)";

const char* kPresentFS = R"(#version 330 core
in vec2 vUV;
out vec4 oColor;
uniform sampler2D tex_scene;
uniform vec4 uXf;    // sx, sy, ox, oy
uniform vec4 uBg;
uniform float uSS;
void main() {
  vec2 uv = vec2(uXf.x * vUV.x + uXf.z, uXf.y * vUV.y + uXf.w);
  /* No flat fill outside the committed frame.  A pan exposes exactly the strip
   * the frame does not cover, and painting it uBg read as a hard band (the
   * "black edge" of a drag, and a visible seam wherever the palette's own
   * background is not the same grey).  The sampler is CLAMP_TO_EDGE, so every
   * tap beyond the edge returns the nearest border texel: the picture's own
   * last row/column continues into the gap, which is what the page's 2D
   * fallback does with an explicit drawImage. */
  if (uSS < 1.5) {
    oColor = texture(tex_scene, uv);
    return;
  }
  ivec2 ts = textureSize(tex_scene, 0);
  vec4 c = vec4(0.0);
  int is = int(uSS);
  for (int j = 0; j < 4; ++j) {
    if (j >= is) break;
    for (int k = 0; k < 4; ++k) {
      if (k >= is) break;
      vec2 o = vec2((float(j) + 0.5 - 0.5 * uSS) / float(ts.x),
                    (float(k) + 0.5 - 0.5 * uSS) / float(ts.y));
      c += texture(tex_scene, uv + o);
    }
  }
  oColor = c / (uSS * uSS);
}
)";

HMODULE g_gl = nullptr;
HWND g_host = nullptr;
HWND g_hwnd = nullptr;
HDC g_dc = nullptr;
HGLRC g_rc = nullptr;
int g_w = 0, g_h = 0;

GLuint g_vao = 0;
GLuint g_shadeProg = 0, g_presentProg = 0;
GLuint g_fieldTex = 0, g_sceneTex = 0, g_sceneFbo = 0, g_rampTex = 0;
int g_fieldW = 0, g_fieldH = 0;
int g_sceneW = 0, g_sceneH = 0;
bool g_fieldNew = false;
/* True once the current scene texture has been shaded at least once.  A
 * reallocated scene holds undefined pixels, and presenting it shows the clear
 * colour -- a full-frame flash of background every time the pass size
 * changes, which is what a zoom did on every resolution switch. */
bool g_sceneShaded = false;

int g_passW = 0, g_passH = 0, g_ss = 1, g_cw = 0, g_ch = 0;
bool g_ready = false;
bool g_gpuShading = true;
/* UploadRGBATile() bypasses the colour stage: the caller already produced
 * pixels, so CommitPass must present them instead of re-shading a field that
 * was never written.  Cleared by the next field upload. */
bool g_rgbaMode = false;

std::mutex g_mu;
double g_sx = 1.0, g_sy = 1.0, g_ox = 0.0, g_oy = 0.0;
double g_upMs = 0.0, g_prMs = 0.0;
int g_frames = 0;

struct ShadeState {
  mbc::Palette pal{};
  double offset = 0.0;
  double iterPerCycle = 1.0;
  int colorMode = 0;
  int samples = 1;
  int rampLevels = 0;
  std::vector<uint32_t> rampPacked;
  float exposure = 1.0f;
  bool dirty = true;
};
ShadeState g_st;

std::string g_renderer, g_version;
/* Every failure path records why.  A canvas that silently declines is the
 * hardest kind of bug to chase, so the reason travels back to the shell log. */
std::string g_why;

void Fail(const char* fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  g_why = buf;
  OutputDebugStringA("[glc] ");
  OutputDebugStringA(buf);
  OutputDebugStringA("\n");
}

double NowMs() {
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

bool HasExt(const std::vector<std::string>& v, const char* n) {
  return std::binary_search(v.begin(), v.end(), std::string(n));
}

GLuint CompileShader(GLenum type, const char* src, std::string& err) {
  GLuint s = ggl::glCreateShader(type);
  ggl::glShaderSource(s, 1, &src, nullptr);
  ggl::glCompileShader(s);
  GLint ok = 0;
  ggl::glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[4096] = {0};
    ggl::glGetShaderInfoLog(s, sizeof(log) - 1, nullptr, log);
    err = log;
    ggl::glDeleteShader(s);
    return 0;
  }
  return s;
}

GLuint LinkProgram(const char* vs, const char* fs, std::string& err) {
  GLuint v = CompileShader(GL_VERTEX_SHADER, vs, err);
  if (!v) return 0;
  GLuint f = CompileShader(GL_FRAGMENT_SHADER, fs, err);
  if (!f) {
    ggl::glDeleteShader(v);
    return 0;
  }
  GLuint p = ggl::glCreateProgram();
  ggl::glAttachShader(p, v);
  ggl::glAttachShader(p, f);
  ggl::glLinkProgram(p);
  ggl::glDeleteShader(v);
  ggl::glDeleteShader(f);
  GLint ok = 0;
  ggl::glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[4096] = {0};
    ggl::glGetProgramInfoLog(p, sizeof(log) - 1, nullptr, log);
    err = log;
    ggl::glDeleteProgram(p);
    return 0;
  }
  return p;
}

GLint U(GLuint prog, const char* name) {
  return ggl::glGetUniformLocation(prog, name);
}

/** Register a throwaway window class and use it to reach the WGL extension
 *  entry points, which only exist while a context is current. */
bool BootstrapContext() {
  WNDCLASSA wc{};
  wc.lpfnWndProc = DefWindowProcA;
  wc.hInstance = GetModuleHandleA(nullptr);
  wc.lpszClassName = "mbGLBootstrap";
  if (!RegisterClassA(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
    return false;
  HWND w = CreateWindowExA(0, wc.lpszClassName, "", WS_OVERLAPPEDWINDOW, 0, 0,
                           64, 64, nullptr, nullptr, wc.hInstance, nullptr);
  if (!w) return false;
  HDC dc = GetDC(w);
  PIXELFORMATDESCRIPTOR pfd{};
  pfd.nSize = sizeof(pfd);
  pfd.nVersion = 1;
  pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  pfd.iPixelType = PFD_TYPE_RGBA;
  pfd.cColorBits = 32;
  pfd.cAlphaBits = 8;
  const int pf = ChoosePixelFormat(dc, &pfd);
  bool ok = false;
  if (pf > 0 && SetPixelFormat(dc, pf, &pfd)) {
    HGLRC rc = wglCreateContext(dc);
    if (rc && wglMakeCurrent(dc, rc)) {
      ok = true;
      // loadCore() resolves wglCreateContextAttribsARB etc.  The pointers stay
      // valid for the process, so the real context can use them afterwards.
      ggl::loadCore();
      wglMakeCurrent(nullptr, nullptr);
    }
    if (rc) wglDeleteContext(rc);
  }
  ReleaseDC(w, dc);
  DestroyWindow(w);
  return ok;
}

/** Attach a 10-bit, double-buffered pixel format when the driver offers one.
 *  Ten bits per channel is the whole point of the GL_RGB10_A2 pipeline; when
 *  the display path cannot take it we still render in 10 bits and let the
 *  present pass dither down. */
int PickPixelFormat(HDC dc) {
  if (ggl::wglChoosePixelFormatARB) {
    const int attribs[] = {
        WGL_DRAW_TO_WINDOW_ARB, GL_TRUE,
        WGL_SUPPORT_OPENGL_ARB, GL_TRUE,
        WGL_DOUBLE_BUFFER_ARB, GL_TRUE,
        WGL_PIXEL_TYPE_ARB, WGL_TYPE_RGBA_ARB,
        WGL_COLOR_BITS_ARB, 30,
        WGL_RED_BITS_ARB, 10,
        WGL_GREEN_BITS_ARB, 10,
        WGL_BLUE_BITS_ARB, 10,
        WGL_ALPHA_BITS_ARB, 2,
        WGL_DEPTH_BITS_ARB, 0,
        WGL_STENCIL_BITS_ARB, 0,
        0, 0};
    int pf = 0;
    UINT n = 0;
    if (ggl::wglChoosePixelFormatARB(dc, attribs, nullptr, 1, &pf, &n) &&
        n > 0 && pf > 0) {
      PIXELFORMATDESCRIPTOR chk{};
      DescribePixelFormat(dc, pf, sizeof(chk), &chk);
      return pf;
    }
  }
  PIXELFORMATDESCRIPTOR pfd{};
  pfd.nSize = sizeof(pfd);
  pfd.nVersion = 1;
  pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  pfd.iPixelType = PFD_TYPE_RGBA;
  pfd.cColorBits = 32;
  pfd.cAlphaBits = 8;
  return ChoosePixelFormat(dc, &pfd);
}

bool CreateContextOn(HWND w) {
  g_dc = GetDC(w);
  if (!g_dc) return false;
  const int pf = PickPixelFormat(g_dc);
  if (pf <= 0) return false;
  PIXELFORMATDESCRIPTOR pfd{};
  DescribePixelFormat(g_dc, pf, sizeof(pfd), &pfd);
  if (!SetPixelFormat(g_dc, pf, &pfd)) return false;

  if (ggl::wglCreateContextAttribsARB) {
    const int ctxAttribs[] = {
        WGL_CONTEXT_MAJOR_VERSION_ARB, 3,
        WGL_CONTEXT_MINOR_VERSION_ARB, 3,
        WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_CORE_PROFILE_BIT_ARB,
        0};
    g_rc = ggl::wglCreateContextAttribsARB(g_dc, nullptr, ctxAttribs);
  }
  if (!g_rc) g_rc = wglCreateContext(g_dc);      // last resort: legacy context
  if (!g_rc) return false;
  if (!wglMakeCurrent(g_dc, g_rc)) return false;
  if (!ggl::loadCore()) return false;
  return true;
}

/* A GL context can only be current in one thread.  Init() runs on the UI thread
 * and the render thread does the drawing, so the context has to be released
 * before the worker can take it: wglMakeCurrent() fails outright while another
 * thread holds the same context, and every glGenTextures / glTexImage2D call
 * then silently does nothing (a texture name stays 0). */
void EnsureCurrent() {
  if (!g_rc || !g_dc) return;
  if (wglGetCurrentContext() == g_rc) return;
  if (!wglMakeCurrent(g_dc, g_rc)) {
    wglMakeCurrent(nullptr, nullptr);
    wglMakeCurrent(g_dc, g_rc);
  }
}

void AllocField(int w, int h) {
  if (g_fieldW == w && g_fieldH == h && g_fieldTex) return;
  if (g_fieldTex) glDeleteTextures(1, &g_fieldTex);
  g_fieldTex = 0;
  glGenTextures(1, &g_fieldTex);
  glBindTexture(GL_TEXTURE_2D, g_fieldTex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, w, h, 0, GL_RGBA, GL_FLOAT,
               nullptr);
  g_fieldW = w;
  g_fieldH = h;
  g_fieldNew = true;
}

void AllocScene(int w, int h) {
  if (g_sceneW == w && g_sceneH == h && g_sceneTex) return;
  if (g_sceneTex) glDeleteTextures(1, &g_sceneTex);
  if (g_sceneFbo) ggl::glDeleteFramebuffers(1, &g_sceneFbo);
  g_sceneTex = 0;
  g_sceneFbo = 0;
  glGenTextures(1, &g_sceneTex);
  glBindTexture(GL_TEXTURE_2D, g_sceneTex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  // The colour library's contract: 10 bits per channel.
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB10_A2, w, h, 0, GL_RGBA,
               GL_UNSIGNED_INT_2_10_10_10_REV, nullptr);
  ggl::glGenFramebuffers(1, &g_sceneFbo);
  ggl::glBindFramebuffer(GL_FRAMEBUFFER, g_sceneFbo);
  ggl::glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                              GL_TEXTURE_2D, g_sceneTex, 0);
  const GLenum st = ggl::glCheckFramebufferStatus(GL_FRAMEBUFFER);
  ggl::glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (st != GL_FRAMEBUFFER_COMPLETE) {
    g_gpuShading = false;
    return;
  }
  g_sceneW = w;
  g_sceneH = h;
  g_sceneShaded = false;
}

/** Build the gradient LUT as GL_RGB10_A2 texels — the colour library's own
 *  packing, uploaded through the same function a caller would use. */
void BuildRamp() {
  const mbc::Palette& P = g_st.pal;
  if (P.mode != 1 || P.ns < 2) {
    g_st.rampLevels = 0;
    g_st.rampPacked.clear();
    return;
  }
  const int N = 1024;
  mbcol::LUT lut;
  lut.levels = N;
  lut.srgb.assign((size_t)N * 3, 0.0f);
  lut.rgb10.assign((size_t)N * 3, 0);
  lut.packed.assign((size_t)N, 0);
  for (int k = 0; k < N; ++k) {
    const float t = (float)k / (float)N;
    // Locate the segment (stops are sorted by pos).
    int i = 0;
    while (i + 1 < P.ns && P.s[i + 1].pos <= t) ++i;
    const mbc::GradientStop& a = P.s[i];
    const mbc::GradientStop& b = P.s[std::min(i + 1, P.ns - 1)];
    const float span = std::max(1e-9f, b.pos - a.pos);
    float u = (t - a.pos) / span;
    u = u < 0.0f ? 0.0f : (u > 1.0f ? 1.0f : u);
    // Smoothstep, exactly as the editor's gradient bar draws it.
    u = u * u * (3.0f - 2.0f * u);
    auto lerp = [&](float x, float y) { return x + (y - x) * u; };
    float r = lerp(a.r, b.r), g = lerp(a.g, b.g), bl = lerp(a.b, b.b);
    // tonePrep is baked here; brightness stays per-pixel in the shader.
    if (P.saturation != 1.0f) {
      const float lum = 0.2126f * r + 0.7152f * g + 0.0722f * bl;
      r = lum + (r - lum) * P.saturation;
      g = lum + (g - lum) * P.saturation;
      bl = lum + (bl - lum) * P.saturation;
    }
    if (P.contrast != 1.0f) {
      r = (r - 0.5f) * P.contrast + 0.5f;
      g = (g - 0.5f) * P.contrast + 0.5f;
      bl = (bl - 0.5f) * P.contrast + 0.5f;
    }
    if (P.gamma != 1.0f) {
      const float ig = 1.0f / P.gamma;
      r = std::pow(std::max(r, 0.0f), ig);
      g = std::pow(std::max(g, 0.0f), ig);
      bl = std::pow(std::max(bl, 0.0f), ig);
    }
    r *= P.gainR; g *= P.gainG; bl *= P.gainB;
    auto q = [](float v) {
      const float c = v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
      return (uint16_t)(c * 1023.0f + 0.5f);
    };
    const uint16_t rr = q(r), gg = q(g), bb = q(bl);
    lut.srgb[(size_t)k * 3 + 0] = r;
    lut.srgb[(size_t)k * 3 + 1] = g;
    lut.srgb[(size_t)k * 3 + 2] = bl;
    lut.rgb10[(size_t)k * 3 + 0] = rr;
    lut.rgb10[(size_t)k * 3 + 1] = gg;
    lut.rgb10[(size_t)k * 3 + 2] = bb;
    lut.packed[(size_t)k] = mbcol::packRGB10A2(rr, gg, bb);
  }
  if (!g_rampTex) glGenTextures(1, &g_rampTex);
  glBindTexture(GL_TEXTURE_2D, g_rampTex);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB10_A2, N, 1, 0, GL_RGBA,
               GL_UNSIGNED_INT_2_10_10_10_REV, lut.packed.data());
  g_st.rampLevels = N;
  g_st.rampPacked = lut.packed;
}

/** Auto-exposure, measured the way the CPU measures it: evaluate the palette
 *  over one cycle and take the 99th percentile of its peak channel.  Without
 *  it a six-term pal() spends most of its cycle above 1 and the whole frame
 *  reads as flat white — the CPU bakes the same factor into its LUT. */
float ComputeExposure() {
  const mbc::Palette& P = g_st.pal;
  if (P.mode == 1) return 1.0f;
  if (P.n <= 0) return 1.0f;
  double peak[256];
  for (int k = 0; k < 256; ++k) {
    const double phase = 2.0 * 3.141592653589793 * (double)k / 256.0;
    double r = 0, g = 0, b = 0;
    for (int i = 0; i < P.n; ++i) {
      const double a = phase * (double)P.c[i].frequency + (double)P.c[i].initial;
      const double amp = 0.5 * (1.0 + std::sin(a));
      r += (double)P.c[i].r * amp;
      g += (double)P.c[i].g * amp;
      b += (double)P.c[i].b * amp;
    }
    peak[k] = std::max(r, std::max(g, b));
  }
  std::sort(peak, peak + 256);
  const double p99 = peak[(int)(255 * 0.99)];
  const double bf = (double)P.brightnessFinite;
  const double bi = (double)P.brightnessInfinite;
  const double eff = p99 * bf * std::max(bf, bi);
  if (!(eff > 1e-9)) return 1.0f;
  const double k = 1.05 / eff;
  if (std::fabs(k - 1.0) < 0.05) return 1.0f;
  return (float)std::min(std::max(k, 0.02), 50.0);
}

void ApplyUniforms() {
  const mbc::Palette& P = g_st.pal;
  ggl::glUseProgram(g_shadeProg);
  ggl::glUniform1i(U(g_shadeProg, "tex_field"), 0);
  ggl::glUniform1i(U(g_shadeProg, "tex_ramp"), 1);
  ggl::glUniform1i(U(g_shadeProg, "uRamp"), g_st.rampLevels > 0 ? 1 : 0);
  ggl::glUniform2f(U(g_shadeProg, "uFieldSize"), (float)g_fieldW,
                   (float)g_fieldH);
  ggl::glUniform1i(U(g_shadeProg, "uColorMode"), g_st.colorMode);
  const int n = std::min(std::max(P.n, 0), 20);
  ggl::glUniform1i(U(g_shadeProg, "uNColor"), n);
  if (n > 0) {
    float c[60], f[20], iv[20];
    for (int i = 0; i < n; ++i) {
      c[i * 3 + 0] = P.c[i].r;
      c[i * 3 + 1] = P.c[i].g;
      c[i * 3 + 2] = P.c[i].b;
      f[i] = P.c[i].frequency;
      iv[i] = P.c[i].initial;
    }
    ggl::glUniform3fv(U(g_shadeProg, "uColorC[0]"), n, c);
    ggl::glUniform1fv(U(g_shadeProg, "uColorF[0]"), n, f);
    ggl::glUniform1fv(U(g_shadeProg, "uColorI[0]"), n, iv);
  }
  const double reg = P.brightnessFactor > 0.0f ? (double)P.brightnessFactor : 1.0;
  ggl::glUniform1f(U(g_shadeProg, "uBriFinite"),
                   (float)((double)P.brightnessFinite * (double)P.brightness / reg));
  ggl::glUniform1f(U(g_shadeProg, "uBriInfinite"),
                   (float)((double)P.brightnessInfinite * (double)P.brightness / reg));
  ggl::glUniform1f(U(g_shadeProg, "uIterPerCycle"),
                   (float)(g_st.iterPerCycle > 0.0 ? g_st.iterPerCycle : 1.0));
  ggl::glUniform1f(U(g_shadeProg, "uOffset"), (float)g_st.offset);
  ggl::glUniform1f(U(g_shadeProg, "uCycleRef"),
                   (float)(P.cycleRef > 0.0f ? P.cycleRef : 1.0f));
  ggl::glUniform1i(U(g_shadeProg, "uSamples"),
                   std::min(std::max(g_st.samples, 1), 4));
  ggl::glUniform1f(U(g_shadeProg, "uExposure"), g_st.exposure);
  ggl::glUniform4f(U(g_shadeProg, "uTone"), P.saturation, P.contrast, P.gamma,
                   P.brightness);
  ggl::glUniform4f(U(g_shadeProg, "uGain"), P.gainR, P.gainG, P.gainB, 1.0f);
  ggl::glUniform1i(U(g_shadeProg, "uInvert"), 0);
  ggl::glUseProgram(0);
}

/** Shade the whole field into the GL_RGB10_A2 target. */
bool ShadePass() {
  if (!g_shadeProg || g_fieldW <= 0 || !g_sceneFbo) return false;
  if (g_st.dirty) {
    g_st.exposure = ComputeExposure();
    g_st.dirty = false;
  }
  ApplyUniforms();
  ggl::glBindFramebuffer(GL_FRAMEBUFFER, g_sceneFbo);
  // A single colour attachment: the FBO's default draw buffer is
  // GL_COLOR_ATTACHMENT0, so no glDrawBuffers call is needed (and opengl32.dll
  // only exports GL 1.1, so it would have to be resolved anyway).
  glViewport(0, 0, g_sceneW, g_sceneH);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_BLEND);
  ggl::glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, g_fieldTex);
  ggl::glActiveTexture(GL_TEXTURE1);
  glBindTexture(GL_TEXTURE_2D, g_rampTex);
  ggl::glUseProgram(g_shadeProg);
  ggl::glBindVertexArray(g_vao);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  ggl::glBindVertexArray(0);
  ggl::glUseProgram(0);
  ggl::glBindFramebuffer(GL_FRAMEBUFFER, 0);
  g_fieldNew = false;
  g_sceneShaded = true;
  return true;
}

void PresentPass() {
  if (!g_presentProg) return;
  RECT rc{};
  GetClientRect(g_hwnd, &rc);
  const int vw = rc.right - rc.left, vh = rc.bottom - rc.top;
  if (vw <= 0 || vh <= 0) return;
  glViewport(0, 0, vw, vh);
  glDisable(GL_DEPTH_TEST);
  glDisable(GL_BLEND);
  glClearColor(0.031f, 0.035f, 0.043f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
  /* Nothing valid to sample yet: keep whatever the window already shows rather
   * than flashing the clear colour.  The next ShadePass makes it presentable. */
  if (!g_sceneTex || !g_sceneShaded) return;
  ggl::glUseProgram(g_presentProg);
  ggl::glUniform1i(U(g_presentProg, "tex_scene"), 0);
  ggl::glUniform4f(U(g_presentProg, "uXf"), (float)g_sx, (float)g_sy,
                   (float)g_ox, (float)g_oy);
  ggl::glUniform4f(U(g_presentProg, "uBg"), 0.031f, 0.035f, 0.043f, 1.0f);
  ggl::glUniform1f(U(g_presentProg, "uSS"), (float)std::max(1, g_ss));
  ggl::glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, g_sceneTex);
  ggl::glBindVertexArray(g_vao);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  ggl::glBindVertexArray(0);
  ggl::glUseProgram(0);
  SwapBuffers(g_dc);
  ++g_frames;
}

void SetBgBrush() {
  // The child window paints its own background through GL; suppress GDI's.
  SetClassLongPtrA(g_hwnd, GCLP_HBRBACKGROUND,
                   (LONG_PTR)GetStockObject(BLACK_BRUSH));
}

/** The child window does no GDI painting: GL owns every pixel, and answering
 *  WM_ERASEBKGND with 1 is what stops the shell from flashing grey between a
 *  resize and the next present. */
LRESULT CALLBACK CanvasProc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;
    case WM_SIZE:
      return 0;
    default:
      return DefWindowProcA(w, msg, wp, lp);
  }
}

bool RegisterCanvasClass() {
  WNDCLASSA wc{};
  wc.style = CS_OWNDC;          // one DC per window: GL needs a stable one
  wc.lpfnWndProc = CanvasProc;
  wc.hInstance = GetModuleHandleA(nullptr);
  wc.hCursor = LoadCursorA(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = "mbGLCanvas";
  if (RegisterClassA(&wc)) return true;
  return GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
}

}  // namespace

namespace glc {

bool Init(HWND host) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (g_ready) return true;
  g_host = host;
  g_why.clear();
  if (!ggl::loadBase()) {
    Fail("opengl32.dll missing: %s", ggl::lastError());
    return false;
  }
  if (!BootstrapContext()) {
    Fail("no usable legacy GL context on this machine");
    return false;
  }
  if (!RegisterCanvasClass()) {
    Fail("RegisterClass(mbGLCanvas) failed: %lu", (unsigned long)GetLastError());
    return false;
  }

  g_hwnd = CreateWindowExA(
      0, "mbGLCanvas", "", WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
      0, 0, 16, 16, host, nullptr, GetModuleHandleA(nullptr), nullptr);
  if (!g_hwnd) {
    Fail("CreateWindowEx failed: %lu", (unsigned long)GetLastError());
    return false;
  }
  SetBgBrush();
  if (!CreateContextOn(g_hwnd)) {
    Fail("GL 3.3 core context creation failed (dc=%p rc=%p)", (void*)g_dc,
         (void*)g_rc);
    return false;
  }
  g_renderer = ggl::rendererString();
  g_version = ggl::versionString();

  std::string err;
  g_shadeProg = LinkProgram(kShadeVS, kShadeFS, err);
  if (!g_shadeProg) {
    Fail("shade shader: %s", err.c_str());
    return false;
  }
  g_presentProg = LinkProgram(kPresentVS, kPresentFS, err);
  if (!g_presentProg) {
    Fail("present shader: %s", err.c_str());
    return false;
  }
  ggl::glGenVertexArrays(1, &g_vao);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glDisable(GL_DITHER);

  /* Hand the context back: the render thread owns the drawing from here. */
  wglMakeCurrent(nullptr, nullptr);
  g_ready = true;
  return true;
}

void Shutdown() {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready) return;
  EnsureCurrent();
  if (g_fieldTex) glDeleteTextures(1, &g_fieldTex);
  if (g_sceneTex) glDeleteTextures(1, &g_sceneTex);
  if (g_rampTex) glDeleteTextures(1, &g_rampTex);
  if (g_sceneFbo) ggl::glDeleteFramebuffers(1, &g_sceneFbo);
  if (g_shadeProg) ggl::glDeleteProgram(g_shadeProg);
  if (g_presentProg) ggl::glDeleteProgram(g_presentProg);
  if (g_vao) ggl::glDeleteVertexArrays(1, &g_vao);
  g_fieldTex = g_sceneTex = g_rampTex = g_sceneFbo = 0;
  g_shadeProg = g_presentProg = g_vao = 0;
  wglMakeCurrent(nullptr, nullptr);
  if (g_rc) wglDeleteContext(g_rc);
  if (g_dc && g_hwnd) ReleaseDC(g_hwnd, g_dc);
  g_rc = nullptr;
  g_dc = nullptr;
  if (g_hwnd) DestroyWindow(g_hwnd);
  g_hwnd = nullptr;
  g_ready = false;
}

bool Ready() { return g_ready; }

void SetBounds(int x, int y, int w, int h) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_hwnd) return;
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  SetWindowPos(g_hwnd, nullptr, x, y, w, h,
               SWP_NOZORDER | SWP_NOACTIVATE);
  g_w = w;
  g_h = h;
}

void BeginPass(int passW, int passH, int ss, int cw, int ch) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready) return;
  EnsureCurrent();
  if (ss < 1) ss = 1;
  if (ss > 4) ss = 4;
  g_passW = passW;
  g_passH = passH;
  g_ss = ss;
  g_cw = cw;
  g_ch = ch;
  AllocField(passW, passH);
  // Shade only the visible rectangle; the supersampled pass is box-filtered
  // in the present pass, exactly like the D3D path did.
  AllocScene(std::max(1, cw > 0 ? cw : passW / ss),
             std::max(1, ch > 0 ? ch : passH / ss));
  g_sx = g_sy = 1.0;
  g_ox = g_oy = 0.0;
}

bool UploadFieldTile(const float* f, int fw, int fh, int x, int y) {
  if (!f || fw <= 0 || fh <= 0) return false;
  const double t0 = NowMs();
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready || !g_fieldTex) return false;
  if (x < 0 || y < 0 || x + fw > g_fieldW || y + fh > g_fieldH) return false;
  EnsureCurrent();
  glBindTexture(GL_TEXTURE_2D, g_fieldTex);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, fw, fh, GL_RGBA, GL_FLOAT, f);
  g_fieldNew = true;
  g_rgbaMode = false;
  g_upMs = NowMs() - t0;
  return true;
}

bool UploadRGBATile(const uint8_t* rgba, int fw, int fh, int x, int y,
                    bool topDown) {
  if (!rgba || fw <= 0 || fh <= 0) return false;
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready || !g_sceneTex) return false;
  (void)topDown;
  EnsureCurrent();
  glBindTexture(GL_TEXTURE_2D, g_sceneTex);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, fw, fh, GL_RGBA,
                  GL_UNSIGNED_BYTE, rgba);
  g_rgbaMode = true;
  return true;
}

bool CommitPass() {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready) return false;
  EnsureCurrent();
  const double t0 = NowMs();
  const bool shaded = g_rgbaMode ? true : ShadePass();
  PresentPass();
  g_prMs = NowMs() - t0;
  return shaded;
}

bool CommitPassWithPreview(double sx, double ox, double sy, double oy) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready) return false;
  EnsureCurrent();
  const double t0 = NowMs();
  g_sx = sx; g_ox = ox;
  g_sy = sy; g_oy = oy;
  const bool shaded = g_rgbaMode ? true : ShadePass();
  PresentPass();
  g_prMs = NowMs() - t0;
  return shaded;
}

bool Reshade() { return CommitPass(); }

void Preview(double scale, double dx, double dy, double cx, double cy) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready || scale <= 0.0) return;
  EnsureCurrent();
  // Mirrors the page's blitSnapshot: dest = c + scale*(src - c) + d, so
  // src = (dest - d - c)/scale + c.  Composed onto whatever transform is
  // already showing, so repeated wheel steps accumulate.
  const double inv = 1.0 / scale;
  const double nsx = inv, nox = cx * (1.0 - inv) - dx * inv;
  const double nsy = inv, noy = cy * (1.0 - inv) - dy * inv;
  const double sxo = g_sx, oxo = g_ox;
  const double syo = g_sy, oyo = g_oy;
  g_sx = sxo * nsx;
  g_ox = sxo * nox + oxo;
  g_sy = syo * nsy;
  g_oy = syo * noy + oyo;
  PresentPass();
}

void ResetPreview() {
  std::lock_guard<std::mutex> lk(g_mu);
  g_sx = g_sy = 1.0;
  g_ox = g_oy = 0.0;
}

void SetPreview(double sx, double ox, double sy, double oy) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready) return;
  EnsureCurrent();
  g_sx = sx; g_ox = ox;
  g_sy = sy; g_oy = oy;
  PresentPass();
}

void Present() {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready) return;
  EnsureCurrent();
  PresentPass();
}

void SetPalette(const mbc::Palette& pal, double offset, double iterPerCycle,
                int colorMode, int samples) {
  std::lock_guard<std::mutex> lk(g_mu);
  const bool sameRamp =
      pal.mode == g_st.pal.mode && pal.ns == g_st.pal.ns &&
      std::memcmp(pal.s, g_st.pal.s, sizeof(pal.s)) == 0;
  g_st.pal = pal;
  g_st.offset = offset;
  g_st.iterPerCycle = iterPerCycle > 0.0 ? iterPerCycle : 1.0;
  g_st.colorMode = colorMode;
  g_st.samples = std::min(std::max(samples, 1), 4);
  g_st.dirty = true;
  if (!g_ready) return;
  EnsureCurrent();
  if (pal.mode == 1 && (g_st.rampLevels == 0 || !sameRamp)) BuildRamp();
  else if (pal.mode != 1) g_st.rampLevels = 0;
}

void FieldSize(int* w, int* h) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (w) *w = g_fieldW;
  if (h) *h = g_fieldH;
}

bool ReadPresented(uint8_t* rgba, int w, int h) {
  std::lock_guard<std::mutex> lk(g_mu);
  if (!g_ready || !g_sceneFbo || !rgba || w <= 0 || h <= 0) return false;
  EnsureCurrent();
  // Present the shaded pass, not the window: the window may be covered, and it
  // may be a different size than the pass.
  ggl::glBindFramebuffer(GL_FRAMEBUFFER, g_sceneFbo);
  const int rw = std::min(w, g_sceneW), rh = std::min(h, g_sceneH);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  // GL rows start at the bottom; the product's row 0 is the top of the image.
  std::vector<uint8_t> tmp((size_t)rw * (size_t)rh * 4);
  glReadPixels(0, 0, rw, rh, GL_RGBA, GL_UNSIGNED_BYTE, tmp.data());
  ggl::glBindFramebuffer(GL_FRAMEBUFFER, 0);
  for (int y = 0; y < rh; ++y) {
    std::memcpy(rgba + (size_t)(rh - 1 - y) * (size_t)w * 4,
                tmp.data() + (size_t)y * (size_t)rw * 4, (size_t)rw * 4);
  }
  return true;
}

HWND Hwnd() { return g_hwnd; }
double LastUploadMs() { return g_upMs; }
double LastPresentMs() { return g_prMs; }
int FrameCount() { return g_frames; }
bool GpuShading() { return g_gpuShading; }
const char* RendererString() { return g_renderer.c_str(); }
const char* lastError() { return g_why.empty() ? "ok" : g_why.c_str(); }
const char* VersionString() { return g_version.c_str(); }

}  // namespace glc
