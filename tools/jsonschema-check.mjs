/**
 * Conformance test for the reference program's JSON loaders.
 *
 * Source of truth: the decompilation in
 *   C:\Users\harve\Desktop\mande\07_反汇编与伪代码\Ghidra\full_pseudocode
 *     005472c0.c readParams          00545e70.c writeParams
 *     00539080.c loadviewportjson   00545d80.c initParams
 *     00546630.c loadParams         00547070.c ColorschemeFromDictionary
 *   C:\Users\harve\Desktop\mande\00_原始项目副本\mandelbrot.exe
 *     INITIALCOLORS @ VA 0x0056bd40 (three float32 quintuples in .rdata)
 *
 * The test deliberately re-implements readParams from that spec rather than
 * calling our own readColors(), so a mistake shared by both sides cannot pass.
 *
 *   node tools/jsonschema-check.mjs [--examples <dir>] [--quiet]
 *
 * The external examples directory is optional: without it the synthetic
 * edge-case suite still runs, so the check works in CI with no local data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importRefPreset, exportRefPreset, readColors, readGlobals,
  defaultRefColors, classifyRefJson, readRefSettings,
  REF_INITIAL_COLORS, REF_MAX_COLORS, REF_MAX_PARAM
} from '../js/refpreset.js';
import { shaderTerms, REF_DEFAULT_LOG_FREQ } from '../js/palettes.js';
import { patchOf, buildObject, thumbPalette } from '../js/presetlib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const QUIET = argv.includes('--quiet');
const EXAMPLES = argOf('--examples',
  'C:/Users/harve/Desktop/mande/04_配置与示例/examples');
const REFERENCE_ROOT = 'C:/Users/harve/Desktop/mande';

let failures = 0, checks = 0;
const near = (a, b, eps = 1e-9) => Math.abs(Number(a) - Number(b)) <= eps;

function ok(cond, label, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}
function eq(a, b, label) { ok(a === b, label, `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function close(a, b, label) {
  ok(near(a, b), label, `${a} != ${b}`);
}

/* ------------------------------------------------------------------
 * Independent transcription of readParams (005472c0.c).
 * ----------------------------------------------------------------*/
const INIT = [
  [1, 0, 0, -2.1202635765075684, -1],
  [0, 1, 0, -1.1363141536712646, -1.5],
  [0, 0, 1, -0.023268627002835274, -0.5]
].map(v => ({ r: v[0], g: v[1], b: v[2], frequency: v[3], initial: v[4] }));

function refColors(parameters) {
  const p = parameters || {};
  const arr = Array.isArray(p.colors) ? p.colors.slice(0, 20) : null;
  if (!arr) return INIT.map(c => ({ ...c }));   // ncolor stays 3
  const out = [];
  arr.forEach((e, i) => {
    const t = i < 3 ? { ...INIT[i] } : { r: 0, g: 0, b: 0, frequency: 0, initial: 0 };
    if (e && !Array.isArray(e) && typeof e === 'object') {
      if (Array.isArray(e.rgb)) {
        if (e.rgb.length > 0) t.r = +e.rgb[0] || 0;
        if (e.rgb.length > 1) t.g = +e.rgb[1] || 0;
        if (e.rgb.length > 2) t.b = +e.rgb[2] || 0;
      }
      if (e.frequency != null) t.frequency = +e.frequency;
      if (e.initial != null) t.initial = +e.initial;
    }
    out.push(t);
  });
  return out;
}

function refGlobals(parameters) {
  const p = parameters || {};
  const n = (k, d) => (p[k] != null && isFinite(+p[k])) ? +p[k] : d;
  return {
    briFinite: n('brightnessfinite', 1),
    briInfinite: n('brightnessinfinite', 1),
    frequency: n('frequency', REF_DEFAULT_LOG_FREQ),
    initial: n('initial', 0),
    inverse: !!n('inverse', 0),
    param: Array.isArray(p.custom) ? p.custom.slice(0, 10).map(v => +v || 0) : []
  };
}

function sameColors(a, b, label) {
  eq(a.length, b.length, label + ' length');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (const k of ['r', 'g', 'b', 'frequency', 'initial']) {
      close(a[i][k], b[i][k], `${label}[${i}].${k}`);
    }
  }
}

function checkPreset(obj, label) {
  const p = obj.parameters || {};
  const cs = p.colorscheme || {};
  const want = refColors(p);
  const wantG = refGlobals(p);

  eq(classifyRefJson(obj), 'preset', label + ' classify');
  const got = importRefPreset(obj);
  /* A file with no `colors` key leaves readParams' INITIALCOLORS in place;
   * the parser signals that with an absent field and patchOf supplies the
   * default table (see defaultRefColors). */
  const resolved = (got.colors && got.colors.length) ? got.colors : defaultRefColors();
  sameColors(resolved, want, label + ' colors');
  const gg = readGlobals(p);
  close(gg.frequency, wantG.frequency, label + ' F');
  close(gg.initial, wantG.initial, label + ' I');
  close(gg.briFinite, wantG.briFinite, label + ' brightnessfinite');
  close(gg.briInfinite, wantG.briInfinite, label + ' brightnessinfinite');
  eq(gg.inverse, wantG.inverse, label + ' inverse');

  if (p.custom) {
    eq((got.param || []).length, Math.min(10, p.custom.length), label + ' custom length');
  }
  if (cs.name) eq(got.schemeName, String(cs.name).trim(), label + ' scheme name');
  if (typeof cs.codegl === 'string' && cs.codegl.trim()) {
    eq(got.glsl, cs.codegl, label + ' codegl');
    ok(!got.schemeBuiltin, label + ' custom scheme is not builtin');
  } else if (cs.name) {
    eq(got.schemeBuiltin, String(cs.name).trim(), label + ' builtin name');
  }
  if (cs.samples != null) eq(got.samples, Math.max(1, cs.samples | 0), label + ' samples');
  if (cs.nparam != null) eq(got.nparam, Math.max(0, Math.min(10, cs.nparam | 0)), label + ' nparam');
  if (cs.channels != null) eq(got.channels, cs.channels >>> 0, label + ' channels');
  if (typeof cs.aux === 'string' && cs.aux.trim()) eq(got.auxfile, cs.aux.trim(), label + ' aux');
  if (obj.flags != null && typeof obj.flags === 'number') {
    eq(got.realmFlags, obj.flags >>> 0, label + ' realm flags');
  }
  const jm = Math.max(0, Math.min(2, Number(p.juliamode) | 0 || 0));
  eq(got.juliamode, jm, label + ' juliamode');
  eq(got.mode === 'j', jm === 2 || !!(obj.flags && obj.flags.julia === true) ||
     !!(obj.spec && obj.spec.mode === 'j'), label + ' mode');

  /* shaderTerms is the only exp() conversion in the pipeline. */
  const shader = shaderTerms(resolved, got.colorFreq, got.colorInit);
  for (let i = 0; i < shader.length; i++) {
    close(shader[i].frequency, Math.exp(want[i].frequency + wantG.frequency),
          `${label} shader frequency[${i}]`);
    close(shader[i].initial, want[i].initial + wantG.initial,
          `${label} shader initial[${i}]`);
  }

  /* A patch must expose the resolved table, and its thumbnail must use the
   * file's global F/I rather than the program default. */
  const patch = patchOf(obj);
  sameColors(patch.colors, want, label + ' patch colors');
  close(patch.colorFreq, wantG.frequency, label + ' patch F');
  const item = { f: 'test:' + label, n: label, col: patch.colors.map(c =>
    [c.r, c.g, c.b, c.frequency, c.initial]), bf: patch.briFinite,
    bi: patch.briInfinite, cf: patch.colorFreq, ci: patch.colorInit };
  const pal = thumbPalette(item);
  ok(!!pal, label + ' thumbnail palette registered');

  /* Round trip: write the view back and re-read it. */
  const exported = buildObject({
    ...patch, name: label, mode: patch.mode,
    colors: patch.colors, colorFreq: patch.colorFreq, colorInit: patch.colorInit,
    briFinite: patch.briFinite, briInfinite: patch.briInfinite,
    briFactor: patch.briFactor, inverse: patch.inverse,
    glsl: patch.glsl, hlsl: patch.hlsl, schemeName: patch.schemeName,
    samples: patch.samples, nparam: patch.nparam, channels: patch.channels,
    auxfile: patch.auxfile, builtin: patch.builtin, param: patch.param,
    juliamode: patch.juliamode, realmFlags: patch.realmFlags,
    initialZoom: patch.initialZoom
  });
  const back = importRefPreset(exported);
  sameColors(back.colors || [], want, label + ' round-trip colors');
  close(back.colorFreq, wantG.frequency, label + ' round-trip F');
  close(back.colorInit, wantG.initial, label + ' round-trip I');
  if (obj.flags != null && typeof obj.flags === 'number') {
    eq(back.realmFlags, obj.flags >>> 0, label + ' round-trip flags');
  }
  if (typeof cs.codegl === 'string' && cs.codegl.trim()) {
    eq(back.glsl, cs.codegl, label + ' round-trip codegl');
  }
  return { want, wantG, got };
}

/* ------------------------------------------------------------------
 * Synthetic edge cases the shipped examples do not cover.
 * ----------------------------------------------------------------*/
function synthetic() {
  console.log('synthetic edge cases');

  /* 1. A partially specified table inherits INITIALCOLORS, not zero. */
  const partial = {
    x: '0', y: '0', zoom: '0.1e1',
    parameters: { frequency: -0.23258, colors: [{ initial: -0.9 }, {}, { initial: -1.0 }] }
  };
  const r = checkPreset(partial, 'partial');
  eq(r.want[0].r, 1, 'partial inherits red');
  eq(r.want[1].g, 1, 'partial inherits green');
  eq(r.want[2].b, 1, 'partial inherits blue');
  close(r.want[0].frequency, INIT[0].frequency, 'partial inherits frequency');
  close(r.want[0].initial, -0.9, 'partial overrides initial');
  ok(r.want[0].frequency !== -0.23258, 'global F is not a per-entry default');

  /* 2. An empty array entry is legal and means "keep the default slot". */
  const emptySlot = {
    x: '0', y: '0', zoom: '0.1e1',
    parameters: { colors: [[], { rgb: [0.2, 0.3] }, {}] }
  };
  const e = checkPreset(emptySlot, 'empty-slot');
  eq(e.want[0].r, 1, 'empty array keeps red');
  eq(e.want[1].r, 0.2, 'short rgb overrides r');
  eq(e.want[1].g, 0.3, 'short rgb overrides g');
  eq(e.want[1].b, 0, 'short rgb leaves b at zero (slot 1 default is 0)');
  close(e.want[1].frequency, INIT[1].frequency, 'short rgb keeps inherited frequency');

  /* 3. No `colors` key at all: readParams resets to INITIALCOLORS. */
  const noColors = { x: '0', y: '0', zoom: '0.1e1', parameters: { frequency: -4 } };
  eq(readColors(noColors.parameters).length, 0, 'no colors -> readColors empty');
  sameColors(defaultRefColors(), INIT, 'defaultRefColors == INITIALCOLORS');
  const np = patchOf(noColors);
  sameColors(np.colors, INIT, 'no colors -> patch uses INITIALCOLORS');
  close(np.colorFreq, -4, 'no colors -> file F still applied');

  /* 4. juliamode 1/2 and our own extensions. */
  const j1 = { x: '0', y: '0', zoom: '1', parameters: { juliamode: 1 } };
  eq(importRefPreset(j1).mode, undefined, 'juliamode 1 leaves the Mandelbrot view');
  eq(importRefPreset(j1).juliaDock, true, 'juliamode 1 opens the Julia dock');
  const j2 = { x: '0', y: '0', zoom: '1', parameters: { juliamode: 2 } };
  eq(importRefPreset(j2).mode, 'j', 'juliamode 2 is the full Julia view');
  const jExt = { x: '0', y: '0', zoom: '1', flags: { julia: true },
                 parameters: { juliamode: 1 }, spec: { mode: 'j' } };
  eq(importRefPreset(jExt).mode, 'j', 'authored Julia cards stay Julia');

  /* 5. Legacy home zoom and numeric realm flags survive a round trip. */
  const legacy = { x: '0', y: '0', initialzoom: '0.5e3', flags: 11,
                   julia_zoom: '0.8e2', julia_initialzoom: '0.4e2',
                   parameters: { colors: [{ rgb: [1, 0, 0] }] } };
  const l = importRefPreset(legacy);
  eq(l.realmFlags, 11, 'numeric realm flags preserved');
  eq(l.initialZoom, '0.5e3', 'initialzoom preserved');
  ok(l.span && l.span.m > 0, 'initialzoom becomes the view span when zoom is absent');
  const lo = buildObject({ ...l, name: 'legacy', mode: 'm',
    colors: l.colors, colorFreq: l.colorFreq, colorInit: l.colorInit });
  eq(lo.flags, 11, 'flags written back');
  eq(lo.initialzoom, '0.5e3', 'initialzoom written back');

  /* 6. NCOLOR / NPARAM limits. */
  const many = { x: '0', y: '0', zoom: '1', parameters: {
    colors: Array.from({ length: 25 }, (_, i) => ({ rgb: [i / 25, 0, 0], frequency: -1, initial: 0 })),
    custom: Array.from({ length: 14 }, (_, i) => i / 10),
    colorscheme: { name: 'wide', codegl: 'vec4 color(Data d){return vec4(1.0);}',
                   channels: 1, nparam: 14, samples: 8 }
  } };
  const m = importRefPreset(many);
  eq(m.colors.length, REF_MAX_COLORS, 'NCOLOR 20');
  eq(m.param.length, REF_MAX_PARAM, 'NPARAM 10');
  eq(m.nparam, REF_MAX_PARAM, 'nparam clamped to 10');
  eq(m.samples, 8, 'samples parsed verbatim (renderer caps it separately)');

  /* 7. The four JSON shapes are told apart. */
  const libPath = path.join(REFERENCE_ROOT, '00_原始项目副本/colorschemes.json');
  const setPath = path.join(REFERENCE_ROOT, '04_配置与示例/mandelbrot.json');
  if (fs.existsSync(libPath)) {
    const lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
    eq(classifyRefJson(lib), 'colorschemes', 'colorschemes.json is a library');
    eq(classifyRefJson(lib[0]), 'scheme', 'one colorscheme dictionary');
  }
  if (fs.existsSync(setPath)) {
    const settings = JSON.parse(fs.readFileSync(setPath, 'utf8'));
    eq(classifyRefJson(settings), 'settings', 'mandelbrot.json is settings');
  }
  const cfg = readRefSettings({ guiscale: 1.25, nthread: 7, highres: true,
                                videooptions: { preset: 'ultrafast' }, junk: 3 });
  eq(cfg.guiscale, 1.25, 'settings guiscale');
  eq(cfg.nthread, 7, 'settings nthread');
  eq(cfg.highres, 1, 'settings boolean -> numeric');
  eq(cfg.videooptions.preset, 'ultrafast', 'settings videooptions');
  ok(!('junk' in cfg), 'settings ignores unknown keys');
  eq(classifyRefJson({ hello: 'world' }), 'unknown', 'unknown shape');
}

/* ------------------------------------------------------------------ */
function examples() {
  if (!fs.existsSync(EXAMPLES)) {
    console.log('examples: skipped (' + EXAMPLES + ' not present)');
    return;
  }
  const files = fs.readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).sort();
  console.log('examples: ' + files.length + ' files from ' + EXAMPLES);
  let inherited = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(EXAMPLES, f), 'utf8').replace(/^\ufeff/, '');
    const obj = JSON.parse(text);
    const before = failures;
    checkPreset(obj, f);
    if (failures === before && !QUIET) console.log('  ok  ' + f);
    const cs = obj.parameters && obj.parameters.colors;
    if (Array.isArray(cs)) {
      for (const c of cs) {
        if (c && typeof c === 'object' && !Array.isArray(c) &&
            (!('rgb' in c) || !('frequency' in c) || !('initial' in c))) inherited++;
      }
    }
  }
  console.log('  partial colour entries covered: ' + inherited);
}

synthetic();
examples();
console.log(`\n${checks} assertions, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
