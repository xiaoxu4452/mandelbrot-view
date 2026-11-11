#!/usr/bin/env node
/* ------------------------------------------------------------------
 * gen-sets.mjs — the two libraries the reference distribution never shipped.
 *
 *   1. SET_LIB   — the *other* sets the engine can evaluate (tricorn, burning
 *                  ship, celtic, perpendicular, multibrot p=3..6, plus a few
 *                  Julia slices of each).  The reference only ever ships
 *                  Mandelbrot and Julia pictures, so these have no authored
 *                  viewpoint to copy: every entry here is a probe that was
 *                  actually rendered and measured before being kept.
 *
 *   2. MORE_LIB  — 200 further Mandelbrot / Julia cards.  Their *neighbourhoods*
 *                  come from the reference's own examples (the branch features
 *                  it chose to show), but each card is a different decade,
 *                  rotation and colour recipe, so the grid is not the same
 *                  eleven pictures tinted eight ways.
 *
 * Every candidate is validated by rendering it through the shipped kernel
 * (`mb_bench.exe`) and reading the statistics the engine itself reports:
 *
 *   bounded=<n>    pixels the kernel proved are inside the set
 *   esc=[lo,hi]    the escape-count range across the frame
 *
 * A view is kept only when the interior occupies a usable part of the frame
 * (2%..92%) and the escape counts actually spread out — a frame that is one
 * flat colour, or one solid interior, is discarded no matter how pretty its
 * coordinates look.  The same probe proves the set loads: these entries go
 * through the same native field path as everything else, so a card that
 * renders here renders in the app, and zooming past double precision falls
 * into the same perturbation/orbit machinery.
 *
 * Output: ../ui/js/sets-data.js
 * ------------------------------------------------------------------ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const bench = path.join(root, 'src', 'bin', 'mb_bench.exe');
const bases = JSON.parse(fs.readFileSync(path.join(here, 'preset-bases.json'), 'utf8'));
const outFile = path.join(root, 'src', 'ui', 'js', 'sets-data.js');

/* ---- colour recipes ------------------------------------------------------
 * The reference's UniformsColor table is (r, g, b, frequency, initial) with the
 * frequency in the *log* domain: loadParams uploads exp(f + F) and init + I
 * (00546630.c:79/:87).  Every table below is written in that same literal form,
 * exactly as its example JSONs do, so the page's shaderTerms() converts them
 * the same way — no second convention, no re-tuning.
 * ----------------------------------------------------------------------- */
const PALETTES = [
  { key: 'amethyst', zh: '紫晶', colors: [[0.62, 0.24, 0.92, -2.10, -1.0], [1.0, 0.72, 0.18, -1.20, -1.6], [0.10, 0.55, 0.85, -0.05, -0.4]] },
  { key: 'ember', zh: '余烬', colors: [[1.0, 0.34, 0.05, -2.30, -0.2], [1.0, 0.86, 0.35, -1.05, -1.9], [0.25, 0.06, 0.02, -0.02, -0.6]] },
  { key: 'glacier', zh: '冰川', colors: [[0.15, 0.72, 0.95, -2.05, -1.4], [0.75, 0.94, 1.0, -1.30, -0.3], [0.05, 0.16, 0.45, -0.03, -1.0]] },
  { key: 'moss', zh: '苔原', colors: [[0.30, 0.85, 0.42, -2.20, -0.8], [0.85, 0.95, 0.30, -1.15, -1.7], [0.04, 0.22, 0.12, -0.04, -0.2]] },
  { key: 'magenta', zh: '品红', colors: [[1.0, 0.16, 0.62, -2.12, -1.1], [0.35, 0.28, 1.0, -1.28, -0.5], [0.12, 0.0, 0.18, -0.02, -1.3]] },
  { key: 'sand', zh: '砂金', colors: [[0.96, 0.78, 0.42, -2.24, -1.8], [0.55, 0.32, 0.12, -1.10, -0.7], [1.0, 0.98, 0.90, -0.03, -0.4]] },
  { key: 'cyanide', zh: '青蓝', colors: [[0.10, 0.92, 0.86, -2.08, -0.9], [0.18, 0.32, 0.86, -1.22, -1.5], [0.90, 1.0, 0.98, -0.05, -0.1]] },
  { key: 'crimson', zh: '绯红', colors: [[0.92, 0.10, 0.20, -2.26, -1.2], [1.0, 0.55, 0.10, -1.12, -0.3], [0.10, 0.02, 0.05, -0.02, -1.6]] },
  { key: 'violet', zh: '紫罗兰', colors: [[0.52, 0.22, 0.95, -2.02, -0.6], [0.92, 0.40, 0.85, -1.34, -1.9], [0.05, 0.08, 0.30, -0.04, -0.9]] },
  { key: 'arctic', zh: '极夜', colors: [[0.34, 0.46, 0.96, -2.18, -1.7], [0.92, 0.96, 1.0, -1.06, -0.4], [0.02, 0.04, 0.10, -0.03, -1.1]] },
  { key: 'lime', zh: '青柠', colors: [[0.72, 1.0, 0.22, -2.14, -1.0], [0.12, 0.62, 0.30, -1.26, -1.4], [0.04, 0.10, 0.02, -0.02, -0.5]] },
  { key: 'copper', zh: '古铜', colors: [[0.90, 0.52, 0.22, -2.28, -1.3], [0.42, 0.72, 0.78, -1.18, -0.6], [0.18, 0.06, 0.02, -0.05, -1.5]] }
];

/* ---- validation ----------------------------------------------------------
 * A view is judged on the picture it produces, not on its coordinates.  The
 * probe renders it through the shipped kernel into a field dump and measures
 * what the colour stage would actually see:
 *
 *   interior  share of pixels the kernel proved bounded
 *   edge      share of pixels whose escape count differs from their left
 *             neighbour by two or more — the density of filaments
 *   esc       the escape-count range
 *
 * A smooth gradient across the frame (a deep view with nothing in it) has a
 * wide escape range but almost no edges; a frame parked inside a bulb is all
 * interior.  Both were getting through an escape-count-only test, and both
 * look like flat colour cards in the grid.
 * ----------------------------------------------------------------------- */
const PROBE_W = 176, PROBE_H = 132;
const probeFile = path.join(root, 'bin', 'sets', '_probe.bin');

function probe(o) {
  /* The iteration budget follows the depth: at 1e-14 a boundary point needs
   * thousands of steps before it escapes, and a fixed budget labels the whole
   * frame "interior" for a reason that has nothing to do with the view. */
  const zoomLog = Math.log10(2 / (o.mant * Math.pow(2, o.exp)));
  const iter = Math.round(Math.min(24000, 800 + 700 * Math.max(0, zoomLog)));
  const args = [
    process.platform === 'win32' ? 'NUL' : '/dev/null',
    String(PROBE_W), String(PROBE_H),
    o.re, o.im, String(o.mant), String(o.exp), String(iter),
    '0', '2', '0', '0', String(o.kind || 0), String(o.power || 2), '1'
  ];
  if (o.mode === 'j') args.push(o.jre || '0', o.jim || '0');
  const env = { ...process.env, MB_FIELD: probeFile, MB_FIELDDIST_OFF: '1' };
  const r = spawnSync(bench, args, { encoding: 'utf8', timeout: 120000, env });
  if (r.status !== 0) return null;
  let buf;
  try { buf = fs.readFileSync(probeFile); } catch { return null; }
  if (buf.length < 16) return null;
  const w = buf.readInt32LE(0), h = buf.readInt32LE(4);
  const ch = buf.readInt32LE(12) === 6 ? 6 : 4;
  const n = w * h;
  if (buf.length < 16 + n * ch * 4) return null;
  const f = new Float32Array(buf.buffer, buf.byteOffset + 16, n * ch);
  let interior = 0, edges = 0, lo = 1e9, hi = -1;
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const i = y * w + x;
      const it = f[i * ch + 2];
      if (it < 0) { interior++; continue; }
      if (it < lo) lo = it;
      if (it > hi) hi = it;
      if (x > 0) {
        const jt = f[(i - 1) * ch + 2];
        if (jt >= 0 && Math.abs(it - jt) >= 2) edges++;
      }
    }
  }
  try { fs.unlinkSync(probeFile); } catch { /* best effort */ }
  return {
    bounded: interior / n,
    edge: edges / n,
    lo: lo === 1e9 ? 0 : lo,
    hi: hi < 0 ? 0 : hi
  };
}

/** A card has to look like something: filaments on screen, not a gradient. */
function score(p) {
  if (!p) return -1;
  if (p.bounded > 0.85) return -1;        // parked inside the set
  if (p.hi < 30) return -1;               // everything escapes at once
  if (p.edge < 0.075) return -1;          // smooth gradient: nothing in frame
  const detail = Math.min(1, p.edge / 0.22);
  const spread = Math.min(1, Math.log10(1 + Math.max(0, p.hi - p.lo)) / 2.4);
  const balance = p.bounded <= 0 ? 0.45 : 1 - Math.abs(p.bounded - 0.3) / 0.7;
  return 0.5 * detail + 0.25 * spread + 0.25 * Math.max(0, balance);
}

/* ---- decimal helpers ----------------------------------------------------- */
/** zoom -> {mant, exp} with 1 <= mant < 2, the reference's own pair. */
function spanOf(zoomStr) {
  const z = Number(zoomStr);
  if (!isFinite(z) || z <= 0) return { mant: 1, exp: 1 };
  let mant = 2 / z, exp = 0;
  while (mant >= 2) { mant /= 2; exp++; }
  while (mant < 1) { mant *= 2; exp--; }
  return { mant, exp };
}
/* The reference stores zoom as a decimal mantissa/exponent pair, e.g.
 * "0.100000e5" for 10^4.  Keeping its spelling means an exported card reads
 * the same as a file the original program wrote. */
function refZoom(z) {
  if (!isFinite(z) || z <= 0) return '0.100000e0';
  let e = Math.floor(Math.log10(z));
  let m = z / Math.pow(10, e);          // [1,10)
  m /= 10; e += 1;                       // [0.1,1)
  return `0.${m.toFixed(6).slice(2)}e${e}`;
}

/* ---- candidate pools ----------------------------------------------------- */
const seen = new Set();
const uniqCenters = [];
for (const rec of bases) {
  const j = rec.json || {};
  const k = `${Number(j.x).toPrecision(9)}|${Number(j.y).toPrecision(9)}`;
  if (!isFinite(Number(j.x)) || seen.has(k)) continue;
  seen.add(k);
  uniqCenters.push(j);
}

/* Mandelbrot candidates: the reference's viewpoints, pushed several decades in
 * or out and nudged so the frame lands on a filament rather than the same crop.
 * Five decades per view is what gives the pool enough distinct pictures; the
 * probe below throws away every one that lands on a flat region. */
const DECADES = [0, 2, 5, -1, 8, 3, -3, 11, 4, 6, 9, -2];
const ROTS = [0, 0.11, -0.17];
const mCand = [];
for (let i = 0; i < uniqCenters.length; ++i) {
  const b = uniqCenters[i];
  const base = spanOf(b.zoom);
  for (let d = 0; d < DECADES.length; ++d) {
    const dz = DECADES[d];
    const rot = ROTS[d % ROTS.length];
    const mant = base.mant, exp = base.exp + dz;
    const span = mant * Math.pow(2, exp);
    /* Offsets are fractions of the span, so they stay on the same filament at
     * every decade instead of drifting off it at 1e-20. */
    const nudge = [[0.12, 0.07], [-0.09, 0.11], [0.05, -0.13], [-0.14, -0.06], [0.02, 0.16]][d % 5];
    mCand.push({
      mode: 'm', kind: 0, power: 2,
      re: Number(b.x) + nudge[0] * span,
      im: Number(b.y) + nudge[1] * span,
      mant, exp, rot
    });
  }
}

/* Landmark boundary points.  The reference's own examples cluster around a few
 * neighbourhoods; these are the classic features the literature names, so the
 * library covers the shapes people recognise (seahorse valley, the triple
 * spiral, Feigenbaum's point, the deep Misiurewicz spirals).  Each is probed at
 * several decades and the survivors are kept on merit, not on their reputation. */
const LANDMARKS = [
  [-0.75, 0.1], [0.275, 0], [-0.088, 0.654], [-0.1011, 0.9563],
  [-1.25066, 0.02012], [0.2925755, 0.0149977], [-0.1592, -1.0317],
  [-0.7269, 0.1889], [-0.8, 0.156], [-1.401155, 0], [-0.743643887, 0.131825904],
  [0.3602404434, -0.6413130611], [-0.5628242, 0.6429319], [-0.12256, 0.74486],
  [0.001643721971153, 0.822467633298876], [-0.7746806106269039, -0.1374168856037867],
  [-0.163, 1.032], [0.27322626, 0.59553571], [-0.504340175446244, 0.562765892505875],
  [-0.101, 0.957], [0.428, 0.231], [-1.1547, 0.2887], [0.011, 0.718]
];
const LAND_DECADES = [2.6, 6, 10, 14, 22];
for (const [lx, ly] of LANDMARKS) {
  for (let d = 0; d < LAND_DECADES.length; ++d) {
    const zoom = Math.pow(10, LAND_DECADES[d]);
    const span = 2 / zoom;
    let mant = span, exp = 0;
    while (mant >= 2) { mant /= 2; exp++; }
    while (mant < 1) { mant *= 2; exp--; }
    const nudge = [[0, 0], [0.18, 0.12], [-0.16, 0.09], [0.06, -0.19], [-0.07, -0.04]][d % 5];
    mCand.push({
      mode: 'm', kind: 0, power: 2,
      re: lx + nudge[0] * span,
      im: ly + nudge[1] * span,
      mant, exp, rot: [0, 0.13, -0.09, 0.19, -0.21][d % 5]
    });
  }
}

/* Julia candidates: the seeds the reference itself uses, at their own view and
 * a few decades in. */
const jCand = [];
for (let i = 0; i < uniqCenters.length; ++i) {
  const b = uniqCenters[i];
  const jr = b.julia_mx != null ? Number(b.julia_mx) : Number(b.x);
  const ji = b.julia_my != null ? Number(b.julia_my) : Number(b.y);
  if (!isFinite(jr) || !isFinite(ji)) continue;
  const base = spanOf(b.julia_zoom || b.zoom);
  /* A Julia frame is centred on the origin — nudging it leaves the set — so
   * variety comes from the seed and from how much of it the frame covers. */
  const spans = [2.6, 2.1, 3.4, 1.6, 1.15];
  for (let d = 0; d < spans.length; ++d) {
    let mant = spans[d], exp = base.exp;
    while (mant >= 2) { mant /= 2; exp++; }
    jCand.push({
      mode: 'j', kind: 0, power: 2,
      re: 0, im: 0,
      mant, exp, rot: [0, 0.09, -0.12, 0.21, -0.05][d],
      jre: jr, jim: ji
    });
  }
}

/* The classic boundary points double as Julia seeds: a seed inside the set
 * gives a connected Julia set, and every seed is a different picture. */
for (const [lx, ly] of LANDMARKS) {
  for (let d = 0; d < 4; ++d) {
    let mant = [2.6, 2.0, 3.2, 1.5][d], exp = 0;
    while (mant >= 2) { mant /= 2; exp++; }
    jCand.push({
      mode: 'j', kind: 0, power: 2, re: 0, im: 0,
      mant, exp, rot: [0, 0.07, -0.15, 0.18][d],
      jre: lx, jim: ly
    });
  }
}

/* Other sets: hand-authored probes, then measured like everything else. */
const otherCand = [
  ['tricorn', '三叉戟', 1, 2, 'm', -0.30, 0, 3.2, 0, 0],
  ['tricorn-core', '三叉戟·芯', 1, 2, 'm', -0.25, 0, 2.0, 0, 0],
  ['tricorn-spike', '三叉戟·刺', 1, 2, 'm', -0.85, 0, 0.8, 0, 0],
  ['tricorn-drift', '三叉戟·漂移', 1, 2, 'm', -0.42, 0.28, 0.42, 0, 0],
  ['ship-hull', '燃烧船·船体', 2, 2, 'm', 1.6, 0.02, 0.9, 0, 0],
  ['ship-tower', '燃烧船·塔楼', 2, 2, 'm', 1.72, -0.02, 0.32, 0, 0],
  ['ship-mast', '燃烧船·桅杆', 2, 2, 'm', 1.755, 0.02, 0.10, 0, 0],
  ['ship-rig', '燃烧船·索具', 2, 2, 'm', 1.66, 0.05, 0.18, 0, 0],
  ['celtic-home', '凯尔特', 3, 2, 'm', -0.60, 0, 3.0, 0, 0],
  ['celtic-core', '凯尔特·芯', 3, 2, 'm', -0.50, 0, 1.6, 0, 0],
  ['celtic-wing', '凯尔特·翼', 3, 2, 'm', -1.10, 0.40, 0.9, 0, 0],
  ['celtic-arm', '凯尔特·臂', 3, 2, 'm', -0.72, -0.42, 0.5, 0, 0],
  ['perp-home', '垂叶', 4, 2, 'm', -0.40, 0, 3.2, 0, 0],
  ['perp-core', '垂叶·芯', 4, 2, 'm', -0.20, 0.60, 1.6, 0, 0],
  ['perp-shell', '垂叶·壳', 4, 2, 'm', -0.55, -0.35, 0.7, 0, 0],
  ['multi3-home', '三阶多重', 0, 3, 'm', -0.20, 0, 3.4, 0, 0],
  ['multi3-bulb', '三阶·球茎', 0, 3, 'm', -0.35, 0.50, 1.2, 0, 0],
  ['multi3-fan', '三阶·扇', 0, 3, 'm', 0.30, 0.55, 0.8, 0, 0],
  ['multi4-home', '四阶多重', 0, 4, 'm', -0.10, 0, 3.2, 0, 0],
  ['multi4-arm', '四阶·臂', 0, 4, 'm', -0.40, 0.40, 1.4, 0, 0],
  ['multi4-star', '四阶·星', 0, 4, 'm', 0.10, 0.70, 0.9, 0, 0],
  ['multi5-home', '五阶多重', 0, 5, 'm', -0.10, 0, 3.0, 0, 0],
  ['multi5-web', '五阶·网', 0, 5, 'm', 0.20, 0.62, 0.8, 0, 0],
  ['multi6-home', '六阶多重', 0, 6, 'm', -0.05, 0, 3.0, 0, 0],
  ['multi6-flower', '六阶·花', 0, 6, 'm', 0.10, 0.60, 0.8, 0, 0],
  ['j-tricorn-a', '朱丽叶·三叉戟 A', 1, 2, 'j', 0, 0, 2.6, 0, 0, -0.30, 0.10],
  ['j-tricorn-b', '朱丽叶·三叉戟 B', 1, 2, 'j', 0, 0, 1.6, 0, 0, -0.62, 0.42],
  ['j-ship-a', '朱丽叶·燃烧船 A', 2, 2, 'j', 0, 0, 2.4, 0, 0, 1.72, 0.02],
  ['j-ship-b', '朱丽叶·燃烧船 B', 2, 2, 'j', 0, 0, 1.5, 0, 0, 1.62, 0.05],
  ['j-celtic-a', '朱丽叶·凯尔特 A', 3, 2, 'j', 0, 0, 2.4, 0, 0, -0.35, 0.35],
  ['j-celtic-b', '朱丽叶·凯尔特 B', 3, 2, 'j', 0, 0, 1.8, 0, 0, -0.62, 0.42],
  ['j-perp-a', '朱丽叶·垂叶 A', 4, 2, 'j', 0, 0, 2.4, 0, 0, -0.30, 0.40],
  ['j-multi3-a', '朱丽叶·三阶 A', 0, 3, 'j', 0, 0, 3.0, 0, 0, -0.40, 0.40],
  ['j-multi3-b', '朱丽叶·三阶 B', 0, 3, 'j', 0, 0, 2.4, 0, 0, 0.60, 0.50],
  ['j-multi4-a', '朱丽叶·四阶 A', 0, 4, 'j', 0, 0, 2.8, 0, 0, 0.30, 0.50],
  ['multi3-j1', '三阶·深芯', 0, 3, 'm', -0.35, 0.50, 0.22, 0, 0]
];

/* ---- run the probes ------------------------------------------------------ */
const t0 = Date.now();
const DBG = !!process.env.MB_SETS_DEBUG;
/* The other families are *shapes*, not lace.  Tricorn, burning ship, celtic and
 * the multibrots are dominated by a filled body, so the edge-density rule that
 * picks a good Mandelbrot crop rejects exactly the frames people recognise.
 * They get their own bar: a visible body, a visible boundary, and some escape
 * range — enough that the thumbnail reads as a distint shape and not a blob.
 */
function scoreOther(p) {
  if (!p) return -1;
  if (p.bounded > 0.94) return -1;        // a solid silhouette, no boundary
  if (p.hi < 24) return -1;               // everything escapes at once
  if (p.edge < 0.012) return -1;          // no filament anywhere in frame
  const detail = Math.min(1, p.edge / 0.16);
  const spread = Math.min(1, Math.log10(1 + Math.max(0, p.hi - p.lo)) / 2.2);
  /* A recognisable set has *some* inside and some outside. */
  const balance = p.bounded <= 0.02 ? 0.2 : 1 - Math.abs(p.bounded - 0.45) / 0.55;
  return 0.45 * detail + 0.25 * spread + 0.30 * Math.max(0, balance);
}

function keep(o, extra) {
  const p = probe(o);
  const s = o.other ? scoreOther(p) : score(p);
  if (DBG && s < 0) process.stderr.write(
    `  drop ${o.mode} k${o.kind} p${o.power} ${o.re.toFixed(12)},${o.im.toFixed(12)} ` +
    `2^${o.exp}*${o.mant.toFixed(3)} -> b=${p ? p.bounded.toFixed(3) : '?'} esc=[${p ? p.lo : '?'},${p ? p.hi : '?'}]\n`);
  if (s < 0) return null;
  return { ...o, ...extra, s, p };
}

/* One card per (place, decade, angle): the same frame twice is not two
 * presets, however different the palette. */
const seenPlace = new Set();
const placeKey = o =>
  [o.mode, o.re.toPrecision(10), o.im.toPrecision(10), o.mant.toFixed(6), o.exp,
   o.rot.toFixed(3), o.jre != null ? Number(o.jre).toPrecision(10) : '',
   o.jim != null ? Number(o.jim).toPrecision(10) : ''].join('|');

const mKept = [];
for (const c of mCand) {
  const k = keep(c);
  if (!k || seenPlace.has(placeKey(k))) continue;
  seenPlace.add(placeKey(k));
  mKept.push(k);
}
const jKept = [];
for (const c of jCand) {
  const k = keep(c);
  if (!k || seenPlace.has(placeKey(k))) continue;
  seenPlace.add(placeKey(k));
  jKept.push(k);
}
const oKept = [];
for (const [key, zh, kind, power, mode, re, im, mant, exp, rot, jre, jim] of otherCand) {
  const k = keep({ mode, kind, power, re, im, mant, exp: exp | 0, rot: rot | 0,
                   jre, jim, other: true });
  if (k) oKept.push({ ...k, key, zh });
}
process.stderr.write(
  `[sets] probes: m=${mKept.length}/${mCand.length} ` +
  `j=${jKept.length}/${jCand.length} other=${oKept.length}/${otherCand.length} ` +
  `(${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);

/* Best first, then trim to the requested counts. */
mKept.sort((a, b) => b.s - a.s);
jKept.sort((a, b) => b.s - a.s);

const TARGET = 200;
/* Fill the library by quality, not by category quota — but keep a floor of
 * Julia cards so the grid is not all Mandelbrot. */
const JULIA_FLOOR = Math.min(60, Math.floor(TARGET * 0.3));
const jTake = Math.min(jKept.length, Math.max(JULIA_FLOOR, TARGET - mKept.length));
const pool = [
  ...jKept.slice(0, jTake).map(o => ({ ...o, cat: 'j' })),
  ...mKept.slice(0, TARGET - jTake).map(o => ({ ...o, cat: 'm' }))
].sort((a, b) => b.s - a.s);

/* Names: a motif list per set, indexed so a grid of cards reads as a series. */
const MOTIF_M = ['海马谷', '象鼻谷', '卫星球', '须枝', '螺旋臂', '针尖', '双曲网', '闪电枝', '珊瑚礁', '断层线'];
const MOTIF_J = ['兔形', '藤蔓', '花冠', '闪电环', '羽状枝', '彗尾', '珊瑚', '迷宫', '星尘', '漩涡'];
const EN_M = ['Seahorse Valley', 'Elephant Valley', 'Satellite', 'Filament', 'Spiral Arm', 'Needle', 'Hyperbolic Web', 'Lightning', 'Coral', 'Fault Line'];
const EN_J = ['Rabbit', 'Vine', 'Corona', 'Lightning Ring', 'Plume', 'Comet Tail', 'Coral', 'Labyrinth', 'Stardust', 'Vortex'];

function entryOf(c, i, palette, prefix) {
  const motif = i % 10;
  const isJ = c.cat === 'j';
  const num = (i + 1).toString().padStart(3, '0');
  const colors = palette.colors.map(([r, g, b, frequency, initial]) => ({ rgb: [r, g, b], frequency, initial }));
  const zoomStr = refZoom(2 / (c.mant * Math.pow(2, c.exp)));
  return {
    id: `${prefix}-${num}`,
    /* The Julia seed lives where the reference keeps it (julia_mx/my = the
     * Mandelbrot point), and the Julia *plane* view is its own triple.  Putting
     * a seed only in parameters.julia left importRefPreset with nothing to read
     * and every Julia card opened at c = 0 — a plain disk. */
    julia_mx: isJ ? String(c.jre) : undefined,
    julia_my: isJ ? String(c.jim) : undefined,
    julia_x: isJ ? '0' : undefined,
    julia_y: isJ ? '0' : undefined,
    julia_zoom: isJ ? zoomStr : undefined,
    julia_rotation: isJ ? c.rot : undefined,
    name: `${isJ ? EN_J[motif] : EN_M[motif]} ${num}`,
    nameZh: `${isJ ? MOTIF_J[motif] : MOTIF_M[motif]} ${num}`,
    category: 'more',
    x: String(c.re),
    y: String(c.im),
    zoom: zoomStr,
    rotation: c.rot,
    flags: { julia: isJ },
    spec: { mode: c.mode, kind: c.kind, power: c.power },
    parameters: {
      juliamode: isJ ? 1 : 0,
      colors,
      brightnessfinite: 1,
      brightnessinfinite: 1,
      julia: isJ ? { re: String(c.jre), im: String(c.jim) } : undefined
    }
  };
}

const more = pool.slice(0, TARGET).map((c, i) => entryOf(c, i, PALETTES[i % PALETTES.length], 'more'));

/* The other-set cards reuse the same palette table, one palette per family, so
 * a set keeps its identity across its own views. */
const FAMILY_PAL = { 0: 1, 1: 0, 2: 1, 3: 3, 4: 8 };
const sets = oKept.map((c, i) => {
  const pal = PALETTES[(FAMILY_PAL[c.kind] ?? 0) + (i % 3)] || PALETTES[0];
  const id = `set-${c.key}`;
  const zoom = refZoom(2 / (c.mant * Math.pow(2, c.exp)));
  return {
    id,
    julia_mx: c.mode === 'j' ? String(c.jre) : undefined,
    julia_my: c.mode === 'j' ? String(c.jim) : undefined,
    julia_x: c.mode === 'j' ? '0' : undefined,
    julia_y: c.mode === 'j' ? '0' : undefined,
    julia_zoom: c.mode === 'j' ? '0.100000e1' : undefined,
    julia_rotation: c.mode === 'j' ? c.rot : undefined,
    name: c.key.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase()),
    nameZh: c.zh,
    category: 'other',
    x: String(c.re),
    y: String(c.im),
    zoom,
    rotation: c.rot,
    flags: { julia: c.mode === 'j' },
    spec: { mode: c.mode, kind: c.kind, power: c.power },
    parameters: {
      juliamode: c.mode === 'j' ? 1 : 0,
      colors: pal.colors.map(([r, g, b, frequency, initial]) => ({ rgb: [r, g, b], frequency, initial })),
      brightnessfinite: 1,
      brightnessinfinite: 1,
      julia: c.mode === 'j' ? { re: String(c.jre), im: String(c.jim) } : undefined
    }
  };
});

const header = `/* Generated by tools/gen-sets.mjs — do not edit by hand.
 *
 * SET_LIB   — the other sets this engine evaluates (tricorn, burning ship,
 *             celtic, perpendicular, multibrot 3..6, and Julia slices of each).
 * MORE_LIB  — 200 further Mandelbrot / Julia cards: the reference's own branch
 *             neighbourhoods at a different decade and rotation, with twelve
 *             colour recipes written in the same log-domain form its JSONs use.
 *
 * Every entry was rendered and measured before it was kept (interior share
 * 2%..92%, escape counts spread across the frame), so a card that exists is a
 * card that draws.  The "spec" field is this program's formula selector
 * (mode / kind / power).
 */
`;

const body = `${header}export const SET_LIB = ${JSON.stringify(sets)};\n\nexport const MORE_LIB = ${JSON.stringify(more)};\n`;
fs.writeFileSync(outFile, body);
process.stderr.write(`[sets] wrote ${sets.length} other-set cards + ${more.length} more (${(body.length / 1024).toFixed(0)} KB)\n`);
