/* ------------------------------------------------------------------
 * corepanel.js — "Render core" panel.
 *
 * The browser bundle already ships a WebAssembly kernel, but the optional
 * native core runs the very same kernel inside a Node.js worker pool, out of
 * the page's event loop.  This panel:
 *   1. reports whether a local core answered on 127.0.0.1:8778,
 *   2. offers the packaged core (`core/mandelbrot-core.zip`) for download,
 *   3. caches that archive so a later download works offline / instantly,
 *   4. explains the two-step start-up on every platform.
 *
 * The package is a static artefact rebuilt by `tools/build-core-package.mjs`,
 * therefore it can be served straight from GitHub Pages.
 * ----------------------------------------------------------------*/

import { remoteStatus } from './remote.js';

const PKG_URL = 'core/mandelbrot-core.zip';
const CACHE_NAME = 'mb-core-v1';
const PKG_BYTES = 412 * 1024; // approximate, refreshed from Content-Length when known

/** Cache the archive in the background so the download is instant later. */
async function warmCache() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(PKG_URL);
    if (hit) return;
    const res = await fetch(PKG_URL, { cache: 'no-store' });
    if (res.ok) await cache.put(PKG_URL, res.clone());
  } catch {
    /* private mode, quota, offline — the direct link still works */
  }
}

function sizeLabel(bytes) {
  if (!bytes) return '';
  return bytes > 1024 * 1024
    ? (bytes / 1048576).toFixed(1) + ' MB'
    : Math.round(bytes / 1024) + ' KB';
}

/**
 * Render the core panel inside the shared modal host.
 * @param {{t:Function, openModal:Function, toast:Function, isSecure:boolean}} ui
 */
export function openCorePanel(ui) {
  const { t, openModal, toast } = ui;
  const st = remoteStatus();
  const online = !!st.enabled;
  const info = st.info || {};
  const https = location.protocol === 'https:';

  const status = online
    ? `<div class="core-status ok"><span class="cs-dot"></span>
         <span>${t('coreOnline')}</span>
         <span class="cs-sub">${(info.threads || '—')} thr · ${info.kernel || 'wasm'}</span>
       </div>`
    : `<div class="core-status busy"><span class="cs-dot"></span>
         <span>${t('coreOffline')}</span>
         <span class="cs-sub">127.0.0.1:8778</span>
       </div>`;

  const body = `
    <div class="core-body">
      ${status}
      <p>${t('coreDesc')}</p>
      <ol class="core-steps">
        <li>${t('coreStep1')}</li>
        <li>${t('coreStep2')}</li>
        <li>${t('coreStep3')}</li>
      </ol>
      <div class="core-actions">
        <a class="btn primary" id="core-download" href="${PKG_URL}" download="mandelbrot-core.zip">
          ${t('coreDownload')}<span style="opacity:.6;font-size:11px">· ${sizeLabel(PKG_BYTES)}</span>
        </a>
        <button class="btn" id="core-copy">${t('coreCopy')}</button>
        <button class="btn ghost" id="core-retry">${t('coreRetry')}</button>
      </div>
      <div class="core-note">${https ? t('coreHttpsNote') : t('coreLocalNote')}</div>
    </div>`;

  openModal('core', t('coreTitle'), t('coreSub'), body, '', 'narrow');

  const copyBtn = document.getElementById('core-copy');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const cmd = /^win/i.test(navigator.platform || '') ? 'start-core.bat' : 'bash start-core.sh';
      (navigator.clipboard ? navigator.clipboard.writeText(cmd) : Promise.reject())
        .then(() => toast(t('coreCopied')))
        .catch(() => toast(cmd));
    };
  }

  const retry = document.getElementById('core-retry');
  if (retry) {
    retry.onclick = async () => {
      retry.disabled = true;
      retry.textContent = '…';
      const ok = await ui.reprobe();
      toast(ok ? t('coreOnline') : t('coreOffline'));
      openCorePanel(ui);
    };
  }

  // Reflect the real archive size once the cache is warm.
  warmCache().then(async () => {
    const el = document.getElementById('core-download');
    if (!el) return;
    try {
      const cache = await caches.open(CACHE_NAME);
      const res = await cache.match(PKG_URL);
      const len = res && res.headers.get('content-length');
      if (len) {
        const span = el.querySelector('span');
        if (span) span.textContent = '· ' + sizeLabel(Number(len));
      }
    } catch { /* ignore */ }
  });
}
