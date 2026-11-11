/* ------------------------------------------------------------------
 * corepanel.js — "Render core" panel.
 *
 * The browser bundle already ships a WebAssembly kernel, and the main view
 * iterates entirely in a fragment shader.  What it cannot do is run the
 * desktop program's own core: multi-threaded, out of the page's event loop,
 * with no tab-memory ceiling.  That core ships with the desktop build, so the
 * download entry point is the project's Releases page rather than a copy of
 * the kernel zip baked into the site.
 *
 * The panel therefore:
 *   1. reports whether a local core answered on 127.0.0.1:8778,
 *   2. links to the Releases page (desktop build + core package),
 *   3. explains the two-step start-up on every platform.
 * ----------------------------------------------------------------*/

import { remoteStatus } from './remote.js';

const RELEASES_URL = 'https://github.com/xiaoxu4452/mandelbrot-view/releases';

/**
 * Render the core panel inside the shared modal host.
 * @param {{t:Function, openModal:Function, toast:Function, reprobe:Function}} ui
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
        <a class="btn primary" id="core-download" href="${RELEASES_URL}"
           target="_blank" rel="noopener noreferrer">${t('coreDownload')}</a>
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
}
