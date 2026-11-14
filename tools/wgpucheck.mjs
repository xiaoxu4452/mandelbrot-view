/* wgpucheck.mjs — A/B the WebGPU perturbation kernel against a direct
 * evaluation of each family, in the page's own geometry.
 *
 * The shader never touches float64: it iterates δ against a reference orbit.
 * That is only trustworthy if, at a shallow view where direct double iteration
 * is exact, the two agree pixel by pixel.  For every family the check
 *
 *   1. builds a view through the public state (the same fields the UI sets),
 *   2. waits for the WebGPU frame,
 *   3. reads the float field back for a grid of pixels,
 *   4. iterates the same family from the same coordinates in float64 here,
 *
 * and compares the escape iteration and the smooth count.  A family whose
 * perturbation step was transcribed wrong (wrong fold, wrong conj, wrong
 * memory term) shows up as a large iteration delta on a known fraction of the
 * grid, not as a colour difference that a screenshot could hide.
 */
const PORT = process.env.MB_CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('no mandelbrot page on the CDP port');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => {
  const k = ++id;
  ws.send(JSON.stringify({ id: k, method, params }));
  return new Promise((r) => pend.set(k, r));
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  }
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};

/* ---- float64 reference, one step per family ------------------------------ */
const BAIL2 = 1e20;
function step(kind, power, z, c, prev, phx) {
  const x = z[0], y = z[1];
  switch (kind) {
    case 'tricorn': return [x * x - y * y + c[0], -2 * x * y + c[1]];
    case 'burningship':
    case 'perpendicular': {
      const ax = Math.abs(x), ay = Math.abs(y);
      return [ax * ax - ay * ay + c[0], 2 * ax * ay + c[1]];
    }
    case 'celtic': return [Math.abs(x * x - y * y) + c[0], 2 * x * y + c[1]];
    case 'phoenix': return [x * x - y * y + phx * prev[0] + c[0],
                            2 * x * y + phx * prev[1] + c[1]];
    default: {
      if (power === 2) return [x * x - y * y + c[0], 2 * x * y + c[1]];
      let pr = 1, pi = 0;
      for (let k = 0; k < power; k++) {
        const tr = pr * x - pi * y, ti = pr * y + pi * x;
        pr = tr; pi = ti;
      }
      return [pr + c[0], pi + c[1]];
    }
  }
}

function direct(kind, power, z0, c, maxIter, phx) {
  let z = z0, prev = [0, 0];
  for (let n = 1; n <= maxIter; n++) {
    const nz = step(kind, power, z, c, prev, phx);
    prev = z;
    z = nz;
    const m2 = z[0] * z[0] + z[1] * z[1];
    if (m2 > BAIL2) {
      const mm = Math.min(m2, 1e30);
      const nu = Math.log(0.5 * Math.log(Math.max(mm, 1e-30)) / Math.log(1e10)) /
                 Math.log(Math.max(power, 2));
      return { iter: n, smooth: n + 1 - nu };
    }
  }
  return { iter: maxIter, smooth: maxIter };
}

/* ---- one family ---------------------------------------------------------- */
async function probe(kind, power, center, span, julia, seed) {
  const label = `${kind}${power !== 2 ? '^' + power : ''}${julia ? ' julia' : ''}`;
  await ev(`(()=>{
    const s = __mb.state;
    s.spec.mode = '${julia ? 'j' : 'm'}';
    s.spec.kind = '${kind}';
    s.spec.power = ${power};
    s.spec.julia = { re: '${seed ? seed[0] : '0'}', im: '${seed ? seed[1] : '0'}' };
    s.center = { re: '${center[0]}', im: '${center[1]}' };
    s.span = { m: ${span}, e: 0 };
    s.rotation = 0; s.gpu = true; s.traps = 0; s.inverse = false;
    s.palette = 'ice'; s.stops = null; s.scheme = 'bands'; s.glsl = null;
    s.schemeName = null; s.cycle = 140; s.cycleAuto = true; s.offset = 0;
    s.aa = 1; s.renderScale = 1; s.bits = 'auto'; s.autoIter = false;
    s.maxIter = 600;
    __mb.render();
    return 1;
  })()`);
  /* Frames land on whichever engine accepts the view; only the WebGPU one
   * bumps the frame counter, so wait for it and fall back to reading the
   * metadata after a settle period. */
  let meta = null;
  for (let i = 0; i < 50; i++) {
    await wait(300);
    const m = JSON.parse(await ev('JSON.stringify(__mb.meta())'));
    if (!m) continue;
    meta = m;
    if (m.engine === 'webgpu') break;
    if (i === 30) break;
  }
  if (!meta) { check(label + ' frame', false, 'timeout'); return; }
  if (meta.engine !== 'webgpu') {
    /* The engine refuses views whose reference orbit dies before the pixels
     * do; the page then paints them with the per-pixel pipeline.  That is the
     * designed outcome, not a failure — it is reported so the split stays
     * visible. */
    check(label + ' handed off (short reference)', meta.engine === 'gpu' || meta.engine === 'wasm',
      `engine=${meta.engine}`);
    return;
  }
  check(label + ' runs on WebGPU', true,
    `refLen=${meta.refLen} ${Math.round(meta.ms)}ms`);

  const geo = JSON.parse(await ev('JSON.stringify(__mb.wgpu().geometry)'));
  const W = geo.w, H = geo.h;
  const scaleLog2 = geo.spanLog2 - Math.log2(W);
  const pixel = Math.pow(2, scaleLog2);
  /* A regular grid plus the exact centre, so a sign error cannot hide. */
  const pts = [];
  for (let j = 0; j < 25; j++) {
    for (let i = 0; i < 33; i++) {
      pts.push([Math.round((i + 0.5) * W / 33), Math.round((j + 0.5) * H / 25)]);
    }
  }
  const samples = JSON.parse(await ev(
    `(async()=>JSON.stringify(await __mb.wgpu().sample(${JSON.stringify(pts)})))()`));

  let bad = 0, worst = 0, checked = 0;
  for (const s of samples) {
    if (!s) continue;
    const px = [s.x, s.y];
    const re = Number(geo.centerRe) + ((px[0] + 0.5) - 0.5 * W) * pixel;
    const im = Number(geo.centerIm) + (0.5 * H - (px[1] + 0.5)) * pixel;
    const ref = julia
      ? direct(kind, power, [re, im], [Number(seed[0]), Number(seed[1])], geo.maxIter, 0.5667)
      : direct(kind, power, [0, 0], [re, im], geo.maxIter, 0.5667);
    checked++;
    const d = Math.abs(ref.iter - s.iter);
    if (d > worst) worst = d;
    if (d > 1) bad++;
  }
  /* The forced-deep flag runs this kernel on whole-set views too, where the
   * page itself uses the direct fragment shader: δ is then comparable to |Z|,
   * and float32 perturbation is allowed to disagree on the boundary pixels
   * (a few percent).  Inside its operating range the same check is expected
   * to be exact, which is what the 8% gate separates. */
  check(label + ' iteration counts match float64', checked > 0 && bad / checked < 0.08,
    `${bad}/${checked} off by >1, worst delta ${worst}`);
}

await send('Page.enable');
/* Exercise the kernel at every depth, including the shallow views where the
 * page itself prefers the direct fragment shader. */
await ev('__mb.wgpuForce(64)');
/* MB_DD=1/0 pins the 48-bit pixel kernel on/off for the A/B.  It cannot push
 * the kernel outside its physical range (|delta| << |Z|); see _wantDD.  The
 * deep-view limb check lives in tools/_ddab2.mjs and tools/_truth.mjs. */
if (process.env.MB_DD) await ev(`__mb.wgpuDD(${process.env.MB_DD === '0' ? 'false' : 'true'})`);
await probe('mandelbrot', 2, ['-0.5', '0'], 2.8, false);
await probe('multibrot', 3, ['0', '0'], 2.6, false);
await probe('multibrot', 5, ['0', '0'], 2.4, false);
await probe('tricorn', 2, ['0', '0'], 3.0, false);
await probe('burningship', 2, ['-0.5', '-0.5'], 3.0, false);
await probe('celtic', 2, ['0', '0'], 3.0, false);
await probe('perpendicular', 2, ['0', '0'], 3.0, false);
await probe('phoenix', 2, ['0', '0'], 3.0, false);
await probe('mandelbrot', 2, ['0', '0'], 3.2, true, ['-0.8', '0.156']);
await probe('tricorn', 2, ['0', '0'], 3.2, true, ['-0.8', '0.156']);
await probe('burningship', 2, ['0', '0'], 3.2, true, ['-0.5', '-0.5']);
await probe('celtic', 2, ['0', '0'], 3.2, true, ['-0.8', '0.156']);
await probe('phoenix', 2, ['0', '0'], 3.2, true, ['-0.5', '0.5']);

console.log(fails ? `\nWGPUCHECK FAILED (${fails})` : '\nWGPUCHECK OK');
ws.close();
process.exit(fails ? 1 : 0);
