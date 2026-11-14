/* ------------------------------------------------------------------
 * rebasecheck.mjs — A/B for the KF singleref rebase switch (p[52]).
 *
 * A view whose reference orbit escapes before the iteration budget used to
 * mark nearly every pixel as a perturbation glitch (example-14: 78%, >130 s),
 * because the JS repair loop then had to fix most of the frame with secondary
 * orbits that were just as short.  The C++ kernel already implements rebase;
 * the worker simply forced the switch off.  It is now enabled exactly when
 * orbitLen < 0.9 * maxIter.
 *
 * This tool builds a deliberately short reference orbit and renders the same
 * pixels twice, with the switch off and on, without a browser.
 * ---------------------------------------------------------------- */
import { KERNEL_B64 } from '../js/kernel-wasm.js';
import { paletteLUT } from '../js/palettes.js';

const b = Uint8Array.from(Buffer.from(KERNEL_B64, 'base64'));
const inst = await WebAssembly.instantiate(await WebAssembly.compile(b),
  { env: { abort() { throw new Error('abort'); } } });
const w = inst.exports;
const INIT = w.memory.buffer.byteLength;
const OUT = Math.max(65536, INIT);
const OUT_CAP = 512 * 513 * 4;
const LUT = OUT + OUT_CAP;
const PARAMS = LUT + 2048;
const ROOTS = PARAMS + 512;
const STATS = ROOTS + 256;
const GLITCH = ROOTS + 1024;
const GLITCH_CAP = 8192;
const ORBIT = GLITCH + GLITCH_CAP * 8;
const MAXITER = 500;
const STRIDE = MAXITER + 1;
const need = Math.ceil((ORBIT + STRIDE * 32 + 1048576) / 65536) * 65536;
if (w.memory.buffer.byteLength < need)
  w.memory.grow((need - w.memory.buffer.byteLength) / 65536);
const heap = new Uint8Array(w.memory.buffer);
const p = new Float64Array(w.memory.buffer, PARAMS, 64);
heap.set(paletteLUT('ice'), LUT);

/* Reference orbit of c = 2 + 2i: it escapes after a handful of steps, so
 * refLen is far below maxIter — exactly the case the worker now detects. */
const zr = new Float64Array(w.memory.buffer, ORBIT, STRIDE);
const zi = new Float64Array(w.memory.buffer, ORBIT + STRIDE * 8, STRIDE);
let ZR = 0, ZI = 0, refLen = 0;
for (let n = 0; n < STRIDE; n++) {
  zr[n] = ZR; zi[n] = ZI;
  const nr = ZR * ZR - ZI * ZI + 2, ni = 2 * ZR * ZI + 2;
  ZR = nr; ZI = ni;
  refLen = n + 1;
  if (ZR * ZR + ZI * ZI > 1e20) break;
}

const W = 128, H = 96;
function run(rebase) {
  p.fill(0);
  p[0] = 1; p[1] = 0; p[2] = 2; p[3] = 0;
  p[4] = 0; p[5] = 0; p[6] = W; p[7] = H; p[8] = W; p[9] = H;
  p[10] = 2; p[11] = 2; p[12] = 1e-20;
  p[15] = MAXITER; p[16] = 140; p[17] = 0; p[18] = OUT; p[19] = LUT;
  p[20] = ORBIT; p[21] = refLen; p[22] = W / 2; p[23] = H / 2;
  p[24] = 0; p[25] = 1; p[27] = ROOTS; p[28] = STRIDE;
  p[38] = GLITCH; p[39] = GLITCH_CAP; p[40] = 0;
  p[41] = 1; p[42] = 1; p[43] = 0.55; p[44] = 0;
  p[45] = STATS; p[46] = 0; p[47] = 0; p[48] = 0; p[49] = 10;
  p[50] = 0; p[51] = 0; p[52] = rebase ? 0 : 1; p[53] = 0;
  const t0 = performance.now();
  const glitches = w.render(PARAMS);
  const ms = performance.now() - t0;
  const o = new Uint8Array(W * H * 4);
  o.set(heap.subarray(OUT, OUT + W * H * 4));
  const set = new Set();
  for (let i = 0; i < o.length; i += 4) set.add((o[i] << 16) | (o[i + 1] << 8) | o[i + 2]);
  return { glitches, ms, colours: set.size, data: o };
}

const off = run(false), on = run(true);
console.log(`refLen=${refLen} / maxIter=${MAXITER}`);
console.log(`rebase OFF: glitches=${off.glitches} colours=${off.colours} ${off.ms.toFixed(1)}ms`);
console.log(`rebase ON : glitches=${on.glitches} colours=${on.colours} ${on.ms.toFixed(1)}ms`);
let fails = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) fails++; };
check('short orbit is a real short-orbit case', refLen < MAXITER * 0.9, `${refLen}`);
check('rebase removes the glitch storm', on.glitches < off.glitches * 0.1,
  `${off.glitches} -> ${on.glitches}`);
check('rebase still shades the frame', on.colours > 1, `${on.colours} colours`);
console.log(fails ? `\nREBASECHECK FAILED (${fails})` : '\nREBASECHECK OK');
process.exit(fails ? 1 : 0);
