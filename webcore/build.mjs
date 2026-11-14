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
];

// ---- mechanical patches ----------------------------------------------------
// Every entry: [file, old, new, expected count]. Each replacement is asserted,
// so a desktop-side change can never silently drift into the web build.
const PATCHES = [
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
  if (f.endsWith('.cpp')) text = applyPatches(f, text);
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
  '-target', 'wasm32-wasi', '-std=c++20', '-O2', '-fno-exceptions',
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
