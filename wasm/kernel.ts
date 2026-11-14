// ------------------------------------------------------------------
// kernel.ts — 分形像素内核（AssemblyScript -> WebAssembly）
//
// 参数块为 f64 数组，索引 × 8 即字节偏移：
//  0 mode(0 direct /1 perturb /2 newton)
//  1 kind(0 poly 1 tricorn 2 burningship 3 celtic 4 perpendicular 5 phoenix)
//  2 power  3 julia  4 tileX 5 tileY 6 tileW 7 tileH 8 imgW 9 imgH
// 10 centerRe 11 centerIm 12 ps 13 juliaRe 14 juliaIm
// 15 maxIter 16 cycle 17 offset 18 outPtr 19 lutPtr
// 20 refPtr 21 refLen 22 refPx 23 refPy 24 phoenixP 25 samples
// 26 newtonDegree 27 rootsPtr 28 orbitStride
// ------------------------------------------------------------------

@inline function ldf(p: i32, i: i32): f64 { return load<f64>(p + (i << 3)); }
@inline function ldi(p: i32, i: i32): i32 { return <i32>load<f64>(p + (i << 3)); }

const BAIL2: f64 = 1e20;
const LOGBAIL: f64 = 23.025850929940457; // ln(1e10)

@inline function smoothOf(k: i32, m2: f64, invLogPower: f64): f64 {
  const lz: f64 = 0.5 * Math.log(m2);
  let nu: f64 = Math.log(lz / LOGBAIL) * invLogPower;
  if (nu != nu) nu = 0.0;
  return <f64>k + 1.0 - nu;
}

@inline function putColor(outPtr: i32, o: i32, lutPtr: i32, t: f64): void {
  let u: f64 = t - Math.floor(t);
  let i0: i32 = <i32>(u * 512.0);
  if (i0 >= 512) i0 = 511;
  if (i0 < 0) i0 = 0;
  const f: f64 = u * 512.0 - <f64>i0;
  const j0: i32 = (i0 + 1) & 511;
  const a: i32 = lutPtr + (i0 << 2);
  const b: i32 = lutPtr + (j0 << 2);
  const r0: f64 = <f64>load<u8>(a), r1: f64 = <f64>load<u8>(b);
  const g0: f64 = <f64>load<u8>(a + 1), g1: f64 = <f64>load<u8>(b + 1);
  const b0: f64 = <f64>load<u8>(a + 2), b1: f64 = <f64>load<u8>(b + 2);
  store<u8>(outPtr + o, <u8>(r0 + (r1 - r0) * f + 0.5));
  store<u8>(outPtr + o + 1, <u8>(g0 + (g1 - g0) * f + 0.5));
  store<u8>(outPtr + o + 2, <u8>(b0 + (b1 - b0) * f + 0.5));
  store<u8>(outPtr + o + 3, 255);
}

@inline function putInterior(outPtr: i32, o: i32): void {
  store<u8>(outPtr + o, 5);
  store<u8>(outPtr + o + 1, 6);
  store<u8>(outPtr + o + 2, 9);
  store<u8>(outPtr + o + 3, 255);
}

export function render(p: i32): i32 {
  const mode: i32 = ldi(p, 0);
  if (mode == 2) { renderNewton(p); return 0; }
  if (mode == 0) {
    if (ldi(p, 1) == 0 && ldi(p, 2) == 2) return renderDirect2(p);
    return renderDirectGeneric(p);
  }
  return renderPerturb(p);
}

// ---------------- 双精度直算 · 二次幂特化（热路径） ----------------
function renderDirect2(p: i32): i32 {
  const isJulia: bool = ldi(p, 3) != 0;
  const tx: i32 = ldi(p, 4), ty: i32 = ldi(p, 5);
  const tw: i32 = ldi(p, 6), th: i32 = ldi(p, 7);
  const halfW: f64 = ldf(p, 8) * 0.5, halfH: f64 = ldf(p, 9) * 0.5;
  const cre: f64 = ldf(p, 10), cim: f64 = ldf(p, 11);
  const ps: f64 = ldf(p, 12);
  const jre: f64 = ldf(p, 13), jim: f64 = ldf(p, 14);
  const maxIter: i32 = ldi(p, 15);
  const bandScale: f64 = 1.0 / Math.max(ldf(p, 16), 1.0), offset: f64 = ldf(p, 17);
  const outPtr: i32 = ldi(p, 18), lutPtr: i32 = ldi(p, 19);
  const invLogPower: f64 = 1.4426950408889634; // 1/ln2
  let o: i32 = 0;

  for (let py: i32 = 0; py < th; py++) {
    const gy: f64 = <f64>(ty + py) + 0.5;
    for (let px: i32 = 0; px < tw; px++) {
      const gx: f64 = <f64>(tx + px) + 0.5;
      const ox: f64 = (gx - halfW) * ps;
      const oy: f64 = -(gy - halfH) * ps;
      const cr: f64 = isJulia ? jre : cre + ox;
      const ci: f64 = isJulia ? jim : cim + oy;
      let zr: f64 = isJulia ? cre + ox : 0.0;
      let zi: f64 = isJulia ? cim + oy : 0.0;
      let n: i32 = 0;
      let m2: f64 = 0.0;
      let escaped: bool = false;
      let chkR: f64 = 0.0, chkI: f64 = 0.0;
      let chkOn: bool = false;
      let period: bool = false;

      while (n < maxIter) {
        const zr2: f64 = zr * zr, zi2: f64 = zi * zi;
        m2 = zr2 + zi2;
        if (m2 > BAIL2) { escaped = true; break; }
        zi = 2.0 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        n++;
        if (n == 12) { chkR = zr; chkI = zi; chkOn = true; }
        else if (chkOn && ((n & 31) == 0)) {
          const dx: f64 = zr - chkR, dy: f64 = zi - chkI;
          if (dx * dx + dy * dy < 1e-26) { period = true; break; }
        }
      }
      if (escaped) {
        putColor(outPtr, o, lutPtr, smoothOf(n, m2, invLogPower) * bandScale + offset);
      } else {
        putInterior(outPtr, o);
      }
      o += 4;
    }
  }
  return 0;
}

// ---------------- 双精度直算 · 通用族 ----------------
function renderDirectGeneric(p: i32): i32 {
  const kind: i32 = ldi(p, 1), power: i32 = ldi(p, 2);
  const isJulia: bool = ldi(p, 3) != 0;
  const tx: i32 = ldi(p, 4), ty: i32 = ldi(p, 5);
  const tw: i32 = ldi(p, 6), th: i32 = ldi(p, 7);
  const halfW: f64 = ldf(p, 8) * 0.5, halfH: f64 = ldf(p, 9) * 0.5;
  const cre: f64 = ldf(p, 10), cim: f64 = ldf(p, 11);
  const ps: f64 = ldf(p, 12);
  const jre: f64 = ldf(p, 13), jim: f64 = ldf(p, 14);
  const maxIter: i32 = ldi(p, 15);
  const bandScale: f64 = 1.0 / Math.max(ldf(p, 16), 1.0), offset: f64 = ldf(p, 17);
  const outPtr: i32 = ldi(p, 18), lutPtr: i32 = ldi(p, 19);
  const ph: f64 = ldf(p, 24);
  const invLogPower: f64 = 1.0 / Math.log(<f64>power);
  let o: i32 = 0;

  for (let py: i32 = 0; py < th; py++) {
    const gy: f64 = <f64>(ty + py) + 0.5;
    for (let px: i32 = 0; px < tw; px++) {
      const gx: f64 = <f64>(tx + px) + 0.5;
      const ox: f64 = (gx - halfW) * ps;
      const oy: f64 = -(gy - halfH) * ps;
      const cr: f64 = isJulia ? jre : cre + ox;
      const ci: f64 = isJulia ? jim : cim + oy;
      let zr: f64 = isJulia ? cre + ox : 0.0;
      let zi: f64 = isJulia ? cim + oy : 0.0;
      let pr: f64 = 0.0, pi: f64 = 0.0;
      let n: i32 = 0, m2: f64 = 0.0;
      let escaped: bool = false;

      for (; n < maxIter; n++) {
        let nr: f64 = 0.0, ni: f64 = 0.0;
        if (kind == 0) {
          if (power == 3) {
            const a: f64 = zr * zr - zi * zi, b: f64 = 2.0 * zr * zi;
            nr = a * zr - b * zi; ni = a * zi + b * zr;
          } else {
            let tr: f64 = zr, ti: f64 = zi;
            for (let k: i32 = 2; k <= power; k++) {
              const r2: f64 = tr * zr - ti * zi, i2: f64 = tr * zi + ti * zr;
              tr = r2; ti = i2;
            }
            nr = tr; ni = ti;
          }
        } else if (kind == 1) {
          nr = zr * zr - zi * zi; ni = -2.0 * zr * zi;
        } else if (kind == 2) {
          const ax: f64 = Math.abs(zr), ay: f64 = Math.abs(zi);
          nr = ax * ax - ay * ay; ni = 2.0 * ax * ay;
        } else if (kind == 3) {
          nr = Math.abs(zr * zr - zi * zi); ni = 2.0 * zr * zi;
        } else if (kind == 4) {
          nr = zr * zr - zi * zi; ni = 2.0 * Math.abs(zr) * Math.abs(zi);
        } else {
          nr = zr * zr - zi * zi + ph * pr;
          ni = 2.0 * zr * zi + ph * pi;
          pr = zr; pi = zi;
        }
        zr = nr + cr; zi = ni + ci;
        m2 = zr * zr + zi * zi;
        if (m2 > BAIL2) { escaped = true; break; }
      }
      if (escaped) {
        putColor(outPtr, o, lutPtr, smoothOf(n, m2, invLogPower) * bandScale + offset);
      } else {
        putInterior(outPtr, o);
      }
      o += 4;
    }
  }
  return 0;
}

// ---------------- 扰动（多项式族） ----------------
function renderPerturb(p: i32): i32 {
  const power: i32 = ldi(p, 2);
  /* Desktop core (B10): Julia has NO constant term in the perturbation
   * recursion.  d_0 is the pixel delta; Mandelbrot carries +d_0. */
  const isJulia: bool = ldi(p, 3) != 0;
  const tx: i32 = ldi(p, 4), ty: i32 = ldi(p, 5);
  const tw: i32 = ldi(p, 6), th: i32 = ldi(p, 7);
  const maxIter: i32 = ldi(p, 15);
  const bandScale: f64 = 1.0 / Math.max(ldf(p, 16), 1.0), offset: f64 = ldf(p, 17);
  const outPtr: i32 = ldi(p, 18), lutPtr: i32 = ldi(p, 19);
  const refPtr: i32 = ldi(p, 20);
  const refLen: i32 = ldi(p, 21);
  const refPx: f64 = ldf(p, 22), refPy: f64 = ldf(p, 23);
  const ps: f64 = ldf(p, 12);
  const stride: i32 = ldi(p, 28);
  const imPtr: i32 = refPtr + (stride << 3);
  const invLogPower: f64 = power == 2 ? 1.4426950408889634 : 1.0 / Math.log(<f64>power);
  let o: i32 = 0;
  let glitches: i32 = 0;

  for (let py: i32 = 0; py < th; py++) {
    const gy: f64 = <f64>(ty + py) + 0.5;
    for (let px: i32 = 0; px < tw; px++) {
      const gx: f64 = <f64>(tx + px) + 0.5;
      const dcr: f64 = (gx - refPx) * ps;
      const dci: f64 = -(gy - refPy) * ps;
      let dr: f64 = dcr, di: f64 = dci;
      let n: i32 = 0, m2: f64 = 0.0;
      let escaped: bool = false;
      let glitch: bool = false;

      if (power == 2) {
        while (n < maxIter) {
          if (n >= refLen) {
            const zr: f64 = load<f64>(refPtr + (refLen << 3)) + dr;
            const zi: f64 = load<f64>(imPtr + (refLen << 3)) + di;
            m2 = zr * zr + zi * zi;
            if (m2 > BAIL2) { escaped = true; n = refLen; } else glitch = true;
            break;
          }
          const Zr: f64 = load<f64>(refPtr + (n << 3));
          const Zi: f64 = load<f64>(imPtr + (n << 3));
          const zr: f64 = Zr + dr, zi: f64 = Zi + di;
          m2 = zr * zr + zi * zi;
          if (m2 > BAIL2) { escaped = true; break; }
          const d2: f64 = dr * dr + di * di;
          const refm2: f64 = Zr * Zr + Zi * Zi;
          /* Desktop core: losing 20 bits to cancellation is a real glitch —
           * |Z+d|^2 << max(|Z|^2,|d|^2), not merely < |d|^2. */
          if (m2 < Math.max(refm2, d2) * 9.094947017729282e-13) glitch = true;
          const t: f64 = 2.0 * Zr + dr, u: f64 = 2.0 * Zi + di;
          const ndr: f64 = t * dr - u * di + (isJulia ? 0.0 : dcr);
          const ndi: f64 = t * di + u * dr + (isJulia ? 0.0 : dci);
          dr = ndr; di = ndi;
          n++;
        }
      } else {
        while (n < maxIter) {
          if (n >= refLen) {
            const zr: f64 = load<f64>(refPtr + (refLen << 3)) + dr;
            const zi: f64 = load<f64>(imPtr + (refLen << 3)) + di;
            m2 = zr * zr + zi * zi;
            if (m2 > BAIL2) { escaped = true; n = refLen; } else glitch = true;
            break;
          }
          const Zr: f64 = load<f64>(refPtr + (n << 3));
          const Zi: f64 = load<f64>(imPtr + (n << 3));
          const zr: f64 = Zr + dr, zi: f64 = Zi + di;
          m2 = zr * zr + zi * zi;
          if (m2 > BAIL2) { escaped = true; break; }
          const d2: f64 = dr * dr + di * di;
          const refm2: f64 = Zr * Zr + Zi * Zi;
          /* Desktop core: losing 20 bits to cancellation is a real glitch —
           * |Z+d|^2 << max(|Z|^2,|d|^2), not merely < |d|^2. */
          if (m2 < Math.max(refm2, d2) * 9.094947017729282e-13) glitch = true;
          let zpr: f64 = 1.0, zpi: f64 = 0.0;
          for (let k: i32 = 0; k < power - 1; k++) {
            const r2: f64 = zpr * Zr - zpi * Zi, i2: f64 = zpr * Zi + zpi * Zr;
            zpr = r2; zpi = i2;
          }
          let dkr: f64 = dr, dki: f64 = di;
          let sr: f64 = 0.0, si: f64 = 0.0;
          let binom: f64 = 1.0;
          for (let k: i32 = 1; k <= power; k++) {
            binom = binom * <f64>(power - k + 1) / <f64>k;
            sr += binom * (zpr * dkr - zpi * dki);
            si += binom * (zpr * dki + zpi * dkr);
            if (k < power) {
              const r2: f64 = dkr * dr - dki * di, i2: f64 = dkr * di + dki * dr;
              dkr = r2; dki = i2;
              const za: f64 = zpr * Zr - zpi * Zi, zb: f64 = zpr * Zi + zpi * Zr;
              zpr = za; zpi = zb;
            }
          }
          dr = sr + (isJulia ? 0.0 : dcr); di = si + (isJulia ? 0.0 : dci);
          n++;
        }
      }
      if (glitch) glitches++;
      if (escaped) {
        putColor(outPtr, o, lutPtr, smoothOf(n, m2, invLogPower) * bandScale + offset);
      } else {
        putInterior(outPtr, o);
      }
      o += 4;
    }
  }
  return glitches;
}

// ---------------- 牛顿集 ----------------
function renderNewton(p: i32): void {
  const tx: i32 = ldi(p, 4), ty: i32 = ldi(p, 5);
  const tw: i32 = ldi(p, 6), th: i32 = ldi(p, 7);
  const halfW: f64 = ldf(p, 8) * 0.5, halfH: f64 = ldf(p, 9) * 0.5;
  const cre: f64 = ldf(p, 10), cim: f64 = ldf(p, 11);
  const ps: f64 = ldf(p, 12);
  const maxIter: i32 = ldi(p, 15);
  const bandScale: f64 = 1.0 / Math.max(ldf(p, 16), 1.0), offset: f64 = ldf(p, 17);
  const outPtr: i32 = ldi(p, 18), lutPtr: i32 = ldi(p, 19);
  const deg: i32 = ldi(p, 26);
  const rootsPtr: i32 = ldi(p, 27);
  const EPS: f64 = 1e-12;
  const fd: f64 = <f64>deg;
  let o: i32 = 0;

  for (let py: i32 = 0; py < th; py++) {
    const gy: f64 = <f64>(ty + py) + 0.5;
    for (let px: i32 = 0; px < tw; px++) {
      const gx: f64 = <f64>(tx + px) + 0.5;
      let zr: f64 = cre + (gx - halfW) * ps;
      let zi: f64 = cim - (gy - halfH) * ps;
      let n: i32 = 0;
      let root: i32 = -1;
      let dist: f64 = 1.0;

      for (; n < maxIter; n++) {
        let pr: f64 = 1.0, pi: f64 = 0.0;
        for (let k: i32 = 0; k < deg - 1; k++) {
          const r2: f64 = pr * zr - pi * zi, i2: f64 = pr * zi + pi * zr;
          pr = r2; pi = i2;
        }
        const qr: f64 = pr * zr - pi * zi - 1.0;
        const qi: f64 = pr * zi + pi * zr;
        const dr_: f64 = fd * pr, di_: f64 = fd * pi;
        const den: f64 = dr_ * dr_ + di_ * di_;
        if (den < 1e-300) break;
        zr -= (qr * dr_ + qi * di_) / den;
        zi -= (qi * dr_ - qr * di_) / den;
        if (n > 3) {
          for (let k: i32 = 0; k < deg; k++) {
            const ex: f64 = zr - load<f64>(rootsPtr + (k << 4));
            const ey: f64 = zi - load<f64>(rootsPtr + (k << 4) + 8);
            const dd: f64 = ex * ex + ey * ey;
            if (dd < EPS) { root = k; dist = Math.sqrt(dd); break; }
          }
          if (root >= 0) break;
        }
      }
      if (root >= 0) {
        const t: f64 = (<f64>n + 1.0 - Math.log2(Math.max(dist, 1e-15)) / 8.0) * bandScale
          + <f64>root * 0.173 + offset;
        putColor(outPtr, o, lutPtr, t);
      } else {
        putInterior(outPtr, o);
      }
      o += 4;
    }
  }
}

