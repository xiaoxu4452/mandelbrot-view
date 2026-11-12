// ---------------------------------------------------------------------------
// mb_caps.cpp — SDK installation / full-extension regression probe.
//
// Creates a hidden GL 3.3 core context, enumerates every advertised GL, WGL
// and OpenCL extension from the official headers, and prints a compact report.
// Pass --dump <file> to write the complete extension lists.  This is the guard
// that "the SDK is configured completely" means something measurable.
// ---------------------------------------------------------------------------
#include "cl_api.h"
#include "gl_api.h"

#include <windows.h>

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

namespace {

HWND g_hwnd = nullptr;
HDC g_dc = nullptr;
HGLRC g_rc = nullptr;

bool makeWindow() {
  WNDCLASSW wc = {};
  wc.lpfnWndProc = ::DefWindowProcW;
  wc.hInstance = ::GetModuleHandleW(nullptr);
  wc.lpszClassName = L"MBGpuProbeWindow";
  if (!::RegisterClassW(&wc) && ::GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
    return false;
  g_hwnd = ::CreateWindowExW(0, wc.lpszClassName, L"probe", WS_OVERLAPPEDWINDOW,
                             0, 0, 64, 64, nullptr, nullptr, wc.hInstance, nullptr);
  if (!g_hwnd) return false;
  g_dc = ::GetDC(g_hwnd);
  return g_dc != nullptr;
}

bool makeContext() {
  PIXELFORMATDESCRIPTOR pfd = {};
  pfd.nSize = sizeof(pfd);
  pfd.nVersion = 1;
  pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  pfd.iPixelType = PFD_TYPE_RGBA;
  pfd.cColorBits = 32;
  pfd.cAlphaBits = 8;
  pfd.cDepthBits = 24;
  pfd.cStencilBits = 8;
  const int pf = ::ChoosePixelFormat(g_dc, &pfd);
  if (!pf || !::SetPixelFormat(g_dc, pf, &pfd)) return false;

  HGLRC legacy = ::wglCreateContext(g_dc);
  if (!legacy || !::wglMakeCurrent(g_dc, legacy)) return false;

  // The ARB context-creation entry point is itself an extension: resolve it
  // on the legacy context before asking for 3.3 core.
  auto createAttribs = reinterpret_cast<PFNWGLCREATECONTEXTATTRIBSARBPROC>(
      ::wglGetProcAddress("wglCreateContextAttribsARB"));
  if (createAttribs) {
    const int attribs[] = {
        WGL_CONTEXT_MAJOR_VERSION_ARB, 3,
        WGL_CONTEXT_MINOR_VERSION_ARB, 3,
        WGL_CONTEXT_PROFILE_MASK_ARB, WGL_CONTEXT_CORE_PROFILE_BIT_ARB,
        0};
    HGLRC core = createAttribs(g_dc, nullptr, attribs);
    if (core) {
      ::wglMakeCurrent(g_dc, nullptr);
      ::wglDeleteContext(legacy);
      g_rc = core;
      if (!::wglMakeCurrent(g_dc, g_rc)) return false;
    }
  }
  if (!g_rc) g_rc = legacy;
  return true;
}

void printGl() {
  std::printf("[gl ] version   : %s\n", ggl::versionString().c_str());
  std::printf("[gl ] renderer  : %s\n", ggl::rendererString().c_str());
  GLint maxTex = 0, max3d = 0, maxUnits = 0, maxAttach = 0, maxSamples = 0;
  ::glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTex);
  ::glGetIntegerv(GL_MAX_3D_TEXTURE_SIZE, &max3d);
  ::glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS, &maxUnits);
  ::glGetIntegerv(GL_MAX_COLOR_ATTACHMENTS, &maxAttach);
  ::glGetIntegerv(GL_MAX_SAMPLES, &maxSamples);
  std::printf("[gl ] limits    : tex2D=%d tex3D=%d units=%d attach=%d samples=%d\n",
              maxTex, max3d, maxUnits, maxAttach, maxSamples);
  std::printf("[gl ] core api  : %s (%s)\n", ggl::coreLoaded() ? "loaded" : "FAILED",
              ggl::lastError());
  const auto e = ggl::extensions();
  const auto w = ggl::wglExtensions();
  std::printf("[gl ] extensions: %zu GL, %zu WGL\n", e.size(), w.size());
  for (const char* n : {"GL_ARB_gpu_shader_fp64", "GL_ARB_compute_shader",
                        "GL_ARB_texture_float", "GL_ARB_color_buffer_float",
                        "GL_EXT_color_buffer_float", "GL_ARB_texture_buffer_object",
                        "GL_ARB_shader_image_load_store", "GL_EXT_texture_filter_anisotropic",
                        "GL_ARB_framebuffer_object", "GL_ARB_pixel_buffer_object"}) {
    if (ggl::extensionSupported(n)) std::printf("[gl ]   + %s\n", n);
  }
  for (const char* n : {"WGL_ARB_create_context", "WGL_ARB_pixel_format",
                        "WGL_EXT_swap_control", "WGL_ARB_extensions_string",
                        "WGL_ARB_pbuffer"}) {
    const auto& v = w;
    bool found = false;
    for (const auto& x : v) if (x == n) found = true;
    if (found) std::printf("[gl ]   + %s\n", n);
  }
}

void printCl() {
  const ocl::Caps& c = ocl::capabilities();
  std::printf("[cl ] available : %s (%s)\n", c.ok ? "yes" : "NO", ocl::lastError());
  if (!c.ok) return;
  std::printf("[cl ] platform  : %s | %s | %s\n", c.platform.c_str(),
              c.platformVendor.c_str(), c.platformVersion.c_str());
  std::printf("[cl ] device    : %s\n", c.device.c_str());
  std::printf("[cl ] driver    : %s | C: %s\n", c.driverVersion.c_str(),
              c.openclCVersion.c_str());
  std::printf("[cl ] fp64      : %s (correctly-rounded div/sqrt=%s, FMA=%s)\n",
              c.fp64 ? "yes" : "NO", c.fp64CorrectlyRounded ? "yes" : "no",
              (c.doubleFpConfig & CL_FP_FMA) ? "yes" : "no");
  std::printf("[cl ] glSharing : %s, zero-copy ready=%s\n",
              c.glSharing ? "yes" : "NO", ocl::glSharingReady() ? "yes" : "NO");
  std::printf("[cl ] units     : %u @ %u MHz, workgroup=%zu, dims=%u\n",
              c.computeUnits, c.maxClockMHz, c.maxWorkGroup, c.maxWorkItemDim);
  std::printf("[cl ] memory    : global=%llu MB local=%llu KB alloc=%llu MB\n",
              static_cast<unsigned long long>(c.globalMem / 1048576),
              static_cast<unsigned long long>(c.localMem / 1024),
              static_cast<unsigned long long>(c.maxMemAlloc / 1048576));
  std::printf("[cl ] extensions: %zu platform, %zu device\n",
              c.platformExtensions.size(), c.deviceExtensions.size());
  for (const char* n : {"cl_khr_fp64", "cl_khr_gl_sharing", "cl_khr_fp16",
                        "cl_khr_global_int32_base_atomics", "cl_khr_image2d_from_buffer",
                        "cl_amd_device_attribute_query", "cl_khr_d3d11_sharing"}) {
    if (ocl::extensionSupported(n)) std::printf("[cl ]   + %s\n", n);
  }
}

void dump(const char* path) {
  std::ofstream f(path);
  if (!f) return;
  f << "# GL extensions (" << ggl::extensions().size() << ")\n";
  for (const auto& s : ggl::extensions()) f << s << "\n";
  f << "\n# WGL extensions (" << ggl::wglExtensions().size() << ")\n";
  for (const auto& s : ggl::wglExtensions()) f << s << "\n";
  const auto& c = ocl::capabilities();
  f << "\n# OpenCL platform extensions (" << c.platformExtensions.size() << ")\n";
  for (const auto& s : c.platformExtensions) f << s << "\n";
  f << "\n# OpenCL device extensions (" << c.deviceExtensions.size() << ")\n";
  for (const auto& s : c.deviceExtensions) f << s << "\n";
  std::printf("[all] full extension dump -> %s\n", path);
}

}  // namespace

int main(int argc, char** argv) {
  const char* dumpPath = nullptr;
  for (int i = 1; i + 1 < argc; ++i)
    if (std::string(argv[i]) == "--dump") dumpPath = argv[i + 1];

  if (!ggl::loadBase()) {
    std::printf("[gl ] loadBase failed: %s\n", ggl::lastError());
    return 1;
  }
  const bool win = makeWindow();
  const bool ctx = win && makeContext();
  if (ctx) ggl::loadCore();
  std::printf("[gl ] window=%d context=%d\n", win ? 1 : 0, ctx ? 1 : 0);
  if (ctx) printGl();
  printCl();
  if (dumpPath) dump(dumpPath);

  const ocl::Caps& c = ocl::capabilities();
  const bool pass = ctx && ggl::coreLoaded() && c.ok && c.fp64;
  std::printf("RESULT: %s\n", pass ? "PASS" : "FAIL");
  ::wglMakeCurrent(g_dc, nullptr);
  if (g_rc) ::wglDeleteContext(g_rc);
  if (g_hwnd) ::DestroyWindow(g_hwnd);
  return pass ? 0 : 1;
}
