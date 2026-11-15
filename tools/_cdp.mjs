/* _cdp.mjs — spawn a private headless Edge, hand back a tiny CDP client.
 *
 * The browser lives exactly as long as the test: launching it from a separate
 * background shell is what killed the previous runs halfway (the shell's sleep
 * expired, the browser went with it, and every pending CDP call hung).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

export async function launch({ width = 1280, height = 900, profile } = {}) {
  const dir = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'mbedge-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-features=Translate,MediaRouter', '--mute-audio',
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('edge did not report a devtools endpoint')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('edge exited ' + c)); });
  });

  /* Only the page socket is needed: every test drives one tab. */
  const base = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
  let pageTarget = null;
  for (let i = 0; i < 100 && !pageTarget; i++) {
    const targets = await http(`${base}/json/list`).catch(() => []);
    pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) await new Promise((r) => setTimeout(r, 150));
  }
  if (!pageTarget) throw new Error('no page target');
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  return { page, proc, dir };
}

/** Attach to a browser that is already listening on `port`. */
export async function attach(port = 9346) {
  const base = `http://127.0.0.1:${port}`;
  let pageTarget = null;
  for (let i = 0; i < 100 && !pageTarget; i++) {
    const targets = await http(`${base}/json/list`).catch(() => []);
    pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) await new Promise((r) => setTimeout(r, 150));
  }
  if (!pageTarget) throw new Error(`no page target on ${port}`);
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  return { page, proc: null, dir: null };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pend = new Map();
    const listeners = [];
    const client = {
      ws,
      logs: [],
      send(method, params = {}) {
        const k = ++id;
        ws.send(JSON.stringify({ id: k, method, params }));
        return new Promise((res, rej) => pend.set(k, { res, rej }));
      },
      on(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch { /* already gone */ } },
    };
    ws.onopen = () => resolve(client);
    ws.onerror = (e) => reject(new Error('ws error ' + e.message));
    ws.onclose = () => { for (const [, p] of pend) p.rej(new Error('socket closed')); pend.clear(); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message)); else p.res(m);
        return;
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') client.logs.push(m.params.entry.text);
      if (m.method === 'Runtime.exceptionThrown') client.logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      for (const fn of listeners) fn(m);
    };
  });
}

async function http(url) {
  const r = await fetch(url);
  return r.json();
}

/** Evaluate in the page and return the value (throws on page exception). */
export async function evaluate(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  const d = r.result;
  if (d?.exceptionDetails) {
    throw new Error(String(d.exceptionDetails.exception?.description || d.exceptionDetails.text).slice(0, 400));
  }
  return d?.result?.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
