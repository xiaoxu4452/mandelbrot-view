/* ------------------------------------------------------------------
 * grabcanvas.mjs — export one canvas from the running page as a PNG.
 *
 * Screenshots go through the compositor, which can differ from what the
 * canvas actually holds (a stale layer shows through, a resize lands
 * mid-pass).  Reading the canvas itself is the only way to tell a real
 * rendering defect from a capture artefact.
 *
 *   node tools/grabcanvas.mjs --port 9333 --id fractal --out x.png [--w 500]
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const PORT = Number(arg('port', 9333));
const ID = arg('id', 'fractal');
const OUT = arg('out', 'canvas.png');
const W = Number(arg('w', 500));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};

const expr = `(()=>{const c=document.getElementById(${JSON.stringify(ID)});`
  + `if(!c)return null;`
  + `const t=document.createElement('canvas');t.width=${W};t.height=Math.round(${W}*c.height/c.width);`
  + `t.getContext('2d').drawImage(c,0,0,t.width,t.height);`
  + `return JSON.stringify({url:t.toDataURL('image/png'),w:c.width,h:c.height,hud:(document.getElementById('hud-engine')||{}).textContent});})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const raw = r.result?.result?.value;
if (!raw) { console.log('no such canvas:', ID, JSON.stringify(r.result).slice(0, 200)); process.exit(1); }
const info = JSON.parse(raw);
const { writeFileSync } = await import('node:fs');
writeFileSync(OUT, Buffer.from(info.url.split(',')[1], 'base64'));
console.log(`saved ${OUT}  canvas=${info.w}x${info.h}  hud="${info.hud}"`);
ws.close();
