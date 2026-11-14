/* Reproduce the reported "10^17 is the limit / coordinates flicker" view.
 *
 * Sets a Julia view at ~10^17.5 magnification and asks the questions that
 * separate a rendering limit from a coordinate-precision limit:
 *   - how many digits does the centre string really carry?
 *   - do two different cursor positions still map to two different plane
 *     points (the seed of "the zoom does not follow the pointer")?
 *   - does screenToPlane -> planeToScreen round-trip?
 *   - what does the WebGPU backend say about this view?
 */
const PORT = process.env.MB_CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('no index.html page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
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

const depth = Number(process.argv[2] || 17.5);
await ev(`(() => {
  const s = __mb.state;
  s.spec.mode = 'j';
  s.spec.kind = 'mandelbrot';
  s.spec.power = 2;
  s.spec.julia = { re: '-0.8287124868082089', im: '0.2412526521631408' };
  s.center = { re: '-0.8287124868082089', im: '0.2412526521631408' };
  const W = document.getElementById('fractal').width || 1280;
  /* state.span is a mantissa times a power of two, and depth is measured on
   * the PER-PIXEL scale: 10^-D = 2^e / W. */
  const e = Math.round(-${depth} * Math.log2(10) + Math.log2(W));
  s.span = { m: 1, e };
  s.maxIter = 3000;
  s.rotation = 0;
  s.autoIter = false;
  return 1;
})()`);

const rect = await ev(
  `JSON.stringify((() => { const r = document.getElementById('fractal').getBoundingClientRect();
     return { x: r.left, y: r.top, w: r.width, h: r.height }; })())`
);
const R = JSON.parse(rect);
const cx = R.x + R.w * 0.68;
const cy = R.y + R.h * 0.33;
const cx2 = R.x + R.w * 0.31;
const cy2 = R.y + R.h * 0.72;

const report = JSON.parse(
  await ev(`JSON.stringify((() => {
  const s = __mb.state;
  const p1 = __mb.screenToPlane(${cx}, ${cy});
  const p2 = __mb.screenToPlane(${cx2}, ${cy2});
  const q1 = __mb.screenToPlaneHi(${cx}, ${cy});
  const q2 = __mb.screenToPlaneHi(${cx2}, ${cy2});
  const b1 = __mb.planeToScreen(p1.re, p1.im);
  const bq = __mb.planeToScreen(q1.re, q1.im);
  let jseed = null;
  try { jseed = document.getElementById('julia-seed')?.textContent; } catch (e) {}
  return {
    centerRe: s.center.re, centerIm: s.center.im,
    centerDigits: s.center.re.replace(/^[-+]/, '').replace('.', '').length,
    juliaRe: s.spec.julia && s.spec.julia.re,
    juliaDigits: s.spec.julia && s.spec.julia.re.replace(/^[-+]/, '').replace('.', '').length,
    span: s.span,
    p1, p2, q1, q2,
    hiDigits: q1.re.replace(/^[-+]/, '').replace('.', '').replace(/e.*$/, '').length,
    samePoint: String(p1.re) === String(p2.re) && String(p1.im) === String(p2.im),
    sameHi: String(q1.re) === String(q2.re) && String(q1.im) === String(q2.im),
    dPoint: { re: p2.re - p1.re, im: p2.im - p1.im },
    roundTrip: {
      double: { x: b1 && b1.x, y: b1 && b1.y },
      hi: { x: bq && bq.x, y: bq && bq.y },
      wanted: { x: ${cx}, y: ${cy} }
    },
    jseed,
    depthDecades: ${depth}
  };
})())`)
);
console.log('--- view ---');
console.log(JSON.stringify(report, null, 2));

/* Watch the coordinate and the backend while the frame settles: a flickering
 * view rewrites state.center or bounces between backends. */
await ev('__mb.render()');
const samples = [];
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 500));
  samples.push(
    JSON.parse(
      await ev(`JSON.stringify({
        t: Math.round(performance.now()),
        re: __mb.state.center.re, im: __mb.state.center.im,
        span: __mb.state.span,
        why: __mb.wgpu().why, surf: document.documentElement.classList.contains('wgpu-surface'),
        hud: (document.getElementById('hud') || {}).innerText
      })`)
    )
  );
}
const uniq = (f) => [...new Set(samples.map(f))];
console.log('--- 10 samples over 5 s ---');
console.log('distinct centre :', uniq((s) => s.re + '|' + s.im).length);
console.log('distinct span   :', uniq((s) => JSON.stringify(s.span)).length);
console.log('distinct wgpuWhy:', uniq((s) => s.why));
console.log('surface on/off  :', uniq((s) => s.surf));
console.log('last hud        :', samples.at(-1).hud.replace(/\n/g, ' | ').slice(0, 260));
ws.close();
