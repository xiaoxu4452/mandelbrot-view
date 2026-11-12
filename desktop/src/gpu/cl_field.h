// ---------------------------------------------------------------------------
// cl_field.h — the iteration kernel, on OpenCL.
//
// This is the same job core/mb_kernels.cpp does on the CPU, expressed as a
// data-parallel kernel: given the frame's view, write one texel per pixel with
//   r = smooth iteration count (negative = negated period, interior)
//   g = distance estimate in pixels
//   b = raw escape count (negative = negated period, interior)
//   a = second distance estimate (see mb_engine.cpp: it is 0 at this bailout)
//
// That is exactly the Field layout the colour shader consumes, so a GPU tile
// and a CPU tile are interchangeable — which is what makes them comparable.
//
// Precision: the kernel runs in `double` (cl_khr_fp64).  A double holds ~2^-52
// relative, and the iteration loses about one bit per step, so it is used up to
// a pixel scale of 2^-40; below that the perturbation path of the CPU core is
// still the only exact one and this module refuses the request (the caller
// falls back).  Refusing honestly is better than painting noise.
// ---------------------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace clf {

struct Caps {
  bool ok = false;
  bool fp64 = false;
  bool interop = false;      // CL can write a GL texture directly
  std::string device;
  std::string driver;
  std::string version;
  int computeUnits = 0;
  int clockMHz = 0;
  size_t maxWorkGroup = 0;
  size_t globalMem = 0;
};

/** Create the context, the queue and the programs.  `glContext`/`glDc` may be
 *  null: the kernels run without interop, the upload just costs a copy. */
bool init(void* glContext, void* glDc);
void shutdown();
bool ready();
const char* lastError();
const Caps& caps();

/** One tile of one frame. */
struct Tile {
  int w = 1, h = 1;          // tile size
  int ox = 0, oy = 0;        // tile origin in frame space
  int fw = 1, fh = 1;        // frame size
  double cre = 0.0, cim = 0.0;
  double px = 1.0;           // pixel size (span / fw)
  double rotC = 1.0, rotS = 0.0;
  int julia = 0;
  int power = 2;
  int maxIter = 600;
  int wantDist = 1;
  double jre = 0.0, jim = 0.0;
};

/** Compute `t` into `out` (t.w * t.h * 4 floats, row-major, top row first).
 *  Returns false when the device is missing, the kernel failed, or the view is
 *  too deep for double. */
bool compute(const Tile& t, float* out);

/** Whether this view is inside the kernel's precision envelope. */
bool supports(double px, int power);

/** Reference orbit and Taylor tables for the perturbation kernel.  The
 *  pointers alias the core's Ref vectors; the caller keeps them alive for the
 *  duration of computePerturb(). */
struct OrbitView {
  const double* re = nullptr;
  const double* im = nullptr;
  const double* ar = nullptr;
  const double* ai = nullptr;
  const double* br = nullptr;
  const double* bi = nullptr;
  const double* cr = nullptr;
  const double* ci = nullptr;
  const int* aExp = nullptr;
  const int* bExp = nullptr;
  const int* cExp = nullptr;
  const double* dcthLog = nullptr;
  const double* jr = nullptr;
  const double* ji = nullptr;
  const double* hr = nullptr;
  const double* hi = nullptr;
  const double* kr = nullptr;
  const double* ki = nullptr;
  const signed char* fR = nullptr;
  const signed char* fI = nullptr;
  int len = 0;
  int skip = 0;
  int derSkip = 0;
  double z0r = 0.0, z0i = 0.0;
};

/** One tile of a perturbation render.  `psMant * 2^psExp` is the pixel pitch,
 *  which stays exact below the double range; `psPixels` is the same value in
 *  doubles (zero at extreme depth) and only feeds the distance estimate. */
struct PerturbTile : Tile {
  OrbitView orbit;
  double psMant = 1.0;
  int psExp = 0;
  double psPixels = 0.0;
  double dRe = 0.0, dIm = 0.0;   // anchor offset from the frame centre
  int kind = 0;
  int dynSkip = 1;
  double phoenixP = -0.5;
};

/** Same field layout as compute(), produced by the deep-zoom perturbation
 *  kernel.  Pixels the reference cannot describe are written with w = -1 and
 *  counted in *glitches (may be null); the caller repairs those exactly like
 *  the CPU engine does. */
bool computePerturb(const PerturbTile& t, float* out, int* glitches);

/** Whether the perturbation kernel can drive this map. */
bool supportsPerturb(int kind, int power);

/** Microseconds of the last compute() (kernel + readback). */
double lastMs();

}  // namespace clf
