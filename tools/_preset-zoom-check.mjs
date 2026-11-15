/* _preset-zoom-check.mjs — 回归：预设放大不得触发迭代预算失控。
 *
 * 症状（用户报告）：带 GLSL 标签的预设「一放大就严重错位、不跟随鼠标 /
 * 手指」，且切换预设、大幅度平移时渲染极慢。根因不是坐标或参考轨道，
 * 是迭代预算的正反馈：浅景全景视点在 Mandelbrot 边界上，无论预算多大
 * 总有像素正好在 cap 处被截断；noteFrameObservation() 把这个被截断的
 * escMax 当作「该深度的真实观测」存进 OBS_BY_DEPTH，autoIterNow() 下一帧
 * 再乘 1.3，于是 783 -> 4000 -> 5152 -> ... -> 14607，单帧 0.32 s 涨到
 * 7.4 s。手势期间画面一直停在 blit 出来的旧位图上，看起来就是「跳到
 * 别处、不跟手」。
 *
 * 不变量：
 *   1. 连续 5 格真滚轮，迭代预算增长 < 1.8x（只随深度公式缓慢变化）
 *   2. 每格单帧 < 1.5 s、从事件到落帧 < 3 s
 *   3. 落帧中心 == 状态中心（没有停在旧帧上）
 *   4. 大幅度拖动落帧 < 3 s
 *   5. 放大后切回默认视图，预算不被深度表污染
 *
 *   node tools/_preset-zoom-check.mjs
 *   MB_URL=http://127.0.0.1:8777/index.html node tools/_preset-zoom-check.mjs
 */
import { launch, evaluate as ev, sleep } from './_cdp.mjs';

const URL = process.env.MB_URL ||
  'https://xiaoxu4452.github.io/mandelbrot-view/index.html';
const { page, proc } = await launch({ width: 1280, height: 860 });
const js = (e) => ev(page, e);
let failures = 0;

const SNAP = `JSON.stringify((() => {
  const m = __mb.meta(), it = __mb.iter(), p = __mb.paint(), s = __mb.state;
  return { frame: __mb.frames(), cap: m && m.cap, ms: m && Math.round(m.ms || 0),
    escMax: m && m.escMax, bounded: m && m.bounded,
    total: it.total, obsCap: it.cap, observedMax: it.observedMax,
    match: !!p && p.re === s.center.re && p.im === s.center.im &&
           p.m === s.span.m && p.e === s.span.e,
    drops: __mb.drops().n };
})())`;

async function waitFrame(before, limitMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    await sleep(200);
    const f = +(await js(`__mb.frames()`));
    if (f > before) return Date.now() - t0;
  }
  return -1;
}

async function closePanels() {
  await js(`(() => { const b=[...document.querySelectorAll('[data-close]')].find(e=>e.offsetParent);
    if (b) b.click(); document.body.classList.remove('panel-open');
    const p = document.getElementById('panel'); if (p) p.hidden = true; return 1; })()`);
  await sleep(700);
}

async function openPreset(id) {
  await js(`document.getElementById('btn-presets').click(); 1`);
  await sleep(1000);
  const f = +(await js(`__mb.frames()`));
  await js(`document.querySelector('.pcard[data-id=' + JSON.stringify(${JSON.stringify(id)}) + ']').click(); 1`);
  await waitFrame(f);
  await sleep(700);
  await closePanels();
}

function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
}

try {
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + 'pz=' + Math.random() });
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    try { if (await js(`typeof window.__mb !== 'undefined'`)) break; } catch {}
  }
  await sleep(3000);

  await js(`document.getElementById('btn-presets').click(); 1`);
  await sleep(1200);
  const cards = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.pcard')].map(e =>
    ({ id: e.dataset.id, glsl: /GLSL/.test((e.querySelector('.tag')||{}).textContent || '') })))`));
  const glsl = cards.filter(c => c.glsl).map(c => c.id);
  const plain = cards.filter(c => !c.glsl).map(c => c.id);
  check('preset library has GLSL cards', glsl.length > 0, `glsl=${glsl.length} plain=${plain.length}`);
  await closePanels();

  const targets = [...glsl.slice(0, 2), ...plain.slice(0, 1)];
  for (const id of targets) {
    console.log(`\n--- ${id} ---`);
    await openPreset(id);
    const open = JSON.parse(await js(SNAP));
    console.log(`open   cap=${open.cap} ms=${open.ms} total=${open.total}`);
    const caps = [open.cap], waits = [], mss = [];
    /* Drops are a cumulative diagnostic: boot / preset loading can drop a
     * stale frame on purpose (v52 arms a retry for it).  What must be zero is
     * the number of NEW drops during the gesture, not the session total. */
    const drops0 = open.drops;
    let allMatch = open.match;
    for (let n = 1; n <= 5; n++) {
      const f = +(await js(`__mb.frames()`));
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel',
        x: 430, y: 330, deltaX: 0, deltaY: -120, button: 'none', buttons: 0 });
      const w = await waitFrame(f);
      await sleep(350);
      const s = JSON.parse(await js(SNAP));
      caps.push(s.cap); waits.push(w); mss.push(s.ms);
      allMatch = allMatch && s.match && s.drops === drops0;
    }
    const growth = caps[caps.length - 1] / Math.max(1, caps[0]);
    const slowest = Math.max(...mss), longest = Math.max(...waits);
    console.log(`caps   ${caps.join(' -> ')}`);
    console.log(`ms     ${mss.join(', ')}   waits ${waits.join(', ')}`);
    check(`${id}: budget stays bounded`, growth < 1.8,
      `growth ${growth.toFixed(2)}x (was 18.7x before the fix)`);
    check(`${id}: frames land fast`, slowest < 1500 && longest > 0 && longest < 3000,
      `slowest frame ${slowest} ms, longest wait ${longest} ms`);
    check(`${id}: no stale frame`, allMatch,
      `painted view == state, no new drops (baseline ${drops0})`);

    /* 大幅度拖动 */
    const f = +(await js(`__mb.frames()`));
    const mouse = (t, x, y) => page.send('Input.dispatchMouseEvent', { type: t, x, y,
      button: 'left', buttons: t === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mousePressed', 320, 420);
    for (let i = 1; i <= 14; i++) { await mouse('mouseMoved', 320 + i * 28, 420 - i * 8); await sleep(20); }
    await mouse('mouseReleased', 320 + 14 * 28, 420 - 14 * 8);
    const dw = await waitFrame(f);
    check(`${id}: large pan lands fast`, dw > 0 && dw < 3000, `${dw} ms`);
  }

  /* 切回默认视图：深度观测表不得把首页预算抬起来 */
  await js(`(() => { const s=__mb.state; s.center={re:'-0.6',im:'0'}; s.span={m:1.6,e:1};
    s.presetId=null; __mb.render(); return 1; })()`);
  await sleep(2500);
  const home = JSON.parse(await js(SNAP));
  check('return to default view is clean', home.total < 3000 && home.ms < 1500 && home.match,
    `total=${home.total} ms=${home.ms}`);
} finally {
  page.close();
  if (proc) proc.kill();
  console.log(failures ? `[preset-zoom] ${failures} FAILED` : '[preset-zoom] all checks passed');
  if (failures) process.exitCode = 1;
}
