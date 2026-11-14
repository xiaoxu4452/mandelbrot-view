import fs from 'node:fs';
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('port', 9222));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => { const k = ++id; ws.send(JSON.stringify({ id: k, method, params })); return new Promise(r => pend.set(k, r)); };
const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return 'ERR ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
  return r.result?.result?.value; };
const wait = ms => new Promise(r => setTimeout(r, ms));
await send('Page.enable');
console.log('probe', await ev(`JSON.stringify({mb:Object.keys(window.__mb||{}), node:!!document.getElementById('nodetail'), hud:(document.getElementById('hud')||{}).innerText})`));
/* A featureless deep view: far outside the set, every pixel escapes in the
 * same iteration, so passStats has hi-lo <= 1 and no bounded pixels. */
const before = Number(await ev(`window.__mb && window.__mb.frames ? window.__mb.frames() : -1`));
console.log('frames before', before);
await ev(`(()=>{const s=window.__mb.state;
  s.spec.mode='m'; s.spec.kind='mandelbrot'; s.spec.power=2;
  s.center={re:'2',im:'2'};
  s.span={m:1.6,e:-60};
  s.gpu=false; s.autoIter=false; s.maxIter=300; s.bits='auto';
  window.__mb.render(); return 1;})()`);
let state = null;
for (let i = 0; i < 40; i++) {
  await wait(500);
  state = await ev(`JSON.stringify({
    frames: window.__mb.frames ? window.__mb.frames() : -1,
    meta: window.__mb.meta ? window.__mb.meta() : null,
    nodetail: (()=>{const e=document.getElementById('nodetail');if(!e)return null;
      const c=getComputedStyle(e);return {text:e.innerText,display:c.display,opacity:c.opacity,visible:c.visibility,cls:e.className};})(),
    hud:(document.getElementById('hud')||{}).innerText
  })`);
  if (state && state.includes('"nodetail":{"text"') && !state.includes('"display":"none"')) break;
}
console.log('final', state);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shot.result?.data) {
  fs.writeFileSync('evidence/desktop-nodetail.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot evidence/desktop-nodetail.png');
}
ws.close();
