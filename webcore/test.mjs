// test.mjs — load core.wasm in Node, render, and compare pixel-by-pixel
// against the desktop core's own PNG (the golden standard).
//
// usage: node test.mjs [--quick]
//   --quick : one shallow view only (compile smoke test)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decode as decodePng } from '../tools/_pngdiff.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MSET = 'C:/Users/harve/Desktop/mande/new/dist/mset.exe';
const TMP = path.join(ROOT, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

// ---------------------------------------------------------------- wasm host
async function loadCore() {
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'core.wasm')));
  let memView = null;
  const clock = (id, prec_, out) => {
    if (out) view().setBigUint64(out, BigInt(Math.floor(Date.now() * 1e6)), true);
    return 0;
  };
  const imports = { wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== 'function') { imports[imp.module] ||= {}; imports[imp.module][imp.name] = 0; continue; }
    imports[imp.module][imp.name] =
      imp.name === 'clock_time_get' ? clock : () => 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  const e = instance.exports;
  const view = () => (memView = new DataView(e.memory.buffer));
  view();

  const enc = new TextEncoder();
  const writeStr = (s) => {
    view();
    const bytes = enc.encode(s + '\0');
    const p = e.mb_alloc(bytes.length);
    new Uint8Array(e.memory.buffer).set(bytes, p);
    return p;
  };

  class Core {
    render(opts) {
      const o = {
        centerRe: '-0.6', centerIm: '0.0',
        zoomMant: 1.0, zoomExp10: 0,
        width: 320, height: 200, maxiter: 2000,
        julia: false, juliaRe: '0', juliaIm: '0',
        palette: 'rainbow', paletteScale: 0, colorMode: 0,
        saOrder: 16, useSa: 1, tileRebase: 1, exact: 0, threads: 1,
        rotCos: 1, rotSin: 0, interiorPalette: 0, ...opts,
      };
      const a = writeStr(o.centerRe), b = writeStr(o.centerIm);
      const jr = writeStr(o.juliaRe), ji = writeStr(o.juliaIm);
      const pal = writeStr(o.palette);
      const rc = e.mb_render(a, b, o.zoomMant, o.zoomExp10, o.width, o.height,
        o.maxiter, o.julia ? 1 : 0, jr, ji, pal, o.paletteScale, o.colorMode,
        o.saOrder, o.useSa, o.tileRebase, o.exact, o.threads,
        o.rotCos, o.rotSin, o.interiorPalette);
      view();
      const err = rc ? this.error() : '';
      const outP = e.mb_out_ptr(), outN = e.mb_out_size();
      const mode = e.mb_out_mode();
      let out;
      if (mode === 0) {
        out = new Uint8Array(e.memory.buffer.slice(outP, outP + outN));
      } else {
        out = new Float32Array(e.memory.buffer.slice(outP, outP + outN));
      }
      const sp = e.mb_stats_ptr();
      const v = view();
      const st = {
        seconds: v.getFloat64(sp, true),
        pixels: Number(v.getBigInt64(sp + 8, true)),
        glitches: Number(v.getBigInt64(sp + 16, true)),
        saSkipped: Number(v.getBigInt64(sp + 24, true)),
        tileRefs: Number(v.getBigInt64(sp + 32, true)),
        refLen: v.getInt32(sp + 40, true),
        precDigits: v.getInt32(sp + 44, true),
        log10Zoom: v.getFloat64(sp + 48, true),
        pixelScaleLog10: v.getFloat64(sp + 56, true),
        steps: Number(v.getBigInt64(sp + 64, true)),
        maxEsc: v.getInt32(sp + 72, true),
        minEsc: v.getInt32(sp + 76, true),
        cancelled: v.getInt32(sp + 80, true) === 1,
      };
      e.mb_free(a, 1); e.mb_free(b, 1); e.mb_free(jr, 1); e.mb_free(ji, 1); e.mb_free(pal, 1);
      return { rc, err, out, mode, st, w: o.width, h: o.height };
    }
    error() { view(); const p = e.mb_error(); let s = ''; const u = new Uint8Array(e.memory.buffer); while (u[p + s.length]) s += String.fromCharCode(u[p + s.length]); return s; }
    backend() { view(); const p = e.mb_backend(); let s = ''; const u = new Uint8Array(e.memory.buffer); while (u[p + s.length]) s += String.fromCharCode(u[p + s.length]); return s; }
  }
  return new Core();
}

// ---------------------------------------------------------------- compare
function compareRgb(core, png) {
  // png.px is RGB or RGBA; compare channel-wise on the first three.
  const w = core.w, h = core.h;
  let same = 0, diff = 0, maxDelta = 0, sumDelta = 0;
  for (let i = 0, n = w * h; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const a = core.out[i * 3 + c], b = png.px[i * png.bpp + c];
      const d = Math.abs(a - b);
      if (d === 0) same++; else diff++;
      if (d > maxDelta) maxDelta = d;
      sumDelta += d;
    }
  }
  const samples = w * h * 3;
  return {
    pixelSamePct: (100 * same / samples).toFixed(3),
    maxDelta, meanDelta: (sumDelta / samples).toFixed(3),
    exactPct: null, diff,
  };
}

function countNonBlack(rgb) {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) if (rgb[i] + rgb[i + 1] + rgb[i + 2] > 24) n++;
  return n;
}

// ---------------------------------------------------------------- main
const quick = process.argv.includes('--quick');
const core = await loadCore();
console.log('[core] backend =', core.backend());

const VIEWS = quick ? [
  { tag: 'home', centerRe: '-0.6', centerIm: '0.0', zoomMant: 1.0, zoomExp10: 0, width: 320, height: 200, maxiter: 2000 },
] : [
  { tag: 'home', centerRe: '-0.6', centerIm: '0.0', zoomMant: 1.0, zoomExp10: 0, width: 480, height: 300, maxiter: 2000 },
  { tag: 'user15', centerRe: '-0.7436438870374124', centerIm: '0.1318259145695319', zoomMant: 1.5848931924611135, zoomExp10: 15, width: 720, height: 430, maxiter: 4439 },
  { tag: 'deep38', centerRe: '-1.7499976601933828', centerIm: '0.0000001000000000', zoomMant: 9.99, zoomExp10: 38, width: 426, height: 240, maxiter: 3000 },
  { tag: 'ci600', centerRe: '0', centerIm: '1', zoomMant: 9.99, zoomExp10: 600, width: 200, height: 120, maxiter: 2000 },
  { tag: 'julia', centerRe: '-0.74', centerIm: '0.13', zoomMant: 1.0, zoomExp10: 0, width: 400, height: 250, maxiter: 2000, julia: true, juliaRe: '-0.7435', juliaIm: '0.1314' },
];

let failures = 0;
for (const v of VIEWS) {
  const t0 = Date.now();
  const r = core.render(v);
  const wall = Date.now() - t0;
  const nonBlack = r.mode === 0 ? countNonBlack(r.out) : -1;
  console.log(`[${v.tag}] rc=${r.rc} ${r.err} mode=${r.mode} refLen=${r.st.refLen} digits=${r.st.precDigits} ` +
    `glitches=${r.st.glitches} maxEsc=${r.st.maxEsc} minEsc=${r.st.minEsc} saSkip=${r.st.saSkipped} ` +
    `core=${r.st.seconds.toFixed(2)}s wall=${wall}ms nonBlack=${nonBlack}`);
  if (r.rc !== 0) { failures++; continue; }
  if (r.mode !== 0) continue;

  if (!quick && v.tag !== 'julia') {
    const zoomDec = `${v.zoomMant}e${v.zoomExp10}`;
    const pngPath = path.join(TMP, `desktop-${v.tag}.png`);
    const out = execFileSync(MSET, ['render',
      '--center-re', v.centerRe, '--center-im', v.centerIm,
      '--zoom', `${v.zoomMant}e${v.zoomExp10}`,   // never through double: 1e309+ would become Infinity
      '--width', String(v.width), '--height', String(v.height),
      '--maxiter', String(v.maxiter), '--out', pngPath],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(MSET) }).toString();
    const ref = /reference orbit = (\d+) points|escape range = (\S+) \.\. (\S+)|band = (\S+) iters/g
      [Symbol.match] ? null : null;
    console.log('    desktop:', out.split('\n').filter(l => /reference|escape|band|glitches/.test(l)).map(s => s.trim()).join(' | '));
    const png = decodePng(pngPath);
    const cmp = compareRgb(r, png);
    const ok = Number(cmp.pixelSamePct) >= 99.0 && cmp.maxDelta <= 48;
    if (!ok) failures++;
    console.log(`    vs desktop PNG: same=${cmp.pixelSamePct}% maxDelta=${cmp.maxDelta} meanDelta=${cmp.meanDelta} ` +
      `${ok ? 'PASS' : 'FAIL'}`);
    fs.writeFileSync(path.join(TMP, `wasm-${v.tag}.ppm`),
      Buffer.concat([Buffer.from(`P6\n${v.width} ${v.height}\n255\n`), Buffer.from(r.out)]));
  }
}

console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
