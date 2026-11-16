/* formulacore-worker.js — the arbitrary-formula core inside a Web Worker.
 *
 * This is the C++ core, not the page's JS kernel: every pixel is rendered by
 * formulacore.wasm.  ONE arbitrary-precision reference orbit is built with
 * the page's own hpeval.js BigInt arithmetic (via formulacore/env.js), and
 * the jet / series coefficients come from jet.js automatic differentiation.
 * The host's `usable` contract decides between
 *
 *   jet perturbation  (deep views, long orbits, one orbit + N pixels)  and
 *   direct double     (shallow views / short orbits, still C++ wasm).
 *
 * Output is the SAME single-channel f32 smooth-iteration field webcore's
 * worker returns (interior = -1), so shadeSmoothField() needs no changes.
 */
import { buildFormulaEnvironment } from '../formulacore/env.js?v=63';

/* deep.cpp: kEscape2 = 4.0.  Both cores must use the same bailout so their
 * smoothed iteration fields line up (see formulacore/align-test.mjs). */
const BAIL2 = 4.0;
const WASM_URL = new URL('../formulacore/formulacore.wasm?v=63', import.meta.url);

let e = null;
let allocs = [];
const programs = new Map();
const textEnc = new TextEncoder();

const dv = () => new DataView(e.memory.buffer);
const stub = (name) => (...a) => {
  if (name === 'environ_sizes_get' || name === 'args_sizes_get') {
    const d = dv();
    if (a[0]) d.setUint32(a[0], 0, true);
    if (a[1]) d.setUint32(a[1], 0, true);
    return 0;
  }
  if (name === 'clock_time_get') {
    const d = dv();
    if (a[2]) d.setBigUint64(a[2], BigInt(Date.now() * 1000000), true);
    return 0;
  }
  if (name === 'fd_write') { const d = dv(); if (a[3]) d.setUint32(a[3], 0, true); return 0; }
  if (name === 'proc_exit') throw new Error('proc_exit ' + a[0]);
  return 0;
};

async function init() {
  const res = await fetch(WASM_URL);
  if (!res.ok) throw new Error('formulacore.wasm HTTP ' + res.status);
  const mod = new WebAssembly.Module(await res.arrayBuffer());
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ||= {};
    imports[imp.module][imp.name] = imp.kind === 'function' ? stub(imp.name) : 0;
  }
  e = new WebAssembly.Instance(mod, imports).exports;
}

function cstr(p) {
  if (!p) return '';
  const m = new Uint8Array(e.memory.buffer);
  let s = '';
  for (let i = p; m[i]; ++i) s += String.fromCharCode(m[i]);
  return s;
}
function ws(s) {
  const b = textEnc.encode(String(s) + '\0');
  const p = e.fc_alloc(b.length);
  new Uint8Array(e.memory.buffer).set(b, p);
  allocs.push(p);
  return p;
}
function put(a) {
  const p = e.fc_alloc(Math.max(8, a.length * 8));
  new Float64Array(e.memory.buffer, p, a.length).set(a);
  allocs.push(p);
  return p;
}
function release() {
  for (const p of allocs) e.fc_free(p);
  allocs = [];
}

/* state.span is m * 2^e (BINARY exponent); the formula core takes a decimal
 * zoom = mantissa * 10^exponent.  zoom = 3 / span. */
function spanToZoom(span) {
  const log10z = Math.log10(3) - Math.log10(span.m) - span.e * Math.log10(2);
  const exp10 = Math.floor(log10z);
  return { zoomMant: Math.pow(10, log10z - exp10), zoomExp10: exp10 };
}

function fieldStats(field) {
  let lo = Infinity, hi = 0, bounded = 0;
  for (let i = 0; i < field.length; ++i) {
    const v = field[i];
    if (!(v >= 0)) { ++bounded; continue; }
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  /* refLen is deliberately 0: the deep-Julia short-reference guard belongs to
   * webcore.  This engine has its own `usable` contract and never paints a
   * frame whose reference died early. */
  return { minEsc: lo === Infinity ? 0 : lo, maxEsc: hi, bounded, refLen: 0 };
}

function render(job) {
  const y0 = Math.max(0, job.y0 | 0);
  const y1 = Math.min(job.h, job.y1 > 0 ? job.y1 | 0 : job.h);
  const { zoomMant, zoomExp10 } = spanToZoom(job.span);
  const expr = String(job.expr || 'z^2 + c');
  let prog = programs.get(expr);
  if (prog === undefined) {
    prog = e.fc_compile(ws(expr));
    if (prog < 0) throw new Error('unsupported expression: ' + cstr(e.fc_error()));
    programs.set(expr, prog);
  }

  const nparam = Math.max(0, e.fc_param_count(prog) | 0);
  const params = new Float64Array(Math.max(1, nparam));
  for (let i = 0; i < nparam; ++i) {
    const name = cstr(e.fc_param_name(prog, i));
    const v = Number(job.customParams ? job.customParams[name] : 0);
    params[i] = Number.isFinite(v) ? v : 0;
  }

  /* viewAngle() is 0 in the current basis; keep the parameter so a future
   * rotation change does not silently desynchronise the two engines. */
  const rot = Number(job.rot) || 0;
  const rc = Math.cos(rot), rs = Math.sin(rot);

  const mode = job.julia ? 1 : 0;
  const jr = ws(job.juliaRe || '0'), ji = ws(job.juliaIm || '0');

  /* The folded built-in families own a dedicated C++ kernel: an EXACT
   * piecewise-quadratic delta recurrence over a ladder of arbitrary-precision
   * orbits.  That is used at every depth -- the ladder is as cheap as a direct
   * double render here (both pay the same iteration count) and it stays exact
   * where a double pixel offset would collapse.  `fc_render` is only the
   * fallback for a job that arrived without a ladder. */
  if (job.family) {
    let rc0, engine;
    if (job.familyEnv) {
      const f = job.familyEnv;
      rc0 = e.fc_render_family(job.family, mode, job.w, job.h, job.maxiter,
        BAIL2, f.R, f.stride,
        put(f.zr), put(f.zi), put(f.foldA), put(f.foldB),
        put(f.offX), put(f.offY),
        f.dMant, f.dExp2, rc, rs, f.phoenixP,
        y0, y1, 0);
      engine = 'family';
    } else {
      rc0 = e.fc_render(prog, ws(job.re), ws(job.im), zoomMant, zoomExp10,
        job.w, job.h, job.maxiter, mode, jr, ji, BAIL2,
        nparam, put(params), rc, rs, y0, y1);
      engine = 'direct';
    }
    if (rc0) throw new Error(engine + ' rc ' + rc0 + ' ' + cstr(e.fc_error()));
    const full = new Float32Array(e.memory.buffer, e.fc_out_ptr(), job.w * job.h);
    const field = full.slice(y0 * job.w, y1 * job.w);
    return { w: job.w, h: job.h, y0, y1, field, stats: fieldStats(field), engine,
             ms: 0, bits: job.familyEnv ? job.familyEnv.bits : 0 };
  }

  const env = buildFormulaEnvironment({
    expr,
    centerRe: job.re, centerIm: job.im,
    maxiter: job.maxiter, zoomMant, zoomExp10,
    width: job.w, customParams: job.customParams || {},
  });

  let engine;
  /* `useJet` also checks that the reference survived and that the view is
   * deep enough for a truncated series to be cheap.  Shallow views are
   * rendered directly -- still entirely in C++ wasm. */
  if (env.useJet) {
    const rc0 = e.fc_render_jet(prog, job.w, job.h, job.maxiter, mode, BAIL2,
      env.orbitLen, put(env.zr), put(env.zi), put(env.coefA), put(env.coefB),
      env.jetOrder, env.stride, env.dMant, env.dExp2, rc, rs,
      y0, y1, env.saSkip, put(env.saAt), 1);
    if (rc0) throw new Error('fc_render_jet rc ' + rc0 + ' ' + cstr(e.fc_error()));
    engine = 'jet';
  } else {
    /* Short orbit at depth cannot be rendered in double either -- the page's
     * high-precision kernel is the right fallback for that view. */
    if (zoomExp10 > 12) throw new Error('reference orbit too short at this depth');
    const rc0 = e.fc_render(prog, ws(job.re), ws(job.im), zoomMant, zoomExp10,
      job.w, job.h, job.maxiter, mode, jr, ji, BAIL2,
      nparam, put(params), rc, rs, y0, y1);
    if (rc0) throw new Error('fc_render rc ' + rc0 + ' ' + cstr(e.fc_error()));
    engine = 'direct';
  }

  const full = new Float32Array(e.memory.buffer, e.fc_out_ptr(), job.w * job.h);
  const field = full.slice(y0 * job.w, y1 * job.w);
  return { w: job.w, h: job.h, y0, y1, field, stats: fieldStats(field), engine,
           ms: 0, jetOrder: env.jetOrder, saSkip: env.saSkip, bits: env.bits };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    try { await init(); self.postMessage({ type: 'ready' }); }
    catch (err) { self.postMessage({ type: 'fatal', err: String(err && err.message || err) }); }
    return;
  }
  if (m.type !== 'render') return;
  try {
    const t0 = performance.now();
    const out = render(m.job);
    out.ms = performance.now() - t0;
    self.postMessage({ type: 'done', id: m.id, ...out }, [out.field.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, err: String(err && err.message || err) });
  } finally {
    if (e) release();
  }
};
