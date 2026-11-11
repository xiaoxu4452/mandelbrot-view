"""Grab the primary screen into a PNG. Windows only, no external deps.

Used by the build/verify loop: launch the app, wait, shoot, look.  Keeping it
here (rather than in a PowerShell one-liner) avoids loading .NET assemblies
into a sandboxed shell, and gives a predictable file name.
"""
import ctypes
import ctypes.wintypes as wt
import struct
import sys
import zlib

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def shoot(path, only_window_name=None):
    x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    w = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    h = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    if only_window_name:
        hwnd = user32.FindWindowW(None, only_window_name)
        if hwnd:
            r = wt.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(r))
            pt = wt.POINT(0, 0)
            user32.ClientToScreen(hwnd, ctypes.byref(pt))
            x, y, w, h = pt.x, pt.y, r.right, r.bottom
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    gdi32.BitBlt(mem, 0, 0, w, h, hdc, x, y, SRCCOPY)

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h            # top-down
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)

    raw = buf.raw
    rows = []
    for j in range(h):
        line = raw[j * w * 4:(j + 1) * w * 4]
        row = bytearray(w * 3)
        for i in range(w):
            s = i * 4
            d = i * 3
            row[d] = line[s + 2]       # R  (DIB is BGRA)
            row[d + 1] = line[s + 1]   # G
            row[d + 2] = line[s]       # B
        rows.append(b"\x00" + bytes(row))
    payload = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(payload, 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    print("shot", path, w, "x", h)


if __name__ == "__main__":
    shoot(sys.argv[1] if len(sys.argv) > 1 else "shot.png")
