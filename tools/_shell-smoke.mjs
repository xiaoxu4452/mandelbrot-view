// Browser smoke test for the new minimal shell (index.html + core.wasm).
// Renders the user's disputed deep link, wheel-zooms deep, and checks the
// committed frames for colour diversity / anomalies.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:8777/index.html';
const OUT = '.tmp/shell-smoke';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-gl=swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

// 1 — boot
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.document.getElementById('hud-stat').textContent.includes('ms'), { timeout: 120000 });
await page.waitForTimeout(500);
const bootHud = await page.evaluate(() => document.getElementById('hud-stat').textContent);
console.log('[boot]', bootHud);
await page.screenshot({ path: `${OUT}/1-home.png` });

// 2 — the user's legacy deep link (v29-era disputed viewpoint, 1e10.3)
// NOTE: same URL + different hash does NOT reload the page, so force it.
const LEGACY = '#st=eyJzIjp7Im1vZGUiOiJtIiwia2luZCI6Im1hbmRlbGJyb3QiLCJwb3dlciI6MiwianVsaWEiOnsicmUiOiItMC43NDM1IiwiaW0iOiIwLjEzMTQifSwibmV3dG9uRGVncmVlIjozLCJwaG9lbml4UCI6MC41NjY3LCJjdXN0b21FeHByIjoiel4yICsgYyIsImN1c3RvbVBhcmFtcyI6eyJhIjowLCJiIjowLCJrIjowfX0sImMiOnsicmUiOiItMC44Mzk0MjA5OTkzMzkzNzU2MzA1NDk2MjA5Mjc0MTkxNzE4NjA3NzQyMjI4NTUyNzkzNzM2Nzg0MzY3NTkwNDMyNzQzMzA5MDY1Njk5OCIsImltIjoiMC4yMjM1MjIyNTA0NTAxNjAzNjEwMjQwMjQzNzc1MDgzNTQwMDUwMDU4MTE3MDE0OTcyNTAxNzIzNjExNzI4MjA4NjQzNDIyNzAzOTcxNyJ9LCJzcCI6eyJtIjoxLjYwODI2MzM3NjczMTAzODQsImUiOi0zNH0sImkiOjYwMCwiYSI6dHJ1ZSwiYiI6ImF1dG8iLCJwIjoiaWNlIiwiY3kiOjE0MCwibyI6MCwiciI6MCwic2giOiJiYW5kcyIsImJkIjowLCJjYSI6ZmFsc2UsInRuIjp7ImJyaSI6MSwiZ3IiOjEsImdnIjoxLCJnYiI6MX0sInN0IjpudWxsLCJzaSI6bnVsbCwic20iOm51bGwsInNwbSI6W10sInNjIjpbXSwic2IiOnsiZmluaXRlIjoxLCJpbmZpbml0ZSI6MSwiZmFjdG9yIjoxfSwiZ2wiOm51bGx9';
await page.goto(URL + '?cb=' + Date.now() + LEGACY, { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('hud-stat').textContent.includes('ms'), { timeout: 120000 });
await page.waitForTimeout(400);
const deepHud = await page.evaluate(() => ({
  coord: document.getElementById('hud-coord').textContent,
  zoom: document.getElementById('hud-zoom').textContent,
  stat: document.getElementById('hud-stat').textContent,
}));
console.log('[legacy-link]', JSON.stringify(deepHud));
await page.screenshot({ path: `${OUT}/2-legacy-deep.png` });

// colour diversity of the deep frame (should be a continuous field, not 1 flat colour or blocky)
const deep = await page.evaluate(() => {
  const c = document.getElementById('view');
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  const x = t.getContext('2d');
  x.drawImage(c, 0, 0);
  const d = x.getImageData(0, 0, t.width, t.height).data;
  const set = new Set();
  let nonDark = 0, samples = 0;
  for (let i = 0; i < d.length; i += 4 * 97) {
    set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (d[i] + d[i + 1] + d[i + 2] > 30) nonDark++;
    samples++;
  }
  return { colours: set.size, nonDark, samples };
});
console.log('[deep diversity]', JSON.stringify(deep));

// 3 — wheel deep at the seahorse valley boundary (interior black is correct
// at -0.6, but a boundary point gives a visual check)
await page.goto(URL + '?cb=' + Date.now(), { waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('hud-stat').textContent.includes('ms'), { timeout: 120000 });
await page.evaluate(() => {
  const s = window.__shell.state;
  s.center = { re: '-0.7436438870371587', im: '0.13182590420531197' };
  s.span = { m: 3.0, e: 0 };
});
const cdp = await page.context().newCDPSession(page);
for (let k = 0; k < 24; k++) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 450, y: 300, deltaX: 0, deltaY: -120 });
  if (k % 6 === 5) await page.waitForTimeout(30);
}
await page.waitForTimeout(4000);
const wheelHud = await page.evaluate(() => ({
  zoom: document.getElementById('hud-zoom').textContent,
  coord: document.getElementById('hud-coord').textContent,
  stat: document.getElementById('hud-stat').textContent,
  hash: location.hash.slice(0, 26),
}));
console.log('[after 24 wheels @seahorse]', JSON.stringify(wheelHud));
await page.screenshot({ path: `${OUT}/3-wheeled.png` });

// 4 — touch: pinch out + pan on a mobile viewport
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
});
const mp = await mctx.newPage();
mp.on('pageerror', (e) => errs.push('mobile pageerror: ' + e.message));
await mp.goto(URL, { waitUntil: 'load', timeout: 60000 });
await mp.waitForFunction(() => document.getElementById('hud-stat').textContent.includes('ms'), { timeout: 120000 });
const mcdp = await mctx.newCDPSession(mp);
const cx = 195, cy = 400;
await mcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 70, y: cy - 90, id: 1 }, { x: cx + 70, y: cy + 90, id: 2 }] });
for (let k = 1; k <= 8; k++) {
  const s = 70 - k * 7;
  await mcdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - s, y: cy - s * 1.28, id: 1 }, { x: cx + s, y: cy + s * 1.28, id: 2 }] });
  await mp.waitForTimeout(40);
}
await mcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await mp.waitForTimeout(2500);
const pinchHud = await mp.evaluate(() => ({
  zoom: document.getElementById('hud-zoom').textContent,
  coord: document.getElementById('hud-coord').textContent,
  stat: document.getElementById('hud-stat').textContent,
}));
console.log('[mobile pinch-in x3.4]', JSON.stringify(pinchHud));
await mp.screenshot({ path: `${OUT}/4-mobile-pinch.png` });
// pan
await mcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 1 }] });
for (let k = 1; k <= 10; k++) {
  await mcdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + k * 9, y: cy + k * 5, id: 1 }] });
  await mp.waitForTimeout(30);
}
await mcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await mp.waitForTimeout(2000);
await mp.screenshot({ path: `${OUT}/5-mobile-pan.png` });

console.log('[errors]', errs.length ? errs.slice(0, 6).join(' | ') : 'none');
await browser.close();
console.log('SMOKE DONE');
