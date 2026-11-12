/* ------------------------------------------------------------------
 * wgsl.js — the WebGPU compute + shading kernels for the deep-zoom page.
 *
 * Pixel iteration is done by WGSL only (no JS/Wasm per-pixel work).  The
 * reference orbit comes from gmp-wasm/MPFR (see ref-orbit.js); the shader
 * iterates the perturbation δ with a shared extra exponent so δ can start at
 * 2^-10000 without underflowing float32.
 *
 * Field channels:  r = smooth iteration, g = distance estimate in pixels,
 *                  b = iterations used,        a = status bits
 * status: bit0 glitch, bit1 interior, bit2 BLA skip used.
 * ------------------------------------------------------------------ */

export const COMPUTE_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  maxIter: u32,
  refLen: u32,
  stride: u32,
  blockCount: u32,
  flags: u32,
  _p0: u32,
  scaleMant: f32,
  scaleExp: i32,
  dcOffX: f32,
  dcOffY: f32,
  bailout2: f32,
  paletteFreq: f32,
  palettePhase: f32,
  paletteOffset: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> refOrbit: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> blaBlocks: array<vec4<f32>>;
@group(0) @binding(3) var fieldTex: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn norm2(v: vec2<f32>) -> f32 {
  return v.x * v.x + v.y * v.y;
}

fn refAt(n: u32) -> vec2<f32> {
  let r = refOrbit[n];
  return vec2<f32>(r.x + r.y, r.z + r.w);
}

/* Keep the shared exponent in a range where the float32 mantissas are
 * accurate.  Both δ and the constant pixel offset dc are rescaled together;
 * dc is δ at n=0, so it must follow every exponent change. */
fn renorm(d: ptr<function, vec2<f32>>, dc: ptr<function, vec2<f32>>,
          de: ptr<function, i32>) {
  for (var i = 0; i < 6; i = i + 1) {
    let m = max(abs((*d).x), abs((*d).y));
    if (m > 65536.0) {
      (*d).x = (*d).x * 1.52587890625e-5;
      (*d).y = (*d).y * 1.52587890625e-5;
      (*dc).x = (*dc).x * 1.52587890625e-5;
      (*dc).y = (*dc).y * 1.52587890625e-5;
      (*de) = (*de) + 16;
    } else if (m < 1.52587890625e-5 && m > 0.0) {
      (*d).x = (*d).x * 65536.0;
      (*d).y = (*d).y * 65536.0;
      (*dc).x = (*dc).x * 65536.0;
      (*dc).y = (*dc).y * 65536.0;
      (*de) = (*de) - 16;
    } else {
      break;
    }
  }
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let px = gid.x;
  let py = gid.y;
  if (px >= (P.width + P.stride - 1u) / P.stride ||
      py >= (P.height + P.stride - 1u) / P.stride) {
    return;
  }

  let stride = f32(P.stride);
  let offX = (f32(px) + 0.5) * stride - 0.5 * f32(P.width) + P.dcOffX;
  let offY = 0.5 * f32(P.height) - ((f32(py) + 0.5) * stride) + P.dcOffY;

  var d = vec2<f32>(offX * P.scaleMant, offY * P.scaleMant);
  var dc = d;
  var de = P.scaleExp;
  renorm(&d, &dc, &de);

  var n = 0u;
  var bi = 0u;
  var status = 0u;
  var escaped = false;
  var smoothVal = f32(P.maxIter);
  var dist = 1.0e7;
  var m2 = 0.0;
  var used = 0u;

  loop {
    if (n >= P.maxIter || n >= P.refLen) {
      break;
    }

    /* Bilinear approximation: in the linear regime the 64-step block is a
     * complex affine map δ' = A δ + B dc.  A and B are stored normalised with
     * their own powers of two.  Skipping is only legal while |δ| is tiny. */
    if ((P.flags & 1u) != 0u && bi < P.blockCount && de < -55) {
      let b0 = blaBlocks[bi * 2u];
      let b1 = blaBlocks[bi * 2u + 1u];
      let start = u32(b0.z);
      if (n == start) {
        let blen = u32(b0.w);
        let ea = i32(b1.z);
        let eb = i32(b1.w);
        if (blen > 0u && ea > -100 && ea < 100 && eb > -100 && eb < 100) {
          let A = vec2<f32>(b0.x, b0.y);
          let B = vec2<f32>(b1.x, b1.y);
          let nd = cmul(A, d) * exp2(f32(ea)) +
                   cmul(B, dc) * exp2(f32(eb));
          d = nd;
          renorm(&d, &dc, &de);
          n = n + blen;
          used = n;
          bi = bi + 1u;
          status = status | 4u;
          continue;
        }
      }
      if (n > start) {
        bi = bi + 1u;
      }
    }

    let Z = refAt(n);

    /* The reference itself left the bailout: every pixel here is a glitch —
     * the reference point must be reselected. */
    if (norm2(Z) > P.bailout2) {
      status = status | 1u;
      atomicAdd(&counters[0], 1u);
      break;
    }

    let s = exp2(f32(de));
    var quad = 0.0;
    if (de > -40) {
      quad = s;
    }
    let nx = 2.0 * (Z.x * d.x - Z.y * d.y) +
             quad * (d.x * d.x - d.y * d.y) + dc.x;
    let ny = 2.0 * (Z.x * d.y + Z.y * d.x) +
             quad * (2.0 * d.x * d.y) + dc.y;
    d = vec2<f32>(nx, ny);
    renorm(&d, &dc, &de);
    n = n + 1u;
    used = n;

    let zx = Z.x + d.x * exp2(f32(de));
    let zy = Z.y + d.y * exp2(f32(de));
    m2 = zx * zx + zy * zy;

    if (m2 > P.bailout2) {
      escaped = true;
      break;
    }

    /* Glitch: the total point is much smaller than the perturbation, i.e. the
     * reference and the pixel cancelled and float32 δ is no longer resolving
     * the orbit.  Record it per pixel instead of recolouring the whole frame. */
    if (n > 0u && de > -55) {
      let dm2 = norm2(d) * exp2(f32(2 * de));
      if (m2 < dm2 * 0.0625) {
        status = status | 1u;
        atomicAdd(&counters[0], 1u);
        break;
      }
    }
  }

  if (escaped) {
    let l2 = log2(max(m2, 4.0));
    smoothVal = f32(n) - log2(max(l2, 1.0));
    let dn = sqrt(norm2(d)) * exp2(f32(de));
    if (dn > 1.0e-30) {
      dist = 0.5 * sqrt(m2) * log(max(m2, 2.0)) / dn;
    }
  } else {
    status = status | 2u;
    smoothVal = f32(P.maxIter);
    dist = 1.0e7;
  }

  textureStore(fieldTex, vec2<i32>(i32(px), i32(py)),
               vec4<f32>(smoothVal, dist, f32(used), f32(status)));
  atomicAdd(&counters[1], 1u);
  if (escaped) {
    atomicAdd(&counters[2], 1u);
  } else {
    atomicAdd(&counters[3], 1u);
  }
}
`;

/* Shade the float field into the 10-bit target. */
export const SHADE_WGSL = /* wgsl */ `
struct Shade {
  srcW: f32,
  srcH: f32,
  dstW: f32,
  dstH: f32,
  mode: u32,
  freq: f32,
  phase: f32,
  offset: f32,
  exposure: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};

@group(0) @binding(0) var<uniform> S: Shade;
@group(0) @binding(1) var fieldTex: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(frag.x / S.dstW, frag.y / S.dstH);
  let src = vec2<i32>(
    clamp(i32(uv.x * S.srcW), 0, i32(S.srcW) - 1),
    clamp(i32(uv.y * S.srcH), 0, i32(S.srcH) - 1)
  );
  let f = textureLoad(fieldTex, src, 0);
  let status = u32(f.w);
  let interior = (status & 2u) != 0u;

  var rgb = vec3<f32>(0.5) + 0.5 * cos(
    6.28318530718 * (f.x * S.freq + S.phase +
    vec3<f32>(0.0, 0.33, 0.67)) + S.offset);

  if (S.mode == 1u) {
    let d = clamp(log2(max(f.y, 1.0)) / 6.0, 0.0, 1.0);
    rgb = vec3<f32>(d * d, d * 0.85, 1.0 - d);
  }

  if (interior) {
    rgb = vec3<f32>(0.015, 0.018, 0.028);
  }

  rgb = clamp(rgb * S.exposure, vec3<f32>(0.0), vec3<f32>(1.0));
  /* Linear -> display.  The 10-bit target keeps the resulting steps. */
  rgb = pow(rgb, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(rgb, 1.0);
}
`;

/* Copy the rgba10a2 target to the swap chain. */
export const PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(srcTex, vec2<i32>(frag.xy), 0);
}
`;

