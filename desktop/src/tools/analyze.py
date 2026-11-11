"""Summarise a screenshot numerically.

The image tools in this session cannot take pictures, so the verification loop
reads pixels instead: this prints the colour histogram, the fraction of
non-background pixels, and a coarse 8x8 grid of mean colours so the layout is
still legible as text.

    python tools/analyze.py shot.png
"""
import struct
import sys
import zlib


def load_png(path):
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    i = 8
    idat = b""
    w = h = bd = ct = 0
    while i < len(d):
        ln = struct.unpack(">I", d[i:i + 4])[0]
        tag = d[i + 4:i + 8]
        body = d[i + 8:i + 8 + ln]
        if tag == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", body[:10])
        elif tag == b"IDAT":
            idat += body
        i += 12 + ln
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    stride = w * ch + 1
    # Undo the per-row filters (only 0..4 appear in practice).
    out = bytearray(w * h * ch)
    prev = bytearray(w * ch)
    for y in range(h):
        base = y * stride
        f = raw[base]
        line = bytearray(raw[base + 1:base + 1 + w * ch])
        if f == 1:
            for x in range(ch, w * ch):
                line[x] = (line[x] + line[x - ch]) & 0xFF
        elif f == 2:
            for x in range(w * ch):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif f == 3:
            for x in range(w * ch):
                a = line[x - ch] if x >= ch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif f == 4:
            for x in range(w * ch):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        out[y * w * ch:(y + 1) * w * ch] = line
        prev = line
    return w, h, ch, out


def main(path):
    w, h, ch, px = load_png(path)

    def at(x, y):
        o = (y * w + x) * ch
        return px[o], px[o + 1], px[o + 2]

    # Coarse grid of mean colours: enough to see layout without the picture.
    G = 8
    print(f"image {w}x{h} ch={ch}")
    print("grid (mean rgb per cell):")
    for gy in range(G):
        cells = []
        for gx in range(G):
            x0, x1 = gx * w // G, (gx + 1) * w // G
            y0, y1 = gy * h // G, (gy + 1) * h // G
            r = g = b = n = 0
            for y in range(y0, y1, max(1, (y1 - y0) // 12)):
                for x in range(x0, x1, max(1, (x1 - x0) // 12)):
                    c = at(x, y)
                    r += c[0]; g += c[1]; b += c[2]; n += 1
            cells.append("%02x%02x%02x" % (r // n, g // n, b // n))
        print("  " + " ".join(cells))

    # Saturation histogram: a fractal has many hue clusters, a blank window one.
    hist = {}
    dark = 0
    total = 0
    vivid = 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            r, g, b = at(x, y)
            total += 1
            if r < 24 and g < 24 and b < 24:
                dark += 1
            mx, mn = max(r, g, b), min(r, g, b)
            if mx - mn > 40:
                vivid += 1
            key = (r >> 5, g >> 5, b >> 5)
            hist[key] = hist.get(key, 0) + 1
    top = sorted(hist.items(), key=lambda kv: -kv[1])[:6]
    print(f"dark={dark * 100 // total}% vivid={vivid * 100 // total}% "
          f"distinct5bit={len(hist)}")
    print("top buckets:", ", ".join(
        f"({k[0] << 5},{k[1] << 5},{k[2] << 5})={v * 100 // total}%" for k, v in top))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "shot.png")
