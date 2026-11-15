/* Check the web shell after the view moved into the core.
 *
 * The shell no longer does coordinate arithmetic: it posts raw input and stores
 * the centre the core answers with.  So the test is end-to-end through real
 * input events: after a burst of wheel notches the HUD zoom must have moved by
 * exactly the accumulated factor, the centre must be a full-precision string at
 * the new depth, and zooming back out must land on the same centre — if the
 * core's zoom_at_pixel were wrong, the round trip would not close.
 */
const PORT = process.env.MB_CDP_PORT || 9344;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const k = ++id; ws.send(JSON.stringify({ id: k, method, params })); return new Promise((r) => pend.set(k, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 300));
  }
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Log.enable');
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') logs.push(JSON.stringify(m.params.exceptionDetails.text));
});

// boot: wait for the first committed frame
let ready = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const t = await ev(`document.getElementById('hud-stat').textContent`);
  if (t && /ms/.test(t)) { ready = true; break; }
}
console.log('boot', JSON.stringify({
  ready,
  coord: await ev(`document.getElementById('hud-coord').textContent`),
  zoom: await ev(`document.getElementById('hud-zoom').textContent`),
  stat: await ev(`document.getElementById('hud-stat').textContent`),
}));

const before = JSON.parse(await ev(`JSON.stringify({
  c: __shell.state.center, z: __shell.state.zoom,
  digits: __shell.state.digits, span: __shell.state.spanLog10 })`));

// real wheel notches at an off-centre position
const geo = JSON.parse(await ev(`(() => { const c = document.getElementById('view');
  const r = c.getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height}); })()`));
const cx = geo.l + geo.w * 0.62, cy = geo.t + geo.h * 0.38;
const NOTCH = 11;
for (let i = 0; i < NOTCH; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120, pointerType: 'mouse',
  });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 6000));

const afterIn = JSON.parse(await ev(`JSON.stringify({
  c: __shell.state.center, z: __shell.state.zoom,
  digits: __shell.state.digits, span: __shell.state.spanLog10 })`));
const expected = NOTCH * 120 * 0.0035;
const gotLog = Math.log(10) * (Math.log10(afterIn.z.mant) + afterIn.z.exp10)
  - Math.log(10) * (Math.log10(before.z.mant) + before.z.exp10);
console.log('zoom in', JSON.stringify({
  notches: NOTCH,
  log10ZoomBefore: (Math.log10(before.z.mant) + before.z.exp10).toFixed(3),
  log10ZoomAfter: (Math.log10(afterIn.z.mant) + afterIn.z.exp10).toFixed(3),
  expectedFactorLn: expected.toFixed(4),
  measuredFactorLn: gotLog.toFixed(4),
  digits: afterIn.digits,
  centerDecimals: (afterIn.c.re.split('.')[1] || '').length,
}));

// and back out the same number of notches at the same point
for (let i = 0; i < NOTCH; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 120, pointerType: 'mouse',
  });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 6000));
const back = JSON.parse(await ev(`JSON.stringify({ c: __shell.state.center, z: __shell.state.zoom })`));

const drift = await ev(`(() => {
  const a = ${JSON.stringify(before.c)}, b = ${JSON.stringify(back.c)};
  // both are decimal strings at the same width; compare as scaled integers
  const toBig = (s) => {
    s = String(s).trim();
    let sign = 1n; if (s[0] === '-') { sign = -1n; s = s.slice(1); }
    const dot = s.indexOf('.');
    const frac = dot >= 0 ? s.slice(dot + 1) : '';
    return { v: sign * BigInt((s.replace('.', '') || '0')), n: frac.length };
  };
  const A = toBig(a.re), B = toBig(b.re), Ai = toBig(a.im), Bi = toBig(b.im);
  const n = Math.max(A.n, B.n, Ai.n, Bi.n);
  const scale = (x) => x.v * 10n ** BigInt(n - x.n);
  const pxSize = Math.pow(10, ${before.span}) / ${geo.w};
  const dre = Number(scale(A) - scale(B)) / 10 ** n;
  const dim = Number(scale(Ai) - scale(Bi)) / 10 ** n;
  return JSON.stringify({ driftPxRe: dre / pxSize, driftPxIm: dim / pxSize });
})()`);

console.log('round trip', JSON.stringify({
  centerSame: before.c.re === back.c.re && before.c.im === back.c.im,
  zoomSame: before.z.mant === back.z.mant && before.z.exp10 === back.z.exp10,
  drift,
}));
console.log('errors', logs.length ? logs.slice(0, 4) : 'none');
ws.close();
