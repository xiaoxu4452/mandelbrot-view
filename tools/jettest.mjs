import { compileJet } from '../js/jet.js';
import { compile } from '../js/mathlib.js';

const K = 6;
// 已知限制：非全纯（abs/conj）与 z_1 的级数不是解析函数，只保证一阶项
const KNOWN_APPROX = new Set(['abs(z)^2 + c', 'conj(z)^2 + c', 'z^2 + c + 0.5*z_1']);
const cases = ['z^2 + c', 'z^3 + c', 'z^4 + c', 'sin(z) + c', 'exp(z) + c',
  'abs(z)^2 + c', 'conj(z)^2 + c', 'z^2 + c + 0.5*z_1', 'sqrt(z) + c', 'cos(z/2) + c'];
const zr = 0.31, zi = -0.24, cr = -0.52, ci = 0.18;
const P = new Float64Array(8);
const S = { zpr: 0.1, zpi: -0.2 };
let fails = 0;

for (const src of cases) {
  const dbl = compile(src);
  const d2 = compile(src);
  const { fn } = compileJet(dbl.ast, { order: K, params: dbl.params });
  const jet = fn({ zr, zi, cr, ci, n: 0, zpr: S.zpr, zpi: S.zpi, P, loopVal: 0 });

  // 用多项式预测 F(Z + t, c0 + d)，与直接计算比较
  for (const [tr, ti, dr, di] of [[1e-3, -5e-4, 0, 0], [0, 0, 1e-3, 2e-4], [2e-2, 1e-2, -3e-3, 1e-3]]) {
    let pr = 0, pi = 0;
    // Horner
    for (let k = K; k >= 0; k--) {
      const nr = pr * tr - pi * ti + jet.r[k];
      const ni = pr * ti + pi * tr + jet.i[k];
      pr = nr; pi = ni;
    }
    // δ 部分
    let qr = 0, qi = 0;
    for (let k = K; k >= 0; k--) {
      const nr = qr * tr - qi * ti + jet.dr[k];
      const ni = qr * ti + qi * tr + jet.di[k];
      qr = nr; qi = ni;
    }
    pr += qr * dr - qi * di;
    pi += qr * di + qi * dr;

    const OUT = new Float64Array(2);
    d2.fn(zr + tr, zi + ti, cr + dr, ci + di, P, 0, { zpr: S.zpr + tr, zpi: S.zpi + ti }, OUT);
    const err = Math.hypot(OUT[0] - pr, OUT[1] - pi);
    const scale = Math.hypot(OUT[0], OUT[1]) + 1e-30;
    const tol = KNOWN_APPROX.has(src) ? 5e-2 : 1e-9;
    if (err > tol * Math.max(1, scale)) {
      console.log('FAIL', src, 'err', err.toExponential(2), 'rel', (err / scale).toExponential(2));
      fails++;
      break;
    }
  }
}
console.log(fails === 0 ? 'JET ALL PASS' : fails + ' FAILURES');
