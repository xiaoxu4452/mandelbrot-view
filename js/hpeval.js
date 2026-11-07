/* ------------------------------------------------------------------
 * hpeval.js — 高精度（BigInt 定点）复数表达式求值器
 *
 * 用途：自定义公式在深度放大时，双精度已经完全无法表示坐标
 *      （10^-16 以下就开始量化），因此参考轨道必须在高精度下迭代。
 *      每个像素仍然用双精度扰动递推，只有「一条参考轨道」需要高精度。
 *
 * 支持：+ - * / 整数次幂、sin cos tan sinh cosh tanh exp log sqrt
 *      abs abs2 norm arg conj re im、Σ Π、piecewise、比较、参数
 *
 * 实数超越函数用定点级数实现（参数归约 + 泰勒展开），
 * 复数按标准恒等式组合。arg / atan2 走双精度（仅影响 log 的相位）。
 * ----------------------------------------------------------------*/

import { contextFor } from './bigfixed.js';

/* ---------------- 常量 ---------------- */

const PI_STR = '3.14159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798';
const LN2_STR = '0.693147180559945309417232121458176568075500134360255254120680009493393621969694715605863326996418687';

/* ---------------- 编译期上下文 ---------------- */

export function makeBigContext(bits) {
  const ctx = contextFor(bits);
  const FB = ctx.FB, HALF = ctx.HALF, ONE = ctx.ONE;
  const mul = (a, b) => { const p = a * b; return p >= 0n ? (p + HALF) >> FB : -((-p + HALF) >> FB); };
  const div = (a, b) => {
    if (b === 0n) return 0n;
    const q = (a << FB) / b;
    return q;
  };
  const PI = ctx.fromString(PI_STR);
  const TWO_PI = PI << 1n;
  const HALF_PI = PI >> 1n;
  const LN2 = ctx.fromString(LN2_STR);
  const EPS = 1n;                       // 最小可表示单位

  function fromInt(k) { return BigInt(k) << FB; }

  /* ---- 实数函数 ---- */

  function sqrt(a) {
    if (a <= 0n) return 0n;
    // 双精度初值
    const approx = Math.sqrt(ctx.toNumber(a));
    let x = ctx.fromNumber(approx > 0 ? approx : 1);
    if (x <= 0n) x = ONE;
    for (let i = 0; i < 6; i++) {
      const q = div(a, x);
      x = (x + q) >> 1n;
      if (x <= 0n) break;
    }
    return x;
  }

  function expReal(a) {
    // 范围保护
    const lim = fromInt(700);
    if (a > lim) return ctx.MAXV();
    if (a < -lim) return 0n;
    // k = round(a / ln2)
    const k = Number((a * 2n + LN2) / (LN2 << 1n));
    let r = a - BigInt(k) * LN2;
    // e^r 泰勒
    let sum = ONE, term = ONE;
    for (let i = 1; i < 64; i++) {
      term = mul(term, r) / BigInt(i);
      if (term === 0n) break;
      sum += term;
      if (term < 0n ? -term < EPS : term < EPS) break;
    }
    return k >= 0 ? (sum << BigInt(k)) : (sum >> BigInt(-k));
  }

  function sinCosReal(a) {
    // 归约到 [-π, π]：k = round((a + π) / 2π)
    let r = a;
    if (r > PI || r < -PI) {
      let k = (r + PI) / TWO_PI;                 // BigInt 除法（截断）
      if ((r + PI) - k * TWO_PI > PI) k += 1n;   // 四舍五入
      r = r - k * TWO_PI;
      if (r > PI) r -= TWO_PI;
      if (r < -PI) r += TWO_PI;
    }
    // 归约到 [-π/2, π/2]：
    //   r ∈ (π/2, π]  ->  sin = sin(π-r),  cos = -cos(π-r)
    //   r ∈ [-π,-π/2) ->  sin = sin(-π-r), cos = -cos(-π-r)
    let cosSign = 1n;
    if (r > HALF_PI) { r = PI - r; cosSign = -1n; }
    else if (r < -HALF_PI) { r = -PI - r; cosSign = -1n; }

    const s2 = mul(r, r);
    // sin 泰勒
    let s = r, term = r;
    for (let i = 1; i < 80; i++) {
      term = -mul(term, s2) / BigInt((2 * i) * (2 * i + 1));
      if (term === 0n) break;
      s += term;
      if ((term < 0n ? -term : term) < EPS) break;
    }
    // cos 泰勒
    let c = ONE, ct = ONE;
    for (let i = 1; i < 80; i++) {
      ct = -mul(ct, s2) / BigInt((2 * i - 1) * (2 * i));
      if (ct === 0n) break;
      c += ct;
      if ((ct < 0n ? -ct : ct) < EPS) break;
    }
    return [s, cosSign < 0n ? -c : c];
  }

  function lnReal(a) {
    if (a <= 0n) return -ctx.MAXV();
    // 归一化到 [1,2)
    let v = a, e = 0;
    while (v >= (2n << FB)) { v >>= 1n; e++; }
    while (v < ONE) { v <<= 1n; e--; }
    // ln(v) = 2 atanh((v-1)/(v+1))
    const num = v - ONE, den = v + ONE;
    const t = div(num, den);
    const t2 = mul(t, t);
    let term = t, sum = t;
    for (let i = 3; i < 200; i += 2) {
      term = mul(term, t2);
      const add = term / BigInt(i);
      if (add === 0n) break;
      sum += add;
      if ((add < 0n ? -add : add) < EPS) break;
    }
    return (BigInt(e) << FB) * LN2 / ONE + (sum << 1n);
  }

  /** 定点 atan（半角归约两次 + 泰勒） */
  function atanReal(x) {
    if (x === 0n) return 0n;
    const neg = x < 0n;
    let a = neg ? -x : x;
    let big = false;
    if (a > ONE) { a = div(ONE, a); big = true; }
    // atan(a) = 2 atan(a / (1 + sqrt(1 + a^2)))，两次把 |a| 压到 ~0.2
    a = div(a, ONE + sqrt(ONE + mul(a, a)));
    a = div(a, ONE + sqrt(ONE + mul(a, a)));
    const a2 = mul(a, a);
    let term = a, sum = a;
    for (let k = 1; k < 300; k++) {
      term = -mul(term, a2);
      const add = term / BigInt(2 * k + 1);
      if (add === 0n) break;
      sum += add;
      if ((add < 0n ? -add : add) < EPS) break;
    }
    sum <<= 2n;                    // 两次归约 => ×4
    if (big) sum = HALF_PI - sum;
    return neg ? -sum : sum;
  }

  /** 定点 atan2 */
  function atan2(y, x) {
    if (x === 0n && y === 0n) return 0n;
    if (x > 0n) return atanReal(div(y, x));
    if (x < 0n) {
      const base = x === 0n ? 0n : atanReal(div(y, x));
      // atan(y/x) 在第三/四象限，需要 ±π 修正
      return y >= 0n ? base + PI : base - PI;
    }
    return y > 0n ? HALF_PI : -HALF_PI;
  }

  /** 定点 sinh / cosh */
  function sinhCosh(x) {
    const e = expReal(x), ei = expReal(-x);
    return [(e - ei) >> 1n, (e + ei) >> 1n];
  }

  /* ---- 复数辅助 ---- */
  const ZERO = [0n, 0n];
  const ONE_C = [ONE, 0n];

  function cMul(a, b) {
    return [mul(a[0], b[0]) - mul(a[1], b[1]), mul(a[0], b[1]) + mul(a[1], b[0])];
  }
  function cAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function cSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function cAbs2(a) { return mul(a[0], a[0]) + mul(a[1], a[1]); }
  function cAbs(a) { return sqrt(cAbs2(a)); }

  function cDiv(a, b) {
    const d = cAbs2(b);
    if (d === 0n) return [0n, 0n];
    return [div(mul(a[0], b[0]) + mul(a[1], b[1]), d), div(mul(a[1], b[0]) - mul(a[0], b[1]), d)];
  }

  function cExp(a) {
    const m = expReal(a[0]);
    if (m === 0n) return [0n, 0n];
    const [s, c] = sinCosReal(a[1]);
    return [mul(m, c), mul(m, s)];
  }

  function cLog(a) {
    if (a[0] === 0n && a[1] === 0n) return [-ctx.MAXV(), 0n];
    const mod = cAbs(a);
    const re = lnReal(mod);
    // 相位用双精度（只影响非常规公式）
    return [re, atan2(a[1], a[0])];
  }

  function cSqrt(a) {
    const m = cAbs(a);
    if (m === 0n) return [0n, 0n];
    if (a[0] >= 0n) {
      const x = sqrt((m + a[0]) >> 1n);
      if (x === 0n) return [0n, 0n];
      return [x, div(a[1], x << 1n)];
    }
    const y = sqrt((m - a[0]) >> 1n);
    if (y === 0n) return [0n, 0n];
    const yy = a[1] < 0n ? -y : y;
    return [div(a[1], yy << 1n), yy];
  }

  function cPowInt(a, k) {
    if (k === 0) return [ONE, 0n];
    let neg = k < 0;
    let n = Math.abs(k);
    let base = a, res = [ONE, 0n];
    while (n > 0) {
      if (n & 1) res = cMul(res, base);
      n >>= 1;
      if (n) base = cMul(base, base);
    }
    return neg ? cDiv([ONE, 0n], res) : res;
  }

  function cPow(a, b) {
    // a^b = exp(b log a)；b 为实数时优先用 exp(b*ln|a|) 保持对称
    if (b[1] === 0n) {
      const k = ctx.toNumber(b[0]);
      if (Number.isInteger(k) && Math.abs(k) <= 32) return cPowInt(a, k);
    }
    return cExp(cMul(b, cLog(a)));
  }

  return {
    ctx, bits, FB, ONE, ZERO, ONE_C, PI, HALF_PI, LN2,
    mul, div, sqrt, expReal, sinCosReal, lnReal, atanReal, atan2, sinhCosh,
    cMul, cAdd, cSub, cDiv, cAbs, cAbs2, cExp, cLog, cSqrt, cPow, cPowInt
  };
}

/* ---------------- AST -> 闭包 ---------------- */

const REAL_FUNCS = new Set(['floor', 'ceil', 'round', 'sign']);

export function compileBig(ast, options = {}) {
  const bits = options.bits || 256;
  const K = options.ctx || makeBigContext(bits);
  const ctx = K.ctx;
  const params = options.params || ast.params || [];
  const userFns = options.functions || {};

  function num(v) { return [ctx.fromNumber(v), 0n]; }

  function build(node, scope) {
    switch (node.k) {
      case 'num': return () => num(node.v);
      case 'var': {
        const name = node.name;
        if (scope.has(name)) {
          const kind = scope.get(name);
          return kind === 'loop' ? (st) => [st.loopVal, 0n] : (st) => st[scope.get(name)] || K.ZERO;
        }
        if (name === 'z') return (st) => st.z;
        if (name === 'c') return (st) => st.c;
        if (name === 'n') return (st) => [ctx.fromNumber(st.n), 0n];
        if (name === 'z_1') return (st) => st.zp;
        const idx = params.indexOf(name);
        if (idx >= 0) return (st) => st.P[idx] || K.ONE_C;
        return () => [ctx.fromNumber(0), 0n];
      }
      case 'bin': {
        const a = build(node.a, scope), b = build(node.b, scope);
        switch (node.op) {
          case '+': return (st) => K.cAdd(a(st), b(st));
          case '-': return (st) => K.cSub(a(st), b(st));
          case '*': return (st) => K.cMul(a(st), b(st));
          case '/': return (st) => K.cDiv(a(st), b(st));
          default: return (st) => K.cAdd(a(st), b(st));
        }
      }
      case 'pow': {
        const a = build(node.a, scope);
        if (node.b.k === 'num' && Number.isInteger(node.b.v)) {
          const k = node.b.v;
          return (st) => K.cPowInt(a(st), k);
        }
        const b = build(node.b, scope);
        return (st) => K.cPow(a(st), b(st));
      }
      case 'call': {
        const args = node.args.map(x => build(x, scope));
        const f = node.name;
        switch (f) {
          case 'sin': return (st) => complexSin(args[0](st));
          case 'cos': return (st) => complexCos(args[0](st));
          case 'exp': return (st) => K.cExp(args[0](st));
          case 'log': case 'ln': return (st) => K.cLog(args[0](st));
          case 'sqrt': return (st) => K.cSqrt(args[0](st));
          case 'abs': case 'cabs': return (st) => [K.cAbs(args[0](st)), 0n];
          case 'abs2': case 'norm': return (st) => [K.cAbs2(args[0](st)), 0n];
          case 'arg': {
            return (st) => {
              const v = args[0](st);
              return [K.atan2(v[1], v[0]), 0n];
            };
          }
          case 'tan': return (st) => {
            const v = args[0](st);
            const [s, c] = [complexSin(v), complexCos(v)];
            return K.cDiv(s, c);
          };
          case 'sinh': return (st) => complexSinh(args[0](st));
          case 'cosh': return (st) => complexCosh(args[0](st));
          case 'tanh': return (st) => K.cDiv(complexSinh(args[0](st)), complexCosh(args[0](st)));
          case 'fact': return (st) => {
            const k = Math.round(ctx.toNumber(args[0](st)[0]));
            if (k < 0) return [0n, 0n];
            let acc = K.ONE;
            for (let i = 2; i <= Math.min(k, 2000); i++) acc *= BigInt(i);
            return [acc, 0n];
          };
          case 'pow': {
            return (st) => K.cPow(args[0](st), args[1](st));
          }
          case 'conj': return (st) => { const v = args[0](st); return [v[0], -v[1]]; };
          case 're': return (st) => [args[0](st)[0], 0n];
          case 'im': return (st) => [args[0](st)[1], 0n];
          case 'floor': case 'ceil': case 'round': case 'sign': {
            return (st) => {
              const v = args[0](st);
              const x = Number(ctx.toNumber(v[0]));
              const r = f === 'floor' ? Math.floor(x) : f === 'ceil' ? Math.ceil(x) : f === 'round' ? Math.round(x) : Math.sign(x);
              return [ctx.fromNumber(r), 0n];
            };
          }
          case 'min': case 'max': {
            return (st) => {
              const a = args[0](st), b = args[1](st);
              const take = f === 'min' ? (ctx.toNumber(a[0]) <= ctx.toNumber(b[0])) : (ctx.toNumber(a[0]) >= ctx.toNumber(b[0]));
              return take ? a : b;
            };
          }
          case 'mod': {
            return (st) => {
              const a = args[0](st), b = args[1](st);
              const ar = ctx.toNumber(a[0]), br = ctx.toNumber(b[0]);
              return [ctx.fromNumber(br ? ar - br * Math.floor(ar / br) : 0), 0n];
            };
          }
          default: {
            if (userFns[f]) {
              const def = userFns[f];
              const inner = build(def.body, new Map());
              return (st) => {
                const saved = st.z;
                st.z = args[0](st);
                const r = inner(st);
                st.z = saved;
                return r;
              };
            }
            throw new Error('高精度求值不支持函数 ' + f);
          }
        }
      }
      case 'sum': case 'prod': {
        const from = build(node.from, scope), to = build(node.to, scope);
        const inner = build(node.body, new Map([...scope, [node.v, 'loop']]));
        const init = node.k === 'sum' ? [0n, 0n] : [K.ONE, 0n];
        return (st) => {
          const a = Math.round(ctx.toNumber(from(st)[0]));
          const b = Math.round(ctx.toNumber(to(st)[0]));
          let acc = init;
          const saved = st.loopVal;
          for (let i = a; i <= b; i++) {
            st.loopVal = ctx.fromNumber(i);
            const v = inner(st);
            acc = node.k === 'sum' ? K.cAdd(acc, v) : K.cMul(acc, v);
          }
          st.loopVal = saved;
          return acc;
        };
      }
      case 'piecewise': {
        // piecewise(cond, a, cond2, b, ..., else)
        const parts = node.args.map(x => build(x, scope));
        return (st) => {
          for (let i = 0; i + 1 < parts.length; i += 2) {
            if (truthy(parts[i](st))) return parts[i + 1](st);
          }
          return parts.length % 2 ? parts[parts.length - 1](st) : [0n, 0n];
        };
      }
      case 'cmp': {
        const a = build(node.a, scope), b = build(node.b, scope);
        return (st) => {
          const d = ctx.toNumber(a(st)[0]) - ctx.toNumber(b(st)[0]);
          const r = node.op === '<' ? d < 0 : node.op === '>' ? d > 0 : node.op === '<=' ? d <= 0 : node.op === '>=' ? d >= 0 : d === 0;
          return r ? [K.ONE, 0n] : [0n, 0n];
        };
      }
      default:
        return () => [0n, 0n];
    }
  }

  function truthy(v) {
    return v[0] > (K.ONE >> 1n) || v[1] !== 0n;
  }

  function complexSin(v) {
    // sin(a+bi) = sin a cosh b + i cos a sinh b
    const [s, c] = K.sinCosReal(v[0]);
    const eb = K.expReal(v[1]);
    const enb = K.expReal(-v[1]);
    const ch = (eb + enb) >> 1n;
    const sh = (eb - enb) >> 1n;
    return [K.mul(s, ch), K.mul(c, sh)];
  }
  function complexSinh(v) {
    // sinh(a+bi) = sinh a cos b + i cosh a sin b
    const [sh, ch] = K.sinhCosh(v[0]);
    const [s, c] = K.sinCosReal(v[1]);
    return [K.mul(sh, c), K.mul(ch, s)];
  }
  function complexCosh(v) {
    // cosh(a+bi) = cosh a cos b + i sinh a sin b
    const [sh, ch] = K.sinhCosh(v[0]);
    const [s, c] = K.sinCosReal(v[1]);
    return [K.mul(ch, c), K.mul(sh, s)];
  }

  function complexCos(v) {
    const [s, c] = K.sinCosReal(v[0]);
    const eb = K.expReal(v[1]);
    const enb = K.expReal(-v[1]);
    const ch = (eb + enb) >> 1n;
    const sh = (eb - enb) >> 1n;
    return [K.mul(c, ch), -K.mul(s, sh)];
  }

  const fn = build(ast, new Map());

  /**
   * 单步求值
   * @param {object} st { z:[re,im], c:[re,im], n:number, zp:[re,im], P:[[re,im]...] }
   * @returns {[bigint, bigint]}
   */
  return function evalBig(st) {
    return fn(st);
  };
}

/* ---------------- 便捷封装 ---------------- */

export function bigFromNumber(K, x) { return K.ctx.fromNumber(x); }
