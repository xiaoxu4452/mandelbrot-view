/* ------------------------------------------------------------------
 * jet.js — 表达式「喷射」求值（截断幂级数），用于扰动法的任意公式
 *
 * 对每个参考点 Z_n，把 F(Z_n + ε, c0 + δ) 展开成 ε 的幂级数：
 *
 *     F = p_0 + p_1 ε + p_2 ε² + … + p_K ε^K        （ε 方向，直到 K 阶）
 *       + (q_0 + q_1 ε + … + q_K ε^K) δ              （δ 方向，只保留一阶）
 *
 * 于是扰动递推变得精确（多项式族在 K ≥ 次数 时完全精确）：
 *
 *     ε' = (p_1 + p_2 ε + … ) ε + (q_0 + q_1 ε + …) δ
 *
 * 系数由「幂级数自动微分」在参考轨道上求得，不用有限差分。
 * ----------------------------------------------------------------*/

export const JET_ORDER = 6;

/* ---------- 复数截断幂级数 ---------- */

function zeros(n) { return new Float64Array(n); }

function makeVal(K, r0 = 0, i0 = 0) {
  const v = { r: zeros(K + 1), i: zeros(K + 1), dr: zeros(K + 1), di: zeros(K + 1) };
  v.r[0] = r0; v.i[0] = i0;
  return v;
}

function clone(v) {
  return {
    r: v.r.slice(), i: v.i.slice(),
    dr: v.dr.slice(), di: v.di.slice()
  };
}

/** c = a * b（截断卷积，复数系数） */
function mulSeries(ar, ai, br, bi, K) {
  const cr = zeros(K + 1), ci = zeros(K + 1);
  for (let n = 0; n <= K; n++) {
    let sr = 0, si = 0;
    for (let k = 0; k <= n; k++) {
      sr += ar[k] * br[n - k] - ai[k] * bi[n - k];
      si += ar[k] * bi[n - k] + ai[k] * br[n - k];
    }
    cr[n] = sr; ci[n] = si;
  }
  return [cr, ci];
}

function mul(a, b, K) {
  const [r, i] = mulSeries(a.r, a.i, b.r, b.i, K);
  const [dr1, di1] = mulSeries(a.dr, a.di, b.r, b.i, K);
  const [dr2, di2] = mulSeries(a.r, a.i, b.dr, b.di, K);
  const dr = zeros(K + 1), di = zeros(K + 1);
  for (let k = 0; k <= K; k++) { dr[k] = dr1[k] + dr2[k]; di[k] = di1[k] + di2[k]; }
  return { r, i, dr, di };
}

function add(a, b, K, sign = 1) {
  const r = zeros(K + 1), i = zeros(K + 1), dr = zeros(K + 1), di = zeros(K + 1);
  for (let k = 0; k <= K; k++) {
    r[k] = a.r[k] + sign * b.r[k];
    i[k] = a.i[k] + sign * b.i[k];
    dr[k] = a.dr[k] + sign * b.dr[k];
    di[k] = a.di[k] + sign * b.di[k];
  }
  return { r, i, dr, di };
}

/** 1/a（a0 ≠ 0） */
function inv(a, K) {
  const a0r = a.r[0], a0i = a.i[0];
  const d = a0r * a0r + a0i * a0i;
  if (d === 0) return makeVal(K, 0, 0);
  const ir = a0r / d, ii = -a0i / d;

  // b_n = -(1/a0) * Σ_{k=1..n} a_k b_{n-k}
  const br = zeros(K + 1), bi = zeros(K + 1);
  br[0] = ir; bi[0] = ii;
  const tr = zeros(K + 1), ti = zeros(K + 1);
  for (let n = 1; n <= K; n++) {
    let sr = 0, si = 0;
    for (let k = 1; k <= n; k++) {
      sr += a.r[k] * br[n - k] - a.i[k] * bi[n - k];
      si += a.r[k] * bi[n - k] + a.i[k] * br[n - k];
    }
    tr[n] = (ir * sr - ii * si);
    ti[n] = (ir * si + ii * sr);
    br[n] = tr[n]; bi[n] = ti[n];
  }
  // δ 方向：d(1/a)/dc = -a_c / a²
  const [q1r, q1i] = mulSeries(a.dr, a.di, br, bi, K);
  const [q2r, q2i] = mulSeries(q1r, q1i, br, bi, K);
  const dr = zeros(K + 1), di = zeros(K + 1);
  for (let k = 0; k <= K; k++) { dr[k] = -q2r[k]; di[k] = -q2i[k]; }
  return { r: br, i: bi, dr, di };
}

function div(a, b, K) { return mul(a, inv(b, K), K); }

/** 由导数序列重建函数：g' = h，g0 给定 */
function integrate(h, K, g0r, g0i) {
  const r = zeros(K + 1), i = zeros(K + 1);
  r[0] = g0r; i[0] = g0i;
  for (let n = 1; n <= K; n++) { r[n] = h.r[n - 1] / n; i[n] = h.i[n - 1] / n; }
  return r;
}

function deriv(a, K) {
  const r = zeros(K + 1), i = zeros(K + 1);
  for (let n = 0; n < K; n++) { r[n] = (n + 1) * a.r[n + 1]; i[n] = (n + 1) * a.i[n + 1]; }
  return { r, i };
}

/** exp(a) */
function expSeries(a, K) {
  // a = a0 + u，exp(a) = exp(a0) * exp(u)
  const a0r = a.r[0], a0i = a.i[0];
  const m = Math.exp(a0r);
  const e0r = m * Math.cos(a0i), e0i = m * Math.sin(a0i);
  const u = { r: a.r.slice(), i: a.i.slice() };
  u.r[0] = 0; u.i[0] = 0;
  // e_0 = 1; e_n = (1/n) Σ k·u_k·e_{n-k}
  const er = zeros(K + 1), ei = zeros(K + 1);
  er[0] = 1; ei[0] = 0;
  for (let n = 1; n <= K; n++) {
    let sr = 0, si = 0;
    for (let k = 1; k <= n; k++) {
      sr += k * (u.r[k] * er[n - k] - u.i[k] * ei[n - k]);
      si += k * (u.r[k] * ei[n - k] + u.i[k] * er[n - k]);
    }
    er[n] = sr / n; ei[n] = si / n;
  }
  const r = zeros(K + 1), i = zeros(K + 1);
  for (let k = 0; k <= K; k++) {
    r[k] = e0r * er[k] - e0i * ei[k];
    i[k] = e0r * ei[k] + e0i * er[k];
  }
  // δ 方向：exp(a)_c = exp(a) * a_c
  const dr = zeros(K + 1), di = zeros(K + 1);
  const base = { r, i };
  const [qx, qy] = mulSeries(base.r, base.i, a.dr, a.di, K);
  for (let k = 0; k <= K; k++) { dr[k] = qx[k]; di[k] = qy[k]; }
  return { r, i, dr, di };
}

/** log(a) */
function logSeries(a, K) {
  const a0r = a.r[0], a0i = a.i[0];
  const m2 = a0r * a0r + a0i * a0i;
  if (m2 === 0) return makeVal(K, 0, 0);
  const lnr = 0.5 * Math.log(m2);
  const lni = Math.atan2(a0i, a0r);
  // g' = a'/a
  const d = deriv(a, K);
  const q = div({ r: d.r, i: d.i, dr: zeros(K + 1), di: zeros(K + 1) }, a, K);
  const r = integrate(q, K, lnr, lni);
  const i = zeros(K + 1);
  for (let k = 1; k <= K; k++) i[k] = q.i[k - 1] / k;
  // δ 方向：d log(a)/dc = a_c / a
  const av = inv(a, K);
  const [qr, qi] = mulSeries(a.dr, a.di, av.r, av.i, K);
  return { r, i, dr: qr, di: qi };
}

/** sqrt(a)：由 g'·g = a'/2 递推 */
function sqrtSeries(a, K) {
  const a0r = a.r[0], a0i = a.i[0];
  const m = Math.hypot(a0r, a0i);
  if (m === 0) return makeVal(K, 0, 0);
  let g0r, g0i;
  if (a0r >= 0) { g0r = Math.sqrt((m + a0r) / 2); g0i = a0i / (2 * g0r); }
  else { g0i = Math.sign(a0i || 1) * Math.sqrt((m - a0r) / 2); g0r = a0i / (2 * g0i); }

  const r = zeros(K + 1), i = zeros(K + 1);
  r[0] = g0r; i[0] = g0i;
  const ar = a.r, ai = a.i;
  const d0 = g0r * g0r + g0i * g0i;      // |g0|²

  for (let n = 1; n <= K; n++) {
    // Σ_{j=0..n-2} (j+1) g_{j+1} g_{n-1-j}
    let sr = 0, si = 0;
    for (let j = 0; j <= n - 2; j++) {
      const g1r = (j + 1) * r[j + 1], g1i = (j + 1) * i[j + 1];
      const h2r = r[n - 1 - j], h2i = i[n - 1 - j];
      sr += g1r * h2r - g1i * h2i;
      si += g1r * h2i + g1i * h2r;
    }
    // rhs = a'_{n-1}/2 - sum
    const rhsR = 0.5 * n * ar[n] - sr;
    const rhsI = 0.5 * n * ai[n] - si;
    // 除以 n·g0
    const cr = rhsR * g0r + rhsI * g0i;
    const ci = rhsI * g0r - rhsR * g0i;
    const den = n * d0;
    r[n] = cr / den;
    i[n] = ci / den;
  }
  // δ 方向：a_c / (2 sqrt(a))
  const invv = inv({ r, i, dr: zeros(K + 1), di: zeros(K + 1) }, K);
  const [qr2, qi2] = mulSeries(a.dr, a.di, invv.r, invv.i, K);
  const dr = zeros(K + 1), di = zeros(K + 1);
  for (let k = 0; k <= K; k++) { dr[k] = qr2[k] / 2; di[k] = qi2[k] / 2; }
  return { r, i, dr, di };
}

/** i * a */
function imagMul(a, K) {
  return {
    r: a.i.map(x => -x), i: a.r.slice(),
    dr: a.di.map(x => -x), di: a.dr.slice()
  };
}

function negVal(a, K) {
  return {
    r: a.r.map(x => -x), i: a.i.map(x => -x),
    dr: a.dr.map(x => -x), di: a.di.map(x => -x)
  };
}

function subVal(a, b, K) { return add(a, b, K, -1); }

/** sin / cos（借助 exp(±i a)） */
function sinSeries(a, K) {
  const ia = imagMul(a, K);
  const ep = expSeries(ia, K);
  const en = expSeries(negVal(ia, K), K);
  const d = subVal(ep, en, K);
  const r = zeros(K + 1), i = zeros(K + 1), dr = zeros(K + 1), di = zeros(K + 1);
  for (let k = 0; k <= K; k++) {
    r[k] = d.i[k] / 2; i[k] = -d.r[k] / 2;
    dr[k] = d.di[k] / 2; di[k] = -d.dr[k] / 2;
  }
  return { r, i, dr, di };
}

function cosSeries(a, K) {
  const ia = imagMul(a, K);
  const ep = expSeries(ia, K);
  const en = expSeries(negVal(ia, K), K);
  const r = zeros(K + 1), i = zeros(K + 1), dr = zeros(K + 1), di = zeros(K + 1);
  for (let k = 0; k <= K; k++) {
    r[k] = (ep.r[k] + en.r[k]) / 2; i[k] = (ep.i[k] + en.i[k]) / 2;
    dr[k] = (ep.dr[k] + en.dr[k]) / 2; di[k] = (ep.di[k] + en.di[k]) / 2;
  }
  return { r, i, dr, di };
}

function powInt(a, k, K) {
  if (k === 0) return makeVal(K, 1, 0);
  let neg = false, n = k;
  if (n < 0) { neg = true; n = -n; }
  let base = clone(a), res = makeVal(K, 1, 0);
  while (n > 0) {
    if (n & 1) res = mul(res, base, K);
    n >>= 1;
    if (n) base = mul(base, base, K);
  }
  return neg ? inv(res, K) : res;
}

/* ---------- AST -> jet ---------- */

export function compileJet(ast, options = {}) {
  const K = options.order || JET_ORDER;
  const params = options.params || ast.params || [];
  const userFns = options.functions || {};

  function build(node, scope) {
    switch (node.k) {
      case 'num': return () => makeVal(K, node.v, 0);
      case 'var': {
        const name = node.name;
        if (name === 'z') {
          // 自变量：z = Z + t，且与 c 无关
          return (st) => {
            const v = makeVal(K, st.zr, st.zi);
            v.r[1] = 1;
            return v;
          };
        }
        if (name === 'c') {
          // c = c0 + δ
          return (st) => {
            const v = makeVal(K, st.cr, st.ci);
            v.dr[0] = 1;
            return v;
          };
        }
        if (name === 'n') return (st) => makeVal(K, st.n, 0);
        if (name === 'z_1') return (st) => makeVal(K, st.zpr, st.zpi);
        if (scope.has(name)) {
          return scope.get(name) === 'loop'
            ? (st) => makeVal(K, st.loopVal, 0)
            : (st) => clone(st[scope.get(name)] || makeVal(K, 0, 0));
        }
        const idx = params.indexOf(name);
        return (st) => makeVal(K, idx >= 0 ? (st.P[idx] || 0) : 0, 0);
      }
      case 'bin': {
        const a = build(node.a, scope), b = build(node.b, scope);
        switch (node.op) {
          case '+': return (st) => add(a(st), b(st), K, 1);
          case '-': return (st) => add(a(st), b(st), K, -1);
          case '*': return (st) => mul(a(st), b(st), K);
          case '/': return (st) => div(a(st), b(st), K);
          default: return (st) => add(a(st), b(st), K, 1);
        }
      }
      case 'pow': {
        const a = build(node.a, scope);
        if (node.b.k === 'num' && Number.isInteger(node.b.v)) {
          const k = node.b.v;
          return (st) => powInt(a(st), k, K);
        }
        const b = build(node.b, scope);
        return (st) => expSeries(mul(b(st), logSeries(a(st), K), K), K);
      }
      case 'call': {
        const args = node.args.map(x => build(x, scope));
        switch (node.name) {
          case 'sin': return (st) => sinSeries(args[0](st), K);
          case 'cos': return (st) => cosSeries(args[0](st), K);
          case 'tan': return (st) => div(sinSeries(args[0](st), K), cosSeries(args[0](st), K), K);
          case 'exp': return (st) => expSeries(args[0](st), K);
          case 'log': case 'ln': return (st) => logSeries(args[0](st), K);
          case 'sqrt': return (st) => sqrtSeries(args[0](st), K);
          case 'conj': {
            return (st) => {
              const v = args[0](st);
              return {
                r: v.r.slice(), i: v.i.map(x => -x),
                dr: v.dr.slice(), di: v.di.map(x => -x)
              };
            };
          }
          case 'abs': return (st) => {
            const v = args[0](st);
            return sqrtSeries(mul(v, { ...conjVal(v, K) }, K), K);
          };
          case 'abs2': case 'norm': return (st) => {
            const v = args[0](st);
            return mul(v, conjVal(v, K), K);
          };
          case 're': return (st) => {
            const v = args[0](st);
            return { r: v.r.slice(), i: zeros(K + 1), dr: v.dr.slice(), di: zeros(K + 1) };
          };
          case 'im': return (st) => {
            const v = args[0](st);
            return { r: v.i.slice(), i: zeros(K + 1), dr: v.di.slice(), di: zeros(K + 1) };
          };
          default: {
            if (userFns[node.name]) {
              const def = userFns[node.name];
              const inner = build(def.body, new Map());
              return (st) => {
                const saved = st.zr, savedI = st.zi;
                const v = args[0](st);
                st.zr = v.r[0]; st.zi = v.i[0];
                const r = inner(st);
                st.zr = saved; st.zi = savedI;
                return r;
              };
            }
            throw new Error('级数求值不支持函数 ' + node.name);
          }
        }
      }
      case 'sum': case 'prod': {
        const from = build(node.from, scope), to = build(node.to, scope);
        const inner = build(node.body, new Map([...scope, [node.v, 'loop']]));
        return (st) => {
          const a = Math.round(from(st).r[0]);
          const b = Math.round(to(st).r[0]);
          let acc = node.k === 'sum' ? makeVal(K, 0, 0) : makeVal(K, 1, 0);
          const saved = st.loopVal;
          for (let i = a; i <= b; i++) {
            st.loopVal = i;
            const v = inner(st);
            acc = node.k === 'sum' ? add(acc, v, K, 1) : mul(acc, v, K);
          }
          st.loopVal = saved;
          return acc;
        };
      }
      case 'piecewise': {
        const parts = node.args.map(x => build(x, scope));
        return (st) => {
          for (let i = 0; i + 1 < parts.length; i += 2) {
            if (parts[i](st).r[0] > 0.5) return parts[i + 1](st);
          }
          return parts.length % 2 ? parts[parts.length - 1](st) : makeVal(K, 0, 0);
        };
      }
      case 'cmp': {
        const a = build(node.a, scope), b = build(node.b, scope);
        return (st) => {
          const x = a(st).r[0], y = b(st).r[0];
          const ok = node.op === '<' ? x < y : node.op === '>' ? x > y : node.op === '<=' ? x <= y : node.op === '>=' ? x >= y : x === y;
          return makeVal(K, ok ? 1 : 0, 0);
        };
      }
      default:
        return () => makeVal(K, 0, 0);
    }
  }

  function conjVal(v, K) {
    return {
      r: v.r.slice(), i: v.i.map(x => -x),
      dr: v.dr.slice(), di: v.di.map(x => -x)
    };
  }

  const fn = build(ast, new Map());
  return { fn, order: K };
}
