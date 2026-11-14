/* kernel-layout.mjs — guard the wasm memory layout without a browser.
 *
 * The kernel's shadow stack sits at the top of the module's *initial* linear
 * memory and grows down.  Everything the worker owns must therefore start at
 * or above that address, or a 512x512 RGBA tile (1 MiB) paints over the
 * kernel's own spilled locals and every following row is garbage — the dark
 * band that used to appear once per 512 px on the CPU path.
 *
 * This mirrors worker.js `layoutMemory()` and fails loudly if a rebuilt
 * kernel.wasm changes the initial memory size such that the tile slot would
 * overlap the stack again.
 *
 *   node tools/kernel-layout.mjs      (exit 0 = safe)
 */
import { KERNEL_B64 } from '../js/kernel-wasm.js';
import { paletteLUT } from '../js/palettes.js';
const OUT_CAP = 512 * 513 * 4;
const GLITCH_CAP = 8192;

const b = Uint8Array.from(Buffer.from(KERNEL_B64, 'base64'));
const mod = await WebAssembly.compile(b);
const inst = await WebAssembly.instantiate(mod, { env: { abort() { throw new Error('abort'); } } });
const wasm = inst.exports;
const INIT = wasm.memory.buffer.byteLength;
const OUT = Math.max(65536, INIT);
const LUT_PTR = OUT + OUT_CAP;
const PARAMS = LUT_PTR + 2048;
const ROOTS = PARAMS + 512;
const STATS = ROOTS + 256;
const GLITCH = ROOTS + 1024;
const ORBIT = GLITCH + GLITCH_CAP * 8;
const need = Math.ceil((ORBIT + OUT_CAP + 1048576) / 65536) * 65536;
if (wasm.memory.buffer.byteLength < need) wasm.memory.grow((need - wasm.memory.buffer.byteLength) / 65536);
const heap = new Uint8Array(wasm.memory.buffer);
const params = new Float64Array(wasm.memory.buffer, PARAMS, 64);
heap.set(paletteLUT('orchid'), LUT_PTR);
console.log(`init=0x${INIT.toString(16)} out=0x${OUT.toString(16)} tileEnd=0x${(OUT + 512*512*4).toString(16)} mem=${heap.length}`);

const W = 2496, H = 1408, PS = 3.2 / W;
function render(tx, ty, tw, th) {
  const p = params; p.fill(0);
  p[0]=0;p[1]=0;p[2]=2;p[3]=0;p[4]=tx;p[5]=ty;p[6]=tw;p[7]=th;
  p[8]=W;p[9]=H;p[10]=-0.6;p[11]=0;p[12]=PS;
  p[15]=600;p[16]=140;p[17]=0;p[18]=OUT;p[19]=LUT_PTR;p[24]=0;p[25]=1;
  p[41]=1;p[42]=1;p[43]=0.55;p[44]=0;p[45]=STATS;p[46]=0;p[47]=0;p[48]=0;p[49]=10;p[50]=0;p[51]=0;p[52]=1;
  heap.fill(0xAB, OUT, OUT + tw*th*4);
  wasm.render(PARAMS);
  const o = new Uint8Array(tw*th*4); o.set(heap.subarray(OUT, OUT + tw*th*4)); return o;
}
const px = (d, tw, x, y) => { const o=(y*tw+x)*4; return d[o]+','+d[o+1]+','+d[o+2]; };
const tile = render(512, 0, 512, 512);
let bad = 0, firstBad = -1;
for (let y = 0; y < 512; y++) {
  const r = render(512, y, 512, 1);
  let n = 0;
  for (let x = 0; x < 512; x++) if (px(tile, 512, x, y) !== px(r, 512, x, 0)) n++;
  if (n) { bad++; if (firstBad < 0) firstBad = y; }
}
console.log('512x512 tile vs per-row reference: badRows', bad, 'firstBad', firstBad);
/* deep-path sanity: a 512x512 tile twice in a row must be identical (no state leak) */
const a1 = render(512, 0, 512, 512), a2 = render(512, 0, 512, 512);
let same = 0;
for (let i = 0; i < a1.length; i++) if (a1[i] === a2[i]) same++;
console.log('repeat render identical pixels:', same, '/', a1.length);
const inBounds = OUT >= INIT && OUT + OUT_CAP <= heap.length;
console.log(`layout: OUT=0x${OUT.toString(16)} INIT=0x${INIT.toString(16)} ` +
            `slot=[0x${OUT.toString(16)},0x${(OUT + OUT_CAP).toString(16)}) mem=0x${heap.length.toString(16)} ` +
            `${inBounds ? 'above the stack' : 'OVERLAPS THE STACK'}`);
const pass = bad === 0 && same === a1.length && inBounds;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
