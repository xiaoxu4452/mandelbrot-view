/* ------------------------------------------------------------------
 * tilecheck.mjs — regression check for the CPU tile pipeline.
 *
 * Two properties, both measured on the real canvas:
 *
 *   1. No seams.  A 512 px tile that overlaps the wasm shadow stack used to
 *      paint a dark band every 512 rows (the kernel's spilled locals were
 *      overwritten by pixel data).  The check renders the frame with the
 *      default tiling and looks for single rows whose mean brightness is far
 *      from both neighbours.
 *
 *   2. Tiling independence.  The same frame rendered at 512 px and at 40 px
 *      tiles must be pixel-identical; any difference means the solver's output
 *      depends on where a tile starts.
 *
 *   node tools/tilecheck.mjs [--port 9333]
 *
 * Exit code 0 = both pass.
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg('port', 9333));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no page target on port ' + PORT); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const errs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    errs.push((m.params.args || []).map(a => a.value ?? '').join(' '));
};
const send = (method, params = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, 9000));

const render = async (tilePx, slot) => {
  await ev(`(() => { const st = window.__mb.state; st.gpu = false; st.tilePx = ${tilePx}; st.aa = 1;
    window.__mb.render(); return 1; })()`);
  let prev = -1;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 300));
    const n = await ev('window.__mb.frames()');
    if (n === prev) break;
    prev = n;
  }
  await new Promise(r => setTimeout(r, 400));
  return JSON.parse(await ev(`(() => {
    const cv = document.getElementById('fractal');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width, H = cv.height, prof = [];
    for (let y = 0; y < H; y++) { let s = 0;
      for (let x = 0; x < W; x += 4) { const p = (y * W + x) * 4; s += d[p] + d[p+1] + d[p+2]; }
      prof.push(Math.round(s / (W / 4) / 3)); }
    (window.__fr = window.__fr || [])[${slot}] = d.slice();
    return JSON.stringify({ W, H, prof });
  })()`));
};

const big = await render(512, 0);
const small = await render(40, 1);
const spikeRows = [];
for (let y = 1; y < big.prof.length - 1; y++) {
  const d = Math.abs(big.prof[y] - (big.prof[y - 1] + big.prof[y + 1]) / 2);
  if (d > 6) spikeRows.push([y, Math.round(d)]);
}
const cmp = JSON.parse(await ev(`(() => {
  const [a, b] = window.__fr || [];
  if (!a || !b) return JSON.stringify({ n: -1, maxd: -1 });
  let n = 0, maxd = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);
    if (d) { n++; if (d > maxd) maxd = d; }
  }
  return JSON.stringify({ n, maxd });
})()`));

console.log(`canvas             ${big.W}x${big.H}`);
console.log(`seam rows (>6/255) ${spikeRows.length} ${JSON.stringify(spikeRows.slice(0, 8))}`);
console.log(`512 vs 40 tiles    ${cmp.n} px differ (max Δ ${cmp.maxd})`);
console.log(`errors             ${errs.slice(-2).join(' | ') || 'none'}`);
const pass = spikeRows.length === 0 && cmp.n === 0 && !errs.length;
console.log(pass ? 'PASS' : 'FAIL');
ws.close();
process.exit(pass ? 0 : 1);
