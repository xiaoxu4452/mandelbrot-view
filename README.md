# Mandelbrot View — the desktop core, in your browser

An interactive Mandelbrot / Julia explorer whose renderer is **the desktop
C++ core compiled to WebAssembly** — the very same translation units that
power [Meter-Mandelbrot-Desktop](https://github.com/xiaoxu4452/Meter-Mandelbrot-Desktop)
(perturbation engine, series approximation, periodic reference orbits,
self-contained BigFloat backend). There is no second algorithm: what you see
here is what the desktop renders, pixel for pixel.

**Open**: <https://xiaoxu4452.github.io/mandelbrot-view/>
**中文说明**: [README.zh.md](README.zh.md)

---

## Architecture

```
browser                     shell-worker.js          core.wasm (C++ → wasm32-wasi)
 ┌────────────┐  postMessage  ┌──────────────┐  mb_render()  ┌──────────────────┐
 │ shell.js   │ ────────────▶ │ string ABI   │ ────────────▶ │ desktop core:    │
 │ canvas,    │ ◀──────────── │ RGB → ImageData│ ◀──────────── │ deep / reference │
 │ gestures   │   ImageData   │              │    RGB        │ / render / bigfloat│
 └────────────┘               └──────────────┘               └──────────────────┘
```

* **One engine, one worker.** Gestures (wheel / pan / pinch) repaint a
  reduced full frame through the same core; the committed frame is always a
  single full-resolution render. No shader iteration, no WebGPU, no
  progressive tile mixing.
* **The centre is a decimal string at full depth.** Every gesture applies a
  small double delta with BigInt decimal arithmetic, so a 1e-600 pan on a
  63-digit centre never loses a digit. Coordinates go into the core as
  strings, exactly as on the desktop CLI.
* **Precision** is planned by the core itself: `digits = log10(zoom) + 50`,
  64-limb aligned — identical to the desktop rule.
* **Wheels** follow the desktop shell model: one notch ≈ 1.522×, snapshot
  feedback under the cursor, 360 ms debounce, no glide.

## The core build (`webcore/`)

`webcore/build.mjs` copies the render-chain translation units from the
desktop source tree (`C:\Users\harve\Desktop\mande\new\src`), applies three
documented, mechanical build-time adaptations, and compiles with zig:

1. `throw std::invalid_argument` (7 sites, input parsing only) → error flag,
   because zig's wasm32-wasi libc++ ships without the unwinder.
2. `<thread>` → single-threaded shim; the shell always renders with
   `threads = 1`, so no worker is ever spawned.
3. `gmp_bridge.cpp` → `gmp_stub.cpp`: the runtime backend selector is pinned
   to the self-contained BigFloat backend — numerically identical to the
   desktop build when the GMP DLL is absent, which is exactly the backend the
   B2 oracle tests were validated against. A periodic-reference probe
   (exact-repetition detection + tiling, mirroring `orbit_gmp`) is added to
   the BigFloat path so periodic centres stay exact at any depth.

No desktop original is ever modified; every patch is asserted in
`webcore/build.mjs`, so upstream changes cannot drift silently into the
web build.

```bash
# rebuild core.wasm (requires zig 0.16+)
npm run build:core

# render and compare pixel-by-pixel against the desktop mset.exe
# (views: home, 1e15.2, 1e38, c=i @ 1e600, Julia)
npm run test:core

# browser smoke test (Playwright, desktop + mobile touch)
npm run page &      # local static server on :8777
npm run smoke
```

Current acceptance: **100.000 % pixel-identical (maxDelta = 0)** against the
desktop golden renderer on all five reference views.

## Files

| path | role |
| --- | --- |
| `index.html`, `shell.css`, `shell.js` | the shell: canvas, gestures, HUD, panel |
| `shell-worker.js` | WASM host: string ABI, RGB → ImageData |
| `core.wasm` | the compiled desktop core (served to the browser) |
| `webcore/` | build + pixel-comparison test for the core |
| `server/static-server.mjs` | local dev server |
| `tools/` | publish, history rebuild, browser smoke, PNG reader |

## Sharing a view

Menu → **复制视点链接** copies a link containing the full-precision centre,
window width, iteration count and palette. Links from the previous web
engine (`#st=…` with `v:1`-style payloads) are still decoded.
