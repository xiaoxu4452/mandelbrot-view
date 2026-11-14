/* colortime.mjs — how long does a colour / fractal switch take to reach the
 * screen?  "Switching the palette stutters" is a latency claim, so it is
 * measured: from the DOM change event to the next completed frame.
 *
 *   node tools/colortime.mjs [--depth -20] [--port 9333]
 */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));
const DEPTH = Number(arg('depth', -20));

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
    logs.push('[error] ' + (m.params.args || []).map(a => a.value ?? '').join(' ').slice(0, 160));
};
const send = (m2, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m2, params: p })); return new Promise(r => pending.set(id, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1248, height: 704, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); try { if (await ev('!!(window.__mb && window.__mb.frames() > 0)')) break; } catch {} }
await new Promise(r => setTimeout(r, 1200));

/* Deep enough that the CPU fallback is expensive: any switch that drops off the
 * shader path will show its real cost here. */
await ev(`(() => { const st = window.__mb.state;
  st.center = { re: '-0.743643887037151', im: '0.131825904205330' };
  st.span = { m: 1.6, e: ${DEPTH} }; window.__mb.render(); return 1; })()`);
const settle = async (limit = 90, baseIn = null) => {
  const t0 = Date.now();
  const base = baseIn == null ? Number(await ev('window.__mb.frames()')) : baseIn;
  for (let i = 0; i < limit * 4; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (Number(await ev('window.__mb.frames()')) > base) break;
  }
  return Date.now() - t0;
};
const first = await settle();
console.log(`initial deep frame      ${first} ms`);
const look = async () => JSON.parse(await ev(`(() => { const s = window.__mb.state;
  return JSON.stringify({ palette: s.palette, stops: s.stops ? s.stops.length : 0,
    spec: s.spec.mode + '/' + s.spec.kind, meta: window.__mb.meta() }); })()`));

const timed = async (label, script) => {
  const before = await look();
  const base = Number(await ev('window.__mb.frames()'));   // must be read BEFORE the change
  const t0 = Date.now();
  await ev(script);
  const ms = await settle(90, base);
  const after = await look();
  console.log(`${label.padEnd(24)} ${String(ms).padStart(6)} ms  ` +
              `${after.meta && after.meta.engine}/${after.meta && after.meta.mode} ` +
              `pal=${after.palette} stops=${after.stops} spec=${after.spec}`);
  return { ms, before, after };
};

await timed('palette ice', `(() => { const el = document.getElementById('sel-palette');
  el.value = 'ice'; el.dispatchEvent(new Event('change')); return 1; })()`);
await timed('palette viridis', `(() => { const el = document.getElementById('sel-palette');
  el.value = 'viridis'; el.dispatchEvent(new Event('change')); return 1; })()`);
await timed('palette copper', `(() => { const el = document.getElementById('sel-palette');
  el.value = 'copper'; el.dispatchEvent(new Event('change')); return 1; })()`);
await timed('kind tricorn', `(() => { const st = window.__mb.state; st.spec = { ...st.spec, kind: 'tricorn' };
  window.__mb.render(); return 1; })()`);
await timed('kind mandelbrot', `(() => { const st = window.__mb.state; st.spec = { ...st.spec, kind: 'mandelbrot' };
  window.__mb.render(); return 1; })()`);
await timed('mode julia', `(() => { const st = window.__mb.state; st.spec = { ...st.spec, mode: 'j' };
  window.__mb.render(); return 1; })()`);
await timed('mode mandelbrot', `(() => { const st = window.__mb.state; st.spec = { ...st.spec, mode: 'm' };
  window.__mb.render(); return 1; })()`);
await timed('ramp (2 stops)', `(() => { const st = window.__mb.state;
  st.stops = [[0, 5, 6, 9], [1, 240, 220, 180]]; window.__mb.render(); return 1; })()`);
await timed('ramp cleared', `(() => { const st = window.__mb.state; st.stops = null;
  window.__mb.render(); return 1; })()`);

console.log('logs', logs.slice(-3).join(' | ') || 'none');
ws.close(); process.exit(0);
