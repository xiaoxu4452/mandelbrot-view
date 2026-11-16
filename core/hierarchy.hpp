// Reference hierarchy — the readable equivalent of newref_hfloat /
// makeref_hfloat.  A primary orbit is anchored at the viewport centre; when a
// tile accumulates cancellation errors a child orbit is anchored at the tile
// centre and shares the parent's precision.  The renderer's tile-rebase path
// is the one-level version of this structure; this class exposes the general
// form for tools and experiments.

#pragma once

#include "reference.hpp"
#include "viewport.hpp"

#include <string>
#include <vector>

struct ReferenceNode {
    BigFloat anchor_re;
    BigFloat anchor_im;
    Orbit orbit;
    int parent = -1;
    int x0 = 0, y0 = 0, width = 0, height = 0;
    int depth = 0;
};

class ReferenceHierarchy {
public:
    std::vector<ReferenceNode> nodes;

    int add_primary(const BigFloat& cr, const BigFloat& ci, int maxiter, int sa_order,
                    const Fexp& delta_max, std::string* error, int digits = 0) {
        ReferenceNode n;
        n.anchor_re = cr;
        n.anchor_im = ci;
        n.orbit.digits = digits;
        n.depth = 0;
        if (!compute_orbit(n.orbit, cr, ci, maxiter, false, sa_order, delta_max, error)) {
            return -1;
        }
        nodes.push_back(std::move(n));
        return (int)nodes.size() - 1;
    }

    // Add a child anchored at the centre of the requested tile.  `julia` is
    // false for Mandelbrot (z0 = 0, c = anchor) and true for Julia
    // (z0 = anchor, c = fixed parameter).
    int add_local(int parent, const Viewport& vp, int x0, int y0, int w, int h,
                  bool julia, const BigFloat& jr, const BigFloat& ji, int maxiter,
                  int sa_order, std::string* error, int digits = 0) {
        if (parent < 0 || parent >= (int)nodes.size()) return -1;
        double cx = (double)(x0 + w * 0.5) - (double)vp.width * 0.5;
        double cy = (double)vp.height * 0.5 - (double)(y0 + h * 0.5);
        Fexp scale = vp.pixel_scale();
        Fexp offx = scale * Fexp(cx);
        Fexp offy = scale * Fexp(cy);
        BigFloat anchor_re = vp.center_re + BigFloat::from_floatexp(offx.m, offx.e);
        BigFloat anchor_im = vp.center_im + BigFloat::from_floatexp(offy.m, offy.e);
        Fexp delta = scale * Fexp(std::sqrt((double)w * w + (double)h * h) * 0.5 + 1.0);
        ReferenceNode n;
        n.anchor_re = anchor_re;
        n.anchor_im = anchor_im;
        n.parent = parent;
        n.x0 = x0;
        n.y0 = y0;
        n.width = w;
        n.height = h;
        n.depth = nodes[(size_t)parent].depth + 1;
        n.orbit.digits = nodes[(size_t)parent].orbit.digits;
        bool ok = julia
                      ? compute_orbit_from(n.orbit, anchor_re, anchor_im, jr, ji, maxiter,
                                           false, sa_order, delta, error)
                      : compute_orbit(n.orbit, anchor_re, anchor_im, maxiter, false,
                                      sa_order, delta, error);
        if (!ok || n.orbit.escaped) return -1;
        nodes.push_back(std::move(n));
        return (int)nodes.size() - 1;
    }

    const ReferenceNode* find_covering(int x, int y) const {
        const ReferenceNode* best = nullptr;
        for (const auto& n : nodes) {
            if (n.parent < 0) {
                if (!best) best = &n;
                continue;
            }
            bool covers = x >= n.x0 && x < n.x0 + n.width && y >= n.y0 && y < n.y0 + n.height;
            if (covers && (!best || n.depth > best->depth)) best = &n;
        }
        return best;
    }
};
