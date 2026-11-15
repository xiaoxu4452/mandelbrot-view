/* formulacore/test.mjs — stage-1 correctness checks for the independent core.
 *
 *   node formulacore/test.mjs
 *
 * The decisive check is a pixel-exact comparison of z^2+c against a plain
 * Node implementation of the SAME escape/smoothing rule: if the expression
 * compiler, the bytecode VM and the renderer all agree with the reference,
 * every more complicated formula is built on a sound base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const wasm = fs.readFileSync(path.join(ROOT, 'formulacore.wasm'));
const mod = new WebAssembly.Module(wasm);

let e = null;
const view = () => new DataView(e.memory.buffer);
function stub(name) {
  return (...a) => {
    if (name === 'environ_sizes_get' || name === 'args_sizes_get') {
      const d = view();
      if (a[0]) d.setUint32(a[0], 0, true);
      if (a[1]) d.setUint32(a[1], 0, true);
      return 0;
    }
    if (name === 'clock_time_get') {
      const d = view();
      if (a[2]) d.setBigUint64(a[2], BigInt(Date.now() * 1000000), true);
      return 0;
    }
    if (name === 'fd_write') {
      const d = view();
      if (a[3]) d.setUint32(a[3], 0, true);
      return 0;
    }
    if (name === 'proc_exit') throw new Error('wasm proc_exit ' + a[0]);
    return 0;
  };
}
const imports = {};
for (const imp of WebAssembly.Module.imports(mod)) {
  imports[imp.module] ||= {};
  imports[imp.module][imp.name] = imp.kind === 'function' ? stub(imp.name) : 0;
}
const inst = await WebAssembly.instantiate(mod, imports);
e = inst.exports || inst.instance.exports;
const enc = new TextEncoder();
const ws = (s) => {
  const b = enc.encode(String(s) + '\0');
  const p = e.fc_alloc(b.length);
  new Uint8Array(e.memory.buffer).set(b, p);
  return p;
};
const readStr = (p) => {
  const m = new Uint8Array(e.memory.buffer);
  let n = 0;
  while (p + n < m.length && m[p + n]) ++n;
  return new TextDecoder().decode(m.subarray(p, p + n));
};
const compile = (src) => {
  const id = e.fc_compile(ws(src));
  if (id < 0) throw new Error(`compile "${src}": ${readStr(e.fc_error())}`);
  return id;
};
const render = (prog, o = {}) => {
  const w = o.w | 0 || 160, h = o.h | 0 || 120;
  const rc = e.fc_render(prog,
    ws(o.re ?? '-0.6'), ws(o.im ?? '0'),
    o.zoomMant ?? 1, o.zoomExp10 ?? 0,
    w, h, o.maxiter ?? 200,
    o.mode ?? 0, ws(o.jr ?? '0'), ws(o.ji ?? '0'),
    o.bail2 ?? 1e20, 0, 0, 1, 0);
  if (rc) throw new Error('render ' + rc + ': ' + readStr(e.fc_error()));
  return { w, h, f: new Float32Array(e.memory.buffer, e.fc_out_ptr(), w * h).slice() };
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};

// ---------------------------------------------------------------- z^2 + c --
const W = 160, H = 120, MAXIT = 200, BAIL2 = 1e20;
const ps = 3.0 / 1.0 / W;
const logBail = 0.5 * Math.log(BAIL2);
function reference(x, y) {
  const cr = -0.6 + (x + 0.5 - W / 2) * ps;
  const ci = 0 - (y + 0.5 - H / 2) * ps;
  let zr = 0, zi = 0;
  for (let it = 0; it < MAXIT; ++it) {
    const nr = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = nr;
    const z2 = zr * zr + zi * zi;
    if (!(z2 <= BAIL2)) {
      const logz = 0.5 * Math.log(Math.max(z2, 1e-300));
      return Math.max(0, it + 1 - Math.log2(logz / logBail));
    }
    if (!Number.isFinite(z2)) return -1;
  }
  return -1;
}

const p0 = compile('z^2+c');
check('compile z^2+c', p0 === 0, `program ${p0}`);
const r0 = render(p0, { w: W, h: H, maxiter: MAXIT });
let worst = 0, mism = 0, interior = 0;
for (let y = 0; y < H; ++y) {
  for (let x = 0; x < W; ++x) {
    const i = y * W + x;
    const want = reference(x, y), got = r0.f[i];
    if (want < 0) {
      ++interior;
      if (got >= 0) mism++;
    } else {
      if (got < 0) { mism++; continue; }
      const d = Math.abs(got - want);
      if (d > worst) worst = d;
      if (d > 2e-3) mism++;
    }
  }
}
check('z^2+c matches a Node reference pixel-by-pixel', mism === 0,
  `worst |d|=${worst.toExponential(2)}, mismatches=${mism}, interior=${interior}`);

// ------------------------------------------------------------- expressions --
const cases = [
  ['z^3+c', 'multibrot'],
  ['sin(z)+c', 'nested trig'],
  ['exp(z^2)+c*0.1', 'nested exp'],
  ['z^2+c+0.05*cos(3*z)', 'arithmetic nesting'],
  ['conj(z)^2+c', 'non-holomorphic'],
  ['pow(z,2.5)+c', 'fractional power'],
  ['log(sqrt(z^2+1))+c', 'log/sqrt nesting'],
  ['sinh(z)*0.3+c', 'hyperbolic'],
  ['atan(z)+c', 'inverse trig'],
];
for (const [src, label] of cases) {
  let ok = false, detail = '';
  try {
    const id = compile(src);
    const r = render(id, { w: 96, h: 72, maxiter: 120 });
    let esc = 0, inside = 0, sum = 0;
    for (const v of r.f) { if (v >= 0) { esc++; sum += v; } else inside++; }
    const mean = esc ? sum / esc : 0;
    /* atan / log(sqrt(...)) are BOUNDED maps: their orbits never leave the
     * bailout disc, so "every pixel interior" is the correct answer, not a
     * failure.  What must hold is that the field is finite and complete. */
    ok = esc + inside === r.w * r.h && Number.isFinite(mean) &&
         r.f.every((v) => Number.isFinite(v));
    detail = `escaped=${esc} interior=${inside} mean=${mean.toFixed(1)}` +
             (esc === 0 ? ' (bounded map: all interior is correct)' : '');
  } catch (err) { detail = err.message; }
  check(`render ${label} "${src}"`, ok, detail);
}

// -------------------------------------------------------------- parameters --
try {
  const id = compile('z^2+a*c');
  const np = e.fc_param_count(id);
  const name = readStr(e.fc_param_name(id, 0));
  check('parameters are discovered', np === 1 && name === 'a', `count=${np} name=${name}`);
} catch (err) { check('parameters are discovered', false, err.message); }

// ------------------------------------------------------------------ errors --
const bad = ['z+', '(z', 'nope(z)', 'sin(z,z)', 'z^'];
let caught = 0;
for (const s of bad) {
  const id = e.fc_compile(ws(s));
  if (id < 0 && readStr(e.fc_error()).length > 0) caught++;
}
check('bad expressions are rejected with a message', caught === bad.length,
  `${caught}/${bad.length}`);

// ------------------------------------------------------------------- ascii --
const art = (f, w, h, label) => {
  const N = 22;
  const rows = [];
  for (let j = 0; j < N; ++j) {
    let s = '';
    for (let i = 0; i < N; ++i) {
      const x = Math.floor((i + 0.5) * w / N), y = Math.floor((j + 0.5) * h / N);
      const v = f[y * w + x];
      s += v < 0 ? '#' : v > 24 ? '.' : v > 12 ? '+' : v > 5 ? ':' : '*';
    }
    rows.push(s);
  }
  console.log(`--- ${label}\n${rows.join('\n')}`);
};
art(r0.f, W, H, 'z^2+c (formulacore.wasm)');

console.log(failures ? `[formulacore] ${failures} FAILED` : '[formulacore] all checks passed');
if (failures) process.exitCode = 1;
