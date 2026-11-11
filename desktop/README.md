# Desktop build — the render core

The web app in the repository root runs entirely in the browser: the main view
iterates every pixel in a fragment shader, and a WebAssembly kernel covers the
views a shader cannot express. The desktop build is the same program with the
kernel moved into C++ on this machine:

* `mb_mpf.cpp` / `mb_hf.cpp` — GMP / double-double reference orbits, so depth is
  limited by memory rather than by a 64-bit exponent;
* `mb_orbit.cpp` — reference-point election, series approximation, glitch repair;
* `mb_kernels.cpp` — the per-pixel kernels (direct, perturbed, vectorised);
* `mb_engine.cpp` — the tile scheduler, the thread pool and the iteration budget
  that adapts to what the frame has actually observed;
* `shell/` — the Win32 + WebView2 host that owns the window and the render thread.

## Building

Requirements: Windows, MSVC (Visual Studio 2019+ build tools), and the WebView2
SDK. The SDK is **not** vendored here — download the "WebView2 SDK" NuGet
package and unpack it so the include/lib paths match `env-msvc.bat`, or point
`WEBVIEW2_DIR` at it.

```
src\env-msvc.bat          :: sets INCLUDE/LIB without touching the registry
src\build.bat             :: /O2 /GL /AVX2 /MT + LTCG -> Mandelbrot View.exe
src\build-bench.bat       :: the benchmark harness (tools/mb_bench.cpp)
```

`build-alt.bat` is the fallback path (no LTCG) used when link-time code
generation is not available on the machine.

## Threads

`Engine(int threads)` defaults to `hardware_concurrency() - 1`: one core is left
for the WebView2 renderer, the page's compositor and whatever else the user is
running. The pool owns `threads - 1` workers and the calling thread does its
share of the tiles. `MB_THREADS` overrides the count for measurement.

## Relationship to the web build

The two share the colour pipeline and the mathematics, not the code: the web
kernel is `wasm/kernel.cpp` compiled to WebAssembly, the desktop kernel is this
C++ tree. Anything changed in one should be checked against the other with the
regression harnesses in `tools/` (tiling independence, seam detection, pinch).
