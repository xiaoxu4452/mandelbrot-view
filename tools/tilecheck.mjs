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

/* A deep view exercises the perturbation path, where the reference orbit is
 * elected once per frame and every tile adopts it (app.js prepareEnv).  Its
 * tiling must be as independent as the direct path's: a tile that starts at a
 * different offset may not compute a different pixel. */
const DEEP = Number(arg('deep', 0));
if (DEEP) {
  await ev(`(() => { const st = window.__mb.state; st.gpu = false;
    st.center = { re: '-0.743643887037151', im: '0.131825904205330' };
    st.span = { m: 1.6, e: ${DEEP} }; window.__mb.render(); return 1; })()`);
  await new Promise(r => setTimeout(r, 1500));
}
/* A real deep preset is the better test for the perturbation path: the
 * synthetic point above sits in a flat exterior pocket where almost every
 * pixel is a glitch and the repair pass — not the tiling — dominates. */
const PRESET = arg('preset', '');
if (PRESET) {
  await ev(`document.getElementById('btn-presets').click(); 1`);
  await new Promise(r => setTimeout(r, 900));
  const hit = await ev(`(() => { const el = document.querySelector('.pcard[data-id="${PRESET}"]');
    if (!el) return 0; el.click(); return 1; })()`);
  if (!hit) { console.error('preset not found: ' + PRESET); process.exit(2); }
  await new Promise(r => setTimeout(r, 600));
  await ev(`(() => { const x = document.querySelector('#modal-root [data-close]'); if (x) x.click(); return 1; })()`);
  await new Promise(r => setTimeout(r, 1500));
}

const render = async (tilePx, slot) => {
  const base = Number(await ev('window.__mb.frames()'));
  await ev(`(() => { const st = window.__mb.state; st.gpu = false; st.tilePx = ${tilePx}; st.aa = 1;
    window.__mb.render(); return 1; })()`);
  /* `frameSeq` only moves when the whole progressive chain finished (app.js
   * renderPlan -> next()), so waiting for it to *increase* is the only reliable
   * "this frame is complete" signal.  Waiting for it to stop changing fires on
   * the first poll — the counter sits still while a pass runs. */
  let done = false;
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 400));
    if (Number(await ev('window.__mb.frames()')) > base) { done = true; break; }
  }
  if (!done) console.log(`  (${tilePx}px: frame did not settle, sampling anyway)`);
  await new Promise(r => setTimeout(r, 500));
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

const T1 = Number(arg('t1', 512)), T2 = Number(arg('t2', DEEP ? 256 : 40));
const big = await render(T1, 0);
const small = await render(T2, 1);
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
console.log(`${T1} vs ${T2} tiles   ${cmp.n} px differ (max Δ ${cmp.maxd})`);
console.log(`errors             ${errs.slice(-2).join(' | ') || 'none'}`);
const pass = spikeRows.length === 0 && cmp.n === 0 && !errs.length;
console.log(pass ? 'PASS' : 'FAIL');
ws.close();
process.exit(pass ? 0 : 1);
