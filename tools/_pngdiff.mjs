/* Minimal PNG reader + image comparison for the evidence screenshots.
 *
 * No dependencies: PNG IDAT is zlib, which Node already has, and the five
 * filter types are a few lines each.  Page.captureScreenshot produces 8-bit
 * RGB (2) or RGBA (6), non-interlaced, which is all this handles.
 *
 * usage:
 *   node tools/_pngdiff.mjs a.png b.png [--crop fx0,fy0,fx1,fy1] [--shift 4]
 *
 * Two modes:
 *   default   same-position diff (how many pixels moved, by how much)
 *   --shift N search integer shifts in [-N,N] and report the one that best
 *             aligns b onto a.  A pair that differs only by a translation
 *             lands on that shift with ~0 residual; a frame whose content
 *             really changed has no shift that explains it.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export function decode(path) {
  const b = fs.readFileSync(path);
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported png ${bd}/${ct}`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += up;
      else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) {
        const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { w, h, bpp, px: out };
}

const lum = (im, x, y) => {
  const i = (y * im.w + x) * im.bpp;
  return (im.px[i] * 299 + im.px[i + 1] * 587 + im.px[i + 2] * 114) / 1000;
};

/** Best integer alignment of b onto a, sampled on a 3-px lattice. */
export function bestShift(A, B, box, range = 4) {
  const [x0, y0, x1, y1] = box;
  let best = null;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      let sum = 0, n = 0;
      for (let y = y0 + 20; y < y1 - 20; y += 3) {
        for (let x = x0 + 20; x < x1 - 20; x += 3) {
          const sx = x + dx, sy = y + dy;
          if (sx < x0 || sy < y0 || sx >= x1 || sy >= y1) continue;
          sum += Math.abs(lum(A, x, y) - lum(B, sx, sy));
          n++;
        }
      }
      const v = n ? sum / n : 1e9;
      if (!best || v < best.v) best = { dx, dy, v, n };
    }
  }
  return best;
}

if (process.argv[1] && process.argv[1].endsWith('_pngdiff.mjs')) {
  const files = process.argv.slice(2).filter((s) => !s.startsWith('--'));
  const opt = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const A = decode(files[0]), B = decode(files[1]);
  if (A.w !== B.w || A.h !== B.h) throw new Error('size mismatch');
  const [fx0, fy0, fx1, fy1] = (opt('crop', '0,0,1,1')).split(',').map(Number);
  const box = [Math.round(fx0 * A.w), Math.round(fy0 * A.h), Math.round(fx1 * A.w), Math.round(fy1 * A.h)];
  if (opt('shift', null) !== null) {
    console.log(JSON.stringify({ box, best: bestShift(A, B, box, Number(opt('shift', 4))) }));
  } else {
    const [x0, y0, x1, y1] = box;
    let diff = 0, maxd = 0, sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * A.w + x) * A.bpp;
        n++;
        const d = Math.max(
          Math.abs(A.px[i] - B.px[i]),
          Math.abs(A.px[i + 1] - B.px[i + 1]),
          Math.abs(A.px[i + 2] - B.px[i + 2]));
        if (d) { diff++; sum += d; if (d > maxd) maxd = d; }
      }
    }
    console.log(`region ${x0},${y0}-${x1},${y1} (${n} px)  differing: ${diff}  max delta: ${maxd}  mean delta: ${(sum / n).toFixed(4)}`);
  }
}
