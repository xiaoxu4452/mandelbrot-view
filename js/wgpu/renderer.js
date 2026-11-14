/* ------------------------------------------------------------------
 * renderer.js — WebGPU deep-zoom renderer.
 *
 *   reference : gmp-wasm / MPFR (ref-orbit.js), cached per anchor
 *   pixels    : WGSL compute (extended float + BLA), never JS/Wasm
 *   colour    : WGSL IQ cosine palette -> rgb10a2unorm target -> swap chain
 *
 * Depth is carried by (scaleMant, scaleExp) and by the per-pixel δ exponent,
 * not by float64.  The swap-chain format is the browser's preferred 8-bit
 * format; the 10-bit target lives immediately before presentation.
 * ------------------------------------------------------------------ */

import { COMPUTE_WGSL, SHADE_WGSL, PRESENT_WGSL, computeWgslWithoutDoubleFloat } from './wgsl.js?v=28';
import {
  buildReferenceOrbit,
  buildBla,
  precisionForSpan,
  physicalBits,
  bitsToDigits,
  familyIndex,
  isPolynomialFamily,
  pickSurvivor,
  OrbitCache,
  gmpLib
} from './ref-orbit.js?v=28';

const WG = 8;

function spanToString(spanLog2) {
  const e10 = spanLog2 * Math.log10(2);
  const e = Math.floor(e10);
  const m = Math.pow(10, e10 - e);
  return `${m.toPrecision(17)}e${e}`;
}

export function depthText(spanLog2) {
  const e10 = spanLog2 * Math.log10(2);
  return `10^${e10.toFixed(e10 > -10 ? 2 : 0)}`;
}

/**
 * Offset a decimal coordinate by `delta` without dropping the digits that
 * matter.  Used by the reference search, which only runs on shallow views, so
 * the double the string parses to is far more precise than the offset; a
 * coordinate whose own precision would be destroyed is refused instead of
 * silently moved.
 */
function shiftDecimal(str, delta) {
  const base = Number(str);
  if (!Number.isFinite(base)) return null;
  if (Math.abs(delta) < Math.abs(base) * 1e-12) return null;
  const out = base + delta;
  if (!Number.isFinite(out) || out === base) return null;
  return out.toPrecision(17);
}

export class DeepRenderer {
  constructor(canvas, onStatus = () => {}) {
    this.canvas = canvas;
    this.onStatus = onStatus;
    this.viewW = 1;
    this.viewH = 1;
    this.device = null;
    this.context = null;
    this.presentFormat = 'bgra8unorm';
    this.orbitCache = new OrbitCache();
    this.orbit = null;
    this.bla = { data: new Float32Array(0), count: 0 };
    this._fieldCache = new Map();
    this._shadeTarget = null;
    this._camCtx = null;
    this._camBits = 0;
    this._nudge = 0;
    this._reselecting = false;
    this._disposed = false;
    this.stats = null;
    this.status = null;
    /* Every setView starts a generation; a newer one invalidates the async
     * work of an older one (MPFR orbit build, progressive passes) so a fast
     * zoom burst cannot land a stale frame on top of a newer view. */
    this._gen = 0;
    this._lutKey = '';
    /* null = pick by depth, true/false = measurement override. */
    this.ddForce = null;
    this._noDD = false;
    /* Monotonic frame counter, so a measurement can wait for *this* frame
     * instead of reading the previous status. */
    this._seq = 0;
    /* Colour cycles per frame.  out uses ten, but its palette is a sum of
     * cosines that never reaches zero, whereas the presets here are
     * there-and-back gradients -- every wrap lands on the dark end and paints
     * a visible arc, so ten wraps per frame look like ten black contours. */
    this._cycleBands = 3;
  }

  async init() {
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('NO_WEBGPU');
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });
    if (!adapter) throw new Error('NO_ADAPTER');
    const device = await adapter.requestDevice();
    this.device = device;
    this.adapterInfo = typeof adapter.info === 'object' ? adapter.info : {};

    this.presentFormat = navigator.gpu.getPreferredCanvasFormat();
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error('NO_CONTEXT');
    ctx.configure({
      device,
      format: this.presentFormat,
      alphaMode: 'opaque'
    });
    this.context = ctx;

    this.computeModule = await this._compileCompute();
    this.shadeModule = await this._compile(SHADE_WGSL, 'shade');
    this.presentModule = await this._compile(PRESENT_WGSL, 'present');

    this.computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' }
        },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
      ]
    });
    this.shadeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }
        }
      ]
    });
    this.presentBGL = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' }
        }
      ]
    });

    const computeLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.computeBGL]
    });
    this.computePipeline = device.createComputePipeline({
      layout: computeLayout,
      compute: { module: this.computeModule, entryPoint: 'main' }
    });

    this.shadePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.shadeBGL] }),
      vertex: { module: this.shadeModule, entryPoint: 'vs' },
      fragment: {
        module: this.shadeModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgb10a2unorm' }]
      },
      primitive: { topology: 'triangle-list' }
    });

    this.presentPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.presentBGL] }),
      vertex: { module: this.presentModule, entryPoint: 'vs' },
      fragment: {
        module: this.presentModule,
        entryPoint: 'fs',
        targets: [{ format: this.presentFormat }]
      },
      primitive: { topology: 'triangle-list' }
    });

    this.computeParams = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.shadeParams = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    /* Six counters, not four: the last two carry the frame's escape range as
     * fixed point (smooth * 8), reduced with atomicMin/atomicMax.  The palette
     * needs that range and nothing else in the pipeline can supply it — the
     * page used to guess it from maxIter, and at 1e-5 a guess of 3000 against
     * a real span of 6..48 put sixteen colour wraps on one screen (the hard
     * dark contour arcs).  Padded to 32 bytes so the copy stays aligned. */
    this.counterBuf = device.createBuffer({
      size: 32,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    });
    this.stagingBuf = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    this.orbitBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.blaBuf = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.orbitLen = 1;
    this.blaCount = 0;
    /* The main page's palette table, uploaded as a 512x1 texture.  Mode 3
     * shades from this instead of a built-in cosine ramp. */
    this.paletteTex = device.createTexture({
      size: [512, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    this.resize();
  }

  /**
   * Compile the compute kernel, dropping the double-float section if this
   * implementation cannot compile it.  The section needs `fma`; the stripped
   * source is the float32 kernel that was shipped before it, so the fallback
   * costs accuracy at depth but never the whole backend.
   */
  async _compileCompute() {
    try {
      return await this._compile(COMPUTE_WGSL, 'compute');
    } catch (err) {
      console.warn('[webgpu] double-float kernel rejected, using float32 pixels', err);
      this._noDD = true;
      return await this._compile(computeWgslWithoutDoubleFloat(), 'compute-sp');
    }
  }

  async _compile(code, label) {
    const module = this.device.createShaderModule({ code, label });
    if (module.getCompilationInfo) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        throw new Error(
          `WGSL ${label}: ` +
            errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')
        );
      }
    }
    return module;
  }

  resize() {
    const coarse =
      typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const cap = coarse ? 1.5 : 2;
    let dpr = Math.min(window.devicePixelRatio || 1, cap);
    let w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    let h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    /* Phones report 3x DPR; the compute pass is per-pixel, so cap the buffer
     * instead and let the compositor upscale the swap chain.
     *
     * A deep frame is 3.2 M px times 14 000 iterations — 45 G steps.  At the
     * shallow cap that is 4.2 s of compute for one frame; 2.0 M px brings it
     * under 3 s and the difference is invisible after the compositor's
     * upscale, because at that depth every pixel is a filament several
     * screen-pixels wide. */
    const deep = !!(this.view && this.view.maxIter > 6000);
    const maxPx = coarse ? 1.5e6 : (deep ? 2.0e6 : 3.6e6);
    const px = w * h;
    if (px > maxPx) {
      const k = Math.sqrt(maxPx / px);
      w = Math.max(1, Math.floor(w * k));
      h = Math.max(1, Math.floor(h * k));
    }
    if (w === this.viewW && h === this.viewH && this._shadeTarget) return;
    this.viewW = w;
    this.viewH = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of this._fieldCache.values()) t.destroy();
    this._fieldCache.clear();
    this._shadeTarget?.destroy();
    this._shadeTarget = this.device.createTexture({
      size: [w, h],
      format: 'rgb10a2unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
  }

  _fieldTexture(w, h) {
    const key = `${w}x${h}`;
    let t = this._fieldCache.get(key);
    if (t) return t;
    t = this.device.createTexture({
      size: [w, h],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC
    });
    this._fieldCache.set(key, t);
    return t;
  }

  async setView(view) {
    const gen = ++this._gen;
    this.declined = null;
    this.view = {
      maxIter: 2000,
      mode: 0,
      juliaRe: '0',
      juliaIm: '0',
      power: 2,
      kind: 'mandelbrot',
      phoenixP: 0.5667,
      rotation: 0,
      useBla: true,
      shadeMode: 0,
      cycle: 140,
      bands: 3,
      palette: { freq: 0.12, phase: 0.0, offset: 0.0, exposure: 1.0 },
      safety: 1,
      ...view
    };
    this.resize();
    this._syncLut();
    this._cycleBands = Math.max(1, this.view.bands || 3);
    if (!(await this._prepareOrbit(gen))) return false;
    if (gen !== this._gen) return false;
    if (!(await this.renderProgressive(gen))) return false;
    this._emitStatus({ phase: 'ready' });
    return true;
  }

  /** Invalidate any in-flight build/pass; the next setView starts fresh. */
  cancel() {
    this._gen++;
  }

  /** Upload the main page's 512-entry palette table when its key changes. */
  _syncLut() {
    const v = this.view;
    if (!v || !v.lut || !v.lutKey || v.lutKey === this._lutKey) return;
    this.device.queue.writeTexture(
      { texture: this.paletteTex },
      v.lut,
      { bytesPerRow: 512 * 4 },
      [512, 1]
    );
    this._lutKey = v.lutKey;
  }

  async _prepareOrbit(gen) {
    const v = this.view;
    const needBits = precisionForSpan(v.spanLog2, v.maxIter, v.safety);
    let reuse = !!this.orbit &&
      this.orbit.bits >= needBits &&
      this.orbit.maxIter >= v.maxIter &&
      this.orbit.mode === v.mode &&
      this.orbit.kind === familyIndex(v.kind) &&
      this.orbit.power === v.power &&
      this.orbit.juliaRe === v.juliaRe &&
      this.orbit.juliaIm === v.juliaIm;

    let off = { x: 0, y: 0 };
    if (reuse) {
      off = await this._offsetPixels(this.orbit, needBits);
      if (gen !== this._gen) return false;
      if (
        Math.abs(off.x) > this.viewW * 0.75 ||
        Math.abs(off.y) > this.viewH * 0.75
      ) {
        reuse = false;
      }
    }

    if (!reuse) {
      const tA = performance.now();
      this.onStatus({ phase: 'orbit', depth: depthText(v.spanLog2) });
      await new Promise((r) => setTimeout(r, 0));
      if (gen !== this._gen) return false;
      let orbit = await this._buildOrbit(v.centerRe, v.centerIm, needBits, gen);
      if (window.__mbTiming) console.info(`[t] buildOrbit ${Math.round(performance.now() - tA)}ms len=${orbit ? orbit.length : -1} bits=${needBits}`);
      if (!orbit || gen !== this._gen) return false;
      /* A reference that escapes before the pixels do hands every longer
       * orbit to the float32 "direct finish", which has no zoom left in it.
       * The reference only has to be *some* point whose orbit stays bounded,
       * so on a shallow view try the neighbours too and keep the longest —
       * the same idea as the CPU side's pickReference, and what makes a whole
       * Julia set render without a speckled boundary.  Deep views skip this:
       * there the centre either belongs to the set or the frame escapes
       * within a handful of steps anyway.
       *
       * `_longestOrbit` returns {orbit, best}, not an orbit: assigning the
       * wrapper here was the crash that left the page on a half-painted frame
       * (orbit.points undefined -> the frame throws -> the backend is marked
       * failed while still claiming every later view). */
      let scanBest = -1;
      const tS = performance.now();
      if (orbit.escape >= 0 && v.spanLog2 > -40) {
        const better = await this._longestOrbit(v, needBits, orbit, gen);
        if (gen !== this._gen) return false;
        if (better) {
          orbit = better.orbit;
          scanBest = better.best;
        }
      } else if (orbit.escape >= 0) {
        /* Below 2^-40 a double grid cannot resolve the frame at all.  Score
         * candidates built as MPFR decimal strings instead: a view whose
         * centre escapes in 18 steps can still contain a boundary point that
         * lives for thousands, and that point is the reference the pixels
         * need.  This is what keeps a real 10^17 Julia view on WebGPU. */
        const better = await this._longestOrbitHi(v, needBits, orbit, gen);
        if (gen !== this._gen) return false;
        if (better) {
          orbit = better.orbit;
          scanBest = better.best;
        }
      }
      if (window.__mbTiming) console.info(`[t] survivorScan ${Math.round(performance.now() - tS)}ms best=${scanBest} esc=${orbit.escape}`);
      /* A reference that dies long before the frame's iteration budget hands
       * every surviving pixel to the float32 "direct finish", which iterates
       * the pixel's ABSOLUTE coordinate.  At 10^17 those coordinates have
       * already collapsed onto the double grid, so the tail becomes a flat
       * band instead of structure: the reported "10^17 is the limit".
       *
       * The old decline gate needed `scanBest` from the double survivor scan,
       * but that scan was skipped below 2^-40, so scanBest stayed -1 and a
       * deep view could NEVER be handed back.  Judge the orbit on its own
       * length instead, after the high-precision scan has had its chance. */
      const refFloor = Math.min(v.maxIter, Math.max(96, v.maxIter >> 2));
      if (v.spanLog2 < -40 && orbit.escape >= 0 && orbit.escape < refFloor) {
        this.declined = {
          reason: 'short-reference', refLen: orbit.escape, best: scanBest,
          maxIter: v.maxIter
        };
        return false;
      }
      if (v.spanLog2 > -40 && orbit.escape >= 0 &&
          scanBest > orbit.escape && scanBest - orbit.escape > 12) {
        this.declined = { reason: 'short-reference', refLen: orbit.escape, best: scanBest, maxIter: v.maxIter };
        return false;
      }
      orbit.maxIter = v.maxIter;
      orbit.mode = v.mode;
      orbit.power = v.power;
      orbit.kind = familyIndex(v.kind);
      orbit.juliaRe = v.juliaRe;
      orbit.juliaIm = v.juliaIm;
      this.orbit = orbit;
      /* BLA encodes the z^2 multiplier (2Z) over a block, so it is only valid
       * for the polynomial family at power 2.  The folded families run the
       * per-step formula instead — still one GPU dispatch, just no skip. */
      const blaOk = isPolynomialFamily(v.kind) && (v.power | 0 || 2) === 2;
      const tB = performance.now();
      this.bla = blaOk ? buildBla(orbit.points, orbit.length)
                       : { data: new Float32Array(0), count: 0 };
      if (window.__mbTiming) console.info(`[t] bla ${Math.round(performance.now() - tB)}ms count=${this.bla.count}`);
      if (!this._uploadOrbit()) {
        this.declined = { reason: 'empty-orbit', refLen: orbit.length, maxIter: v.maxIter };
        this.orbit = null;
        return false;
      }
      /* The reference is not necessarily the view centre (see the survivor
       * search above), so the window offset has to be measured even for a
       * freshly built orbit — it is zero only when the two points coincide. */
      off = await this._offsetPixels(orbit, needBits);
      if (gen !== this._gen) return false;
      this._nudge = 0;
    }
    this.orbitOffset = off;
    this.needBits = needBits;
    this.physicalNeed = physicalBits(v.spanLog2, v.maxIter);
    return true;
  }

  /** Build one orbit at `bits` and remember which point it belongs to. */
  async _buildOrbit(centerRe, centerIm, bits, gen) {
    const v = this.view;
    const orbit = await buildReferenceOrbit({
      centerRe,
      centerIm,
      maxIter: v.maxIter,
      precisionBits: bits,
      mode: v.mode,
      juliaRe: v.juliaRe,
      juliaIm: v.juliaIm,
      power: v.power,
      kind: v.kind,
      phoenixP: v.phoenixP,
      isCancelled: () => gen !== this._gen
    });
    if (!orbit) return null;
    orbit.centerRe = centerRe;
    orbit.centerIm = centerIm;
    return orbit;
  }

  /**
   * Replace a short-lived reference with the best survivor in the frame.  The
   * grid scan runs in double (cheap, and far finer than a pixel on a shallow
   * view); only the winner is rebuilt at the working precision.
   */
  async _longestOrbit(v, needBits, current, gen) {
    const pick = pickSurvivor({
      centerRe: v.centerRe,
      centerIm: v.centerIm,
      spanLog2: v.spanLog2,
      maxIter: v.maxIter,
      mode: v.mode,
      juliaRe: v.juliaRe,
      juliaIm: v.juliaIm,
      power: v.power,
      kind: v.kind,
      phoenixP: v.phoenixP
    });
    if (!pick || gen !== this._gen) return null;
    if (!(pick.len > current.escape)) return { orbit: current, best: pick.len };
    /* Shallow views only.  The scan reports a relative offset; at these scales
     * an absolute float64 is still finer than a pixel, so keep the original
     * double round-trip here (it is the path the per-family A/B is signed off
     * against).  Deep views use _longestOrbitHi, which never forms an absolute
     * coordinate in float64. */
    const span = Math.pow(2, v.spanLog2);
    if (Math.abs(pick.dx) > span || Math.abs(pick.dy) > span) return null;
    const x = Number(v.centerRe) + pick.dx;
    const y = Number(v.centerIm) + pick.dy;
    const orbit = await this._buildOrbit(x.toPrecision(17), y.toPrecision(17), needBits, gen);
    if (!orbit) return null;
    return { orbit, best: pick.len };
  }

  /** A short MPFR orbit used only to score one candidate reference point. */
  async _probeOrbit(centerRe, centerIm, bits, maxIter, gen) {
    const v = this.view;
    return buildReferenceOrbit({
      centerRe,
      centerIm,
      maxIter,
      precisionBits: bits,
      mode: v.mode,
      juliaRe: v.juliaRe,
      juliaIm: v.juliaIm,
      power: v.power,
      kind: v.kind,
      phoenixP: v.phoenixP,
      isCancelled: () => gen !== this._gen
    });
  }

  /**
   * Survivor scan for deep views.
   *
   * `pickSurvivor` forms candidates as `cx + offset` in float64; at 10^17 the
   * frame is ~1e-15 wide while the centre is ~0.8, so every candidate in a
   * 40x40 grid collapses onto one of about ten doubles.  Here the offset is
   * applied to the centre in MPFR and the candidate is emitted as a decimal
   * string, so it is a genuinely different point.  Only the winner is rebuilt
   * at the full iteration budget; the probes are deliberately short.
   */
  async _longestOrbitHi(v, needBits, current, gen) {
    const ctx = await this._cameraCtx(needBits);
    if (gen !== this._gen) return null;
    const span = ctx.Float(spanToString(v.spanLog2));
    const cr = ctx.Float(v.centerRe);
    const ci = ctx.Float(v.centerIm);
    const th = v.rotation || 0;
    const cs = Math.cos(th), sn = Math.sin(th);
    const probeIter = Math.min(v.maxIter, 384);
    const grid = 7;
    let best = current.escape >= 0 ? current.escape : v.maxIter + 1000;
    let bestRe = v.centerRe, bestIm = v.centerIm;
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        /* Screen-space fractions -> plane fractions with the same rotation
         * matrix planeDelta() uses, so a rotated view scans its own frame. */
        const fx = (i + 0.5) / grid - 0.5;
        const fy = 0.5 - (j + 0.5) / grid;
        const u = fx * cs - fy * sn;
        const w = fx * sn + fy * cs;
        const re = cr.add(span.mul(u)).toString(10);
        const im = ci.add(span.mul(w)).toString(10);
        const probe = await this._probeOrbit(re, im, needBits, probeIter, gen);
        if (!probe || gen !== this._gen) return null;
        const score = probe.escape < 0 ? probeIter + 1000 : probe.escape;
        if (score > best) { best = score; bestRe = re; bestIm = im; }
      }
    }
    if (bestRe === v.centerRe && bestIm === v.centerIm) {
      return { orbit: current, best };
    }
    const orbit = await this._buildOrbit(bestRe, bestIm, needBits, gen);
    if (!orbit || gen !== this._gen) return null;
    return { orbit, best };
  }

  _uploadOrbit() {
    const o = this.orbit;
    /* Guard rather than throw: a frame that throws marks the whole backend
     * failed, and a failed backend used to keep claiming frames while drawing
     * nothing, freezing the page on a half-painted canvas. */
    if (!o || !o.points || !o.points.length || !(o.length > 0)) return false;
    const n = o.points.length;
    if (n * 4 > this.orbitBuf.size) {
      this.orbitBuf.destroy();
      this.orbitBuf = this.device.createBuffer({
        size: Math.ceil((n * 4) / 16) * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
    }
    this.device.queue.writeBuffer(this.orbitBuf, 0, o.points);
    /* The escaped sample itself is the only reference point available for the
     * iteration where the reference leaves the bailout, so it is uploaded too;
     * the shader stops there and finishes those pixels with plain float32. */
    this.orbitLen = o.length;

    const b = this.bla.data;
    const bytes = Math.max(32, b.byteLength);
    if (bytes > this.blaBuf.size) {
      this.blaBuf.destroy();
      this.blaBuf = this.device.createBuffer({
        size: Math.ceil(bytes / 16) * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
    }
    if (b.byteLength) this.device.queue.writeBuffer(this.blaBuf, 0, b);
    this.blaCount = this.bla.count;
    return true;
  }

  async _cameraCtx(bits) {
    if (this._camCtx && this._camBits === bits) return this._camCtx;
    this._camCtx?.destroy();
    const lib = await gmpLib();
    this._camCtx = lib.getContext({ precisionBits: bits });
    this._camBits = bits;
    return this._camCtx;
  }

  async _offsetPixels(orbit, bits) {
    if (
      orbit.centerRe === this.view.centerRe &&
      orbit.centerIm === this.view.centerIm
    ) {
      return { x: 0, y: 0 };
    }
    const ctx = await this._cameraCtx(bits);
    const span = ctx.Float(spanToString(this.view.spanLog2));
    const dre = ctx.Float(this.view.centerRe).sub(ctx.Float(orbit.centerRe));
    const dim = ctx.Float(this.view.centerIm).sub(ctx.Float(orbit.centerIm));
    /* Pixel offsets of the view centre relative to the reference centre.  The
     * shader maps the horizontal span across viewW pixels, so both axes divide
     * by the same pixel scale (span/viewW).  dOffset is added in *screen*
     * space before the shader rotates, so the plane delta has to be rotated
     * the other way here or a rotated view lands displaced. */
    const px = dre.div(span).mul(this.viewW).toNumber();
    const py = dim.div(span).mul(this.viewW).toNumber();
    const th = this.view.rotation || 0;
    const cs = Math.cos(th), sn = Math.sin(th);
    return { x: px * cs + py * sn, y: -px * sn + py * cs };
  }

  async renderProgressive(gen = this._gen) {
    /* Broad strides double as instant previews on large frames, but on a phone
     * buffer the first pass is already full resolution — repeating it three
     * times only burns GPU time. */
    const stride = this._bestStride();
    if (stride > 1) {
      if (!(await this.renderPass(stride, false, gen))) return false;
      if (gen !== this._gen) return false;
      const mid = Math.min(2, stride);
      if (mid > 1) {
        if (!(await this.renderPass(mid, false, gen))) return false;
        if (gen !== this._gen) return false;
      }
    }
    return await this.renderPass(1, true, gen);
  }

  _bestStride() {
    const px = this.viewW * this.viewH;
    if (px > 2.2e6) return 8;
    if (px > 0.8e6) return 4;
    return 1;
  }

  /**
   * Should this pass carry 48-bit pixel coordinates?
   *
   * Only the final pass of a frame whose per-pixel scale is below 2^-DD_LOG2.
   * The error the extra limb removes is the *phase* error of the escape: each
   * step multiplies delta's 24-bit relative error by |2Z|, so after a thousand
   * steps the smooth count is off by a tenth of a colour band.  Above 2^-14
   * that is below a percent of a band and invisible; below it, it is the
   * mottled "rotten pixel" look.  Previews never pay for it, so a gesture
   * still answers in one cheap dispatch.
   *
   * Folded families stay in float32: their step is an exact-difference form
   * over |z| and sign flips, which has no double-float transcription yet.
   */
  _wantDD(stride) {
    if (this._noDD) return false;
    /* The limb kernel runs on the final full-resolution pass only. */
    if (stride !== 1) return false;
    const v = this.view;
    if (familyIndex(v.kind) !== 0) return false;
    if ((v.power | 0 || 2) !== 2) return false;
    /* Perturbation assumes |delta| << |Z|.  On a whole-set frame the pixel
     * offset is the same order as the reference, and only the float32 kernel
     * has the rebase logic that repairs it; the limb kernel has none.  A
     * measurement override may widen the depth threshold but may not switch
     * that physics off — forcing it on span=3.2 produced a 593-iteration
     * error that looked like a precision bug and was a misuse of the kernel. */
    if (this._pixelLog2() > -18) return false;
    if (this.ddForce != null) return !!this.ddForce;
    return true;
  }

  _pixelLog2() {
    return this.view.spanLog2 - Math.log2(this.viewW);
  }

  _uniformData(stride, fw, fh) {
    const v = this.view;
    const buf = new ArrayBuffer(96);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = this.viewW;
    u[1] = this.viewH;
    u[2] = v.maxIter;
    u[3] = this.orbitLen;
    u[4] = stride;
    u[5] = this.blaCount;
    /* bit0 BLA, bit1 Julia (dc is zero there, δ starts at the pixel offset),
     * bit3 double-float pixels.  The last one is only worth its ~10x
     * arithmetic on the final pass of a frame deep enough for float32's
     * accumulated phase error to show up as colour mottling. */
    const dd = this._wantDD(stride);
    this._lastKernel = dd ? 'df32' : 'f32';
    u[6] = (v.useBla ? 1 : 0) | (v.mode === 1 ? 2 : 0) | (dd ? 8 : 0);
    u[7] = v.power | 0 || 2;
    const scaleLog2 = v.spanLog2 - Math.log2(this.viewW);
    const se = Math.floor(scaleLog2);
    const mant = Math.pow(2, scaleLog2 - se);
    const mantHi = Math.fround(mant);
    f[8] = mantHi;
    u[9] = se;
    f[10] = this.orbitOffset?.x || 0;
    f[11] = this.orbitOffset?.y || 0;
    f[12] = 1e20;
    f[13] = v.palette.freq;
    f[14] = v.palette.phase;
    f[15] = v.palette.offset;
    f[16] = Number(v.juliaRe) || 0;
    f[17] = Number(v.juliaIm) || 0;
    f[18] = v.phoenixP != null ? v.phoenixP : 0.5667;
    f[19] = Math.cos(v.rotation || 0);
    f[20] = Math.sin(v.rotation || 0);
    u[21] = familyIndex(v.kind);
    /* The pixel scale with two limbs: a single float32 mantissa would put a
     * 1e-7 relative error straight onto dc, i.e. onto the seed of every
     * pixel's recurrence, where nothing downstream can average it out. */
    f[22] = Math.fround(mant - mantHi);

    const sbuf = new ArrayBuffer(64);
    const su = new Uint32Array(sbuf);
    const sf = new Float32Array(sbuf);
    sf[0] = fw;
    sf[1] = fh;
    sf[2] = this.viewW;
    sf[3] = this.viewH;
    su[4] = v.shadeMode;
    sf[5] = v.palette.freq;
    sf[6] = v.palette.phase;
    sf[7] = v.palette.offset;
    sf[8] = v.palette.exposure;
    su[9] = v.shadeMode === 3 ? 1 : 0;
    sf[10] = v.cycle || 140;
    return { compute: buf, shade: sbuf };
  }

  async renderPass(stride, readStats = true, gen = this._gen) {
    if (this._disposed || !this.orbit || gen !== this._gen) return false;
    this.resize();
    const fw = Math.ceil(this.viewW / stride);
    const fh = Math.ceil(this.viewH / stride);
    const field = this._fieldTexture(fw, fh);
    this._lastField = field;
    this._lastFw = fw;
    this._lastFh = fh;
    this._lastStride = stride;
    const { compute, shade } = this._uniformData(stride, fw, fh);
    this.device.queue.writeBuffer(this.computeParams, 0, compute);
    this.device.queue.writeBuffer(this.shadeParams, 0, shade);
    this.device.queue.writeBuffer(
      this.counterBuf,
      0,
      new Uint32Array([0, 0, 0, 0, 0xffffffff, 0, 0, 0])
    );

    const computeBG = this.device.createBindGroup({
      layout: this.computeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.computeParams } },
        { binding: 1, resource: { buffer: this.orbitBuf } },
        { binding: 2, resource: { buffer: this.blaBuf } },
        { binding: 3, resource: field.createView() },
        { binding: 4, resource: { buffer: this.counterBuf } }
      ]
    });
    const shadeBG = this.device.createBindGroup({
      layout: this.shadeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.shadeParams } },
        { binding: 1, resource: field.createView() },
        { binding: 2, resource: this.paletteTex.createView() }
      ]
    });
    const presentBG = this.device.createBindGroup({
      layout: this.presentBGL,
      entries: [{ binding: 0, resource: this._shadeTarget.createView() }]
    });

    const enc = this.device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(this.computePipeline);
    cp.setBindGroup(0, computeBG);
    cp.dispatchWorkgroups(Math.ceil(fw / WG), Math.ceil(fh / WG));
    cp.end();

    const sp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this._shadeTarget.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }
      ]
    });
    sp.setPipeline(this.shadePipeline);
    sp.setBindGroup(0, shadeBG);
    sp.draw(3);
    sp.end();

    const pp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }
      ]
    });
    pp.setPipeline(this.presentPipeline);
    pp.setBindGroup(0, presentBG);
    pp.draw(3);
    pp.end();

    const t0 = performance.now();
    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    if (gen !== this._gen) return false;
    const frameMs = performance.now() - t0;
    /* Counter readback maps a staging buffer, which is far more expensive than
     * the draw itself — only the final pass needs the glitch statistics. */
    if (readStats) {
      if (!(await this._readCounters(frameMs, gen))) return false;
    }
    return true;
  }

  /**
   * Repaint the current field with the current `view.cycle`.
   *
   * The palette index is a pure function of the smooth iteration stored in the
   * field texture, so changing the band count never needs another iteration
   * pass.  This is what lets the caller fix the colouring *after* the frame
   * reports how much escape range it actually contains.
   */
  _reshade() {
    if (this._disposed || !this._lastField || !this._shadeTarget) return;
    const fw = this._lastFw;
    const fh = this._lastFh;
    const shade = this._uniformData(this._lastStride || 1, fw, fh).shade;
    this.device.queue.writeBuffer(this.shadeParams, 0, shade);
    const shadeBG = this.device.createBindGroup({
      layout: this.shadeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.shadeParams } },
        { binding: 1, resource: this._lastField.createView() },
        { binding: 2, resource: this.paletteTex.createView() }
      ]
    });
    const presentBG = this.device.createBindGroup({
      layout: this.presentBGL,
      entries: [{ binding: 0, resource: this._shadeTarget.createView() }]
    });
    const enc = this.device.createCommandEncoder();
    const sp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this._shadeTarget.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }
      ]
    });
    sp.setPipeline(this.shadePipeline);
    sp.setBindGroup(0, shadeBG);
    sp.draw(3);
    sp.end();
    const pp = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 }
        }
      ]
    });
    pp.setPipeline(this.presentPipeline);
    pp.setBindGroup(0, presentBG);
    pp.draw(3);
    pp.end();
    this.device.queue.submit([enc.finish()]);
  }

  /* Diagnostic readback of the float field (used by the deep-zoom checks). */
  async readFieldSamples(points) {
    const fw = this._lastFw;
    const fh = this._lastFh;
    const bpr = Math.ceil((fw * 16) / 256) * 256;
    const buf = this.device.createBuffer({
      size: bpr * fh,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this._lastField },
      { buffer: buf, bytesPerRow: bpr },
      { width: fw, height: fh }
    );
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(buf.getMappedRange().slice(0));
    buf.unmap();
    buf.destroy();
    return points.map(([x, y]) => {
      const o = y * (bpr / 4) + x * 4;
      return { x, y, smooth: data[o], dist: data[o + 1], iter: data[o + 2], status: data[o + 3] };
    });
  }

  async _readCounters(frameMs, gen = this._gen) {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.counterBuf, 0, this.stagingBuf, 0, 24);
    this.device.queue.submit([enc.finish()]);
    await this.stagingBuf.mapAsync(GPUMapMode.READ);
    if (gen !== this._gen) {
      this.stagingBuf.unmap();
      return false;
    }
    const copy = this.stagingBuf.getMappedRange().slice(0);
    this.stagingBuf.unmap();
    const c = new Uint32Array(copy);
    const total = c[1] || 0;
    const glitchRatio = total ? c[0] / total : 0;
    /* Escape range in smooth iterations, back out of the 1/8 fixed point the
     * kernel stores.  When nothing escaped, both stay at their sentinels and
     * the caller must treat the range as absent, not as zero. */
    const escMin = c[4] === 0xffffffff ? -1 : c[4] / 8;
    const escMax = c[4] === 0xffffffff ? -1 : c[5] / 8;
    this.stats = {
      glitches: c[0],
      total,
      escaped: c[2],
      interior: c[3],
      glitchRatio,
      escMin,
      escMax,
      frameMs
    };
    /* Re-shade once with a band count derived from the range this frame
     * actually contains.  The field is already on the GPU, so this is one
     * full-screen pass (~1 ms), not another 45 G-step render.  It has to run
     * before the status is emitted so the page records the divisor that is
     * really on screen. */
    if (escMax > escMin && this._cycleBands) {
      const want = Math.max(2, (escMax - escMin) / this._cycleBands);
      const have = this.view.cycle || 0;
      if (Math.abs(want - have) > have * 0.25) {
        this.view.cycle = want;
        this._reshade();
      }
    }
    this._emitStatus({ phase: 'frame' });

    /* A single glitched pixel is a black speck on a smooth field, and a row of
     * them is a visible contour.  The 1 % threshold here was far too coarse:
     * the measured glitch rate on a boundary view is ~0.1 %, so the repair
     * never ran and the specks stayed.  Repair costs one probe set plus one
     * re-render, and is capped by _nudge so a view that cannot be repaired
     * does not loop. */
    if (glitchRatio > 1e-4 && !this._reselecting && this._nudge < 3 &&
        this.orbit && this.orbit.escape >= 0) {
      /* Only an escaping reference can be improved: if the reference is itself
       * bounded, probes cannot outlive it and a new anchor would only add cost. */
      this._reselecting = true;
      try {
        if (!(await this._reselectReference(gen))) return false;
      } finally {
        this._reselecting = false;
      }
    }
    /* Glitched pixels are the one thing this kernel cannot paint honestly.
     *
     * A glitch is a pixel whose orbit was continued from a partly cancelled
     * value after the reference escaped; it is 1-3 px wide, flagged
     * `status=3`, and the shade pass draws it near-black.  A row of them reads
     * as a thin black contour across the frame -- the "discrete" report.
     * Re-picking the reference fixes some views and cannot fix others, so once
     * the repair budget is spent the frame is *declined* instead: the page
     * falls back to the CPU core, which renders the same view cleanly (measured
     * 4 % glitched pixels on the GPU, 0 on the CPU, 141 ms vs 404 ms).  A
     * slightly slower correct frame beats a fast wrong one. */
    if (glitchRatio > 2e-4 && this._nudge >= 3) {
      this.declined = {
        reason: 'glitch',
        rate: glitchRatio,
        refLen: this.orbit ? this.orbit.escape : -1,
        maxIter: this.view.maxIter
      };
      return false;
    }
    return true;
  }

  async _reselectReference(gen) {
    /* Probe several anchors with a short orbit and keep the longest-lived
     * one.  A blind nudge can land outside the set and make glitches worse,
     * so the view centre is a candidate too; if it wins the reference is kept
     * and only the retry counter advances. */
    const ctx = await this._cameraCtx(this.needBits);
    if (gen !== this._gen) return false;
    const span = ctx.Float(spanToString(this.view.spanLog2));
    /* Probe with the frame's own budget, not 512 steps.
     *
     * 512 was a leftover from the era when this only had to break a tie
     * between points that all escape early.  At a boundary view every
     * candidate survives 512 steps, so the scores tied, the centre always won,
     * and the reference kept escaping at ~4 400 -- which is what produces the
     * glitch pixels: past the reference's escape the pixel is continued
     * directly from a partly cancelled value.  Those pixels are 1-3 px wide,
     * are flagged `status=3`, and the shade pass paints them near-black: the
     * thin contour lines read as "discrete".  Scoring on the real budget lets
     * the longest-lived candidate win instead. */
    const limit = Math.min(8192, this.view.maxIter);
    const dirs = [
      [0, 0],
      [0.31, 0.17],
      [-0.29, 0.23],
      [0.13, -0.33],
      [-0.17, -0.27]
    ];
    /* The probes have to walk the *same* family as the frame, and the family
     * tag used to be missing here: every probe on a tricorn or a phoenix view
     * was scored as if it were z^2, so the winner was a point that survives
     * for the wrong map. */
    const probeArgs = {
      maxIter: limit,
      precisionBits: this.needBits,
      mode: this.view.mode,
      juliaRe: this.view.juliaRe,
      juliaIm: this.view.juliaIm,
      power: this.view.power,
      kind: this.view.kind,
      phoenixP: this.view.phoenixP
    };
    let best = null;
    for (const [dx, dy] of dirs) {
      const re = ctx.Float(this.view.centerRe).add(span.mul(dx));
      const im = ctx.Float(this.view.centerIm).add(span.mul(dy));
      const probe = await buildReferenceOrbit({
        ...probeArgs,
        centerRe: re.toString(10),
        centerIm: im.toString(10)
      });
      if (gen !== this._gen) return false;
      if (!probe) continue;
      const score = probe.escape < 0 ? limit + 1000 : probe.escape;
      if (!best || score > best.score) {
        best = { score, re: re.toString(10), im: im.toString(10), dx, dy };
      }
    }
    /* Only adopt a winner that outlives the reference we already have.
     *
     * Without this check the repair could trade a long orbit for a short one:
     * measured on a boundary view whose centre escapes at 4 400, the probe
     * grid returned a candidate that escapes at 166, the renderer adopted it,
     * and the glitch rate jumped from 0.1 % to 4.7 % -- a handful of thin
     * specks became a field of black contour lines.  Moving the reference is
     * only worth its cost when it strictly improves the situation. */
    const cur = this.orbit && this.orbit.escape >= 0 ? this.orbit.escape : limit + 1000;
    if (!best || best.score <= cur) {
      this._nudge++;
      return true;
    }

    const orbit = await buildReferenceOrbit({
      ...probeArgs,
      maxIter: this.view.maxIter,
      centerRe: best.re,
      centerIm: best.im
    });
    if (!orbit || gen !== this._gen) return false;
    orbit.maxIter = this.view.maxIter;
    orbit.mode = this.view.mode;
    orbit.power = this.view.power;
    orbit.kind = familyIndex(this.view.kind);
    orbit.juliaRe = this.view.juliaRe;
    orbit.juliaIm = this.view.juliaIm;
    orbit.centerRe = best.re;
    orbit.centerIm = best.im;
    this.orbit = orbit;
    const blaOk = isPolynomialFamily(this.view.kind) && (this.view.power | 0 || 2) === 2;
    this.bla = blaOk ? buildBla(orbit.points, orbit.length)
                     : { data: new Float32Array(0), count: 0 };
    if (!this._uploadOrbit()) { this.orbit = null; return false; }
    this.orbitOffset = await this._offsetPixels(orbit, this.needBits);
    if (gen !== this._gen) return false;
    return await this.renderPass(1, false, gen);
  }

  _emitStatus(extra = {}) {
    const v = this.view;
    const s = this.stats || {};
    this.status = {
      seq: ++this._seq,
      depth: depthText(v.spanLog2),
      bits: this.orbit?.bits || 0,
      digits: this.orbit ? bitsToDigits(this.orbit.bits) : 0,
      marginBits:
        this.orbit && this.physicalNeed
          ? this.orbit.bits - this.physicalNeed
          : 0,
      refLen: this.orbit?.length || 0,
      escape: this.orbit?.escape ?? -1,
      orbitMs: this.orbit?.ms || 0,
      frameMs: s.frameMs || 0,
      glitchRatio: s.glitchRatio || 0,
      total: s.total || 0,
      /* The range the frame really contains, in smooth iterations.  The page
       * uses it for the band count and for its "no detail" / "interior"
       * verdicts, both of which were previously guessed from maxIter. */
      escMin: s.escMin == null ? -1 : s.escMin,
      escMax: s.escMax == null ? -1 : s.escMax,
      cycle: v.cycle || 0,
      maxIter: v.maxIter | 0,
      bla: v.useBla ? this.blaCount : 0,
      width: this.viewW,
      height: this.viewH,
      format: 'rgb10a2unorm -> ' + this.presentFormat,
      /* Which pixel kernel the last pass ran: 'f32' or 'df32' (two limbs).
       * Measurement hook — the A/B run tells the two apart by this. */
      pixelKernel: this._lastKernel || 'f32',
      ...extra
    };
    this.onStatus(this.status);
  }

  async pan(dxPix, dyPix) {
    await this.gesture(0, 0, dxPix, dyPix, 1);
  }

  async zoomAt(px, py, factor) {
    await this.gesture(px, py, px, py, factor);
  }

  /**
   * Commit one screen-space gesture in a single refresh.
   *
   * The world point that sat under (px0, py0) is re-anchored under (px1, py1)
   * after the span is divided by `factor`.  That models a one-finger pan
   * (factor 1), a wheel/pinch zoom (matching points) and a combined pinch
   * (moving midpoint + scale) with the same maths.
   */
  async gesture(px0, py0, px1, py1, factor) {
    const ctx = await this._cameraCtx(this.needBits || 1024);
    const span = ctx.Float(spanToString(this.view.spanLog2));
    const w = ctx.Float(this.viewW);
    const h = ctx.Float(this.viewH);
    const ox0 = ctx.Float(px0).div(w).sub(0.5);
    const oy0 = ctx.Float(0.5).sub(ctx.Float(py0).div(h));
    const wx = ctx.Float(this.view.centerRe).add(span.mul(ox0));
    const wy = ctx.Float(this.view.centerIm).add(span.mul(oy0));
    const span2 = span.div(factor);
    const ox1 = ctx.Float(px1).div(w).sub(0.5);
    const oy1 = ctx.Float(0.5).sub(ctx.Float(py1).div(h));
    this.view.centerRe = wx.sub(span2.mul(ox1)).toString(10);
    this.view.centerIm = wy.sub(span2.mul(oy1)).toString(10);
    this.view.spanLog2 -= Math.log2(factor);
    this._nudge = 0;
    await this._refresh();
  }

  async _refresh() {
    return await this.setView(this.view);
  }

  dispose() {
    this._disposed = true;
    this._gen++;
    this._camCtx?.destroy();
    this._camCtx = null;
    this.paletteTex?.destroy();
    for (const t of this._fieldCache.values()) t.destroy();
    this._fieldCache.clear();
    this._shadeTarget?.destroy();
    this.orbitBuf?.destroy();
    this.blaBuf?.destroy();
    this.counterBuf?.destroy();
    this.stagingBuf?.destroy();
    this.computeParams?.destroy();
    this.shadeParams?.destroy();
    this.device?.destroy?.();
  }
}

