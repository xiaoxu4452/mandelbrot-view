/* Render one full frame inside Node (no browser) and dump per-tile metadata.
 * Used to isolate renderer defects from page-side composition defects.     */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { writePNG } from './png.mjs';
import fs from 'node:fs';

const W = Number(process.argv[2] || 1280);
const H = Number(process.argv[3] || 800);
const E = Number(process.argv[4] || -43);
const OUT = process.argv[5] || 'tools/fullframe.png';
const SINGLE = process.argv[6] !== 'pass';

const spec = {
  mode: 'm', kind: 'mandelbrot', power: 2,
  julia: { re: '-0.7435', im: '0.1314' },
  newtonDegree: 3, phoenixP: 0.5667,
  customExpr: 'z^2 + c', customParams: { a: 0, b: 0, k: 0 }
};
const center = { re: '-0.743643887037158704752191506114774', im: '0.131825904205311970493132056385139' };
const span = { m: 1.15, e: E };

function payload(rect, PW, PH, iter) {
  let pm = span.m / PW, pe = span.e;
  while (Math.abs(pm) >= 2) { pm /= 2; pe++; }
  while (Math.abs(pm) < 1) { pm *= 2; pe--; }
  return {
    id: `t-${rect.x}-${rect.y}`, viewId: 1,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h, width: PW, height: PH,
    spec, center, span, pixelSize: pm * Math.pow(2, pe),
    psMant: pm, psExp: pe, psLog2: Math.log2(Math.abs(pm)) + pe,
    maxIter: iter, bits: 'auto', palette: 'ice', cycle: 22, offset: 0, samples: 1
  };
}

const worker = new Worker(path.resolve('server/render-worker.mjs'));
const pending = new Map();
let ready = false;

worker.on('message', (m) => {
  if (m.type === 'ready') { ready = true; return; }
  if (m.type === 'stage') return;
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m); }
});

function render(job) {
  return new Promise((resolve, reject) => {
    pending.set(job.id, { resolve, reject });
    worker.postMessage({ type: 'render', job });
  });
}

const frame = new Uint8ClampedArray(W * H * 4);
const TILE = 128;
const passes = SINGLE ? [{ s: 1, iter: 4000 }] : [{ s: 0.13, iter: 4000 }, { s: 0.38, iter: 4000 }, { s: 0.68, iter: 4000 }, { s: 1, iter: 4000 }];

while (!ready) await new Promise(r => setTimeout(r, 40));

for (const pass of passes) {
  const PW = Math.round(W * pass.s);
  const PH = Math.round(H * pass.s);
  const tw = Math.max(40, Math.round(128 * Math.max(pass.s, 0.5)));
  const tiles = [];
  for (let y = 0; y < PH; y += tw) for (let x = 0; x < PW; x += tw) tiles.push({ x, y, w: Math.min(tw, PW - x), h: Math.min(tw, PH - y) });

  const metas = [];
  for (const rect of tiles) {
    const msg = await render(payload(rect, PW, PH, pass.iter));
    metas.push({ x: rect.x, y: rect.y, mode: msg.meta.mode, gl: msg.meta.glitches, fixed: msg.meta.fixed, ref: msg.meta.refLen });
    if (pass.s === 1) {
      for (let yy = 0; yy < rect.h; yy++) {
        frame.set(msg.data.subarray(yy * rect.w * 4, (yy + 1) * rect.w * 4), ((rect.y + yy) * W + rect.x) * 4);
      }
    }
  }
  const bad = metas.filter(m => m.gl > 0);
  console.log(`pass ${pass.s}: ${tiles.length} tiles, ${bad.length} with glitches, totalGlitch=${metas.reduce((a, m) => a + m.gl, 0)}`);
  if (bad.length) console.log('  worst:', bad.sort((a, b) => b.gl - a.gl).slice(0, 6).map(m => `${m.x},${m.y}:${m.gl}`).join(' '));
}

writePNG(OUT, Buffer.from(frame.buffer), W, H);
fs.writeFileSync(OUT.replace('.png','.bin'), Buffer.from(frame.buffer));
console.log('wrote', OUT);
worker.terminate();
