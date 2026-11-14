/**
 * Browser-level check for the four JSON import shapes.
 *
 * Talks to the already-running CDP browser on :9333.  Verifies that
 *   - a viewport preset applies the file's resolved additive table,
 *   - colorschemes.json installs schemes instead of opening a blank view,
 *   - mandelbrot.json is applied as settings, not as a preset,
 * and that none of them raise an uncaught exception.
 */

import fs from 'node:fs';

const PORT = 9333;
const REF = 'C:/Users/harve/Desktop/mande';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
if (!page) { console.error('no page on :9333'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 300));
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = m.params.type;
    if (t === 'error' || t === 'warning') {
      logs.push(`[${t}] ` + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 240));
    }
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700));
  }
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, 9000));

const snapshot = () => ev(`(() => {
  const s = window.__mb && window.__mb.state;
  if (!s) return JSON.stringify({boot: false});
  const st = JSON.parse(localStorage.getItem('mb.colorschemes.v2') || '[]');
  return JSON.stringify({
    boot: true,
    presetId: s.presetId || null,
    mode: s.spec.mode,
    palette: s.palette,
    colors: (s.schemeColors || []).length,
    freq: (s.schemeColors || []).slice(0, 3).map(c => +Number(c.frequency).toFixed(6)),
    rgb: (s.schemeColors || []).slice(0, 3).map(c => [c.r, c.g, c.b]),
    scheme: s.schemeName || '',
    cfg: s.cfg ? { loaded: s.cfg.loaded, nthread: s.cfg.nthread } : null,
    schemes: st.length
  });
})()`);

const importText = async (text, name) => {
  await ev(`window.dispatchEvent(new CustomEvent('mbPreset', {detail:{type:'presetImport', ok:true, text:${JSON.stringify(text)}, name:${JSON.stringify(name)}}})); 1`);
  await new Promise(r => setTimeout(r, 3500));
};

const home = JSON.parse(await snapshot());
console.log('home    ', home);

const example = fs.readFileSync(
  `${REF}/04_配置与示例/examples/Retinamandelbrot Example 11.json`, 'utf8');
await importText(example, 'Retinamandelbrot Example 11.json');
const e11 = JSON.parse(await snapshot());
console.log('preset  ', e11);

const libText = fs.readFileSync(`${REF}/00_原始项目副本/colorschemes.json`, 'utf8');
await importText(libText, 'colorschemes.json');
const lib = JSON.parse(await snapshot());
console.log('schemes ', lib);

const cfgText = fs.readFileSync(`${REF}/04_配置与示例/mandelbrot.json`, 'utf8');
await importText(cfgText, 'mandelbrot.json');
const cfg = JSON.parse(await snapshot());
console.log('settings', cfg);

const failures = [];
if (!home.boot) failures.push('page did not boot');
if (e11.colors !== 3) failures.push('preset did not install 3 colour terms');
if (Math.abs(e11.freq[0] - 0.095098) > 1e-4) failures.push('preset frequency not in shader domain');
if (e11.rgb[0][0] !== 1) failures.push('preset lost the inherited red term');
if (lib.presetId !== e11.presetId) failures.push('colorschemes.json opened a new view');
if (!cfg.cfg || !cfg.cfg.loaded) failures.push('mandelbrot.json was not applied as settings');
const exceptions = logs.filter(l => l.startsWith('EXC'));
if (exceptions.length) failures.push('exceptions: ' + exceptions.slice(0, 3).join(' | '));

console.log('\nconsole errors:', logs.filter(l => !l.startsWith('EXC')).slice(-4).join(' | ') || 'none');
console.log(failures.length ? 'FAIL ' + failures.join('; ') : 'PASS all import shapes');
ws.close();
process.exit(failures.length ? 1 : 0);
