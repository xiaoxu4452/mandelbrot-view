/* _preset-lag-check.mjs — "switching presets gets slower every time".
 *
 * Repeatedly opens presets in a real browser and records, per switch:
 *   - time until a frame actually settles (not just the HUD's 101 ms core time)
 *   - the visible buffer/snapshot geometry and how much of the canvas is black
 *   - every queue / worker / timer / cache counter exposed by __mb.queues()
 *
 * An accumulator shows up as a counter that never returns to its baseline,
 * or as a settle time that grows monotonically.
 *
 *   node server/static-server.mjs --port 8777
 *   MB_URL=http://127.0.0.1:8777/index.html node tools/_preset-lag-check.mjs
 */
import fs from 'node:fs';
import { launch, evaluate as ev, sleep } from '../tools/_cdp.mjs';
import { decode } from '../tools/_pngdiff.mjs';

const URL = process.env.MB_URL || 'https://xiaoxu4452.github.io/mandelbrot-view/index.html';
const ROUNDS = Number(process.env.MB_ROUNDS || 9);
const EVID = 'D:/mandelbrot view/evidence';
fs.mkdirSync(EVID, { recursive: true });

function frameStats(A) {
  const { w, h, bpp, px } = A;
  let black = 0, lit = 0, topLeft = 0, rest = 0, tlN = 0, restN = 0;
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const o = (y * w + x) * bpp;
      const b = px[o] + px[o + 1] + px[o + 2];
      if (b < 12) black++; else lit++;
      if (x < w * 0.5 && y < h * 0.5) { topLeft += b; tlN++; }
      else { rest += b; restN++; }
    }
  }
  return {
    blackPct: 100 * black / (black + lit),
    tl: topLeft / Math.max(1, tlN) / 3,
    rest: rest / Math.max(1, restN) / 3,
  };
}

const { page, proc } = await launch({ width: 1000, height: 700 });
let shotNo = 0;
const shot = async () => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const p = `${EVID}/lag-${shotNo++}.png`;
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return frameStats(decode(p));
};

try {
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: URL + '?lag=' + Math.random() });
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    try { if (await ev(page, `typeof window.__mb !== 'undefined'`)) break; } catch {}
  }
  await sleep(4500);
  await ev(page, `(() => { document.body.classList.remove('panel-open');
    const p=document.getElementById('panel'); if(p) p.hidden=true; return 1; })()`);
  await ev(page, `(() => { document.getElementById('btn-presets').click(); return 1; })()`);
  await sleep(2500);
  const ids = JSON.parse(await ev(page,
    `JSON.stringify([...document.querySelectorAll('#preset-grid .pcard')].map(e=>e.dataset.id).slice(0,24))`));
  console.log(`[lag] ${ids.length} preset cards visible; ${ROUNDS} switches`);
  if (!ids.length) throw new Error('no preset cards');

  const rows = [];
  /* Alternate the SAME two presets.  Cycling through different ones only
   * measures their depth: a 1e74 example legitimately needs 100k iterations.
   * Comparing round 0/2/4/... against each other isolates accumulation. */
  const MIX = !!process.env.MB_MIX;
  const A = ids[0], B = ids[Math.min(1, ids.length - 1)];
  for (let k = 0; k < ROUNDS; ++k) {
    const id = MIX ? ids[k % ids.length] : (k % 2 === 0 ? A : B);
    const before = JSON.parse(await ev(page, `JSON.stringify({f:__mb.frames(),q:__mb.queues()})`));
    const t0 = Date.now();
    await ev(page, `(() => { const el=[...document.querySelectorAll('#preset-grid .pcard')]
      .find(e=>e.dataset.id===${JSON.stringify(id)}); if(el) el.click(); return 1; })()`);
    let settled = -1, last = before.f;
    for (let i = 0; i < 90; ++i) {
      await sleep(250);
      const f = Number(await ev(page, `__mb.frames()`));
      if (f > last) { last = f; settled = i; }
      if (settled >= 0 && i - settled >= 4) break;
    }
    const ms = Date.now() - t0;
    const s = JSON.parse(await ev(page, `JSON.stringify({
      q:__mb.queues(), cache:__mb.cache(), layer:__mb.layer(),
      meta:__mb.meta(), frame:__mb.frame(), drops:__mb.drops(),
      viewport:__mb.viewport(), coreWhy:__mb.coreWhy(),
      iter:__mb.iter(), spanE:__mb.state.span.e, spec:__mb.state.spec.kind
    })`));
    const px = await shot();
    rows.push({ k, id, ms, settled, px, s, before });
    const q = s.q;
    console.log(
      `#${k} ${String(id).slice(0, 40).padEnd(40)} settle ${String(ms).padStart(6)}ms ` +
      `frame ${String(Math.round(s.frame)).padStart(5)}ms  ` +
      `black ${px.blackPct.toFixed(1).padStart(5)}%  tl/rest ${px.tl.toFixed(0)}/${px.rest.toFixed(0)}  ` +
      `q[pending ${q.pending} main ${q.main} thumb ${q.thumb} jobs ${q.thumbJobs} ` +
      `busy ${q.busy} cap ${q.deepPixelCap}]  ` +
      `cache ${s.cache.fields}/${(s.cache.bytes / 1048576).toFixed(0)}MB  ` +
      `buf ${s.layer.c2d.join('x')}  drops ${s.drops.n}  ` +
      `iter ${s.iter.total}/${s.iter.cap}  e ${s.spanE}  ${s.spec}`);
  }

  /* Accumulation verdict: a counter that ends above its starting value, or a
   * settle time whose last third is much worse than its first third. */
  /* Only compare rounds that opened the SAME preset (A), so a deep example's
   * legitimate cost cannot masquerade as accumulation. */
  const sameA = rows.filter((r) => r.id === A);
  const first = sameA.slice(0, 2), last3 = sameA.slice(-2);
  const avg = (a, f) => a.reduce((s, r) => s + f(r), 0) / Math.max(1, a.length);
  const tFirst = avg(first, (r) => r.ms), tLast = avg(last3, (r) => r.ms);
  const q0 = rows[0].s.q, qN = rows[rows.length - 1].s.q;
  const growth = {
    pending: qN.pending - q0.pending,
    thumbQueue: qN.thumb - q0.thumb,
    thumbJobs: qN.thumbJobs - q0.thumbJobs,
    mainQueue: qN.main - q0.main,
    workers: qN.workers - q0.workers,
    drops: rows[rows.length - 1].s.drops.n - rows[0].s.drops.n,
    cache: rows[rows.length - 1].s.cache.fields - rows[0].s.cache.fields,
  };
  console.log(`[lag] first3 ${tFirst.toFixed(0)}ms -> last3 ${tLast.toFixed(0)}ms ` +
              `(${(tLast / Math.max(1, tFirst)).toFixed(2)}x)`);
  console.log('[lag] counter growth', JSON.stringify(growth));
  const badBlack = rows.filter((r) => r.px.blackPct > 35).length;
  console.log(`[lag] frames with >35% black: ${badBlack}/${rows.length}`);
  /* `drops` is a cumulative session counter of frames superseded during
   * gestures -- expected and bounded per switch, not a leaked resource.  Only
   * QUEUE lengths, worker counts and cache occupancy can indicate a real
   * accumulator. */
  const growing = Object.entries(growth).filter(([k, v]) => v > 2 && k !== 'drops');
  if (growing.length || tLast > tFirst * 1.6 || badBlack > 1) {
    console.log('[lag] ACCUMULATION DETECTED ' +
                (growing.length ? JSON.stringify(growing) : 'via settle time / black frames'));
    process.exitCode = 1;
  } else {
    console.log('[lag] no accumulation');
  }
} finally {
  page.close();
  if (proc) proc.kill();
}
