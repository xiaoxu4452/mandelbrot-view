#include "palette.hpp"

#include <algorithm>
#include <cmath>

RGB Palette::eval(double t) const {
    double r = 0, g = 0, b = 0;
    for (const auto& c : comps) {
        double amp = 0.5 * (1.0 + std::sin(t * c.frequency + c.initial));
        r += c.r * amp;
        g += c.g * amp;
        b += c.b * amp;
    }
    r *= brightness;
    g *= brightness;
    b *= brightness;
    double m = std::max({r, g, b});
    if (m > 1.0) {
        r /= m;
        g /= m;
        b /= m;
    }
    return {std::clamp(r, 0.0, 1.0), std::clamp(g, 0.0, 1.0), std::clamp(b, 0.0, 1.0)};
}

Palette Palette::by_name(const std::string& name) {
    Palette p;
    if (name == "rainbow") {
        p.comps = {
            {0.0, 0.85, 1.0, 1.0, 0.0},
            {1.0, 0.15, 0.6, 1.3, 2.0},
            {1.0, 0.9, 0.2, 0.7, 4.0},
        };
    } else if (name == "nebula") {
        p.comps = {
            {0.0, 0.85, 1.0, 1.8, 0.0},
            {1.0, 0.15, 0.6, 2.2, -0.4},
        };
        p.brightness = 0.9;
    } else if (name == "fire") {
        p.comps = {
            {1.0, 0.25, 0.02, 1.0, 0.0},
            {1.0, 0.72, 0.10, 2.3, 1.2},
            {0.25, 0.05, 0.0, 0.5, 3.0},
        };
    } else if (name == "ocean") {
        p.comps = {
            {0.02, 0.20, 1.0, 1.0, 0.0},
            {0.0, 0.75, 0.95, 1.7, 1.8},
            {0.55, 1.0, 0.9, 0.6, 3.9},
        };
    } else if (name == "mono" || name == "grayscale") {
        p.comps = {{1.0, 1.0, 1.0, 1.0, 0.0}};
    } else if (name == "rainbow2") {
        p.comps = {
            {1.0, 0.0, 0.0, 1.0, 0.0},
            {0.0, 1.0, 0.0, 1.0, 2.0943951},
            {0.0, 0.0, 1.0, 1.0, 4.1887902},
        };
    } else {
        // default to the original "Smooth" look
        p = by_name("rainbow");
    }
    return p;
}

RGB lerp_rgb(const RGB& a, const RGB& b, double t) {
    t = std::clamp(t, 0.0, 1.0);
    return {a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t};
}
HSV rgb_to_hsv(const RGB& c) {
    double r = std::clamp(c.r, 0.0, 1.0);
    double g = std::clamp(c.g, 0.0, 1.0);
    double b = std::clamp(c.b, 0.0, 1.0);
    double mx = std::max({r, g, b});
    double mn = std::min({r, g, b});
    double d = mx - mn;
    HSV out;
    out.v = mx;
    out.s = (mx > 0.0) ? d / mx : 0.0;
    if (d <= 0.0) {
        out.h = 0.0;
    } else if (mx == r) {
        out.h = std::fmod((g - b) / d, 6.0) / 6.0;
    } else if (mx == g) {
        out.h = ((b - r) / d + 2.0) / 6.0;
    } else {
        out.h = ((r - g) / d + 4.0) / 6.0;
    }
    if (out.h < 0.0) out.h += 1.0;
    return out;
}

RGB hsv_to_rgb(const HSV& c) {
    double h = c.h - std::floor(c.h);
    double s = std::clamp(c.s, 0.0, 1.0);
    double v = std::clamp(c.v, 0.0, 1.0);
    double sector = h * 6.0;
    int i = (int)std::floor(sector);
    double f = sector - (double)i;
    double p = v * (1.0 - s);
    double q = v * (1.0 - s * f);
    double t = v * (1.0 - s * (1.0 - f));
    switch (i % 6) {
        case 0: return {v, t, p};
        case 1: return {q, v, p};
        case 2: return {p, v, t};
        case 3: return {p, q, v};
        case 4: return {t, p, v};
        default: return {v, p, q};
    }
}