/* ------------------------------------------------------------------
 * build-core-package.mjs — build the downloadable local bundle.
 *
 * The GitHub Pages build is a pure static site: everything renders inside
 * the browser.  For maximum throughput the same code can also run next to
 * the user, with the kernel hosted by a Node.js worker-thread pool.  This
 * script packs that self-contained bundle (page + core + launchers) into
 * `core/mandelbrot-core.zip`, which the in-app "Render core" panel offers
 * for download.
 *
 * ZIP is written by hand (store method) so the build has zero dependencies.
 * ------------------------------------------------------------------ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'core');
const OUT_ZIP = path.join(OUT_DIR, 'mandelbrot-core.zip');
const FOLDER = 'mandelbrot-core';

/** Runtime files: everything the page needs, nothing from the dev tooling. */
const FILES = [
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/bigfixed.js',
  'js/corepanel.js',
  'js/customenv.js',
  'js/environment.js',
  'js/formulas.js',
  'js/hpeval.js',
  'js/i18n.js',
  'js/jet.js',
  'js/kernel-wasm.js',
  'js/mathlib.js',
  'js/palettes.js',
  'js/presets-data.js',
  'js/remote.js',
  'js/render.js',
  'js/worker.js',
  'server/render-server.mjs',
  'server/render-worker.mjs',
  'server/static-server.mjs'
];

/* ---------------- minimal ZIP writer ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime();

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 names
    local.writeUInt16LE(0, 8);         // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ---------------- launchers ---------------- */
const START_BAT = `@echo off
chcp 65001 >nul
title MANDELBROT - local core
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found. Install Node.js 18+ from https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)
echo   [1/2] render core  ->  http://127.0.0.1:8778
start "MANDELBROT render core" /min node "%~dp0server\\render-server.mjs"
echo   [2/2] static page  ->  http://127.0.0.1:8777
start "MANDELBROT page" /min node "%~dp0server\\static-server.mjs"
timeout /t 1 >nul
start "" http://127.0.0.1:8777/index.html
echo.
echo   Both servers are running in the background. Close those windows to stop them.
`;

const START_SH = `#!/usr/bin/env bash
# MANDELBROT — start the local core and the static page.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }

node server/render-server.mjs &
CORE=$!
node server/static-server.mjs &
PAGE=$!
trap 'kill $CORE $PAGE 2>/dev/null' EXIT

sleep 1
( command -v open >/dev/null && open http://127.0.0.1:8777/index.html ) \\
  || ( command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8777/index.html ) \\
  || echo "Open http://127.0.0.1:8777/index.html in your browser."

wait
`;

const PKG_JSON = `{
  "name": "mandelbrot-core",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Local render core for the MANDELBROT precision fractal observatory"
}
`;

const README_LOCAL = `# MANDELBROT — local bundle

This archive contains the complete fractal observatory and its native render
core, so it runs offline with the kernel hosted outside the browser.

## Requirements
- Node.js 18 or newer (https://nodejs.org)

## Start
- **Windows** — double-click \`start-core.bat\`
- **macOS / Linux** — \`bash start-core.sh\`

The launcher starts two local servers and opens the page:

| service | address | purpose |
| --- | --- | --- |
| render core | http://127.0.0.1:8778 | worker-thread pool running the C++/WASM kernel |
| static page | http://127.0.0.1:8777 | serves this bundle over HTTP (required by ES modules) |

Both bind to the loopback interface only and are unreachable from the network.

## Why the core cannot be used from the hosted page
GitHub Pages serves over HTTPS, and browsers refuse to let an HTTPS page call
http://127.0.0.1 (mixed content). Run this bundle locally to use the core; the
hosted build keeps using the in-browser WebAssembly kernel, which is the same
code path.
`;

/* ---------------- assemble ---------------- */
function entry(name, content) {
  return { name: path.posix.join(FOLDER, name), data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') };
}

const entries = [];
let raw = 0;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  raw += buf.length;
  entries.push(entry(rel, buf));
}
entries.push(entry('start-core.bat', START_BAT.replace(/\r?\n/g, '\r\n')));
entries.push(entry('start-core.sh', START_SH));
entries.push(entry('package.json', PKG_JSON));
entries.push(entry('README.md', README_LOCAL));

const zip = buildZip(entries);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_ZIP, zip);

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
  name: 'mandelbrot-core',
  version: '1.0.0',
  file: 'mandelbrot-core.zip',
  bytes: zip.length,
  files: entries.length,
  builtAt: new Date().toISOString()
}, null, 2));

console.log(`[core] ${path.relative(ROOT, OUT_ZIP)}  ${(zip.length / 1024).toFixed(1)} KB  ` +
  `(${entries.length} files, ${(raw / 1024).toFixed(1)} KB raw)`);
