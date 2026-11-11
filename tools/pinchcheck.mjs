/* ------------------------------------------------------------------
 * pinchcheck.mjs — drive the real touch handlers through CDP.
 *
 * A phone-sized viewport with touch emulation, then genuine
 * Input.dispatchTouchEvent sequences (the browser turns these into pointer
 * events, so the page's own pointerdown/move/up code runs — nothing is
 * stubbed).  Checks:
 *
 *   1. two fingers spreading ×2 zooms in ×2 (span halves, psLog2 -1);
 *   2. the plane point under the finger midpoint stays under it;
 *   3. closing the fingers zooms back out to the starting span;
 *   4. one-finger pan after a pinch moves the centre the opposite way;
 *   5. the canvas ends up fully painted (no unrendered region).
 *
 *   node tools/pinchcheck.mjs [--port 9333] [--shot out.png]
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));
const SHOT = arg('shot', '');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no page target'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const errs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errs.push((m.params.args || []).map(a => a.value ?? '').join(' '));
};
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, 10000));

const waitFrame = async () => {
  let prev = -1;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300));
    const n = await ev('window.__mb.frames()');
    if (n === prev) return n;
    prev = n;
  }
  return prev;
};
await waitFrame();

const view = () => ev(`(() => { const s = window.__mb.state, cv = document.getElementById('fractal');
  const m = s.span.m, e = s.span.e;
  return JSON.stringify({ span: m * Math.pow(2, e), m, e, re: s.center.re, im: s.center.im,
    w: cv.width, h: cv.height, dpr: window.devicePixelRatio }); })()`);
const V = JSON.parse(await view());
const psLog2 = (v) => Math.log2(Math.abs(v.span) / v.w);
const v0 = { ...V, l2: psLog2(V) };
console.log(`viewport ${V.w}x${V.h} dpr ${V.dpr}  psLog2 ${v0.l2.toFixed(3)}`);

/* Where the gesture happens: the geometric centre of the canvas. */
const cx = 195, cy = 420;
const touch = (type, pts) => send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const two = (dx) => [{ x: cx - dx, y: cy, id: 0, radiusX: 12, radiusY: 12, force: 1 },
                     { x: cx + dx, y: cy, id: 1, radiusX: 12, radiusY: 12, force: 1 }];

/* --- 1. spread the fingers: 60 px apart -> 180 px apart (x3) --- */
await touch('touchStart', two(30));
await new Promise(r => setTimeout(r, 60));
for (const d of [45, 60, 75, 90]) {
  await touch('touchMove', two(d));
  await new Promise(r => setTimeout(r, 60));
}
await touch('touchEnd', [{ x: cx + 90, y: cy, id: 0, radiusX: 12, radiusY: 12, force: 1 }]);
await new Promise(r => setTimeout(r, 1200));
await waitFrame();
const v1 = JSON.parse(await view());
const l2a = psLog2(v1);
console.log(`spread 60->180 (x3): psLog2 ${l2a.toFixed(3)} (expected ${(v0.l2 - Math.log2(3)).toFixed(3)}), ` +
            `centre Δ ${(v1.re - v0.re).toExponential(2)}, ${(v1.im - v0.im).toExponential(2)}`);

/* --- 2. close them again: back to the start --- */
await touch('touchStart', two(90));
await new Promise(r => setTimeout(r, 60));
for (const d of [75, 60, 45, 30]) {
  await touch('touchMove', two(d));
  await new Promise(r => setTimeout(r, 60));
}
await touch('touchEnd', [{ x: cx + 30, y: cy, id: 0, radiusX: 12, radiusY: 12, force: 1 }]);
await new Promise(r => setTimeout(r, 1200));
await waitFrame();
const v2 = JSON.parse(await view());
const l2b = psLog2(v2);
console.log(`close 180->60 (x1/3): psLog2 ${l2b.toFixed(3)} (expected ${(l2a + Math.log2(3)).toFixed(3)})`);

/* --- 3. one-finger pan --- */
await touch('touchStart', [{ x: cx, y: cy, id: 0, radiusX: 12, radiusY: 12, force: 1 }]);
for (const [x, y] of [[cx - 30, cy], [cx - 60, cy], [cx - 90, cy]]) {
  await touch('touchMove', [{ x, y, id: 0, radiusX: 12, radiusY: 12, force: 1 }]);
  await new Promise(r => setTimeout(r, 70));
}
await touch('touchEnd', []);
await new Promise(r => setTimeout(r, 1500));
await waitFrame();
const v3 = JSON.parse(await view());
console.log(`pan left 90 px: centre re ${v2.re} -> ${v3.re} (should increase), im ${v2.im} -> ${v3.im}`);

/* --- 4. is the canvas fully painted? --- */
const paint = JSON.parse(await ev(`(() => {
  const cv = document.getElementById('fractal'), g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  let black = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { n++; if (d[i] === 0 && d[i+1] === 0 && d[i+2] === 0) black++; }
  return JSON.stringify({ black, n, frac: +(black / n).toFixed(4), w: cv.width, h: cv.height });
})()`));
console.log(`unpainted (pure black) samples: ${paint.black}/${paint.n} = ${(paint.frac * 100).toFixed(1)}%`);
console.log(`errors: ${errs.slice(-3).join(' | ') || 'none'}`);

const spreadOk = Math.abs(l2a - (v0.l2 - Math.log2(3))) < 0.15;
const backOk = Math.abs(l2b - v0.l2) < 0.2;
const midOk = Math.abs(Number(v1.re) - Number(v0.re)) < Math.abs(v0.span) * 0.02;
const panOk = Number(v3.re) > Number(v2.re);
const paintOk = paint.frac < 0.05;
console.log(`checks: spread=${spreadOk} back=${backOk} midpoint=${midOk} pan=${panOk} painted=${paintOk}`);
const pass = spreadOk && backOk && midOk && panOk && paintOk && !errs.length;
console.log(pass ? 'PASS' : 'FAIL');

if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT', SHOT);
  }
}
ws.close();
process.exit(pass ? 0 : 1);
