/* _coreui.mjs — end-to-end check of the restored UI running on core.wasm.
 *
 * Drives the real page through CDP: waits for the first core frame, reads the
 * HUD and lastMeta (engine must be 'core'), then zooms with wheel events and
 * with touch gestures, and reports frame times.  Screenshots land in evidence/.
 *
 * usage: node tools/_coreui.mjs [port]
 */
import fs from 'node:fs';

const PORT = Number(process.argv[2] || process.env.MB_CDP_PORT || 9345);
const OUT = 'D:/mandelbrot view/evidence';
fs.mkdirSync(OUT, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('no page: ' + JSON.stringify(list.map(t => t.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pend = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.text + ' ' +
    (m.params.exceptionDetails.exception?.description || ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    logs.push('console.error ' + m.params.args.map(a => a.value || a.description || '').join(' '));
  }
};
const send = (method, params = {}) => {
  const k = ++id;
  ws.send(JSON.stringify({ id: k, method, params }));
  return new Promise((r) => pend.set(k, r));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 400));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = `${OUT}/${name}.png`;
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

async function hud() {
  return ev(`JSON.stringify({
    stat: document.getElementById('hud-engine')?.textContent,
    zoom: document.getElementById('hud-depth')?.textContent,
    prog: document.getElementById('hud-progress')?.textContent,
    coord: (document.getElementById('hud-center')||document.getElementById('hud-coord'))?.textContent,
    prec: document.getElementById('chip-precision')?.textContent,
    meta: (window.__mb && __mb.meta) ? __mb.meta() : null,
    center: __mb.state.center, span: __mb.state.span,
  })`).then((s) => JSON.parse(s));
}

/** Wait until a *new* finished final frame lands after this call started. */
async function waitFrame(label, timeoutMs = 180000) {
  const t0 = Date.now();
  const seq0 = JSON.parse(await ev(`JSON.stringify({s:(__mb.meta()||{}).seq||0})`)).s;
  while (Date.now() - t0 < timeoutMs) {
    const raw = await ev(`(() => { const m = __mb.meta() || {}; return JSON.stringify({seq:m.seq, engine:m.engine, ms:m.ms, done:m.done, final:m.final, escMin:m.escMin, escMax:m.escMax, bits:m.bits, refLen:m.refLen, mode:m.mode, cap:m.cap}); })()`);
    const o = JSON.parse(raw);
    if (o.seq > seq0 && o.done && o.final !== false) return { ...o, wall: Date.now() - t0 };
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

console.log('boot:', JSON.stringify(await hud()));
/* The first frame usually lands while the test was booting; take it as-is. */
let first = null;
for (let i = 0; i < 240; i++) {
  const o = JSON.parse(await ev(`(() => { const m = __mb.meta() || {}; return JSON.stringify({seq:m.seq, engine:m.engine, ms:m.ms, done:m.done, final:m.final, escMin:m.escMin, escMax:m.escMax, bits:m.bits, refLen:m.refLen, mode:m.mode, cap:m.cap}); })()`));
  if (o.done && o.final !== false && o.engine === 'core') { first = o; break; }
  await sleep(250);
}
if (!first) throw new Error('no core frame at boot');
console.log('first frame:', JSON.stringify(first));
console.log('shot:', await shot('core-ui-01-home'));

/* ---- wheel zoom: 6 notches in at the frame centre ---- */
const box = await ev(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`);
const { x, y } = JSON.parse(box);
for (let i = 0; i < 6; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, modifiers: 0, pointerType: 'mouse' });
  await sleep(60);
}
const zf = await waitFrame('wheel frame');
console.log('after 6 wheel notches:', JSON.stringify(zf));
console.log('hud:', JSON.stringify(await hud()));
console.log('shot:', await shot('core-ui-02-wheel'));

/* ---- deep view: c = i at 1e600 (exact coordinates, no digits lost) ---- */
const deep = await ev(`(() => {
  const lz = 600;                      // decimal zoom
  const log2span = Math.log2(3) - lz * Math.log2(10);
  const e = Math.floor(log2span);
  const m = Math.pow(2, log2span - e);
  __mb.state.spec.mode = 'm';
  __mb.state.spec.kind = 'mandelbrot';
  __mb.state.spec.power = 2;
  __mb.state.center = { re: '0', im: '1' };
  __mb.state.span = { m, e };
  __mb.render();
  return JSON.stringify({ m, e, span: m * Math.pow(2, e) });
})()`);
console.log('deep set:', deep);
const d1 = await waitFrame('deep frame 1e600', 600000);
console.log('deep 1e600:', JSON.stringify(d1));
console.log('hud:', JSON.stringify(await hud()));
console.log('shot:', await shot('core-ui-03-deep600'));

/* ---- touch: one-finger drag pans, two-finger pinch zooms ---- */
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
const before = await hud();
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 12, y: y + i * 6, id: 1 }] });
  await sleep(30);
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const afterDrag = await hud();
console.log('touch drag:', JSON.stringify({ before: before.center, after: afterDrag.center }));

await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 80, y, id: 1 }, { x: x + 80, y, id: 2 }] });
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 80 - i * 10, y, id: 1 }, { x: x + 80 + i * 10, y, id: 2 }] });
  await sleep(30);
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const afterPinch = await hud();
console.log('touch pinch:', JSON.stringify({ before: afterDrag.zoom, after: afterPinch.zoom, center: afterPinch.center }));
console.log('shot:', await shot('core-ui-04-touch'));
const tf = await waitFrame('touch frame', 300000).catch((e) => ({ err: String(e) }));
console.log('touch frame:', JSON.stringify(tf));

console.log('logs:', JSON.stringify(logs.slice(0, 12)));
ws.close();
