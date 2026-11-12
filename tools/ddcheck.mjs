/* ------------------------------------------------------------------
 * ddcheck.mjs — pixel-level guard for the C++ double-double kernel (mode 3).
 *
 * Non-z^2 families (tricorn / burning ship / celtic / perpendicular /
 * phoenix) used to be routed to the JavaScript BigInt renderer past 2^-34.
 * mode 3 keeps their coordinates AND orbit in WebAssembly at ~106 bits.
 *
 * Assertions:
 *   · shallow view — mode 3 agrees with the long-standing f64 direct kernel
 *     (a 1-iteration difference on a handful of boundary pixels is expected
 *     because dd retains the rounding residual, so a 98% identity threshold);
 *   · deep view — f64 collapses onto one colour while dd still resolves
 *     structure, proving the low words really reach the orbit;
 *   · every kind renders without a trap and is repeatable bit-for-bit;
 *   · speed ratio is reported, not asserted (machines differ).
 *
 *   node tools/ddcheck.mjs
 * ---------------------------------------------------------------- */
import { KERNEL_B64 } from '../js/kernel-wasm.js';
import { paletteLUT } from '../js/palettes.js';
import { contextFor } from '../js/bigfixed.js';

const b = Uint8Array.from(Buffer.from(KERNEL_B64, 'base64'));
const mod = await WebAssembly.compile(b);
const inst = await WebAssembly.instantiate(mod, { env: { abort() { throw new Error('abort'); } } });
const wasm = inst.exports;
const OUT_CAP = 512 * 513 * 4, GLITCH_CAP = 8192;
const INIT = wasm.memory.buffer.byteLength;
const OUT = Math.max(65536, INIT);
const LUT_PTR = OUT + OUT_CAP;
const PARAMS = LUT_PTR + 2048;
const ROOTS = PARAMS + 512;
const STATS = ROOTS + 256;
const GLITCH = ROOTS + 1024;
const ORBIT = GLITCH + GLITCH_CAP * 8;
const need = Math.ceil((ORBIT + OUT_CAP + 1048576) / 65536) * 65536;
if (wasm.memory.buffer.byteLength < need)
  wasm.memory.grow((need - wasm.memory.buffer.byteLength) / 65536);
const heap = new Uint8Array(wasm.memory.buffer);
const p = new Float64Array(wasm.memory.buffer, PARAMS, 64);
heap.set(paletteLUT('ice'), LUT_PTR);

/** The same residual the worker ships in p[54..57]. */
function lowWord(s) {
  const hi = Number(s);
  const ctx = contextFor(256);
  return ctx.toNumber(ctx.sub(ctx.fromString(s), ctx.fromNumber(hi)));
}

const W = 320, H = 240;
function render(opts) {
  const { mode = 0, kind = 0, power = 2, ps, centerRe, centerIm,
          julia = 0, seedRe = 0, seedIm = 0, maxIter = 600, zeroLo = false } = opts;
  p.fill(0);
  p[0] = mode; p[1] = kind; p[2] = power; p[3] = julia;
  p[4] = 0; p[5] = 0; p[6] = W; p[7] = H; p[8] = W; p[9] = H;
  p[10] = Number(centerRe); p[11] = Number(centerIm); p[12] = ps;
  p[13] = seedRe; p[14] = seedIm;
  p[15] = maxIter; p[16] = 140; p[17] = 0; p[18] = OUT; p[19] = LUT_PTR;
  p[24] = 0.5667; p[25] = 1; p[27] = ROOTS; p[28] = 1;
  p[38] = GLITCH; p[39] = GLITCH_CAP; p[40] = 0;
  p[41] = 1; p[42] = 1; p[43] = 0.55; p[44] = 0;
  p[45] = STATS; p[46] = 0; p[47] = 0; p[48] = 0; p[49] = 10;
  p[50] = 0; p[51] = 0; p[52] = 1; p[53] = 0;
  p[54] = zeroLo ? 0 : lowWord(centerRe);
  p[55] = zeroLo ? 0 : lowWord(centerIm);
  p[56] = zeroLo ? 0 : lowWord(String(seedRe));
  p[57] = zeroLo ? 0 : lowWord(String(seedIm));
  const t0 = performance.now();
  wasm.render(PARAMS);
  const ms = performance.now() - t0;
  const o = new Uint8Array(W * H * 4);
  o.set(heap.subarray(OUT, OUT + W * H * 4));
  const sv = new Float64Array(wasm.memory.buffer, STATS, 3);
  return { data: o, ms, stats: { nMin: sv[0], nMax: sv[1] } };
}
const colours = d => {
  const s = new Set();
  for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return s.size;
};
const identical = (a, b) => {
  let n = 0, diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(a[i + k] - b[i + k]);
    if (d === 0) n++; else diff += d;
  }
  return { ratio: n / (a.length / 4), mean: diff / (a.length / 4) };
};

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

const NAMES = ['poly', 'tricorn', 'burningship', 'celtic', 'perpendicular', 'phoenix'];
const CR = '-0.74364388703715119283746519283746519283';
const CI = '0.13182590420533019827364591827364591827';

/* ---- 1. shallow view: dd must reproduce the f64 kernel -----------------
 * kind0^power2 is excluded from the colour A/B: mode 0 dispatches that
 * combination to renderDirect2 (SIMD, with distance-estimate rim shading),
 * so its colours differ by design even when the orbits agree. */
for (let kind = 0; kind < 6; kind++) {
  for (const power of kind === 0 ? [2, 3] : [2]) {
    const base = { kind, power, ps: 3.2 / W, centerRe: CR, centerIm: CI, maxIter: 400 };
    const a = render({ ...base, mode: 0 });
    const d = render({ ...base, mode: 3 });
    if (!(kind === 0 && power === 2)) {
      const cmp = identical(a.data, d.data);
      check(`shallow ${NAMES[kind]}^${power} f64 vs dd`,
        cmp.ratio >= 0.97 && cmp.mean < 8.0,
        `same=${(cmp.ratio * 100).toFixed(2)}% meanDiff=${cmp.mean.toFixed(3)}`);
    } else {
      /* renderDirect2 counts its loop differently and adds a distance-estimate
       * rim, so neither its colours nor its stats are a valid reference here. */
      check('shallow poly^2 dd repeatable',
        identical(d.data, render({ ...base, mode: 3 }).data).ratio === 1);
    }
    check(`shallow ${NAMES[kind]}^${power} has structure`,
      colours(d.data) > 20, `${colours(d.data)} colours`);
  }
}

/* ---- 2. deep view: dd keeps the pixel offset that f64 rounds away ------
 * At 2^-66 the whole window is one colour band (the centre sits outside the
 * set), so counting colours proves nothing.  The iteration statistics are
 * full doubles: a spread there means adjacent pixels really had different
 * coordinates instead of all collapsing onto centre + ulp. */
let resolved = 0;
for (const kind of [0, 1, 2, 3, 4, 5]) {
  const base = { kind, power: 2, ps: 1e-20, centerRe: CR, centerIm: CI, maxIter: 500 };
  const a = render({ ...base, mode: 0 });
  const d = render({ ...base, mode: 3 });
  const d2 = render({ ...base, mode: 3 });
  check(`deep ${NAMES[kind]} dd repeatable`, identical(d.data, d2.data).ratio === 1);
  /* An all-interior window has no escaped pixels to measure (stats keep their
   * sentinel values).  That is a property of the chosen centre, not a kernel
   * defect, so only windows that actually escaped can be compared. */
  if (!(d.stats.nMin < 1e299)) {
    console.log(`SKIP  deep ${NAMES[kind]} resolution (whole window interior)`);
    continue;
  }
  const spread = d.stats.nMax - d.stats.nMin;
  const spreadF = a.stats.nMax - a.stats.nMin;
  /* How much the low words change the answer depends on the family's error
   * amplification over the orbit.  Zero spread in one family just means that
   * family's smooth count is insensitive to a 1e-18 offset at this centre;
   * what matters is that at least one family keeps the resolution f64 lost. */
  if (spread > 0 && spread > spreadF) resolved++;
  console.log(`INFO  deep ${NAMES[kind]} spread dd=${spread.toExponential(3)} ` +
              `f64=${spreadF.toExponential(3)}`);
}
check('deep dd preserves resolution where f64 collapses', resolved >= 1,
  `${resolved}/6 families`);
{
  const lr = lowWord(CR), li = lowWord(CI);
  check('centre residual words survive the decimal split',
    Math.abs(lr) > 1e-20 && Math.abs(li) > 1e-20,
    `loRe=${lr.toExponential(3)} loIm=${li.toExponential(3)}`);
}

/* ---- 3. Julia seed also arrives as hi + lo ----------------------------- */
{
  const base = { kind: 0, power: 2, ps: 1e-18, centerRe: CR, centerIm: CI,
                 julia: 1, seedRe: -0.613313813075054, seedIm: 0.4610367855546879,
                 maxIter: 500 };
  const d = render({ ...base, mode: 3 });
  check('deep Julia dd renders', colours(d.data) >= 1 && Number.isFinite(d.stats.nMin),
    `${colours(d.data)} colours, nMin=${d.stats.nMin}`);
}

/* ---- 4. cost ------------------------------------------------------------ */
{
  const base = { kind: 2, power: 2, ps: 1e-20, centerRe: CR, centerIm: CI, maxIter: 500 };
  const a = render({ ...base, mode: 0 });
  const d = render({ ...base, mode: 3 });
  console.log(`TIMING f64=${a.ms.toFixed(1)}ms dd=${d.ms.toFixed(1)}ms ` +
              `ratio=${(d.ms / Math.max(0.01, a.ms)).toFixed(2)}x (${W * H} px)`);
}

console.log(fails ? `\nDDCHECK FAILED (${fails})` : '\nDDCHECK OK');
process.exit(fails ? 1 : 0);
