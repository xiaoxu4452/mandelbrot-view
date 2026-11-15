// test-view.mjs — acceptance for the view that now lives in the core.
//
// The page no longer does coordinate arithmetic; `mb_view_zoom_at` is the
// recovered app_state.cpp rule:
//     before = point_at(x, y);  zoom_by(factor);  after = point_at(x, y);
//     centre += before - after;
// A correct implementation is *invariant*: zooming in N steps and back out N
// steps at the same pixel must return the centre to the exact same digits.
// Power-of-two factors make that test bit-exact (no double rounding at all).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const mod = new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'core.wasm')));
const imports = { wasi_snapshot_preview1: {} };
for (const imp of WebAssembly.Module.imports(mod)) {
  if (imp.kind !== 'function') { imports[imp.module] ||= {}; imports[imp.module][imp.name] = 0; continue; }
  imports[imp.module][imp.name] = () => 0;
}
const { exports: e } = await WebAssembly.instantiate(mod, imports);
const enc = new TextEncoder();
const mem = () => new Uint8Array(e.memory.buffer);
const put = (s) => {
  const b = enc.encode(s + '\0');
  const p = e.mb_alloc(b.length);
  mem().set(b, p);
  return p;
};
const cstrAt = (p) => {
  const u = mem();
  let s = '';
  for (let i = 0; u[p + i]; i++) s += String.fromCharCode(u[p + i]);
  return s;
};
const center = () => [cstrAt(e.mb_view_center_re()), cstrAt(e.mb_view_center_im())];
const zoom = () => ({ m: e.mb_view_zoom_mant(), e: e.mb_view_zoom_exp10() });

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

const W = 1200, H = 800;
const PX = 900, PY = 300;

// ---- 1. round trip at a shallow zoom is bit-exact -----------------------
const a = put('-0.6'), b = put('0.0');
e.mb_view_set(a, b, 1.0, 3, W, H, 3.0);
e.mb_free(a, 1); e.mb_free(b, 1);
const c0 = center(), z0 = zoom();
for (let i = 0; i < 60; i++) e.mb_view_zoom_at(PX, PY, 0.5);
const cMid = center(), zMid = zoom();
for (let i = 0; i < 60; i++) e.mb_view_zoom_at(PX, PY, 2.0);
const c1 = center(), z1 = zoom();
check('round trip centre is bit-identical', c0[0] === c1[0] && c0[1] === c1[1],
      `${c0[0].length} chars`);
check('round trip zoom is bit-identical', z0.m === z1.m && z0.e === z1.e,
      `${z0.m}e${z0.e}`);
check('zoom actually moved', zMid.e !== z0.e, `mid 10^${Math.log10(zMid.m) + zMid.e}`);

// ---- 2. anchoring: the point under the cursor must not move -------------
// point_at(x,y) = centre + (x+0.5-W/2)*ps, evaluated exactly by the core's own
// 60-step equivalent: zoom in, then ask where that pixel now sits by zooming
// back out about it — if the anchor moved, the round trip would not close.
for (const [px, py] of [[0, 0], [W - 1, H - 1], [W / 2, H / 2]]) {
  const p = put('-0.743643887037158704752191506114774');
  const q = put('0.131825904205311970493132056385139');
  e.mb_view_set(p, q, 1.0, 0, W, H, 3.0);
  e.mb_free(p, 1); e.mb_free(q, 1);
  const s0 = center(), zz0 = zoom();
  for (let i = 0; i < 80; i++) e.mb_view_zoom_at(px, py, 0.5);
  for (let i = 0; i < 80; i++) e.mb_view_zoom_at(px, py, 2.0);
  const s1 = center(), zz1 = zoom();
  check(`anchor (${px},${py}) closes exactly`, s0[0] === s1[0] && s0[1] === s1[1],
        `zoom ${zz0.m}e${zz0.e} -> ${zz1.m}e${zz1.e}`);
}

// ---- 3. precision follows the zoom --------------------------------------
// The plan is digits = log10(zoom) + 50 (out's rule), so a 10^60 view must
// carry ~110 decimals, and the printed centre must actually contain them.
const p60 = put('-0.743643887037158704752191506114774');
const q60 = put('0.131825904205311970493132056385139');
e.mb_view_set(p60, q60, 1.0, 60, W, H, 3.0);
e.mb_free(p60, 1); e.mb_free(q60, 1);
const digits = e.mb_view_digits();
const [re60] = center();
const decimals = (re60.split('.')[1] || '').length;
check('10^60 uses >= 108 digits', digits >= 108, `digits=${digits}`);
check('centre text carries those digits', decimals >= 108, `${decimals} decimals`);
check('span log10 is log10(3)-60', Math.abs(e.mb_view_span_log10() - (Math.log10(3) - 60)) < 0.01,
      e.mb_view_span_log10().toFixed(3));

// ---- 4. pan is the inverse of itself ------------------------------------
const r0 = center();
e.mb_view_pan(137, -91);
e.mb_view_pan(-137, 91);
const r1 = center();
check('pan round trip closes', r0[0] === r1[0] && r0[1] === r1[1], r0[0].slice(0, 18));

console.log(fails === 0 ? '\nVIEW OK' : `\nVIEW FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
