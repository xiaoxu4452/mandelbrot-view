// ---------------------------------------------------------------------------
// gl_api.h — OpenGL binding built on the official Khronos headers.
//
//   <GL/gl.h>      Windows SDK, 1.1 core (linked from opengl32.lib)
//   <GL/glext.h>   Khronos registry, every core 1.2+ and extension typedef
//   <GL/wglext.h>  Khronos registry, every WGL extension typedef
//
// The headers live in third_party/khronos/GL and are found first because the
// build passes /I third_party/khronos ahead of the Windows SDK include path.
// Nothing is hand-transcribed: constants, PFN types and prototypes all come
// from the registry, and proc() can resolve *any* extension by name at run
// time, so opting into a new one never requires editing this file.
// ---------------------------------------------------------------------------
#pragma once

#include <windows.h>

#include <GL/gl.h>
#include <GL/glext.h>
#include <GL/wglext.h>

#include <string>
#include <vector>

namespace ggl {

// Strongly-typed entry points actually used by the canvas.  Their types are
// the official PFN*PROC typedefs from glext.h / wglext.h.
#define GL_FN(type, name) extern type name
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

/** Create a current legacy context first, then call loadCore(). */
bool loadBase();
/** Resolve all core/extension entry points; requires a current context. */
bool loadCore();
bool coreLoaded();
bool ready();
const char* lastError();

/** Resolve *any* GL or WGL function by name (the "all extensions" door). */
void* proc(const char* name);
/** Enumerate GL_EXTENSIONS via glGetStringi, or glGetString on GL < 3.0. */
std::vector<std::string> extensions();
bool extensionSupported(const char* name);
/** WGL extension string (ARB extension or the registry's WGL list). */
std::vector<std::string> wglExtensions();
std::string versionString();
std::string rendererString();

}  // namespace ggl
