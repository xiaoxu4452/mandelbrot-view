/**
 * gen-schemes.mjs — build the embedded official GLSL scheme library.
 *
 * The reference program ships its colour recipes as `codegl` strings, not as
 * palette tables: six custom schemes in `examples/*.json` and six built-in
 * ones in `colorschemes.json`.  Every one of them declares `nparam`, the
 * number of `params.param[i]` sliders the original UI shows; those are the
 * official controls we import alongside the shaders.
 *
 * Everything is written into ONE file (`src/ui/js/schemes-data.js`) so the
 * library stays in memory, switchable by language, and needs no file I/O at
 * runtime — the same rule the preset library follows.  Re-run this script
 * only when the reference material changes.
 *
 *   node src/tools/gen-schemes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REF = 'C:/Users/harve/Desktop/mande/04_配置与示例';
const OUT = resolve(ROOT, 'src/ui/js/schemes-data.js');

const read = (p) => JSON.parse(readFileSync(`${REF}/${p}`, 'utf8'));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/* Original names, kept for the English side; the Chinese labels are the
 * project's own translations and live here so switching language never
 * needs a lookup table at runtime. */
const NAMES = {
  'Amethyst Crown': ['紫晶冠', '距离缩放', 'Distance scale'],
  'Nebula Bloom': ['星云绽放', '距离缩放', 'Distance scale'],
  'Rainbow Veins': ['虹脉', '距离缩放', 'Distance scale'],
  'Chinese Remainder Clock': ['中国剩余时钟', '距离缩放', 'Distance scale'],
  'High Precision Rainbow': ['高精度彩虹', '迭代上限', 'Iteration limit'],
  'Iteration with limit': ['限幅迭代', '迭代上限', 'Iteration limit'],
  'Distance': ['距离轮廓', '距离缩放', 'Distance scale'],
  'Distance and iteration levels': ['距离 + 迭代层级', '距离缩放', 'Distance scale'],
  'Texture': ['纹理', '纹理阈值', 'Texture threshold']
};

/* `parameters.colors` in the examples is `UniformsColor[]`: rgb + frequency
 * + initial.  Flatten to the 5-tuple the GPU path already consumes. */
function flatColors(colors) {
  if (!Array.isArray(colors)) return [];
  return colors.slice(0, 20).map((c) => {
    const rgb = c.rgb || [1, 1, 1];
    return [num(rgb[0], 1), num(rgb[1], 1), num(rgb[2], 1),
            num(c.frequency, 0), num(c.initial, 0)];
  });
}

/* Default `params.param[]`.  The reference's own examples only carry a
 * `custom` array when a slider was moved; the neutral value for a distance
 * scale is 0.33 (Texture spells it out: exp((-param+0.33)*5)).  Iteration
 * limits use the value shipped in `custom` (0.117... => ~11.7 iterations). */
function defaults(name, custom, nparam) {
  const limit = name.includes('Rainbow') || name.includes('limit');
  const out = [];
  for (let i = 0; i < nparam; ++i) {
    const shipped = Array.isArray(custom) ? num(custom[i], NaN) : NaN;
    out.push(isFinite(shipped) ? shipped : (limit ? 0.117 : (i === 0 ? 0.33 : 0.3)));
  }
  return out;
}

/* An official scheme was authored at a particular view.  Its codegl often
 * paints the exterior a flat colour and reserves the detail for the boundary
 * (Amethyst Crown is exactly that: `else color = vec3(0.12,0.02,0.18)`), so
 * installing the shader without the view shows a solid rectangle.  Keep the
 * authored centre/span/rotation with the recipe.  span = 2/zoom, normalised
 * to a mantissa in [1,2) and a binary exponent. */
function viewOf(d) {
  if (d.x == null || d.y == null || d.zoom == null) return null;
  const z = Number(d.zoom);
  if (!isFinite(z) || z <= 0) return null;
  let m = 2 / z, e = 0;
  while (m >= 2) { m /= 2; ++e; }
  while (m > 0 && m < 1) { m *= 2; --e; }
  return {
    re: String(d.x), im: String(d.y),
    m, e,
    rotation: Number(d.rotation) || 0
  };
}

function labels(name, nparam) {
  const meta = NAMES[name] || [name, '参数', 'Parameter'];
  const out = [];
  for (let i = 0; i < nparam; ++i) {
    if (i === 0) out.push({ zh: meta[1], en: meta[2] });
    else out.push({ zh: '细节距离', en: 'Detail distance' });
  }
  return out;
}

const lib = [];
let seq = 0;
const push = (o) => lib.push({ ...o, id: `glsl:${++seq}` });

/* ---- custom schemes shipped as examples -------------------------------- */
const files = [
  'examples/Amethyst Crown.json',
  'examples/Nebula Bloom.json',
  'examples/Rainbow Veins.json',
  'examples/HighPrecision_Rainbow.json',
  'examples/Retinajulia Example 4.json',      // Chinese Remainder Clock
  'examples/Retinamandelbrot Example 12.json' // Iteration with limit
];
for (const f of files) {
  const d = read(f);
  const cs = d.parameters?.colorscheme;
  if (!cs?.codegl) { console.warn('skip (no codegl):', f); continue; }
  const p = d.parameters || {};
  const name = String(cs.name || '').trim();
  const nparam = Math.max(0, Math.min(4, cs.nparam | 0));
  const meta = NAMES[name] || [name, '参数', 'Parameter'];
  push({
    key: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name, nameZh: meta[0], group: 'art',
    view: viewOf(d),
    nparam,
    params: defaults(name, p.custom, nparam),
    paramLabels: labels(name, nparam),
    colors: flatColors(p.colors),
    /* loadParams (00546630.c:79/:87) uploads exp(f_i + F) and init_i + I.
     * F/I are the file's global keys; when absent the program's initParams
     * defaults apply (00545d80.c:29: F = -ln(10), I = 0).  A scheme that
     * dropped them would upload raw log numbers into pal() and lose its
     * whole colour cycle. */
    gf: p.frequency != null ? num(p.frequency, -Math.LN10) : -Math.LN10,
    gi: num(p.initial, 0),
    briFinite: num(p.brightnessfinite, 1),
    briInfinite: num(p.brightnessinfinite, 1),
    briFactor: num(p.brightnessfactor, 1),
    samples: Math.max(1, Math.min(4, cs.samples | 0 || 2)),
    channels: cs.channels == null ? null : (cs.channels >>> 0),
    glsl: cs.codegl
  });
}

/* ---- built-in schemes that expose official sliders ---------------------- */
for (const cs of read('colorschemes.json')) {
  const nparam = Math.max(0, Math.min(4, cs.nparam | 0));
  if (!nparam || !cs.codegl) continue;         // the other three have no UI
  const name = cs.name;
  const meta = NAMES[name] || [name, '参数', 'Parameter'];
  push({
    key: 'ref-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name, nameZh: meta[0], group: 'official',
    view: null,
    nparam,
    params: defaults(name, null, nparam),
    paramLabels: labels(name, nparam),
    colors: [],                                 // these use pal(), not params.color
    gf: -Math.LN10, gi: 0,
    briFinite: 1, briInfinite: 1, briFactor: 1,
    samples: Math.max(1, Math.min(4, cs.samples | 0 || 2)),
    channels: cs.channels == null ? null : (cs.channels >>> 0),
    glsl: cs.codegl
  });
}

const body = `/* Generated by src/tools/gen-schemes.mjs — DO NOT EDIT BY HAND.
 * Reference: Retinamandelbrot for Windows Beta, 04_配置与示例/.
 * ${lib.length} official GLSL colour recipes, embedded so the library is a
 * pure in-memory lookup (no file I/O, instant zh/en switching).
 *
 * Each entry carries the original codegl, the number of official
 * params.param[] sliders (nparam), their neutral values and labels, the
 * UniformsColor table its shader reads, and the samples count it shipped with.
 */
export const SCHEME_LIB = ${JSON.stringify(lib, null, 2)};

export function findScheme(id) {
  if (!id) return null;
  return SCHEME_LIB.find(s => s.id === id || s.key === id) || null;
}
`;
writeFileSync(OUT, body, 'utf8');
console.log(`[schemes] ${lib.length} schemes, ${(body.length / 1024).toFixed(1)} KB -> src/ui/js/schemes-data.js`);
for (const s of lib) console.log(`   ${s.id.padEnd(9)} ${s.name.padEnd(34)} nparam=${s.nparam} colors=${s.colors.length} samples=${s.samples}`);
