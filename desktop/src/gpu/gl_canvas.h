// ---------------------------------------------------------------------------
// gl_canvas.h — the product canvas, rendered by OpenGL 3.3 core.
//
// This module replaces the D3D11 bitblt canvas.  It owns a child HWND with a
// real GL context, a full-frame RGBA32F *field* texture and the colour shader
// that turns that field into pixels — the same split the reference program
// uses (kernel -> tex_smoothiter/tex_dist; fragment shader -> colour).
//
// Why a field instead of RGBA: a tile that arrives later only has to write its
// own rectangle of the field texture, and the shader re-colours the whole
// frame from it.  Progressive passes therefore cost one shade per tile, and a
// palette change costs one shade and no iteration at all.
//
// Colour contract: the shade pass renders into a GL_RGB10_A2 framebuffer
// (see mb_color.h), and the present pass box-filters the supersampled result
// into the window.  Ten bits per channel is the display precision, not eight.
// ---------------------------------------------------------------------------
#pragma once

#include <windows.h>

#include "mb_core.h"

namespace glc {

/** Create the child window, the GL 3.3 core context and the shader programs.
 *  False leaves the product on the previous (D3D11 / JS) path. */
bool Init(HWND host);
void Shutdown();
bool Ready();

/** Move the child window and resize the framebuffer without re-shading. */
void SetBounds(int x, int y, int w, int h);

/** Declare a new pass surface: passW/passH is the engine bitmap, ss the
 *  supersampling factor, cw/ch the page canvas size.  Reallocates the field
 *  texture when the size changes and clears it to "not yet computed". */
void BeginPass(int passW, int passH, int ss, int cw, int ch);

/** Upload one finished tile of the field (4 floats per texel, row-major, top
 *  first) into the pass field texture.  `x`,`y` are pass-space texel coords.
 *  Returns false when the canvas is not ready or the rect is out of range. */
bool UploadFieldTile(const float* f, int fw, int fh, int x, int y);

/** Upload one finished tile of an already-coloured RGBA bitmap.  Used by the
 *  CPU-colour fallback: when the GPU cannot shade, the RGBA still presents
 *  through this canvas instead of falling back to the JS canvas. */
bool UploadRGBATile(const uint8_t* rgba, int fw, int fh, int x, int y, bool topDown);

/** Shade the whole field with the current palette and present. */
bool CommitPass();

/** Promote the pass while keeping the gesture transform that accumulated
 *  during the computation (src = sx*dst + ox, normalised). */
bool CommitPassWithPreview(double sx, double ox, double sy, double oy);

/** Re-shade + present without new field data (palette / tone change only). */
bool Reshade();

/** One gesture-preview step.  Coordinates are normalised by the canvas size. */
void Preview(double scale, double dx, double dy, double cx, double cy);
/** Replace the gesture transform (src = sx*dst + ox, normalised) and present.
 *  Used by pans, which know their total offset and must not compose it twice. */
void SetPreview(double sx, double ox, double sy, double oy);
void ResetPreview();

void Present();

/** Palette / colour state for the shade pass. */
void SetPalette(const mbc::Palette& pal, double offset, double iterPerCycle,
                int colorMode, int samples);

/** Diagnostic: the field texture's current dimensions (0 = none). */
void FieldSize(int* w, int* h);

/** Read the shaded pass back as RGBA8, top row first (PNG export). */
bool ReadPresented(uint8_t* rgba, int w, int h);

HWND Hwnd();
double LastUploadMs();
double LastPresentMs();
int FrameCount();
bool GpuShading();

/** Diagnostics: the GL strings actually in use, and why Init() declined. */
const char* lastError();
const char* RendererString();
const char* VersionString();

}  // namespace glc
