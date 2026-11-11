# MANDELBROT · Precision Fractal Observatory

An interactive, high-precision fractal renderer. It runs entirely in the browser, and it can also
hand rendering to a native thread pool on your own machine. The visual language follows Fluent /
scientific tooling: translucent glass, restrained hierarchy, no decorative gradients.

**Live demo**: <https://xiaoxu4452.github.io/mandelbrot-view/>
**中文说明**: [README.md](README.md)

---

## Quick start

### 1. Open the hosted build (nothing to install)

Use the demo link above. The WebAssembly kernel is compiled on first load; every calculation then
runs locally.

### 2. Desktop app (recommended, no setup)

In the app: **Settings → Desktop app & render core → Download desktop app** serves the
Windows build (`download/Mandelbrot-View.exe`) with the same C++ multi-threaded kernel,
GPU shading and preset library built in — no unpacking and no Node.js required.
Advanced users can still fetch `mandelbrot-core.zip` from the same panel; unpack it and run:

- **Windows** — double-click `start-core.bat`
- **macOS / Linux** — `bash start-core.sh`

The launcher starts two loopback-only services and opens the page:

| Service | Address | Purpose |
| --- | --- | --- |
| Render core | `http://127.0.0.1:8778` | Node worker-thread pool hosting the C++/WASM kernel, returns raw RGBA |
| Static page | `http://127.0.0.1:8777` | Serves the bundle over HTTP (required by ES modules) |

### 3. From source

```bash
git clone https://github.com/xiaoxu4452/mandelbrot-view.git
cd mandelbrot-view
node server/render-server.mjs   # optional: local render core on 127.0.0.1:8778
node server/static-server.mjs   # page on 127.0.0.1:8777
```

> **The page must be served over HTTP.** Opening `index.html` with `file://` makes the browser block
> ES modules and Web Workers, so nothing can start. The boot screen ships a diagnostic guard that
> tells you exactly which command to run instead of hanging at 0%.

---

## Interface

- **Top bar** — fractal family, 512 presets, formula editor, custom presets, numeric precision,
  **console toggle**, settings.
- **Console** — draggable and collapsible. Press the “—” button or `P` to fold it into the top-bar
  toggle; press again to bring it back exactly where it was.
- **Mobile** — narrow screens switch to a bottom sheet (with grab handle); the top bar compacts into
  icons plus a horizontally scrollable nav. One finger pans, two fingers pinch-zoom, tapping the
  canvas dismisses the sheet.
- **HUD** — bottom-left readout of zoom factor, centre coordinates, engine path (`CORE` / `WASM` /
  `HP`), bit width, reference-orbit length and frame time.

| Action | Desktop | Mobile |
| --- | --- | --- |
| Zoom | wheel (anchored at the cursor) | pinch |
| Pan | drag | one-finger drag |
| Zoom in / out | double-click / Shift + double-click | double-tap |
| Reset view | `R` | console “Reset” |
| Console | `P` | top-bar toggle |
| Fullscreen | `F` | — |
| Export PNG | `S` | console “Export PNG” |
| Iterations | `+` / `-` | console slider |

---

## Rendering pipeline

```
main thread                   workers × N                    local core (optional)
───────────                   ───────────                    ─────────────────────
view state (decimal strings)
scale = mantissa × 2^exp  ──► ① WASM pixel kernel  ──HTTP──► Node worker_threads
progressive tiling             · direct / perturb / newton   (identical kernel)
(0.13 → 0.38 → 0.68 → 1.0)     · f64x2 SIMD, two pixels
                              ② BigInt high-precision layer
                               · reference orbit + series approximation
```

1. **Coordinates** — the centre is stored as decimal strings; the pixel scale is split into
   `mantissa × 2^exp` so double precision never underflows below `1e-300`.
2. **Automatic precision** — 64 / 128 / 256 / 512 / 1024 / 2048 / 4096-bit fixed point, chosen from
   `log₂(pixel scale)`.
3. **Perturbation** — a reference orbit is iterated once in high precision; every pixel then only
   recurses the double-precision delta `δ`. The reference is elected by lifetime inside the viewport,
   preferring an interior point that never escapes.
4. **Series approximation** — the first `s` steps of `δ` come straight from the A/B/C coefficients,
   skipping hundreds of iterations. The valid radius is derived from the pixel scale; once exceeded,
   the pixel falls back to step-by-step iteration.
5. **Glitch repair** — the kernel writes the coordinates of pixels whose recursion lost precision
   back into memory, and the host re-runs *only those pixels* against secondary reference orbits.
   No tile-wide re-render is needed, so the WASM speed advantage survives.
6. **Progressive refinement** — four passes per frame (0.13 → 1.0) always computed with the final
   iteration count, so a low-resolution preview can never collapse into flat colour blocks.

---

## High-precision evaluator (`js/hpeval.js`)

At depth, custom formulas need coordinates far beyond double precision. The evaluator compiles the
expression into a closure tree and evaluates it on `BigInt` fixed-point numbers
(fraction bits = width + 26 guard bits):

| Capability | Implementation |
| --- | --- |
| `+ - * / ^` | fixed-point arithmetic; integer powers by square-and-multiply; general powers via `exp(b·log a)` |
| `sin cos tan sinh cosh tanh` | argument reduction + Taylor series; complex values via the standard identities |
| `exp log sqrt` | `k·ln2` reduction, atanh series, Newton iteration |
| `arg atan atan2` | fixed-point atan (two half-angle reductions + Taylor), so `log` phase is high precision too |
| `abs conj re im`, `Σ Π`, piecewise | implemented term by term |

Verification (`tools/hpverify.mjs`, `tools/hpconverge.mjs`):

- every elementary function agrees with double to better than `1e-12`;
- iterating `z²+c` 2000 times, the 512-bit and 256-bit results agree **bit-for-bit to 85 decimal
  digits (≈282 bit)**, and 512-bit vs 128-bit to 47 digits — the precision really scales with width.

Throughput: `z²+c` ≈ 130k iterations/s (128–256 bit); `sin(z)+c` ≈ 25k iterations/s (128 bit).

## Deep perturbation for arbitrary formulas (`js/jet.js`)

`z²+c` needs only a second-order term, but `z³+c` is wrong without `ε³`. The renderer therefore
computes the truncated power series of `F(Z+ε, c+δ)` in `ε`:

```
F  = p₀ + p₁ε + … + p_K ε^K + (q₀ + q₁ε + …) δ
ε' = (p₁ + p₂ε + …) ε + (q₀ + q₁ε + …) δ
```

Coefficients come from power-series automatic differentiation along the reference orbit (not finite
differences); the order follows the polynomial degree. Polynomial formulas (`z^p`, compositions,
`Σ`) are **exact** at any depth; `sin/exp/log` stay accurate at shallow and medium depth and are
flagged as approximate in the HUD when pushed to the limit.

---

## Expression library (`js/mathlib.js`)

A self-contained complex expression front end that follows Desmos input conventions:

- Pratt parser with implicit multiplication (`2z`, `3(z+1)`, `az`);
- common-subexpression elimination and code generation for the whole iteration step;
- `Σ`, `Π`, piecewise, user functions `f(x)=…`, comparisons and booleans;
- any free single letter becomes a parameter slider (`z`, `c`, `n`, `z_1` are reserved);
- the same AST also serialises to LaTeX for the formula panel.

## Presets

512 presets = 64 observation anchors × 8 palettes. Anchors are selected by boundary scanning plus a
composition score (`tools/gen-presets.mjs`) and refined by `tools/searchviews.mjs`, covering
Mandelbrot, Julia, Newton and several exotic families.

---

## Layout

```
index.html            markup + boot guard (file:// diagnostics)
css/app.css           Fluent glass styling, dark/light themes, mobile breakpoints
js/app.js             view state, progressive tiling, interaction, dialogs
js/worker.js          render thread: WASM dispatch, orbit/series cache, glitch repair
js/render.js          CPU tile renderer (perturbation / high precision / Newton / custom)
js/corepanel.js       “Render core” panel (download, status probe)
js/remote.js          local core client (127.0.0.1:8778)
js/formulas.js        fractal families and high-precision reference orbits
js/bigfixed.js        arbitrary-precision fixed point (BigInt)
js/environment.js     series approximation (A/B/C coefficients, skip count)
js/customenv.js       high-precision environment for custom formulas
js/hpeval.js          high-precision evaluator
js/jet.js             power-series (jet) automatic differentiation
js/mathlib.js         complex expression library (parser / codegen / LaTeX)
js/palettes.js        palette LUTs
js/presets-data.js    the 512 presets (generated)
wasm/kernel.cpp       WASM kernel source (C++ / SIMD)
wasm/kernel.ts        AssemblyScript reference implementation
js/kernel-wasm.js     inlined base64 kernel (generated)
server/               local render core and static server
core/                 downloadable core bundle (built by tools/build-core-package.mjs)
tools/                build and verification scripts
```

## Rebuilding

```bash
node tools/build-kernel.mjs          # C++ → wasm → js/kernel-wasm.js (requires zig)
node tools/build-core-package.mjs    # package core/mandelbrot-core.zip
node tools/gen-presets.mjs           # regenerate the 512 presets
```

## License

[MIT](LICENSE). Palette and preset organisation inspired by the Retinamandelbrot / Retinajulia
example sets.
