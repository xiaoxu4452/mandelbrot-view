/* _abdiff.mjs — the same view through both engines, compared on the canvas.
 *
 * The palette, the canvas size and the UI state are identical, so any
 * difference is the engine's own: the core's field must reproduce the picture
 * the page's JS pipeline produced for the same centre/span/cycle.
 *
 * usage: node tools/_abdiff.mjs [port] [log10zoom]
 */
import fs from 'node:fs';
import { attach, evaluate as ev, sleep } from './_cdp.mjs';

const port = Number(process.argv[2] || 9347);
const lz = Number(process.argv[3] || 0);
const URL = 'http://127.0.0.1:8781/index.html';
const { page } = await attach(port);
await page.send('Page.enable');
await page.send('Runtime.enable');

const SPAN = `(() => { const l = Math.log2(3) - ${lz} * Math.log2(10);
  const e = Math.floor(l), m = Math.pow(2, l - e); return JSON.stringify({ m, e }); })()`;

async function grab(engine) {
  await page.send('Page.navigate', { url: engine === 'core' ? URL : `${URL}?engine=old` });
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    try { if (await ev(page, `typeof window.__mb !== 'undefined'`)) break; } catch { /* nav */ }
  }
  const seq0 = await ev(page, `__mb.frames()`);
  const span = await ev(page, SPAN);
  await ev(page, `(() => { __mb.state.spec.mode='m'; __mb.state.spec.kind='mandelbrot';
    __mb.state.spec.power=2; __mb.state.traps=0;
    __mb.state.center={re:'-0.7436438870374124', im:'0.1318259145695319'};
    __mb.state.span=${span}; __mb.render(); return 1; })()`);
  for (let i = 0; i < 1200; i++) {
    await sleep(200);
    const done = await ev(page, `(() => { const m = __mb.meta()||{}; return !!(m.done && m.final !== false && __mb.frames() > ${seq0}); })()`);
    if (done) break;
  }
  await sleep(400);
  const px = await ev(page, `(() => {
    const c = document.querySelector('canvas');
    const g = c.getContext('2d');
    const w = 300, h = 200, x = (c.width - w) >> 1, y = (c.height - h) >> 1;
    const d = g.getImageData(x, y, w, h).data;
    let out = ''; for (let i = 0; i < d.length; i += 4) out += String.fromCharCode(d[i], d[i+1], d[i+2]);
    return btoa(out);
  })()`);
  const engineLabel = await ev(page, `document.getElementById('hud-engine').textContent`);
  return { px: Buffer.from(px, 'base64'), engineLabel };
}

const a = await grab('core');
const b = await grab('old');
fs.writeFileSync('D:/mandelbrot view/evidence/ab-core.ppm',
  Buffer.concat([Buffer.from(`P6\n300 200\n255\n`), a.px]));
fs.writeFileSync('D:/mandelbrot view/evidence/ab-old.ppm',
  Buffer.concat([Buffer.from(`P6\n300 200\n255\n`), b.px]));
const n = Math.min(a.px.length, b.px.length);
let diff = 0, max = 0, sum = 0;
for (let i = 0; i < n; i++) {
  const d = Math.abs(a.px[i] - b.px[i]);
  if (d) diff++;
  if (d > max) max = d;
  sum += d;
}
let big = 0;
for (let i = 0; i < n; i += 3) {
  const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i+1] - b.px[i+1]), Math.abs(a.px[i+2] - b.px[i+2]));
  if (d > 32) big++;
}
console.log(JSON.stringify({
  bytes: n / 3, pixels: n / 3,
  pixelsOver32: big, over32Pct: (100 * big / (n / 3)).toFixed(2),
  diffChannels: diff, diffPct: (100 * diff / n).toFixed(2),
  maxDelta: max, meanDelta: (sum / n).toFixed(2),
  core: a.engineLabel, old: b.engineLabel,
}));
page.close();
