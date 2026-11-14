// shell-worker.js — WASM host for the desktop core (core.wasm).
// Zero algorithm logic here: it fills the adapter ABI and copies pixels back.

'use strict';

let core = null;

async function loadCore() {
  const resp = await fetch('core.wasm?v=1');
  const bytes = await resp.arrayBuffer();
  const mod = await WebAssembly.compile(bytes);
  let memView = null;
  const clock = (id, prec, out) => {
    if (out) {
      memView = memView && memView.buffer === coreMem.buffer
        ? memView : new DataView(coreMem.buffer);
      memView.setBigUint64(out, BigInt(Math.floor(Date.now() * 1e6)), true);
    }
    return 0;
  };
  let coreMem = null;
  const imports = { wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ||= {};
    if (imp.kind !== 'function') { imports[imp.module][imp.name] = 0; continue; }
    imports[imp.module][imp.name] = imp.name === 'clock_time_get' ? clock : () => 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  const e = instance.exports;
  coreMem = e.memory;
  const view = () => new DataView(e.memory.buffer);
  view();

  const enc = new TextEncoder();
  const writeStr = (s) => {
    const v = view();
    const bytes2 = enc.encode(String(s ?? '0') + '\0');
    const p = e.mb_alloc(bytes2.length);
    new Uint8Array(e.memory.buffer).set(bytes2, p);
    return p;
  };
  const readStr = (p) => {
    const u = new Uint8Array(e.memory.buffer);
    let s = '';
    while (u[p + s.length]) s += String.fromCharCode(u[p + s.length]);
    return s;
  };

  return {
    render(job) {
      const a = writeStr(job.centerRe);
      const b = writeStr(job.centerIm);
      const jr = writeStr(job.juliaRe || '0');
      const ji = writeStr(job.juliaIm || '0');
      const pal = writeStr(job.palette || 'rainbow');
      const t0 = performance.now();
      const rc = e.mb_render(
        a, b, job.zoomMant, job.zoomExp10 | 0,
        job.width | 0, job.height | 0, job.maxiter | 0,
        job.julia ? 1 : 0, jr, ji,
        pal, 0, job.colorMode | 0,
        16, 1, 1, 0, 1,
        1.0, 0.0, job.interiorPalette ? 1 : 0);
      const ms = performance.now() - t0;
      const err = rc ? readStr(e.mb_error()) : '';
      const outP = e.mb_out_ptr(), outN = e.mb_out_size();
      const mode = e.mb_out_mode();
      let out;
      if (mode === 0) {
        out = new Uint8Array(job.width * job.height * 4);
        const rgb = new Uint8Array(e.memory.buffer, outP, outN);
        for (let i = 0, n = job.width * job.height; i < n; i++) {
          out[i * 4] = rgb[i * 3];
          out[i * 4 + 1] = rgb[i * 3 + 1];
          out[i * 4 + 2] = rgb[i * 3 + 2];
          out[i * 4 + 3] = 255;
        }
      } else {
        out = new Float32Array(e.memory.buffer.slice(outP, outP + outN));
      }
      const v = view();
      const sp = e.mb_stats_ptr();
      const stats = {
        seconds: v.getFloat64(sp, true),
        refLen: v.getInt32(sp + 40, true),
        precDigits: v.getInt32(sp + 44, true),
        log10Zoom: v.getFloat64(sp + 48, true),
        maxEsc: v.getInt32(sp + 72, true),
        minEsc: v.getInt32(sp + 76, true),
      };
      e.mb_free(a, 1); e.mb_free(b, 1); e.mb_free(jr, 1); e.mb_free(ji, 1); e.mb_free(pal, 1);
      return { rc, err, out, mode, stats, ms, w: job.width, h: job.height };
    },
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.cmd === 'render') {
      if (!core) core = await loadCore();
      const r = core.render(msg.job);
      if (r.mode === 0) {
        self.postMessage({ type: 'frame', id: msg.id, w: r.w, h: r.h,
          rgba: r.out.buffer, stats: r.stats, ms: r.ms, err: r.err },
          [r.out.buffer]);
      } else {
        self.postMessage({ type: 'frame', id: msg.id, w: r.w, h: r.h,
          field: r.out, stats: r.stats, ms: r.ms, err: r.err });
      }
    }
  } catch (ex) {
    self.postMessage({ type: 'error', id: msg && msg.id, err: String(ex && ex.message || ex) });
  }
};
