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
/* One worker per core, minus one: the browser, the compositor and whatever else
 * the user is running need a slot, and a machine that stutters is not faster
 * than one that does not.  MB_THREADS overrides it for measurement. */
const CORES = os.availableParallelism?.() || os.cpus().length;
const THREADS = Math.max(1, Math.min(64, Number(process.env.MB_THREADS) || (CORES - 1)));

const pool = [];
const queue = [];
let seq = 0;
/* One reference orbit per view, shared by every tile and every worker thread.
 * The page does this in its in-browser worker pool; the out-of-process core
 * used to elect an orbit per tile, which is what made deep remote frames much
 * slower than local ones and left seams between tiles. */
const envCache = new Map();
const envInflight = new Map();
const ENV_CACHE_MAX = 8;

/** Signature of the *plane region*, not of a tile or pass buffer. */
function envSig(job) {
  const s = job.spec || {};
  return [s.mode, s.kind, s.power,
    s.julia ? s.julia.re + ',' + s.julia.im : '',
    job.center && job.center.re, job.center && job.center.im,
    job.span && job.span.m, job.span && job.span.e,
    job.maxIter, job.bits].join('|');
}

function spawn() {
  const rec = { busy: false, w: new Worker(path.join(HERE, 'render-worker.mjs')), task: null };
  rec.w.on('message', (msg) => {
    if (msg.type === 'ready') { rec.ready = true; pump(); return; }
    if (msg.type === 'tile' || msg.type === 'error' || msg.type === 'env') {
      const task = rec.task;
      rec.task = null;
      rec.busy = false;
      if (task) {
        if (msg.type === 'error') task.reject(new Error(msg.message));
        else if (msg.type === 'env' && msg.error)
          task.reject(new Error(msg.error));
        else task.resolve(msg);
      }
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
    rec.w.postMessage(task.kind === 'prepare'
      ? { type: 'prepare', job: task.job, id: task.id }
      : { type: 'render', job: task.job });
  }
}

function submit(kind, job) {
  return new Promise((resolve, reject) => {
    queue.push({ kind, job, resolve, reject, id: ++seq });
    pump();
  });
}

const renderTile = (job) => submit('render', job);

/** Build (once) and reuse the frame-wide reference orbit for a view. */
async function ensureEnv(job) {
  const sig = envSig(job);
  const hit = envCache.get(sig);
  if (hit) return { env: hit, built: false };
  if (envInflight.has(sig)) return { env: await envInflight.get(sig), built: false };
  const pending = submit('prepare', job).then((env) => {
    if (envCache.size >= ENV_CACHE_MAX)
      envCache.delete(envCache.keys().next().value);
    envCache.set(sig, env);
    return env;
  });
  envInflight.set(sig, pending);
  try { return { env: await pending, built: true }; }
  finally { envInflight.delete(sig); }
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
    'Access-Control-Expose-Headers': 'x-meta, x-env, content-length'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (url.pathname === '/ping') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, threads: THREADS, kernel: 'c++/wasm-simd',
      version: 3, env: true, field: true }));
    return;
  }

  if (url.pathname === '/render' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const job = JSON.parse(body.toString('utf8'));
      const t0 = performance.now();
      let envInfo = 'none';
      /* A reference orbit belongs to the view, not to a tile.  Build it once
       * here and attach it to every tile of that view; the worker's adoptEnv()
       * then copies it into its own orbit slot instead of electing a new one
       * (which is both slow and the source of tile-boundary seams). */
      const eligible = job.psLog2 <= -34 && job.spec &&
        (job.spec.kind === 'mandelbrot' || job.spec.kind === 'multibrot');
      if (eligible && !job.env) {
        try {
          const r = await ensureEnv(job);
          if (r.env && r.env.re) {
            job.env = r.env;
            envInfo = r.built ? 'built' : 'cached';
          }
        } catch (e) {
          /* Never lose a frame because the shared orbit failed: without
           * job.env the worker elects its own, i.e. the old behaviour. */
          envInfo = 'failed';
          if (process.env.MB_DEBUG) console.warn('[env]', e && e.message || e);
        }
      }
      const msg = await renderTile(job);
      if (process.env.MB_DEBUG) {
        console.log(`[tile] ${job.id} ${job.w}x${job.h} iter=${job.maxIter} ${(performance.now()-t0).toFixed(0)}ms`);
      }
      const data = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
      const meta = Buffer.from(JSON.stringify({
        ...msg.meta, x: msg.x, y: msg.y, w: msg.w, h: msg.h,
        /* The page rejects a tile whose pass-buffer dimensions do not match
         * the pass it started (drawTile's passW/passH guard).  Without these
         * two, every remote tile was silently dropped. */
        width: msg.width, height: msg.height,
        viewId: msg.viewId, id: msg.id,
        ms: msg.meta && msg.meta.ms != null ? msg.meta.ms : (performance.now() - t0),
        total: performance.now() - t0
      })).toString('base64');
      res.writeHead(200, {
        ...cors,
        'content-type': 'application/octet-stream',
        'content-length': data.length,
        'x-meta': meta,
        'x-env': envInfo,
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
