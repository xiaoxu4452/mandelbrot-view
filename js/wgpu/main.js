/* Bridge between the page's view state and the WebGPU deep renderer.
 *
 * The page owns panning, zooming, presets and the HUD; this class only keeps a
 * single render job in flight.  Requests that arrive mid-frame replace the
 * queued one and invalidate the running build, so a burst of wheel notches
 * cannot queue up minutes of stale MPFR work.
 */
import { DeepRenderer } from './renderer.js?v=28';

export class MainGPU {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.onFrame = hooks.onFrame || null;
    this.onDecline = hooks.onDecline || null;
    this.onFail = hooks.onFail || null;
    this.renderer = null;
    this.ready = false;
    this.failed = false;
    this.running = false;
    this.pending = null;
    /* One thrown frame used to mark the backend dead forever, so a single
     * cancelled build (every wheel notch cancels the previous one) left the
     * rest of the session on the CPU pipeline — deep views then took seconds.
     * Only consecutive, superseded-free failures count. */
    this.failStreak = 0;
  }

  async init() {
    if (this.ready) return true;
    if (this.failed || !navigator.gpu) {
      this.failed = true;
      return false;
    }
    try {
      const renderer = new DeepRenderer(this.canvas, () => {});
      await renderer.init();
      this.renderer = renderer;
      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[webgpu] init failed, keeping the CPU pipeline', err);
      this.failed = true;
      return false;
    }
  }

  get status() {
    return this.renderer ? this.renderer.status : null;
  }

  /** Queue a full-quality frame for `view` (built by the caller).
   *
   * `failed` is checked here, not just `ready`: once a frame has thrown the
   * renderer will never produce another one, so reporting success would make
   * the page skip its CPU pipeline for a backend that draws nothing.  The
   * visible symptom was a canvas frozen on a half-painted pass while the HUD
   * kept saying "rendering 0%". */
  commit(view) {
    if (!this.ready || this.failed) return false;
    this.pending = view;
    if (this.running) this.renderer.cancel();
    else this._drain();
    return true;
  }

  /** Drop queued/running work (window resize, switching to an unsupported set). */
  cancel() {
    this.pending = null;
    if (this.running && this.renderer) this.renderer.cancel();
  }

  async _drain() {
    this.running = true;
    try {
      while (this.pending && !this.failed) {
        const view = this.pending;
        this.pending = null;
        let ok = false;
        const gen0 = this.renderer._gen;
        try {
          ok = await this.renderer.setView(view);
        } catch (err) {
          /* A frame that was cancelled by a newer commit throws from inside
           * the async orbit build.  That is the normal wheel-burst path, not a
           * broken device: leaving `failed` set here is what pushed every deep
           * view back onto the CPU for the rest of the session. */
          if (this.pending || this.renderer._gen !== gen0 + 1) continue;
          this.failStreak++;
          console.warn('[webgpu] frame failed (' + this.failStreak + ')', err);
          if (this.onFail) this.onFail(err, view);
          if (this.failStreak >= 2) {
            /* Two real failures in a row: keep the CPU pipeline responsible
             * instead of asking a backend that draws nothing every frame. */
            this.failed = true;
            break;
          }
          continue;
        }
        this.failStreak = 0;
        /* ok === false means a newer commit invalidated this one.  If another
         * request is already queued, stay silent and let that frame land. */
        if (!ok && !this.pending && this.renderer.declined) {
          const why = this.renderer.declined;
          this.renderer.declined = null;
          if (this.onDecline) this.onDecline(why, view);
          continue;
        }
        if (!ok || this.pending) continue;
        if (this.onFrame) this.onFrame(this.renderer.status, view);
      }
    } finally {
      this.running = false;
    }
  }

  resize() {
    if (this.renderer) this.renderer.resize();
  }

  /** Measurement override for the double-float pixel path (null = by depth). */
  forceDD(v) {
    if (this.renderer) this.renderer.ddForce = v;
    return this.renderer ? this.renderer.ddForce : null;
  }

  dispose() {
    this.cancel();
    if (this.renderer) this.renderer.dispose();
    this.renderer = null;
    this.ready = false;
  }
}
