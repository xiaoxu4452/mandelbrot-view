// ---------------------------------------------------------------------------
// gpu_render.h — the GPU backend the shell talks to.
//
// One entry point per event the shell already handles, so host.cpp does not
// need to know whether a frame is produced by the CPU engine, by OpenCL, or
// presented through OpenGL:
//
//   beginPass()        declare the pass surface
//   uploadRGBA()       a CPU-coloured tile arrives
//   renderFieldTile()  OpenCL computes the tile's field and the GPU shades it
//   commit()           shade + present
//   preview()          gesture transform without recomputing
//
// `ready()` is false when the machine has no usable GL 3.3 context; the shell
// then falls back to the D3D11 canvas and, failing that, to the JS canvas.
// `cl()` is independent: a machine can present through GL while iterating on
// the CPU, or iterate on the GPU and fall back to D3D for display.
// ---------------------------------------------------------------------------
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>

#include "mb_core.h"

namespace gpur {

struct Info {
  bool gl = false;
  bool cl = false;
  std::string glRenderer;
  std::string glVersion;
  std::string clDevice;
  std::string clVersion;
  std::string why;      // why a half is missing, for the boot log
};

/** Create the GL canvas (child window on `host`) and the CL context. */
bool init(HWND host);
void shutdown();
bool ready();
bool cl();
const Info& info();

void setBounds(int x, int y, int w, int h);
HWND hwnd();

void beginPass(int passW, int passH, int ss, int cw, int ch);
/** Upload a whole-frame field (4 floats per texel) into the pass surface. */
bool uploadField(const float* f, int w, int h);
bool uploadRGBA(const uint8_t* rgba, int fw, int fh, int x, int y);
bool commit(bool keepPreview, double sx, double ox, double sy, double oy);
void preview(double scale, double dx, double dy, double cx, double cy);
/** Replace the gesture transform (normalised) instead of composing it. */
void setPreview(double sx, double ox, double sy, double oy);
void resetPreview();

void setPalette(const mbc::Palette& pal, double offset, double iterPerCycle,
                int colorMode, int samples);

/** Compute one tile on the GPU and shade it into the pass surface.
 *  Returns false when the tile is outside the kernel's envelope (deep zoom,
 *  a formula the kernel does not implement, an orbit trap) — the caller then
 *  runs the CPU engine for that tile. */
bool renderFieldTile(const mbc::Request& req, double pixelScale,
                     mbc::Stats& st);

/** The last field renderFieldTile() produced (w*h*4 floats, top row first). */
const float* fieldData();
size_t fieldFloats();

/** Read the presented pass back as RGBA (PNG export). */
bool readback(uint8_t* rgba, int w, int h);

double lastKernelMs();
double lastPresentMs();
int frames();

}  // namespace gpur
