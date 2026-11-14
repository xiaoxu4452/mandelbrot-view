import { _internals } from '../js/render.js';
import { buildCustomEnvironment } from '../js/customenv.js';
import { compile } from '../js/mathlib.js';
import { paletteLUT } from '../js/palettes.js';
import { writePNG } from './png.mjs';

const expr = process.argv[2] || 'z^3 + c';
const cx = Number(process.argv[3] || 0);
const cy = Number(process.argv[4] || 0);
const exp = Number(process.argv[5] || -8);
const maxIter = Number(process.argv[6] || 500);
const W = 24, H = 18;

const dbl = compile(expr);
const OUT = new Float64Array(2), P = new Float64Array(8), S = { zpr: 0, zpi: 0 };
function esc(cr, ci, max) {
  let zr = 0, zi = 0;
  for (let n = 0; n < max; n++) {
    dbl.fn(zr, zi, cr, ci, P, n, S, OUT);
    S.zpr = zr; S.zpi = zi;
    zr = OUT[0]; zi = OUT[1];
    if (zr * zr + zi * zi > 1e6) return n;
  }
  return -1;
}
// 在网格里找「内部/外部」相邻的一对，然后二分到边界
const span0 = Number(process.argv[7] || 2.4);
const G = 61;
let pair = null;
const grid = [];
for (let j = 0; j < G; j++) {
  grid[j] = [];
  for (let i = 0; i < G; i++) {
    const cr = cx + (i / (G - 1) - 0.5) * span0;
    const ci = cy + (j / (G - 1) - 0.5) * span0;
    grid[j][i] = esc(cr, ci, maxIter) < 0;
  }
}
outer:
for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
  if (grid[j][i] !== grid[j][i + 1]) {
    pair = [[cx + (i / (G - 1) - 0.5) * span0, cy + (j / (G - 1) - 0.5) * span0],
            [cx + ((i + 1) / (G - 1) - 0.5) * span0, cy + (j / (G - 1) - 0.5) * span0]];
    break outer;
  }
}
if (!pair) { console.log('no boundary found'); process.exit(0); }
let [a, b] = pair;
for (let k = 0; k < 50; k++) {
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (esc(m[0], m[1], maxIter) < 0) { if (esc(a[0], a[1], maxIter) < 0) a = m; else b = m; }
  else { if (esc(a[0], a[1], maxIter) < 0) b = m; else a = m; }
}
const px0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
console.log('boundary', px0[0].toFixed(15), px0[1].toFixed(15), 'escape', esc(px0[0], px0[1], maxIter * 4));

const c0 = { re: px0[0].toFixed(17), im: px0[1].toFixed(17) };
const v = Math.pow(10, exp), e = Math.floor(Math.log2(v));
const span = { m: v / Math.pow(2, e), e };
let pm = span.m / W, pe = e;
while (Math.abs(pm) >= 2) { pm /= 2; pe++; }
while (Math.abs(pm) < 1) { pm *= 2; pe--; }
const ps = pm * Math.pow(2, pe);
const bits = 200;

const t0 = performance.now();
const env = buildCustomEnvironment({ customExpr: expr, customParams: {} }, c0, bits, maxIter);
const t1 = performance.now();
env.refPx = W / 2; env.refPy = H / 2;
const base = {
  viewId: 'cc', x: 0, y: 0, w: W, h: H, width: W, height: H,
  spec: { mode: 'x', kind: 'mandelbrot', power: 2, customExpr: expr, customParams: {} },
  center: c0, span, pixelSize: ps, psMant: pm, psExp: pe, psLog2: Math.log2(pm) + pe,
  bits, maxIter, palette: 'ice', cycle: 8, offset: 0, customEnv: env
};
const lut = paletteLUT('ice');
const pert = _internals.renderCustomPerturb(base, lut);
const t2 = performance.now();
const dir = _internals.renderCustomHpDirect(base, bits, lut);
const t3 = performance.now();
let diff = 0, maxd = 0, bad = 0, nonint = 0;
for (let i = 0; i < W * H; i++) {
  const d = Math.abs(pert.data[i * 4] - dir.data[i * 4]) + Math.abs(pert.data[i * 4 + 1] - dir.data[i * 4 + 1]) + Math.abs(pert.data[i * 4 + 2] - dir.data[i * 4 + 2]);
  diff += d; if (d > maxd) maxd = d; if (d > 16) bad++;
  if (pert.data[i * 4] !== 5 || pert.data[i * 4 + 1] !== 6) nonint++;
}
console.log('env', (t1 - t0).toFixed(0) + 'ms len', env.len,
  '| perturb', (t2 - t1).toFixed(0) + 'ms glitch', pert.glitches,
  '| hp-direct', (t3 - t2).toFixed(0) + 'ms');
console.log('meandiff', (diff / (W * H)).toFixed(2), 'max', maxd, 'bad', bad, '/', W * H, 'nonInterior', (nonint / (W * H) * 100).toFixed(0) + '%');
writePNG('tools/cc_pert.png', pert.data, W, H);
writePNG('tools/cc_dir.png', dir.data, W, H);
