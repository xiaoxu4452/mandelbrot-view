import { makeBigContext, compileBig } from '../js/hpeval.js';
import { compile as compileDouble } from '../js/mathlib.js';

const K = makeBigContext(200);
const ctx = K.ctx;
const N = (v) => ctx.toNumber(v);
let fails = 0;
const near = (a, b, tol, label) => {
  const d = Math.abs(a - b);
  if (!(d <= tol)) { console.log('FAIL', label, a, b, 'd=' + d.toExponential(2)); fails++; }
};

// 1) atan
for (const x of [-100, -3, -1, -0.5, 0, 1e-9, 0.5, 1, 3, 100]) {
  near(N(K.atanReal(ctx.fromNumber(x))), Math.atan(x), 1e-14, 'atan ' + x);
}
// 2) atan2
for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1], [0, -1], [0, 1], [1, 0], [-1, 0], [0.3, -0.7]]) {
  near(N(K.atan2(ctx.fromNumber(y), ctx.fromNumber(x))), Math.atan2(y, x), 1e-14, `atan2 ${y},${x}`);
}
// 3) ln 全量程
for (const x of [1e-9, 1e-6, 0.1, 0.9, 1, 2, 3.7, 100, 1e6, 1e12]) {
  near(N(K.lnReal(ctx.fromNumber(x))), Math.log(x), 1e-13, 'ln ' + x);
}
// 4) exp
for (const x of [-20, -3, -0.5, 0, 0.5, 3, 20, 60]) {
  near(N(K.expReal(ctx.fromNumber(x))) / Math.exp(x), 1, 1e-15, 'exp ' + x);
}
// 5) 三角
for (const x of [-7, -3, -1.6, 0, 3, 7, 50]) {
  const [s, c] = K.sinCosReal(ctx.fromNumber(x));
  near(N(s), Math.sin(x), 1e-14, 'sin ' + x);
  near(N(c), Math.cos(x), 1e-14, 'cos ' + x);
}
// 6) 恒等式（高精度）
const zr = ctx.fromString('-0.743643887037158704752191506114774');
const zi = ctx.fromString('0.131825904205311970493132056385139');
const z = [zr, zi];
const z2 = K.cMul(z, z);
const r2 = K.cSqrt(z2);
// 主值可能取 -z，比较模长与 |sqrt| = |z|
near(Math.hypot(N(r2[0]), N(r2[1])), Math.hypot(N(zr), N(zi)), 1e-17, 'sqrt(z^2) modulus');
near(Math.hypot(N(K.cMul(r2, r2)[0]), N(K.cMul(r2, r2)[1])), Math.hypot(N(z2[0]), N(z2[1])), 1e-16, 'sqrt squared');
const ez = K.cExp(z), lz = K.cLog(ez);
near(N(lz[0]), N(zr), 1e-15, 'log(exp z).re'); near(N(lz[1]), N(zi), 1e-15, 'log(exp z).im');
const [s1, c1] = K.sinCosReal(zr);
const id = K.mul(s1, s1) + K.mul(c1, c1);
near(N(id), 1, 1e-17, 'sin^2+cos^2');
const p = K.cPow(z, [ctx.fromNumber(3), 0n]);
const p3 = K.cMul(K.cMul(z, z), z);
near(N(p[0]), N(p3[0]), 1e-17, 'pow3.re'); near(N(p[1]), N(p3[1]), 1e-17, 'pow3.im');

// 7) 与双精度表达式逐项对照
const cases = ['z^2 + c', 'sin(z) + c', 'exp(z) + c', 'z^3 + c', 'conj(z)^2 + c',
  'abs(z)^2 + c', 'z - (z^3 - 1)/(3*z^2)', 'sum(k,0,2,z^3/3^k) + c',
  'piecewise(abs(z) < 1, z^2 + c, z/2 + c)', 'sqrt(z) + c', 'tan(z/4) + c',
  'cosh(z) + c', 'z^2 + c + 0.5667*z_1'];
for (const src of cases) {
  try {
    const d = compileDouble(src);
    const OUT = new Float64Array(2), P = new Float64Array(8), S = { zpr: 0.1, zpi: -0.2 };
    d.fn(0.31, -0.24, -0.52, 0.18, P, 0, S, OUT);
    const big = compileBig(d.ast, { bits: 200, ctx: K, params: d.params });
    const got = big({
      z: [ctx.fromNumber(0.31), ctx.fromNumber(-0.24)],
      c: [ctx.fromNumber(-0.52), ctx.fromNumber(0.18)],
      n: 0, zp: [ctx.fromNumber(0.1), ctx.fromNumber(-0.2)], P: []
    });
    near(N(got[0]), OUT[0], 1e-12, src + ' .re');
    near(N(got[1]), OUT[1], 1e-12, src + ' .im');
  } catch (e) { console.log('ERR', src, e.message); fails++; }
}
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
