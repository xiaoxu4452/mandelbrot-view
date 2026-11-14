/* Deep-zoom stress: 10^12 .. 10^24 on a real boundary centre.
 *
 * Two questions the user asked:
 *   "10^17 is the limit"  -> does the frame still contain structure (varying
 *                           escape counts / smooth values) past 10^17?
 *   "coordinates flicker" -> does the visible surface or the view state bounce
 *                            between backends during a continuous gesture?
 *
 * Evidence is numeric: the WebGPU field sampler, MPFR bit counts, distinct
 * escape counts over an 11x11 grid, and a class/centre trace sampled at 120ms.
 * No screenshot parsing, no guessing from a thumbnail.
 */
const PORT = process.env.MB_CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('no index.html page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const line = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/webgpu|declined|failed/i.test(line)) logs.push(line.slice(0, 180));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 180));
  }
};
const send = (method, params = {}) => {
  const k = ++id;
  ws.send(JSON.stringify({ id: k, method, params }));
  return new Promise((r) => pend.set(k, r));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  }
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.bringToFront');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 5000));

/* Level-set centre for n=2000 (tools/_boundary.mjs): the escape count jumps
 * 1999 -> 2000 inside a 2^-60 frame, so the views below really do straddle a
 * boundary instead of being flat exterior plateaus. */
const CR = '-0.7436445304724177994199210807022414481170343915942763397125547797372746';
const CI = '0.1318259042053299999999999999999999999999999999999999999999999999999999';
const DECADES = (process.argv[2] || '12,14,16,17,18,20,24').split(',').map(Number);
const MAXITER = Number(process.argv[3] || 3000);

const geo = JSON.parse(await ev('JSON.stringify({w: document.getElementById("fractal").width})'));
const pts = [];
for (let j = 0; j < 11; j++) {
  for (let i = 0; i < 11; i++) {
    pts.push([
      Math.round((i + 0.5) * geo.w / 11),
      Math.round((j + 0.5) * (geo.w * 0.64) / 11)
    ]);
  }
}

console.log(`centre=${CR.slice(0, 24)}... maxIter=${MAXITER} viewW=${geo.w}`);
console.log('depth     span2^e   bits  orbit_ms  frame_ms  refLen  kernel  glitch  engine      iters  smoothRange  surface');
console.log('-'.repeat(115));

for (const D of DECADES) {
  const e = Math.round(-D * Math.log2(10) + Math.log2(geo.w));
  await ev(`(() => {
    const s = __mb.state;
    s.spec.mode='m'; s.spec.kind='mandelbrot'; s.spec.power=2;
    s.center={re:${JSON.stringify(CR)}, im:${JSON.stringify(CI)}};
    s.span={m:1,e:${e}}; s.maxIter=${MAXITER}; s.rotation=0;
    s.autoIter=false; s.bits='auto';
    /* Force this level to pay for its own orbit. */
    if (window.__mbgpu && __mbgpu.renderer) __mbgpu.renderer.orbit = null;
    return 1;
  })()`);
  const seq0 = Number(await ev('(window.__mb.wgpu().status||{}).seq || 0'));
  await ev('__mb.render()');

  let st = null, meta = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const r = JSON.parse(await ev(`JSON.stringify({
      st: __mb.wgpu().status,
      meta: __mb.meta(),
      why: __mb.wgpu().why,
      surf: document.documentElement.classList.contains('wgpu-surface')
    })`));
    if (r.meta && r.meta.done) { st = r.st; meta = r.meta; break; }
  }
  if (!meta) {
    console.log(`10^${String(D).padEnd(5)}  TIMEOUT`);
    continue;
  }

  let iters = '-', range = '-';
  if (meta.engine === 'webgpu') {
    const smp = JSON.parse(await ev(
      `(async()=>JSON.stringify(await __mb.wgpu().sample(${JSON.stringify(pts)})))()`
    ));
    const ns = smp.map((p) => p.iter | 0);
    const sv = smp.map((p) => p.smooth).filter(Number.isFinite);
    iters = String(new Set(ns).size);
    range = sv.length ? (Math.max(...sv) - Math.min(...sv)).toFixed(2) : '-';
  }
  const s = st || {};
  console.log(
    `10^${String(D).padEnd(5)}  ${String(e).padStart(7)}  ` +
    `${String(s.bits ?? meta.bits ?? '-').padStart(5)}  ` +
    `${String(Math.round(s.orbitMs ?? 0)).padStart(8)}  ` +
    `${String(Math.round(s.frameMs ?? meta.ms ?? 0)).padStart(8)}  ` +
    `${String(s.refLen ?? meta.refLen ?? '-').padStart(6)}  ` +
    `${String(s.pixelKernel ?? 'cpu').padStart(6)}  ` +
    `${String(Math.round((s.glitchRatio ?? 0) * 100)).padStart(5)}%  ` +
    `${String(meta.engine).padEnd(11)} ${String(iters).padStart(5)}  ` +
    `${String(range).padStart(11)}  ${meta.engine === 'webgpu' ? 'wgpu' : 'other'}`
  );
}

/* Flicker trace: continuous wheel events at 10^17, sampling the visible
 * surface, the compositor transform and the view state every 120 ms. */
await ev(`(() => { const s = __mb.state;
  s.span = { m: 1, e: ${Math.round(-17 * Math.log2(10) + Math.log2(geo.w))} };
  s.maxIter = ${MAXITER}; return 1; })()`);
const W = 1000, H = 700;
for (let k = 0; k < 12; k++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: W * 0.63, y: H * 0.37,
    deltaX: 0, deltaY: -60, pointerType: 'mouse'
  });
  await new Promise((r) => setTimeout(r, 60));
}
const trace = [];
for (let k = 0; k < 25; k++) {
  await new Promise((r) => setTimeout(r, 120));
  trace.push(JSON.parse(await ev(`JSON.stringify({
    cls: document.documentElement.className,
    re: __mb.state.center.re,
    span: JSON.stringify(__mb.state.span),
    tf: document.getElementById('wgpu-fractal')?.style.transform || '',
    why: __mb.wgpu().why
  })`)));
}
const uniq = (f) => [...new Set(trace.map(f))];
console.log('\n--- flicker trace after a 12-notch wheel burst ---');
console.log('distinct html classes :', uniq((t) => t.cls).length, uniq((t) => t.cls).slice(0, 6));
console.log('distinct centres      :', uniq((t) => t.re).length);
console.log('distinct spans        :', uniq((t) => t.span).length);
console.log('distinct transforms   :', uniq((t) => t.tf).length);
console.log('distinct decline keys :', uniq((t) => t.why));
console.log('console errors        :', logs.slice(-6));
ws.close();
