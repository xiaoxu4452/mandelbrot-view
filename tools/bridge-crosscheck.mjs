/* Cross-check the web MPFR orbit against the desktop Boost referee.
 *
 * This is the runtime half of the Boost <-> MPFR bridge: the page builds a
 * real gmp-wasm (MPFR) reference orbit and exports it as decimal strings;
 * core/mb_bridge.cpp recomputes the same orbit with Boost.Multiprecision and
 * reports the worst step-by-step relative error.  A deliberately corrupted
 * sample is checked too, so a bridge that always says "PASS" is detected.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = process.env.MB_CDP_PORT || 9333;
const EXE = resolve('Meter Mandelbrot/src/bin/mb_bridgecheck.exe');
const TMP = resolve('tools/_bridge-orbit.json');
const BAD = resolve('tools/_bridge-orbit-bad.json');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
if (!page) throw new Error('no index.html page (start the static server + debug browser)');
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
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  }
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.bringToFront');

const steps = Number(process.argv[2] || 32);
const digits = Number(process.argv[3] || 40);
const cr = '-0.743643887037158704752191506114774';
const ci = '0.131825904205311970493132056385139';
const json = await ev(`(async () => __mb.exportOrbitJson({
  centerRe: ${JSON.stringify(cr)},
  centerIm: ${JSON.stringify(ci)},
  maxIter: ${steps},
  precisionBits: 512,
  digits: ${digits}
}))()`);
if (!json || !json.startsWith('{')) throw new Error('bad export: ' + String(json).slice(0, 200));
const obj = JSON.parse(json);
writeFileSync(TMP, json);
console.log(`web MPFR orbit: ${obj.orbit.length / 2} steps, ${obj.digits} digits, ` +
            `first z1=${obj.orbit[2]}`);

const run = (file) => {
  const r = spawnSync(EXE, [file], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout };
};

const good = run(TMP);
const line = good.out.split('\n').filter((l) => /\[bridge\] check|RESULT/.test(l)).join(' | ');
console.log('desktop Boost referee:', line || '(no check line)');
console.log('positive case exit:', good.code);

/* Corrupt one mantissa in step 3: the referee must reject it.  gmp-wasm's
 * toString(10) is a plain decimal without an exponent, so change the third
 * significant digit outright instead of trying to match a scientific suffix. */
const bad = JSON.parse(json);
const k = 3 * 2; // Re(z_3)
const s = bad.orbit[k];
const m = /^(-?\d)\.(\d+)/.exec(s);
if (!m) throw new Error('unexpected orbit format: ' + s);
const at = m[0].length - m[2].length + 2;       // third fractional digit
const ch = s[at];
bad.orbit[k] = s.slice(0, at) +
  (ch === '9' ? '0' : String(Number(ch) + 1)) + s.slice(at + 1);
if (bad.orbit[k] === obj.orbit[k]) throw new Error('corruption did not apply');
writeFileSync(BAD, JSON.stringify(bad));
const neg = run(BAD);
const negLine = neg.out.split('\n').filter((l) => /mismatched steps|RESULT/.test(l)).join(' | ');
console.log('corrupted case  :', negLine || '(no mismatch line)');
console.log('negative case exit:', neg.code);

ws.close();
const ok = good.code === 0 && neg.code === 1;
console.log(ok ? 'BRIDGE CROSS-CHECK OK' : 'BRIDGE CROSS-CHECK FAILED');
process.exit(ok ? 0 : 1);
