/* A/B: old core.wasm (interior default) vs rebuilt core.wasm (Julia root fix).
 * A Julia view whose reference escapes early used to paint every pixel as
 * interior -> a black frame.  The fix continues those pixels in double. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/* Needs an OLD core.wasm to compare against:
 *   git show <pre-fix-commit>:core.wasm > .tmp/old-core.wasm
 * The committed version is the fixed one; without the old binary this tool
 * still reports the reference lengths and interior fractions of the new core. */

const TOOLDIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(TOOLDIR, '..');
const enc = new TextEncoder();

function inst(file) {
  const mod = new WebAssembly.Module(fs.readFileSync(file));
  let e = null;
  const dv = () => new DataView(e.memory.buffer);
  const stub = (name) => (...a) => {
    if (name === 'environ_sizes_get' || name === 'args_sizes_get') {
      const d = dv(); if (a[0]) d.setUint32(a[0], 0, true);
      if (a[1]) d.setUint32(a[1], 0, true); return 0;
    }
    if (name === 'clock_time_get') {
      const d = dv(); if (a[2]) d.setBigUint64(a[2], BigInt(Date.now() * 1000000), true); return 0;
    }
    if (name === 'fd_write') { const d = dv(); if (a[3]) d.setUint32(a[3], 0, true); return 0; }
    return 0;
  };
  const imports = {};
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] ||= {};
    imports[im.module][im.name] = im.kind === 'function' ? stub(im.name) : 0;
  }
  e = new WebAssembly.Instance(mod, imports).exports;
  const ws = (s) => {
    const b = enc.encode(String(s) + '\0');
    const p = e.mb_alloc(b.length);
    new Uint8Array(e.memory.buffer).set(b, p);
    return p;
  };
  return { e, ws };
}

const OLD_FILE = path.join(ROOT, '.tmp', 'old-core.wasm');
const OLD = fs.existsSync(OLD_FILE) ? inst(OLD_FILE) : null;
const NEW = inst(path.join(ROOT, 'core.wasm'));

function render(H, v) {
  const { e, ws } = H;
  const a = ws(v.cre), b = ws(v.cim), jr = ws(v.jr), ji = ws(v.ji), pal = ws('');
  const rc = e.mb_render(a, b, 1, v.exp10, v.w, v.h, v.maxiter,
    1, jr, ji, pal, 0, 0, 16, 1, 1, 0, 1, 1, 0, 0);
  if (rc) return { rc, err: 'mb_render rc ' + rc };
  const n = v.w * v.h;
  const f = new Float32Array(e.memory.buffer, e.mb_out_ptr(), n * 4);
  let inside = 0, esc = 0;
  const levels = new Set();
  for (let i = 0; i < n; ++i) {
    const sv = f[i * 4];
    if (!(sv >= 0)) ++inside;
    else { ++esc; levels.add(Math.round(sv)); }
  }
  const d = new DataView(e.memory.buffer, e.mb_stats_ptr());
  return { inside, esc, levels: levels.size,
           refLen: d.getInt32(40, true), glitches: Number(d.getBigInt64(16, true)),
           maxEsc: d.getInt32(72, true), minEsc: d.getInt32(76, true),
           insidePct: +(100 * inside / n).toFixed(1) };
}

const W = 120, H = 80, MAX = 2000;
const cases = [
  { name: 'c=-0.8+0.156i z0=1+0.5i 1e14', cre: '1', cim: '0.5', jr: '-0.8', ji: '0.156', exp10: 14 },
  { name: 'c=-0.8+0.156i z0=1+0.5i 1e20', cre: '1', cim: '0.5', jr: '-0.8', ji: '0.156', exp10: 20 },
  { name: 'c=i z0=1.2+0.3i 1e14', cre: '1.2', cim: '0.3', jr: '0', ji: '1', exp10: 14 },
  { name: 'c=0.285+0.01i z0=1.1+0i 1e14', cre: '1.1', cim: '0', jr: '0.285', ji: '0.01', exp10: 14 },
  { name: 'c=-0.4+0.6i z0=0.9+0.7i 1e14', cre: '0.9', cim: '0.7', jr: '-0.4', ji: '0.6', exp10: 14 },
  { name: 'c=-0.8+0.156i z0=0 (interior) 1e14', cre: '0', cim: '0', jr: '-0.8', ji: '0.156', exp10: 14 },
  /* Boundary point obtained by inverse iteration of z <- sqrt(z - c): the
   * reference orbit lives for hundreds of steps, which is exactly the
   * 10^13.6 / 'reference orbit 801' regime from the bug report. */
  { name: 'boundary julia 1e10', cre: '-1.04065302322617881', cim: '0.25659761207121512', jr: '-0.3701564403598011', ji: '0.6632768211493827', exp10: 10 },
  { name: 'boundary julia 1e14', cre: '-1.04065302322617881', cim: '0.25659761207121512', jr: '-0.3701564403598011', ji: '0.6632768211493827', exp10: 14 },
  { name: 'boundary julia 1e20', cre: '-1.04065302322617881', cim: '0.25659761207121512', jr: '-0.3701564403598011', ji: '0.6632768211493827', exp10: 20 },
  { name: 'boundary julia 1e30', cre: '-1.04065302322617881', cim: '0.25659761207121512', jr: '-0.3701564403598011', ji: '0.6632768211493827', exp10: 30 },
];

let wins = 0, checks = 0;
for (const c of cases) {
  const v = { ...c, w: W, h: H, maxiter: MAX };
  const n = render(NEW, v);
  const o = OLD ? render(OLD, v) : n;
  const wasBlack = o.insidePct > 98;
  const fixed = n.insidePct < 98 && n.esc > 0;
  if (wasBlack) {
    ++checks;
    if (fixed) ++wins;
    console.log(`${fixed ? 'FIXED' : 'STILL BLACK'} ${c.name}\n` +
      `   old: interior ${o.insidePct}% esc ${o.esc} levels ${o.levels}\n` +
      `   new: interior ${n.insidePct}% esc ${n.esc} levels ${n.levels}`);
  } else {
    console.log(`(not a black case) ${c.name}  refLen ${o.refLen}/${MAX} glitches ${o.glitches} esc ${o.minEsc}..${o.maxEsc} | old interior ${o.insidePct}% / new ${n.insidePct}%`);
  }
}
console.log(`\n[julia-fix] ${wins}/${checks} early-reference black frames repaired`);
if (checks === 0) console.log('[julia-fix] no black case found (probe views did not trigger it)');
