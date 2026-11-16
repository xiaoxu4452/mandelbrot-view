#include "image.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

namespace {

uint32_t crc_table[256];
bool crc_init = false;

void init_crc() {
    if (crc_init) return;
    for (uint32_t n = 0; n < 256; ++n) {
        uint32_t c = n;
        for (int k = 0; k < 8; ++k) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        crc_table[n] = c;
    }
    crc_init = true;
}

uint32_t crc32_bytes(const uint8_t* data, size_t len) {
    init_crc();
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; ++i) c = crc_table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

uint32_t adler32_bytes(const uint8_t* data, size_t len) {
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < len; ++i) {
        a = (a + data[i]) % 65521;
        b = (b + a) % 65521;
    }
    return (b << 16) | a;
}

void put_u32(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back((uint8_t)(v >> 24));
    out.push_back((uint8_t)(v >> 16));
    out.push_back((uint8_t)(v >> 8));
    out.push_back((uint8_t)v);
}

void chunk(std::vector<uint8_t>& out, const char* type, const std::vector<uint8_t>& data) {
    put_u32(out, (uint32_t)data.size());
    std::vector<uint8_t> body;
    body.reserve(4 + data.size());
    body.insert(body.end(), type, type + 4);
    body.insert(body.end(), data.begin(), data.end());
    uint32_t crc = crc32_bytes(body.data(), body.size());
    out.insert(out.end(), body.begin(), body.end());
    put_u32(out, crc);
}

}  // namespace

bool write_png(const std::string& path, const Image& img, std::string* error) {
    if (img.width <= 0 || img.height <= 0) {
        if (error) *error = "empty image";
        return false;
    }
    // Raw scanlines with filter byte 0.
    std::vector<uint8_t> raw;
    raw.reserve((size_t)img.height * (1 + (size_t)img.width * 3));
    for (int y = 0; y < img.height; ++y) {
        raw.push_back(0);
        const uint8_t* row = &img.rgb[(size_t)y * img.width * 3];
        raw.insert(raw.end(), row, row + (size_t)img.width * 3);
    }

    std::vector<uint8_t> z;
    // zlib header: deflate, 32K window, no preset dictionary, check bits valid.
    z.push_back(0x78);
    z.push_back(0x01);
    size_t pos = 0;
    while (pos < raw.size()) {
        size_t n = std::min<size_t>(65535, raw.size() - pos);
        bool last = pos + n >= raw.size();
        z.push_back(last ? 0x01 : 0x00);  // BFINAL, BTYPE=00 (stored)
        z.push_back((uint8_t)(n & 0xFF));
        z.push_back((uint8_t)(n >> 8));
        uint16_t inv = (uint16_t)(~n & 0xFFFF);
        z.push_back((uint8_t)(inv & 0xFF));
        z.push_back((uint8_t)(inv >> 8));
        z.insert(z.end(), raw.begin() + pos, raw.begin() + pos + n);
        pos += n;
    }
    uint32_t ad = adler32_bytes(raw.data(), raw.size());
    put_u32(z, ad);

    std::vector<uint8_t> png;
    static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    png.insert(png.end(), sig, sig + 8);
    std::vector<uint8_t> ihdr;
    put_u32(ihdr, (uint32_t)img.width);
    put_u32(ihdr, (uint32_t)img.height);
    ihdr.push_back(8);  // bit depth
    ihdr.push_back(2);  // color type: truecolor
    ihdr.push_back(0);
    ihdr.push_back(0);
    ihdr.push_back(0);
    chunk(png, "IHDR", ihdr);
    chunk(png, "IDAT", z);
    chunk(png, "IEND", {});

    std::ofstream f(path, std::ios::binary);
    if (!f) {
        if (error) *error = "cannot open output file: " + path;
        return false;
    }
    f.write((const char*)png.data(), (std::streamsize)png.size());
    if (!f) {
        if (error) *error = "write failed: " + path;
        return false;
    }
    return true;
}

bool write_ppm(const std::string& path, const Image& img, std::string* error) {
    std::ofstream f(path, std::ios::binary);
    if (!f) {
        if (error) *error = "cannot open output file: " + path;
        return false;
    }
    f << "P6\n" << img.width << " " << img.height << "\n255\n";
    f.write((const char*)img.rgb.data(), (std::streamsize)img.rgb.size());
    return (bool)f;
}
