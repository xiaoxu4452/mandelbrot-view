/* wheelzoom.mjs — zoom the way a user does: a burst of wheel events, then look
 * at what the page did.
 *
 *   node tools/wheelzoom.mjs [--steps 30] [--shot out.png]
 *
 * Two things are measured, because "it stutters" is two different bugs:
 *   · responsiveness — how long a trivial script takes to run while the pass is
 *     going (a blocked main thread is a frozen cursor, not a slow picture);
 *   · picture integrity — how much of the canvas is a single flat colour after
 *     the frame lands (a deep pass that paints one enormous tile leaves the
 *     rest as the previous frame's interior colour, i.e. "large colour blocks").
 */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));
const STEPS = Number(arg('steps', 30));
const GPU_ON = args.indexOf('--nogpu') < 0;   // default: the path a user gets
const CENTER = { re: '-0.743643887037151', im: '0.131825904205330' };

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no page'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 200));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    logs.push('[error] ' + (m.params.args || []).map(a => a.value ?? '').join(' ').slice(0, 200));
};
const send = (m2, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m2, params: p })); return new Promise(r => pending.set(id, r)); };
const ev = async (x, timeout = 15000) => {
  const t0 = Date.now();
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }),
    new Promise(r => setTimeout(() => r({ timeout: true }), timeout))
  ]);
  if (r.timeout) return { __timeout: Date.now() - t0 };
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1248, height: 704, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); try { if (await ev('!!(window.__mb && window.__mb.frames() > 0)')) break; } catch {} }
await new Promise(r => setTimeout(r, 1000));

/* Start at 2^-20 and wheel in: 30 steps of 1.6x is 2^-6.4 deeper each 10 steps. */
await ev(`(() => { const st = window.__mb.state; st.gpu = ${GPU_ON};
  st.center = { re: '${CENTER.re}', im: '${CENTER.im}' };
  st.span = { m: 1.6, e: -20 }; window.__mb.render(); return 1; })()`);
for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 300)); if (await ev('window.__mb.frames() > 1')) break; }

/* Wheel burst at the canvas centre: this is what "zoom in" feels like. */
const CX = 624, CY = 352;
const lag = [];
for (let i = 0; i < STEPS; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: CX, y: CY, deltaX: 0, deltaY: -120, modifiers: 0
  });
  await new Promise(r => setTimeout(r, 60));
  if (i % 5 === 0) {
    const r = await ev('1', 4000);
    lag.push(typeof r === 'object' && r.__timeout ? 999 : 0);
  }
}
const spanAfter = JSON.parse(await ev(`JSON.stringify(window.__mb.state.span)`));
console.log('wheel burst done, span', JSON.stringify(spanAfter));
console.log('main-thread stalls (>4s to run `1`)', lag.filter(x => x).length, 'of', lag.length);

/* Wait for the frame to settle (HUD stops saying 渲染中). */
const t0 = Date.now();
let hud = '';
for (let i = 0; i < 400; i++) {
  await new Promise(r => setTimeout(r, 500));
  const r = await ev(`document.getElementById('hud').textContent.replace(/\\s+/g,' ')`);
  if (typeof r !== 'string') continue;
  hud = r;
  if (i > 2 && !/渲染中|rendering/i.test(r)) break;
  if (Date.now() - t0 > 200000) break;
}
console.log(`settled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('hud', hud.trim().slice(0, 140));

/* Integrity: how dominant is the single largest quantised colour, and how many
 * 64x64 blocks are uniform (a blocky frame is many uniform blocks). */
const stats = await ev(`(() => {
  const cv = document.getElementById('fractal'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, d = g.getImageData(0, 0, W, H).data;
  const hist = new Map(); let n = 0;
  for (let i = 0; i < d.length; i += 4 * 17) {
    n++; const k = (d[i] >> 2) + ',' + (d[i+1] >> 2) + ',' + (d[i+2] >> 2);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const top = Math.max(...hist.values()) / n;
  let uni = 0, blocks = 0;
  for (let by = 0; by + 64 <= H; by += 64) for (let bx = 0; bx + 64 <= W; bx += 64) {
    blocks++;
    const p0 = (by * W + bx) * 4;
    let same = true;
    for (let y = 0; y < 64 && same; y += 4) for (let x = 0; x < 64; x += 4) {
      const p = ((by + y) * W + bx + x) * 4;
      if (Math.abs(d[p] - d[p0]) > 2 || Math.abs(d[p+1] - d[p0+1]) > 2 || Math.abs(d[p+2] - d[p0+2]) > 2) { same = false; break; }
    }
    if (same) uni++;
  }
  return JSON.stringify({ W, H, colours: hist.size, topShare: +top.toFixed(3),
    uniformBlocks: uni, blocks, meta: window.__mb.meta() });
})()`);
console.log('canvas', typeof stats === 'string' ? stats : JSON.stringify(stats));
console.log('logs', logs.slice(-3).join(' | ') || 'none');
const shotTo = arg('shot', '');
if (shotTo) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(shotTo, Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT', shotTo);
}
ws.close(); process.exit(0);
