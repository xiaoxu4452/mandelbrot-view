# The C++ core, in this repository

This directory is a **complete copy of the desktop engine's `src/` tree** — the
same files that build `mset.exe`, the desktop application and (through
`webcore/build.mjs`) `core.wasm` in this repository.

It exists so that a fresh clone can rebuild every binary without needing the
author's desktop checkout. It contains:

| path | what it is |
| --- | --- |
| `bigfloat.*`, `floatexp.hpp`, `exact.hpp` | the arbitrary-precision base (base-10⁹ limbs) and the binary float-exp |
| `reference.*`, `deep.*`, `render.*`, `viewport.hpp` | reference orbit, perturbation, glitch repair, series approximation, view math |
| `palette.*`, `image.*` | colour pipeline and PNG/PPM output |
| `dive.*`, `hierarchy.hpp`, `workspace.*`, `algorithms.hpp` | Newton diving, periodicity, workspace/planning helpers |
| `gmp_bridge.*`, `port/` | runtime GMP loading and the platform abstraction layer |
| `mathx/` | the applied-mathematics library: arbitrary-precision elementary functions, the formula lexer/parser/VM, the complex layer and the deep family engine |
| `app/`, `main.cpp` | CLI/application front ends and the built-in UI model |

The **`formulacore/core.cpp`** and **`wasm/kernel.cpp`** trees at the repository
root are separate, self-contained formula kernels used by the page's formula
panel; they are not compiled from this directory.

## Rebuilding `core.wasm`

```bash
node webcore/build.mjs
```

`webcore/build.mjs` prefers this directory, then `webcore/src/` (a vendored
copy with the web-specific mechanical patches applied). To build explicitly
from this tree:

```bash
MB_SRC=core node webcore/build.mjs
node webcore/test.mjs          # pixel-for-pixel comparison against the desktop PNGs
```

The build requires `zig` (zig c++ targeting `wasm32-wasi`). No other toolchain
or system library is needed: GMP is loaded at runtime on the desktop and is
stubbed out for WebAssembly with the identical built-in BigFloat backend.

## Keeping the sources in sync

`src/mathx/*` is shared with the desktop repository
[xiaoxu4452/Meter-Mandelbrot-Desktop](https://github.com/xiaoxu4452/Meter-Mandelbrot-Desktop).
When a core file changes, copy it here and re-run `node webcore/build.mjs` plus
`node webcore/test.mjs` before publishing. The deep-Julia escape continuation
(`ref.julia && ref.escaped`) is present in `deep.cpp` in both repositories.
