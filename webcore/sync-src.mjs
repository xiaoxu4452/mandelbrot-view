/* sync-src.mjs — vendor the desktop core sources into this repository.
 *
 * The web build compiles the desktop core (`mande/new/src` on the author's
 * machine).  That tree is not part of this repository — it is the desktop
 * project — so a clone of this repo could not rebuild `core.wasm` at all.
 * This script copies exactly the translation units and headers the wasm build
 * needs into `webcore/src/`, so the repository is self-contained: the C ABI
 * (`adapter.cpp`), the stubs, the mirror patches and now the algorithms
 * themselves all live here.
 *
 *   node webcore/sync-src.mjs [path-to-desktop-src]
 *
 * The copy is byte-for-byte except for line endings (the build normalizes to
 * LF as well); nothing is patched here — `build.mjs` applies its asserted
 * patches to whatever source it reads, so the vendored files stay identical to
 * the originals and a diff against the desktop tree is meaningful.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DST = path.join(ROOT, 'src');

/* Kept in step with TUS/HEADERS in build.mjs: the build fails loudly if a file
 * is missing, so this list cannot silently disagree with it. */
export const TUS = [
  'bigfloat.cpp', 'reference.cpp', 'deep.cpp', 'render.cpp', 'palette.cpp',
  'port/registry.cpp',
];
export const HEADERS = [
  'bigfloat.hpp', 'floatexp.hpp', 'reference.hpp', 'deep.hpp', 'render.hpp',
  'palette.hpp', 'dive.hpp', 'exact.hpp', 'image.hpp', 'port/port.hpp',
  'gmp_bridge.hpp', 'viewport.hpp',
];

const SRC = process.argv[2] || process.env.MB_SRC || 'C:/Users/harve/Desktop/mande/new/src';

if (!fs.existsSync(path.join(SRC, 'render.cpp'))) {
  console.error(`[sync-src] no core sources at ${SRC}`);
  console.error('[sync-src] usage: node webcore/sync-src.mjs <path-to-mande/new/src>');
  process.exit(1);
}

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(path.join(DST, 'port'), { recursive: true });

let total = 0;
for (const f of [...TUS, ...HEADERS]) {
  const from = path.join(SRC, f);
  const to = path.join(DST, f);
  if (!fs.existsSync(from)) throw new Error(`missing ${f} in ${SRC}`);
  const text = fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text);
  total += text.length;
  console.log(`  ${f.padEnd(18)} ${(text.length / 1024).toFixed(1)} KB`);
}
console.log(`[sync-src] ${TUS.length + HEADERS.length} files, ${(total / 1024).toFixed(0)} KB -> webcore/src/`);
