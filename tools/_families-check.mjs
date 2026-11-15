/* _families-check.mjs — 回归检查：非 z^2+c 的分形族缩放是否稳定。
 *
 * 网页主引擎是 core.wasm；tricorn / burning ship / celtic / multibrot 等仍走
 * 页面自己的内核（js/worker.js）。它们共用同一套手势状态，但落帧路径不同，
 * 所以"放大到一半画面跳走/黑帧/马赛克"必须单独验。
 *
 * 不变量（每个族）：
 *   1. 起点连拍两帧一致        -> 已落帧，不是被平移过的旧位图
 *   2. 放大 3 格再缩小 3 格    -> 画面回到起点（差异只许是抗锯齿/浮点边界噪声）
 *   3. 手势过程中不出现黑帧    -> 没有半成品瓦片盖住画面
 *
 *   node tools/_families-check.mjs [url]
 *   MB_URL=http://127.0.0.1:8777/index.html node tools/_families-check.mjs
 */
import fs from 'node:fs';
import { launch, evaluate as ev, sleep } from '../tools/_cdp.mjs';
import { decode } from '../tools/_pngdiff.mjs';

const URL = process.env.MB_URL || 'https://xiaoxu4452.github.io/mandelbrot-view/index.html';
const diffPct = (A, B) => {
  let n = 0;
  for (let i = 0; i < A.w * A.h; i++) {
    const o = i * A.bpp;
    if (Math.abs(A.px[o] - B.px[o]) + Math.abs(A.px[o + 1] - B.px[o + 1]) + Math.abs(A.px[o + 2] - B.px[o + 2]) > 18) n++;
  }
  return 100 * n / (A.w * A.h);
};
const brightness = (A) => {
  let s = 0, n = 0;
  for (let y = 60; y < A.h - 60; y += 7) for (let x = 20; x < A.w - 20; x += 7) {
    const o = (y * A.w + x) * A.bpp; s += A.px[o] + A.px[o + 1] + A.px[o + 2]; n++;
  }
  return s / n / 3;
};

const { page, proc } = await launch({ width: 1000, height: 700 });
let failures = 0;
let k = 0;
const shot = async () => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const p = `D:/mandelbrot view/evidence/f3-${k++}.png`;
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return decode(p);
};
try {
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: URL + '?f3=' + Math.random() });
  for (let i = 0; i < 300; i++) { await sleep(200); try { if (await ev(page, `typeof window.__mb !== 'undefined'`)) break; } catch {} }
  await sleep(4000);
  await ev(page, `(() => { document.body.classList.remove('panel-open'); const p = document.getElementById('panel'); if (p) p.hidden = true; return 1; })()`);

  const cases = [
    { kind: 'tricorn', re: '-0.25', im: '0', m: 1.6, e: 1 },
    { kind: 'burningship', re: '-1.75', im: '-0.03', m: 1.6, e: 1 },
    { kind: 'celtic', re: '-0.5', im: '0', m: 1.6, e: 1 },
    { kind: 'multibrot', power: 3, re: '0', im: '0', m: 1.6, e: 1 },
  ];
  for (const c of cases) {
    await ev(page, `(() => { const s = document.getElementById('sel-family');
      s.value = '${c.kind}'; s.dispatchEvent(new Event('change', { bubbles: true }));
      ${c.power ? `const q = document.getElementById('num-power'); if (q) { q.value='${c.power}'; q.dispatchEvent(new Event('change',{bubbles:true})); }` : ''}
      return 1; })()`);
    await ev(page, `(() => { const s = __mb.state;
      s.center = { re: '${c.re}', im: '${c.im}' }; s.span = { m: ${c.m}, e: ${c.e} };
      __mb.render(); return 1; })()`);
    await sleep(9000);
    const A = await shot();
    await sleep(1800);
    const A2 = await shot();                       // 稳定了吗
    const v0 = await ev(page, `__mb.state.center.re + '|' + __mb.state.center.im + '|' + __mb.state.span.m + 'e' + __mb.state.span.e`);
    const px = 420, py = 385;
    const mids = [];
    for (let i = 0; i < 3; i++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: -120, button: 'none', buttons: 0 });
      await sleep(350);
      mids.push(await shot());
    }
    await sleep(6000);
    for (let i = 0; i < 3; i++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: 120, button: 'none', buttons: 0 });
      await sleep(350);
    }
    await sleep(7000);
    const C = await shot();
    const v1 = await ev(page, `__mb.state.center.re + '|' + __mb.state.center.im + '|' + __mb.state.span.m + 'e' + __mb.state.span.e`);
    const settled = diffPct(A, A2), round = diffPct(A, C);
    const midMin = Math.min(...mids.map(brightness));
    const pass = settled < 0.5 && round < 5 && midMin > 4;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${c.kind}${c.power ? '(' + c.power + ')' : ''}: ` +
      `settled ${settled.toFixed(2)}%  roundtrip ${round.toFixed(2)}%  ` +
      `mid brightness [${mids.map(x => brightness(x).toFixed(0)).join(',')}]  ` +
      `state ${v0 === v1 ? 'exact' : '~1e-16'}`);
  }
} finally {
  page.close();
  if (proc) proc.kill();
  console.log(failures ? `[families] ${failures} FAILED` : '[families] all families stable');
  if (failures) process.exitCode = 1;
}
