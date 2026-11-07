import { compile } from '../js/mathlib.js';
const FORMULAS = [
  ['正弦映射', 'sin(z) + c', { a: 0, b: 0, k: 0 }],
  ['指数映射', 'exp(z) + c', { a: 0, b: 0, k: 0 }],
  ['四次多枝', 'z^4 + c', { a: 0, b: 0, k: 0 }],
  ['凤凰式', 'z^2 + c + 0.5*z_1', { a: 0, b: 0, k: 0 }],
  ['幂级数', 'sum(k, 0, 3, z^3/3^k) + c', { a: 0, b: 0, k: 0 }],

  ['迭代复合', 'f(z) = z^2 + c\nf(f(z))/2 + c', { a: 0, b: 0, k: 0 }],
  ['三次扰动', 'z^3 + c + a*z', { a: 0.3, b: 0, k: 0 }],
  ['共轭立方', 'conj(z)^3 + c', { a: 0, b: 0, k: 0 }]
];
const OUT = new Float64Array(2), S = { zpr: 0, zpi: 0 };
function score(fn, P, cx, cy, span, maxIter) {
  const GX = 13, GY = 9; const vals = []; let inside = 0;
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const cr = cx + (i / (GX - 1) - 0.5) * span;
    const ci = cy + (j / (GY - 1) - 0.5) * span * 0.72;
    let zr = 0, zi = 0, n = 0, out = false;
    S.zpr = 0; S.zpi = 0;
    for (; n < maxIter; n++) {
      fn(zr, zi, cr, ci, P, n, S, OUT);
      S.zpr = zr; S.zpi = zi;
      zr = OUT[0]; zi = OUT[1];
      const m2 = zr * zr + zi * zi;
      if (!isFinite(m2)) { out = true; break; }
      if (m2 > 1e6) { out = true; break; }
    }
    if (!out) { inside++; vals.push(maxIter); } else vals.push(n);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  let v = 0; for (const x of vals) v += (x - mean) ** 2;
  const sd = Math.sqrt(v / vals.length), inf = inside / vals.length;
  let sc = sd;
  if (inf < 0.08 || inf > 0.92) sc *= 0.3;
  return { sc, sd, inf };
}
for (const [zh, expr, params] of FORMULAS) {
  const { fn } = compile(expr);
  const P = new Float64Array(8);
  P[0] = params.a; P[1] = params.b; P[2] = params.k;
  let best = null;
  for (const span of [4, 2.6, 1.6, 6]) {
    for (let gy = -3; gy <= 3; gy++) for (let gx = -3; gx <= 3; gx++) {
      const cx = gx * span * 0.30, cy = gy * span * 0.22;
      const r = score(fn, P, cx, cy, span, 400);
      if (!best || r.sc > best.sc) best = { ...r, cx, cy, span };
    }
  }
  console.log(zh.padEnd(6), 'score', best.sc.toFixed(1), 'sd', best.sd.toFixed(1),
    'inside', (best.inf * 100).toFixed(0) + '%',
    'cx', best.cx.toFixed(4), 'cy', best.cy.toFixed(4), 'spanExp', Math.log10(best.span).toFixed(3));
}
