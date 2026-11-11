/* ------------------------------------------------------------------
 * webprobe.mjs — drive the *web* build through CDP.
 *
 * The desktop shell listens on 9222 (see tools/cdp.mjs); the browser build
 * needs its own probe because it is a real page, not a WebView2 host.  This
 * connects to whatever remote-debugging port Edge/Chrome was started with,
 * collects console output and uncaught errors, evaluates one expression, and
 * writes a screenshot.
 *
 *   node tools/webprobe.mjs --port 9333 --shot out.png [--eval "expr"]
 *                           [--wait 8000] [--w 1280] [--h 800]
 *
 * Exit code is 0 when the page produced no uncaught error, 1 otherwise, so a
 * build script can gate on it.
 * ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};

const PORT = Number(arg('port', 9333));
const SHOT = arg('shot', '');
const EXPR = arg('eval', '');
const WAIT = Number(arg('wait', 8000));
const VIEW_W = Number(arg('w', 1280));
const VIEW_H = Number(arg('h', 800));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
    logs.push({ level: m.params.type, text });
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push({ level: 'exception', text: (d.exception && (d.exception.description || d.text)) || d.text || 'exception' });
  } else if (m.method === 'Log.entryAdded') {
    logs.push({ level: m.params.entry.level, text: m.params.entry.text });
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(r => pending.set(id, r));
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
/* Only resize when the page is not already that size: the override itself
 * fires a resize event, which starts a fresh progressive render — and a
 * screenshot taken mid-pass shows the not-yet-painted tiles as black bands
 * that look exactly like a rendering bug. */
const cur = await send('Runtime.evaluate', {
  expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true
});
let sized = false;
try { const [w, h] = JSON.parse(cur.result.result.value); sized = w === VIEW_W && h === VIEW_H; } catch { /* ignore */ }
if (!sized) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false
  });
}
await new Promise(r => setTimeout(r, WAIT));

if (EXPR) {
  const r = await send('Runtime.evaluate', {
    expression: EXPR, returnByValue: true, awaitPromise: true
  });
  const v = r.result?.result;
  console.log('EVAL:', v && 'value' in v ? JSON.stringify(v.value) : JSON.stringify(r.result).slice(0, 400));
}

if (SHOT) {
  const shot = await send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false
  });
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT:', SHOT);
  } else {
    console.log('SHOT FAILED:', JSON.stringify(shot).slice(0, 200));
  }
}

const bad = logs.filter(l => l.level === 'error' || l.level === 'exception');
for (const l of logs.slice(-25)) console.log(`[${l.level}] ${String(l.text).slice(0, 300)}`);
ws.close();
process.exit(bad.length ? 1 : 0);
