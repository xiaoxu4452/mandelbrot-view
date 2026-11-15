/* ------------------------------------------------------------------
 * drawlib.js — the presentation layer, decoupled from the solver.
 *
 * Contract: the solver hands back, per sample, either an escape record
 * (iteration count n + |z|^2 at escape) or an interior marker.  This module
 * owns everything after that: smooth-iteration normalisation, palette fetch,
 * tile rasterisation, and supersample reduction (anti-aliasing).
 *
 * The WASM kernel keeps its own LUT fetch for speed; putColor() below is the
 * reference implementation and is byte-for-byte equivalent to kernel putColor.
 * ----------------------------------------------------------------*/

export const BAIL2 = 1e20;
export const LOG_BAIL = 23.025850929940457;   // ln(1e10), matches kernel LOGBAIL
export const LUT_SIZE = 512;
export const INTERIOR = [5, 6, 9];

/** Smooth escape count: continuous across iteration bands (Mandelbrot/Julia). */
export function smoothIter(n, m2, invLogPower) {
  const nu = Math.log(0.5 * Math.log(m2) / LOG_BAIL) * invLogPower;
  return n + 1 - (nu === nu ? nu : 0);
}

/** Palette fetch with wrap-around interpolation; writes RGBA into data[o..]. */
export function putColor(lut, t, data, o) {
  const u = t - Math.floor(t);
  let ix = u * LUT_SIZE;
  let i0 = ix | 0;
  if (i0 >= LUT_SIZE) i0 = LUT_SIZE - 1;
  if (i0 < 0) i0 = 0;
  const f = ix - i0;
  const a4 = i0 * 4, b4 = ((i0 + 1) & (LUT_SIZE - 1)) * 4;
  data[o] = Math.round(lut[a4] + (lut[b4] - lut[a4]) * f);
  data[o + 1] = Math.round(lut[a4 + 1] + (lut[b4 + 1] - lut[a4 + 1]) * f);
  data[o + 2] = Math.round(lut[a4 + 2] + (lut[b4 + 2] - lut[a4 + 2]) * f);
  data[o + 3] = 255;
}

export function putInterior(data, o) {
  data[o] = INTERIOR[0]; data[o + 1] = INTERIOR[1]; data[o + 2] = INTERIOR[2]; data[o + 3] = 255;
}

/** Colour index from the smooth count: one palette pass every `cycle` iterations. */
export function shadeSmooth(smooth, cycle, offset) {
  return smooth * (1 / Math.max(2, cycle)) + offset;
}

export function tileImageData(data, w, h) {
  return new ImageData(new Uint8ClampedArray(data), w, h);
}

/**
 * Integer box reduction: (w x h) RGBA -> (w/k x h/k).  This is the box filter
 * used for supersampling; `k` is the per-axis sample count.  Box averaging is
 * the right filter here because the samples are already evenly spaced inside
 * the pixel footprint (uniform supersampling), and it keeps edges crisp instead
 * of the blur a bilinear/bicubic minification would add.
 */
export function boxDownsample(src, w, h, k) {
  if (k === 1) return src;
  const ow = Math.floor(w / k), oh = Math.floor(h / k);
  const out = new Uint8ClampedArray(ow * oh * 4);
  const denom = k * k;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < k; dy++) {
        let p = ((y * k + dy) * w + x * k) * 4;
        for (let dx = 0; dx < k; dx++, p += 4) {
          r += src[p]; g += src[p + 1]; b += src[p + 2]; a += src[p + 3];
        }
      }
      const q = (y * ow + x) * 4;
      out[q] = (r + denom / 2) / denom;
      out[q + 1] = (g + denom / 2) / denom;
      out[q + 2] = (b + denom / 2) / denom;
      out[q + 3] = (a + denom / 2) / denom;
    }
  }
  return out;
}

/**
 * Composite one solver tile onto a 2D context.
 *  scale > 1 : the tile was rendered supersampled; reduce it with boxDownsample.
 *  scale == 1: straight blit.
 *  scale < 1 : progressive pass; smooth upscale (never nearest-neighbour).
 */
export function composeTile(ctx, scratch, msg, scale) {
  const k = Math.round(scale);
  if (!window.__mbForceBlit && scale >= 1 && Math.abs(scale - k) < 1e-9) {
    const data = k === 1 ? msg.data : boxDownsample(msg.data, msg.w, msg.h, k);
    const iw = msg.w / k, ih = msg.h / k;
    if (k === 1) { ctx.putImageData(new ImageData(new Uint8ClampedArray(data), iw, ih), msg.x, msg.y); return; }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), iw, ih), msg.x / k, msg.y / k);
    return;
  }
  scratch.width = msg.w;
  scratch.height = msg.h;
  scratch.ctx.putImageData(new ImageData(new Uint8ClampedArray(msg.data), msg.w, msg.h), 0, 0);
  /* Snap the tile's scaled rect to whole pixels *as a pair*, so neighbouring
   * tiles share their edge exactly.  Rounding each coordinate independently
   * (or drawing at fractional positions) leaves 1px gaps/overlaps between
   * tiles of a progressive pass — after a deep zoom that reads as diagonal
   * tearing across the whole picture. */
  const x0 = Math.round(msg.x / scale), y0 = Math.round(msg.y / scale);
  const x1 = Math.round((msg.x + msg.w) / scale), y1 = Math.round((msg.y + msg.h) / scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scratch.canvas, 0, 0, msg.w, msg.h, x0, y0, x1 - x0, y1 - y0);
}
