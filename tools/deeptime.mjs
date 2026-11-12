/* deeptime.mjs — measure how long a deep view takes, end to end, in the browser.
 *
 *   node tools/deeptime.mjs [--depths -57,-80,-100] [--port 9333]
 *
 * It disables the in-page GPU shading pass (so the CPU worker path is the one
 * being measured), sets a fixed viewport, and waits for the frame counter to
 * stop advancing before reporting.  Prints per-depth wall time plus the last
 * pass metadata (engine, bits, perturb mode, reference-orbit length).
 */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));
const DEPTHS = String(arg('depths', '-57,-80,-100')).split(',').map(Number);
const CENTER = { re: '-0.743643887037151', im: '0.131825904205330' };

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no page at /index.html'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 200));
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (m.params.type === 'error' || m.params.type === 'warning') logs.push(`[${m.params.type}] ` + t.slice(0, 200));
  }
};
const send = (m2, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m2, params: p })); return new Promise(r => pending.set(id, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1248, height: 704, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  try { if (await ev('!!(window.__mb && window.__mb.frames() > 0)')) break; } catch { /* loading */ }
}
await new Promise(r => setTimeout(r, 1200));
console.log('engine at rest:', await ev(`(() => { const q=(s)=>{const e=document.querySelector(s);return e?e.textContent.trim():null;};
  return JSON.stringify({ meta: window.__mb.meta() && window.__mb.meta().engine, hud: (q('#hud')||'').replace(/\\s+/g,' ').slice(0,70) }); })()`));

for (const D of DEPTHS) {
  const base = Number(await ev('window.__mb.frames()'));
  await ev(`(() => { const st = window.__mb.state;
    st.gpu = false;
    st.center = { re: '${CENTER.re}', im: '${CENTER.im}' };
    st.span = { m: 1.6, e: ${D} };
    window.__mbTiles = []; window.__mbDebug = true;
    window.__mb.render(); return 1; })()`);
  const t0 = Date.now();
  let last = base, settled = false;
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 500));
    const n = Number(await ev('window.__mb.frames()'));
    if (n > base) { if (n === last) { settled = true; break; } last = n; }
    if (Date.now() - t0 > 240000) break;
  }
  const info = JSON.parse(await ev(`(() => { const q=(s)=>{const e=document.querySelector(s);return e?e.textContent.trim():null;};
    return JSON.stringify({ hud: (q('#hud')||'').replace(/\\s+/g,' '), meta: window.__mb.meta(),
      tiles: (window.__mbTiles||[]).length }); })()`));
  const m = info.meta || {};
  console.log(`2^${D}  wall ${((Date.now() - t0) / 1000).toFixed(1)}s settled=${settled} ` +
              `tiles=${info.tiles} engine=${m.engine} mode=${m.mode} bits=${m.bits} ` +
              `refLen=${m.refLen} saSkip=${m.saSkip} ms=${m.ms && Math.round(m.ms)}`);
  console.log('   hud', String(info.hud).slice(0, 120));
}
const errs = logs.filter(l => /error|EXC/i.test(l));
console.log('logs', errs.slice(-3).join(' | ') || 'none');
const shotTo = arg('shot', '');
if (shotTo) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(shotTo, Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT', shotTo);
}
ws.close(); process.exit(0);
