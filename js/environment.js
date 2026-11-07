/* ------------------------------------------------------------------
 * environment.js — 参考轨道「环境」：级数近似 + 重用判定
 *
 * 级数近似（Series Approximation, SA）
 * ------------------------------------
 * 设参考点为 c0，其轨道为 Z_n；像素点为 c = c0 + δ（δ 即 dc）。
 * 令 z_n = Z_n + ε_n，则 ε_n 可展开为 δ 的幂级数：
 *
 *     ε_n ≈ A_n δ + B_n δ² + C_n δ³ + …
 *
 * 对 z -> z^p + c（p = 2）：
 *     A_{n+1} = 2 Z_n A_n + 1,   A_0 = 0
 *     B_{n+1} = 2 Z_n B_n + A_n²,  B_0 = 0
 *     C_{n+1} = 2 Z_n C_n + 2 A_n B_n,  C_0 = 0
 *
 * 于是从第 s 步开始迭代时，直接用
 *     ε_s = A_s δ + B_s δ² + C_s δ³
 * 作为扰动初值，跳过前 s 次迭代（每次迭代都要做一次复数扰动递推）。
 * 深度越大，可跳过的步数越多——这是深层放大提速的主要来源。
 *
 * 适用条件：|δ| 必须小于“级数有效半径” r_s。取
 *     r_s = min( sqrt(tol·|A_s|/|B_s|), cbrt(tol·|A_s|/|C_s|) )
 * 保证二次、三次项相对线性项都小于 tol。
 * ----------------------------------------------------------------*/

/* 截断误差预算：二次/三次项相对「一个像素的位移」的允许比例 */
export const SA_TOL = 0.01;
/* 最多跳过最大迭代的多少 */
const SA_MAX_FRACTION = 0.52;
const SA_MIN_SKIP = 12;

/** 复数乘 (ar,ai)*(br,bi) */
function cmul(ar, ai, br, bi) {
  return [ar * br - ai * bi, ar * bi + ai * br];
}

/**
 * 计算级数系数（double）。只做 p = 2 的多项式族，其余返回 null。
 * @param {{re:Float64Array, im:Float64Array, len:number}} orbit
 * @param {number} maxIter
 * @param {boolean} isJulia
 * @param {number} pixelUnit 一个像素对应的复平面长度
 */
export function buildSeries(orbit, maxIter, isJulia, pixelUnit) {
  const len = Math.min(orbit.len, maxIter);
  if (len < SA_MIN_SKIP) return null;

  const Zr = orbit.re, Zi = orbit.im;
  const Ar = new Float64Array(len + 1), Ai = new Float64Array(len + 1);
  const Br = new Float64Array(len + 1), Bi = new Float64Array(len + 1);
  const Cr = new Float64Array(len + 1), Ci = new Float64Array(len + 1);
  const Rad = new Float64Array(len + 1);

  // Julia：ε_0 = δ（初始 z 就是像素点）；Mandelbrot：ε_0 = 0
  let ar = 0, ai = 0, br = 0, bi = 0, cr = 0, ci = 0;
  if (isJulia) ar = 1;

  let ok = 0;
  for (let n = 0; n <= len; n++) {
    Ar[n] = ar; Ai[n] = ai; Br[n] = br; Bi[n] = bi; Cr[n] = cr; Ci[n] = ci;

    const magA = Math.hypot(ar, ai);
    const magB = Math.hypot(br, bi);
    const magC = Math.hypot(cr, ci);
    let rad = Infinity;
    if (magA > 1e-14 && Number.isFinite(magA) && magA < 1e100) {
      // 截断误差要小于 tol × 「一个像素带来的位移」
      const budget = SA_TOL * magA * pixelUnit;
      if (magB > 0) rad = Math.min(rad, Math.sqrt(budget / magB));
      if (magC > 0) rad = Math.min(rad, Math.cbrt(budget / magC));
      if (!(rad > 0) || !Number.isFinite(magB) || !Number.isFinite(magC)) rad = 0;
    } else {
      rad = 0;
    }
    Rad[n] = rad;
    if (rad > 0) ok = n;
    if (n === len) break;

    // 推进到 n+1
    const zr = Zr[n], zi = Zi[n];
    const [tar, tai] = cmul(2 * zr, 2 * zi, ar, ai);
    const [abr, abi] = cmul(ar, ai, ar, ai);
    const [abr2, abi2] = cmul(ar, ai, br, bi);
    const nar = tar + (isJulia ? 0 : 1);
    const nai = tai;
    const nbr = 2 * (zr * br - zi * bi) + abr;
    const nbi = 2 * (zr * bi + zi * br) + abi;
    const ncr = 2 * (zr * cr - zi * ci) + 2 * abr2;
    const nci = 2 * (zr * ci + zi * cr) + 2 * abi2;
    ar = nar; ai = nai; br = nbr; bi = nbi; cr = ncr; ci = nci;

    if (!Number.isFinite(ar) || !Number.isFinite(br) || !Number.isFinite(cr) ||
      Math.abs(ar) > 1e120 || Math.abs(br) > 1e120 || Math.abs(cr) > 1e120) {
      // 溢出/发散：后续不再可用
      for (let k = n + 1; k <= len; k++) Rad[k] = 0;
      break;
    }
  }

  return { Ar, Ai, Br, Bi, Cr, Ci, Rad, len, last: ok };
}

/**
 * 选择跳过步数：取「有效半径 ≥ margin × 视野半径」的最大 s。
 * @param {object} series buildSeries 的返回值
 * @param {number} viewRadius 参考点到视野最远角的距离（复平面单位）
 * @param {number} maxIter
 */
export function chooseSkip(series, viewRadius, maxIter) {
  if (!series || !(viewRadius > 0)) return null;
  const need = viewRadius;
  const limit = Math.min(series.len, Math.floor(maxIter * SA_MAX_FRACTION));
  let best = -1;
  for (let n = SA_MIN_SKIP; n <= limit; n++) {
    const r = series.Rad[n];
    if (r >= need) best = n;
    else if (best >= 0 && n > best + 64) break;   // 半径已明显变小，不再回头找
  }
  if (best < SA_MIN_SKIP) return null;
  return {
    skip: best,
    ar: series.Ar[best], ai: series.Ai[best],
    br: series.Br[best], bi: series.Bi[best],
    cr: series.Cr[best], ci: series.Ci[best],
    radius: series.Rad[best]
  };
}
