// ---------------------------------------------------------------------------
// gl_api.cpp — official-header runtime binding.  GL 1.1 comes from
// opengl32.lib; everything newer is wglGetProcAddress, with a GetProcAddress
// fallback for entry points the ICD happens to export directly.
// ---------------------------------------------------------------------------
#include "gl_api.h"

#include <algorithm>
#include <cstdint>

namespace ggl {

#define GL_FN(type, name) type name = nullptr
GL_FN(PFNGLCREATESHADERPROC, glCreateShader);
GL_FN(PFNGLDELETESHADERPROC, glDeleteShader);
GL_FN(PFNGLSHADERSOURCEPROC, glShaderSource);
GL_FN(PFNGLCOMPILESHADERPROC, glCompileShader);
GL_FN(PFNGLGETSHADERIVPROC, glGetShaderiv);
GL_FN(PFNGLGETSHADERINFOLOGPROC, glGetShaderInfoLog);
GL_FN(PFNGLCREATEPROGRAMPROC, glCreateProgram);
GL_FN(PFNGLDELETEPROGRAMPROC, glDeleteProgram);
GL_FN(PFNGLATTACHSHADERPROC, glAttachShader);
GL_FN(PFNGLLINKPROGRAMPROC, glLinkProgram);
GL_FN(PFNGLGETPROGRAMIVPROC, glGetProgramiv);
GL_FN(PFNGLGETPROGRAMINFOLOGPROC, glGetProgramInfoLog);
GL_FN(PFNGLUSEPROGRAMPROC, glUseProgram);
GL_FN(PFNGLGETUNIFORMLOCATIONPROC, glGetUniformLocation);
GL_FN(PFNGLUNIFORM1IPROC, glUniform1i);
GL_FN(PFNGLUNIFORM1FPROC, glUniform1f);
GL_FN(PFNGLUNIFORM2FPROC, glUniform2f);
GL_FN(PFNGLUNIFORM3FPROC, glUniform3f);
GL_FN(PFNGLUNIFORM4FPROC, glUniform4f);
GL_FN(PFNGLUNIFORM1FVPROC, glUniform1fv);
GL_FN(PFNGLUNIFORM3FVPROC, glUniform3fv);
GL_FN(PFNGLACTIVETEXTUREPROC, glActiveTexture);
GL_FN(PFNGLGENVERTEXARRAYSPROC, glGenVertexArrays);
GL_FN(PFNGLBINDVERTEXARRAYPROC, glBindVertexArray);
GL_FN(PFNGLDELETEVERTEXARRAYSPROC, glDeleteVertexArrays);
GL_FN(PFNGLGENFRAMEBUFFERSPROC, glGenFramebuffers);
GL_FN(PFNGLBINDFRAMEBUFFERPROC, glBindFramebuffer);
GL_FN(PFNGLFRAMEBUFFERTEXTURE2DPROC, glFramebufferTexture2D);
GL_FN(PFNGLCHECKFRAMEBUFFERSTATUSPROC, glCheckFramebufferStatus);
GL_FN(PFNGLDELETEFRAMEBUFFERSPROC, glDeleteFramebuffers);
GL_FN(PFNGLGENBUFFERSPROC, glGenBuffers);
GL_FN(PFNGLBINDBUFFERPROC, glBindBuffer);
GL_FN(PFNGLBUFFERDATAPROC, glBufferData);
GL_FN(PFNGLENABLEVERTEXATTRIBARRAYPROC, glEnableVertexAttribArray);
GL_FN(PFNGLVERTEXATTRIBPOINTERPROC, glVertexAttribPointer);
GL_FN(PFNGLGETSTRINGIPROC, glGetStringi);
GL_FN(PFNGLTEXSTORAGE2DPROC, glTexStorage2D);
GL_FN(PFNGLTEXIMAGE2DMULTISAMPLEPROC, glTexImage2DMultisample);
GL_FN(PFNGLBLITFRAMEBUFFERPROC, glBlitFramebuffer);
GL_FN(PFNWGLCREATECONTEXTATTRIBSARBPROC, wglCreateContextAttribsARB);
GL_FN(PFNWGLCHOOSEPIXELFORMATARBPROC, wglChoosePixelFormatARB);
GL_FN(PFNWGLSWAPINTERVALEXTPROC, wglSwapIntervalEXT);
GL_FN(PFNWGLGETEXTENSIONSSTRINGARBPROC, wglGetExtensionsStringARB);
#undef GL_FN

namespace {
HMODULE g_mod = nullptr;
bool g_base = false;
bool g_core = false;
std::string g_error;
std::vector<std::string> g_extCache, g_wglCache;

bool validProc(FARPROC p) {
  const auto v = reinterpret_cast<uintptr_t>(p);
  return p != nullptr && v > 4;  // 1,2,3,-1 are wglGetProcAddress failures
}

/** Every extension-capable process goes through here. */
FARPROC resolve(const char* name) {
  FARPROC p = ::wglGetProcAddress(name);
  if (validProc(p)) return p;
  if (g_mod) p = ::GetProcAddress(g_mod, name);
  return validProc(p) ? p : nullptr;
}

template <typename T>
bool load(T& fn, const char* name, bool required) {
  fn = reinterpret_cast<T>(resolve(name));
  if (!fn && required) g_error = std::string("GL entry point missing: ") + name;
  return fn != nullptr;
}

std::vector<std::string> split(const std::string& s) {
  std::vector<std::string> out;
  size_t a = 0;
  while (a < s.size()) {
    const size_t b = s.find(' ', a);
    const std::string t = s.substr(a, b == std::string::npos ? b : b - a);
    if (!t.empty()) out.push_back(t);
    if (b == std::string::npos) break;
    a = b + 1;
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

#define LOAD_R(name) ok &= load(name, #name, true)
#define LOAD_O(name) load(name, #name, false)

}  // namespace

bool loadBase() {
  if (g_base) return true;
  g_mod = ::LoadLibraryW(L"opengl32.dll");
  if (!g_mod) {
    g_error = "opengl32.dll not found";
    return false;
  }
  g_base = true;
  return true;
}

bool loadCore() {
  if (g_core) return true;
  if (!g_base && !loadBase()) return false;
  if (!::wglGetCurrentContext()) {
    g_error = "no current GL context (wglGetProcAddress needs one)";
    return false;
  }
  bool ok = true;
  LOAD_R(glCreateShader);
  LOAD_R(glDeleteShader);
  LOAD_R(glShaderSource);
  LOAD_R(glCompileShader);
  LOAD_R(glGetShaderiv);
  LOAD_R(glGetShaderInfoLog);
  LOAD_R(glCreateProgram);
  LOAD_R(glDeleteProgram);
  LOAD_R(glAttachShader);
  LOAD_R(glLinkProgram);
  LOAD_R(glGetProgramiv);
  LOAD_R(glGetProgramInfoLog);
  LOAD_R(glUseProgram);
  LOAD_R(glGetUniformLocation);
  LOAD_R(glUniform1i);
  LOAD_R(glUniform1f);
  LOAD_R(glUniform2f);
  LOAD_R(glUniform3f);
  LOAD_R(glUniform4f);
  LOAD_R(glUniform1fv);
  LOAD_R(glUniform3fv);
  LOAD_R(glActiveTexture);
  LOAD_R(glGenVertexArrays);
  LOAD_R(glBindVertexArray);
  LOAD_R(glDeleteVertexArrays);
  LOAD_R(glGenFramebuffers);
  LOAD_R(glBindFramebuffer);
  LOAD_R(glFramebufferTexture2D);
  LOAD_R(glCheckFramebufferStatus);
  LOAD_R(glDeleteFramebuffers);
  LOAD_R(glGenBuffers);
  LOAD_R(glBindBuffer);
  LOAD_R(glBufferData);
  LOAD_R(glEnableVertexAttribArray);
  LOAD_R(glVertexAttribPointer);
  LOAD_O(glGetStringi);
  LOAD_O(glTexStorage2D);
  LOAD_O(glTexImage2DMultisample);
  LOAD_O(glBlitFramebuffer);
  LOAD_O(wglCreateContextAttribsARB);
  LOAD_O(wglChoosePixelFormatARB);
  LOAD_O(wglSwapIntervalEXT);
  LOAD_O(wglGetExtensionsStringARB);
  g_core = ok;
  return g_core;
}

bool coreLoaded() { return g_core; }
bool ready() { return g_base && g_core; }
const char* lastError() { return g_error.empty() ? "ok" : g_error.c_str(); }

void* proc(const char* name) { return reinterpret_cast<void*>(resolve(name)); }

std::vector<std::string> extensions() {
  if (!g_extCache.empty()) return g_extCache;
  if (!::wglGetCurrentContext()) return {};
  if (glGetStringi) {
    GLint n = 0;
    ::glGetIntegerv(GL_NUM_EXTENSIONS, &n);
    for (GLint i = 0; i < n; ++i) {
      const GLubyte* s = glGetStringi(GL_EXTENSIONS, static_cast<GLuint>(i));
      if (s) g_extCache.push_back(reinterpret_cast<const char*>(s));
    }
  } else {
    const GLubyte* s = ::glGetString(GL_EXTENSIONS);
    if (s) g_extCache = split(reinterpret_cast<const char*>(s));
  }
  std::sort(g_extCache.begin(), g_extCache.end());
  return g_extCache;
}

bool extensionSupported(const char* name) {
  const auto& e = extensions();
  return std::binary_search(e.begin(), e.end(), std::string(name));
}

std::vector<std::string> wglExtensions() {
  if (!g_wglCache.empty()) return g_wglCache;
  HDC dc = ::wglGetCurrentDC();
  if (wglGetExtensionsStringARB) {
    const char* s = wglGetExtensionsStringARB(dc);
    if (s) g_wglCache = split(s);
  } else {
    auto p = reinterpret_cast<PFNWGLGETEXTENSIONSSTRINGEXTPROC>(proc("wglGetExtensionsStringEXT"));
    if (p) g_wglCache = split(p());
  }
  return g_wglCache;
}

std::string versionString() {
  if (!loadBase()) return {};
  const GLubyte* s = ::glGetString(GL_VERSION);
  return s ? reinterpret_cast<const char*>(s) : std::string();
}
std::string rendererString() {
  if (!loadBase()) return {};
  const GLubyte* s = ::glGetString(GL_RENDERER);
  return s ? reinterpret_cast<const char*>(s) : std::string();
}

#undef LOAD_R
#undef LOAD_O

}  // namespace ggl
