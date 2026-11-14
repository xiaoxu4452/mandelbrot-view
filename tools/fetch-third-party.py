#!/usr/bin/env python
"""Rebuild the vendored SDK trees under Meter Mandelbrot/src/third_party.

The desktop build reads these headers/libraries directly; git only tracks the
small pieces (Khronos headers, musl sources, generated .lib files).  Run this
once on a fresh checkout.  All sources are official upstream releases.

    python tools/fetch-third-party.py
"""
import json, pathlib, urllib.request, zipfile, io, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / 'Meter Mandelbrot' / 'src' / 'third_party'
MIRROR = ROOT / 'desktop' / 'src' / 'third_party'
CACHE = ROOT / '.sdk-cache'
CACHE.mkdir(exist_ok=True)

SOURCES = {
 'khronos-opencl-headers': 'https://codeload.github.com/KhronosGroup/OpenCL-Headers/zip/refs/heads/main',
 'khronos-opengl-registry': 'https://codeload.github.com/KhronosGroup/OpenGL-Registry/zip/refs/heads/main',
 'khronos-icd-loader': 'https://codeload.github.com/KhronosGroup/OpenCL-ICD-Loader/zip/refs/heads/main',
 'musl': 'https://codeload.github.com/ifduyue/musl/zip/refs/heads/master',
 'lcms2': 'https://codeload.github.com/mm2/Little-CMS/zip/refs/heads/master',
 'mpir': 'https://codeload.github.com/wbhart/mpir/zip/refs/heads/master',
 'mpfr': 'https://codeload.github.com/BrianGladman/mpfr/zip/refs/heads/master',
 'boost': 'https://archives.boost.org/release/1.87.0/source/boost_1_87_0.zip',
}

def get(name, url):
    f = CACHE / (name + '.zip')
    if not f.exists() or f.stat().st_size < 10000:
        print('download', name, '...')
        req = urllib.request.Request(url, headers={'User-Agent': 'mandelbrot-view'})
        f.write_bytes(urllib.request.urlopen(req, timeout=600).read())
    else:
        print('cached  ', name, f.stat().st_size // 1048576, 'MB')
    return zipfile.ZipFile(f)

def extract(z, prefix, out, suffixes, flatten=None):
    n = 0
    for info in z.infolist():
        if not info.filename.startswith(prefix): continue
        rel = info.filename[len(prefix):]
        if not rel or not rel.endswith(suffixes): continue
        if flatten: rel = rel.split('/', flatten)[-1]
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(z.read(info)); n += 1
    return n

def main():
    z = {k: get(k, u) for k, u in SOURCES.items()}
    jobs = [
      ('khronos-opencl-headers', 'OpenCL-Headers-main/CL/', DEST/'khronos'/'CL', ('.h',), 0),
      ('khronos-opengl-registry', 'OpenGL-Registry-main/api/GL/', DEST/'khronos'/'GL', ('.h',), 0),
      ('khronos-opengl-registry', 'OpenGL-Registry-main/xml/', DEST/'khronos'/'xml', ('.xml',), 0),
      ('khronos-icd-loader', 'OpenCL-ICD-Loader-main/loader/', DEST/'khronos'/'icd-loader', ('.c','.h','.def'), 0),
      ('musl', 'musl-master/src/math/', DEST/'musl'/'src'/'math', ('.c','.h'), 0),
      ('musl', 'musl-master/src/internal/', DEST/'musl'/'src'/'internal', ('libm.h','fp_arch.h','atomic.h'), 0),
      ('musl', 'musl-master/arch/generic/', DEST/'musl'/'arch'/'generic', ('.h',), 0),
      ('musl', 'musl-master/arch/x86_64/', DEST/'musl'/'arch'/'x86_64', ('atomic_arch.h',), 0),
      ('lcms2', 'Little-CMS-master/src/', DEST/'lcms2'/'src', ('.c','.h'), 0),
      ('lcms2', 'Little-CMS-master/include/', DEST/'lcms2'/'include', ('.h',), 0),
      ('boost', 'boost_1_87_0/boost/', DEST/'boost', ('.h','.hpp','.ipp'), 0),
      ('mpir', 'mpir-master/', DEST/'mpir', ('.c','.h'), 0),
      ('mpfr', 'mpfr-master/', DEST/'mpfr', ('.c','.h'), 0),
    ]
    for name, prefix, out, suff, flat in jobs:
        print(name, prefix, '->', extract(z[name], prefix, out, suff, flat), 'files')
    # khrplatform.h comes from EGL-Registry (small single file)
    url = 'https://api.github.com/repos/KhronosGroup/EGL-Registry/contents/api/KHR/khrplatform.h?ref=main'
    import base64
    d = json.load(urllib.request.urlopen(urllib.request.Request(
        url, headers={'User-Agent':'mandelbrot-view'}), timeout=60))
    for t in (DEST/'khronos'/'KHR', MIRROR/'khronos'/'KHR'):
        t.mkdir(parents=True, exist_ok=True)
        (t/'khrplatform.h').write_bytes(base64.b64decode(d['content']))
    print('khrplatform.h ok')
    print('Next: build-opencl-lib.bat, build-musl-libm.bat, build-lcms2-msvc.bat,')
    print('      build-caps.bat, build-libcheck.bat, build-hpcheck.bat')

if __name__ == '__main__':
    main()
