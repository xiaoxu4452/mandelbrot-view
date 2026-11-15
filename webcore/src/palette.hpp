// Palette reconstruction.
//
// The recovered GLSL (core_fractal.glsl) implements
//     c = sum_i  color_i * 0.5 * (1 + sin(iter * frequency_i + initial_i))
// followed by a max-channel normalization.  We reproduce that formula on the
// CPU.  Built-in component sets are taken from the shipped examples and the
// remaining schemes are clean scientific alternatives.

#pragma once

#include <string>
#include <vector>

struct RGB {
    double r = 0, g = 0, b = 0;
};

struct SineComponent {
    double r = 1, g = 1, b = 1;
    double frequency = 1.0;
    double initial = 0.0;
};

class Palette {
public:
    std::vector<SineComponent> comps;
    double brightness = 1.0;

    RGB eval(double t) const;
    static Palette by_name(const std::string& name);
};

struct HSV {
    double h = 0.0;  // [0,1)
    double s = 0.0;  // [0,1]
    double v = 0.0;  // [0,1]
};

// hsv / hsvinv from the recovered colour code.
HSV rgb_to_hsv(const RGB& c);
RGB hsv_to_rgb(const HSV& c);

RGB lerp_rgb(const RGB& a, const RGB& b, double t);
