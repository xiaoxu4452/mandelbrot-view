/* 把浏览器里的渲染 Worker（js/worker.js）原样跑在 Node 的 worker_thread 里。
 * 只做一层 self 适配，渲染逻辑与浏览器完全一致（含 C++ → WASM 内核）。 */
import { parentPort } from 'node:worker_threads';

const listeners = new Set();

globalThis.self = {
  set onmessage(fn) { listeners.add(fn); parentPort.on('message', (data) => fn({ data })); },
  get onmessage() { return null; },
  postMessage(msg, transfer) { parentPort.postMessage(msg, transfer); }
};

await import('../js/worker.js');
