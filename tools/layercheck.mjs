/* ------------------------------------------------------------------
 * layercheck.mjs — assert that the picture on screen belongs to exactly one
 * renderer, at exactly one resolution.
 *
 * A deep-zoom screenshot showed a full-screen grid of white/navy squares
 * while the HUD still said "GPU · 48 bit · done · 1 ms".  Three separate
 * ownership bugs made that possible:
 *
 *   1. scenePass() declining left `html.gl-surface` on, which sets the 2D
 *      canvas to opacity:0.  Every CPU pass painted into an invisible layer.
 *   2. glideApply() fed its transformed bitmap back into `snap` on every
 *      eased frame.  A fast wheel burst resampled the same pixels dozens of
 *      times, so one source pixel became a 40x40 block.
 *   3. glCanvas was only sized inside sceneDraw(); a declined view stretched
 *      the previous window's shader buffer over the new viewport.
 *
 * This tool drives all four transitions through the real page and checks the
 * invariants, including that a palette change actually reaches the visible
 * canvas.  Usage: node tools/layercheck.mjs [--port 9333]
 * ---------------------------------------------------------------- */
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no app page'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
await send('Page.reload', { ignoreCache: true });
await wait(3500);

/** Install a view with a given per-pixel plane step, then render it. */
const setView = (pixel, mode = 'm') => `(()=>{
  const s = __mb.state;
  s.spec.mode='${mode}'; s.spec.kind='mandelbrot'; s.spec.power=2;
  s.spec.julia={re:'-0.613313813075054',im:'0.4610367855546879'};
  s.center={re:'-0.743643887037151',im:'0.131825904205330'};
  const w = __mb.viewport().buffer[0];
  s.span = { m: ${pixel} * w / 2, e: 1 };
  s.rotation=0; s.palette='ice'; s.stops=null; s.scheme='bands'; s.glsl=null;
  s.traps=0; s.inverse=false; s.cycle=140; s.cycleAuto=false; s.offset=0;
  s.aa=1; s.renderScale=1; s.bits='auto'; s.autoIter=true;
  __mb.render();
  return JSON.stringify({layer:__mb.layer(), frames:__mb.frames()});
})()`;

const sample = `(()=>{
  const c=document.getElementById('fractal');
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const set=new Set(); let h=0;
  for(let i=0;i<d.length;i+=4*257){const v=(d[i]<<16)|(d[i+1]<<8)|d[i+2];set.add(v);h=(h*31+v)>>>0;}
  return JSON.stringify({colours:set.size, hash:h});
})()`;

/* ---- 1. a view the fragment shader owns ------------------------------- */
await ev(setView('1e-4', 'm'));
await wait(900);
let L = JSON.parse(await ev('JSON.stringify(__mb.layer())'));
check('shader frame visible', L.gl === true, JSON.stringify(L));
check('both backstores match (shader frame)',
  L.glBuffer[0] === L.c2d[0] && L.glBuffer[1] === L.c2d[1],
  `${L.glBuffer} vs ${L.c2d}`);

/* ---- 2. a view the shader must decline -------------------------------- */
await ev(setView('5e-10', 'm'));
await wait(6000);
L = JSON.parse(await ev('JSON.stringify(__mb.layer())'));
const sc = await ev('JSON.stringify(__mb.scene())');
check('declined frame hides the shader layer', L.gl === false, sc.slice(0, 120));
check('both backstores match (declined frame)',
  L.glBuffer[0] === L.c2d[0] && L.glBuffer[1] === L.c2d[1],
  `${L.glBuffer} vs ${L.c2d}`);
const before = JSON.parse(await ev(sample));

/* ---- 3. a palette change reaches the visible canvas ------------------- */
await ev(`(()=>{const e=document.getElementById('sel-palette');e.value='ember';e.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
await wait(1800);
L = JSON.parse(await ev('JSON.stringify(__mb.layer())'));
const after = JSON.parse(await ev(sample));
check('recolour leaves the visible layer consistent', L.gl === false, JSON.stringify(L));
check('recolour changes 2D pixels', before.hash !== after.hash,
  `${before.hash} -> ${after.hash}`);

/* ---- 4. resize keeps both layers in lockstep -------------------------- */
await send('Emulation.setDeviceMetricsOverride',
  { width: 1100, height: 680, deviceScaleFactor: 1, mobile: false });
await ev('window.dispatchEvent(new Event("resize"))');
await wait(1200);
L = JSON.parse(await ev('JSON.stringify(__mb.layer())'));
check('resize synchronises both backstores',
  L.glBuffer[0] === L.c2d[0] && L.glBuffer[1] === L.c2d[1],
  `${L.glBuffer} vs ${L.c2d}`);

/* ---- 5. a wheel burst never accumulates bitmap resampling ------------- */
await ev(setView('1e-4', 'm'));
await wait(700);
for (let i = 0; i < 12; i++) {
  await ev(`(()=>{const c=document.getElementById('fractal');c.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:450,clientY:300,bubbles:true,cancelable:true}));return 1})()`);
  await wait(35);
}
await wait(700);
L = JSON.parse(await ev('JSON.stringify(__mb.layer())'));
check('gesture bitmap scale stays bounded',
  L.bitmapScale >= 0.08 && L.bitmapScale <= 12, `scale=${L.bitmapScale}`);
check('gesture leaves both backstores matched',
  L.glBuffer[0] === L.c2d[0] && L.glBuffer[1] === L.c2d[1],
  `${L.glBuffer} vs ${L.c2d}`);

console.log(fails ? `\nLAYERCHECK FAILED (${fails})` : '\nLAYERCHECK OK');
ws.close();
process.exit(fails ? 1 : 0);
