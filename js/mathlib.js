/* ------------------------------------------------------------------
 * mathlib.js — 复数表达式数学库
 *
 * 设计参考 Desmos / mathjs / math.js 的表达式前端，为分形迭代做了专门优化：
 *   1. 词法 + Pratt 优先级解析（含隐式乘法、右结合幂、后缀阶乘）
 *   2. 语义分析：变量/函数/元数检查，带位置的错误信息
 *   3. 公共子表达式消除（CSE）+ 临时变量代码生成 -> 单次遍历的 JS 闭包
 *   4. 内置复数函数库（分支切割、稳定 hypot、log1p 近似等）
 *   5. 求和 Σ / 连乘 Π / 分段 piecewise / 用户自定义函数 f(x)=…
 *   6. LaTeX 序列化，用于公式窗口的科学排版
 *
 * 变量：z 当前值，c 常数项，n 迭代序号，z_1 上一轮值；其余单字母均为参数（自动生成滑块）
 * ----------------------------------------------------------------*/

/* ============ 1. 词法 ============ */

const OPS3 = ['<=', '>=', '==', '!='];
const OPS1 = '+-*/^!(),<>=';

export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) { // 注释
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] || '')) {
          while (k < n && /[0-9]/.test(src[k])) k++;
          j = k;
        }
      }
      const text = src.slice(i, j);
      const v = Number(text);
      if (!isFinite(v)) throw err(`数字无法解析：${text}`, i);
      out.push({ t: 'num', v, p: i, text });
      i = j;
      continue;
    }
    if (/[A-Za-z\u03b1-\u03c9\u0391-\u03a9]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9\u03b1-\u03c9\u0391-\u03a9]/.test(src[j])) j++;
      // 下标：z_1、f_2
      if (src[j] === '_') {
        let k = j + 1;
        if (src[k] === '{') {
          k++;
          while (k < n && src[k] !== '}') k++;
          k++;
        } else {
          while (k < n && /[0-9]/.test(src[k])) k++;
        }
        j = k;
      }
      out.push({ t: 'id', v: src.slice(i, j), p: i });
      i = j;
      continue;
    }
    if (ch === '\u03c0') { out.push({ t: 'id', v: 'pi', p: i }); i++; continue; }
    if (ch === '\u03c4') { out.push({ t: 'id', v: 'tau', p: i }); i++; continue; }
    if (ch === '\u2212') { out.push({ t: '-', p: i }); i++; continue; }
    let matched = false;
    for (const op of OPS3) {
      if (src.startsWith(op, i)) { out.push({ t: op, p: i }); i += op.length; matched = true; break; }
    }
    if (matched) continue;
    if (OPS1.includes(ch)) { out.push({ t: ch, p: i }); i++; continue; }
    throw err(`无法识别的字符 “${ch}”`, i);
  }
  out.push({ t: 'eof', p: n });
  return out;
}

function err(msg, pos) {
  const e = new Error(msg);
  e.pos = pos;
  return e;
}

/* ============ 2. 语法（Pratt） ============ */

const CONST = {
  pi: Math.PI, 'π': Math.PI, tau: 2 * Math.PI, e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2, i: 0
};

export const VARIABLES = ['z', 'c', 'n', 'z_1'];

const FUNC_NAMES = new Set([
  'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'ln', 'sqrt',
  'abs', 'abs2', 'norm', 'arg', 'conj', 're', 'im', 'floor', 'ceil', 'round',
  'sign', 'min', 'max', 'mod', 'fact', 'pow', 'cabs'
]);

export function parse(src, options = {}) {
  const userFns = options.functions || {};
  const loopVars = new Set();
  const params = new Set();
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t, what) => {
    if (peek().t !== t) throw err(`此处应为 ${what}`, peek().p);
    return next();
  };

  function parseExpr() { return parseCompare(); }

  function parseCompare() {
    let left = parseAdd();
    for (;;) {
      const t = peek().t;
      if (t === '<' || t === '>' || t === '<=' || t === '>=' || t === '==' || t === '!=') {
        next();
        const right = parseAdd();
        left = { k: 'cmp', op: t, a: left, b: right };
      } else break;
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    for (;;) {
      const t = peek().t;
      if (t === '+') { next(); left = { k: 'bin', op: '+', a: left, b: parseMul() }; }
      else if (t === '-') { next(); left = { k: 'bin', op: '-', a: left, b: parseMul() }; }
      else break;
    }
    return left;
  }

  function startsPrimary(t) {
    return t === 'num' || t === 'id' || t === '(';
  }

  function parseMul() {
    let left = parseUnary();
    for (;;) {
      const t = peek().t;
      if (t === '*') { next(); left = { k: 'bin', op: '*', a: left, b: parseUnary() }; }
      else if (t === '/') { next(); left = { k: 'bin', op: '/', a: left, b: parseUnary() }; }
      else if (startsPrimary(t)) {
        // 隐式乘法：2z、3(z+1)、(z)(c)、z sin(z)
        left = { k: 'bin', op: '*', a: left, b: parseUnary(), implicit: true };
      } else break;
    }
    return left;
  }

  function parseUnary() {
    if (peek().t === '-') { next(); return { k: 'neg', a: parseUnary() }; }
    if (peek().t === '+') { next(); return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    if (peek().t === '^') {
      next();
      return { k: 'pow', a: base, b: parseUnary() }; // 右结合
    }
    return base;
  }

  function parsePostfix() {
    let node = parsePrimary();
    while (peek().t === '!') {
      next();
      node = { k: 'call', name: 'fact', args: [node] };
    }
    return node;
  }

  function parseArgs() {
    const args = [];
    if (peek().t !== ')') {
      args.push(parseExpr());
      while (peek().t === ',') { next(); args.push(parseExpr()); }
    }
    expect(')', '右括号 )');
    return args;
  }

  function parsePrimary() {
    const tk = peek();
    if (tk.t === 'num') { next(); return { k: 'num', v: tk.v }; }
    if (tk.t === '(') { next(); const e = parseExpr(); expect(')', '右括号 )'); return e; }
    if (tk.t === 'id') {
      next();
      const name = tk.v;
      const callable = FUNC_NAMES.has(name) || name in userFns ||
        name === 'sum' || name === 'prod' || name === 'piecewise';
      if (peek().t === '(' && callable) {
        next();
        // Σ / Π：sum(k, a, b, body)
        if (name === 'sum' || name === 'prod') {
          const idxTok = next();
          if (idxTok.t !== 'id') throw err(`${name} 的第一个参数必须是索引变量`, idxTok.p);
          expect(',', '逗号');
          const from = parseExpr();
          expect(',', '逗号');
          const to = parseExpr();
          expect(',', '逗号');
          loopVars.add(idxTok.v);
          const body = parseExpr();
          loopVars.delete(idxTok.v);
          expect(')', '右括号 )');
          return { k: name, v: idxTok.v, from, to, body };
        }
        if (name === 'piecewise') {
          return { k: 'piecewise', args: parseArgs() };
        }
        const args = parseArgs();
        if (userFns[name]) return expandUser(userFns[name], args);
        return { k: 'call', name, args };
      }
      if (name === 'i') return { k: 'num', v: 0, imag: 1 };
      if (name in CONST) return { k: 'num', v: CONST[name] };
      if (name === 'z_1' || name === 'zprev' || name === 'zp') return { k: 'var', name: 'z_1' };
      if (VARIABLES.includes(name) || loopVars.has(name)) return { k: 'var', name };
      if (/^[A-Za-z]$/.test(name)) { params.add(name); return { k: 'var', name, param: true }; }
      if (userFns[name]) {
        // 零元用户函数
        return expandUser(userFns[name], []);
      }
      throw err(`未知标识符 “${name}”（可用：${VARIABLES.join(' ')}）`, tk.p);
    }
    throw err('表达式不完整', tk.p);
  }

  // 用户函数展开（宏替换）
  function expandUser(def, argNodes) {
    if (argNodes.length !== def.params.length) {
      throw err(`函数 ${def.name} 需要 ${def.params.length} 个参数`, 0);
    }
    const map = {};
    def.params.forEach((pn, i) => { map[pn] = argNodes[i]; });
    return subst(def.body, map);
  }

  const ast = parseExpr();
  if (peek().t !== 'eof') throw err('多余的内容', peek().p);
  ast.params = [...params];
  return ast;
}

function subst(node, map) {
  if (!node || typeof node !== 'object') return node;
  if (node.k === 'var' && map[node.name]) return map[node.name];
  const out = { ...node };
  for (const key of ['a', 'b', 'body', 'from', 'to']) {
    if (out[key] && typeof out[key] === 'object') out[key] = subst(out[key], map);
  }
  if (out.args) out.args = out.args.map(x => subst(x, map));
  return out;
}

/* ============ 3. 代码生成（CSE + 临时变量） ============ */

const REAL_FUNCS = new Set(['abs', 'arg', 're', 'im', 'floor', 'ceil', 'round', 'sign', 'fact']);

function key(node) {
  switch (node.k) {
    case 'num': return 'n' + node.v + (node.imag ? 'i' : '');
    case 'var': return 'v' + node.name;
    case 'neg': return '-' + key(node.a);
    case 'bin': return node.op + '(' + key(node.a) + ',' + key(node.b) + ')';
    case 'pow': return '^(' + key(node.a) + ',' + key(node.b) + ')';
    case 'cmp': return 'c' + node.op + '(' + key(node.a) + ',' + key(node.b) + ')';
    case 'call': return 'f' + node.name + '(' + node.args.map(key).join(',') + ')';
    case 'sum': return 'S(' + node.v + ',' + key(node.from) + ',' + key(node.to) + ',' + key(node.body) + ')';
    case 'prod': return 'P(' + node.v + ',' + key(node.from) + ',' + key(node.to) + ',' + key(node.body) + ')';
    case 'piecewise': return 'W(' + node.args.map(key).join(',') + ')';
    default: return '?';
  }
}

export function generate(ast, opts = {}) {
  const paramNames = opts.params || ast.params || [];
  const lines = [];
  const cache = new Map();
  const scope = new Map();
  let t = 0;
  const T = () => 't' + (t++);
  const tmp = (r, i) => { const n = T(); lines.push(`const ${n}r = ${r}, ${n}i = ${i};`); return { r: n + 'r', i: n + 'i' }; };
  const cmp = (op) => {
    if (op === '<') return '<';
    if (op === '>') return '>';
    if (op === '<=') return '<=';
    if (op === '>=') return '>=';
    if (op === '==') return '===';
    return '!==';
  };

  function emit(node) {
    const k = key(node);
    const hit = cache.get(k);
    if (hit) return hit;

    let res;
    switch (node.k) {
      case 'num':
        res = { r: numLit(node.v), i: node.imag ? '1' : '0' };
        break;
      case 'var': {
        if (node.name === 'z') res = { r: 'zr', i: 'zi' };
        else if (node.name === 'c') res = { r: 'cr', i: 'ci' };
        else if (node.name === 'n') res = { r: opts.loop ? 'n' : 'NI', i: '0' };
        else if (node.name === 'z_1') res = { r: 'S.zpr', i: 'S.zpi' };
        else if (scope.has(node.name)) res = { r: node.name, i: '0' };
        else {
          const idx = paramNames.indexOf(node.name);
          res = { r: `P[${idx < 0 ? 0 : idx}]`, i: '0' };
        }
        break;
      }
      case 'neg': {
        const a = emit(node.a);
        res = { r: `-(${a.r})`, i: `-(${a.i})` };
        break;
      }
      case 'cmp': {
        const a = emit(node.a), b = emit(node.b);
        // 用实部比较（虚部不参与），返回 1/0
        res = { r: `((${a.r}) ${cmp(node.op)} (${b.r}) ? 1 : 0)`, i: '0' };
        break;
      }
      case 'bin': {
        const a = emit(node.a), b = emit(node.b);
        if (node.op === '+') res = tmp(`${a.r} + ${b.r}`, `${a.i} + ${b.i}`);
        else if (node.op === '-') res = tmp(`${a.r} - ${b.r}`, `${a.i} - ${b.i}`);
        else if (node.op === '*') res = tmp(`${a.r} * ${b.r} - ${a.i} * ${b.i}`, `${a.r} * ${b.i} + ${a.i} * ${b.r}`);
        else if (node.op === '/') {
          const n = T();
          lines.push(`const ${n}d = ${b.r} * ${b.r} + ${b.i} * ${b.i} || 1e-300;`);
          lines.push(`const ${n}r = (${a.r} * ${b.r} + ${a.i} * ${b.i}) / ${n}d;`);
          lines.push(`const ${n}i = (${a.i} * ${b.r} - ${a.r} * ${b.i}) / ${n}d;`);
          res = { r: n + 'r', i: n + 'i' };
        }
        break;
      }
      case 'pow': res = emitPow(node); break;
      case 'call': res = emitCall(node); break;
      case 'sum': case 'prod': res = emitLoop(node); break;
      case 'piecewise': res = emitPiecewise(node); break;
      default: throw new Error('未知节点 ' + node.k);
    }
    cache.set(k, res);
    return res;
  }

  function emitPow(node) {
    const a = emit(node.a);
    if (node.b.k === 'num' && Number.isInteger(node.b.v) && Math.abs(node.b.v) <= 12) {
      const p = Math.abs(node.b.v);
      if (p === 0) return { r: '1', i: '0' };
      const n0 = T();
      lines.push(`const ${n0}r = ${a.r}, ${n0}i = ${a.i};`);
      let cur = { r: n0 + 'r', i: n0 + 'i' };
      for (let k = 1; k < p; k++) cur = tmp(`${cur.r} * ${a.r} - ${cur.i} * ${a.i}`, `${cur.r} * ${a.i} + ${cur.i} * ${a.r}`);
      if (node.b.v < 0) {
        const m = T();
        lines.push(`const ${m}d = ${cur.r} * ${cur.r} + ${cur.i} * ${cur.i} || 1e-300;`);
        lines.push(`const ${m}r = ${cur.r} / ${m}d, ${m}i = -${cur.i} / ${m}d;`);
        return { r: m + 'r', i: m + 'i' };
      }
      return cur;
    }
    // 一般复数幂 exp(w·log z)
    const b = emit(node.b);
    const n = T();
    lines.push(`const ${n}mag = Math.hypot(${a.r}, ${a.i}) || 1e-300;`);
    lines.push(`const ${n}lm = Math.log(${n}mag), ${n}th = Math.atan2(${a.i}, ${a.r});`);
    lines.push(`const ${n}er = ${b.r} * ${n}lm - ${b.i} * ${n}th, ${n}ei = ${b.r} * ${n}th + ${b.i} * ${n}lm;`);
    lines.push(`const ${n}ex = Math.exp(${n}er);`);
    return { r: `(${n}ex * Math.cos(${n}ei))`, i: `(${n}ex * Math.sin(${n}ei))` };
  }

  function emitCall(node) {
    const a = emit(node.args[0] || { k: 'num', v: 0 });
    const name = node.name;
    if (name === 'abs' || name === 'cabs') return { r: `Math.hypot(${a.r}, ${a.i})`, i: '0' };
    if (name === 'abs2' || name === 'norm') return { r: `(${a.r} * ${a.r} + ${a.i} * ${a.i})`, i: '0' };
    if (name === 'arg') return { r: `Math.atan2(${a.i}, ${a.r})`, i: '0' };
    if (name === 're') return { r: a.r, i: '0' };
    if (name === 'im') return { r: a.i, i: '0' };
    if (name === 'conj') return { r: a.r, i: `-(${a.i})` };
    if (name === 'floor') return { r: `Math.floor(${a.r})`, i: '0' };
    if (name === 'ceil') return { r: `Math.ceil(${a.r})`, i: '0' };
    if (name === 'round') return { r: `Math.round(${a.r})`, i: '0' };
    if (name === 'sign') return { r: `Math.sign(${a.r})`, i: '0' };
    if (name === 'fact') return { r: `gamma(${a.r} + 1)`, i: '0' };
    if (name === 'min' || name === 'max' || name === 'mod') {
      const b = emit(node.args[1] || { k: 'num', v: 0 });
      if (name === 'mod') return { r: `((${a.r}) % (${b.r}))`, i: '0' };
      return { r: `Math.${name}(${a.r}, ${b.r})`, i: '0' };
    }
    if (name === 'exp') {
      const n = T();
      lines.push(`const ${n}e = Math.exp(${a.r});`);
      return { r: `(${n}e * Math.cos(${a.i}))`, i: `(${n}e * Math.sin(${a.i}))` };
    }
    if (name === 'log' || name === 'ln') {
      const n = T();
      lines.push(`const ${n}m = Math.hypot(${a.r}, ${a.i}) || 1e-300;`);
      return { r: `Math.log(${n}m)`, i: `Math.atan2(${a.i}, ${a.r})` };
    }
    if (name === 'sqrt') {
      const n = T();
      lines.push(`const ${n}m = Math.hypot(${a.r}, ${a.i});`);
      lines.push(`const ${n}s = Math.sqrt(Math.max((${n}m + ${a.r}) * 0.5, 0));`);
      lines.push(`const ${n}q = ${n}s === 0 ? 0 : ${a.i} / (2 * ${n}s);`);
      return { r: `${n}s`, i: `${n}q` };
    }
    if (name === 'sin') {
      const n = T();
      lines.push(`const ${n}ch = Math.cosh(${a.i}), ${n}sh = Math.sinh(${a.i});`);
      return { r: `(Math.sin(${a.r}) * ${n}ch)`, i: `(Math.cos(${a.r}) * ${n}sh)` };
    }
    if (name === 'cos') {
      const n = T();
      lines.push(`const ${n}ch = Math.cosh(${a.i}), ${n}sh = Math.sinh(${a.i});`);
      return { r: `(Math.cos(${a.r}) * ${n}ch)`, i: `(-Math.sin(${a.r}) * ${n}sh)` };
    }
    if (name === 'sinh') {
      const n = T();
      lines.push(`const ${n}ch = Math.cosh(${a.r}), ${n}sh = Math.sinh(${a.r});`);
      return { r: `(${n}sh * Math.cos(${a.i}))`, i: `(${n}ch * Math.sin(${a.i}))` };
    }
    if (name === 'cosh') {
      const n = T();
      lines.push(`const ${n}ch = Math.cosh(${a.r}), ${n}sh = Math.sinh(${a.r});`);
      return { r: `(${n}ch * Math.cos(${a.i}))`, i: `(${n}sh * Math.sin(${a.i}))` };
    }
    if (name === 'tan' || name === 'tanh') {
      const sh = name === 'tan' ? 'sin' : 'sinh';
      const ch = name === 'tan' ? 'cos' : 'cosh';
      const s = emit({ k: 'call', name: sh, args: node.args });
      const c = emit({ k: 'call', name: ch, args: node.args });
      const n = T();
      lines.push(`const ${n}d = ${c.r} * ${c.r} + ${c.i} * ${c.i} || 1e-300;`);
      return { r: `((${s.r} * ${c.r} + ${s.i} * ${c.i}) / ${n}d)`, i: `((${s.i} * ${c.r} - ${s.r} * ${c.i}) / ${n}d)` };
    }
    throw new Error('未实现的函数 ' + name);
  }

  function emitLoop(node) {
    const idx = node.v;
    const from = emit(node.from), to = emit(node.to);
    const n = T();
    const acc = node.k === 'sum' ? '+' : '*';
    const initR = node.k === 'sum' ? '0' : '1';
    const savedCache = new Map(cache);
    const savedScope = new Map(scope);
    scope.set(idx, idx);
    const before = lines.length;
    const body = emit(node.body);
    const inner = lines.splice(before);
    cache.clear();
    savedCache.forEach((v, k) => cache.set(k, v));
    scope.clear();
    savedScope.forEach((v, k) => scope.set(k, v));

    lines.push(`let ${n}r = ${initR}, ${n}i = 0;`);
    lines.push(`{ const __f${n} = Math.round(${from.r}), __t${n} = Math.round(${to.r});`);
    lines.push(`  for (let ${idx} = __f${n}; ${idx} <= __t${n}; ${idx}++) {`);
    for (const ln of inner) lines.push('    ' + ln);
    lines.push(`    ${n}r = ${n}r ${acc} ${body.r};`);
    lines.push(`    ${n}i = ${n}i ${acc} ${body.i};`);
    lines.push('  } }');
    return { r: n + 'r', i: n + 'i' };
  }

  function emitPiecewise(node) {
    const args = node.args;
    const n = T();
    lines.push(`let ${n}r = 0, ${n}i = 0; let ${n}done = false;`);
    for (let i = 0; i + 1 < args.length; i += 2) {
      const c = emit(args[i]);
      const v = emit(args[i + 1]);
      lines.push(`if (!${n}done && (${c.r}) !== 0) { ${n}r = ${v.r}; ${n}i = ${v.i}; ${n}done = true; }`);
    }
    if (args.length % 2 === 1) {
      const v = emit(args[args.length - 1]);
      lines.push(`if (!${n}done) { ${n}r = ${v.r}; ${n}i = ${v.i}; }`);
    }
    return { r: n + 'r', i: n + 'i' };
  }

  const res = emit(ast);
  const src = [
    '"use strict";',
    lines.join('\n'),
    `OUT[0] = ${res.r};`,
    `OUT[1] = ${res.i};`
  ].join('\n');

  // eslint-disable-next-line no-new-func
  const fn = new Function('zr', 'zi', 'cr', 'ci', 'P', 'NI', 'S', 'OUT', src);

  // ---- 整段迭代版本：把 for 循环一起生成，JIT 可把状态放进寄存器 ----
  const loopSrc = [
    '"use strict";',
    'let zr = zr0, zi = zi0, n = 0, m2 = 0;',
    'S.zpr = 0; S.zpi = 0; S.on = 0;',
    'for (; n < maxIter; n++) {',
    lines.join('\n'),
    '  S.zpr = zr; S.zpi = zi;',
    `  zr = ${res.r}; zi = ${res.i};`,
    '  m2 = zr * zr + zi * zi;',
    '  if (!(m2 <= 1e20)) break;',
    '  if (n === 12) { S.cr = zr; S.ci = zi; S.on = 1; }',
    '  else if (S.on && ((n & 31) === 0)) {',
    '    const dx = zr - S.cr, dy = zi - S.ci;',
    '    if (dx * dx + dy * dy < 1e-26) { n = maxIter; m2 = -1; break; }',
    '  }',
    '}',
    'OUT[0] = n; OUT[1] = m2;'
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const step = new Function('zr0', 'zi0', 'cr', 'ci', 'P', 'maxIter', 'S', 'OUT', loopSrc);
  return { fn, step, src, loopSrc, temps: t };
}

function numLit(v) {
  if (Number.isInteger(v)) return String(v);
  return v.toPrecision(17);
}

/* ============ 4. LaTeX 序列化 ============ */

const LATEX_FUNC = {
  abs: ['\\left|', '\\right|', 1], arg: ['\\arg', '', 1], re: ['\\operatorname{Re}', '', 1],
  im: ['\\operatorname{Im}', '', 1], conj: ['\\overline{', '}', 1], sqrt: ['\\sqrt{', '}', 1],
  exp: ['e^{', '}', 1], log: ['\\ln', '', 1], ln: ['\\ln', '', 1], sin: ['\\sin', '', 1],
  cos: ['\\cos', '', 1], tan: ['\\tan', '', 1], sinh: ['\\sinh', '', 1], cosh: ['\\cosh', '', 1],
  tanh: ['\\tanh', '', 1], floor: ['\\lfloor ', ' \\rfloor', 1], ceil: ['\\lceil ', ' \\rceil', 1],
  sign: ['\\operatorname{sgn}', '', 1], abs2: ['\\left|', '\\right|^2', 1]
};

export function toLatex(node) {
  const g = (n) => {
    switch (n.k) {
      case 'num': return n.imag ? 'i' : fmtNum(n.v);
      case 'var': return n.name === 'z_1' ? 'z_{n-1}' : (n.name === 'n' ? 'n' : n.name);
      case 'neg': return '-' + g(n.a);
      case 'bin': {
        if (n.op === '/') return `\\frac{${g(n.a)}}{${g(n.b)}}`;
        if (n.op === '*') {
          const a = g(n.a), b = g(n.b);
          const needA = n.a.k === 'bin' && (n.a.op === '+' || n.a.op === '-');
          const needB = n.b.k === 'bin' && (n.b.op === '+' || n.b.op === '-');
          return (needA ? `\\left(${a}\\right)` : a) + (needB ? `\\left(${b}\\right)` : b);
        }
        return g(n.a) + n.op + g(n.b);
      }
      case 'pow': {
        if (n.b.k === 'num' && Number.isInteger(n.b.v)) {
          const base = n.a.k === 'bin' || n.a.k === 'call' && n.a.name !== 'abs' ? `\\left(${g(n.a)}\\right)` : g(n.a);
          return `${base}^{${n.b.v}}`;
        }
        return `${g(n.a)}^{${g(n.b)}}`;
      }
      case 'cmp': return `${g(n.a)} ${n.op} ${g(n.b)}`;
      case 'call': {
        const f = LATEX_FUNC[n.name];
        if (f) {
          if (n.name === 'abs' || n.name === 'conj' || n.name === 'abs2') return f[0] + g(n.args[0]) + f[1];
          if (n.name === 'sqrt') return f[0] + g(n.args[0]) + f[1];
          if (n.name === 'exp') return f[0] + g(n.args[0]) + f[1];
          if (n.name === 'floor' || n.name === 'ceil') return f[0] + g(n.args[0]) + f[1];
          return f[0] + `\\left(${g(n.args[0])}\\right)`;
        }
        return `\\operatorname{${n.name}}\\left(${n.args.map(g).join(', ')}\\right)`;
      }
      case 'sum': return `\\sum_{${n.v}=${g(n.from)}}^{${g(n.to)}} ${g(n.body)}`;
      case 'prod': return `\\prod_{${n.v}=${g(n.from)}}^{${g(n.to)}} ${g(n.body)}`;
      case 'piecewise': return `\\begin{cases} ${n.args.map(g).join(' & ')} \\end{cases}`;
      default: return '?';
    }
  };
  return g(node) || '';
}

function fmtNum(v) {
  if (Number.isInteger(v)) return String(v);
  const s = String(Number(v.toPrecision(8)));
  return s;
}

/* ============ 5. 对外 API ============ */

/**
 * 编译多行公式：前面若干行可定义 f(x)=…，最后一行是迭代式
 * @returns {{ok:boolean, fn?:Function, latex?:string, error?:string, src?:string, defs:number}}
 */
export function compile(source) {
  const lines = String(source || '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#') && !s.startsWith('//'));

  const userFns = {};
  let main = null;
  let defs = 0;

  for (const line of lines) {
    const m = /^([A-Za-z]\w*)\s*\(\s*([A-Za-z]\w*)\s*\)\s*=\s*(.+)$/.exec(line);
    if (m && !['sum', 'prod', 'piecewise'].includes(m[1])) {
      const [, name, param, bodySrc] = m;
      const body = parse(bodySrc, { functions: userFns });
      userFns[name] = { name, params: [param], body };
      defs++;
      continue;
    }
    if (main !== null) {
      throw err('只能有一行迭代公式（其余行需写成 f(x)=…）', 0);
    }
    main = line;
  }
  if (main === null) throw err('缺少迭代公式', 0);

  const ast = parse(main, { functions: userFns });
  const params = (ast.params || []).filter(n => !VARIABLES.includes(n));
  const allParams = (ast.params || []);
  const { fn, step } = generate(ast, { params: allParams, loop: true });
  return { ok: true, fn, step, ast, latex: toLatex(ast), params: allParams, defs };
}

/** 仅校验，返回 latex 或抛出错误 */
export function preview(source) {
  try {
    const r = compile(source);
    return { ok: true, latex: r.latex, defs: r.defs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const EXAMPLES = [
  { expr: 'z^2 + c', zh: '曼德勃罗集', en: 'Mandelbrot' },
  { expr: 'z^3 + c', zh: '三次多枝', en: 'Cubic multibrot' },
  { expr: 'abs(z)^2 + c', zh: '燃烧船', en: 'Burning Ship' },
  { expr: 'conj(z)^2 + c', zh: '三叉戟', en: 'Tricorn' },
  { expr: 'z^2 + c + 0.5667*z_1', zh: '凤凰', en: 'Phoenix' },
  { expr: 'sin(z) + c', zh: '正弦分形', en: 'Sine fractal' },
  { expr: 'exp(z) + c', zh: '指数分形', en: 'Exponential fractal' },
  { expr: 'sum(k, 0, 2, z^3/3^k) + c', zh: 'Σ 级数分形', en: 'Series fractal' },
  { expr: 'piecewise(abs(z) < 1, z^2 + c, z/2 + c)', zh: '分段映射', en: 'Piecewise map' },
  { expr: 'f(z) = z^2 + c\nf(f(z))/2 + c', zh: '自定义函数', en: 'User function' }
];
