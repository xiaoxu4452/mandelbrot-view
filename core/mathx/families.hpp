// ---------------------------------------------------------------------------
// families.hpp — deep rendering for the folded families and for user formulas.
//
// The polynomial core (deep.cpp) owns z^p + c.  Everything else used to stop at
// about 1e-13 on the desktop, because the pixel recurrence needs the reference
// orbit's *fold signs* and its derivatives at every step:
//
//   tricorn      conj(z)^2 + c
//   burning ship (|x| + i|y|)^2 + c
//   celtic       |x^2 - y^2| + i 2xy + c
//   perpendicular x^2 - y^2 + i|2xy| + c
//   phoenix      z^2 + c + p z_{n-1}
//
// For these five the delta recurrence is an exact polynomial (no Taylor
// truncation), so a frame at 1e120 is as exact as one at 1e2.  A user formula
// is handled with the second-order Taylor perturbation
//   du = A u + B dc + ps (C u^2 + D u ubar + E ubar^2)
// with A, B, C, D, E taken from the expression's own second-order jet along the
// arbitrary-precision reference orbit -- no finite differences, so the
// coefficients are exact to the working precision.
//
// Per-pixel arithmetic is double, in units of the pixel scale (u = delta / ps),
// which is what keeps a 1e120 frame in registers: the reference values are
// O(1), u is O(1) until escape, and the only large numbers are the fold
// quotients A/ps and B/ps.
// ---------------------------------------------------------------------------
#pragma once

#include "../floatexp.hpp"
#include "../render.hpp"
#include "expr.hpp"

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace mx {

using ::Fexp;
using ::PixelOut;

struct FamilyView {
    int kind = 1;           // 1 tricorn, 2 burning ship, 3 celtic, 4 perpendicular, 5 phoenix, 6 formula
    int mode = 0;           // 0 Mandelbrot, 1 Julia
    const Program* formula = nullptr;
    std::string centerRe = "-0.6";
    std::string centerIm = "0";
    std::string juliaRe, juliaIm;
    int width = 1, height = 1;
    int maxiter = 1000;
    int digits = 0;         // 0 = derive from the pixel scale
    Fexp ps;                // plane units per pixel
    double bail2 = 4.0;
    double rotCos = 1.0, rotSin = 0.0;
    /* Phoenix's p and the formula sliders travel as decimal strings: a
     * parameter that is only 16 digits long caps the useful depth at about
     * 1e16, because the reference orbit stops being the map the user asked
     * for.  Parse-at-full-precision is what lets a phoenix view go as deep as
     * a Mandelbrot one. */
    std::string phoenixP = "0.5667";
    std::vector<BigFloat> params;   // one per Program::params entry
    int threads = 0;
    const std::atomic<bool>* cancel = nullptr;
};

struct FamilyStats {
    bool ok = false;
    const char* error = "";
    double ms = 0.0;
    int refLen = 0;
    int refs = 0;
    long long glitches = 0;
    int escMin = 0, escMax = 0;
    int bounded = 0;
    int digits = 0;
};

bool renderFamily(const FamilyView& v, std::vector<PixelOut>& out, FamilyStats* st);

/* A boundary point of a family, at arbitrary precision.
 *
 * Solves z_{m+p}(c) = z_m(c) by a 2x2 Newton iteration with central
 * differences: m = 0 is a nucleus (superattracting cycle), m > 0 is a
 * Misiurewicz point (preperiodic, repelling, on the boundary).  A 200-digit
 * point is what makes a 1e120 frame around it show structure instead of a flat
 * field: the set's boundary is the only place where detail survives at that
 * scale. */
struct PointResult {
    bool ok = false;
    const char* error = "";
    std::string re, im;
    int newton_steps = 0;
    double log10_residual = 0.0;
};

PointResult findFamilyPoint(int kind, const std::string& phoenixP, int preperiod, int period,
                            const std::string& guessRe, const std::string& guessIm,
                            int digits, int max_newton);

// Human-readable name for kind 0..6.
const char* familyName(int kind);

}  // namespace mx
