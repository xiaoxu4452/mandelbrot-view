/* ------------------------------------------------------------------
 * remote.js — client for the out-of-browser render core.
 *
 *   Once `server/render-server.mjs` is running, the page streams tile jobs
 *   to http://127.0.0.1:8778/render.  The service executes the very same
 *   C++/WebAssembly kernel in a worker-thread pool and returns raw RGBA,
 *   so the page only has to compose the returned bytes onto the canvas.
 * ----------------------------------------------------------------*/

const BASE = 'http://127.0.0.1:8778';
let state = null;      // null = not probed yet, true = available, false = unavailable
let info = null;
let probing = null;

/** True when the page is served over HTTPS from a public host. */
function blockedByMixedContent() {
  return location.protocol === 'https:' &&
    location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1';
}

export function remoteStatus() {
  return { enabled: state === true, info };
}

export async function probeRemote() {
  if (state !== null) return state;
  if (probing) return probing;
  probing = (async () => {
    // An https page may not call http://127.0.0.1 — the browser blocks it
    // before a single byte leaves the machine, so do not waste a round trip.
    if (blockedByMixedContent()) {
      state = false;
      info = null;
      probing = null;
      return state;
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 900);
      const r = await fetch(BASE + '/ping', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const j = await r.json();
      state = !!(r.ok && j.ok);
      info = j;
    } catch {
      state = false;
    }
    probing = null;
    return state;
  })();
  return probing;
}

/** Forget the cached result so the next probe hits the network again. */
export function resetRemote() {
  state = null;
  info = null;
  probing = null;
}

export function remoteEnabled() {
  return state === true;
}

export function disableRemote() {
  state = false;
}

/** Request one tile; resolves to {type:'tile', x, y, w, h, data, meta}. */
export async function remoteRender(job, signal) {
  const r = await fetch(BASE + '/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(job),
    signal
  });
  if (!r.ok) throw new Error('render server: ' + (await r.text()).slice(0, 120));
  const raw = r.headers.get('x-meta');
  const meta = raw ? JSON.parse(atob(raw)) : {};
  const buf = new Uint8Array(await r.arrayBuffer());
  const data = new Uint8ClampedArray(buf.length);
  data.set(buf);
  return {
    type: 'tile',
    viewId: meta.viewId,
    x: meta.x, y: meta.y, w: meta.w, h: meta.h,
    data,
    meta: {
      mode: meta.mode, bits: meta.bits, ms: meta.ms != null ? meta.ms : meta.total,
      glitches: meta.glitches || 0, refLen: meta.refLen || 0,
      engine: 'remote', limited: !!meta.limited
    }
  };
}
