/* ------------------------------------------------------------------
 * render-server.mjs — 本地渲染服务
 *   把渲染核心（C++/WASM 内核 + 高精度参考轨道）放在浏览器进程之外，
 *   通过 HTTP 把瓦片以原始 RGBA 交给页面，页面只负责显示。
 * ----------------------------------------------------------------*/
import http from 'node:http';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.MB_PORT || 8778);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const THREADS = Math.max(4, Math.min(32, (os.availableParallelism?.() || os.cpus().length) - 0));

const pool = [];
const queue = [];
let seq = 0;

function spawn() {
  const rec = { busy: false, w: new Worker(path.join(HERE, 'render-worker.mjs')), task: null };
  rec.w.on('message', (msg) => {
    if (msg.type === 'ready') { rec.ready = true; pump(); return; }
    if (msg.type === 'tile' || msg.type === 'error') {
      const task = rec.task;
      rec.task = null;
      rec.busy = false;
      if (task) (msg.type === 'tile' ? task.resolve(msg) : task.reject(new Error(msg.message)));
      pump();
    }
  });
  rec.w.on('error', (e) => {
    console.error('[worker]', e.message);
    if (rec.task) { rec.task.reject(e); rec.task = null; }
    rec.busy = false;
    pump();
  });
  pool.push(rec);
  return rec;
}

for (let i = 0; i < THREADS; i++) spawn();

function pump() {
  while (queue.length) {
    const rec = pool.find(r => r.ready && !r.busy);
    if (!rec) return;
    const task = queue.shift();
    rec.busy = true;
    rec.task = task;
    rec.w.postMessage({ type: 'render', job: task.job });
  }
}

function renderTile(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject, id: ++seq });
    pump();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    // 浏览器默认读不到自定义响应头，必须显式暴露 x-meta
    'Access-Control-Expose-Headers': 'x-meta, content-length'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (url.pathname === '/ping') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, threads: THREADS, kernel: 'c++/wasm-simd', version: 2 }));
    return;
  }

  if (url.pathname === '/render' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const job = JSON.parse(body.toString('utf8'));
      const t0 = performance.now();
      const msg = await renderTile(job);
      if (process.env.MB_DEBUG) {
        console.log(`[tile] ${job.id} ${job.w}x${job.h} iter=${job.maxIter} ${(performance.now()-t0).toFixed(0)}ms`);
      }
      const data = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
      const meta = Buffer.from(JSON.stringify({
        ...msg.meta, x: msg.x, y: msg.y, w: msg.w, h: msg.h,
        viewId: msg.viewId, id: msg.id,
        ms: msg.meta && msg.meta.ms != null ? msg.meta.ms : (performance.now() - t0),
        total: performance.now() - t0
      })).toString('base64');
      res.writeHead(200, {
        ...cors,
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'x-meta': meta,
        'cache-control': 'no-store'
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { ...cors, 'content-type': 'text/plain' });
      res.end(String(e && e.message || e));
    }
    return;
  }

  res.writeHead(404, cors);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[render-core] http://127.0.0.1:${PORT}  threads=${THREADS}`);
});
