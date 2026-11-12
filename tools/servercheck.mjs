/* ------------------------------------------------------------------
 * servercheck.mjs — end-to-end smoke test for the out-of-browser core.
 *
 * Starts render-server.mjs on a private port and checks the three protocol
 * additions that the old JSON+RGBA-only service was missing:
 *   · /ping advertises env + field (version 3);
 *   · two tiles of one deep view build the reference orbit ONCE and reuse it;
 *   · asField returns 4 bytes per pixel of colour positions, with meta.field;
 *   · every tile carries the pass-buffer dimensions the page's drawTile guard
 *     compares, so remote tiles are not silently dropped.
 * ---------------------------------------------------------------- */
import { spawn } from 'node:child_process';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['server/render-server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, MB_PORT: String(PORT), MB_THREADS: '2' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
srv.stdout.on('data', d => { serverLog += d.toString(); });
srv.stderr.on('data', d => { serverLog += d.toString(); });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`);
  if (!ok) fails++;
};

async function ping() {
  const r = await fetch(BASE + '/ping');
  return r.json();
}
async function render(job) {
  const r = await fetch(BASE + '/render', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(job)
  });
  if (!r.ok) throw new Error(await r.text());
  const meta = JSON.parse(Buffer.from(r.headers.get('x-meta'), 'base64').toString('utf8'));
  const body = Buffer.from(await r.arrayBuffer());
  return { meta, body, env: r.headers.get('x-env') };
}

const W = 256, H = 192, TW = 128, TH = 96;
function job(x, y, asField = false, exp = -40) {
  const psExp = exp;
  return {
    id: `t-${x}-${y}-${asField ? 'f' : 'r'}`, viewId: 7,
    x, y, w: TW, h: TH, width: W, height: H,
    spec: { mode: 'm', kind: 'mandelbrot', power: 2,
            julia: { re: '-0.6', im: '0' }, customExpr: 'z^2 + c',
            customParams: { a: 0, b: 0, k: 0 } },
    center: { re: '-0.743643887037151', im: '0.131825904205330' },
    centerRe: '-0.743643887037151', centerIm: '0.131825904205330',
    span: { m: 1, e: psExp }, spanMant: 1, spanExp: psExp,
    pixelSize: Math.pow(2, psExp), psMant: 1, psExp, psLog2: psExp,
    maxIter: 300, bits: 'auto', palette: 'ice',
    cycle: 140, offset: 0, bands: 0, detail: 3, traps: 0,
    ncycle: 140, tone: { bri: 1, gr: 1, gg: 1, gb: 1 }, colorMode: 0,
    scheme: 0, dither: false, aa: 1, quality: 2,
    de: { on: true, width: 1, strength: 0.85 },
    asField, frame: false, rotation: 0
  };
}

try {
  let info = null;
  for (let i = 0; i < 30; i++) {
    try { info = await ping(); break; } catch { await wait(200); }
  }
  check('server responds', !!info, JSON.stringify(info));
  check('server advertises env + field',
    info && info.env === true && info.field === true && info.version >= 3,
    `version=${info && info.version}`);

  const a = await render(job(0, 0));
  const b = await render(job(128, 0));
  check('first deep tile builds the shared orbit', a.env === 'built', `x-env=${a.env}`);
  check('second tile reuses it', b.env === 'cached', `x-env=${b.env}`);
  check('tile carries pass-buffer dimensions',
    a.meta.width === W && a.meta.height === H,
    `${a.meta.width}x${a.meta.height}`);
  check('RGBA payload size', a.body.length === TW * TH * 4,
    `${a.body.length} bytes`);
  check('both tiles share one reference', a.meta.refLen === b.meta.refLen,
    `${a.meta.refLen} vs ${b.meta.refLen}`);

  /* A shallower view actually escapes, so the field carries real
   * colour positions rather than only interior markers. */
  const f = await render(job(0, 0, true, -10));
  check('field mode flagged in meta', f.meta.field === true,
    `field=${f.meta.field}`);
  check('field payload is one float per pixel', f.body.length === TW * TH * 4,
    `${f.body.length} bytes`);
  const floats = new Float32Array(f.body.buffer, f.body.byteOffset, TW * TH);
  let interior = 0, positions = 0, nan = 0, over = 0; const odd = [];
  for (const v of floats) {
    if (Number.isNaN(v)) { nan++; if (odd.length < 6) odd.push('NaN'); }
    else if (v < 0) interior++;
    else if (v <= 1) positions++;
    else { over++; if (odd.length < 6) odd.push(v); }
  }
  console.log('FIELD DIAG', JSON.stringify({ nan, over, interior, positions, odd }));
  check('field values are colour positions or interior markers',
    interior + positions === TW * TH,
    `interior=${interior} positions=${positions}`);
  check('field carries real escape positions', positions > 0,
    `${positions} positions`);
} catch (e) {
  check('server smoke test ran', false, String(e && e.message || e));
  if (serverLog) console.log('[server]', serverLog.slice(-600));
} finally {
  srv.kill();
}
console.log(fails ? `\nSERVERCHECK FAILED (${fails})` : '\nSERVERCHECK OK');
process.exit(fails ? 1 : 0);
