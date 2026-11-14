/* Verify the observed-iteration budget transcribed from 0046f630.c.
 * The web page used to derive maxIter from depth alone; this checks that a
 * completed frame whose pixels reached the cap raises the ceiling, that a
 * non-exhausted frame does not, that the runaway guard holds, and that no
 * repaint is triggered by the observation itself.
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
const ev = async (x) => {
  const r = await send('Runtime.evaluate', {
    expression: x, returnByValue: true, awaitPromise: true
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

const base = JSON.parse(await ev('JSON.stringify(__mb.iter())'));
check('fresh view has no raised ceiling', base.cap === 0,
      `cap=${base.cap} total=${base.total}`);

/* A frame whose pixels stopped one step short of the cap is not evidence. */
const quiet = JSON.parse(await ev(
  'JSON.stringify(__mb.iterProbe(600, 420, 12))'));
check('non-exhausted frame does not raise', quiet.cap === 0,
      `cap=${quiet.cap}`);

/* 599/600 with bounded pixels: real exhaustion.  known*3+3000 = 4797,
 * checkcanvas = 599*5+10000 = 12995 -> 12995, but the desktop's runaway
 * guard is max(cap*4, 4000) = 4000, so the ceiling lands on 4000. */
const hit = JSON.parse(await ev(
  'JSON.stringify(__mb.iterProbe(600, 599, 30))'));
check('exhausted frame raises within safe cap', hit.cap === 4000 && hit.refine === 1,
      `cap=${hit.cap} refine=${hit.refine}`);
check('raised ceiling reaches effectiveIterTotal', hit.total >= 4000,
      `total=${hit.total}`);

/* Two more exhausted frames may refine, but never past 3 refinements or the
 * 200000 hard guard. */
for (let i = 0; i < 6; i++) {
  await ev(`__mb.iterProbe(${2000 + i * 1000}, ${1999 + i * 1000}, 40)`);
}
const capped = JSON.parse(await ev('JSON.stringify(__mb.iter())'));
check('refinement count is bounded', capped.refine <= 3,
      `refine=${capped.refine}`);
check('ceiling stays under the runaway guard', capped.cap <= 200000,
      `cap=${capped.cap}`);

/* Changing the view resets the per-view ceiling (the global observation max
 * survives, exactly like canvas->maxiter on the desktop). */
await ev(`(() => { __mb.state.span = { m: 1, e: -40 }; return 1; })()`);
const moved = JSON.parse(await ev(
  'JSON.stringify(__mb.iterProbe(600, 599, 30))'));
check('a new view starts from its own ceiling',
      moved.refine === 1 && moved.observedMax >= 599,
      `refine=${moved.refine} observedMax=${moved.observedMax}`);

/* No self-triggered repaint: the frame sequence must not change just because
 * an observation was recorded. */
const seq0 = await ev('document.documentElement.className');
await ev('__mb.iterProbe(600, 599, 30)');
await new Promise((r) => setTimeout(r, 700));
const seq1 = await ev('document.documentElement.className');
check('observation does not repaint', seq0 === seq1,
      `class before/after equal=${seq0 === seq1}`);

ws.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `ITERTEST FAILED (${failed})` : 'ITERTEST OK');
process.exit(failed ? 1 : 0);
