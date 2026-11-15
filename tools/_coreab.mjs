/* _coreab.mjs — two core builds, same process, interleaved.
 *
 * Machine state drifts (background work, clocks); a sequential A then B run
 * measures the drift as much as the change.  Alternating the two builds inside
 * one process and taking the min of N per build removes that.
 *
 * usage: node tools/_coreab.mjs a.wasm b.wasm [repeats]
 */
import fs from 'node:fs';

const [A, B, rep] = process.argv.slice(2);
const REPEATS = Number(rep || 3);

async function load(file) {
  const mod = new WebAssembly.Module(fs.readFileSync(file));
  let coreMem = null;
  let memView = null;
  const clock = (id, prec, out) => {
    if (out) {
      memView = memView && memView.buffer === coreMem.buffer ? memView : new DataView(coreMem.buffer);
      memView.setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
    }
    return 0;
  };
  const imports = { wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ||= {};
    imports[imp.module][imp.name] = imp.kind === 'function'
      ? (imp.name === 'clock_time_get' ? clock : () => 0) : 0;
  }
  const e = (await WebAssembly.instantiate(mod, imports)).exports;
  coreMem = e.memory;
  const enc = new TextEncoder();
  const writeStr = (s) => {
    const b = enc.encode(String(s) + '\0');
    const p = e.mb_alloc(b.length);
    new Uint8Array(e.memory.buffer).set(b, p);
    return p;
  };
  return {
    name: file.split(/[\\/]/).pop(),
    e, writeStr,
    render(v) {
      const a = writeStr(v.re), b = writeStr(v.im), jr = writeStr('0'), ji = writeStr('0');
      const pal = writeStr('');
      const t0 = performance.now();
      const rc = e.mb_render(a, b, v.zoomMant, v.zoomExp10, v.w, v.h, v.maxiter,
        0, jr, ji, pal, 0, 0, 16, 1, 1, 0, 1, 1, 0, 0);
      const ms = performance.now() - t0;
      e.mb_out_ptr(); e.mb_out_size();
      const sp = e.mb_stats_ptr();
      const dv = new DataView(e.memory.buffer);
      return { rc, ms, refLen: dv.getInt32(sp + 40, true), digits: dv.getInt32(sp + 44, true),
               escMin: dv.getInt32(sp + 76, true), escMax: dv.getInt32(sp + 72, true) };
    },
  };
}

const a = await load(A);
const b = await load(B);

const VIEWS = [
  { tag: 'home', re: '-0.6', im: '0', zoomMant: 3.0, zoomExp10: 0, w: 1248, h: 704, maxiter: 600 },
  { tag: 'ci600', re: '0', im: '1', zoomMant: 2.4, zoomExp10: 600, w: 1248, h: 704, maxiter: 3000 },
];

for (const v of VIEWS) {
  const best = { [a.name]: Infinity, [b.name]: Infinity };
  for (let i = 0; i < REPEATS; i++) {
    for (const core of [a, b]) {
      const r = core.render(v);
      if (r.ms < best[core.name]) best[core.name] = r.ms;
    }
  }
  const [na, nb] = [a.name, b.name];
  console.log(`${v.tag.padEnd(6)} ${na}=${best[na].toFixed(0)}ms  ${nb}=${best[nb].toFixed(0)}ms  ` +
    `ratio ${(best[nb] / best[na]).toFixed(2)}x`);
}
