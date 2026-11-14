import { makeBigContext, compileBig } from '../js/hpeval.js';
import { compile as compileDouble } from '../js/mathlib.js';

const src = process.argv[2] || 'z^2 + c';
const N = Number(process.argv[3] || 2000);
const cx = '-0.743643887037158704752191506114774';
const cy = '0.131825904205311970493132056385139';

function iterate(bits) {
  const K = makeBigContext(bits);
  const ctx = K.ctx;
  const d = compileDouble(src);
  const big = compileBig(d.ast, { bits, ctx: K, params: d.params });
  const st = {
    z: [0n, 0n],
    c: [ctx.fromString(cx), ctx.fromString(cy)],
    n: 0, zp: [0n, 0n], P: []
  };
  const t0 = performance.now();
  let esc = -1;
  for (let n = 0; n < N; n++) {
    st.n = n;
    st.zp = st.z;
    st.z = big(st);
    const m2 = K.cAbs2(st.z);
    if (m2 > ctx.fromNumber(1e20)) { esc = n; break; }
  }
  const ms = performance.now() - t0;
  return { re: st.z[0], im: st.z[1], ctx, esc, ms, bits };
}
const results = [128, 256, 512].map(iterate);
for (const r of results) {
  console.log(`${r.bits} bit: escaped=${r.esc} ${r.ms.toFixed(0)}ms ${(N / r.ms * 1000).toFixed(0)} iter/s  re=${r.ctx.toString(r.re, 40)}`);
}
// 位数一致性：逐位比较十进制展开
function commonDigits(a, ctxA, b, ctxB, max = 120) {
  const sa = ctxA.toString(a, max);
  const sb = ctxB.toString(b, max);
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return i;
}
const [r128, r256, r512] = results;
const d256 = commonDigits(r512.re, r512.ctx, r256.re, r256.ctx);
const d128 = commonDigits(r512.re, r512.ctx, r128.re, r128.ctx);
console.log('512 vs 256 相同十进制位数:', d256, '（约', (d256 * 3.32).toFixed(0), 'bit）');
console.log('512 vs 128 相同十进制位数:', d128, '（约', (d128 * 3.32).toFixed(0), 'bit）');

// 与双精度对比
const dd = compileDouble(src);
const OUT = new Float64Array(2), P = new Float64Array(8), S = { zpr: 0, zpi: 0 };
let zr = 0, zi = 0;
for (let n = 0; n < N; n++) { dd.fn(zr, zi, parseFloat(cx), parseFloat(cy), P, n, S, OUT); S.zpr = zr; S.zpi = zi; zr = OUT[0]; zi = OUT[1]; }
console.log('double: re=' + zr.toExponential(6) + ' im=' + zi.toExponential(6),
  ' hp512: re=' + r512.ctx.toNumber(r512.re).toExponential(6) + ' im=' + r512.ctx.toNumber(r512.im).toExponential(6));
