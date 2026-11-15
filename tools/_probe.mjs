/* _probe.mjs — what is the page doing? dumps engine state and console errors. */
import { attach, evaluate as ev, sleep } from './_cdp.mjs';

const port = Number(process.argv[2] || 9347);
const url = process.argv[3] || 'http://127.0.0.1:8781/index.html?engine=old';
const { page } = await attach(port);
await page.send('Page.enable');
await page.send('Runtime.enable');
await page.send('Log.enable');
await page.send('Page.navigate', { url });
for (let i = 0; i < 80; i++) {
  await sleep(250);
  try { if (await ev(page, `typeof window.__mb !== 'undefined'`)) break; } catch { /* nav */ }
}
await sleep(6000);
const dump = await ev(page, `(() => {
  const m = __mb.meta && __mb.meta();
  return JSON.stringify({
    meta: m, engineLabel: document.getElementById('hud-engine')?.textContent,
    progress: document.getElementById('hud-progress')?.textContent,
    coord: document.getElementById('hud-center')?.textContent,
    splash: document.getElementById('splash')?.className,
    canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
    workers: typeof __mb.shell === 'undefined' ? 'n/a' : 'x',
  });
})()`);
console.log(dump);
console.log('logs:', JSON.stringify(page.logs.slice(0, 15), null, 1));
page.close();
