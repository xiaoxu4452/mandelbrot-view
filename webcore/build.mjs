#!/usr/bin/env node
// build.mjs — compile the DESKTOP core (C:\Users\harve\Desktop\mande\new\src)
// to wasm32-wasi, byte-for-byte the same algorithm, with three build-time
// adaptations that touch no desktop original:
//   1. source mirror: render-chain TUs are copied into src-mirror/ each build
//   2. mechanical patches (see PATCHES): the six `throw` sites in
//      BigFloat::from_string and the two try/catch blocks in render.cpp become
//      mbxx error-flag calls, because zig's wasm32-wasi libc++ has no unwinder
//   3. gmp_bridge.cpp is replaced by gmp_stub.cpp (backend pinned to BigFloat;
//      identical to the desktop build with the GMP DLL absent)
// The desktop originals are only ever read.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = 'C:/Users/harve/Desktop/mande/new/src';
const MIRROR = path.join(ROOT, 'src-mirror');
const OUT = path.join(ROOT, 'core.wasm');

const TUS = [
  'bigfloat.cpp', 'reference.cpp', 'deep.cpp', 'render.cpp', 'palette.cpp',
  'port/registry.cpp',
];
const HEADERS = [
  'bigfloat.hpp', 'floatexp.hpp', 'reference.hpp', 'deep.hpp', 'render.hpp',
  'palette.hpp', 'dive.hpp', 'exact.hpp', 'image.hpp', 'port/port.hpp',
  'gmp_bridge.hpp',
  /* The view layer.  Header-only, and the reason the web build needs it is the
   * whole point of this file: point_at / zoom_by / pan_pixels live in the core
   * on the desktop, and the page must not have a second implementation. */
  'viewport.hpp',
];

// ---- mechanical patches ----------------------------------------------------
// Every entry: [file, old, new, expected count]. Each replacement is asserted,
// so a desktop-side change can never silently drift into the web build.
const PATCHES = [
  /* ---- band renders share one reference orbit ---------------------------
   *
   * A frame split into horizontal bands is still ONE view, so every band has
   * to perturb against the same reference.  Panning each band's centre (which
   * is how the strip entry point works: the page never does coordinate
   * arithmetic) moved the reference with it, and the anchor is what decides
   * everything downstream: at c=i the frame centre gives the exact periodic
   * orbit (80001 steps, tiled), while a centre 200 rows away escapes after
   * 1616 steps, so the band's pixels run off the end of their reference and
   * the repair loop grinds re-rendering them.  Measured on a 1248x804 frame at
   * 10^600: one band 1289 ms, four bands 2678 ms -- parallel work that was
   * slower than serial.
   *
   * The override keeps the band's own c for anything that needs a plane
   * coordinate (`pixel_c` for probe and repair anchors) and only redirects the
   * reference: its c and where that c sits in this band's pixels.
   */
  ['render.hpp', `    bool interior_palette = false; // original iter<0 colouring for interior points`,
   `    bool interior_palette = false; // original iter<0 colouring for interior points

    /* Reference-anchor override (adapter mb_render_strip).  Empty/negative =
     * use the view centre, which is what a whole-frame render always does. */
    std::string ref_re, ref_im;
    int ref_rdx = -1, ref_rdy = -1;
    double ref_ax = 0.0, ref_ay = 0.0;

    /* Row offset for a band of a shallow (direct double) frame.  The direct path
     * has no reference orbit, so a band keeps the frame's own geometry and
     * shifts only the ROW it starts at: panning the centre would feed a centre
     * rounded to a double and move boundary pixels by up to 150 iterations
     * (measured: 76 of 1 M pixels differed from the whole frame).  geom_height
     * is the height that geometry was built for. */
    int row0 = 0;
    int geom_height = 0;`, 1],
  ['render.cpp', `    const double y = (double)req.height * 0.5 - py;`,
   `    const double gh = req.geom_height > 0 ? (double)req.geom_height : (double)req.height;
    const double y = gh * 0.5 - py;`, 1],
  ['render.cpp', `                    frame_offset(req, (double)x + 0.5, (double)y + 0.5, dx, dy);`,
   `                    frame_offset(req, (double)x + 0.5, (double)(y + req.row0) + 0.5, dx, dy);`, 1],

  ['render.cpp', `    BigFloat cr, ci;
    try {`,
   `    BigFloat cr, ci;
    /* Band anchor: parsed here, after plan_precision, for the same reason. */
    BigFloat refr, refi;
    const bool band_ref = req.ref_rdx >= 0 && !req.ref_re.empty();
    if (band_ref) {
        refr = BigFloat::from_string(req.ref_re);
        refi = BigFloat::from_string(req.ref_im);
    }
    try {`, 1],
  ['render.cpp', `        dp.cancel = req.cancel;`,
   `        dp.cancel = req.cancel;
        dp.geom_height = req.geom_height;
        if (band_ref) {
            dp.refr = &refr;
            dp.refi = &refi;
            dp.ref_rdx = req.ref_rdx;
            dp.ref_rdy = req.ref_rdy;
            dp.ref_ax = req.ref_ax;
            dp.ref_ay = req.ref_ay;
        }`, 1],
  ['deep.hpp', `    const std::atomic<bool>* cancel = nullptr;`,
   `    const std::atomic<bool>* cancel = nullptr;
    /* Frame height the geometry belongs to, when this is a band of a taller
     * frame.  The series-approximation radius test is measured over the frame's
     * diagonal, so a band that used its own height would take a shorter series
     * skip than the whole frame and its tone would drift at the seams. */
    int geom_height = 0;
    // Reference-anchor override (see RenderRequest::ref_re).
    const BigFloat* refr = nullptr;
    const BigFloat* refi = nullptr;
    int ref_rdx = 0, ref_rdy = 0;
    double ref_ax = 0.0, ref_ay = 0.0;`, 1],
  ['deep.cpp', `    if (sa_order > 8 && (long long)p.width * p.height < 400000) sa_order = 8;`,
   `    /* ...and it is decided by the FRAME's pixel count, not the band's: a band
     * of a 1 Mpx frame is 250 kpx, so taking the cheaper order there changed the
     * series (skip 1594 against 1597) and with it the tone of every band that
     * does not hold the anchor -- 82 368 of 1 M pixels differed by up to 0.34
     * iterations, which is a visible seam. */
    if (sa_order > 8 &&
        (long long)p.width * (p.geom_height > 0 ? p.geom_height : p.height) < 400000) {
        sa_order = 8;
    }`, 1],
  ['deep.cpp', `    const Fexp delta_max = p.scale * Fexp(std::sqrt((double)p.width * p.width +
                                                    (double)p.height * p.height) * 0.5 + 1.0);`,
   `    const int geom_h = p.geom_height > 0 ? p.geom_height : p.height;
    const Fexp delta_max = p.scale * Fexp(std::sqrt((double)p.width * p.width +
                                                    (double)geom_h * geom_h) * 0.5 + 1.0);`, 1],
  ['deep.cpp', `    int rdx = p.width / 2, rdy = p.height / 2;`,
   `    int rdx = p.refr ? p.ref_rdx : p.width / 2;
    int rdy = p.refr ? p.ref_rdy : p.height / 2;`, 1],
  ['deep.cpp', `    const bool center_ref = !v.p->julia &&
        rdx == v.p->width / 2 && rdy == v.p->height / 2 &&
        !(std::getenv("MB_CENTER_REF") && std::atoi(std::getenv("MB_CENTER_REF")) == 0);
    BigFloat re, im;
    if (center_ref) { re = *v.p->cr; im = *v.p->ci; }
    else v.pixel_c(rdx, rdy, re, im);`,
   `    /* A caller-supplied anchor wins: it is a c the caller knows exactly (the
     * frame centre of a band render) and it is the same orbit the whole frame
     * would use, so the bands stay comparable pixel for pixel. */
    const bool anchor_ref = v.p->refr && rdx == v.p->ref_rdx && rdy == v.p->ref_rdy;
    const bool center_ref = anchor_ref || (!v.p->julia &&
        rdx == v.p->width / 2 && rdy == v.p->height / 2 &&
        !(std::getenv("MB_CENTER_REF") && std::atoi(std::getenv("MB_CENTER_REF")) == 0));
    BigFloat re, im;
    if (anchor_ref) { re = *v.p->refr; im = *v.p->refi; }
    else if (center_ref) { re = *v.p->cr; im = *v.p->ci; }
    else v.pixel_c(rdx, rdy, re, im);`, 1],
  ['deep.cpp', `    ref.anchor_x = center_ref ? (double)v.p->width * 0.5 - 0.5 : (double)rdx;
    ref.anchor_y = center_ref ? (double)v.p->height * 0.5 - 0.5 : (double)rdy;`,
   `    ref.anchor_x = anchor_ref ? v.p->ref_ax
                 : center_ref ? (double)v.p->width * 0.5 - 0.5 : (double)rdx;
    ref.anchor_y = anchor_ref ? v.p->ref_ay
                 : center_ref ? (double)v.p->height * 0.5 - 0.5 : (double)rdy;`, 1],
  // wasi-libc has no pthreads; threads = 1 never spawns a worker, the type
  // just has to exist. See webcore/mb_thread.hpp.
  ['render.cpp', '#include <thread>', '#include "mb_thread.hpp"', 1],
  ['deep.cpp', '#include <thread>', '#include "mb_thread.hpp"', 1],
  ['bigfloat.cpp', 'throw std::invalid_argument(', 'MB_BF_FAIL(', 7],
  // Periodic-reference probe on the BigFloat backend (mirror of orbit_gmp's
  // exact-repetition detection + tiling, which the desktop implements only on
  // the GMP path). Without it a periodic centre such as c=i drifts off its
  // true cycle after ~2000 BigFloat squarings and every pixel goes wrong.
  // Numerically equivalent: tiling starts only on exact value equality.
  ['reference.cpp',
`    BigFloat zr = z0r, zi = z0i;
    orbit.c = cfexp_from_bigfloat(cr, ci);

    SaTracker sa;
    sa.begin(sa_order, julia, delta_max);

    for (int n = 0;; ++n) {
        orbit.z.push_back(cfexp_from_bigfloat(zr, zi));`,
`    BigFloat zr = z0r, zi = z0i;
    orbit.c = cfexp_from_bigfloat(cr, ci);

    SaTracker sa;
    sa.begin(sa_order, julia, delta_max);

    /* Same exact-repetition probe orbit_gmp runs on the GMP backend, now for
     * BigFloat: detect an exact repetition inside the first kProbe steps with
     * the BigFloat value comparison, then tile the stored CFexp values. The
     * pixels still iterate every step; only Z_n is frozen analytically. */
    const bool probe_period_bf = !need_derivative && !julia &&
                                 !(std::getenv("MB_PERIOD") &&
                                   std::atoi(std::getenv("MB_PERIOD")) == 0);
    constexpr int kProbeBf = 64;
    std::vector<BigFloat> snap_r_bf, snap_i_bf;
    if (probe_period_bf) {
        snap_r_bf.reserve(kProbeBf);
        snap_i_bf.reserve(kProbeBf);
    }
    int per_start_bf = -1, per_len_bf = 0;

    for (int n = 0;; ++n) {
        orbit.z.push_back(cfexp_from_bigfloat(zr, zi));`, 1],
  ['reference.cpp',
`        orbit.z.push_back(cfexp_from_bigfloat(zr, zi));

        if (need_derivative) {`,
`        orbit.z.push_back(cfexp_from_bigfloat(zr, zi));

        if (probe_period_bf && per_start_bf < 0 && n <= kProbeBf) {
            for (int j = 0; j < (int)snap_r_bf.size(); ++j) {
                if (zr == snap_r_bf[(size_t)j] && zi == snap_i_bf[(size_t)j]) {
                    per_start_bf = j;
                    per_len_bf = n - j;
                    break;
                }
            }
            if (per_start_bf < 0 && n < kProbeBf) {
                snap_r_bf.push_back(zr);
                snap_i_bf.push_back(zi);
            }
        }
        if (per_start_bf >= 0) {
            /* orbit.z holds Z_0..Z_n. Fill the rest by repetition and keep the
             * in-loop SA integration aligned, exactly as orbit_gmp does. */
            for (int k = n; k < maxiter; ++k) {
                orbit.z.push_back(
                    orbit.z[(size_t)(per_start_bf + (k + 1 - per_start_bf) % per_len_bf)]);
                sa.step(orbit.z[(size_t)k], k, maxiter);
            }
            orbit.escaped = false;
            orbit.escape_iter = -1;
            orbit.periodic = true;
            break;
        }

        if (need_derivative) {`, 1],
  ['render.cpp',
`    try {
        cr = BigFloat::from_string(req.center_re);
        ci = BigFloat::from_string(req.center_im);
    } catch (const std::exception& e) {
        if (error) *error = std::string("invalid centre coordinate: ") + e.what();
        return false;
    }`,
`    cr = BigFloat::from_string(req.center_re);
    ci = BigFloat::from_string(req.center_im);
    if (::mbxx::take_error()) {
        if (error) *error = "invalid centre coordinate";
        return false;
    }`, 1],
  ['render.cpp',
`        try {
            jr = BigFloat::from_string(req.julia_re);
            ji = BigFloat::from_string(req.julia_im);
        } catch (const std::exception& e) {
            if (error) *error = std::string("invalid Julia parameter: ") + e.what();
            return false;
        }`,
`        jr = BigFloat::from_string(req.julia_re);
        ji = BigFloat::from_string(req.julia_im);
        if (::mbxx::take_error()) {
            if (error) *error = "invalid Julia parameter";
            return false;
        }`, 1],
];

function applyPatches(rel, text) {
  for (const [file, oldS, newS, count] of PATCHES) {
    if (file !== rel) continue;
    const n = text.split(oldS).length - 1;
    if (n !== count) throw new Error(`patch in ${file}: found ${n}, expected ${count}`);
    text = text.split(oldS).join(newS);
    console.log(`[patch] ${file}: ${n} site(s)`);
  }
  return text;
}

// ---- mirror ----------------------------------------------------------------
fs.rmSync(MIRROR, { recursive: true, force: true });
fs.mkdirSync(path.join(MIRROR, 'port'), { recursive: true });
for (const f of [...TUS, ...HEADERS]) {
  const dst = path.join(MIRROR, f);
  let text = fs.readFileSync(path.join(DESKTOP_SRC, f), 'utf8').replace(/\r\n/g, '\n');
  /* Headers are patched as well: the band-anchor plumbing lives in
   * render.hpp/deep.hpp, and a patch array that silently skipped them would
   * compile a core whose fields nobody fills. */
  text = applyPatches(f, text);
  if (f === 'bigfloat.cpp') {
    text = text.replace('#include "bigfloat.hpp"',
      '#include "bigfloat.hpp"\n#include "mb_noexcept.hpp"');
  }
  if (f === 'render.cpp') {
    text = text.replace('#include "render.hpp"',
      '#include "render.hpp"\n#include "mb_noexcept.hpp"');
  }
  fs.writeFileSync(dst, text);
}
fs.copyFileSync(path.join(ROOT, 'mb_noexcept.hpp'), path.join(MIRROR, 'mb_noexcept.hpp'));
fs.copyFileSync(path.join(ROOT, 'mb_thread.hpp'), path.join(MIRROR, 'mb_thread.hpp'));
console.log(`[mirror] ${TUS.length + HEADERS.length} files from desktop originals`);

// ---- compile ----------------------------------------------------------------
const flags = [
  '-target', 'wasm32-wasi', '-std=c++20', process.env.MB_OPT || '-O2', '-fno-exceptions',
  ...(process.env.MB_SIMD ? ['-msimd128'] : []),
  '-I', MIRROR,
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,-z,stack-size=8388608',
];
const sources = [
  ...TUS.map(f => path.join(MIRROR, f)),
  path.join(ROOT, 'adapter.cpp'),
  path.join(ROOT, 'gmp_stub.cpp'),
  path.join(ROOT, 'mb_noexcept.cpp'),
];
console.log('[zig] compiling', sources.length, 'translation units...');
const t0 = Date.now();
execFileSync('zig', ['c++', ...flags, ...sources, '-o', OUT], { stdio: 'inherit' });
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`[done] core.wasm ${kb} KiB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
