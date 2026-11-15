/* _ablook.mjs — same view through both engines, screenshot each, so the
 * "brain swapped, body unchanged" claim is checked on pixels and not on prose.
 *
 * usage: node tools/_ablook.mjs [port]
 */
import fs from 'node:fs';

const PORT = Number(process.argv[2] || process.env.MB_CDP_PORT || 9346);
const OUT = 'D:/mandelbrot view/evidence';
const URL = 'http://127.0.0.1:8781/index.html';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const k = ++id; ws.send(JSON.stringify({ id: k, method, params })); return new Promise((r) => pend.set(k, r)); };
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description).slice(0, 300));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64'));
};

/* log10 zoom -> {m,e} for the page's binary span (3 / zoom) */
const SPAN_EXPR = (lz) => `(() => { const l = Math.log2(3) - ${lz} * Math.log2(10);
  const e = Math.floor(l), m = Math.pow(2, l - e); return JSON.stringify({m, e}); })()`;

async function frame() {
  const seq0 = JSON.parse(await ev(`JSON.stringify((__mb.meta()||{}).seq||0)`)).seq;
  for (let i = 0; i < 4000; i++) {
    const o = JSON.parse(await ev(`(() => { const m = __mb.meta()||{}; return JSON.stringify({seq:m.seq, engine:m.engine, ms:m.ms, done:m.done, escMin:m.escMin, escMax:m.escMax}); })()`));
    if (o.seq > seq0 && o.done) return o;
    await sleep(200);
  }
  throw new Error('timeout');
}

async function load(engine) {
  await send('Page.navigate', { url: engine === 'core' ? URL : `${URL}?engine=old` });
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const ok = await ev(`typeof window.__mb !== 'undefined'`);
    if (ok) break;
  }
}

const VIEWS = [
  { tag: 'home', lz: 0, re: '-0.6', im: '0' },
  { tag: 'user15', lz: 15, re: '-0.7436438870374124', im: '0.1318259145695319' },
  { tag: 'ci600', lz: 600, re: '0', im: '1' },
];

for (const v of VIEWS) {
  for (const engine of ['core', 'old']) {
    await load(engine);
    const span = await ev(SPAN_EXPR(v.lz));
    await ev(`(() => { __mb.state.spec.mode='m'; __mb.state.spec.kind='mandelbrot'; __mb.state.spec.power=2;
      __mb.state.center = { re: ${JSON.stringify(v.re)}, im: ${JSON.stringify(v.im)} };
      __mb.state.span = ${span}; __mb.render(); return 1; })()`);
    const f = await frame();
    await shot(`ab-${v.tag}-${engine}`);
    const hud = await ev(`document.getElementById('hud-engine').textContent`);
    console.log(`${v.tag.padEnd(7)} ${engine.padEnd(4)} ${JSON.stringify(f)} hud=${JSON.stringify(hud)}`);
  }
}
ws.close();
