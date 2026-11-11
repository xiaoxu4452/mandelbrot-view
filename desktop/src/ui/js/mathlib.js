/* ------------------------------------------------------------------
 * mathlib.js — complex-expression math library
 *
 * The expression front end follows Desmos / mathjs / math.js, specialised for fractal iteration:
 *   1. Lexer + Pratt precedence parser (implicit multiplication, right-associative powers, postfix factorial)
 *   2. Semantic analysis: variable/function/arity checks, with position-aware error messages
 *   3. Common-subexpression elimination (CSE) + temporary-variable codegen -> a JS closure evaluated in one pass
 *   4. Built-in complex function library (branch cuts, stable hypot, log1p approximations, …)
 *   5. Summation Σ / product Π / piecewise / user-defined functions f(x)=…
 *   6. LaTeX serialisation, for scientific typesetting in the formula panel
 *
 * Variables: z current value, c constant term, n iteration index, z_1 previous value; any other single letter is a parameter (a slider is generated automatically)
 * ----------------------------------------------------------------*/

/* ============ 1. Lexer ============ */

const OPS3 = ['<=', '>=', '==', '!='];
const OPS1 = '+-*/^!(),<>=';

export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) { // comment
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
      if (!isFinite(v)) throw err(`cannot parse number: ${text}`, i);
      out.push({ t: 'num', v, p: i, text });
      i = j;
      continue;
    }
    if (/[A-Za-z\u03b1-\u03c9\u0391-\u03a9]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9\u03b1-\u03c9\u0391-\u03a9]/.test(src[j])) j++;
      // Subscripts: z_1, f_2
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
    throw err(`unrecognised character “${ch}”`, i);
  }
  out.push({ t: 'eof', p: n });
  return out;
}

function err(msg, pos) {
  const e = new Error(msg);
  e.pos = pos;
  return e;
}

/* ============ 2. Parser (Pratt) ============ */

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
    if (peek().t !== t) throw err(`expected ${what} here`, peek().p);
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
        // Implicit multiplication: 2z, 3(z+1), (z)(c), z sin(z)
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
      return { k: 'pow', a: base, b: parseUnary() }; // right-associative
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
    expect(')', 'closing parenthesis )');
    return args;
  }

  function parsePrimary() {
    const tk = peek();
    if (tk.t === 'num') { next(); return { k: 'num', v: tk.v }; }
    if (tk.t === '(') { next(); const e = parseExpr(); expect(')', 'closing parenthesis )'); return e; }
    if (tk.t === 'id') {
      next();
      const name = tk.v;
      const callable = FUNC_NAMES.has(name) || name in userFns ||
        name === 'sum' || name === 'prod' || name === 'piecewise';
      if (peek().t === '(' && callable) {
        next();
        // Σ / Π: sum(k, a, b, body)
        if (name === 'sum' || name === 'prod') {
          const idxTok = next();
          if (idxTok.t !== 'id') throw err(`${name}: the first argument must be an index variable`, idxTok.p);
          expect(',', 'comma');
          const from = parseExpr();
          expect(',', 'comma');
          const to = parseExpr();
          expect(',', 'comma');
          loopVars.add(idxTok.v);
          const body = parseExpr();
          loopVars.delete(idxTok.v);
          expect(')', 'closing parenthesis )');
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
        // Zero-argument user function
        return expandUser(userFns[name], []);
      }
      throw err(`unknown identifier “${name}” (available: ${VARIABLES.join(' ')})`, tk.p);
    }
    throw err('incomplete expression', tk.p);
  }

  // User-function expansion (macro substitution)
  function expandUser(def, argNodes) {
    if (argNodes.length !== def.params.length) {
      throw err(`function ${def.name} expects ${def.params.length} argument(s)`, 0);
    }
    const map = {};
    def.params.forEach((pn, i) => { map[pn] = argNodes[i]; });
    return subst(def.body, map);
  }

  const ast = parseExpr();
  if (peek().t !== 'eof') throw err('trailing content', peek().p);
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

/* ============ 3. Code generation (CSE + temporaries) ============ */

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
        // Compare real parts only (the imaginary part is ignored); returns 1/0
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
      default: throw new Error('unknown node ' + node.k);
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
    // General complex power exp(w·log z)
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
    throw new Error('unimplemented function ' + name);
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

  // ---- Whole-loop variant: the for loop is generated too, so the JIT can keep state in registers ----
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
    '    if (dx * dx + dy * dy < 1e-30) { n = maxIter; m2 = -1; break; }',
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

/* ============ 4. LaTeX serialisation ============ */

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

/* ============ 5. Public API ============ */

/**
 * Compile a multi-line formula: the leading lines may define f(x)=…, the last line is the iteration
 * @returns {{ok:boolean, fn?:Function, latex?:string, error?:string, src?:string, defs:number}}
 */
/* Complexity budget for one iteration formula.
 *
 * The expression is expanded (user functions are macro-substituted) and inlined
 * into a single JS closure that runs per pixel, per iteration, so a formula
 * with N nodes costs N flops times pixels times iterations.  z^2+c is 4 nodes;
 * a hand-written "artistic" formula is 50–150.  Past a few hundred the picture
 * stops being a fractal and becomes a way to lock the renderer up, so the
 * compiler refuses it with an explanation instead of freezing the window. */
const kMaxNodes = 600;
const kMaxDepth = 48;

function measureAst(node) {
  let nodes = 0, depth = 0;
  const walk = (n, d) => {
    if (!n || d > 256) return;
    nodes++;
    if (d > depth) depth = d;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && c.k) walk(c, d + 1); }
      else if (v && v.k) walk(v, d + 1);
    }
  };
  walk(node, 1);
  return { nodes, depth };
}

export function compile(source) {
  /* Keep the original line number with each line: an error message that only
   * says "column 7" is useless in a multi-line formula, and silently throwing
   * away the position would turn a real syntax error into a flat colour. */
  const raw = String(source || '').split('\n');
  const lines = [];
  raw.forEach((s, i) => {
    const txt = s.trim();
    if (txt && !txt.startsWith('#') && !txt.startsWith('//')) lines.push({ txt, no: i + 1 });
  });

  const userFns = {};
  let main = null;
  let defs = 0;

  /** Re-throw a parse error with the source line it came from. */
  const at = (e, no) => { if (e && e.pos != null && e.line == null) e.line = no; return e; };

  for (const { txt, no } of lines) {
    const m = /^([A-Za-z]\w*)\s*\(\s*([A-Za-z]\w*)\s*\)\s*=\s*(.+)$/.exec(txt);
    if (m && !['sum', 'prod', 'piecewise'].includes(m[1])) {
      const [, name, param, bodySrc] = m;
      let body;
      try { body = parse(bodySrc, { functions: userFns }); } catch (e) { throw at(e, no); }
      userFns[name] = { name, params: [param], body };
      defs++;
      continue;
    }
    if (main !== null) {
      throw err('only one iteration formula is allowed (other lines must be written as f(x)=…)', 0);
    }
    main = { txt, no };
  }
  if (main === null) throw err('missing iteration formula', 0);

  let ast;
  try { ast = parse(main.txt, { functions: userFns }); } catch (e) { throw at(e, main.no); }
  /* A formula is expanded and inlined into one JS function, so its cost is
   * paid per pixel per iteration.  An expression of a few hundred nodes is
   * already 20x the work of z^2 + c; one with thousands is not a fractal any
   * more, it is a way to hang the renderer for minutes with no warning.  Refuse
   * it up front, with a message the formula dialog can show. */
  const budget = measureAst(ast);
  if (budget.nodes > kMaxNodes) {
    throw err(`formula too complex: ${budget.nodes} operations (limit ${kMaxNodes}) — simplify it, or split it with f(x)=… helpers`, 0);
  }
  if (budget.depth > kMaxDepth) {
    throw err(`formula nested too deeply (${budget.depth} levels, limit ${kMaxDepth}) — flatten the nesting`, 0);
  }
  const params = (ast.params || []).filter(n => !VARIABLES.includes(n));
  const allParams = (ast.params || []);
  const { fn, step } = generate(ast, { params: allParams, loop: true });
  return { ok: true, fn, step, ast, latex: toLatex(ast), params: allParams, defs };
}

/** Validate only: returns the LaTeX or throws */export function preview(source) {
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
