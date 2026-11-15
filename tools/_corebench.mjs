// _corebench.mjs — how fast is core.wasm at the sizes the page actually asks
// for?  Prints wall ms and ms/Mpx so the preview scale is a decision, not a
// guess.  Field mode (empty palette) because that is what the page consumes.
//
// usage: node tools/_corebench.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/mandelbrot view';

async function loadCore() {
  const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'core.wasm')));
  const clock = (id, prec, out) => {
    if (out) new DataView(e.memory.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
    return 0;
  };
  const imports = { wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ||= {};
    imports[imp.module][imp.name] = imp.kind === 'function'
      ? (imp.name === 'clock_time_get' ? clock : () => 0) : 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  const e = instance.exports;
  const enc = new TextEncoder();
  const writeStr = (s) => {
    const b = enc.encode(String(s) + '\0');
    const p = e.mb_alloc(b.length);
    new Uint8Array(e.memory.buffer).set(b, p);
    return p;
  };
  return { e, writeStr };
}

const { e, writeStr } = await loadCore();

function render({ re, im, zoomMant, zoomExp10, w, h, maxiter, julia = 0, jre = '0', jim = '0' }) {
  const a = writeStr(re), b = writeStr(im), jr = writeStr(jre), ji = writeStr(jim);
  const pal = writeStr('');            // empty => field4 mode
  const t0 = performance.now();
  const rc = e.mb_render(a, b, zoomMant, zoomExp10, w, h, maxiter, julia, jr, ji,
    pal, 0, 0, 16, 1, 1, 0, 1, 1, 0, 0);
  const ms = performance.now() - t0;
  const sp = e.mb_stats_ptr();
  const v = new DataView(e.memory.buffer);
  const outP = e.mb_out_ptr(), outN = e.mb_out_size();
  const mode = e.mb_out_mode();
  // Touch the field so the copy cost is counted the way the worker pays it.
  const field = mode === 1 ? new Float32Array(e.memory.buffer.slice(outP, outP + outN)) : null;
  return { rc, ms, mode, field, refLen: v.getInt32(sp + 40, true), digits: v.getInt32(sp + 44, true),
           maxEsc: v.getInt32(sp + 72, true), minEsc: v.getInt32(sp + 76, true) };
}

const VIEWS = [
  { tag: 'home', re: '-0.6', im: '0', zoomMant: 3.0, zoomExp10: 0, maxiter: 600 },
  { tag: 'user15', re: '-0.7436438870374124', im: '0.1318259145695319', zoomMant: 1.5848931924611135, zoomExp10: 15, maxiter: 4439 },
  { tag: 'deep38', re: '-1.7499976601933828', im: '0.0000001000000000', zoomMant: 9.99, zoomExp10: 38, maxiter: 3000 },
  { tag: 'ci600', re: '0', im: '1', zoomMant: 9.99, zoomExp10: 600, maxiter: 2000 },
];

for (const v of VIEWS) {
  for (const [w, h] of [[300, 170], [600, 340], [1248, 704]]) {
    const r = render({ ...v, w, h });
    const mpx = (w * h) / 1e6;
    console.log(`${v.tag.padEnd(7)} ${String(w + 'x' + h).padEnd(10)} rc=${r.rc} mode=${r.mode} ` +
      `${r.ms.toFixed(0).padStart(6)}ms  ${(r.ms / mpx).toFixed(0).padStart(5)} ms/Mpx  ` +
      `ref=${r.refLen} dig=${r.digits} esc=${r.minEsc}..${r.maxEsc}`);
  }
}
