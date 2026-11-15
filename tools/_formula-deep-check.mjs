/* Deep-view check for the page-wired formula core (jet path) + A/B timing. */
import fs from 'node:fs';
import { launch, evaluate as ev, sleep } from './_cdp.mjs';
import { decode } from './_pngdiff.mjs';

const BASE = process.env.MB_URL || 'https://xiaoxu4452.github.io/mandelbrot-view/index.html';
const OUT = 'D:/mandelbrot view/evidence';

function spread(px, w, h) {
  const seen = new Set();
  let dark = 0, n = 0, max = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = (y * w + x) * 4;
    const v = (px[o] + px[o + 1] + px[o + 2]) / 3;
    seen.add(Math.round(v / 8));
    if (v < 12) dark++;
    if (v > max) max = v;
    n++;
  }
  return { levels: seen.size, darkPct: +(100 * dark / n).toFixed(1), max };
}
async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  const d = decode(f);
  return spread(d.px, d.w, d.h);
}
async function boot(url) {
  const { page, proc } = await launch({ width: 900, height: 640 });
  const errors = [];
  await page.send('Page.enable'); await page.send('Runtime.enable');
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXC ' + (m.params.exceptionDetails.exception?.description ||
                            m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push('CONSOLE ' + (m.params.args[0]?.value || ''));
  });
  await page.send('Page.navigate', { url: url + '?n=' + Math.random() });
  for (let i = 0; i < 300; ++i) {
    await sleep(200);
    try { if (await ev(page, "typeof window.__mb !== 'undefined'")) break; } catch {}
  }
  await sleep(3500);
  return { page, proc, errors };
}

let fails = 0;
const check = (ok, label, detail) => { if (!ok) ++fails; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`); };

for (const [label, query] of [['formula core', ''], ['JS kernel (A/B)', '?formula=0']]) {
  const { page, proc, errors } = await boot(BASE + query);
  try {
    await ev(page, `(() => {
      const s = __mb.state;
      s.spec.mode = 'x';
      s.spec.customExpr = 'z^2+c';
      s.center = { re: '0', im: '1' };          /* c = i, exact Misiurewicz */
      s.span = { m: 3e-30, e: 0 };              /* zoom ~ 1e30 */
      __mb.render(); return 1;
    })()`);
    const t0 = Date.now();
    let f = null;
    for (let i = 0; i < 90; ++i) {
      await sleep(400);
      f = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
      if (query === '' && f.engine === 'jet') break;
      if (query !== '' && i > 12) break;
    }
    const elapsed = Date.now() - t0;
    const p = await shot(page, 'fd-' + (query ? 'ab' : 'new'));
    console.log(`  ${label}: ${JSON.stringify(f)} | ${elapsed} ms from dispatch | pic ${JSON.stringify(p)}`);
    if (!query) {
      check(f.active && f.engine === 'jet', 'deep 1e30 uses jet perturbation', JSON.stringify(f));
      check(p.levels > 8 && p.darkPct < 90, 'deep picture keeps structure', JSON.stringify(p));
      check(errors.length === 0, 'no page errors', JSON.stringify(errors.slice(0, 3)));
    }
  } finally { page.close(); proc.kill(); }
}
console.log(fails ? `[formula-deep] ${fails} FAILED` : '[formula-deep] all checks passed');
if (fails) process.exitCode = 1;
