import fs from 'node:fs';

/* ---------- 逃逸时间（双精度） ---------- */
function esc(cr, ci, max) {
  let zr = 0, zi = 0;
  for (let n = 0; n < max; n++) {
    const t = zr * zr - zi * zi + cr;
    zi = 2 * zr * zi + ci;
    zr = t;
    if (zr * zr + zi * zi > 4) return n;
  }
  return max;
}

/* ---------- 扫描边界点 ---------- */
const GX = 420, GY = 300;
const X0 = -2.2, X1 = 0.9, Y0 = -1.25, Y1 = 1.25;
const cands = [];
for (let j = 0; j < GY; j++) {
  for (let i = 0; i < GX; i++) {
    const cr = X0 + (i / GX) * (X1 - X0);
    const ci = Y0 + (j / GY) * (Y1 - Y0);
    const n = esc(cr, ci, 300);
    if (n > 40 && n < 300) cands.push({ cr, ci, n });
  }
}
console.log('候选边界点', cands.length);

/* ---------- 最远点采样保证分布 ---------- */
function farSample(list, k, spread) {
  const picked = [list[Math.floor(list.length / 2)]];
  while (picked.length < k) {
    let best = null, bestD = -1;
    for (const p of list) {
      let d = 1e9;
      for (const q of picked) {
        const dx = p.cr - q.cr, dy = p.ci - q.ci;
        const dd = dx * dx + dy * dy;
        if (dd < d) d = dd;
      }
      if (d > bestD) { bestD = d; best = p; }
    }
    if (!best) break;
    picked.push(best);
    if (Math.sqrt(bestD) < spread) break;
  }
  return picked;
}

const boundary = farSample(cands, 70, 0.02);
console.log('采样点', boundary.length);


/* ---------- 构图评分：粗网格采样，判断该视野是否有结构 ---------- */
function scoreView(cr0, ci0, span, maxIter, julia) {
  const GX = 15, GY = 11;
  const vals = [];
  let inside = 0;
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const cr = cr0 + (i / (GX - 1) - 0.5) * span;
      const ci = ci0 + (j / (GY - 1) - 0.5) * span * 0.7;
      let zr = julia ? cr : 0, zi = julia ? ci : 0;
      const ar = julia ? julia.re : cr, ai = julia ? julia.im : ci;
      let n = 0, out = false;
      for (; n < maxIter; n++) {
        const t = zr * zr - zi * zi + ar;
        zi = 2 * zr * zi + ai;
        zr = t;
        if (zr * zr + zi * zi > 1e10) { out = true; break; }
      }
      if (!out) { inside++; vals.push(maxIter); }
      else vals.push(n + 1 - Math.log2(Math.log(Math.sqrt(zr * zr + zi * zi)) / Math.log(1e5)));
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  let v = 0;
  for (const x of vals) v += (x - mean) * (x - mean);
  const sd = Math.sqrt(v / vals.length);
  const insideFrac = inside / vals.length;
  // 结构丰富的判断：有一定内部比例 + 明显变化
  let score = sd / (1 + Math.abs(sd) * 0.002);
  if (insideFrac < 0.08 || insideFrac > 0.9) score *= 0.35;
  return { score, sd, insideFrac };
}

/** 在锚点附近搜索最佳构图 */
function refine(cr, ci, span, maxIter, julia) {
  let best = null;
  const offs = [[0, 0]];
  const R = [0.08, 0.18, 0.3];
  for (const r of R) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + r * 7;
      offs.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
  }
  for (const [ox, oy] of offs) {
    const cx = cr + ox * span, cy = ci + oy * span;
    const s = scoreView(cx, cy, span, maxIter, julia);
    if (!best || s.score > best.score) best = { ...s, cx, cy };
  }
  return best;
}

/* ---------- 命名池 ---------- */
const NAMES = [
  ['海马谷', 'Seahorse Valley'], ['珊瑚礁', 'Coral Reef'], ['象鼻峡谷', 'Elephant Gorge'],
  ['螺旋臂', 'Spiral Arm'], ['星尘群', 'Stardust Cluster'], ['双曲穹顶', 'Hyperbolic Dome'],
  ['枝状闪电', 'Branching Bolt'], ['微型宇宙', 'Micro Cosmos'], ['丝状结构', 'Filament Field'],
  ['涡旋核', 'Vortex Core'], ['苔原', 'Tundra'], ['晶簇', 'Crystal Cluster'],
  ['潮汐盆地', 'Tidal Basin'], ['尖峰带', 'Cusp Belt'], ['深空回廊', 'Deep Corridor'],
  ['枝晶森林', 'Dendrite Forest'], ['涟漪阵列', 'Ripple Array'], ['孤岛群', 'Archipelago'],
  ['折线迷宫', 'Labyrinth'], ['冷焰', 'Cold Flame'], ['砂丘', 'Dune Field'],
  ['穹顶回音', 'Dome Echo'], ['织网', 'Woven Web'], ['暗礁', 'Sunken Reef']
];

const PALETTES = [
  { id: 'ice', zh: '冰蓝', en: 'Ice', cycle: 8 },
  { id: 'mono', zh: '单色', en: 'Mono', cycle: 6 },
  { id: 'copper', zh: '铜', en: 'Copper', cycle: 10 },
  { id: 'ember', zh: '余烬', en: 'Ember', cycle: 9 },
  { id: 'viridis', zh: '翠绿', en: 'Viridis', cycle: 9 },
  { id: 'twilight', zh: '暮色', en: 'Twilight', cycle: 7 },
  { id: 'ocean', zh: '深海', en: 'Ocean', cycle: 7 },
  { id: 'slate', zh: '石板', en: 'Slate', cycle: 9 }
];

const anchors = [];

/* 1) 自动采样的曼德勃罗锚点 */
const scored = [];
boundary.forEach((p, i) => {
  const depth = [2, 3, 3, 4, 4, 4, 5, 5, 6][i % 9];
  const span = Math.pow(10, -depth);
  const maxIter = 700 + depth * 150;
  const r = refine(p.cr, p.ci, span, maxIter, null);
  scored.push({ p, depth, span, maxIter, r });
});
// 只保留有结构的构图，并按空间分散挑选
const good = scored.filter(s => s.r.score >= 4).sort((a, b) => b.r.score - a.r.score);
const chosen = [];
for (const s of good) {
  if (chosen.length >= 24) break;
  const far = chosen.every(c => Math.hypot(c.r.cx - s.r.cx, c.r.cy - s.r.cy) > 0.035);
  if (far) chosen.push(s);
}
for (const s of good) {
  if (chosen.length >= 24) break;
  if (!chosen.includes(s)) chosen.push(s);
}
console.log('构图合格', good.length, '入选', chosen.length);
chosen.forEach((s, i) => {
  const nm = NAMES[i % NAMES.length];
  anchors.push({
    cat: 'mandelbrot',
    mode: 'm', kind: 'mandelbrot', power: 2,
    cx: s.r.cx.toFixed(12), cy: s.r.cy.toFixed(12),
    spanExp: -s.depth,
    maxIter: s.maxIter,
    score: s.r.score,
    nameZh: `${nm[0]} ${String(i + 1).padStart(2, '0')}`,
    nameEn: `${nm[1]} ${String(i + 1).padStart(2, '0')}`
  });
});

/* 2) 经典地标 */
const LANDMARKS = [
  ['全集全景', 'The Whole Set', '-0.6', '0', 0, 400],
  ['海马谷深处', 'Deep Seahorse Valley', '-0.7436438870371587', '0.1318259042053120', -11, 4000],
  ['大象谷', 'Elephant Valley', '0.275', '0.007', -2, 900],
  ['三重螺旋', 'Triple Spiral', '-0.088', '0.654', -2, 900],
  ['闪电带', 'Lightning Field', '-0.1011', '0.9563', -3, 1200],
  ['迷你集合', 'Mini Mandelbrot', '-1.7687', '0.0038', -3, 1500]
];
LANDMARKS.forEach(([zh, en, cx, cy, se, mi]) => {
  anchors.push({
    cat: 'mandelbrot', mode: 'm', kind: 'mandelbrot', power: 2,
    cx, cy, spanExp: se, maxIter: mi, nameZh: zh, nameEn: en
  });
});

/* 3) 朱丽叶集：以边界点为种子 */
const juliaSeeds = [
  ['道阿迪兔', 'Douady Rabbit', '-0.123', '0.745'],
  ['圣马可', 'San Marco', '-0.75', '0'],
  ['树枝状', 'Dendrite', '0', '1'],
  ['西格尔圆盘', 'Siegel Disk', '-0.390541', '0.586788'],
  ['玄武岩', 'Basilica', '-1', '0'],
  ['双螺旋', 'Double Spiral', '-0.70176', '-0.3842'],
  ['羽毛', 'Plume', '0.285', '0.01'],
  ['火花', 'Sparks', '-0.8', '0.156'],
  ['极光', 'Aurora', '0.37', '0.1'],
  ['潮汐', 'Tide', '-0.4', '0.6'],
];
juliaSeeds.forEach(([zh, en, jr, ji]) => {
  const sc = scoreView(0, 0, 3.0, 400, { re: parseFloat(jr), im: parseFloat(ji) });
  let spanExp = 1;
  if (sc.sd < 12) spanExp = 0;
  anchors.push({
    cat: 'julia', mode: 'j', kind: 'mandelbrot', power: 2,
    julia: { re: jr, im: ji },
    cx: '0', cy: '0', spanExp, maxIter: 800,
    score: sc.score,
    nameZh: zh, nameEn: en
  });
});

/* 4) 其他族 */
const EXOTIC = [
  ['燃烧船·船体', 'Burning Ship · Hull', 'burningship', 'm', '-0.5', '-0.5', 1, 900],
  ['燃烧船·桅杆', 'Burning Ship · Mast', 'burningship', 'm', '-1.7548', '-0.028', -1, 1200],
  ['凯尔特纹', 'Celtic Weave', 'celtic', 'm', '-0.5', '0', 1, 800],
  ['垂直枝', 'Perpendicular', 'perpendicular', 'm', '-0.5', '0', 1, 800],
  ['三叉戟', 'Tricorn', 'tricorn', 'm', '-0.3', '0', 1, 800],
  ['凤凰', 'Phoenix', 'phoenix', 'm', '-0.5', '0', 1, 900],
  ['六枝曼德勃罗', 'Six-fold Multibrot', 'multibrot', 'm', '0', '0', 1, 900],
  ['九枝曼德勃罗', 'Nine-fold Multibrot', 'multibrot', 'm', '0', '0', 1, 900]
];
EXOTIC.forEach(([zh, en, kind, mode, cx, cy, se, mi], i) => {
  anchors.push({
    cat: 'exotic', mode, kind, power: kind === 'multibrot' ? (i === 6 ? 6 : 9) : 2,
    cx, cy, spanExp: se, maxIter: mi, nameZh: zh, nameEn: en
  });
});

/* 5) 牛顿集 */
const NEWTON = [
  ['牛顿·三次', 'Newton · Cubic', 3, 0.55, 60],
  ['牛顿·四次', 'Newton · Quartic', 4, 0.55, 80],
  ['牛顿·五次', 'Newton · Quintic', 5, 0.55, 90],
  ['牛顿·八次', 'Newton · Octic', 8, 0.55, 120],
  ['牛顿·三次内核', 'Newton · Cubic Core', 3, -0.9, 90],
  ['牛顿·四次内核', 'Newton · Quartic Core', 4, -0.9, 110],
  ['牛顿·六次', 'Newton · Sextic', 6, 0.55, 100],
  ['牛顿·七次内核', 'Newton · Heptic Core', 7, -0.9, 130]
];
NEWTON.forEach(([zh, en, deg, se, mi]) => {
  anchors.push({
    cat: 'newton', mode: 'n', kind: 'mandelbrot', newtonDegree: deg,
    cx: '0', cy: '0', spanExp: se, maxIter: mi, nameZh: zh, nameEn: en
  });
});

/* 6) 公式预设（形状截然不同，展示数学库） */
const CUSTOM = [
  ['正弦映射', 'Sine Map', 'sin(z) + c', { a: 0, b: 0, k: 0 }, '0', '-0.88', 0.602, 400],
  ['指数映射', 'Exponential Map', 'exp(z) + c', { a: 0, b: 0, k: 0 }, '3.6', '-1.76', 0.602, 320],
  ['四次多枝', 'Quartic Multibrot', 'z^4 + c', { a: 0, b: 0, k: 0 }, '0.48', '0.352', 0.204, 500],
  ['凤凰式', 'Phoenix Map', 'z^2 + c + 0.5*z_1', { a: 0, b: 0, k: 0 }, '-0.48', '0', 0.204, 500],
  ['幂级数', 'Power Series', 'sum(k, 0, 3, z^3/3^k) + c', { a: 0, b: 0, k: 0 }, '-0.48', '0', 0.204, 500],
  ['迭代复合', 'Iterated Map', 'f(z) = z^2 + c\nf(f(z))/2 + c', { a: 0, b: 0, k: 0 }, '0', '0', 0.204, 500],
  ['三次扰动', 'Cubic Perturbation', 'z^3 + c + a*z', { a: 0.3, b: 0, k: 0 }, '0', '0', 0.204, 500],
  ['共轭立方', 'Conjugate Cubic', 'conj(z)^3 + c', { a: 0, b: 0, k: 0 }, '0', '0', 0.204, 500]
];
CUSTOM.forEach(([zh, en, expr, params, cx, cy, spanExp, mi]) => {
  anchors.push({
    cat: 'custom', mode: 'x', kind: 'mandelbrot', power: 2,
    customExpr: expr, customParams: params,
    cx, cy, spanExp, maxIter: mi, nameZh: zh, nameEn: en
  });
});

const bad = anchors.filter(a => a.score != null && a.score < 6);
console.log('锚点总数', anchors.length, '低分锚点', bad.length, bad.map(a=>a.nameZh+':'+a.score.toFixed(1)).join(', '));

/* ---------- 展开为 512 个预设 ---------- */
const presets = [];
let id = 0;
for (const a of anchors) {
  for (const p of PALETTES) {
    presets.push({
      id: 'p' + String(id++).padStart(3, '0'),
      cat: a.cat,
      mode: a.mode,
      kind: a.kind,
      power: a.power || 2,
      newtonDegree: a.newtonDegree,
      julia: a.julia,
      customExpr: a.customExpr,
      customParams: a.customParams,
      cx: a.cx, cy: a.cy,
      spanExp: a.spanExp,
      maxIter: a.maxIter,
      palette: p.id,
      cycle: p.cycle,
      offset: ((id * 0.137) % 1),
      nameZh: a.nameZh + ' · ' + p.zh,
      nameEn: a.nameEn + ' · ' + p.en,
      base: a.nameZh
    });
  }
}
console.log('预设总数', presets.length);

fs.writeFileSync('js/presets-data.js',
  '/* 自动生成：tools/gen-presets.mjs */\nexport const PRESETS = ' + JSON.stringify(presets, null, 0) + ';\n');
console.log('已写入 js/presets-data.js');
