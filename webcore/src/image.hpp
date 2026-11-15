#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct Image {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> rgb;  // width * height * 3, row-major, top row first

    void resize(int w, int h) {
        width = w;
        height = h;
        rgb.assign((size_t)w * h * 3, 0);
    }
    uint8_t* pixel(int x, int y) {
        return &rgb[((size_t)y * width + x) * 3];
    }
};

bool write_png(const std::string& path, const Image& img, std::string* error);
bool write_ppm(const std::string& path, const Image& img, std::string* error);
