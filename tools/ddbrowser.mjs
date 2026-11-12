/* Browser-level proof that deep folded families now run in the C++ kernel. */
const PORT = process.env.MB_CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const k = ++id; ws.send(JSON.stringify({ id: k, method, params })); return new Promise(r => pend.set(k, r)); };
const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) fails++; };

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 480, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
await wait(3500);

const view = kind => `(()=>{
  const s=__mb.state;
  s.spec.mode='m'; s.spec.kind='${kind}'; s.spec.power=2;
  s.center={re:'-0.74364388703715119283746519283746519283',im:'0.13182590420533019827364591827364591827'};
  const w=__mb.viewport().buffer[0], pixel=1e-12;
  s.span={m:pixel*w/2,e:1};
  s.palette='ice'; s.stops=null; s.scheme='bands'; s.glsl=null;
  s.gpu=false; s.traps=0; s.inverse=false; s.cycle=140; s.cycleAuto=false;
  s.offset=0; s.aa=1; s.renderScale=1; s.bits='auto'; s.autoIter=false; s.maxIter=400;
  __mb.render();
  return JSON.stringify({frames:__mb.frames(),depth:1e-12});
})()`;

for (const [kind, expect] of [['tricorn', 'dd-direct'], ['burningship', 'dd-direct'],
                              ['celtic', 'dd-direct'], ['phoenix', 'dd-direct'],
                              ['mandelbrot', 'perturb']]) {
  const before = Number(await ev('__mb.frames()'));
  await ev(view(kind));
  let meta = null;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    const f = Number(await ev('__mb.frames()'));
    if (f > before) { meta = JSON.parse(await ev('JSON.stringify(__mb.meta())')); break; }
  }
  const ok = meta && meta.mode === expect && meta.engine === 'wasm';
  check(`${kind} deep view runs ${expect}`, !!ok,
    meta ? `mode=${meta.mode} engine=${meta.engine} bits=${meta.bits} ms=${Math.round(meta.ms)}` : 'timeout');
}

/* A shallow folded view stays on the plain f64 C++ kernel. */
{
  const before = Number(await ev('__mb.frames()'));
  await ev(view('tricorn').replace('pixel=1e-12', 'pixel=1e-3'));
  let meta = null;
  for (let i = 0; i < 30; i++) {
    await wait(400);
    if (Number(await ev('__mb.frames()')) > before) { meta = JSON.parse(await ev('JSON.stringify(__mb.meta())')); break; }
  }
  check('shallow tricorn uses f64 direct', meta && meta.mode === 'direct' && meta.engine === 'wasm',
    meta ? `mode=${meta.mode} engine=${meta.engine}` : 'timeout');
}
console.log(fails ? `\nDDBROWSER FAILED (${fails})` : '\nDDBROWSER OK');
ws.close();
process.exit(fails ? 1 : 0);
