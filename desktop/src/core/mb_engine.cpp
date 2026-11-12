// ------------------------------------------------------------------
// mb_engine.cpp — tiles, threads and the frame as a whole.
//
// Everything here is about *many* pixels: how the frame is cut, which thread
// gets which strip, how the known-values canvas lets a tile be interpolated
// instead of iterated, and where the iteration limit comes from.
//
// The limit is the one piece of policy in the file, and it is a transcription
// rather than a choice — see the comment above vertexIterBudget().
// ------------------------------------------------------------------
#include "mb_internal.h"
#include <cstring>
#include <cstdio>
#include <cstdlib>

namespace mbc {

using namespace detail;

/* Fingerprint of everything that can change the colour of a vertex.
 *
 * The canvas caches *already shaded* vertices, so reusing a grid after a
 * palette edit, a tone change, a phase shift or a rotation would leave whole
 * interpolated cells in the old colours while the raster pixels update — a
 * visible patchwork.  The reference avoids this with its per-AREA
 * computecycle; an appearance fingerprint is the equivalent here. */
static uint64_t appearanceKey(const Request& q, const Palette& P,
                              double ipc, double rotation) {
  uint64_t h = 14695981039346656037ULL;
  auto mix = [&](uint64_t v) { h ^= v; h *= 1099511628211ULL; };
  auto mixf = [&](double v) {
    uint64_t u = 0;
    std::memcpy(&u, &v, sizeof(u));
    mix(u);
  };
  mix((uint64_t)(unsigned)P.mode);
  mix((uint64_t)(unsigned)P.n);
  mix((uint64_t)(unsigned)P.ns);
  for (int i = 0; i < P.n; ++i) {
    mixf(P.c[i].r); mixf(P.c[i].g); mixf(P.c[i].b);
    mixf(P.c[i].frequency); mixf(P.c[i].initial);
  }
  for (int i = 0; i < P.ns; ++i) {
    mixf(P.s[i].pos); mixf(P.s[i].r); mixf(P.s[i].g); mixf(P.s[i].b);
  }
  const double tones[] = {
      P.brightnessFinite, P.brightnessInfinite, P.brightnessFactor,
      P.cycleRef, P.brightness, P.contrast, P.gamma, P.saturation,
      P.gainR, P.gainG, P.gainB};
  for (double v : tones) mixf((double)v);
  mixf(q.offset); mixf(q.cycle); mixf((double)q.bands);
  mixf((double)q.detail); mixf((double)q.colorMode); mixf(rotation);
  mixf(ipc); mixf((double)q.maxIter);
  mixf(q.spec.juliaRe); mixf(q.spec.juliaIm);
  return h;
}

/* The reference program has no maxiter = f(zoom): none of its 25 example
 * JSONs carries an iteration key, and the disassembly contains no expression
 * linking the pixel scale to the iteration limit.  What it does have is a
 * *canvas observation* loop.  These constants are transcribed verbatim from
 * `07_反汇编与伪代码/Ghidra/full_pseudocode/0046f630.c`
 * (processcanvasfinite_hfloat):
 *
 *   :81-99   uVar17 = max(iter) over the four corner vertices that are known
 *   :104-108 if no corner is known:
 *              uVar17 = 0x2aaaa2da;
 *              if (canvas->maxiter != 0) uVar17 = canvas->maxiter * 5;
 *   :114     maxiter = uVar17 * 3 + 3000;
 *   :135/225 canvas->maxiter = max(canvas->maxiter, observed iteration)
 *   :197     if (cvalue->maxiter < uVar17 * 3 + 1000) recalculate
 *
 * `ITER maxiter` is then passed to calciter*() as the per-pixel loop bound
 * (`while (i < maxiter)`).  `canvas->maxiter` is *observed state*, not a
 * user setting.  initcanvas_hfloat (0044e970.c:142,147,245) seeds it with
 * 0 / 200000000 / 10000000 depending on the mode, and worker_move
 * (00429d50.c:185) sets idle_maxiter = 0x7fffffff for idle continuation. */
constexpr int kVertexSlack = 3000;
constexpr int kVertexGate = 1000;
constexpr int kNoVertexSentinel = 0x2aaaa2da;
constexpr int kIterHardCap = 200000;
constexpr int kDefaultIterations = 600;
constexpr int kMaxIdlePasses = 3;

int vertexIterBudget(int known, int observedMax) {
  long long b;
  if (known > 0) b = (long long)known * 3 + kVertexSlack;
  else if (observedMax > 0) b = (long long)observedMax * 5;
  else b = (long long)kNoVertexSentinel;
  if (b < kVertexSlack) b = kVertexSlack;
  if (b > kIterHardCap) b = kIterHardCap;   // the sentinel means "unbounded"
  return (int)b;
}

int requiredBits(double psLog2, int maxIter) {
  double need = -psLog2 + 64.0;
  if (maxIter > 1) need += std::log2((double)maxIter);
  if (!(need > 64.0)) need = 64.0;
  if (need > 16384.0) need = 16384.0;
  int b = (int)(std::ceil(need / 64.0) * 64.0);
  if (b < 96) b = 96;
  return b;
}




/* ------------------------------------------------------------------
 * Area canvas: 2^canvassizeshift pixels, quadtree inside.
 *
 * Structure transcribed from `07_反汇编与伪代码/Ghidra/full_pseudocode`:
 *
 *   004325a0 canvas_calc_init       fixed shift 7  -> 128 px per area
 *   004bacd0 initcanvas_*           (2^shift+1)^2 vertices
 *   004c74a0 subdividecanvas_*      quadtree split, i+2^(7-d) stride
 *   004d6000 processcanvas_*        corners first, then depth 1..7
 *   004c7810 processcanvasfinite_*  only queued vertices are integrated
 *   004c6620 superinterpol_*        corner values + derivatives fill a block
 *   004c6bd0 caccurateinterpolquadratic_*  second-difference residual vs
 *                                   ldexp(k, -5-depth): the tolerance halves
 *                                   with every level
 *   004cec40 interpolcanvas_*       a cell that fails is split, not iterated
 *                                   pixel by pixel
 *   004c9a70 rendercanvas_*         9 float channels out of the canvas
 *   00522180 drawarea               one 128^2 texture per area, parent
 *                                   sub-rect 0x40/0x20/0x10 while a child
 *                                   is not ready
 *
 * What is *ours* rather than transcribed (and therefore has to earn its
 * keep by measurement):
 *
 *   - The iterated quantity is the smooth iteration count, not the complex
 *     map value.  Our kernels return (escape count, |z|^2, relative
 *     deviation, |dz|^2); they do not hand back z and dz/dc, and the
 *     reference's Hermite patch needs exactly those.  The smooth count is
 *     continuous across band edges (that is how it is defined), so it is the
 *     interpolatable scalar this pipeline can offer.
 *   - The residual is the discrete mixed second difference of the four
 *     corner values, and the tolerance is kCanvasTol0 * 2^-depth in
 *     *iterations*.  0.05 iterations is 1/240 of a 12-iteration palette
 *     cycle, i.e. below one 8-bit step.  The reference's tolerance is the
 *     same shape (relative, `ldexp(k, -5-depth)`) on its own value field.
 *   - A cell that is large enough to hide a filament gets one centre probe;
 *     the measured bulge becomes a quadratic correction term in the fill, so
 *     the block is not a flat bilinear ramp.  This is the "four corner values
 *     + derivatives" patch reduced to the data we actually have.
 *   - The parent sub-rect of 00522180 is replaced by the exact rasteriser:
 *     every pixel a cell could not interpolate is left unflagged and is
 *     integrated by the four-wide kernel, which is never staler than a
 *     parent texture and never less accurate.
 *
 * Channels: only the smooth count is interpolated.  The integer escape
 * count is derived from it (floor) and the distance estimate is *not*
 * interpolated — it is a non-linear function of z and dz that the canvas
 * does not carry, so distance-scheme frames stay on the raster.
 * ------------------------------------------------------------------ */
namespace {
/* Tolerance in iterations at the root of an area; halves per level.  Tuning
 * knob: MB_CVTOL overrides it, so the trade-off can be measured rather than
 * guessed. */
static double canvasTol0() {
  static const double v = [] {
    const char* s = std::getenv("MB_CVTOL");
    return s ? std::atof(s) : 0.5;
  }();
  return v > 0.0 ? v : 1e9;
}

/* How many iterations one unit of error in the complex value is worth at the
 * escape radius.
 *
 *   si = n - log2(log2 |z|^2)   =>   d si / d|z| = 1 / (ln2^2 * |z| * ln|z|)
 *
 * The reference compares its residual in the *value* domain against
 * `ldexp(k, -5-depth)`.  Our tolerance is in iterations, so a residual in z has
 * to be converted before the two can be compared — which is exactly this
 * factor.  Interpolating the value instead of the count is what makes the
 * comparison meaningful: the count is continuous but its second difference is
 * not a curvature, while z_n is a polynomial in c and its second difference is.
 */
static double siPerUnitZ(double m2) {
  const double r = std::sqrt(std::max(m2, 1.0));
  const double lr = std::log(std::max(r, 1.0000001));
  return 1.0 / (0.48045301391820142 * r * lr);
}

struct CVertQ {
  double zr = 0.0, zi = 0.0;   // value at iteration n (holomorphic kinds only)
  double dr = 0.0, di = 0.0;   // dz/dc at the same iteration
  /* dz/dx and dz/dy in screen pixels, i.e. dz/dc times dc/d(screen).  The
   * canvas fills a cell with a bicubic Hermite patch built from the four
   * corner values and these two tangents; the reference's `superinterpol`
   * does the same with CVALUE::d, which is why a bilinear patch needed a
   * centre probe on every cell to stay honest. */
  double zxr = 0.0, zxi = 0.0;
  double zyr = 0.0, zyi = 0.0;
  double m2 = 0.0, rel = 0.0;  // what the kernel actually returned
  float si = 0.0f;             // smooth iteration (escaped) / -1-period
  int n = 0;                   // escape count, or -1-period
  uint8_t st = 0;              // 0 unknown, 1 known, 2 glitch
  bool hasZ = false;           // the value/derivative pair is usable
};

struct CQOut {
  int cells = 0;        // nodes visited
  int accepted = 0;     // nodes filled
  int rejects = 0;      // nodes that could not be filled at tolerance
  int filled = 0;       // pixels written
  int verts = 0;        // vertices integrated
  int bounded = 0;      // interior pixels filled
  int maxN = 0, escLo = INT32_MAX, escHi = -1;
  long long iters = 0;  // map iterations performed here
  /* Why cells were split.  Without these the acceptance rate is a single
   * number that cannot be acted on; with them the next step is obvious. */
  int rBand = 0;        // corners disagree on the escape count
  int rRes = 0;         // second-difference residual over tolerance
  int rCenter = 0;      // centre probe disagrees with the patch
  int rInterior = 0;    // mixed interior/escape cell
  int rGlitch = 0;      // vertex the reference could not describe
  int holes = 0;        // pixels left for the raster after the parent fallback
  /* Hard ceiling on scalar vertex work per tile.  A quadtree that keeps
   * splitting is strictly more expensive than the four-wide raster, so the
   * canvas is only allowed to spend a small fraction of the pixels on
   * vertices; past that it stops and hands the rest to the raster.  Without
   * this guard a busy frame (filaments everywhere) would be slower, not
   * faster — measured, not assumed. */
  int vertBudget = 0;
  bool aborted = false;
};

/* Interpolate one accepted cell.  `k` is the measured centre bulge; the
 * bubble u(1-u)v(1-v) vanishes on all four edges and at the corners, so the
 * patch still reproduces the four corner values exactly. */
struct CFill {
  uint8_t* out;
  int pitch, w, h;
  std::vector<uint8_t>* done;
  const Ctx* g;
  CQOut* o;
  double tol;
  bool onlyHoles = false;      // parent sub-rect fallback: fill gaps only
};

/* Count-domain fill (non-holomorphic families, and the fallback when the
 * value domain is not available). */
static void canvasFillCell(const CFill& f, int x0, int y0, int s, double sa,
                           double sb, double sc, double sd, double k,
                           bool interior, int ni) {
  const int xa = std::max(0, x0), xb = std::min(f.w, x0 + s);
  const int ya = std::max(0, y0), yb = std::min(f.h, y0 + s);
  if (xa >= xb || ya >= yb) return;
  const double inv = 1.0 / (double)s;
  /* u = (x - x0)/s, not (x - x0 + 0.5)/s: a vertex at integer index x0 is the
   * kernel's sample of pixel x0 itself, so the parameter must be zero at x0.
   * The half-pixel variant is a systematic sub-pixel shift of the whole
   * interpolated field, which at 192 iterations per pixel reads as a large
   * colour offset — it was measured at mean 15.5/255 before this fix. */
  for (int y = ya; y < yb; ++y) {
    const double v = ((double)y - (double)y0) * inv;
    uint8_t* row = f.out + (size_t)y * (size_t)f.pitch * 4;
    uint8_t* drow = f.done->data() + (size_t)y * (size_t)f.w;
    for (int x = xa; x < xb; ++x) {
      if (f.onlyHoles && drow[x]) continue;
      uint8_t* px = row + (size_t)x * 4;
      if (interior) {
        shade(px, *f.g, ni, 0.0, 0.0, 0.0);
      } else {
        const double u = ((double)x - (double)x0) * inv;
        const double si = sa * (1.0 - u) * (1.0 - v) + sb * u * (1.0 - v) +
                          sc * (1.0 - u) * v + sd * u * v +
                          k * 16.0 * u * (1.0 - u) * v * (1.0 - v);
        double fl = std::floor(si);
        if (!(fl >= 0.0)) fl = 0.0;
        const int n = (int)fl;
        /* shade() reads the smooth count through |z|^2.  Solve for the |z|^2
         * that reproduces `si` exactly: smoothIteration(n, m2, 0) =
         * n - log2(log2 m2), so log2 m2 = 2^(n - si). */
        const double m2 = std::exp2(std::exp2((double)n - si));
        shade(px, *f.g, n, m2, 0.0, 0.0);
      }
      px[3] = 255;
      drow[x] = 1;
      ++f.o->filled;
    }
  }
  ++f.o->accepted;
}

/* The same patch evaluated at the centre, u = v = 1/2.  The Hermite basis
 * collapses to [1/2, 1/8, 1/2, -1/8], which multiplies out to the corner
 * average plus the two tangent imbalances — cheap enough to use as the
 * per-cell accuracy check on every node of eight pixels or more. */
static inline void hermiteCentre(const CVertQ& A, const CVertQ& B,
                                 const CVertQ& C, const CVertQ& D, double su,
                                 double& zr, double& zi) {
  const double c = 0.0625 * su;
  zr = 0.25 * (A.zr + B.zr + C.zr + D.zr) +
       c * ((A.zyr - C.zyr) + (B.zyr - D.zyr)) +
       c * ((A.zxr + C.zxr) - (B.zxr + D.zxr));
  zi = 0.25 * (A.zi + B.zi + C.zi + D.zi) +
       c * ((A.zyi - C.zyi) + (B.zyi - D.zyi)) +
       c * ((A.zxi + C.zxi) - (B.zxi + D.zxi));
}

/* Value-domain fill, bicubic Hermite.
 *
 * `superinterpol` (004c6620) is a Catmull-Rom patch: the 0.5 / 1.5 / 2.0
 * constants it multiplies CVALUE::d with are exactly that kernel's
 * coefficients.  The earlier version here was bilinear plus one hyperbolic
 * bump read from the centre probe, which is not the same function: bilinear
 * cannot carry the corner tangents at all, so every cell needed a centre
 * probe to stay honest and the tree still rejected most of them (62k cells
 * for a 512x384 frame, i.e. nearly every one split to the 1 px floor).
 *
 * A Hermite patch built from the four corner values and their two tangents
 * is exactly determined by what the kernel already returns — ValueProbe
 * carries dz/dc at the escape point, and dc/d(screen) is the rotation the
 * view already applies.  The mixed derivative Puv is left at zero.
 *
 * Parameterisation note: u = (x - x0)/s, so a tangent per pixel has to be
 * scaled by s before it is a derivative with respect to u.
 */
static void canvasFillCellZ(const CFill& f, int x0, int y0, int s, int n,
                            const CVertQ& A, const CVertQ& B,
                            const CVertQ& C, const CVertQ& D) {
  const int xa = std::max(0, x0), xb = std::min(f.w, x0 + s);
  const int ya = std::max(0, y0), yb = std::min(f.h, y0 + s);
  if (xa >= xb || ya >= yb) return;
  const double inv = 1.0 / (double)s;
  const double su = (double)s;
  /* Rows: [P(0,*), Pu(0,*), P(1,*), Pu(1,*)]
   * Cols: [P(*,0), Pv(*,0), P(*,1), Pv(*,1)]   (Puv = 0) */
  struct Cx { double r, i; };
  const Cx K[4][4] = {
      {{A.zr, A.zi}, {A.zyr * su, A.zyi * su},
       {C.zr, C.zi}, {C.zyr * su, C.zyi * su}},
      {{A.zxr * su, A.zxi * su}, {0.0, 0.0},
       {C.zxr * su, C.zxi * su}, {0.0, 0.0}},
      {{B.zr, B.zi}, {B.zyr * su, B.zyi * su},
       {D.zr, D.zi}, {D.zyr * su, D.zyi * su}},
      {{B.zxr * su, B.zxi * su}, {0.0, 0.0},
       {D.zxr * su, D.zxi * su}, {0.0, 0.0}},
  };
  for (int y = ya; y < yb; ++y) {
    const double v = ((double)y - (double)y0) * inv;
    const double v2 = v * v, v3 = v2 * v;
    const double hv0 = 2.0 * v3 - 3.0 * v2 + 1.0;
    const double hv1 = v3 - 2.0 * v2 + v;
    const double hv2 = -2.0 * v3 + 3.0 * v2;
    const double hv3 = v3 - v2;
    /* Collapse the v axis once per row: four Bezier-like control values
     * along u, each already a Hermite blend of the column pair. */
    double Rr[4], Ri[4];
    for (int i = 0; i < 4; ++i) {
      Rr[i] = hv0 * K[i][0].r + hv1 * K[i][1].r + hv2 * K[i][2].r + hv3 * K[i][3].r;
      Ri[i] = hv0 * K[i][0].i + hv1 * K[i][1].i + hv2 * K[i][2].i + hv3 * K[i][3].i;
    }
    uint8_t* row = f.out + (size_t)y * (size_t)f.pitch * 4;
    uint8_t* drow = f.done->data() + (size_t)y * (size_t)f.w;
    for (int x = xa; x < xb; ++x) {
      if (f.onlyHoles && drow[x]) continue;
      uint8_t* px = row + (size_t)x * 4;
      const double u = ((double)x - (double)x0) * inv;
      const double u2 = u * u, u3 = u2 * u;
      const double hu0 = 2.0 * u3 - 3.0 * u2 + 1.0;
      const double hu1 = u3 - 2.0 * u2 + u;
      const double hu2 = -2.0 * u3 + 3.0 * u2;
      const double hu3 = u3 - u2;
      const double zr = hu0 * Rr[0] + hu1 * Rr[1] + hu2 * Rr[2] + hu3 * Rr[3];
      const double zi = hu0 * Ri[0] + hu1 * Ri[1] + hu2 * Ri[2] + hu3 * Ri[3];
      const double m2 = zr * zr + zi * zi;
      if (m2 > kBail2) {
        shade(px, *f.g, n, m2, 0.0, 0.0);
      } else {
        /* The patch fell back inside the bailout radius: this pixel's own
         * orbit is shorter than the cell's common n, so the value is the
         * wrong quantity here.  The corner count is a better answer than a
         * negative log. */
        const double si = A.si * (1.0 - u) * (1.0 - v) +
                          B.si * u * (1.0 - v) + C.si * (1.0 - u) * v +
                          D.si * u * v;
        const int nn = (int)std::floor(std::max(si, 0.0));
        const double m2c = std::exp2(std::exp2((double)nn - si));
        shade(px, *f.g, nn, m2c, 0.0, 0.0);
      }
      px[3] = 255;
      drow[x] = 1;
      ++f.o->filled;
    }
  }
  ++f.o->accepted;
}

/* Run the area canvas over one tile.  Returns false when it could not run at
 * all (no reference orbit), in which case nothing is flagged and the raster
 * covers the whole tile. */
static bool canvasQuadtree(const Ctx& g, const Request& q, uint8_t* out,
                           int pitch, int w, int h, int vw, int vh,
                           bool perturb, int maxIter,
                           std::vector<uint8_t>& done, CQOut& o) {
  if (!out || w <= 0 || h <= 0) return false;
  const int GWv = w + 2, GHv = h + 2;
  /* Index grid + compact records: a 512 px tile only ever integrates a few
   * thousand vertices, so the grid holds 4-byte indices and the 64-byte value
   * records (z, dz/dc, |z|^2, count) are stored once each.  Storing the full
   * record in the grid would be 514*514*64 = 16.9 MB per tile; this is 1.1 MB. */
  std::vector<int> vIdx((size_t)GWv * (size_t)GHv, 0);
  /* deque, not vector: the recursion holds pointers to the four corners while
   * it evaluates more vertices, and a vector would move them on growth. */
  std::deque<CVertQ> vrec;
  const int area = 1 << 7;                 // shift 7, canvassizeshift
  static const bool useZ = std::getenv("MB_CVNOZ") == nullptr;

  CVertQ deadV;
  deadV.st = 2;
  auto slot = [&](int vx, int vy) -> CVertQ* {
    int& idx = vIdx[(size_t)vy * (size_t)GWv + vx];
    if (!idx) { vrec.push_back(CVertQ()); idx = (int)vrec.size(); }
    return &vrec[(size_t)idx - 1];
  };
  auto evalV = [&](int vx, int vy) -> CVertQ* {
    if (o.aborted) return &deadV;
    if (vx < 0) vx = 0;
    if (vy < 0) vy = 0;
    if (vx > w) vx = w;
    if (vy > h) vy = h;
    CVertQ* V = slot(vx, vy);
    if (V->st) return V;
    /* Frame coordinate, clamped only at the frame edge: a vertex on the
     * shared edge of two areas is the same point in the plane, which is why
     * the two areas agree there without communicating. */
    double fx = (double)(q.tileX + vx);
    double fy = (double)(q.tileY + vy);
    if (fx > (double)(vw - 1)) fx = (double)(vw - 1);
    if (fy > (double)(vh - 1)) fy = (double)(vh - 1);
    double m2 = 0.0, rel = 0.0, der2 = 0.0;
    ValueProbe probe;
    ValueProbe* pp = useZ ? &probe : nullptr;
    const int n = perturb ? pertPixel(g, fx, fy, 0, m2, rel, der2, pp)
                          : directPixel(g, fx, fy, m2, rel, der2, pp);
    ++o.verts;
    if (o.vertBudget > 0 && o.verts > o.vertBudget) o.aborted = true;
    if (n == kGlitch) {
      V->st = 2;
      V->n = kGlitch;
      return V;
    }
    V->n = n;
    V->m2 = m2;
    V->rel = rel;
    if (n >= 0) {
      V->si = (float)smoothIteration(n, m2, rel);
      V->hasZ = probe.hasDer;
      V->zr = probe.zr;
      V->zi = probe.zi;
      V->dr = probe.dr;
      V->di = probe.di;
      /* dz/d(screen) = (dz/dc) * (dc/d(screen)).  screenDelta gives
       *   dcx/dx = ps*rotC, dcy/dx = ps*rotS
       *   dcx/dy = -ps*rotS, dcy/dy = ps*rotC
       * so a rotated view costs nothing extra here. */
      if (probe.valid) {
        const double psC = g.ps * g.rotC, psS = g.ps * g.rotS;
        V->zxr = probe.dr * psC - probe.di * psS;
        V->zxi = probe.dr * psS + probe.di * psC;
        V->zyr = -probe.dr * psS - probe.di * psC;
        V->zyi = probe.dr * psC - probe.di * psS;
      }
      o.iters += (long long)n + 1;
    } else {
      /* Interior: the encoded period, which is a constant of the region.
       * No iteration is charged: the kernels bail out on the bulb test
       * without running the limit, and the same convention is applied to the
       * raster, so the two paths stay comparable. */
      V->si = (float)(-1 - n);
      V->hasZ = false;
    }
    V->st = 1;
    return V;
  };

  CFill f{out, pitch, w, h, &done, &g, &o, canvasTol0(), false};
  std::function<bool(int, int, int, int)> rec = [&](int x0, int y0, int s,
                                                    int d) -> bool {
    if (x0 >= w || y0 >= h || x0 + s <= 0 || y0 + s <= 0) return true;
    ++o.cells;
    CVertQ* A = evalV(x0, y0);
    CVertQ* B = evalV(x0 + s, y0);
    CVertQ* C = evalV(x0, y0 + s);
    CVertQ* D = evalV(x0 + s, y0 + s);
    auto split = [&](int x0_, int y0_, int s_, int d_) -> void {
      const int h2 = s_ / 2;
      rec(x0_, y0_, h2, d_ + 1);
      rec(x0_ + h2, y0_, h2, d_ + 1);
      rec(x0_, y0_ + h2, h2, d_ + 1);
      rec(x0_ + h2, y0_ + h2, h2, d_ + 1);
    };
    /* Parent sub-rect fallback (drawarea 00522180 draws a 0x40/0x20/0x10
     * sub-rectangle of the parent texture when a child is not ready).  Ours is
     * the same idea in the vertical direction: before a cell is given up, its
     * best available approximation is written into the pixels nobody has
     * claimed yet, so a moving frame never shows a hole. */
    auto topUp = [&](const CVertQ* a, const CVertQ* b, const CVertQ* c,
                     const CVertQ* e) {
      if (s <= 1) return;
      const bool ina = a && a->st == 1, inb = b && b->st == 1;
      const bool inc = c && c->st == 1, ine = e && e->st == 1;
      const int known = (int)ina + (int)inb + (int)inc + (int)ine;
      if (known < 3) return;               // no usable corner: raster wins
      auto orDefault = [](const CVertQ* p, const CVertQ* q, double& si) {
        si = (p && p->st == 1) ? (double)p->si : (q ? (double)q->si : 0.0);
      };
      double sa, sb, sc, sd;
      orDefault(a, b, sa);
      orDefault(b, a, sb);
      orDefault(c, a, sc);
      orDefault(e, b, sd);
      CFill h = f;
      h.onlyHoles = true;
      canvasFillCell(h, x0, y0, s, sa, sb, sc, sd, 0.0, false, 0);
    };

    if (A->st != 1 || B->st != 1 || C->st != 1 || D->st != 1) {
      /* A glitch or a vertex we could not evaluate: the raster owns this
       * cell, and it is the only path that can repair it. */
      ++o.rejects;
      ++o.rGlitch;
      topUp(A, B, C, D);
      return false;
    }
    if (s == 1) {
      /* 1 px: the top-left corner *is* the pixel.  This level is not
       * interpolated — it is the exact kernel answer, so a leaf pixel is
       * byte-identical to what the raster would have produced.  The reference
       * stops at interpoldepth == canvassizeshift for the same reason
       * (004cec40:181,193). */
      uint8_t* px = f.out + (size_t)y0 * (size_t)pitch * 4 + (size_t)x0 * 4;
      uint8_t* drow = done.data() + (size_t)y0 * (size_t)w;
      if (!drow[x0]) {
        if (A->n < 0) {
          shade(px, g, A->n, 0.0, 0.0, 0.0);
          ++o.bounded;
        } else {
          shade(px, g, A->n, A->m2, A->rel, 0.0);
          if (A->n > o.maxN) o.maxN = A->n;
          if (A->n < o.escLo) o.escLo = A->n;
          if (A->n > o.escHi) o.escHi = A->n;
        }
        px[3] = 255;
        drow[x0] = 1;
        ++o.filled;
      }
      ++o.accepted;
      return true;
    }
    const bool inA = A->n < 0, inB = B->n < 0, inC = C->n < 0, inD = D->n < 0;
    if (inA || inB || inC || inD) {
      /* A cell may only be filled from one region: the smooth count is
       * discontinuous across the escape/interior boundary, and the interior
       * encoding (-period) has nothing to do with an escape count. */
      if (inA && inB && inC && inD &&
          A->n == B->n && B->n == C->n && C->n == D->n) {
        /* Four corners of one bulb do not prove the whole cell is inside —
         * a filament can cross it, and filling the cell then paints a band of
         * interior colour straight through a real feature.  Those were the
         * remaining 139/255 errors in the canvas-vs-raster comparison.  The
         * centre vertex is the cheapest witness; inside a bulb the analytic
         * test answers it without iterating at all. */
        if (s >= 8) {
          CVertQ* M = evalV(x0 + s / 2, y0 + s / 2);
          if (M->st != 1 || M->n != A->n) {
            ++o.rejects;
            ++o.rInterior;
            split(x0, y0, s, d);
            topUp(A, B, C, D);
            return false;
          }
        }
        canvasFillCell(f, x0, y0, s, 0, 0, 0, 0, 0.0, true, A->n);
        o.bounded += s * s;
        return true;
      }
      ++o.rejects;
      ++o.rInterior;
      split(x0, y0, s, d);
      topUp(A, B, C, D);
      return false;
    }
    /* The value domain needs four corners that escaped at the *same*
     * iteration: z_n for different n is not one function of c, so
     * interpolating across a band boundary would be meaningless.  The
     * reference refines exactly there too (its accuracy check sees the
     * disagreement in `v.iter`). */
    const bool sameN = A->n == B->n && B->n == C->n && C->n == D->n;
    const bool zOk = useZ && sameN && A->hasZ && B->hasZ && C->hasZ && D->hasZ;
    if (!zOk && useZ && !sameN) ++o.rBand;
    f.tol = canvasTol0() * std::ldexp(1.0, -d);

    double kzr = 0.0, kzi = 0.0;
    if (zOk) {
      /* Coarse screen: the second difference of the four corner values is
       * proportional to the curvature across the cell.  A bicubic patch
       * reproduces part of it from the tangents, so the threshold is relaxed
       * by 8x — but a cell whose corners swing this much is a band boundary
       * or a filament crossing, and no polynomial of this degree will hold it.
       * Cheap to compute and it keeps the centre check from having to catch
       * every one of those on its own. */
      const double rczr = (A->zr - B->zr) - (C->zr - D->zr);
      const double rczi = (A->zi - B->zi) - (C->zi - D->zi);
      const double rz0 = std::hypot(rczr, rczi);
      double m2min = A->m2;
      m2min = std::min(m2min, B->m2);
      m2min = std::min(m2min, C->m2);
      m2min = std::min(m2min, D->m2);
      if (!(rz0 * siPerUnitZ(m2min) <= f.tol * 8.0)) {
        ++o.rejects;
        ++o.rRes;
        split(x0, y0, s, d);
        topUp(A, B, C, D);
        return false;
      }
      /* The patch is bicubic now, so the bilinear second difference is no
       * longer the residual — a Hermite patch reproduces exactly that
       * curvature from the corner tangents.  What is left is what the patch
       * cannot represent, and the only honest way to measure it is to compare
       * the patch against a real orbit: the centre vertex is already computed
       * for the band test below, so its value doubles as the accuracy check.
       * This is the same role `caccurateinterpolquadratic` plays in the
       * reference. */
      if (s >= 8) {
        CVertQ* M = evalV(x0 + s / 2, y0 + s / 2);
        if (M->st != 1 || M->n != A->n || !M->hasZ) {
          ++o.rejects;
          ++o.rCenter;
          split(x0, y0, s, d);
          topUp(A, B, C, D);
          return false;
        }
        double ezr = 0.0, ezi = 0.0;
        hermiteCentre(*A, *B, *C, *D, (double)s, ezr, ezi);
        const double rz = std::hypot(M->zr - ezr, M->zi - ezi);
        const double km2 = M->m2;
        if (!(rz * siPerUnitZ(km2) <= f.tol)) {
          ++o.rejects;
          ++o.rCenter;
          split(x0, y0, s, d);
          topUp(A, B, C, D);
          return false;
        }
        kzr = M->zr - ezr;
        kzi = M->zi - ezi;
      } else {
        /* Below eight pixels there is no centre vertex to check against;
         * the cell is small enough that the patch's own error stays under
         * the tolerance that produced it. */
      }
      canvasFillCellZ(f, x0, y0, s, A->n, *A, *B, *C, *D);
    } else {
      /* Second difference of the four corner values: zero on a linear ramp,
       * proportional to the curvature across the cell.  Tolerance halves with
       * the level, so a cell that is too curved is split rather than filled. */
      const double R =
          std::fabs(((double)A->si - (double)B->si) - ((double)C->si - (double)D->si));
      if (!(R <= f.tol)) {
        ++o.rejects;
        ++o.rRes;
        split(x0, y0, s, d);
        topUp(A, B, C, D);
        return false;
      }
      double k = 0.0;
      if (s >= 8) {
        /* Four agreeing corners can still straddle a filament that passes
         * between them.  One measurement at the centre makes that visible and
         * turns into a quadratic correction instead of being thrown away. */
        CVertQ* M = evalV(x0 + s / 2, y0 + s / 2);
        if (M->st != 1 || M->n < 0) {
          ++o.rejects;
          ++o.rCenter;
          split(x0, y0, s, d);
          topUp(A, B, C, D);
          return false;
        }
        k = (double)M->si - (double)(0.25f * (A->si + B->si + C->si + D->si));
        if (!(std::fabs(k) <= f.tol)) {
          ++o.rejects;
          ++o.rCenter;
          split(x0, y0, s, d);
          topUp(A, B, C, D);
          return false;
        }
      }
      canvasFillCell(f, x0, y0, s, (double)A->si, (double)B->si, (double)C->si,
                     (double)D->si, k, false, 0);
    }
    int mx = A->n, lo = A->n;
    const int ns[3] = {B->n, C->n, D->n};
    for (int i = 0; i < 3; ++i) {
      if (ns[i] > mx) mx = ns[i];
      if (ns[i] < lo) lo = ns[i];
    }
    if (mx > o.maxN) o.maxN = mx;
    if (lo < o.escLo) o.escLo = lo;
    if (mx > o.escHi) o.escHi = mx;
    return true;
  };

  if (perturb && g.refs == nullptr) return false;
  /* Vertices per tile.  Measured: with the old fixed 1/32 of the pixels the
   * budget was exhausted at 8193 in most 512 px tiles, and every cell after
   * that was rejected — the "low acceptance" was this ceiling, not the
   * tolerance.  MB_CVBUDGET=0 removes it. */
  {
    const char* bs = std::getenv("MB_CVBUDGET");
    o.vertBudget = bs ? std::atoi(bs) : (w * h) / 4;
  }
  /* Area grid: one 128 px canvas at a time, like the reference's area
   * quadtree, so a 512 px tile is four areas and not one 512 px canvas. */
  for (int ay = 0; ay < h; ay += area)
    for (int ax = 0; ax < w; ax += area) rec(ax, ay, area, 0);
  for (size_t i = 0; i < done.size(); ++i) if (!done[i]) ++o.holes;
  return true;
}
}  // namespace

#if defined(_MSC_VER)
#define MB_PAUSE() _mm_pause()
#else
#define MB_PAUSE() std::this_thread::yield()
#endif


namespace {
/* One pool for the life of the engine.
 *
 * The first version spawned threads *inside* every parallelFor call.  A
 * progressive pass is 190 tiles and every tile makes several such calls, so a
 * single pass created and joined thousands of threads.  Measured through the
 * shell that was 8x the cost of the work it was meant to parallelise: the
 * 0.74Mpx preview pass took 18.5ms in the benchmark and 161ms in the app for
 * identical pixels.  Spawning is not the parallelism; the pool is. */
class ThreadPool {
 public:
  explicit ThreadPool(int n) {
    for (int i = 0; i < n; ++i) workers_.emplace_back([this] { loop(); });
  }
  ~ThreadPool() {
    stop_.store(true);
    cv_.notify_all();
    for (auto& t : workers_)
      if (t.joinable()) t.join();
  }

  void run(int count, const std::function<void(int)>& fn) {
    if (count <= 0) return;
    /* A worker that called back into the pool would wait for itself, so it
     * runs the range inline.  Any *other* thread may drive the pool — the
     * engine is constructed on the UI thread and renders on a worker thread
     * in the shell, and keying this on the constructing thread silently
     * serialised every frame (measured 2593ms against 290ms). */
    if (workers_.empty() || t_inWorker) {
      for (int i = 0; i < count; ++i) fn(i);
      return;
    }
    fn_ = &fn;
    count_ = count;
    next_.store(0, std::memory_order_relaxed);
    /* Only the workers decrement, so the counter tracks workers only; the
     * caller waits for it to reach zero.  Counting the caller here without a
     * matching decrement deadlocked the first tile. */
    active_.store((int)workers_.size(), std::memory_order_release);
    gen_.fetch_add(1, std::memory_order_release);
    cv_.notify_all();                 // release any thread that fell asleep
    work();
    /* Short jobs never sleep, so the handshake is a spin rather than a
     * futex round trip.  A 128x128 tile is ~0.5ms of work and a pass is 190
     * of them: at 15 futex wakeups per dispatch that was 2.7x the pixel
     * time (279ms against 104ms for the same frame in the benchmark). */
    int spins = 0;
    while (active_.load(std::memory_order_acquire) != 0) {
      if (++spins > kSpinBudget) {
        std::unique_lock<std::mutex> lk(mu_);
        cvDone_.wait(lk, [&] { return active_.load(std::memory_order_acquire) == 0; });
        break;
      }
      MB_PAUSE();
    }
  }

 private:
  static constexpr int kSpinBudget = 1 << 16;

  void work() {
    for (;;) {
      const int i = next_.fetch_add(1, std::memory_order_relaxed);
      if (i >= count_) return;
      (*fn_)(i);
    }
  }

  void loop() {
    t_inWorker = true;
    int seen = 0;
    for (;;) {
      int spins = 0;
      while (gen_.load(std::memory_order_acquire) == seen) {
        if (stop_.load(std::memory_order_relaxed)) return;
        if (++spins > kSpinBudget) {
          std::unique_lock<std::mutex> lk(mu_);
          cv_.wait(lk, [&] {
            return stop_.load() || gen_.load(std::memory_order_acquire) != seen;
          });
          if (stop_.load()) return;
          break;
        }
        MB_PAUSE();
      }
      seen = gen_.load(std::memory_order_acquire);
      work();
      if (active_.fetch_sub(1, std::memory_order_acq_rel) == 1)
        cvDone_.notify_all();
    }
  }

  std::vector<std::thread> workers_;
  std::mutex mu_;
  std::condition_variable cv_, cvDone_;
  const std::function<void(int)>* fn_ = nullptr;
  std::atomic<int> next_{0};
  std::atomic<int> gen_{0};
  std::atomic<int> active_{0};
  std::atomic<bool> stop_{false};
  int count_ = 0;
  /* Per-thread mark: "this thread is one of the pool's workers". */
  static thread_local bool t_inWorker;
};

thread_local bool ThreadPool::t_inWorker = false;
}  // namespace

struct Engine::Impl {
  int threads = 1;
  std::unique_ptr<ThreadPool> pool;
  std::atomic<uint64_t> gen{0};

  /* Cross-frame reference cache.
   *
   * The orbit is a property of a *point*, not of a frame, so a pan or a zoom
   * keeps it as long as that point is still inside the view.  Reusing it is
   * what makes a wheel gesture cheap: the expensive part (an arbitrary
   * precision orbit plus its Taylor series) is already there, and a pass
   * costs only the pixel work. */
  struct Cache {
    bool valid = false;
    int bits = 0;
    int maxIter = 0;
    std::string juliaKey;
    Big posRe, posIm;          // absolute position of the anchor
    std::vector<Ref> refs;
  };
  std::mutex cacheMu;
  Cache cache;
  int cacheLen = 0;

  /* Root vertex grid of the quadtree canvas.
   *
   * The reference keeps one CVERTEX array per canvas and shares it between
   * every worker that touches the frame (MandelbrotCanvasTemplate).  Tiles are
   * only a transport artefact here, so the grid has to outlive a tile: without
   * this, a 190-tile pass evaluates each shared edge vertex up to four times,
   * and the whole point of a canvas — compute a vertex once, reuse it — is
   * lost.  Keyed by view and cell size, cleared when either changes. */
  struct RootGrid {
    bool valid = false;
    std::string key;
    int step = 8, nx = 0, ny = 0;
    std::vector<int> n;
    std::vector<float> m2, rel;
    std::vector<uint8_t> rgb;      // 3 bytes per vertex, already shaded
    std::vector<uint8_t> st;       // 0 unknown, 1 known, 2 glitch
  };
  std::mutex gridMu;
  RootGrid grid;
  /* Memory of finished vertex canvases.
   *
   * The reference keeps an AREA quadtree per view and only recomputes the
   * areas whose computecycle changed (00427ab0.c:152, 00498570.c:88-107).
   * This is the same idea at the granularity of a whole vertex grid: a small
   * LRU of finished canvases, keyed by the *appearance* as well as the view.
   * Coming back to a view — zoom out, undo a pan, revisit a preset — reuses
   * every vertex instead of integrating it again, which is the "rendered
   * work is remembered" behaviour the reference gets from checkcanvas.
   * One grid is ~150 KB, so a dozen of them cost less than a single frame. */
  std::vector<RootGrid> gridArchive;

  /* Per-area texture cache — drawarea (00522180).
   *
   * The reference draws each finished area from its own 128^2 texture and
   * only recomputes an area whose computecycle changed (00427ab0.c:152,
   * 00498570.c:88-107).  This is that texture: the tile exactly as it was
   * shaded, keyed by view, appearance, pass and limit, so a static frame
   * costs one memcpy per area and *zero* vertices and pixels.  A 128^2 tile
   * is 64 KB, and the whole cache is capped well below one deep frame. */
  struct AreaTex {
    std::string key;
    int w = 0, h = 0, maxIter = 0, bounded = 0, escLo = 0, escHi = 0, glitches = 0;
    std::vector<uint8_t> tex;
  };
  std::mutex areaMu;
  std::vector<AreaTex> areaCache;
  size_t areaBytes = 0;

  /* Canvas observation layer.
   *
   * The original engine is a subdivided vertex canvas, not a flat tile
   * renderer: processcanvasfinite_hfloat (0046f630.c) keeps four corner
   * vertices per cell, raises canvas->maxiter from the iterations it actually
   * observes, and recomputes a cell when its own limit falls short of the
   * vertex budget.  checkcanvas_hfloat (00498570.c) is the re-check pass and
   * worker_move (00429d50.c:185) continues the work while idle.
   *
   * We keep the flat tile rasteriser (it is what makes the frame seamless and
   * fast) and carry the *observation* on a per-view, per-quality-pass state:
   * the four corner vertices are recorded as the tiles arrive, the budget is
   * derived from them, and the next progressive pass of the same view may be
   * continued with a higher per-pixel limit.  Keying by (view, quality) means
   * every tile of one pass shares exactly one limit, so a pass cannot tear.
   *
   * Crucially the limit never changes because the zoom changed.  A new view
   * starts from the caller's explicit ceiling and only *observed* work can
   * raise it afterwards. */
  struct IterState {
    bool valid = false;
    std::string key;             // view + quality pass
    std::string viewKey;         // view only, used to carry observations over
    int cap = 0;                 // per-pixel limit for this pass
    int budget = 0;              // vertexIterBudget()
    int lastCeiling = 0;         // caller ceiling seen on the previous pass
    int corners[4] = {0, 0, 0, 0};   // known iteration of each corner vertex
    int observedMax = 0;         // canvas->maxiter (monotone)
    int hitLimit = 0;            // last pass showed the limit was too tight
    int refine = 0;              // idle continuation passes used
    double psLog2 = 0.0;         // pixel scale of that pass, to tell a zoom from a jump
  };
  std::mutex iterMu;
  IterState iter;

  /* The vertex canvas is a frame-aligned cell grid built in render(), not a
   * cached vertex array.  Evaluating vertices with the full iteration kernel
   * was measured at 5402ms vs 390ms on a real 190-tile window: 46k scalar
   * boundary orbits cost far more than the pixels they saved.  The
   * reference's own cardioid/bulb closed form supplies "known vertex" status
   * in O(1) with a mathematical guarantee, so no cache is needed and a zoom
   * has nothing to invalidate. */

  /* The additive palette is a one-dimensional function of the iteration
   * count, so it is identical for every tile of a pass.  Rebuilding its LUT
   * per tile (12 samples per iteration, P.n sin() calls each) was pure waste
   * on a 190-tile frame.  It is now an immutable shared table; a render
   * holds a shared_ptr for the duration of its pixel pass, so a later tile
   * rebuilding it cannot race with an earlier one still reading it. */
  struct LutCache {
    bool valid = false;
    Palette pal{};
    double ipc = 0.0, offset = 0.0, scale = 0.0;
    int maxIter = 0;
    std::shared_ptr<const std::vector<float>> data;
    std::shared_ptr<Mip> mip;
  };
  std::mutex lutMu;
  LutCache lutCache;

  /* Palette cycle fitted to the last view (see the band-density fit). */
  struct Fit {
    bool valid = false;
    std::string key;
    double ipc = 0.0;
    int lo = 0, hi = 0;      // escape range the fit was derived from
  };
  std::mutex fitMu;
  Fit fit;

  void parallelFor(int count, const std::function<void(int)>& fn);
  void render(const Request& q, uint8_t* out, Stats& st, Field* fieldOut);
};

void Engine::Impl::parallelFor(int count, const std::function<void(int)>& fn) {
  if (count <= 0) return;
  if (threads <= 1 || count == 1 || !pool) {
    for (int i = 0; i < count; ++i) fn(i);
    return;
  }
  pool->run(count, fn);
}

void Engine::Impl::render(const Request& q, uint8_t* out, Stats& st,
                          Field* fieldOut) {
  using clock = std::chrono::steady_clock;
  const auto t0 = clock::now();
  const uint64_t myGen = gen.load(std::memory_order_relaxed);

  const int vw = q.viewWidth > 0 ? q.viewWidth : q.width;
  const int vh = q.viewHeight > 0 ? q.viewHeight : q.height;
  const int w = std::max(1, q.width);
  const int h = std::max(1, q.height);
  const int pitch = q.outPitch > 0 ? q.outPitch : w;

  double psLog2 = std::log2(q.spanMant) + (double)q.spanExp -
                  std::log2((double)std::max(1, std::max(vw, vh)));
  if (psLog2 < -1020.0) psLog2 = -1020.0;    // keep the plane math in range
  double ps = std::exp2(psLog2);
  if (!(ps > 0.0)) ps = 1e-307;

  /* Explicit ceiling from the caller.  No zoom-derived iteration limit: the
   * reference program's examples carry no iteration key and its disassembly
   * has no maxiter = f(zoom).  The vertex budget below is the only thing that
   * can change the per-pixel limit, and it is driven by observed work. */
  const int ceiling =
      std::min(q.maxIter > 0 ? q.maxIter : kDefaultIterations, kIterHardCap);

  char viewKey[512];
  std::snprintf(viewKey, sizeof(viewKey), "%s|%s|%g|%d|%d|%d|%d|%d|%d",
                q.centerRe.c_str(), q.centerIm.c_str(), q.spanMant, q.spanExp,
                vw, vh, q.spec.mode, q.spec.kind, q.spec.power);
  char passKey[560];
  std::snprintf(passKey, sizeof(passKey), "%s|q%d", viewKey, q.quality);

  static const bool noObserved = std::getenv("MB_NOOBSERVED") != nullptr;
  int maxIter = ceiling;
  int iterBudget = 0, cornerKnown = 0, observedMax = 0, refinePass = 0;
  if (!noObserved) {
    std::lock_guard<std::mutex> lk(iterMu);
    if (!iter.valid || iter.key != passKey) {
      const bool sameView = iter.valid && iter.viewKey == viewKey;
      int known = 0;
      if (sameView)
        for (int i = 0; i < 4; ++i) known = std::max(known, iter.corners[i]);
      /* canvas->maxiter is global observed state: it survives a zoom or pan,
       * just as the reference keeps vertices that are still on screen. */
      const int obs = iter.valid ? iter.observedMax : 0;
      const int budget = vertexIterBudget(known, obs);
      /* A jump — opening a preset, the home button, a link — lands somewhere
       * the previous pass says nothing about.  Its observations describe a
       * different place, and carrying them over was why a preset at 1e18 was
       * rendered with the home view's ~1600 iteration cap: the whole frame
       * read as interior and the pass finished in 24 ms.  A zoom or a pan of
       * a few octaves is continuous, and there the reference does keep the
       * observed limit (canvas->maxiter survives both). */
      const bool jump = iter.valid && std::fabs(psLog2 - iter.psLog2) > 3.0;
      const bool hit = !jump && iter.valid && iter.hitLimit != 0 &&
                       iter.refine < kMaxIdlePasses;

      /* A zoom/pan changes the view and the caller's ceiling together.  That
       * is exactly the automatic iteration change the reference program never
       * does: keep the observed limit.  A ceiling change on an unchanged view
       * is an operator action and is honoured. */
      const bool manualCeiling = sameView && ceiling != iter.lastCeiling;
      int cap = (iter.valid && !jump) ? iter.cap : ceiling;
      if (manualCeiling) cap = ceiling;

      /* 0046f630.c:197 recalculates a vertex whose own limit fell below
       * known*3+1000; :107 (canvas->maxiter*5) and 00429d50.c:185
       * (idle_maxiter) continue that work while idle.  Only observed
       * evidence may raise the limit, and at most kMaxIdlePasses times. */
      if (hit) {
        const long long grow =
            std::max<long long>((long long)cap * 5, (long long)obs * 5);
        const long long next =
            known > 0 ? std::max<long long>(budget, grow) : grow;
        cap = (int)std::min<long long>(kIterHardCap, next);
      }
      /* A safety rail: even a mistaken refinement may not grow the limit
       * beyond four times the caller's ceiling.  Before the palette LUT was
       * shared across tiles this was a 14x slowdown on a 190-tile frame. */
      const int safeCap = std::min(kIterHardCap, std::max(ceiling * 4, 4000));
      if (cap > safeCap) cap = safeCap;
      IterState s;
      s.valid = true;
      s.key = passKey;
      s.viewKey = viewKey;
      s.cap = cap;
      s.budget = budget;
      s.observedMax = obs;
      s.lastCeiling = ceiling;
      if (sameView)
        for (int i = 0; i < 4; ++i) s.corners[i] = iter.corners[i];
      s.refine = iter.valid ? iter.refine + (cap > iter.cap ? 1 : 0) : 0;
      s.psLog2 = psLog2;
      iter = s;
    }
    maxIter = iter.cap;
    iterBudget = iter.budget;
    observedMax = iter.observedMax;
    refinePass = iter.refine;
    for (int i = 0; i < 4; ++i)
      cornerKnown = std::max(cornerKnown, iter.corners[i]);
  }
  const int bits = q.bits > 0 ? q.bits : requiredBits(psLog2, maxIter);
  /* Every family can be perturbed natively: the deviation step is the same
   * two complex products for all of them, with the per-family fold coming out
   * of a stored table.  p > 2 uses the general coefficients. */
  const bool famSupported =
      (q.spec.kind == 0 && q.spec.power >= 2 && q.spec.power <= 8) ||
      (q.spec.kind >= 1 && q.spec.kind <= 4 && q.spec.power == 2);
  static const bool forcePerturb = std::getenv("MB_FORCEPERT") != nullptr;
  static const bool noPerturb = std::getenv("MB_NOPERT") != nullptr;
  /* Burning ship and celtic fold along the orbit: a single reference cannot
   * describe a pixel that lives in a different sign cell.  The kernel already
   * detects exactly that per pixel and reports it as a glitch, and the last
   * resort below re-runs those at the frame's own precision — so perturbation
   * stays on at every depth and the sign-cell pixels are repaired instead of
   * the whole frame being demoted to a double orbit (which is what used to
   * happen past 1e-13 and made these two sets stop at 1e13 for good).
   * MB_FOLDEDDEEP=1 restores the old cut for A/B. */
  static const bool foldDeepOff = std::getenv("MB_FOLDEDDEEP") != nullptr;
  const bool foldedDeep =
      foldDeepOff && (q.spec.kind == 2 || q.spec.kind == 3) && psLog2 < -43.0;
  const bool perturb = (q.spec.mode == 0 || q.spec.mode == 1) && famSupported &&
                       (psLog2 <= -42.0 || forcePerturb) && !noPerturb &&
                       !foldedDeep;
  const bool famKernel = q.spec.kind != 0 || q.spec.power != 2;

  st = Stats();
  st.bits = bits;
  st.perturb = perturb;
  st.baseIter = maxIter;
  st.psLog2 = psLog2;
  st.threads = threads;
  st.pixels = w * h;

  /* ---- per-area texture hit ---------------------------------------
   * Keyed by everything that can change a pixel: the view, the Julia seed,
   * the appearance (palette + offset + rotation + colour mode), the pass
   * quality, the supersampling, the detail level, the resolved limit and the
   * tile itself.  A hit means this area was already shaded for exactly this
   * frame, so it is a copy — and the iteration counter honestly reports 0. */
  static const bool noAreaCache = std::getenv("MB_NOAREACACHE") != nullptr;
  char areaKey[1024];
  const bool areaKeyed = !fieldOut && out && q.colorMode == 0 && !noAreaCache;
  if (areaKeyed) {
    const Palette& pal = q.pal ? *q.pal : kFallbackPalette;
    std::snprintf(areaKey, sizeof(areaKey),
                  "%s|%s|%g,%g|%d,%d,%d,%d|q%d|aa%d|dt%d|it%d|%016llx",
                  viewKey, q.spec.juliaReS.c_str(), q.spec.juliaRe, q.spec.juliaIm,
                  q.tileX, q.tileY, w, h, q.quality, q.aa,
                  std::min(3, std::max(0, q.detail)), maxIter,
                  (unsigned long long)appearanceKey(q, pal, 0.0, q.rotation));
    std::lock_guard<std::mutex> lk(areaMu);
    for (size_t i = 0; i < areaCache.size(); ++i) {
      AreaTex& a = areaCache[i];
      if (a.key != areaKey || a.w != w || a.h != h) continue;
      for (int y = 0; y < h; ++y)
        std::memcpy(out + (size_t)y * (size_t)pitch * 4,
                    a.tex.data() + (size_t)y * (size_t)w * 4, (size_t)w * 4);
      st.bounded = a.bounded;
      st.escapeMin = a.escLo;
      st.escapeMax = a.escHi;
      st.maxIterUsed = a.maxIter;
      st.glitches = a.glitches;
      st.canvasFilled = 0;
      st.canvasCacheHit = 1;
      st.iterPixels = 0;
      if (i) {
        AreaTex tmp = std::move(a);
        areaCache.erase(areaCache.begin() + (long)i);
        areaCache.insert(areaCache.begin(), std::move(tmp));
      }
      return;
    }
  }

  Prof prof;
  prof.orbit = prof.ms();

  Ctx g;
  g.q = &q;
  g.ps = ps;
  g.halfW = 0.5 * (double)vw;
  g.halfH = 0.5 * (double)vh;
  g.rotC = std::cos(q.rotation);
  g.rotS = std::sin(q.rotation);
  g.julia = q.spec.mode == 1;
  g.kind = q.spec.kind;
  g.power = q.spec.power;
  g.maxIter = maxIter;
  g.offset = q.offset;
  g.pal = q.pal;
  g.colorMode = q.colorMode;
  g.detail = std::min(3, std::max(0, q.detail));
  /* The field always carries a distance estimate: every colour scheme may read
   * it, and "Distance" / "Distance and iteration levels" threshold it against a
   * pixel — a zero there renders those schemes black, which is what deep
   * presets were doing.  The colouring path only needs it for the distance
   * modes, so the extra derivative stays off the hot loop there. */
  /* `wantDist` keeps its original meaning (and keeps the quad kernels gated:
   * they lack the scalar kernel's cycle detection, so silently switching the
   * field path to them would mis-classify interior pixels).  What a shader
   * that declares no DIST/DIST2 channel buys is `skipDeriv`: the derivative
   * recurrence is a second complex multiply on every iteration of every
   * pixel, and nothing reads its result.
   * MB_FIELDDIST_ALL=1 restores the old always-on behaviour for A/B. */
  static const bool forceDist =
      std::getenv("MB_FIELDDIST_ALL") != nullptr;
  g.wantDist = q.colorMode >= 2 || fieldOut != nullptr;
  g.skipDeriv = fieldOut != nullptr && !q.fieldDist && !forceDist;
  /* CHANNEL_VALUE wants z at the escape point but not dz/dc; `zOnly` keeps
   * the probe from dragging the derivative recurrence back on. */
  g.zOnly = fieldOut != nullptr && q.fieldValue;
  /* Traps only exist in the field: the colour stage is what draws them, and a
   * flat RGBA pass has nowhere to put an orbit statistic. */
  g.wantTrap = q.traps > 0 && fieldOut != nullptr;
  g.trapMode = q.traps;
  g.cre = std::strtod(q.centerRe.c_str(), nullptr);
  g.cim = std::strtod(q.centerIm.c_str(), nullptr);
  g.jr = q.spec.juliaRe;
  g.ji = q.spec.juliaIm;
  g.fam = famKernel;
  if (std::getenv("MB_DEBUGKIND")) {
    std::fprintf(stderr, "[core] kind=%d power=%d famKernel=%d perturb=%d\n",
                 q.spec.kind, q.spec.power, (int)famKernel, (int)perturb);
  }

  /* ---- reference orbits ------------------------------------------- */
  std::vector<Ref> refs;
  const auto tOrb0 = clock::now();
  if (perturb) {
    const Big cRe = Big::fromString(q.centerRe, bits);
    const Big cIm = Big::fromString(q.centerIm, bits);
    const std::string juliaKey =
        q.spec.mode == 1 ? q.spec.juliaReS + "," + q.spec.juliaImS : std::string();
    const double spanX = ps * (double)vw;
    const double spanY = ps * (double)vh;

    double refOffRe = 0.0, refOffIm = 0.0;
    bool reused = false;
    {
      std::lock_guard<std::mutex> lk(cacheMu);
      if (cache.valid && cache.bits == bits && cache.maxIter >= maxIter &&
          cache.juliaKey == juliaKey) {
        const double dRe = cache.posRe.sub(cRe).toDouble();
        const double dIm = cache.posIm.sub(cIm).toDouble();
        if (std::fabs(dRe) <= 0.75 * spanX && std::fabs(dIm) <= 0.75 * spanY) {
          refs = cache.refs;
          refOffRe = dRe;
          refOffIm = dIm;
          reused = true;
        }
      }
    }
    if (!reused) {
      const Pick pick = pickReference(q, bits, maxIter, g, &gen, myGen);
      /* An invalid pick means cancel() landed while the orbit search was
       * running; the rest of this frame belongs to a view nobody wants. */
      if (!pick.valid) return;
      Ref primary;
      if (buildReference(q, bits, maxIter, pick.dRe, pick.dIm, &primary,
                         &gen, myGen) == kOrbitCancelled) return;
      refs.clear();
      refs.push_back(std::move(primary));
      refOffRe = pick.dRe;
      refOffIm = pick.dIm;
      std::lock_guard<std::mutex> lk(cacheMu);
      cache.valid = true;
      cache.bits = bits;
      cache.maxIter = maxIter;
      cache.juliaKey = juliaKey;
      cache.posRe = cRe.add(Big::fromDouble(pick.dRe, bits));
      cache.posIm = cIm.add(Big::fromDouble(pick.dIm, bits));
      cache.refs = refs;
      cacheLen = refs.empty() ? 0 : refs[0].len;
    }
    if (!refs.empty()) {
      refs[0].dRe = refOffRe;
      refs[0].dIm = refOffIm;
    }
    st.orbitReused = reused;
    st.refLen = refs.empty() ? 0 : refs[0].len;
    /* The Taylor series depends on the *frame* extent, so it is rebuilt per
     * view even when the orbit itself came from the cache.  The extent is
     * measured from the anchor, which is rarely the frame centre. */
    for (auto& r : refs) {
      const double hw = 0.5 * (double)vw * ps, hh = 0.5 * (double)vh * ps;
      double dcMax = 0.0;
      for (int sy = -1; sy <= 1; sy += 2) {
        for (int sx = -1; sx <= 1; sx += 2) {
          const double d = std::hypot((double)sx * hw - r.dRe,
                                      (double)sy * hh - r.dIm);
          if (d > dcMax) dcMax = d;
        }
      }
      buildFolds(r, q.spec.kind);
      /* The coefficient table has to exist before the series is built: for
       * p > 2 the series recursions read J/H/K out of it. */
      if (famKernel) buildDevTable(r, q.spec.power);
      buildSeries(r, dcMax, q.spec.mode != 1, q.spec.power, q.spec.kind);
    }
    st.skip = refs.empty() ? 0 : refs[0].skip;
  }
  g.refs = &refs;
  st.orbitMs =
      std::chrono::duration<double, std::milli>(clock::now() - tOrb0).count();

  /* ---- band density ------------------------------------------------
   *
   * The reference has no band control at all: pal() is handed the iteration
   * count and each scheme's own `frequency` decides how many bands appear.
   * That is the default here too — for an additive scheme `ipc` is exactly
   * the scheme's cycleRef, i.e. pal(iter).
   *
   * A gradient ramp has no natural period, so it needs one; `cycle` supplies
   * it and defaults to 8 iterations.
   *
   * One rule is enforced for both, because breaking it is what produced the
   * fan-shaped colour "断层" at depth: a band that is shorter than the frame
   * can resolve is not detail, it is moiré.  The frame's own escape-count
   * span, measured on a coarse grid, says how many bands it can carry.
   */
  const Palette& pal0 = q.pal ? *q.pal : kFallbackPalette;
  const bool rampPal = (pal0.mode == 1);
  double ipc = rampPal ? (q.cycle > 0.0 ? q.cycle : 8.0)
                       : (pal0.cycleRef > 0.05f ? (double)pal0.cycleRef : 1.0);

  int frameLo = -1, frameHi = -1;
  double frameSpan = 0.0;
  {
    /* The probe depends on the *view*, not on the tile, so every tile of one
     * pass would otherwise repeat the same scan.  Cached on the view key. */
    char key[512];
    /* No `maxIter` in the key on purpose: the observation machinery may raise
     * the per-pixel cap between passes of one view, and a fit that changed with
     * it would repaint the whole frame in different colours mid-render. */
    std::snprintf(key, sizeof(key), "%s|%s|%g|%d|%d|%d|%d",
                  q.centerRe.c_str(), q.centerIm.c_str(), q.spanMant, q.spanExp,
                  q.spec.mode, q.spec.kind, vw);
    double cached = 0.0;
    {
    std::lock_guard<std::mutex> lk(fitMu);
    if (fit.valid && fit.key == key) {
      cached = fit.ipc;
      frameLo = fit.lo;
      frameHi = fit.hi;
    } else {
      /* The probe runs under the fit lock on purpose.  Every tile of a pass
       * asks for this number, and without the lock each of the 190 tiles would
       * run its own probe before any of them stored a result — measured as
       * seconds of duplicated work on a deep frame.  One thread samples, the
       * rest wait for a few milliseconds and read the answer. */
      const int GX = 40, GY = 25;
      std::vector<int> vals;
      vals.reserve((size_t)GX * GY);
      for (int row = 0; row < GY; ++row) {
        const double fy = ((double)row + 0.5) * (double)vh / (double)GY;
        for (int cx = 0; cx < GX; ++cx) {
          const double fx = ((double)cx + 0.5) * (double)vw / (double)GX;
          int n;
          double m2 = 0.0, rel = 0.0, der2 = 0.0;
          if (!perturb) n = directPixel(g, fx, fy, m2, rel, der2);
          else if (refs.empty()) n = -1;
          else n = pertPixel(g, fx, fy, 0, m2, rel, der2);
          if (n >= 0) vals.push_back(n);
        }
      }
      /* Percentiles, not extremes.  One probe that happens to land on the
       * tip of a filament reaches thousands of iterations and would stretch
       * the whole frame's cycle to a single flat wash; p02..p98 describes the
       * range a viewer actually sees. */
      int nlo = 0, nhi = 0;
      if (vals.size() >= 16) {
        std::sort(vals.begin(), vals.end());
        nlo = vals[(size_t)((double)(vals.size() - 1) * 0.02)];
        nhi = vals[(size_t)((double)(vals.size() - 1) * 0.98)];
      } else if (!vals.empty()) {
        std::sort(vals.begin(), vals.end());
        nlo = vals.front();
        nhi = vals.back();
      }
      frameSpan = (nhi > nlo) ? (double)(nhi - nlo) : 1.0;
      if (frameSpan < 8.0) frameSpan = 8.0;
      frameLo = nlo;
      frameHi = nhi;
      fit.valid = true;
      fit.key = key;
      fit.ipc = frameSpan;
      fit.lo = frameLo;
      fit.hi = frameHi;
    }
    }
    if (cached > 0.0) frameSpan = cached;
  }

  /* Colour is a function of the iteration count and nothing else.
   *
   * This is the reference's rule and it is deliberately boring: `pal(iter)` is
   * handed the count, the scheme's own `frequency` decides the band spacing,
   * and no frame-dependent factor ever enters.  Everything that used to be
   * fitted here — the escape range of this frame, the caller's band count, the
   * "cycle must not be shorter than the frame can resolve" floor — made the
   * palette phase depend on `maxIter`.  Since the observation machinery may
   * raise `maxIter` between passes of the *same* view, that turned into whole
   * frames changing colour halfway through a render, and tiles of one pass
   * disagreeing with tiles of the next: the hard-edged colour breaks ("断层")
   * at depth had no other cause.
   *
   * Local aliasing is still handled, but downstream and locally: see the
   * palette mip chain, which averages pal() over exactly the phase interval a
   * pixel covers instead of changing the phase of the whole frame.
   */
  if (rampPal) {
    if (!(ipc > 0.0)) ipc = 8.0;
    if (ipc < 0.02) ipc = 0.02;
  } else {
    ipc = pal0.cycleRef > 0.05f ? (double)pal0.cycleRef : 1.0;
    /* Band density: put `bands` palette cycles across the range this frame
     * actually shows.  It only ever lengthens the cycle, so a scheme that is
     * already readable at its authored frequency keeps its look, and the ones
     * whose frequency is far finer than the frame (a 2-rad/iteration scheme
     * over 40 iterations of visible range) are stretched until the bands are
     * something the eye can follow.  The span itself is measured per view and
     * cached without the iteration cap, so panning does not shift colours and
     * a refinement pass cannot repaint the frame. */
    if (q.bands > 0 && frameSpan > 0.0) {
      const double want = frameSpan / (double)q.bands;
      if (want > ipc) ipc = want;
    }
  }
  g.iterPerCycle = ipc;
  st.iterPerCycle = ipc;
  if (std::getenv("MB_DEBUGBAND"))
    std::fprintf(stderr, "[band] span=%.1f ipc=%.3f ramp=%d bands=%d\n",
                 frameSpan, ipc, (int)rampPal, q.bands);

  /* Both palette models travel as tables.  The ramp has a fixed 256 entries
   * over one cycle; the additive scheme is baked over the frame's whole
   * iteration range so a pixel costs one lerp instead of P.n sinusoids. */
  std::vector<float> gradLut;
  std::shared_ptr<const std::vector<float>> addLut;
  Mip gradMip;
  static const bool noPalLut = std::getenv("MB_NOPALLUT") != nullptr;
  if (q.pal && q.pal->mode == 1) {
    buildGradientLut(*q.pal, gradLut);
    if (!gradLut.empty()) {
      g.grad = gradLut.data();
      /* The ramp is cyclic: pos 1.0 is pos 0.0, so the mip has to average
       * across the seam too or every cycle boundary would show a step. */
      buildMip(gradLut, true, gradMip);
      if (!gradMip.lv.empty()) g.gradMip = &gradMip;
    }
  } else if (!noPalLut && q.pal && q.pal->n > 0) {
    std::lock_guard<std::mutex> lk(lutMu);
    /* Compare the semantic fields, not the whole struct: struct padding is
     * not guaranteed to survive an assignment and would cause false misses. */
    const Palette& P = *q.pal;
    const bool hit =
        lutCache.valid && lutCache.maxIter == maxIter &&
        lutCache.ipc == ipc && lutCache.offset == q.offset &&
        lutCache.pal.mode == P.mode && lutCache.pal.n == P.n &&
        lutCache.pal.ns == P.ns &&
        lutCache.pal.cycleRef == P.cycleRef &&
        lutCache.pal.brightness == P.brightness &&
        lutCache.pal.contrast == P.contrast &&
        lutCache.pal.gamma == P.gamma &&
        lutCache.pal.saturation == P.saturation &&
        lutCache.pal.brightnessFinite == P.brightnessFinite &&
        lutCache.pal.brightnessInfinite == P.brightnessInfinite &&
        lutCache.pal.brightnessFactor == P.brightnessFactor &&
        lutCache.pal.gainR == P.gainR && lutCache.pal.gainG == P.gainG &&
        lutCache.pal.gainB == P.gainB &&
        std::memcmp(lutCache.pal.c, P.c,
                    (size_t)P.n * sizeof(PaletteColor)) == 0 &&
        std::memcmp(lutCache.pal.s, P.s,
                    (size_t)P.ns * sizeof(GradientStop)) == 0;
    if (!hit) {
      auto fresh = std::make_shared<std::vector<float>>();
      double scale = 0.0;
      buildAdditiveLut(*q.pal, ipc, q.offset, maxIter, frameLo, frameHi, *fresh,
                       scale);
      lutCache.valid = true;
      lutCache.pal = *q.pal;
      lutCache.ipc = ipc;
      lutCache.offset = q.offset;
      lutCache.maxIter = maxIter;
      lutCache.scale = scale;
      lutCache.data = fresh;
      /* The mip chain is what makes band-limiting free at runtime: a wide
       * box filter costs two taps instead of hundreds.  Built once with the
       * table, which is already per-frame work. */
      auto mip = std::make_shared<Mip>();
      buildMip(*fresh, false, *mip);
      lutCache.mip = mip;
    }
    addLut = lutCache.data;
    g.palLutScale = lutCache.scale;
    g.palLut = addLut->data();
    g.palLutN = (int)(addLut->size() / 3);
    if (lutCache.mip && !lutCache.mip->lv.empty()) {
      g.palMip = lutCache.mip.get();
      g.palMipPerCycle = lutCache.scale * ipc;
    }
  }
  prof.lut = prof.ms();

  prof.canvas = prof.ms();
  /* ---- canvas pass -------------------------------------------------
   * Real area quadtree, as transcribed in canvasQuadtree() above: 128 px
   * areas (canvassizeshift 7), four corner vertices per node, the
   * second-difference residual checked against a tolerance that halves per
   * level, a failing node split instead of iterated, and a 1 px floor that
   * is exact rather than interpolated.
   *
   * The earlier pass is gone.  It only ever filled cells that the cardioid
   * test proved interior — O(1), but a subset of what the reference accepts,
   * and with no error check at all, so it could never cover a calm escaped
   * field.  That is why deep views were pure per-pixel raster.
   *
   * Distance schemes still stay on the raster: `dist` is a non-linear
   * function of z and dz/dc, neither of which the canvas carries (see the
   * channel note above canvasQuadtree). */
  static const bool noCanvas = std::getenv("MB_NOCANVAS") != nullptr;
  std::vector<uint8_t> canvasDone((size_t)w * (size_t)h, 0);
  int canvasCells = 0, interpolated = 0, cvBounded = 0, cvCellsTotal = 0;
  int cvVertices = 0, cvMaxN = 0, cvEscLo = INT32_MAX, cvEscHi = -1;
  int glitchPx = 0;
  long long cvIters = 0;
  int cvHoles = 0, cvBand = 0, cvRes = 0, cvCtr = 0, cvInt = 0, cvGl = 0;
  /* OFF by default.  Measured on the reference hardware: even with the
   * value/derivative channel the tree loses to the four-wide raster at every
   * depth that was measured (doc-specs.md §11).  Enable explicitly for
   * experiments. */
  const bool canvasOk = !noCanvas && !fieldOut &&
                        q.colorMode == 0 && (!perturb || !refs.empty()) &&
                        std::getenv("MB_CANVASFORCE") != nullptr;
  if (canvasOk) {
    CQOut co;
    if (canvasQuadtree(g, q, out, pitch, w, h, vw, vh, perturb, maxIter,
                       canvasDone, co)) {
      canvasCells = co.accepted;
      interpolated = co.filled;
      cvBounded = co.bounded;
      cvCellsTotal = co.cells;
      cvVertices = co.verts;
      cvMaxN = co.maxN;
      cvEscLo = co.escLo;
      cvEscHi = co.escHi;
      cvIters = co.iters;
      st.canvasRejects = co.rejects;
      cvHoles = co.holes;
      cvBand = co.rBand;
      cvRes = co.rRes;
      cvCtr = co.rCenter;
      cvInt = co.rInterior;
      cvGl = co.rGlitch;
    }
  }
  st.canvasVerts = cvVertices;
  st.canvasFilled = interpolated;
  st.iterPixels += cvIters;
  st.interpolated = interpolated;
  st.canvasCells = canvasCells;
  if (const char* cvlog = std::getenv("MB_CVLOG")) {
    /* A GUI process has no usable stderr, so the split reasons go to a file
     * that the measurement script can read back. */
    static FILE* lf = std::fopen(cvlog, "w");
    if (lf) {
      std::fprintf(lf,
                   "[canvas] %dx%d tile=%d,%d cells=%d acc=%d rej=%d fill=%d "
                   "px=%d verts=%d holes=%d band=%d res=%d ctr=%d int=%d gl=%d "
                   "iters=%lld\n",
                   w, h, q.tileX, q.tileY, cvCellsTotal, canvasCells,
                   st.canvasRejects, interpolated, w * h, cvVertices, cvHoles,
                   cvBand, cvRes, cvCtr, cvInt, cvGl, cvIters);
      std::fflush(lf);
    }
  }

  prof.pixel = prof.ms();
  /* ---- pixel pass -------------------------------------------------- */
  std::vector<uint8_t> glitchMask((size_t)w * (size_t)h, 0);
  std::atomic<int> maxIterSeen{0};
  std::atomic<int> escMin{INT32_MAX};
  std::atomic<int> escMax{-1};
  std::atomic<int> boundedCount{0};
  std::atomic<int> glitchCount{0};
  std::atomic<long long> iterCount{0};

  /* The four corner vertices of the whole frame, recorded as the tiles
   * arrive.  processcanvasfinite_hfloat (0046f630.c:81-99) derives its
   * `known` from exactly these four, not from the whole picture. */
  std::atomic<int> cornerVals[4];
  for (auto& c : cornerVals) c.store(0, std::memory_order_relaxed);
  auto noteMax = [](std::atomic<int>& a, int v) {
    int cur = a.load(std::memory_order_relaxed);
    while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
  };

  auto drawRange = [&](int y0, int y1, const std::vector<Ref>& src,
                       bool onlyGlitch) {
    /* Per-call accumulators.  These used to be four atomic updates *per pixel*
     * on three shared cache lines — with sixteen threads that serialises the
     * whole render on cache-line ping-pong.  Measured: 2.3x slower than
     * accumulating locally and merging once at the end of the strip. */
    int lMax = 0, lMin = INT32_MAX, lMaxE = -1, lBounded = 0, lGlitch = 0;
    long long lReb = 0;
    /* Map iterations performed by this strip.  An escaped pixel costs its
     * escape count; an interior pixel costs the whole limit, because that is
     * what the kernel actually ran.  Merged once per strip — same reason the
     * other counters are local. */
    long long lIter = 0;

    /* Local band limiting.  `nu` (the smooth iteration count) is what the
     * palette is a function of, so its gradient across one pixel says how many
     * palette cycles that pixel covers.  More than half a cycle per pixel is
     * below the sampling limit: the palette can no longer be drawn, only
     * aliased, which is the fan-shaped "断层" seen at depth.  Averaging the
     * palette over exactly that interval is the band-limited result — no
     * invented structure, no moiré.
     *
     * Two rows of floats are all the state this needs, and the gradient is
     * taken from the neighbours that were just computed, so flat areas pay
     * nothing and stay bit-identical.
     *
     * `detail` folds in as a coarser target: level 3 filters at one pixel
     * (what samples=2 does in the reference), each step down doubles the
     * footprint, so level 0 asks for eight-pixel features and the fine
     * filigree turns into the smooth wash that makes the main lines read. */
    const float kNoNu = std::numeric_limits<float>::quiet_NaN();
    std::vector<float> nuPrev((size_t)w, kNoNu), nuCur((size_t)w, kNoNu);
    bool havePrevRow = false;
    const double detailScale = (double)(1 << (3 - g.detail));
    const double invIpc = 1.0 / (g.iterPerCycle > 0.0 ? g.iterPerCycle : 1.0);
    static const bool noBand = std::getenv("MB_NOBAND") != nullptr;
    /* Band limiting is a *colour* stage: it measures how many palette cycles
     * a pixel spans and averages `pal()` over that interval.  A field pass has
     * no palette yet (the shader owns it), so running it here would only
     * compute `smoothIteration` twice per pixel — and that is three
     * transcendental calls each, which measured as a 6x slowdown of the whole
     * field pass before this guard existed. */
    const bool bandLimit = !noBand && !fieldOut && (g.colorMode == 0) &&
                           !onlyGlitch;

    /* Account one finished pixel: glitch bookkeeping, the frame statistics and
     * the colour.
     *
     * With `fieldOut` set the colour stage is skipped entirely and the pixel
     * leaves as two floats instead — the reference program's split (kernel
     * produces the field, the shader produces the pixels).  Everything above
     * that point is identical, which is what makes the two paths comparable
     * frame for frame. */
    auto emit = [&](int x, int y, uint8_t* row, uint8_t* mrow, int n,
                    double m2, double rel, double der2, double zr = 0.0,
                    double zi = 0.0) {
      if (n == kGlitch) {
        mrow[x] = 1;
        ++lGlitch;
        /* An adopted shared buffer is *not* zero-filled.  A glitch that the
         * last-resort pass never reaches (its pixel budget can run out) must
         * not leave the previous frame's field sitting in this texel — the
         * owned-vector path got zeros for free from resize(). */
        if (fieldOut) {
          float* f = fieldOut->at(x, y);
          f[0] = f[1] = f[2] = f[3] = 0.0f;
          if (fieldOut->channels > 4) {
            float* v = fieldOut->atValue(x, y);
            v[0] = v[1] = 0.0f;
          }
        }
        return;
      }
      /* Only escaped pixels are charged their escape count.  An interior
       * pixel usually leaves through the bulb shortcut, and the kernels do
       * not report whether it did, so charging the limit would invent work
       * that never ran.  The raster uses the same convention. */
      lIter += (n >= 0) ? (long long)n : 0LL;
      if (n >= 0) {
        if (n > lMax) lMax = n;
        if (n < lMin) lMin = n;
        if (n > lMaxE) lMaxE = n;
        /* Frame-space corner vertices.  `row` is this tile's base + y*pitch,
         * so its offset from `out` is the tile-local y. */
        const int gx = q.tileX + x;
        const int gy = q.tileY + y;
        int slot = -1;
        if (gy == 0 && gx == 0) slot = 0;
        else if (gy == 0 && gx == vw - 1) slot = 1;
        else if (gy == vh - 1 && gx == 0) slot = 2;
        else if (gy == vh - 1 && gx == vw - 1) slot = 3;
        if (slot >= 0) noteMax(cornerVals[slot], n);
      } else {
        ++lBounded;
      }

      if (fieldOut) {
        /* The field is (smoothiter, distance-in-pixels).
         *
         * Interior pixels carry the negated period, so the shader can tell a
         * region from the sign alone — the reference's own convention
         * (`data.smoothiter < 0` selects brightnessinfinite).  Note the
         * encoding here is n = -1 - period, so the period is -n - 1. */
        float* f = fieldOut->at(x, y);
        if (n < 0) {
          const double cyc = (n < -1) ? (double)(-n - 1) : 0.0;
          f[0] = (float)(-cyc);      // smoothiter: negated period
          f[1] = 0.0f;               // distance is meaningless inside
          f[2] = (float)(-cyc);      // iter: the same encoding
          f[3] = 0.0f;
          /* CHANNEL_VALUE is only read on the escaped branch of the scheme,
           * but write the channels anyway so a stale texel from the previous
           * frame cannot leak into a visible one. */
          if (fieldOut->channels > 4) {
            float* v = fieldOut->atValue(x, y);
            v[0] = v[1] = 0.0f;
          }
        } else {
          f[0] = (float)smoothIteration(n, m2, rel);
          /* Distance estimate in pixels: the same expression the Distance
           * scheme uses, which is `|z|·log|z| / |dz/dc|` divided by the pixel
           * size — i.e. already in the units the shader's `dist` expects. */
          double px = 0.0;
          if (der2 > 0.0) {
            const double lz = 0.5 * std::log(std::max(m2 / (1.0 + rel), 1e-300)) +
                              0.5 * std::log1p(rel);
            px = std::sqrt(std::max(m2, 0.0)) * lz / std::sqrt(der2) / g.ps;
          }
          /* Zero here means "no estimate", which the schemes already treat as
           * background (`rr < 1 && rr != 0`).  A tiny but genuine distance must
           * NOT be turned into zero: at a deep view most escaped pixels sit
           * well under one pixel from the set, and rounding those to "unknown"
           * erased the whole rim — one solid white card.  Only a derivative
           * that overflowed (the estimate ran out of double range) has no
           * value to report. */
          if (!std::isfinite(px) || px <= 0.0) px = 0.0;
          f[1] = (float)px;
          f[2] = (float)n;
          /* `dist2` is a *different* estimator from `dist`, not the same one
           * on a coarser footing: dist2_float (004aad40) is the linear
           * distance to the escape circle of radius 2 —
           *     max(0, (2 - |z|) / |z'|)
           * — evaluated where the iteration stopped, with no continuation
           * steps.  The reference escapes at |z|^2 > 4 (DAT_00569d60 = 4.0),
           * so its |z| at escape is just over 2 and the numerator is a real,
           * positive distance.  We escape at 2^16, so this same expression
           * clamps to 0 for every escaped sample.  That is the transcription
           * telling the truth about the different bail-out, not an
           * approximation of it.
           *
           * When a trap is requested it takes this channel instead: one trap
           * mode per frame, so one slot is enough, and the field never has to
           * grow a second texture. */
          /* TIA accumulates a *sum* of log|z| over the orbit; dividing by the
           * iteration count turns it into the mean, which is the bounded
           * quantity the shader can band.  The minima need no such treatment. */
          double tv = trapAcc();
          if (g.trapMode == 4) tv = tv / (double)std::max(1, n);
          double d2 = 0.0;
          if (der2 > 0.0) {
            const double lin = (2.0 - std::sqrt(std::max(m2, 0.0))) /
                               std::sqrt(der2) / g.ps;
            if (lin > 0.0 && std::isfinite(lin)) d2 = lin;
          }
          f[3] = g.wantTrap
               ? (float)(tv > 1e29 ? 0.0 : tv)
               : (float)d2;
          /* CHANNEL_VALUE: z at the escape point, the seed of the scheme's
           * 20-step continuation.  Written only when the request asked for
           * the two extra channels. */
          if (fieldOut->channels > 4) {
            float* v = fieldOut->atValue(x, y);
            v[0] = (float)zr;
            v[1] = (float)zi;
          }
        }
        return;
      }

      double blur = 0.0;
      if (bandLimit) {
        /* Only escaped samples have a smooth count; interior pixels carry the
         * negative period instead, and differencing that against a neighbour's
         * escape count would blur the bright rim into its own background.  NaN
         * marks "no value" and makes the comparison below a no-op. */
        if (n >= 0) {
          const double nu = smoothIteration(n, m2, rel);
          double d = 0.0;
          if (x > 0) {
            const float pn = nuCur[x - 1];
            if (pn == pn) d = std::fabs(nu - (double)pn);
          }
          if (havePrevRow) {
            const float pu = nuPrev[x];
            if (pu == pu) {
              const double du = std::fabs(nu - (double)pu);
              if (du > d) d = du;
            }
          }
          nuCur[x] = (float)nu;
          blur = d * detailScale * 0.5 * invIpc;
          /* No small cap: the kernel is the pixel footprint, and where that
           * spans many cycles the honest answer is the palette mean.  Capping
           * it (at a quarter cycle, say) leaves exactly the sub-pixel mush the
           * eye cannot resolve — the speckled grey fields at depth. */
          if (blur > 8.0) blur = 8.0;
        } else {
          nuCur[x] = kNoNu;
        }
      }
      shade(row + (size_t)x * 4, g, n, m2, rel, der2, blur);
    };

    /* Vector fast path: one reference, no distance derivative, no fold, and a
     * plain z^2 family.  Everything else keeps the scalar kernel. */
    static const bool noQuad = std::getenv("MB_NOQUAD") != nullptr;
    static const bool noDQuad = std::getenv("MB_NODQUAD") != nullptr;
    /* `!g.wantDist` gates this, and the field pass always sets wantDist
     * because some scheme may read the distance, so the vector kernel never
     * runs there.  Opening it up for the skipDeriv case was tried and
     * reverted: `perturbQuad` has no per-step cycle finder, only the fixed and
     * 32-step rolling snapshots, and those close a cycle only when its period
     * divides 32.  A period-77 bulb of a 1e-44 frame therefore drifted out of
     * the bailout at n≈4000 and was drawn as a filament — 194 interior pixels
     * wrong.  Giving the kernel a real Brent finder fixed the picture exactly
     * (0 pixel difference) but cost 3.7x, because the finder is a per-step
     * vector compare plus four blends on top of a 15-op loop.  A step-count
     * threshold cannot separate the two cases either: those pixels escape
     * inside the normal escape band.  Until the finder can be made cheap, the
     * scalar kernel keeps the field path. */
    const bool quad = !noQuad && perturb && !onlyGlitch && src.size() == 1 &&
                      !g.wantDist && !g.wantTrap &&
                      q.spec.kind == 0 && q.spec.power == 2;
    /* Same four-wide treatment for the shallow frames: no reference orbit, so
     * the four lanes are simply four neighbouring pixels of z^2+c.  Opening
     * this up to the field pass (skipDeriv) is safe where perturbQuad is not:
     * directQuad2 carries the analytic cardioid / period-2 test and a cycle
     * check every four steps, so bounded pixels keep a real period.  The one
     * case it cannot name — a bounded orbit whose cycle it never closed — is
     * handed back as kRecheck and re-run by directPixel. */
    const bool dquadBase = !noQuad && !noDQuad && !perturb && !onlyGlitch &&
                           (!g.wantDist || g.skipDeriv) && !g.wantTrap &&
                           q.spec.kind == 0 && q.spec.power == 2;
    /* A bounded pixel the vector kernel cannot name a period for has to be
     * re-run by directPixel, and in the meantime the vector loop has already
     * burned its whole iteration cap on it.  A frame dominated by high-order
     * bulbs — the cardioid shortcut only covers periods 1 and 2 — therefore
     * ends up doing both jobs: measured 5.6 ms against 3.5 ms for the plain
     * scalar pass on a period-3-heavy view.  Once the re-checks pile up past
     * 2% of the frame, the vector path has clearly guessed wrong about this
     * picture and the remaining rows go scalar. */
    /* Counted per strip, not globally: a shared atomic on the pixel path means
     * fifteen threads hammering one cache line, and that alone turned a 90 ms
     * frame into 120 ms.  A strip only needs to know how often *it* guessed
     * wrong, and the threshold scales with its own row count. */
    long long stripRecheck = 0;
    const long long dqLimit = (long long)w * (long long)(y1 - y0) / 200;

    for (int y = y0; y < y1; ++y) {
      /* A field-only pass has no pixel buffer; `row` is then null and only
       * ever reaches emit(), which branches before touching it. */
      uint8_t* row = out ? out + (size_t)(y * pitch) * 4 : nullptr;
      uint8_t* mrow = glitchMask.data() + (size_t)y * (size_t)w;
      /* Pixels this row does not produce keep a NaN, so the neighbour test
       * below cannot read a value from two rows ago and invent a gradient (and
       * with it a blur) along every canvas cell boundary. */
      std::fill(nuCur.begin(), nuCur.end(), kNoNu);
      const double fy = (double)(q.tileY + y);
      const uint8_t* doneRow = canvasDone.data() + (size_t)y * (size_t)w;

      int x0 = 0;
#if defined(__AVX2__)
      if (quad) {
        double fxs[4];
        int nn[4];
        double mm[4], rr[4];
        /* CHANNEL_VALUE: the kernel reports z at |z| = 2 per lane. */
        double vzr[4] = {0, 0, 0, 0}, vzi[4] = {0, 0, 0, 0};
        static const bool quadOne = std::getenv("MB_QUAD1") != nullptr;
        /* The vector kernel can prove a lane escaped, but it can only name a
         * period when the cycle divides its 32-step snapshot grid.  Anything
         * it hands back as kRecheck is bounded, so one scalar pass costs one
         * orbit of a pixel that is interior anyway — and it recovers the exact
         * `-1 - period` the field encodes. */
        auto emitQuad = [&](int x, int n, double m2, double rel, double zr,
                            double zi) {
          if (n == kRecheck) {
            double unusedDist = 0.0;
            n = pertPixel(g, (double)(q.tileX + x), fy, 0, m2, rel, unusedDist);
            zr = zi = 0.0;     // interior: no escape value
          }
          emit(x, y, row, mrow, n, m2, rel, 0.0, zr, zi);
        };
        for (; x0 + 3 < w; x0 += 4) {
          /* A fully interpolated group needs no iteration at all.  Skipping
           * whole groups keeps the vector loop aligned: breaking out of it
           * here would push every remaining pixel into the scalar kernel and
           * cost more than the interpolation saves. */
          if (doneRow[x0] & doneRow[x0 + 1] & doneRow[x0 + 2] & doneRow[x0 + 3])
            continue;
          for (int k = 0; k < 4; ++k) fxs[k] = (double)(q.tileX + x0 + k);
          if (quadOne) {
            for (int k = 0; k < 4; ++k) {
              if (doneRow[x0 + k]) continue;
              double one2[4] = {fxs[k], fxs[k], fxs[k], fxs[k]};
              lReb += perturbQuad(g, src[0], one2, fy, 4, nn, mm, rr,
                                  g.zOnly ? vzr : nullptr,
                                  g.zOnly ? vzi : nullptr);
              emitQuad(x0 + k, nn[0], mm[0], rr[0], vzr[0], vzi[0]);
            }
          } else {
            lReb += perturbQuad(g, src[0], fxs, fy, 4, nn, mm, rr,
                                g.zOnly ? vzr : nullptr,
                                g.zOnly ? vzi : nullptr);
            for (int k = 0; k < 4; ++k)
              if (!doneRow[x0 + k])
                emitQuad(x0 + k, nn[k], mm[k], rr[k], vzr[k], vzi[k]);
          }
        }
        /* A genuine row tail (at most three pixels) uses the same kernel with
         * the remaining lanes repeating the last column. */
        if (x0 < w && x0 + 3 >= w) {
          /* Tail: the same kernel with three dead lanes. */
          for (int k = 0; k < 4; ++k)
            fxs[k] = (double)(q.tileX + std::min(w - 1, x0 + k));
          const int live = w - x0;
          lReb += perturbQuad(g, src[0], fxs, fy, 4, nn, mm, rr,
                              g.zOnly ? vzr : nullptr, g.zOnly ? vzi : nullptr);
          for (int k = 0; k < live; ++k)
            if (!doneRow[x0 + k])
              emitQuad(x0 + k, nn[k], mm[k], rr[k], vzr[k], vzi[k]);
          x0 = w;
        }
      }
#endif
      (void)quad;

#if defined(__AVX2__)
      if (dquadBase && stripRecheck <= dqLimit) {
        double fxs[4];
        int nn[4];
        double mm[4];
        double vzr[4] = {0, 0, 0, 0}, vzi[4] = {0, 0, 0, 0};
        /* A lane the kernel could not resolve — bounded, but neither the bulb
         * test nor its four-step cycle check named a period — is re-run here.
         * directPixel answers most of those from the analytic bulb shortcut
         * without iterating at all. */
        auto emitDirect = [&](int x, int n, double m2, double zr, double zi) {
          if (n == kRecheck) {
            ++stripRecheck;
            double rel = 0.0, der2 = 0.0;
            ValueProbe vp;
            n = directPixel(g, (double)(q.tileX + x), fy, m2, rel, der2,
                            g.zOnly ? &vp : nullptr);
            zr = g.zOnly ? vp.zr : 0.0;
            zi = g.zOnly ? vp.zi : 0.0;
          }
          emit(x, y, row, mrow, n, m2, 0.0, 0.0, zr, zi);
        };
        for (; x0 + 3 < w; x0 += 4) {
          if (doneRow[x0] & doneRow[x0 + 1] & doneRow[x0 + 2] & doneRow[x0 + 3])
            continue;
          for (int k = 0; k < 4; ++k) fxs[k] = (double)(q.tileX + x0 + k);
          directQuad2(g, fxs, fy, 4, nn, mm,
                      g.zOnly ? vzr : nullptr, g.zOnly ? vzi : nullptr);
          for (int k = 0; k < 4; ++k)
            if (!doneRow[x0 + k])
              emitDirect(x0 + k, nn[k], mm[k], vzr[k], vzi[k]);
        }
        /* A genuine row tail (at most three pixels). */
        if (x0 < w && x0 + 3 >= w) {
          for (int k = 0; k < 4; ++k)
            fxs[k] = (double)(q.tileX + std::min(w - 1, x0 + k));
          const int live = w - x0;
          directQuad2(g, fxs, fy, 4, nn, mm,
                      g.zOnly ? vzr : nullptr, g.zOnly ? vzi : nullptr);
          for (int k = 0; k < live; ++k)
            if (!doneRow[x0 + k])
              emitDirect(x0 + k, nn[k], mm[k], vzr[k], vzi[k]);
          x0 = w;
        }
      }
#endif

      for (int x = x0; x < w; ++x) {
        if (doneRow[x]) continue;          // filled by the canvas pass
        if (onlyGlitch && mrow[x] == 0) continue;
        const double fx = (double)(q.tileX + x);
        int n;
        double m2 = 0.0;
        double rel = 0.0;
        double der2 = 0.0;
        /* CHANNEL_VALUE needs z at the escape point.  The probe stays null
         * unless the request asked for it, so the common field pass pays
         * nothing for the branch. */
        ValueProbe vp;
        ValueProbe* pp = g.zOnly ? &vp : nullptr;
        if (!perturb) {
          n = directPixel(g, fx, fy, m2, rel, der2, pp);
        } else if (src.size() == 1) {
          n = pertPixel(g, fx, fy, 0, m2, rel, der2, pp);
        } else {
          /* Use the reference anchored closest to this pixel: that is the
           * deviation of smallest magnitude, i.e. the least likely to glitch. */
          double dcr, dci;
          screenDelta(g, fx, fy, dcr, dci);
          int best = 0;
          double bestD = 1e300;
          for (size_t r = 0; r < src.size(); ++r) {
            const double dr = dcr - src[r].dRe;
            const double di = dci - src[r].dIm;
            const double d = dr * dr + di * di;
            if (d < bestD) {
              bestD = d;
              best = (int)r;
            }
          }
          n = pertPixel(g, fx, fy, best, m2, rel, der2, pp);
          if (n == kGlitch) {
            for (size_t r = 0; r < src.size(); ++r) {
              if ((int)r == best) continue;
              n = pertPixel(g, fx, fy, (int)r, m2, rel, der2, pp);
              if (n != kGlitch) break;
            }
          }
        }
        emit(x, y, row, mrow, n, m2, rel, der2, vp.zr, vp.zi);
      }
      /* Next row: the row just finished becomes the "above" reference. */
      std::swap(nuPrev, nuCur);
      havePrevRow = true;
    }

    if (lReb) g_quadReb.fetch_add(lReb, std::memory_order_relaxed);
    if (lIter) iterCount.fetch_add(lIter, std::memory_order_relaxed);
    if (lGlitch) glitchCount.fetch_add(lGlitch, std::memory_order_relaxed);
    if (lBounded) boundedCount.fetch_add(lBounded, std::memory_order_relaxed);
    if (lMin != INT32_MAX) {
      const int p1 = maxIterSeen.load(std::memory_order_relaxed);
      if (lMax > p1) maxIterSeen.store(lMax, std::memory_order_relaxed);
      const int p2 = escMin.load(std::memory_order_relaxed);
      if (lMin < p2) escMin.store(lMin, std::memory_order_relaxed);
      const int p3 = escMax.load(std::memory_order_relaxed);
      if (lMaxE > p3) escMax.store(lMaxE, std::memory_order_relaxed);
    }
  };

  const int strip = std::max(1, std::min(32, h / std::max(1, threads * 4)));
  const int nStrips = (h + strip - 1) / strip;

  auto runPass = [&](const std::vector<Ref>& src, bool onlyGlitch) {
    parallelFor(nStrips, [&](int s) {
      if (gen.load(std::memory_order_relaxed) != myGen) return;
      const int y0 = s * strip;
      const int y1 = std::min(h, y0 + strip);
      drawRange(y0, y1, src, onlyGlitch);
    });
  };
  const auto tPass0 = clock::now();
  runPass(refs, false);
  if (const char* tf = std::getenv("MB_TIMING")) {
    const double ms = std::chrono::duration<double, std::milli>(
                          clock::now() - tPass0).count();
    /* A windowed process has no stderr, so the timing goes to the file named
     * by MB_TIMING (and to stderr as well, which the bench tool does show). */
    std::fprintf(stderr,
                 "[timing] w=%d h=%d strips=%d strip=%d threads=%d iter=%d "
                 "bounded=%d pixel=%.1fms %.1f ns/px\n",
                 w, h, nStrips, strip, threads, maxIter, boundedCount.load(),
                 ms, ms * 1e6 / (double)(w * h));
    if (FILE* f = std::fopen(tf, "a")) {
      std::fprintf(f,
                   "[timing] w=%d h=%d strips=%d strip=%d threads=%d iter=%d "
                   "bounded=%d pixel=%.1fms %.1f ns/px\n",
                   w, h, nStrips, strip, threads, maxIter, boundedCount.load(),
                   ms, ms * 1e6 / (double)(w * h));
      std::fclose(f);
    }
  }

  /* ---- glitch repair (KF's AddReference) --------------------------- */
  int glitches = glitchCount.load();
  st.glitches = glitches;
  if (perturb && glitches > 0 && gen.load(std::memory_order_relaxed) == myGen) {
    /* Bucket the glitched pixels on a 32x32 grid and drop a reference on the
     * busiest buckets; a reference there makes the deviation small again. */
    const int bw = (w + 31) / 32, bh = (h + 31) / 32;
    std::vector<int> bucket((size_t)bw * (size_t)bh, 0);
    for (int y = 0; y < h; ++y) {
      const uint8_t* mrow = glitchMask.data() + (size_t)y * (size_t)w;
      for (int x = 0; x < w; ++x)
        if (mrow[x])
          ++bucket[(size_t)(y / 32) * (size_t)bw + (size_t)(x / 32)];
    }
    std::vector<std::pair<int, int>> order;
    order.reserve(bucket.size());
    for (size_t i = 0; i < bucket.size(); ++i)
      if (bucket[i] > 0) order.emplace_back(bucket[i], (int)i);
    std::sort(order.begin(), order.end(),
              [](const std::pair<int, int>& a, const std::pair<int, int>& b) {
                return a.first > b.first;
              });
    const int want = std::min((int)order.size(), kMaxExtraRefs);
    for (int i = 0; i < want; ++i) {
      const int id = order[(size_t)i].second;
      const int cx = (id % bw) * 32 + 16;
      const int cy = (id / bw) * 32 + 16;
      Ref extra;
      double dRe, dIm;
      screenDelta(g, (double)(q.tileX + cx), (double)(q.tileY + cy), dRe, dIm);
      const int elen = buildReference(q, bits, maxIter, dRe, dIm, &extra,
                                     &gen, myGen);
      if (elen == kOrbitCancelled) return;
      if (elen <= 0) continue;
      extra.dRe = dRe;
      extra.dIm = dIm;
      const double dcMax = 0.5 * std::hypot((double)vw, (double)vh) * ps;
      const double ehw = 0.5 * (double)vw * ps, ehh = 0.5 * (double)vh * ps;
      double eMax = 0.0;
      for (int sy = -1; sy <= 1; sy += 2) {
        for (int sx = -1; sx <= 1; sx += 2) {
          const double d = std::hypot((double)sx * ehw - dRe,
                                      (double)sy * ehh - dIm);
          if (d > eMax) eMax = d;
        }
      }
      buildFolds(extra, q.spec.kind);
      if (famKernel) buildDevTable(extra, q.spec.power);
      buildSeries(extra, eMax, q.spec.mode != 1, q.spec.power, q.spec.kind);
      refs.push_back(std::move(extra));
    }
    st.references = (int)refs.size();
    if (refs.size() > 1) {
      g.refs = &refs;
      runPass(refs, true);
      st.glitches = glitchCount.load();
    }
  }

  /* ---- last resort: iterate the leftovers directly -----------------
   *
   * Anything still unshaded has no reference that describes it — the frame
   * simply has no long-lived point near it, or the deviation outgrew every
   * anchor we could afford.  Rather than leave those pixels as whatever the
   * previous frame had there (the classic "black speckle" at depth), iterate
   * them from scratch at the frame's own precision.  It is the slow path, so
   * it runs last, on the leftovers only, and reports how many it touched.
   */
  if (glitchCount.load() > 0 && gen.load(std::memory_order_relaxed) == myGen) {
    BigSeed seed;
    seed.julia = g.julia;
    if (g.julia) {
      seed.cRe = Big::fromString(q.spec.juliaReS.empty()
                                     ? std::to_string(q.spec.juliaRe)
                                     : q.spec.juliaReS, bits);
      seed.cIm = Big::fromString(q.spec.juliaImS.empty()
                                     ? std::to_string(q.spec.juliaIm)
                                     : q.spec.juliaImS, bits);
      seed.zRe = Big::fromString(q.centerRe, bits);
      seed.zIm = Big::fromString(q.centerIm, bits);
    } else {
      seed.cRe = Big::fromString(q.centerRe, bits);
      seed.cIm = Big::fromString(q.centerIm, bits);
    }
    /* Bound the work: a pathological frame must not turn one pass into a
     * minute of silence.  Everything that fits is fixed; past that the pass
     * ends and the count says so. */
    const long long budgetPx = std::max<long long>(20000, (long long)w * h / 8);
    std::atomic<long long> done{0};
    parallelFor(nStrips, [&](int s) {
      if (gen.load(std::memory_order_relaxed) != myGen) return;
      const int y0 = s * strip;
      const int y1 = std::min(h, y0 + strip);
      for (int y = y0; y < y1; ++y) {
        uint8_t* row = out ? out + (size_t)(y * pitch) * 4 : nullptr;
        uint8_t* mrow = glitchMask.data() + (size_t)y * (size_t)w;
        const double fy = (double)(q.tileY + y);
        for (int x = 0; x < w; ++x) {
          if (!mrow[x]) continue;
          if (done.fetch_add(1, std::memory_order_relaxed) >= budgetPx) return;
          const double fx = (double)(q.tileX + x);
          double m2 = 0.0, rel = 0.0;
          const int n = bigPixel(g, seed, bits, fx, fy, m2, rel);
          mrow[x] = 0;
          if (fieldOut) {
            float* f = fieldOut->at(x, y);
            if (n < 0) {
              const double cyc = (n < -1) ? (double)(-n - 1) : 0.0;
              f[0] = (float)(-cyc);
              f[2] = (float)(-cyc);
            } else {
              f[0] = (float)smoothIteration(n, m2, rel);
              f[2] = (float)n;
            }
            f[1] = 0.0f;
            f[3] = 0.0f;
          } else {
            shade(row + (size_t)x * 4, g, n, m2, rel, 0.0);
          }
        }
      }
    });
    st.directFixed = (int)std::min<long long>(done.load(), budgetPx);
    glitchCount.store(0);
    for (int y = 0; y < h; ++y) {
      const uint8_t* mrow = glitchMask.data() + (size_t)y * (size_t)w;
      for (int x = 0; x < w; ++x) glitchCount.fetch_add(mrow[x] ? 1 : 0);
    }
    st.glitches = glitchCount.load();
  }

  prof.aa = prof.ms();
  static const bool noAA = std::getenv("MB_NOAA") != nullptr;
  /* ---- adaptive supersampling --------------------------------------
   *
   * The reference always renders SAMPLES x SAMPLES sub-pixels per pixel —
   * the shipped examples use samples = 2, i.e. four samples — which is why
   * its filaments stay smooth instead of breaking into stair steps.  Four
   * samples for every pixel of a 2.9 Mpx frame is a 4x cost, and most pixels
   * sit inside a flat band where it changes nothing, so the budget is spent
   * where the picture actually varies: a pixel is resampled only when it
   * differs from a neighbour by more than one 8-bit step.
   */
  if (!fieldOut && q.aa > 1 && w > 1 && h > 1 &&
      gen.load(std::memory_order_relaxed) == myGen) {
    const int S = q.aa;
    std::vector<uint8_t> aaMark((size_t)w * (size_t)h, 0);
    int edges = 0;
    for (int y = 0; y < h; ++y) {
      const uint8_t* row = out + (size_t)(y * pitch) * 4;
      for (int x = 0; x < w; ++x) {
        const uint8_t* p = row + (size_t)x * 4;
        int m = 0;
        for (int k = 0; k < 3; ++k) {
          if (x + 1 < w)
            m = std::max(m, std::abs((int)p[k] - (int)p[4 + k]));
          if (y + 1 < h)
            m = std::max(m, std::abs((int)p[k] - (int)p[(size_t)pitch * 4 + k]));
        }
        /* Only the pixels the canvas had to subdivide can alias: a filled
         * cell is a bilinear ramp by construction, so re-sampling it four
         * times produces the same colour.  Restricting the pass this way keeps
         * the cost on the detail that actually needs it. */
        if (m > 36 && canvasDone[(size_t)y * w + x] == 0) {
          aaMark[(size_t)y * w + x] = 1;
          ++edges;
        }
      }
    }
    /* A frame that is nearly all edges does not have an aliasing problem, it
     * has detail: every pixel differs from its neighbour because the picture
     * is filaments, and re-sampling all of them costs five scalar evaluations
     * per pixel — measured 8.7x on a 1e-24 frame, which is not a trade worth
     * making.  The pass pays for itself on frames with real flat area, and
     * that is exactly where stair steps are visible. */
    const long long edgeBudget = (long long)w * (long long)h * 2 / 5;
    if (edges > 0 && (long long)edges <= edgeBudget) {
      std::atomic<long long> aaDone{0};
      parallelFor(nStrips, [&](int s) {
        if (gen.load(std::memory_order_relaxed) != myGen) return;
        const int y0 = s * strip;
        const int y1 = std::min(h, y0 + strip);
        for (int y = y0; y < y1; ++y) {
          uint8_t* row = out + (size_t)(y * pitch) * 4;
          const uint8_t* mrow = aaMark.data() + (size_t)y * w;
          const double fy = (double)(q.tileY + y);
          for (int x = 0; x < w; ++x) {
            if (!mrow[x]) continue;
            const double fx = (double)(q.tileX + x);
            double ar = 0.0, ag = 0.0, ab = 0.0;
            uint8_t tmp[4];
            for (int j = 0; j < S; ++j) {
              const double sy = fy + (j + 0.5) / S - 0.5;
              for (int i = 0; i < S; ++i) {
                const double sx = fx + (i + 0.5) / S - 0.5;
                double m2 = 0.0, rel = 0.0, der2 = 0.0;
                int n = -1;
                if (!perturb) n = directPixel(g, sx, sy, m2, rel, der2);
                else if (!refs.empty()) n = pertPixel(g, sx, sy, 0, m2, rel, der2);
                shade(tmp, g, n, m2, rel, der2);
                ar += tmp[0]; ag += tmp[1]; ab += tmp[2];
              }
            }
            const double inv = 1.0 / (double)(S * S);
            uint8_t* p = row + (size_t)x * 4;
            p[0] = (uint8_t)(ar * inv + 0.5);
            p[1] = (uint8_t)(ag * inv + 0.5);
            p[2] = (uint8_t)(ab * inv + 0.5);
            p[3] = 255;
            aaDone.fetch_add(1, std::memory_order_relaxed);
          }
        }
      });
      st.aaPixels = (int)std::min<long long>(aaDone.load(), (long long)w * h);
    }
  }

  st.rebases = (int)((g_quadReb.exchange(0) + g_rebaseCount.exchange(0)) & 0x7fffffff);
  /* The quadtree is now the only stage that integrates anything, so the frame
   * statistics have to come from it as well as from the exact leaves. */
  st.maxIterUsed = std::max(maxIterSeen.load(), cvMaxN);
  st.iterPixels += iterCount.load();
  if (frameLo >= 0) {
    st.escapeMin = frameLo;
    st.escapeMax = frameHi;
  } else {
    int lo = escMin.load() == INT32_MAX ? 0 : escMin.load();
    int hi = escMax.load();
    if (cvEscLo != INT32_MAX) {
      lo = (lo > 0) ? std::min(lo, cvEscLo) : cvEscLo;
      hi = std::max(hi, cvEscHi);
    }
    st.escapeMin = lo;
    st.escapeMax = hi;
  }
  st.bounded = boundedCount.load() + cvBounded;
  st.glitches += glitchPx;

  /* checkcanvas_hfloat (00498570.c) is the re-check pass: a vertex that ran
   * out of limit is recomputed with a higher maxiter.  Our evidence is a
   * frame whose interior is dominant and whose work reached (or sat at) the
   * limit.  A genuinely smooth flat region escapes early, so it does not
   * trigger a pointless refinement. */
  if (!noObserved) {
    /* Evidence that the limit was too tight, without confusing genuine
     * interior for exhaustion:
     *   - a frame dominated by analytically interior pixels (cardioid/bulb,
     *     already filled by the canvas pass) is never evidence;
     *   - otherwise either a pixel escaped right at the limit, or nothing
     *     escaped at all while pixels were reported bounded.
     * Treating a pure interior tile as "exhausted" previously raised the cap
     * five-fold on every pass and made a 190-tile window 14x slower. */
    /* Analytically interior means the cell was filled from the cardioid/bulb
     * closed form, not "interpolated": an interpolated escape cell is real
     * work and must not mask exhaustion. */
    /* Only the Mandelbrot set has an analytic interior (the cardioid and the
     * period-2 disc) that fills cells without iterating.  A Julia frame whose
     * pixels are all bounded got here by *running* the orbit to the cap, which
     * is direct evidence the limit is too tight — treating it as "analytic"
     * froze the budget and turned every deep Julia view into noise. */
    const bool analyticDominant = q.spec.mode == 0 && cvBounded * 2 > st.pixels;
    const bool exhausted =
        st.maxIterUsed >= maxIter - 1 ||
        (st.maxIterUsed == 0 && st.bounded > 0);
    const bool tooTight = !analyticDominant && exhausted && st.bounded > 0;
    std::lock_guard<std::mutex> lk(iterMu);
    if (iter.valid && iter.key == passKey) {
      iter.observedMax = std::max(iter.observedMax, st.maxIterUsed);
      iter.lastCeiling = ceiling;
      if (tooTight) iter.hitLimit = 1;
      for (int i = 0; i < 4; ++i)
        iter.corners[i] = std::max(
            iter.corners[i], cornerVals[i].load(std::memory_order_relaxed));
    }
  }
  st.iterCeiling = ceiling;
  st.cornerKnown = cornerKnown;
  st.iterBudget = iterBudget;
  st.observedMax = std::max(observedMax, st.maxIterUsed);
  st.refinePass = refinePass;
  if (prof.on) {
    const double tot = prof.ms();
    if (FILE* f = std::fopen(std::getenv("MB_PROFILE_FILE"), "a")) {
      std::fprintf(f, "tile=%d,%d %dx%d of %dx%d orbit=%.2f lut=%.2f canvas=%.2f pixel=%.2f aa=%.2f total=%.2f\n",
                   q.tileX, q.tileY, w, h, vw, vh, prof.orbit,
                   prof.lut - prof.orbit, prof.canvas - prof.lut,
                   prof.pixel - prof.canvas, prof.aa - prof.pixel, tot);
      std::fclose(f);
    }
  }
  st.renderMs =
      std::chrono::duration<double, std::milli>(clock::now() - tOrb0).count();
  st.frameMs =
      std::chrono::duration<double, std::milli>(clock::now() - t0).count();

  /* ---- store the finished area ------------------------------------
   * The tile is now what the next pass of the same frame would draw, so it
   * becomes the area texture drawarea (00522180) would sample.  Refresh in
   * place when the key already exists (a refined pass replaces the preview),
   * otherwise push and evict from the back until the cap holds. */
  if (areaKeyed) {
    const size_t bytes = (size_t)w * (size_t)h * 4;
    std::lock_guard<std::mutex> lk(areaMu);
    for (auto& a : areaCache) {
      if (a.key != areaKey) continue;
      for (int y = 0; y < h; ++y)
        std::memcpy(a.tex.data() + (size_t)y * (size_t)w * 4,
                    out + (size_t)y * (size_t)pitch * 4, (size_t)w * 4);
      a.maxIter = st.maxIterUsed;
      a.bounded = st.bounded;
      a.escLo = st.escapeMin;
      a.escHi = st.escapeMax;
      a.glitches = st.glitches;
      return;
    }
    static const size_t kAreaCap = 24u << 20;
    while (!areaCache.empty() && areaBytes + bytes > kAreaCap) {
      areaBytes -= areaCache.back().tex.size();
      areaCache.pop_back();
    }
    AreaTex a;
    a.key = areaKey;
    a.w = w;
    a.h = h;
    a.maxIter = st.maxIterUsed;
    a.bounded = st.bounded;
    a.escLo = st.escapeMin;
    a.escHi = st.escapeMax;
    a.glitches = st.glitches;
    a.tex.resize(bytes);
    for (int y = 0; y < h; ++y)
      std::memcpy(a.tex.data() + (size_t)y * (size_t)w * 4,
                  out + (size_t)y * (size_t)pitch * 4, (size_t)w * 4);
    areaBytes += bytes;
    areaCache.insert(areaCache.begin(), std::move(a));
  }
}

/* --- Engine facade -------------------------------------------------- */

Engine::Engine(int threads) : impl_(new Impl()) {
  const int hc = (int)std::thread::hardware_concurrency();
  impl_->threads = threads > 0 ? threads : std::max(1, hc - 1);
  /* The shell shares the machine with the WebView2 renderer and the page's
   * own compositor.  Handing every core to the fractal leaves those with
   * nothing, and they are on the critical path between two tiles, so the cap
   * is also an environment knob to measure that trade. */
  if (const char* tv = std::getenv("MB_THREADS")) {
    const int v = std::atoi(tv);
    if (v > 0) impl_->threads = v;
  }
  /* The pool owns threads - 1 workers; the calling thread does its share. */
  impl_->pool = std::make_unique<ThreadPool>(std::max(0, impl_->threads - 1));
}

Engine::~Engine() = default;

void Engine::render(const Request& req, uint8_t* out, Stats& stats) {
  impl_->render(req, out, stats, nullptr);
}

void Engine::renderField(const Request& req, Field& field, Stats& stats) {
  const int w = std::max(1, req.width);
  const int h = std::max(1, req.height);
  /* The channel count is part of the request: a VALUE scheme needs six, and
   * asking `fits()` with the default four would quietly resize the caller's
   * six-channel buffer back down to four. */
  const int ch = req.fieldValue ? 6 : 4;
  /* `fits()` accepts either the owned vector or an adopted shared buffer.  A
   * short adopted buffer falls back to an owned one rather than overrunning. */
  if (!field.fits(w, h, ch)) {
    field.resize(w, h, ch);
  }
  /* The kernel writes every texel it is asked for, so a stale field cannot
   * leak into the shader: tiles are always fully covered.  Glitched pixels
   * that survive the last-resort pass keep whatever they had, which is the
   * same contract the RGBA path has (they stay black). */
  impl_->render(req, nullptr, stats, &field);
  field.bounded = stats.bounded;
  field.escapeMin = stats.escapeMin;
  field.escapeMax = stats.escapeMax;
  /* TEMPORARY: measurement for the dist2 verification pass.  Points
   * MB_DIST2_STATS at a file and each field render appends one line with the
   * share of texels whose dist2 is exactly zero plus the largest value seen.
   * Removed once the number is on record. */
  if (const char* dump = std::getenv("MB_DIST2_STATS")) {
    const size_t total = (size_t)w * (size_t)h;
    size_t zero = 0, nonzero = 0;
    double mx = 0.0, mnz = 0.0;
    bool haveNz = false;
    for (size_t i = 0; i < total; ++i) {
      const float v = field.base()[i * 4 + 3];
      if (v == 0.0f) {
        ++zero;
      } else {
        ++nonzero;
        if (!haveNz || v < mnz) { mnz = v; haveNz = true; }
        if (v > mx) mx = v;
      }
    }
    if (FILE* fp = std::fopen(dump, "a")) {
      std::fprintf(fp,
                   "field %dx%d bounded=%d dist2_zero=%zu/%zu (%.4f%%) "
                   "nonzero=%zu min=%.6g max=%.6g\n",
                   w, h, stats.bounded, zero, total,
                   total ? 100.0 * (double)zero / (double)total : 0.0,
                   nonzero, haveNz ? mnz : 0.0, mx);
      std::fflush(fp);
      std::fclose(fp);
    }
  }
}

void Engine::cancel() { impl_->gen.fetch_add(1, std::memory_order_relaxed); }

void Engine::setPaused(bool paused) {
  (void)paused;
}

int Engine::threadCount() const { return impl_->threads; }
int Engine::lastRefLen() const { return impl_->cacheLen; }

}  // namespace mbc
