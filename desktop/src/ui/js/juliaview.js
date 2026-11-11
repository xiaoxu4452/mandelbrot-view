/* ------------------------------------------------------------------
 * juliaview.js — the reference program's Julia preview window.
 *
 * The original does not draw a "mini Mandelbrot" in the corner.  It keeps a
 * second REALM and a second VIEWPORT (00406070.c:44-50): `vpex` renders the
 * Julia set for the Mandelbrot point currently under the cursor, and the very
 * same fragment shader colours it with `uniforms.julia = true` and
 * `uniforms.j = c` (005499b0.c:118-131).  In mode 1 a mouse move writes the
 * marked point into the Julia realm's seed (00405590.c:126-137 ->
 * 004442f0.c:65-76); the small window is 56x56 inside a 60x60 frame
 * (004169c0.c:130-155).
 *
 * This is that window, docked at the top of the console rather than floating
 * over the canvas.  It has its own iteration field and its own WebGL surface,
 * but borrows the main view's compiled scheme and Params, so a palette change
 * recolours both with no second code path to keep in sync.
 *
 * Seeds come from three places, in the reference's own order of precedence:
 *   1. the point just clicked with the picker   (pinned, survives panning)
 *   2. the point under the pointer              (mode 1, "follow")
 *   3. the main view's centre                   (nothing picked yet)
 * ----------------------------------------------------------------*/
import { FieldRenderer } from './gpu.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const $ = (id) => document.getElementById(id);

/* z <- z^2 + c, starting from the *pixel* (z0), with c the Mandelbrot seed.
 * That swap of roles is the entire difference from the main view.  The field
 * layout is the same four floats the main kernel emits, so the same shader
 * can shade it: smoothiter / distance-in-pixels / iter / dist2. */
function juliaField(w, h, o) {
  const { seedRe, seedIm, centerRe, centerIm, span, rotation, maxIter } = o;
  const out = new Float32Array(w * h * 4);
  const ps = span / w;
  const cr = Math.cos(rotation), sr = Math.sin(rotation);
  const halfW = w * 0.5, halfH = h * 0.5;
  const bail = 1.0e8;
  const ln2 = Math.LN2;

  for (let y = 0; y < h; ++y) {
    const dy = -(y + 0.5 - halfH) * ps;
    for (let x = 0; x < w; ++x) {
      const dx = (x + 0.5 - halfW) * ps;
      let zr = centerRe + dx * cr - dy * sr;
      let zi = centerIm + dx * sr + dy * cr;
      /* dz/dz0, for the distance estimate.  Julia keeps c fixed, so the
       * derivative has no +1 term (unlike the Mandelbrot dz/dc). */
      let dr = 1.0, di = 0.0;
      let m2 = zr * zr + zi * zi;
      let n = 0;
      for (; n < maxIter; ++n) {
        const ndr = 2.0 * (zr * dr - zi * di);
        const ndi = 2.0 * (zr * di + zi * dr);
        dr = ndr; di = ndi;
        const nr = zr * zr - zi * zi + seedRe;
        zi = 2.0 * zr * zi + seedIm;
        zr = nr;
        m2 = zr * zr + zi * zi;
        if (m2 > bail) { ++n; break; }
      }
      const p = (y * w + x) * 4;
      if (m2 <= bail) {
        /* Interior.  The reference encodes the negated period in the smooth
         * iteration channel; a fixed point is period 1 -> -1. */
        out[p] = -1; out[p + 1] = 0; out[p + 2] = -1; out[p + 3] = 0;
      } else {
        const lz = 0.5 * Math.log(m2);
        const nu = (n + 1) - Math.log(lz) / ln2;
        const dm = Math.sqrt(dr * dr + di * di);
        const dist = dm > 0 ? Math.sqrt(m2) * lz / dm / ps : 0;
        out[p] = nu;
        out[p + 1] = dist;
        out[p + 2] = n;
        out[p + 3] = dist;
      }
    }
  }
  return out;
}

export function initJuliaView(opts) {
  const {
    mainCanvas, getScheme, screenToPlane, planeToScreen, getCenter, t,
    getLang, onLog, onOpen, onBack
  } = opts;

  const wrap = $('julia-preview');
  const frame = $('julia-frame');
  const view = $('julia-canvas');
  const seedText = $('julia-seed');
  const mark = $('julia-mark');
  if (!wrap || !view) return { redraw() {}, pickAt() { return false; }, isPicking() { return false; }, syncUi() {} };

  const renderer = new FieldRenderer(view);
  let visible = true;
  let follow = true;                      // pointer hover re-seeds (reference mode 1)
  let picking = false;                    // waiting for a click on the canvas
  let big = false;
  let zoom = 0.5;                         // reference's default julia_zoom
  let rotation = -Math.PI / 2;            // reference's default julia_rotation
  let center = { re: 0, im: 0 };          // julia_x / julia_y (viewport centre)
  let seed = null;                        // {re,im} strings once pinned / hovered
  let pickedAt = -1e9;                    // when the last seed was pinned (ms)
  let focus = false;                      // this set is open in the main view
  let timer = 0;
  let lastKey = '';

  const lang = () => (getLang ? getLang() : 'zh');
  const tr = (k, d) => (t ? (t(k) || d) : d);
  const seedNow = () => {
    if (seed) return seed;
    const c = getCenter ? getCenter() : { re: '-0.6', im: '0' };
    return { re: c.re, im: c.im };
  };
  const seedValues = () => {
    const s = seedNow();
    return { re: Number(s.re) || 0, im: Number(s.im) || 0 };
  };

  const zoomFromSlider = (v) => 0.25 * Math.pow(2, (+v || 0) / 12);
  const sliderFromZoom = (z) => clamp(12 * Math.log(Math.max(0.25, z) / 0.25) / Math.LN2, 0, 100);

  /* Buffer size follows the dock, not a constant: the panel is resizable by
   * the user's window, and a 168px buffer stretched to 290px looks soft. */
  function dim() {
    const cssW = frame ? frame.clientWidth : 0;
    const base = cssW > 40 ? cssW - 8 : 168;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return Math.max(64, Math.min(512, Math.round(base * dpr)));
  }

  function fmtSeed(s) {
    const n = (v) => {
      const x = Number(v);
      return Number.isFinite(x) ? x.toFixed(6) : String(v).slice(0, 12);
    };
    const im = Number(s.im) || 0;
    return `c = ${n(s.re)} ${im >= 0 ? '+' : '-'} ${Math.abs(im).toFixed(6)}i`;
  }

  /* Place the pinned-seed marker in the Mandelbrot plane.  It follows pans,
   * zooms and rotation, so the window can never show a set whose c the canvas
   * no longer points at. */
  function updateMark() {
    if (!mark) return;
    /* While the main view *is* that Julia set the circle would point at the
     * Mandelbrot point of a picture that no longer shows it.  A preset pins a
     * seed too, but there the user never placed it, so an unexplained white
     * ring sitting in the middle of the artwork is just an artefact: only a
     * pick — while it is being made, and for a few seconds after — is shown. */
    const picked = picking || (performance.now() - pickedAt < 4000);
    const pinned = seed && !follow && !focus && picked;
    const p = pinned && planeToScreen ? planeToScreen(seed.re, seed.im) : null;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
        p.x < -40 || p.y < -40 ||
        p.x > window.innerWidth + 40 || p.y > window.innerHeight + 40) {
      mark.hidden = true;
      return;
    }
    mark.hidden = false;
    mark.style.left = p.x + 'px';
    mark.style.top = p.y + 'px';
  }

  function syncUi() {
    if (wrap) wrap.hidden = !visible;
    if (wrap) wrap.classList.toggle('big', big);
    const chkFollow = $('chk-julia-follow');
    if (chkFollow) chkFollow.checked = follow;
    /* Focus mode (this set is open in the main view) replaces the caption with
     * the way back — the console has no other place to say where you are. */
    const title = $('julia-dock-title');
    const back = $('btn-julia-back');
    if (title) title.hidden = focus;
    if (back) back.hidden = !focus;
    const pickBtn = $('btn-julia-pick');
    if (pickBtn) pickBtn.classList.toggle('on', picking);
    const hint = $('julia-pick-hint');
    if (hint) hint.hidden = !picking;
    document.body.classList.toggle('julia-picking', picking);
    const zr = $('rng-julia-zoom'), zv = $('val-julia-zoom');
    if (zr) zr.value = String(Math.round(sliderFromZoom(zoom)));
    if (zv) zv.textContent = zoom < 10 ? zoom.toFixed(2) : String(Math.round(zoom));
    const rr = $('rng-julia-rot'), rv = $('val-julia-rot');
    const deg = Math.round(rotation * 180 / Math.PI);
    if (rr) rr.value = String(deg);
    if (rv) rv.textContent = deg + '°';
    if (seedText) seedText.textContent = fmtSeed(seedNow());
    updateMark();
  }

  function redraw(force = false) {
    if (!visible || !renderer.ok) { syncUi(); return; }
    const o = getScheme ? getScheme() : null;
    if (!o || !o.src) return;             // main GPU pass has not run yet
    const c = seedValues();
    /* The reference keeps the Julia view's own centre (julia_x/y, normally
     * the origin) and its own zoom, independent of the Mandelbrot view. */
    const W = dim(), H = W;
    /* Deeper Julia zooms need more iterations; 160 covers the default 0.5. */
    const maxIter = Math.round(clamp(160 + 90 * Math.log2(Math.max(1, zoom)), 140, 2400));
    const key = [c.re, c.im, center.re, center.im, zoom, rotation, maxIter,
                 o.src.length, o.param.join(','), o.colors.length,
                 o.stops.length, W].join('|');
    if (!force && key === lastKey) { syncUi(); return; }
    lastKey = key;

    const field = juliaField(W, H, {
      seedRe: c.re, seedIm: c.im,
      centerRe: center.re, centerIm: center.im,
      span: 2.0 / zoom,
      rotation,
      maxIter
    });
    /* The reference ships samples = 2 and so does this window; a 168px field
     * is cheap enough that supersampling costs nothing noticeable. */
    const err = renderer.setScheme(o.src, Math.min(2, Math.max(1, o.samples | 0 || 1)));
    if (err) {
      if (onLog) onLog('[julia] shader: ' + String(err).slice(0, 240));
      return;
    }
    renderer.uploadField(field, W, H);
    renderer.resize(W, H);
    const ps = (2.0 / zoom) / W;
    renderer.draw({
      colors: o.colors,
      stops: o.stops,
      briFinite: o.briFinite,
      briInfinite: o.briInfinite,
      briFactor: o.briFactor,
      param: o.param,
      /* uniforms.julia / uniforms.j — the seed that selected this Julia set. */
      julia: true,
      juliaRe: c.re, juliaIm: c.im,
      centerRe: center.re, centerIm: center.im,
      scaleX: ps * Math.cos(rotation),
      scaleY: ps * Math.sin(rotation),
      /* Same tone stage as the main view: the small window is a second look at
       * the same picture, so it must not drift away when a slider moves. */
      tone: o.tone,
      inverse: false
    });
    syncUi();
  }

  function schedule(force = false) {
    if (!visible) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; redraw(force); }, 90);
  }

  /* Reference mode 1: the point under the pointer re-seeds the Julia realm.
   * While the picker is armed the same hover previews the candidate, so the
   * user can see the set before committing to it. */
  mainCanvas.addEventListener('pointermove', (e) => {
    if (!visible || e.buttons) return;
    if (!follow && !picking) return;
    const p = screenToPlane ? screenToPlane(e.clientX, e.clientY) : null;
    if (!p) return;
    seed = { re: String(p.re), im: String(p.im) };
    if (seedText) seedText.textContent = fmtSeed(seed);
    schedule();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picking) {
      picking = false;
      syncUi();
    }
  });

  const chkFollow = $('chk-julia-follow');
  if (chkFollow) chkFollow.onchange = (e) => {
    follow = !!e.target.checked;
    if (follow) picking = false;
    syncUi();
    schedule(true);
  };
  const zr = $('rng-julia-zoom');
  if (zr) zr.oninput = (e) => {
    zoom = zoomFromSlider(e.target.value);
    const zv = $('val-julia-zoom');
    if (zv) zv.textContent = zoom < 10 ? zoom.toFixed(2) : String(Math.round(zoom));
    schedule();
  };
  const rr = $('rng-julia-rot');
  if (rr) rr.oninput = (e) => {
    rotation = (+e.target.value) * Math.PI / 180;
    const rv = $('val-julia-rot');
    if (rv) rv.textContent = e.target.value + '°';
    schedule();
  };
  const centerBtn = $('btn-julia-center');
  if (centerBtn) centerBtn.onclick = () => {
    seed = null;
    picking = false;
    follow = true;
    syncUi();
    schedule(true);
  };
  const pickBtn = $('btn-julia-pick');
  if (pickBtn) pickBtn.onclick = () => {
    picking = !picking;
    if (picking) follow = false;
    syncUi();
  };
  const sizeBtn = $('btn-julia-size');
  if (sizeBtn) sizeBtn.onclick = () => {
    big = !big;
    syncUi();
    schedule(true);
  };
  /* Clicking the picture opens that set in the main view.  The reference keeps
   * the second viewport as a picker for the first one; this is the same move
   * with one less menu. */
  if (view) view.onclick = () => {
    if (picking) return;
    const c = seedNow();
    if (onOpen) onOpen({ re: String(c.re), im: String(c.im) });
  };
  const backBtn = $('btn-julia-back');
  if (backBtn) backBtn.onclick = () => { if (onBack) onBack(); };

  syncUi();
  /* At boot the main GPU pass is usually still in flight, so `getScheme()`
   * has nothing to borrow yet.  Retry briefly instead of leaving an empty
   * window until the user happens to move the mouse. */
  {
    let tries = 0;
    const kick = () => {
      if (getScheme && getScheme()) { schedule(true); return; }
      if (++tries < 40) setTimeout(kick, 150);
    };
    kick();
  }
  return {
    redraw: () => schedule(true),
    onViewChanged: () => { syncUi(); if (!follow || seed) schedule(true); },
    isPicking: () => picking,
    /* Focus mode: the caption becomes the way back. */
    setFocus(on) {
      focus = !!on;
      if (focus) { picking = false; }
      syncUi();
    },
    /* A pick and a double-click both land on the canvas; the click that pins a
     * seed must not also be read as "zoom here". */
    pickedRecently: () => picking || (performance.now() - pickedAt) < 400,
    /* Called from the canvas pointerdown handler while the picker is armed.
     * Returns true when the click was consumed as a seed pick. */
    pickAt(clientX, clientY) {
      if (!picking) return false;
      const p = screenToPlane ? screenToPlane(clientX, clientY) : null;
      if (!p) return false;
      seed = { re: String(p.re), im: String(p.im) };
      follow = false;
      picking = false;
      pickedAt = performance.now();
      lastKey = '';
      syncUi();
      schedule(true);
      /* The ring is a confirmation of the pick, not a permanent overlay. */
      setTimeout(updateMark, 4300);
      return true;
    },
    /* Imported reference JSON carries julia_zoom / julia_rotation / julia_mx/my. */
    setParams(p) {
      if (!p) return;
      if (p.zoom != null && isFinite(+p.zoom) && +p.zoom > 0) zoom = +p.zoom;
      if (p.rotation != null && isFinite(+p.rotation)) rotation = +p.rotation;
      if (p.center && p.center.re != null) {
        center = { re: +p.center.re || 0, im: +p.center.im || 0 };
      }
      if (p.seed && p.seed.re != null) {
        seed = { re: String(p.seed.re), im: String(p.seed.im) };
        follow = false;
        picking = false;
      }
      lastKey = '';
      syncUi();
      schedule(true);
    },
    syncUi
  };
}
