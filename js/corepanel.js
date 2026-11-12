/* ------------------------------------------------------------------
 * corepanel.js — desktop download panel.
 *
 * The web page loads its own render core automatically: a WebAssembly kernel
 * for the CPU path and a fragment/compute shader for the live path.  There is
 * no separate core package to download or start.  The desktop build remains
 * the only manual download, because it runs the native multithreaded core
 * outside the browser.
 * ----------------------------------------------------------------*/

/* `latest` rather than a tag: the panel should not need an edit per release. */
const RELEASES_URL = 'https://github.com/xiaoxu4452/mandelbrot-view/releases/latest';

/**
 * Render the desktop download panel inside the shared modal host.
 * @param {{t:Function, openModal:Function}} ui
 */
export function openCorePanel(ui) {
  const { t, openModal } = ui;

  const body = `
    <div class="core-body">
      <p>${t('coreDesc')}</p>
      <div class="core-actions">
        <a class="btn primary" id="core-download" href="${RELEASES_URL}"
           target="_blank" rel="noopener noreferrer">${t('coreDownload')}</a>
      </div>
    </div>`;

  openModal('core', t('coreTitle'), t('coreSub'), body, '', 'narrow');
}
