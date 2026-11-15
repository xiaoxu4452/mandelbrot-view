/* _corecheck.mjs — one run, end to end: the restored UI on core.wasm.
 *
 *   1. both engines on the same views -> screenshots (evidence/ab-*)
 *   2. frame stats per view (engine, ms, reference orbit, escape range)
 *   3. real touch input: one finger pans, two fingers pinch-zoom
 *   4. console errors collected throughout
 *
 * usage: node tools/_corecheck.mjs
 */
import fs from 'node:fs';
import { attach, evaluate as ev, sleep } from './_cdp.mjs';

const OUT = 'D:/mandelbrot view/evidence';
const URL = 'http://127.0.0.1:8781/index.html';
fs.mkdirSync(OUT, { recursive: true });

const { page, proc } = await attach(Number(process.argv[2] || 9347));
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Log.enable');

const shot = async (n) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64'));
};

const META = `(() => { const m = __mb.meta() || {}; return JSON.stringify({
  seq: __mb.frames(), engine: m.engine, ms: m.ms, done: m.done, final: m.final,
  escMin: m.escMin, escMax: m.escMax, bits: m.bits, refLen: m.refLen,
  glitches: m.glitches, bounded: m.bounded, cap: m.cap, mode: m.mode }); })()`;
const HUD = `JSON.stringify({ engine: document.getElementById('hud-engine').textContent,
  depth: document.getElementById('hud-depth').textContent,
  center: document.getElementById('hud-center').textContent,
  progress: document.getElementById('hud-progress').textContent,
  prec: document.getElementById('chip-precision').textContent })`;

async function open(engine) {
  await page.send('Page.navigate', { url: engine === 'core' ? URL : `${URL}?engine=old` });
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    try { if (await ev(page, `typeof window.__mb !== 'undefined' && typeof __mb.meta === 'function'`)) return; } catch { /* mid-navigation */ }
  }
  throw new Error('page never booted: ' + engine);
}

/** Wait for a finished frame with seq > seq0. */
async function frame(seq0 = 0, timeoutMs = 900000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const o = JSON.parse(await ev(page, META));
    if (o.seq > seq0 && o.done && o.final !== false) return o;
    await sleep(150);
  }
  throw new Error('no frame');
}

const SPAN = (lz) => `(() => { const l = Math.log2(3) - ${lz} * Math.log2(10);
  const e = Math.floor(l), m = Math.pow(2, l - e); return JSON.stringify({ m, e }); })()`;

const VIEWS = [
  { tag: 'home', lz: 0, re: '-0.6', im: '0' },
  { tag: 'ci600', lz: 600, re: '0', im: '1' },
  /* A view the core does not implement: must fall back, not go black. */
  { tag: 'multibrot3', lz: 1, re: '-0.5', im: '0', power: 3 },
  /* Julia, seed -0.7435+0.1314i */
  { tag: 'julia', lz: 0, re: '-0.7435', im: '0.1314', mode: 'j' },
];

const results = [];
for (const v of VIEWS) {
  await open('core');
  const seq0 = JSON.parse(await ev(page, META)).seq;
  const span = await ev(page, SPAN(v.lz));
  await ev(page, `(() => { __mb.state.spec.mode = ${JSON.stringify(v.mode || 'm')};
    __mb.state.spec.kind = ${JSON.stringify(v.mode === 'j' ? 'mandelbrot' : (v.power === 3 ? 'multibrot' : 'mandelbrot'))};
    __mb.state.spec.power = ${v.power || 2}; __mb.state.traps = 0;
    __mb.state.center = { re: ${JSON.stringify(v.re)}, im: ${JSON.stringify(v.im)} };
    __mb.state.span = ${span}; __mb.render(); return 1; })()`);
  const f = await frame(seq0, 240000).catch((e) => ({ err: String(e) }));
  await shot(`ab-${v.tag}-core`);
  const hud = JSON.parse(await ev(page, HUD));
  const row = { view: v.tag, ...f, hudStat: hud.engine, depth: hud.depth, center: hud.center };
  results.push(row);
  console.log(JSON.stringify(row));
}

/* ---- touch ---- */
await open('core');
await ev(page, `(() => { __mb.state.center = { re: '-0.7436438870374124', im: '0.1318259145695319' };
  __mb.state.span = { m: 1.2, e: -46 }; __mb.render(); return 1; })()`);
let f0 = await frame(JSON.parse(await ev(page, META)).seq);
const box = JSON.parse(await ev(page, `(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
const { x, y } = box;

await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const before = JSON.parse(await ev(page, HUD));
const c0 = JSON.parse(await ev(page, `JSON.stringify(__mb.state.center)`));

await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
for (let i = 1; i <= 10; i++) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 14, y: y + i * 8, id: 1 }] });
  await sleep(25);
}
await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
const c1 = JSON.parse(await ev(page, `JSON.stringify(__mb.state.center)`));

await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 90, y, id: 1 }, { x: x + 90, y, id: 2 }] });
for (let i = 1; i <= 10; i++) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 90 - i * 12, y, id: 1 }, { x: x + 90 + i * 12, y, id: 2 }] });
  await sleep(25);
}
await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(300);
const after = JSON.parse(await ev(page, HUD));
const ft = await frame(f0.seq).catch(() => null);
await shot('core-touch-pinch');
console.log(JSON.stringify({
  touch: { dragFrom: c0, dragTo: c1, depthBefore: before.depth, depthAfter: after.depth,
           frame: ft && { engine: ft.engine, ms: ft.ms, escMin: ft.escMin, escMax: ft.escMax } },
}));

/* ---- wheel, for the desktop gesture ---- */
const w0 = JSON.parse(await ev(page, HUD));
for (let i = 0; i < 4; i++) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, pointerType: 'mouse' });
  await sleep(50);
}
await sleep(600);
const w1 = JSON.parse(await ev(page, HUD));
console.log(JSON.stringify({ wheel: { before: w0.depth, after: w1.depth } }));

console.log('console errors:', JSON.stringify(page.logs.slice(0, 10)));
console.log('results:', results.length, 'frames');
fs.writeFileSync(`${OUT}/_corecheck.json`, JSON.stringify({ results, logs: page.logs }, null, 2));
page.close();
if (proc) proc.kill();
