/* _mobile.mjs — the page as a phone sees it: 390x844 @3x, coarse pointer, real
 * touch input.  Checks the layout, one-finger drag, two-finger pinch, and how
 * long a frame takes inside the phone's pixel budget.
 *
 * usage: node tools/_mobile.mjs [port]
 */
import fs from 'node:fs';
import { attach, evaluate as ev, sleep } from './_cdp.mjs';

const port = Number(process.argv[2] || 9347);
const OUT = 'D:/mandelbrot view/evidence';
const URL = process.argv[3] || 'http://127.0.0.1:8781/index.html';
const { page } = await attach(port);
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Log.enable');

await page.send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  screenOrientation: { type: 'portraitPrimary', angle: 0 },
});
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await page.send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

const shot = async (n) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64'));
};
const META = `(() => { const m = __mb.meta() || {}; return JSON.stringify({
  seq: __mb.frames(), engine: m.engine, ms: m.ms, done: m.done, escMin: m.escMin,
  escMax: m.escMax, bits: m.bits, refLen: m.refLen, mode: m.mode }); })()`;
const HUD = `JSON.stringify({ stat: document.getElementById('hud-engine').textContent,
  depth: document.getElementById('hud-depth').textContent,
  center: document.getElementById('hud-center').textContent,
  prog: document.getElementById('hud-progress').textContent,
  canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
  touchUI: (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return null; } })(),
  bodyClass: document.body.className })`;

async function frame(seq0 = 0, timeout = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const o = JSON.parse(await ev(page, META));
    if (o.seq > seq0 && o.done) return o;
    await sleep(150);
  }
  throw new Error('no frame');
}

await page.send('Page.navigate', { url: URL });
for (let i = 0; i < 200; i++) {
  await sleep(250);
  try { if (await ev(page, `typeof window.__mb !== 'undefined'`)) break; } catch { /* nav */ }
}
const f0 = await frame(0);
await sleep(1200);
await shot('mobile-01-home');
console.log('home:', JSON.stringify({ frame: f0, hud: JSON.parse(await ev(page, HUD)) }));

const { x, y } = JSON.parse(await ev(page, `(() => { const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));

/* one finger drag: the view must pan, and the picture must follow the finger
 * (centre moves in the opposite direction of the drag) */
const c0 = JSON.parse(await ev(page, `JSON.stringify(__mb.state.center)`));
const s0 = await ev(page, `__mb.frames()`);
await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
for (let i = 1; i <= 12; i++) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 9, y, id: 1 }] });
  await sleep(16);
}
await shot('mobile-02-drag');
await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const c1 = JSON.parse(await ev(page, `JSON.stringify(__mb.state.center)`));
const dragFrame = await frame(s0).catch(() => null);
await sleep(300);
await shot('mobile-03-drag-done');

/* pinch out: fingers apart => deeper */
const s1 = await ev(page, `__mb.frames()`);
const d0 = JSON.parse(await ev(page, HUD));
await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 60, y, id: 1 }, { x: x + 60, y, id: 2 }] });
for (let i = 1; i <= 12; i++) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60 - i * 11, y, id: 1 }, { x: x + 60 + i * 11, y, id: 2 }] });
  await sleep(16);
}
await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const d1 = JSON.parse(await ev(page, HUD));
const pinchFrame = await frame(s1).catch(() => null);
await sleep(400);
await shot('mobile-04-pinch');

console.log(JSON.stringify({
  drag: { from: c0, to: c1, frame: dragFrame && { ms: dragFrame.ms, esc: [dragFrame.escMin, dragFrame.escMax] } },
  pinch: { before: d0.depth, after: d1.depth, frame: pinchFrame && { ms: pinchFrame.ms, bits: pinchFrame.bits } },
  hud: d1,
}));

/* landscape: the panel must not swallow the canvas */
await page.send('Emulation.setDeviceMetricsOverride', {
  width: 844, height: 390, deviceScaleFactor: 3, mobile: true,
  screenOrientation: { type: 'landscapePrimary', angle: 90 },
});
await sleep(1200);
const s2 = await ev(page, `__mb.frames()`);
await ev(page, `__mb.render()`);
await frame(s2).catch(() => null);
await sleep(600);
await shot('mobile-05-landscape');
console.log('landscape:', JSON.stringify(JSON.parse(await ev(page, HUD))));
console.log('errors:', JSON.stringify(page.logs.slice(0, 8)));
page.close();
