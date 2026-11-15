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
  power: u32,
  scaleMant: f32,
  scaleExp: i32,
  dcOffX: f32,
  dcOffY: f32,
  bailout2: f32,
  paletteFreq: f32,
  palettePhase: f32,
  paletteOffset: f32,
  juliaRe: f32,
  juliaIm: f32,
  phoenixP: f32,
  rotCos: f32,
  rotSin: f32,
  kind: u32,
  scaleMantLo: f32,
  pad1: f32,
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

/* High and low words of the reference point.  The orbit is stored as
 * (hi, lo) pairs so Z can be reconstructed with ~48 bits; summing them in
 * float32 would throw the low word away again, so the pixel loop adds the
 * low word to δ first and only then to hi (a two-sum step). */
fn refHi(n: u32) -> vec2<f32> {
  let r = refOrbit[n];
  return vec2<f32>(r.x, r.z);
}

fn refLo(n: u32) -> vec2<f32> {
  let r = refOrbit[n];
  return vec2<f32>(r.y, r.w);
}

/* Integer power by repeated multiplication; the caller keeps p <= 10. */
fn cpow(z: vec2<f32>, p: u32) -> vec2<f32> {
  var r = vec2<f32>(1.0, 0.0);
  for (var k = 0u; k < p; k = k + 1u) {
    r = cmul(r, z);
  }
  return r;
}

/* ------------------------------------------------------------------
 * Family step.
 *
 * Every family here is "escape-time with a constant term c": the reference
 * orbit is Z_n (c = c_ref) and the pixel carries δ_n plus the constant offset
 * dc.  Expanding F(Z + δ) - F(Z) gives the linear term (which carries the
 * reference) plus a quadratic and higher terms in δ (which only matter while
 * |δ| is still comparable to the local scale, hence the q gate).
 *
 *   kind 0  z^p + c                     (Mandelbrot / Multibrot)
 *   kind 1  conj(z)^2 + c               (Tricorn)
 *   kind 2  (|x| + i|y|)^2 + c          (Burning Ship)
 *   kind 3  |Re z^2| + i Im z^2 + c     (Celtic)
 *   kind 4  (|x| + i|y|)^2 + c          (Perpendicular — same map, own tab)
 *   kind 5  z^2 + p z_{n-1} + c         (Phoenix)
 *
 * The folded families are piecewise holomorphic: the sign of the component
 * that the fold reflects is taken from the reference point, which is constant
 * over a pixel's neighbourhood (the fold line has measure zero).
 * ------------------------------------------------------------------ */
fn deltaStep(kind: u32, power: u32, Z: vec2<f32>, zt: vec2<f32>, d: vec2<f32>,
             dc: vec2<f32>, dPrev: vec2<f32>, phx: f32, q: f32,
             s: f32, invS: f32) -> vec2<f32> {
  /* The k-th order term carries s^(k-1); with q = s or 0 that is q^(k-1). */
  let quad = cmul(d, d) * q;
  switch (kind) {
    case 1u: {
      /* conj is anti-linear: conj(Z + δ) = conj(Z) + conj(δ). */
      let Zc = vec2<f32>(Z.x, -Z.y);
      let dcj = vec2<f32>(d.x, -d.y);
      return cmul(Zc, dcj) * 2.0 + cmul(dcj, dcj) * q + dc;
    }
    case 2u, 4u: {
      /* F(z) = A(z)^2 with A = (|x|, |y|), so
       *   F(z) - F(Z) = (A(z) - A(Z)) * (A(z) + A(Z))
       * is exact for every δ, including the case where the pixel crossed a
       * fold line and the reference did not.  Comparing signs instead of
       * assuming "sign(z) == sign(Z)" is what keeps a shallow view from
       * turning into speckle: there |δ| is comparable to |Z|, so the sign
       * flips for a large fraction of the pixels.  When the signs agree the
       * difference is the signed perturbation (no cancellation); when they
       * disagree both magnitudes are O(1) and the sum is exact enough. */
      let u = vec2<f32>(abs(Z.x), abs(Z.y));
      let v = vec2<f32>(abs(zt.x), abs(zt.y));
      let lin = vec2<f32>(select(-1.0, 1.0, Z.x >= 0.0) * d.x,
                          select(-1.0, 1.0, Z.y >= 0.0) * d.y);
      /* Same difference expressed in the perturbation's scaled unit.  Across a
       * fold the two magnitudes are unrelated in sign, so it really is their
       * difference — not a sum (that identity only holds for a shared sign). */
      let jump = (v - u) * invS;
      let w = vec2<f32>(select(jump.x, lin.x, (Z.x >= 0.0) == (zt.x >= 0.0)),
                        select(jump.y, lin.y, (Z.y >= 0.0) == (zt.y >= 0.0)));
      return cmul(w, v + u) + dc;
    }
    case 3u: {
      /* F(z) = B(z^2) with B reflecting the real part.  The imaginary part is
       * the plain perturbation; the real part is |Re Z^2 + Re w| - |Re Z^2|,
       * which is r * Re w while the sign holds and a sum of magnitudes when
       * the pixel crossed the fold. */
      let wq = cmul(Z, d) * 2.0 + quad;   // scaled: (2 Z δ + δ^2) / s
      let reZ2 = Z.x * Z.x - Z.y * Z.y;
      let reGw = reZ2 + wq.x * s;
      let r = select(-1.0, 1.0, reZ2 >= 0.0);
      let cross = (abs(reGw) - abs(reZ2)) * invS;
      let diff = select(cross, r * wq.x, (reZ2 >= 0.0) == (reGw >= 0.0));
      return vec2<f32>(diff, wq.y) + dc;
    }
    case 5u: {
      return cmul(Z, d) * 2.0 + quad + dPrev * phx + dc;
    }
    default: {
      if (power <= 2u) {
        return cmul(Z, d) * 2.0 + quad + dc;
      }
      /* Binomial expansion: sum_k C(p,k) Z^(p-k) delta^k.  Terms above the
       * first only survive while q != 0, which keeps a deep frame at the cost
       * of a handful of multiply-adds. */
      var zp: array<vec2<f32>, 10>;
      zp[0] = vec2<f32>(1.0, 0.0);
      for (var i = 1u; i < power; i = i + 1u) {
        zp[i] = cmul(zp[i - 1u], Z);
      }
      var acc = d;
      var sum = cmul(zp[power - 1u], d) * f32(power);
      var binom = f32(power);
      var qp = 1.0;
      for (var k = 2u; k <= power; k = k + 1u) {
        acc = cmul(acc, d);
        qp = qp * q;
        binom = binom * f32(power - k + 1u) / f32(k);
        sum = sum + cmul(zp[power - k], acc) * (binom * qp);
      }
      return sum + dc;
    }
  }
}

/* The same family step on the total point, without a reference orbit.  Used
 * once the reference has escaped: from there on the orbit is dominated by the
 * squaring, so plain float32 is enough and the pixel finishes on its own. */
fn totalStep(kind: u32, power: u32, z: vec2<f32>, c: vec2<f32>,
             zPrev: vec2<f32>, phx: f32) -> vec2<f32> {
  switch (kind) {
    case 1u: {
      let zc = vec2<f32>(z.x, -z.y);
      return cmul(zc, zc) + c;
    }
    case 2u, 4u: {
      let a = vec2<f32>(abs(z.x), abs(z.y));
      return cmul(a, a) + c;
    }
    case 3u: {
      let z2 = cmul(z, z);
      return vec2<f32>(abs(z2.x), z2.y) + c;
    }
    case 5u: {
      return cmul(z, z) + zPrev * phx + c;
    }
    default: {
      return cpow(z, power) + c;
    }
  }
}

/* Keep the shared exponent in a range where the float32 mantissas are
 * accurate.  δ, the constant offset dc and the previous δ (Phoenix) are all
 * expressed in the same scaled unit, so they have to follow every exponent
 * change together. */
fn renorm(d: ptr<function, vec2<f32>>, dc: ptr<function, vec2<f32>>,
          dp: ptr<function, vec2<f32>>, de: ptr<function, i32>) {
  for (var i = 0; i < 6; i = i + 1) {
    let m = max(abs((*d).x), abs((*d).y));
    if (m > 65536.0) {
      (*d).x = (*d).x * 1.52587890625e-5;
      (*d).y = (*d).y * 1.52587890625e-5;
      (*dc).x = (*dc).x * 1.52587890625e-5;
      (*dc).y = (*dc).y * 1.52587890625e-5;
      (*dp).x = (*dp).x * 1.52587890625e-5;
      (*dp).y = (*dp).y * 1.52587890625e-5;
      (*de) = (*de) + 16;
    } else if (m < 1.52587890625e-5 && m > 0.0) {
      (*d).x = (*d).x * 65536.0;
      (*d).y = (*d).y * 65536.0;
      (*dc).x = (*dc).x * 65536.0;
      (*dc).y = (*dc).y * 65536.0;
      (*dp).x = (*dp).x * 65536.0;
      (*dp).y = (*dp).y * 65536.0;
      (*de) = (*de) - 16;
    } else {
      break;
    }
  }
}

/*<<DD*/
/* ------------------------------------------------------------------
 * Double-float (two float32 limbs, 48 bits) support for the polynomial
 * family at power 2.
 *
 * Why it is needed at all: perturbation keeps delta small, so a single float32
 * looks sufficient — delta keeps 24 bits of *relative* precision no matter how
 * deep the view is.  The error that hurts is the one the escape phase sees:
 * each step multiplies delta's relative error by |2Z| and adds a fresh 6e-8,
 * so after n steps the phase is off by ~n*1e-7 iterations.  At n = 1000 that
 * is a tenth of a colour band.  Measured against exact BigInt arithmetic, the
 * smooth count is off by 0.073 of a band at 2^-20 and 0.27 at 2^-60; with the
 * limbs below it is off by 0.0004 and 0.0000001 respectively.
 *
 * The plain-float path stays the default: the two limbs cost roughly ten
 * times the arithmetic, which is only worth paying on the final pass of a
 * frame that is deep enough for the error to be visible.
 * ------------------------------------------------------------------ */

struct DDPair {
  re: vec2<f32>,
  im: vec2<f32>,
};

struct Result {
  /* smooth is a reserved word in WGSL. */
  sv: f32,
  dist: f32,
  used: u32,
  status: u32,
};

/* a + b as (sum, error). */
fn ddTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  return vec2<f32>(s, (a - (s - bb)) + (b - bb));
}

/* a + b where |a| >= |b|. */
fn ddQuick(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  return vec2<f32>(s, b - (s - a));
}

/* Split a into two halves whose product with anything is exact in f32
 * (Dekker).  SPLIT is 2^12+1 for a 24-bit mantissa. */
fn ddSplit(a: f32) -> vec2<f32> {
  let c = 4097.0 * a;
  let hi = c - (c - a);
  return vec2<f32>(hi, a - hi);
}

/* a * b as (product, error), without fma: a driver that lowers fma(a,b,-p)
 * to a*b-p returns zero here and silently costs every limb its low word. */
fn ddTwoProd(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  let ah = ddSplit(a);
  let bh = ddSplit(b);
  let e = ((ah.x * bh.x - p) + ah.x * bh.y + ah.y * bh.x) + ah.y * bh.y;
  return vec2<f32>(p, e);
}

fn ddAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = ddTwoSum(a.x, b.x);
  return ddQuick(s.x, (s.y + a.y) + b.y);
}

fn ddSub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return ddAdd(a, vec2<f32>(-b.x, -b.y));
}

fn ddMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p = ddTwoProd(a.x, b.x);
  return ddQuick(p.x, p.y + (a.x * b.y + a.y * b.x));
}

/* Multiply by a plain float (the second operand is known to one limb). */
fn ddMulF(a: vec2<f32>, s: f32) -> vec2<f32> {
  let p = ddTwoProd(a.x, s);
  return ddQuick(p.x, p.y + a.y * s);
}

fn ddVal(a: vec2<f32>) -> f32 { return a.x + a.y; }

/* delta' = 2 Z delta + delta^2 q + dc, every term in double-float.
 *
 * The factors 2 and q are exact powers of two (q is 2^de or zero), so they are
 * applied with ddScale instead of a full multiply: a two-limb multiply costs a
 * Dekker split and four products, and this step does seven of them. */
fn ddStep2(Zr: vec2<f32>, Zi: vec2<f32>, d: DDPair, dc: DDPair, q: f32) -> DDPair {
  let ar = ddSub(ddMul(Zr, d.re), ddMul(Zi, d.im));
  let ai = ddAdd(ddMul(Zr, d.im), ddMul(Zi, d.re));
  let qr = ddSub(ddMul(d.re, d.re), ddMul(d.im, d.im));
  let qi = ddScale(ddMul(d.re, d.im), 2.0);
  var out: DDPair;
  out.re = ddAdd(ddAdd(ddScale(ar, 2.0), ddScale(qr, q)), dc.re);
  out.im = ddAdd(ddAdd(ddScale(ai, 2.0), ddScale(qi, q)), dc.im);
  return out;
}

/* Scaling a double-float by a power of two is exact on both limbs, so the
 * shared exponent can be moved with a plain multiply. */
fn ddScale(a: vec2<f32>, k: f32) -> vec2<f32> {
  return a * vec2<f32>(k, k);
}

fn renormDD(d: ptr<function, DDPair>, dc: ptr<function, DDPair>,
            de: ptr<function, i32>) {
  for (var i = 0; i < 6; i = i + 1) {
    let m = max(abs((*d).re.x), abs((*d).im.x));
    if (m > 65536.0) {
      (*d).re = ddScale((*d).re, 1.52587890625e-5);
      (*d).im = ddScale((*d).im, 1.52587890625e-5);
      (*dc).re = ddScale((*dc).re, 1.52587890625e-5);
      (*dc).im = ddScale((*dc).im, 1.52587890625e-5);
      (*de) = (*de) + 16;
    } else if (m < 1.52587890625e-5 && m > 0.0) {
      (*d).re = ddScale((*d).re, 65536.0);
      (*d).im = ddScale((*d).im, 65536.0);
      (*dc).re = ddScale((*dc).re, 65536.0);
      (*dc).im = ddScale((*dc).im, 65536.0);
      (*de) = (*de) - 16;
    } else {
      break;
    }
  }
}

/* The whole pixel loop in double-float.  Only the polynomial family at power 2
 * is routed here; see the branch in main(). */
fn iterateDD(pixX: f32, pixY: f32, isJulia: bool) -> Result {
  /* The pixel offset is a 48-bit number as well: a float32 mantissa would put
   * the same 1e-7 relative error on dc, which is the *seed* of the recurrence
   * and therefore the one error that cannot be averaged away. */
  let mant = vec2<f32>(P.scaleMant, P.scaleMantLo);
  var d: DDPair;
  var dc: DDPair;
  if (isJulia) {
    d.re = ddMul(vec2<f32>(pixX, 0.0), mant);
    d.im = ddMul(vec2<f32>(pixY, 0.0), mant);
    dc.re = vec2<f32>(0.0, 0.0);
    dc.im = vec2<f32>(0.0, 0.0);
  } else {
    d.re = vec2<f32>(0.0, 0.0);
    d.im = vec2<f32>(0.0, 0.0);
    dc.re = ddMul(vec2<f32>(pixX, 0.0), mant);
    dc.im = ddMul(vec2<f32>(pixY, 0.0), mant);
  }
  var de = P.scaleExp;
  renormDD(&d, &dc, &de);

  var n = 0u;
  var escaped = false;
  var m2 = 0.0;
  var used = 0u;
  var zr = vec2<f32>(0.0, 0.0);
  var zi = vec2<f32>(0.0, 0.0);
  var haveZ = false;

  loop {
    if (n >= P.maxIter || n >= P.refLen) { break; }
    let s = exp2(f32(de));
    let Zh = refHi(n);
    let Zl = refLo(n);
    zr = ddAdd(vec2<f32>(Zh.x, Zl.x), ddScale(d.re, s));
    zi = ddAdd(vec2<f32>(Zh.y, Zl.y), ddScale(d.im, s));
    let m2dd = ddAdd(ddMul(zr, zr), ddMul(zi, zi));
    m2 = ddVal(m2dd);
    haveZ = true;
    if (n > 0u && (m2dd.x > P.bailout2 || (m2dd.x == P.bailout2 && m2dd.y > 0.0))) {
      escaped = true;
      used = n;
      break;
    }
    used = n;
    let q = select(0.0, s, de > -40);
    let nd = ddStep2(vec2<f32>(Zh.x, Zl.x), vec2<f32>(Zh.y, Zl.y), d, dc, q);
    d = nd;
    renormDD(&d, &dc, &de);
    n = n + 1u;
    used = n;
  }

  var out: Result;
  out.status = 0u;
  out.used = used;

  if (!escaped && haveZ && n >= P.refLen && n < P.maxIter) {
    /* The reference escaped first.  From here the orbit is dominated by the
     * squaring, so plain float32 finishes it — but only after |z| is large,
     * which is exactly why the reference bailout is 1e20 and not 256. */
    var azr = ddVal(zr);
    var azi = ddVal(zi);
    var nn = n - 1u;
    var cr = P.juliaRe;
    var ci = P.juliaIm;
    if (!isJulia) {
      let C = refAt(1u);
      let rr = exp2(f32(de));
      cr = C.x + ddVal(dc.re) * rr;
      ci = C.y + ddVal(dc.im) * rr;
    }
    loop {
      if (nn >= P.maxIter) { break; }
      let ar2 = azr * azr - azi * azi + cr;
      azi = 2.0 * azr * azi + ci;
      azr = ar2;
      nn = nn + 1u;
      m2 = azr * azr + azi * azi;
      if (m2 > P.bailout2) { escaped = true; n = nn; out.used = nn; break; }
    }
    if (!escaped) {
      n = nn;
      out.used = nn;
      out.status = out.status | 1u;
      atomicAdd(&counters[0], 1u);
    }
  }

  if (escaped) {
    let mm = min(m2, 1e30);
    let nu = log(0.5 * log(max(mm, 1e-30)) / 23.025850929940457) / log(2.0);
    out.sv = f32(n) + 1.0 - select(0.0, nu, nu == nu);
    let dn = sqrt(ddVal(ddMul(d.re, d.re)) + ddVal(ddMul(d.im, d.im))) * exp2(f32(de));
    out.dist = 1.0e7;
    if (dn > 1.0e-30) {
      out.dist = 0.5 * sqrt(mm) * log(max(mm, 2.0)) / dn;
    }
  } else {
    out.status = out.status | 2u;
    out.sv = f32(P.maxIter);
    out.dist = 1.0e7;
  }
  return out;
}
/*DD>>*/

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
  /* The page rotates the view plane around its centre, so the screen offset
   * turns before it becomes a plane offset (same matrix as planeDelta()). */
  let rx = offX * P.rotCos - offY * P.rotSin;
  let ry = offX * P.rotSin + offY * P.rotCos;

  /*<<DD*/
  /* Double-float route: the final pass of a deep frame, polynomial family at
   * power 2 only (folded families need the exact-difference forms, which are
   * a separate transcription and are still measured in float32). */
  if ((P.flags & 8u) != 0u) {
    let r = iterateDD(rx, ry, (P.flags & 2u) != 0u);
    textureStore(fieldTex, vec2<i32>(i32(px), i32(py)),
                 vec4<f32>(r.sv, r.dist, f32(r.used), f32(r.status)));
    atomicAdd(&counters[1], 1u);
    if ((r.status & 2u) != 0u) {
      atomicAdd(&counters[3], 1u);
    } else {
      atomicAdd(&counters[2], 1u);
      let q = u32(clamp(r.sv, 0.0, 4.0e6) * 8.0);
      atomicMin(&counters[4], q);
      atomicMax(&counters[5], q);
    }
    return;
  }
  /*DD>>*/

  let pix = vec2<f32>(rx * P.scaleMant, ry * P.scaleMant);
  let isJulia = (P.flags & 2u) != 0u;

  /* Mandelbrot: the pixel differs from the reference in the constant c, so the
   * perturbation starts at δ=0 and dc carries the offset.  Julia: the constant
   * is shared and the pixel differs in the starting z, so δ starts at the
   * offset and dc must stay zero — adding it every step (the old code) shifted
   * the whole Julia family by one pixel-scale drift. */
  var d = vec2<f32>(0.0, 0.0);
  var dc = pix;
  if (isJulia) {
    d = pix;
    dc = vec2<f32>(0.0, 0.0);
  }
  /* Phoenix carries z_{n-1}; the reference starts that memory at 0, so does
   * the pixel's perturbation. */
  var dPrev = vec2<f32>(0.0, 0.0);
  var de = P.scaleExp;
  renorm(&d, &dc, &dPrev, &de);

  var n = 0u;
  var bi = 0u;
  var status = 0u;
  var escaped = false;
  var direct = false;
  var smoothVal = f32(P.maxIter);
  var dist = 1.0e7;
  var m2 = 0.0;
  var used = 0u;
  var zx = 0.0;
  var zy = 0.0;
  var pzx = 0.0;
  var pzy = 0.0;
  var haveZ = false;

  loop {
    if (n >= P.maxIter || n >= P.refLen) {
      break;
    }

    /* Sample the total point z_n = Z_n + δ_n first and test it for escape:
     * this is the CPU kernel's order (renderPerturb), and it keeps the
     * iteration count on the same convention the palette expects. */
    let Zh = refHi(n);
    let Zl = refLo(n);
    let s = exp2(f32(de));
    pzx = zx;
    pzy = zy;
    zx = Zh.x + (Zl.x + d.x * s);
    zy = Zh.y + (Zl.y + d.y * s);
    m2 = zx * zx + zy * zy;
    haveZ = true;

    if (n > 0u && m2 > P.bailout2) {
      escaped = true;
      used = n;
      break;
    }
    used = n;

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
        /* Never jump across the reference bailout: a block whose end is already
         * far outside would skip the pixel escape test and paint a black hole. */
        let bend = start + blen;
        var safe = blen > 0u && bend < P.refLen;
        if (safe) {
          safe = norm2(refAt(bend)) < 1024.0;
        }
        if (safe && ea > -100 && ea < 100 && eb > -100 && eb < 100) {
          let A = vec2<f32>(b0.x, b0.y);
          let B = vec2<f32>(b1.x, b1.y);
          let nd = cmul(A, d) * exp2(f32(ea)) +
                   cmul(B, dc) * exp2(f32(eb));
          d = nd;
          renorm(&d, &dc, &dPrev, &de);
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
    let q = select(0.0, s, de > -40);
    /* Only the fold branches use it, and only when the pixel's orbit has left
     * the reference's neighbourhood. */
    let invS = select(0.0, 1.0 / s, s > 1.0e-30);
    let nd = deltaStep(P.kind, P.power, Z, vec2<f32>(zx, zy), d, dc, dPrev,
                       P.phoenixP, q, s, invS);
    dPrev = d;
    d = nd;
    renorm(&d, &dc, &dPrev, &de);
    n = n + 1u;
    used = n;
  }

  /* The reference escaped before the pixel did.  Past the reference bailout
   * |z| is large enough for plain float32, so finish the orbit from the last
   * total point instead of declaring the pixel interior.  (The old code mixed
   * the scaled δ with the unscaled constant, which is why this branch painted
   * contour bands instead of escape counts.) */
  if (!escaped && haveZ && n >= P.refLen && n < P.maxIter) {
    var az = vec2<f32>(zx, zy);
    /* Phoenix needs the point before the last one as well. */
    var pz = vec2<f32>(pzx, pzy);
    var nn = n - 1u;
    var cr = P.juliaRe;
    var ci = P.juliaIm;
    if (!isJulia) {
      let C = refAt(1u);
      let rr = exp2(f32(de));
      cr = C.x + dc.x * rr;
      ci = C.y + dc.y * rr;
    }
    direct = true;
    loop {
      if (nn >= P.maxIter) {
        break;
      }
      let nz = totalStep(P.kind, P.power, az, vec2<f32>(cr, ci), pz, P.phoenixP);
      pz = az;
      az = nz;
      nn = nn + 1u;
      m2 = az.x * az.x + az.y * az.y;
      if (m2 > P.bailout2) {
        escaped = true;
        n = nn;
        used = nn;
        break;
      }
    }
    if (!escaped) {
      n = nn;
      used = nn;
      status = status | 1u;
      atomicAdd(&counters[0], 1u);
    }
  }

  if (escaped) {
    /* The page's own smooth count (drawlib.js): nu is measured against
     * ln(1e10) with the escape radius the CPU path uses, so a WebGPU frame and
     * a CPU frame put the same pixel on the same palette entry.  |z| may jump
     * past the float range in the escape squaring; clamping the magnitude keeps
     * nu finite, otherwise the palette index becomes NaN and the driver paints
     * those pixels as the black contour curves seen at every zoom level. */
    let mm = min(m2, 1e30);
    let nu = log(0.5 * log(max(mm, 1e-30)) / 23.025850929940457) /
             log(max(f32(P.power), 2.0));
    smoothVal = f32(n) + 1.0 - select(0.0, nu, nu == nu);
    if (!direct) {
      let dn = sqrt(norm2(d)) * exp2(f32(de));
      if (dn > 1.0e-30) {
        dist = 0.5 * sqrt(mm) * log(max(mm, 2.0)) / dn;
      }
    }
  } else {
    /* No escape within the budget: the point belongs to the set, so take the
     * interior colour instead of leaving a max-iteration value that the
     * palette paints as a bright disc. */
    status = status | 2u;
    smoothVal = f32(P.maxIter);
    dist = 1.0e7;
  }

  textureStore(fieldTex, vec2<i32>(i32(px), i32(py)),
               vec4<f32>(smoothVal, dist, f32(used), f32(status)));
  atomicAdd(&counters[1], 1u);
  if (escaped) {
    atomicAdd(&counters[2], 1u);
    /* Escape range, in 1/8 of an iteration.  The palette needs it to decide
     * how many colour cycles one frame spans; without it the page had to
     * guess from maxIter and guessed six times too many. */
    let q = u32(clamp(smoothVal, 0.0, 4.0e6) * 8.0);
    atomicMin(&counters[4], q);
    atomicMax(&counters[5], q);
  } else {
    atomicAdd(&counters[3], 1u);
  }
}
`;

/**
 * The compute kernel without its double-float section.
 *
 * The two-limb arithmetic needs `fma` (WGSL's fused multiply-add) to keep the
 * product error exact; without it a Dekker split can be contracted into the
 * following subtraction and silently lose the low limb.  Rather than stake the
 * whole GPU path on that assumption, the renderer retries with this source
 * when the first compile fails, and never sets the double-float flag.
 */
export function computeWgslWithoutDoubleFloat() {
  return COMPUTE_WGSL.replace(/\/\*<<DD\*\/[\s\S]*?\/\*DD>>\*\//g, '');
}

/* Shade the float field into the 10-bit target. */
export const SHADE_WGSL = /* wgsl */ `struct Shade {
  srcW: f32,
  srcH: f32,
  dstW: f32,
  dstH: f32,
  mode: u32,
  freq: f32,
  phase: f32,
  offset: f32,
  exposure: f32,
  useLut: u32,
  cycle: f32,
  _p0: f32,
};

@group(0) @binding(0) var<uniform> S: Shade;
@group(0) @binding(1) var fieldTex: texture_2d<f32>;
@group(0) @binding(2) var lutTex: texture_2d<f32>;

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

  /* Mode 3 is the main page's own colour model: the smooth count indexes the
   * 512-entry palette table (one cycle every "cycle" iterations, plus the
   * phase offset) exactly like drawlib.putColor, so the WebGPU frame and the
   * CPU frame carry the same colours.  LUT entries are already display-referred,
   * so no exposure or gamma stage is applied to them. */
  if (S.useLut == 1u) {
    /* out/src/render.cpp effective_palette_scale(): ten colour cycles across
     * the frame's whole iteration range.  S.cycle is maxIter/10, so the frame
     * never wraps more than ten times and a deep view -- whose escapes are all
     * within a few per cent of each other -- stays smooth instead of being
     * chopped into the thirty-five black contour arcs the old fixed 140-cycle
     * count produced.  (A log2(1+n) coordinate was tried here too: correct for
     * an overview, but at 1e-20 it compresses 14 000 iterations into 0.3 of a
     * band and the frame turns flat white.) */
    let t = f.x / max(S.cycle, 2.0) + S.offset;
    let u = t - floor(t);
    let ix = u * 512.0;
    var i0 = i32(ix);
    if (i0 >= 512) { i0 = 511; }
    if (i0 < 0) { i0 = 0; }
    let fr = ix - f32(i0);
    let c0 = textureLoad(lutTex, vec2<i32>(i0, 0), 0).rgb;
    let c1 = textureLoad(lutTex, vec2<i32>((i0 + 1) & 511, 0), 0).rgb;
    rgb = mix(c0, c1, fr);
  }

  if (S.mode == 1u) {
    let d = clamp(log2(max(f.y, 1.0)) / 6.0, 0.0, 1.0);
    rgb = vec3<f32>(d * d, d * 0.85, 1.0 - d);
  }

  /* Ice: dark navy background with cyan filaments.  The smooth iteration count
   * is compressed logarithmically so the scheme survives both the full-set
   * view (n≈2) and 1e-1000 (n≈10000) without a view-dependent exposure. */
  if (S.mode == 2u) {
    let t = log2(1.0 + max(f.x, 0.0));
    let u = clamp(t / 12.0, 0.0, 1.0);
    let band = 0.5 + 0.5 * cos(6.28318530718 * (t * 0.42 + S.phase));
    let base = vec3<f32>(0.012, 0.026, 0.055);
    let ice = vec3<f32>(0.05, 0.36, 0.72);
    let hot = vec3<f32>(0.60, 0.90, 1.0);
    var c = mix(base, ice, smoothstep(0.0, 0.45, u));
    c = mix(c, hot, smoothstep(0.45, 1.0, u) * (0.35 + 0.65 * band));
    rgb = c;
  }

  if (interior) {
    if (S.useLut == 1u) {
      rgb = vec3<f32>(5.0 / 255.0, 6.0 / 255.0, 9.0 / 255.0);
    } else {
      rgb = vec3<f32>(0.015, 0.018, 0.028);
    }
  }

  if (S.useLut == 1u) {
    return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
  }

  rgb = clamp(rgb * S.exposure, vec3<f32>(0.0), vec3<f32>(1.0));
  /* Linear -> display.  The 10-bit target keeps the resulting steps. */
  rgb = pow(rgb, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(rgb, 1.0);
}
`;

/* Copy the rgba10a2 target to the swap chain. */export const PRESENT_WGSL = /* wgsl */ `
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

