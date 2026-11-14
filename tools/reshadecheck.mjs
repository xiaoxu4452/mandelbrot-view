/* reshadecheck.mjs — is a re-shaded frame the same picture as a re-rendered one?
 *
 *   node tools/reshadecheck.mjs [--depth -30]
 *
 * The page can re-shade a finished CPU frame from its colour-position field
 * (kernel.cpp gField) instead of re-iterating it.  That is only allowed to be a
 * speed-up, never a different picture: this measures the two against each
 * other, pixel for pixel.
 */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));
const DEPTH = Number(arg('depth', -30));

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
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};
const settle = async (startFrames) => {
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (Number(await ev('window.__mb.frames()')) > startFrames) break;
  }
  await new Promise(r => setTimeout(r, 300));
  return Date.now() - t0;
};
const frames = () => ev('window.__mb.frames()');
const grab = (slot) => ev(`(() => { const cv = document.getElementById('fractal');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  (window.__g = window.__g || [])[${slot}] = d.slice(); return 1; })()`);

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1248, height: 704, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); try { if (await ev('!!(window.__mb && window.__mb.frames() > 0)')) break; } catch {} }
await new Promise(r => setTimeout(r, 1200));

let f = await frames();
await ev(`(() => { const st = window.__mb.state; st.gpu = false;
  st.center = { re: '-0.743643887037151', im: '0.131825904330' };
  st.span = { m: 1.6, e: ${DEPTH} };
  const el = document.getElementById('sel-palette'); el.value = 'copper'; el.dispatchEvent(new Event('change'));
  return 1; })()`);
await settle(f);
console.log('base frame', await ev('JSON.stringify(window.__mb.meta())'));

/* 1. re-shade with a different palette */
f = await frames();
let t0 = Date.now();
await ev(`(() => { const el = document.getElementById('sel-palette');
  el.value = 'viridis'; el.dispatchEvent(new Event('change')); return 1; })()`);
const reshadeMs = await settle(f);
await grab(0);
const metaA = await ev('JSON.stringify(window.__mb.meta())');
console.log(`reshade  ${reshadeMs} ms  engine=${JSON.parse(metaA).engine} ms=${Math.round(JSON.parse(metaA).ms)}`);

/* 2. same colours, full render */
f = await frames();
await ev(`(() => { window.__mb.render(); return 1; })()`);
await settle(f);
await grab(1);
const metaB = await ev('JSON.stringify(window.__mb.meta())');
console.log(`render   engine=${JSON.parse(metaB).engine}`);

const diff = JSON.parse(await ev(`(() => {
  const [a, b] = window.__g || [];
  if (!a || !b) return JSON.stringify({ n: -1 });
  let n = 0, maxd = 0, over2 = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);
    if (d) { n++; if (d > maxd) maxd = d; if (d > 2) over2++; }
  }
  return JSON.stringify({ n, maxd, over2, total: a.length / 4 });
})()`));
console.log('reshaded vs rendered:', JSON.stringify(diff));
const pass = diff.n >= 0 && diff.over2 === 0;
console.log(pass ? 'PASS' : 'FAIL');
console.log('logs', logs.slice(-2).join(' | ') || 'none');
ws.close();
process.exit(pass ? 0 : 1);
