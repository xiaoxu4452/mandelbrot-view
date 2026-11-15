/* Build the independent formula core.
 *
 * Same toolchain as webcore/build.mjs (zig c++ -> wasm32-wasi, no exceptions,
 * exported memory, 8 MiB stack), but this module has NO dependency on the
 * desktop source tree: it is a separate core with its own ABI.
 *
 *   node formulacore/build.mjs
 *   MB_OPT=-O3 node formulacore/build.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'formulacore.wasm');
const SRC = path.join(ROOT, 'core.cpp');

const flags = [
  '-target', 'wasm32-wasi',
  '-std=c++20',
  process.env.MB_OPT || '-O2',
  '-fno-exceptions',
  '-I', ROOT,
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,-z,stack-size=8388608',
];

console.log('[formulacore] compiling core.cpp ...');
const t0 = Date.now();
execFileSync('zig', ['c++', ...flags, SRC, '-o', OUT], { stdio: 'inherit' });
console.log(`[formulacore] ${(fs.statSync(OUT).size / 1024).toFixed(0)} KiB in ` +
            `${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}`);
