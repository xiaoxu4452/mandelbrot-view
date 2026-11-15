/* _family-page-check.mjs — the five folded families through the REAL page
 * worker chain (not just Node + wasm).
 *
 * Julia slice with seed c = 0 through the exact unit-circle point 0.6+0.8i
 * (phoenix uses a high-precision boundary point): at 1e20 the frame has
 * structure, double precision cannot, and only the dedicated C++ family
 * kernel over the arbitrary-precision reference ladder can draw it.
 *
 *   MB_URL=http://127.0.0.1:8777/index.html node tools/_family-page-check.mjs
 */
import fs from 'node:fs';
import { launch, evaluate as ev, sleep } from './_cdp.mjs';
import { decode } from './_pngdiff.mjs';

const BASE = process.env.MB_URL || 'https://xiaoxu4452.github.io/mandelbrot-view/index.html';
const OUT = 'D:/mandelbrot view/evidence';
fs.mkdirSync(OUT, { recursive: true });
const FAMILIES = ['tricorn', 'burningship', 'celtic', 'perpendicular', 'phoenix'];
/* 2^-100 bisection point of the phoenix filled-set boundary at Im = 0.8.
 * A coarse centre would put the whole 1e20-wide frame on one side. */
const PHOENIX_RE = '-0.192022772000604727281957279291932130027222113945147209017675';

function spread(px, w, h) {
  const seen = new Set();
  let dark = 0, n = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = (y * w + x) * 4;
    const v = (px[o] + px[o + 1] + px[o + 2]) / 3;
    seen.add(Math.round(v / 8));
    if (v < 12) dark++;
    n++;
  }
  return { levels: seen.size, darkPct: +(100 * dark / n).toFixed(1) };
}
async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  const d = decode(f);
  return spread(d.px, d.w, d.h);
}

const { page, proc } = await launch({ width: 900, height: 640 });
const errors = [];
let fails = 0;
const check = (ok, label, detail) => {
  if (!ok) ++fails;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
};
try {
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXC ' + (m.params.exceptionDetails.exception?.description ||
                            m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push('CONSOLE ' + (m.params.args[0]?.value || ''));
  });
  await page.send('Page.navigate', { url: BASE + '?fam=' + Math.random() });
  for (let i = 0; i < 300; ++i) {
    await sleep(200);
    try { if (await ev(page, `typeof window.__mb !== 'undefined'`)) break; } catch {}
  }
  await sleep(4000);
  await ev(page, `(() => { document.body.classList.remove('panel-open');
    const p=document.getElementById('panel'); if(p) p.hidden=true; return 1; })()`);

  for (const kind of FAMILIES) {
    for (const deep of [false, true]) {
      const re = kind === 'phoenix' ? PHOENIX_RE : '0.6';
      const span = deep ? '3e-20' : '1.6';
      const e = deep ? 0 : 1;
      await ev(page, `(() => {
        const s = __mb.state;
        s.spec.mode = 'j';
        s.spec.kind = ${JSON.stringify(kind)};
        s.spec.power = 2;
        s.spec.phoenixP = 0.5667;
        s.spec.julia = { re: '0', im: '0' };
        s.center = { re: ${JSON.stringify(re)}, im: '0.8' };
        s.span = { m: ${span}, e: ${e} };
        s.presetId = null;
        s.glsl = ''; s.traps = 0; s.inverse = false;
        __mb.render(); return 1;
      })()`);
      let f = null;
      for (let i = 0; i < 60; ++i) {
        await sleep(300);
        f = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
        if (deep ? f.engine === 'family' : !f.active) break;
      }
      const p = await shot(page, `fam-${kind}-${deep ? 'deep' : 'shallow'}`);
      /* Shallow views deliberately stay on the page kernel (formulaActive
       * false); deep views must be owned by the C++ family engine. */
      const ok = f && (deep ? (f.active && f.engine === 'family') : !f.active) &&
                 p.levels > 4 && p.darkPct < 90;
      check(ok, `${kind} ${deep ? '1e20 deep' : 'shallow'}`,
        `active=${f && f.active} engine=${f && f.engine} expr=${f && f.expr} ` +
        `levels=${p.levels} dark=${p.darkPct}% ` +
        `coreWhy=${await ev(page, '__mb.coreWhy()')}`);
    }
  }
  check(errors.length === 0, 'no page errors', JSON.stringify(errors.slice(0, 4)));
} finally {
  page.close();
  if (proc) proc.kill();
}
console.log(fails ? `[family-page] ${fails} FAILED` : '[family-page] all five families render in the browser');
if (fails) process.exitCode = 1;
