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

import { COMPUTE_WGSL, SHADE_WGSL, PRESENT_WGSL } from './wgsl.js';
import {
  buildReferenceOrbit,
  buildBla,
  precisionForSpan,
  physicalBits,
  bitsToDigits,
  OrbitCache,
  gmpLib
} from './ref-orbit.js';

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

    this.computeModule = await this._compile(COMPUTE_WGSL, 'compute');
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
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.shadeParams = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.counterBuf = device.createBuffer({
      size: 16,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    });
    this.stagingBuf = device.createBuffer({
      size: 16,
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

    this.resize();
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.viewW && h === this.viewH && this._shadeTarget) return;
    this.viewW = w;
    this.viewH = h;
    this.canvas.width = w;
    this.canvas.height = h;
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
    this.view = {
      maxIter: 2000,
      mode: 0,
      juliaRe: '0',
      juliaIm: '0',
      power: 2,
      useBla: true,
      shadeMode: 0,
      palette: { freq: 0.12, phase: 0.0, offset: 0.0, exposure: 1.0 },
      safety: 3,
      ...view
    };
    this.resize();
    await this._prepareOrbit();
    await this.renderProgressive();
    this._emitStatus({ phase: 'ready' });
  }

  async _prepareOrbit() {
    const v = this.view;
    const needBits = precisionForSpan(v.spanLog2, v.maxIter, v.safety);
    let reuse = !!this.orbit &&
      this.orbit.bits >= needBits &&
      this.orbit.maxIter >= v.maxIter &&
      this.orbit.mode === v.mode &&
      this.orbit.power === v.power &&
      this.orbit.juliaRe === v.juliaRe &&
      this.orbit.juliaIm === v.juliaIm;

    let off = { x: 0, y: 0 };
    if (reuse) {
      off = await this._offsetPixels(this.orbit, needBits);
      if (
        Math.abs(off.x) > this.viewW * 0.75 ||
        Math.abs(off.y) > this.viewH * 0.75
      ) {
        reuse = false;
      }
    }

    if (!reuse) {
      this.onStatus({ phase: 'orbit', depth: depthText(v.spanLog2) });
      await new Promise((r) => setTimeout(r, 0));
      const orbit = await buildReferenceOrbit({
        centerRe: v.centerRe,
        centerIm: v.centerIm,
        maxIter: v.maxIter,
        precisionBits: needBits,
        mode: v.mode,
        juliaRe: v.juliaRe,
        juliaIm: v.juliaIm,
        power: v.power
      });
      orbit.maxIter = v.maxIter;
      orbit.mode = v.mode;
      orbit.power = v.power;
      orbit.juliaRe = v.juliaRe;
      orbit.juliaIm = v.juliaIm;
      orbit.centerRe = v.centerRe;
      orbit.centerIm = v.centerIm;
      this.orbit = orbit;
      this.bla = buildBla(orbit.points, orbit.length);
      this._uploadOrbit();
      off = { x: 0, y: 0 };
      this._nudge = 0;
    }
    this.orbitOffset = off;
    this.needBits = needBits;
    this.physicalNeed = physicalBits(v.spanLog2, v.maxIter);
  }

  _uploadOrbit() {
    const o = this.orbit;
    const n = o.points.length;
    if (n * 4 > this.orbitBuf.size) {
      this.orbitBuf.destroy();
      this.orbitBuf = this.device.createBuffer({
        size: Math.ceil((n * 4) / 16) * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
    }
    this.device.queue.writeBuffer(this.orbitBuf, 0, o.points);
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
    return {
      x: dre.div(span).mul(this.viewW).toNumber(),
      y: dim.div(span).mul(-this.viewH).toNumber()
    };
  }

  async renderProgressive() {
    await this.renderPass(Math.min(8, this._bestStride()));
    await this.renderPass(Math.min(2, this._bestStride()));
    await this.renderPass(1);
  }

  _bestStride() {
    const px = this.viewW * this.viewH;
    if (px > 2.2e6) return 8;
    if (px > 0.8e6) return 4;
    return 1;
  }

  _uniformData(stride, fw, fh) {
    const v = this.view;
    const buf = new ArrayBuffer(64);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    u[0] = this.viewW;
    u[1] = this.viewH;
    u[2] = v.maxIter;
    u[3] = this.orbitLen;
    u[4] = stride;
    u[5] = this.blaCount;
    u[6] = v.useBla ? 1 : 0;
    const scaleLog2 = v.spanLog2 - Math.log2(this.viewW);
    const se = Math.floor(scaleLog2);
    f[8] = Math.pow(2, scaleLog2 - se);
    u[9] = se;
    f[10] = this.orbitOffset?.x || 0;
    f[11] = this.orbitOffset?.y || 0;
    f[12] = 65536;
    f[13] = v.palette.freq;
    f[14] = v.palette.phase;
    f[15] = v.palette.offset;

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
    return { compute: buf, shade: sbuf };
  }

  async renderPass(stride) {
    if (this._disposed || !this.orbit) return;
    this.resize();
    const fw = Math.ceil(this.viewW / stride);
    const fh = Math.ceil(this.viewH / stride);
    const field = this._fieldTexture(fw, fh);
    this._lastField = field;
    this._lastFw = fw;
    this._lastFh = fh;
    const { compute, shade } = this._uniformData(stride, fw, fh);
    this.device.queue.writeBuffer(this.computeParams, 0, compute);
    this.device.queue.writeBuffer(this.shadeParams, 0, shade);
    this.device.queue.writeBuffer(this.counterBuf, 0, new Uint32Array(4));

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
        { binding: 1, resource: field.createView() }
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
    const frameMs = performance.now() - t0;
    await this._readCounters(frameMs);
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

  async _readCounters(frameMs) {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.counterBuf, 0, this.stagingBuf, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await this.stagingBuf.mapAsync(GPUMapMode.READ);
    const copy = this.stagingBuf.getMappedRange().slice(0);
    this.stagingBuf.unmap();
    const c = new Uint32Array(copy);
    const total = c[1] || 0;
    const glitchRatio = total ? c[0] / total : 0;
    this.stats = {
      glitches: c[0],
      total,
      escaped: c[2],
      interior: c[3],
      glitchRatio,
      frameMs
    };
    this._emitStatus({ phase: 'frame' });

    if (glitchRatio > 0.01 && !this._reselecting && this._nudge < 2 &&
        this.orbit && this.orbit.escape >= 0) {
      /* Only an escaping reference can be improved: if the reference is itself
       * bounded, probes cannot outlive it and a new anchor would only add cost. */
      this._reselecting = true;
      try {
        await this._reselectReference();
      } finally {
        this._reselecting = false;
      }
    }
  }

  async _reselectReference() {
    /* Probe several anchors with a short orbit and keep the longest-lived
     * one.  A blind nudge can land outside the set and make glitches worse,
     * so the view centre is a candidate too; if it wins the reference is kept
     * and only the retry counter advances. */
    const ctx = await this._cameraCtx(this.needBits);
    const span = ctx.Float(spanToString(this.view.spanLog2));
    const dirs = [
      [0, 0],
      [0.31, 0.17],
      [-0.29, 0.23],
      [0.13, -0.33]
    ];
    const limit = Math.min(512, this.view.maxIter);
    let best = null;
    for (const [dx, dy] of dirs) {
      const re = ctx.Float(this.view.centerRe).add(span.mul(dx));
      const im = ctx.Float(this.view.centerIm).add(span.mul(dy));
      const probe = await buildReferenceOrbit({
        centerRe: re.toString(10),
        centerIm: im.toString(10),
        maxIter: limit,
        precisionBits: this.needBits,
        mode: this.view.mode,
        juliaRe: this.view.juliaRe,
        juliaIm: this.view.juliaIm,
        power: this.view.power
      });
      const score = probe.escape < 0 ? limit + 1000 : probe.escape;
      if (!best || score > best.score) {
        best = { score, re: re.toString(10), im: im.toString(10), dx, dy };
      }
    }
    this._nudge++;
    if (best.dx === 0 && best.dy === 0) return;

    const orbit = await buildReferenceOrbit({
      centerRe: best.re,
      centerIm: best.im,
      maxIter: this.view.maxIter,
      precisionBits: this.needBits,
      mode: this.view.mode,
      juliaRe: this.view.juliaRe,
      juliaIm: this.view.juliaIm,
      power: this.view.power
    });
    orbit.maxIter = this.view.maxIter;
    orbit.mode = this.view.mode;
    orbit.power = this.view.power;
    orbit.juliaRe = this.view.juliaRe;
    orbit.juliaIm = this.view.juliaIm;
    orbit.centerRe = best.re;
    orbit.centerIm = best.im;
    this.orbit = orbit;
    this.bla = buildBla(orbit.points, orbit.length);
    this._uploadOrbit();
    this.orbitOffset = await this._offsetPixels(orbit, this.needBits);
    await this.renderPass(1);
  }

  _emitStatus(extra = {}) {
    const v = this.view;
    const s = this.stats || {};
    this.onStatus({
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
      bla: v.useBla ? this.blaCount : 0,
      width: this.viewW,
      height: this.viewH,
      format: 'rgb10a2unorm -> ' + this.presentFormat,
      ...extra
    });
  }

  async pan(dxPix, dyPix) {
    const ctx = await this._cameraCtx(this.needBits || 1024);
    const span = ctx.Float(spanToString(this.view.spanLog2));
    const w = ctx.Float(this.viewW);
    const re = ctx.Float(this.view.centerRe).add(span.mul(dxPix).div(w));
    const im = ctx.Float(this.view.centerIm).sub(span.mul(dyPix).div(w));
    this.view.centerRe = re.toString(10);
    this.view.centerIm = im.toString(10);
    await this._refresh();
  }

  async zoomAt(px, py, factor) {
    const ctx = await this._cameraCtx(this.needBits || 1024);
    const span = ctx.Float(spanToString(this.view.spanLog2));
    const w = ctx.Float(this.viewW);
    const h = ctx.Float(this.viewH);
    const ox = ctx.Float(px).div(w).sub(0.5);
    const oy = ctx.Float(0.5).sub(ctx.Float(py).div(h));
    const wx = ctx.Float(this.view.centerRe).add(span.mul(ox));
    const wy = ctx.Float(this.view.centerIm).add(span.mul(oy));
    const span2 = span.div(factor);
    const re = wx.sub(span2.mul(ox));
    const im = wy.sub(span2.mul(oy));
    this.view.centerRe = re.toString(10);
    this.view.centerIm = im.toString(10);
    this.view.spanLog2 -= Math.log2(factor);
    this._nudge = 0;
    await this._refresh();
  }

  async _refresh() {
    await this._prepareOrbit();
    await this.renderProgressive();
    this._emitStatus({ phase: 'ready' });
  }

  dispose() {
    this._disposed = true;
    this._camCtx?.destroy();
    this._camCtx = null;
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

