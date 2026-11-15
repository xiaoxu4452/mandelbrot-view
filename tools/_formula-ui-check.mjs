/* Local browser check for the formulacore page wiring. */
import fs from 'node:fs';
import { launch, evaluate as ev, sleep } from './_cdp.mjs';
import { decode } from './_pngdiff.mjs';

const BASE = process.env.MB_URL || 'https://xiaoxu4452.github.io/mandelbrot-view/index.html';
const OUT = 'D:/mandelbrot view/evidence';

function picture(px, w, h) {
  let sum = 0, dark = 0, n = 0, min = 255, max = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const o = (y * w + x) * 4;
    const v = (px[o] + px[o + 1] + px[o + 2]) / 3;
    sum += v; if (v < 12) dark++; n++;
    if (v < min) min = v; if (v > max) max = v;
  }
  return { mean: +(sum / n).toFixed(1), darkPct: +(100 * dark / n).toFixed(1),
           min, max };
}

async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const f = `${OUT}/${name}.png`;
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  const d = decode(f);
  return picture(d.px, d.w, d.h);
}

async function boot(url, width = 1000, height = 700) {
  const { page, proc } = await launch({ width, height });
  const errors = [];
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXC ' + (m.params.exceptionDetails.exception?.description ||
                            m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push('CONSOLE ' + (m.params.args[0]?.value || ''));
  });
  await page.send('Page.navigate', { url: url + (url.includes('?') ? '&' : '?') + 'n=' + Math.random() });
  for (let i = 0; i < 300; ++i) {
    await sleep(200);
    try { if (await ev(page, "typeof window.__mb !== 'undefined'")) break; } catch {}
  }
  await sleep(3500);
  return { page, proc, errors };
}

const setSpec = async (page, obj) => ev(page, `(() => {
  const s = __mb.state.spec;
  ${Object.entries(obj).map(([k, v]) => `s.${k} = ${JSON.stringify(v)};`).join('\n')}
  __mb.render(); return 1;
})()`);

let fails = 0;
const check = (ok, label, detail) => { if (!ok) ++fails; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`); };

{
  const { page, proc, errors } = await boot(BASE);
  try {
    const f0 = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    const p0 = await shot(page, 'fu-default');
    check(!f0.active && f0.loaded === false, 'default M view stays on core.wasm',
      JSON.stringify(f0) + ' pic ' + JSON.stringify(p0));

    await setSpec(page, { mode: 'x', customExpr: 'z^2+c' });
    await sleep(6000);
    const f1 = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    const p1 = await shot(page, 'fu-custom');
    check(f1.active && f1.loaded && !!f1.engine, 'custom formula uses C++ core',
      JSON.stringify(f1) + ' pic ' + JSON.stringify(p1));
    check(p1.darkPct < 95 && p1.max - p1.min > 30, 'custom formula picture has structure',
      JSON.stringify(p1));

    const wheel = (x, y) => page.send('Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, button: 'none', buttons: 0 });
    for (let i = 0; i < 3; ++i) { await wheel(420, 330); await sleep(260); }
    await sleep(5000);
    const p2 = await shot(page, 'fu-custom-zoom');
    const f2 = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    check(p2.darkPct < 95 && f2.active, 'custom formula survives 3 wheel notches',
      JSON.stringify(p2) + ' ' + JSON.stringify(f2));

    await setSpec(page, { customExpr: 'sin(z)+c' });
    await sleep(6000);
    const f3 = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    const p3 = await shot(page, 'fu-sin');
    check(f3.active && !!f3.engine, 'nested trig expression renders',
      JSON.stringify(f3) + ' pic ' + JSON.stringify(p3));

    await setSpec(page, { mode: 'm', kind: 'mandelbrot', power: 3 });
    await sleep(5000);
    const f4 = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    check(f4.active && f4.expr === 'z^3+c', 'multibrot(3) routed to formula core',
      JSON.stringify(f4));

    await setSpec(page, { mode: 'm', kind: 'mandelbrot', power: 2 });
    await sleep(4000);
    const f5 = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    check(!f5.active, 'back to z^2+c returns to core.wasm', JSON.stringify(f5));

    check(errors.length === 0, 'no page errors', JSON.stringify(errors.slice(0, 4)));
  } finally { page.close(); proc.kill(); }
}

{
  const { page, proc } = await boot(BASE + '?formula=0');
  try {
    await setSpec(page, { mode: 'x', customExpr: 'z^2+c' });
    await sleep(4000);
    const f = JSON.parse(await ev(page, 'JSON.stringify(__mb.formula())'));
    check(!f.active && f.expr === '', '?formula=0 keeps the JS kernel', JSON.stringify(f));
  } finally { page.close(); proc.kill(); }
}

console.log(fails ? `[formula-ui] ${fails} FAILED` : '[formula-ui] all checks passed');
if (fails) process.exitCode = 1;
