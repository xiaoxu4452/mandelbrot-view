// Deep-zoom perturbation engine (the "core" of B2).
//
// The model, and the reason the previous implementation produced terraces:
//
//   * one reference orbit Z_n at full precision, per-pixel perturbation d_n
//       z_n = Z_n + d_n,   d_{n+1} = 2 Z_n d_n + d_n^2 + d_0
//   * that algebra is exact, so any error comes from the *choice* of reference
//
// Two failure modes follow from a badly chosen reference:
//
//   1. the reference escapes before the pixel does -> the pixel runs off the
//      end of the stored orbit and every such pixel collapses onto the same
//      iteration count (measured at 1e38: every failure returned 1812 while
//      the true counts were 1821..1892).  Cure: promote the longest-lived
//      point in the frame to be the reference, repeatedly, until nothing
//      outlives it.
//   2. |Z_n + d_n| << |d_n|: adding two nearly opposite numbers.  The sum is
//      then mostly rounding noise, so the pixel is marked and repaired
//      against a reference anchored at the offending pixel itself.
//
// Both cures are the "new reference" hierarchy of the original engine
// (newref_hfloat in the reference design notes), applied until the frame is
// clean instead of per tile.
//
// Per-pixel arithmetic is a binary float-exp (double mantissa, int exponent).
// That is not an optimisation detail: at 1e60000 the pixel offsets are 10^-60000
// and leave the range of double immediately, while the values that matter
// (Z, d, z) stay within a few decades of 1.

#pragma once

#include "bigfloat.hpp"
#include "floatexp.hpp"
#include "render.hpp"

#include <atomic>
#include <cstdint>
#include <vector>

struct DeepParams {
    const BigFloat* cr = nullptr;   // frame centre, full precision
    const BigFloat* ci = nullptr;
    Fexp scale;                     // plane units per pixel
    int width = 0;
    int height = 0;
    int maxiter = 0;
    int digits = 0;                 // decimal digits for reference orbits
    int sa_order = 0;               // 0 disables series approximation
    int max_ref_rounds = 4;         // reference-promotion rounds
    int max_repair_rounds = 16;     // glitch-repair rounds
    int threads = 1;
    bool use_distance = false;
    bool julia = false;
    const BigFloat* jr = nullptr;   // Julia parameter (c fixed, z0 = pixel)
    const BigFloat* ji = nullptr;
    // View rotation about the frame centre.  The identity pair keeps the exact
    // integer-offset path; anything else composes the offset from a rotated
    // pixel basis, which costs two extra float-exp additions per pixel.
    double rot_cos = 1.0;
    double rot_sin = 0.0;
    bool rotated() const { return rot_sin != 0.0 || rot_cos != 1.0; }
    // Cooperative stop.  Polled per row block inside every pass.
    const std::atomic<bool>* cancel = nullptr;
};

struct DeepStats {
    int reference_len = 0;          // length of the reference finally used
    int references = 0;             // how many orbits were built
    long long glitches = 0;         // pixels repaired at least once
    int sa_skip = 0;                // iterations skipped by the series
    int rounds_used = 0;
    long long steps = 0;            // perturbation steps actually executed
    int esc_min = 0;                // smallest escape count in the frame
    int esc_max = 0;                // largest escape count in the frame
    bool cancelled = false;
};

// Fills `out` with width*height pixels in row-major order.
void deep_render(const DeepParams& p, std::vector<PixelOut>& out, DeepStats* st);
