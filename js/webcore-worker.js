// webcore-worker.js — WASM host for the desktop core (core.wasm).
//
// Zero algorithm logic here: it fills the adapter ABI with the page's job
// (centre string, decimal zoom, size, iteration budget), calls mb_render(), and
// converts the core's four-channel field into the colour position the page's
// palette stage consumes:
//
//   core field4  = [smooth iteration, distance px, iteration, 0]
//                   interior pixels carry a negative smooth value
//   page field   = smooth * (1/cycle) + offset, wrapped to [0,1); interior < 0
//
// Doing the conversion here (not on the page) keeps a 3.5 Mpx frame at one
// float per pixel over the wire instead of four, and lets the interior count
// ride along for free — the HUD's "all interior" banner needs it.

'use strict';

let core = null;

async function loadCore() {
  const resp = await fetch('../core.wasm?v=52');
  const bytes = await resp.arrayBuffer();
  const mod = await WebAssembly.compile(bytes);
  let memView = null;
  let coreMem = null;
  const clock = (id, prec, out) => {
    if (out) {
      memView = memView && memView.buffer === coreMem.buffer
        ? memView : new DataView(coreMem.buffer);
      memView.setBigUint64(out, BigInt(Math.floor(Date.now() * 1e6)), true);
    }
    return 0;
  };
  /* A WASI stub that returns 0 without writing its out-parameters is not a
   * no-op: libc reads whatever was in that memory.  `environ_sizes_get` was the
   * one that hurt — the core's first getenv() (its B2_* experiment knobs) makes
   * libc allocate an "environment" of whatever garbage size those two words
   * held, which measured 512 MB of zeroed memory **per wasm instance**.  Four
   * band workers then held 2 GB of nothing, which is why splitting a deep frame
   * across them looked no faster than one instance: they were thrashing, not
   * computing.  Write the zeroes. */
  const imports = { wasi_snapshot_preview1: {} };
  const zeroes = (a, b) => {
    const dv = new DataView(coreMem.buffer);
    dv.setUint32(a, 0, true);
    if (b) dv.setUint32(b, 0, true);
    return 0;
  };
  const stubs = {
    clock_time_get: clock,
    environ_sizes_get: zeroes,      // empty environment: no B2_* knobs in wasm
    environ_get: zeroes,
    args_sizes_get: zeroes,
    args_get: zeroes,
    fd_write: (fd, iovs, n, written) => {
      new DataView(coreMem.buffer).setUint32(written, 0, true);
      return 0;
    },
  };
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ||= {};
    if (imp.kind !== 'function') { imports[imp.module][imp.name] = 0; continue; }
    imports[imp.module][imp.name] = stubs[imp.name] || (() => 0);
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  const e = instance.exports;
  coreMem = e.memory;
  const view = () => (memView = new DataView(e.memory.buffer));

  const enc = new TextEncoder();
  const writeStr = (s) => {
    const b = enc.encode(String(s ?? '0') + '\0');
    const p = e.mb_alloc(b.length);
    new Uint8Array(e.memory.buffer).set(b, p);
    return p;
  };
  const readStr = (p) => {
    const u = new Uint8Array(e.memory.buffer);
    let s = '';
    while (u[p + s.length]) s += String.fromCharCode(u[p + s.length]);
    return s;
  };
  const viewState = () => ({
    centerRe: readStr(e.mb_view_center_re()),
    centerIm: readStr(e.mb_view_center_im()),
    zoomMant: e.mb_view_zoom_mant(),
    zoomExp10: e.mb_view_zoom_exp10(),
    spanLog10: e.mb_view_span_log10(),
    digits: e.mb_view_digits(),
  });
  const statsPOD = () => {
    const v = view();
    const sp = e.mb_stats_ptr();
    return {
      seconds: v.getFloat64(sp, true),
      pixels: Number(v.getBigInt64(sp + 8, true)),
      glitches: Number(v.getBigInt64(sp + 16, true)),
      refLen: v.getInt32(sp + 40, true),
      precDigits: v.getInt32(sp + 44, true),
      log10Zoom: v.getFloat64(sp + 48, true),
      maxEsc: v.getInt32(sp + 72, true),
      minEsc: v.getInt32(sp + 76, true),
    };
  };

  return {
    setView(v) {
      const a = writeStr(v.centerRe);
      const b = writeStr(v.centerIm);
      const rc = e.mb_view_set(a, b, Number(v.zoomMant) || 1,
        v.zoomExp10 | 0, v.width | 0, v.height | 0, 3.0);
      e.mb_free(a, 1); e.mb_free(b, 1);
      return rc === 0 ? viewState() : null;
    },
    zoom(x, y, f) { return e.mb_view_zoom_at(x, y, f) === 0 ? viewState() : null; },
    pan(dx, dy) { e.mb_view_pan(dx, dy); return viewState(); },
    pinch(x0, y0, x1, y1, f) {
      return e.mb_view_pinch(x0, y0, x1, y1, f) === 0 ? viewState() : null;
    },

    /* One whole frame, or one horizontal band of it.  The centre strings go in
     * verbatim (the explicit-coordinate ABI), so nothing here re-prints a
     * 100-digit coordinate before the core parses it. */
    render(job, band) {
      const a = writeStr(job.re);
      const b = writeStr(job.im);
      const jr = writeStr(job.juliaRe || '0');
      const ji = writeStr(job.juliaIm || '0');
      const pal = writeStr('');            // empty => four-channel field
      const w = job.width | 0;
      const hFull = job.height | 0;
      const y0 = band ? band[0] | 0 : 0;
      const y1 = band ? band[1] | 0 : hFull;
      const h = y1 - y0;
      const t0 = performance.now();
      const common = [a, b, Number(job.zoomMant) || 1, job.zoomExp10 | 0];
      /* Identity unless the card is rotated; the core composes the same pixel
       * basis the page's planeDelta does. */
      const rc0 = Number(job.rotCos), rs0 = Number(job.rotSin);
      const rotCos = Number.isFinite(rc0) ? rc0 : 1;
      const rotSin = Number.isFinite(rs0) ? rs0 : 0;
      const rc = band
        ? e.mb_render_strip(...common, w, hFull, y0, y1, job.maxiter | 0,
            job.julia ? 1 : 0, jr, ji, pal, 0, 0, 16, 1, 1, 0, 1,
            rotCos, rotSin, job.interiorPalette ? 1 : 0)
        : e.mb_render(...common, w, h, job.maxiter | 0,
            job.julia ? 1 : 0, jr, ji, pal, 0, 0, 16, 1, 1, 0, 1,
            rotCos, rotSin, job.interiorPalette ? 1 : 0);
      const ms = performance.now() - t0;
      const err = rc ? readStr(e.mb_error()) : '';
      const outP = e.mb_out_ptr(), outN = e.mb_out_size();
      const mode = e.mb_out_mode();
      const stats = statsPOD();
      e.mb_free(a, 1); e.mb_free(b, 1); e.mb_free(jr, 1);
      e.mb_free(ji, 1); e.mb_free(pal, 1);
      if (rc) return { rc, err, mode, ms, stats, w, h, y0 };

      const n = w * h;
      const pos = new Float32Array(n);
      let inside = 0;
      if (mode === 1) {
        /* One float per pixel: the smooth iteration count, interior as -1.
         * The palette band is chosen on the page from this frame's own escape
         * range, so shading (and re-banding, and a palette change) never needs
         * another render. */
        const f = new Float32Array(e.memory.buffer, outP, n * 4);
        for (let i = 0, q = 0; i < n; i++, q += 4) {
          const sv = f[q];
          if (sv >= 0) pos[i] = sv; else { pos[i] = -1; inside++; }
        }
      } else {
        /* No field (a future palette mode): report it rather than serving an
         * all-black picture as if it were a render. */
        return { rc: 2, err: 'core returned an image, not a field', mode, ms, stats, w, h, y0 };
      }
      stats.bounded = inside;
      return { rc: 0, err: '', mode, ms, stats, w, h, y0, field: pos };
    },
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.cmd !== 'boot' && !core) core = await loadCore();
    switch (msg.cmd) {
      case 'boot': {
        core = await loadCore();
        self.postMessage({ type: 'ready' });
        break;
      }
      case 'view': {
        const v = core.setView(msg.view || {});
        self.postMessage({ type: 'view', id: msg.id, view: v, err: v ? '' : 'view rejected' });
        break;
      }
      case 'zoom': {
        const v = core.zoom(msg.x, msg.y, msg.factor);
        self.postMessage({ type: 'view', id: msg.id, view: v, err: v ? '' : 'zoom rejected' });
        break;
      }
      case 'pan': {
        const v = core.pan(msg.dx, msg.dy);
        self.postMessage({ type: 'view', id: msg.id, view: v });
        break;
      }
      case 'pinch': {
        const v = core.pinch(msg.x0, msg.y0, msg.x1, msg.y1, msg.factor);
        self.postMessage({ type: 'view', id: msg.id, view: v, err: v ? '' : 'pinch rejected' });
        break;
      }
      case 'render': {
        const r = core.render(msg.job || {}, null);
        if (r.field) {
          self.postMessage({ type: 'frame', id: msg.id, w: r.w, h: r.h, y0: 0,
            field: r.field, stats: r.stats, ms: r.ms, err: '' }, [r.field.buffer]);
        } else {
          self.postMessage({ type: 'error', id: msg.id, err: r.err || 'render failed',
            stats: r.stats, ms: r.ms });
        }
        break;
      }
      case 'strip': {
        const j = msg.job || {};
        const r = core.render(j, [j.y0 | 0, j.y1 | 0]);
        if (r.field) {
          self.postMessage({ type: 'frame', id: msg.id, w: r.w, h: r.h, y0: r.y0,
            field: r.field, stats: r.stats, ms: r.ms, err: '' }, [r.field.buffer]);
        } else {
          self.postMessage({ type: 'error', id: msg.id, err: r.err || 'strip failed',
            stats: r.stats, ms: r.ms });
        }
        break;
      }
      default:
        break;
    }
  } catch (ex) {
    self.postMessage({ type: 'error', id: msg && msg.id, err: String((ex && ex.message) || ex) });
  }
};
