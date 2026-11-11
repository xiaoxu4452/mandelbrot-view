#include "mb_mpf.h"

#include "mb_hf.h"
#include "mb_precision.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>

namespace mbc {
namespace {

int topBit(uint32_t x) {
  int n = 31;
  while (n > 0 && ((x >> n) & 1u) == 0) --n;
  return n;
}

std::vector<uint32_t> addMagVec(const std::vector<uint32_t>& a,
                                const std::vector<uint32_t>& b) {
  const size_t n = std::max(a.size(), b.size());
  std::vector<uint32_t> r(n + 1, 0);
  uint64_t carry = 0;
  for (size_t i = 0; i < n; ++i) {
    uint64_t s = carry;
    if (i < a.size()) s += a[i];
    if (i < b.size()) s += b[i];
    r[i] = (uint32_t)s;
    carry = s >> 32;
  }
  r[n] = (uint32_t)carry;
  return r;
}

/* 要求 a >= b（按 magnitude） */
std::vector<uint32_t> subMagVec(const std::vector<uint32_t>& a,
                                const std::vector<uint32_t>& b) {
  std::vector<uint32_t> r(a.size(), 0);
  int64_t borrow = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    int64_t s = (int64_t)a[i] - borrow - (i < b.size() ? (int64_t)b[i] : 0);
    borrow = s < 0 ? 1 : 0;
    if (s < 0) s += (int64_t)1 << 32;
    r[i] = (uint32_t)s;
  }
  while (!r.empty() && r.back() == 0) r.pop_back();
  return r;
}

int cmpMagVec(const std::vector<uint32_t>& a, const std::vector<uint32_t>& b) {
  if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
  for (size_t i = a.size(); i-- > 0;) {
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

void trimVec(std::vector<uint32_t>& v) {
  while (!v.empty() && v.back() == 0) v.pop_back();
}

/* acc += v * 2^(32*off) */
void addInto(std::vector<uint32_t>& acc, const std::vector<uint32_t>& v, size_t off) {
  if (v.empty()) return;
  if (acc.size() < off + v.size() + 1) acc.resize(off + v.size() + 1, 0);
  uint64_t carry = 0;
  size_t i = 0;
  for (; i < v.size(); ++i) {
    const uint64_t s = (uint64_t)acc[off + i] + v[i] + carry;
    acc[off + i] = (uint32_t)s;
    carry = s >> 32;
  }
  size_t k = off + v.size();
  while (carry != 0) {
    if (k >= acc.size()) acc.push_back(0);
    const uint64_t s = (uint64_t)acc[k] + carry;
    acc[k] = (uint32_t)s;
    carry = s >> 32;
    ++k;
  }
}

/* acc -= v * 2^(32*off)，要求 acc >= v*2^(32*off) */
void subFrom(std::vector<uint32_t>& acc, const std::vector<uint32_t>& v, size_t off) {
  if (v.empty()) return;
  if (acc.size() < off + v.size()) acc.resize(off + v.size(), 0);
  int64_t borrow = 0;
  size_t i = 0;
  for (; i < v.size(); ++i) {
    int64_t s = (int64_t)acc[off + i] - borrow - (int64_t)v[i];
    borrow = s < 0 ? 1 : 0;
    if (s < 0) s += (int64_t)1 << 32;
    acc[off + i] = (uint32_t)s;
  }
  size_t k = off + v.size();
  while (borrow != 0 && k < acc.size()) {
    int64_t s = (int64_t)acc[k] - borrow;
    borrow = s < 0 ? 1 : 0;
    if (s < 0) s += (int64_t)1 << 32;
    acc[k] = (uint32_t)s;
    ++k;
  }
  trimVec(acc);
}

void mulSchool(std::vector<uint32_t>& z, const std::vector<uint32_t>& x,
               const std::vector<uint32_t>& y) {
  z.assign(x.size() + y.size() + 1, 0);
  for (size_t i = 0; i < x.size(); ++i) {
    uint64_t carry = 0;
    const uint64_t xi = x[i];
    for (size_t j = 0; j < y.size(); ++j) {
      const uint64_t cur = (uint64_t)z[i + j] + xi * y[j] + carry;
      z[i + j] = (uint32_t)cur;
      carry = cur >> 32;
    }
    size_t k = i + y.size();
    while (carry != 0) {
      const uint64_t cur = (uint64_t)z[k] + carry;
      z[k] = (uint32_t)cur;
      carry = cur >> 32;
      ++k;
    }
  }
  trimVec(z);
}

/* Karatsuba：z = x*y。长度差超过 3 倍时退回 schoolbook（避免空段）。 */
void mulMag(std::vector<uint32_t>& z, const std::vector<uint32_t>& x,
            const std::vector<uint32_t>& y) {
  const size_t nx = x.size(), ny = y.size();
  const size_t nmin = nx < ny ? nx : ny;
  const size_t nmax = nx > ny ? nx : ny;
  const size_t kKaratsubaMin = 24;
  if (nmin < kKaratsubaMin || nmax > 3 * nmin) {
    mulSchool(z, x, y);
    return;
  }
  const size_t h = nmax / 2;
  const size_t xh = h < nx ? h : nx;
  const size_t yh = h < ny ? h : ny;
  const std::vector<uint32_t> x0(x.begin(), x.begin() + (long)xh);
  const std::vector<uint32_t> x1(x.begin() + (long)xh, x.end());
  const std::vector<uint32_t> y0(y.begin(), y.begin() + (long)yh);
  const std::vector<uint32_t> y1(y.begin() + (long)yh, y.end());

  std::vector<uint32_t> sx = addMagVec(x0, x1);
  std::vector<uint32_t> sy = addMagVec(y0, y1);
  trimVec(sx);
  trimVec(sy);

  std::vector<uint32_t> z0, z2, z1;
  mulMag(z0, x0, y0);
  mulMag(z2, x1, y1);
  mulMag(z1, sx, sy);
  subFrom(z1, z0, 0);
  subFrom(z1, z2, 0);

  z = z0;
  addInto(z, z1, h);
  addInto(z, z2, 2 * h);
  trimVec(z);
}

}  // namespace

int Mpf::expBits() const {
  if (size_ == 0) return 0;
  const int bl = 32 * (size_ - 1) + topBit(d_[(size_t)size_ - 1]) + 1;
  return (int)(e_ + bl);
}

void Mpf::trim() {
  while (size_ > 0 && d_[(size_t)size_ - 1] == 0) --size_;
  if (size_ == 0) {
    neg_ = false;
    e_ = 0;
    d_.clear();
    return;
  }
  /* Keep the two in step.  They used to drift apart here — trim() only lowered
   * size_ and left the stale limbs in place — and then every `d_.push_back()`
   * in the magnitude loops (mulSmall, roundToPrec) appended *past* size_ while
   * the size bump made the new limb index point at an old zero.  The carry was
   * silently dropped, so a value that needed a fourth limb lost its top bits.
   * setStr() multiplied by ten thirty-three times and ended up with a number
   * two dozen bits short, which is how "high precision" quietly turned into
   * noise. */
  d_.resize((size_t)size_);
}

void Mpf::setZero() {
  d_.clear();
  size_ = 0;
  neg_ = false;
  e_ = 0;
}

void Mpf::setPrec(int bits) {
  prec_ = std::max(32, bits);
  alloc_ = prec_;
  roundToPrec(prec_);
}

void Mpf::setPrecRaw(int bits) {
  /* GMP mpf_set_prec_raw：不重新分配，也不立即改值，只改后续运算的舍入位数。
   * 原版靠它在轨道推进时原地降精度（004fca50）。 */
  if (bits > alloc_) bits = alloc_;
  prec_ = std::max(32, bits);
}

void Mpf::roundToPrec(int bits) {
  if (size_ == 0) return;
  if (bits < 32) bits = 32;
  int bl = 32 * (size_ - 1) + topBit(d_[(size_t)size_ - 1]) + 1;
  if (bl <= bits) return;
  const int sh = bl - bits;
  /* 就近舍入（half up）：在 bit sh-1 处加 1，再右移 sh 位。 */
  const int pos = sh - 1;
  const size_t li = (size_t)(pos / 32);
  const int lb = pos % 32;
  uint64_t carry = (uint64_t)1 << lb;
  for (size_t i = li; carry != 0; ++i) {
    if (i >= d_.size()) {
      d_.push_back(0);
      ++size_;
    }
    uint64_t s = (uint64_t)d_[i] + carry;
    d_[i] = (uint32_t)s;
    carry = s >> 32;
  }
  /* 右移 sh 位。 */
  const size_t drop = (size_t)(sh / 32);
  const int rbits = sh % 32;
  std::vector<uint32_t> out;
  if (drop >= (size_t)size_) {
    setZero();
    return;
  }
  out.assign(d_.begin() + (long)drop, d_.begin() + size_);
  if (rbits > 0) {
    uint32_t carryDown = 0;
    for (size_t i = out.size(); i-- > 0;) {
      const uint32_t v = out[i];
      out[i] = (v >> rbits) | carryDown;
      carryDown = (uint32_t)(v << (32 - rbits));
    }
  }
  e_ += sh;
  d_.swap(out);
  size_ = (int)d_.size();
  trim();
  /* 舍入进位可能多出 1 位，再削一次（不再舍入）。 */
  if (size_ > 0) {
    int bl2 = 32 * (size_ - 1) + topBit(d_[(size_t)size_ - 1]) + 1;
    if (bl2 > bits) {
      const size_t d2 = (size_t)((bl2 - bits) / 32);
      const int r2 = (bl2 - bits) % 32;
      if (d2 >= (size_t)size_) {
        setZero();
        return;
      }
      out.assign(d_.begin() + (long)d2, d_.begin() + size_);
      if (r2 > 0) {
        uint32_t cd = 0;
        for (size_t i = out.size(); i-- > 0;) {
          const uint32_t v = out[i];
          out[i] = (v >> r2) | cd;
          cd = (uint32_t)(v << (32 - r2));
        }
      }
      e_ += (long)(bl2 - bits);
      d_.swap(out);
      size_ = (int)d_.size();
      trim();
    }
  }
}

void Mpf::toAligned(const Mpf& a, long e, std::vector<uint32_t>& out) {
  if (a.size_ == 0) {
    out.clear();
    return;
  }
  const long sh = a.e_ - e;  // >= 0
  const size_t lo = (size_t)(sh / 32);
  const int bo = (int)(sh % 32);
  out.assign(lo, 0);
  out.resize(lo + (size_t)a.size_ + (bo ? 1 : 0), 0);
  uint64_t carry = 0;
  for (int i = 0; i < a.size_; ++i) {
    const uint64_t v = ((uint64_t)a.d_[(size_t)i] << bo) | carry;
    out[lo + (size_t)i] = (uint32_t)v;
    carry = v >> 32;
  }
  if (bo) out[lo + (size_t)a.size_] = (uint32_t)carry;
  while (!out.empty() && out.back() == 0) out.pop_back();
}

void Mpf::fromLimbs(Mpf& r, std::vector<uint32_t>&& mag, bool neg, long e,
                    int prec) {
  r.d_ = std::move(mag);
  r.size_ = (int)r.d_.size();
  r.neg_ = neg;
  r.e_ = e;
  r.prec_ = std::max(32, prec);
  r.alloc_ = std::max(r.alloc_, r.prec_);
  r.trim();
  r.roundToPrec(r.prec_);
}

void Mpf::mulSmall(uint32_t k) {
  if (size_ == 0 || k == 0) {
    if (k == 0) setZero();
    return;
  }
  uint64_t carry = 0;
  for (int i = 0; i < size_; ++i) {
    const uint64_t cur = (uint64_t)d_[(size_t)i] * k + carry;
    d_[(size_t)i] = (uint32_t)cur;
    carry = cur >> 32;
  }
  if (carry != 0) {
    d_.push_back((uint32_t)carry);
    ++size_;
  }
  roundToPrec(prec_);
}

void Mpf::divSmall(uint32_t k) {
  if (size_ == 0 || k == 0) return;
  uint64_t rem = 0;
  for (int i = size_; i-- > 0;) {
    const uint64_t cur = (rem << 32) | d_[(size_t)i];
    d_[(size_t)i] = (uint32_t)(cur / k);
    rem = cur % k;
  }
  trim();
}

void Mpf::addSmall(uint32_t k) {
  Mpf t(prec_);
  t.setUi(k);
  Mpf s(prec_);
  add(s, *this, t);
  *this = s;
}

void Mpf::setStr(const std::string& s) {
  setZero();
  size_t i = 0;
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
  bool neg = false;
  if (i < s.size() && (s[i] == '+' || s[i] == '-')) {
    neg = s[i] == '-';
    ++i;
  }
  int fracDigits = 0;
  bool seenDot = false;
  for (; i < s.size(); ++i) {
    const char c = s[i];
    if (c == '.') {
      seenDot = true;
      continue;
    }
    if (c < '0' || c > '9') break;
    mulSmall(10);
    addSmall((uint32_t)(c - '0'));
    if (seenDot) ++fracDigits;
  }
  int exp10 = -fracDigits;
  if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    exp10 += std::atoi(s.c_str() + i + 1);
  }
  for (; exp10 > 0; --exp10) mulSmall(10);
  if (neg && size_ != 0) neg_ = true;
  if (exp10 < 0) {
    /* A decimal fraction cannot be produced by dividing the limb array:
     * divSmall() is *integer* division, so "0.332" went 332 -> 33 -> 3 -> 0.
     * Every centre string ended up as zero, buildReferenceMpf() reported a
     * full-length orbit of zeros, and the caller believed it had a reference
     * — which silently turned the whole high-precision path into a plain
     * double iteration.  That is why a deep frame looked posterised: adjacent
     * pixels differ by less than one double ulp there.
     *
     * Scale the integer up by the working precision first, divide, then put
     * the scale back.  Each truncating division now costs a bit far below the
     * last one that survives the final rounding. */
    const int work = prec_ + 96;
    /* Left-shift the limb array (not the exponent) so the discarded remainders
     * land below the bits that survive rounding. */
    const int ls = work / 32, bs = work % 32;
    std::vector<uint32_t> mag((size_t)ls, 0u);
    mag.insert(mag.end(), d_.begin(), d_.begin() + size_);
    if (bs && size_ != 0) {
      uint32_t carry = 0;
      for (size_t k = (size_t)ls; k < mag.size(); ++k) {
        const uint64_t cur = ((uint64_t)mag[k] << bs) | carry;
        mag[k] = (uint32_t)cur;
        carry = (uint32_t)(cur >> 32);
      }
      if (carry) mag.push_back(carry);
    }
    Mpf t(work);
    fromLimbs(t, std::move(mag), neg_, e_ - work, work);
    for (; exp10 < 0; ++exp10) t.divSmall(10);
    t.prec_ = prec_;
    t.roundToPrec(prec_);
    *this = t;
  } else {
    roundToPrec(prec_);
  }
}

void Mpf::setUi(uint64_t v) {
  d_.clear();
  d_.push_back((uint32_t)v);
  d_.push_back((uint32_t)(v >> 32));
  size_ = 2;
  neg_ = false;
  e_ = 0;
  trim();
  roundToPrec(prec_);
}

void Mpf::setD(double v) {
  if (v == 0.0 || !std::isfinite(v)) {
    setZero();
    return;
  }
  neg_ = v < 0.0;
  int ex = 0;
  const double m = std::frexp(std::fabs(v), &ex);  // |v| = m * 2^ex, m in [0.5,1)
  uint64_t mant = (uint64_t)std::ldexp(m, 53);
  d_.assign(2, 0);
  d_[0] = (uint32_t)mant;
  d_[1] = (uint32_t)(mant >> 32);
  size_ = 2;
  e_ = ex - 53;
  trim();
  roundToPrec(prec_);
}

double Mpf::toDouble() const {
  if (size_ == 0) return 0.0;
  const int used = std::min(size_, 2);
  uint64_t m = 0;
  for (int i = size_ - 1; i >= size_ - used; --i) m = (m << 32) | d_[(size_t)i];
  const int shift = (int)e_ + 32 * (size_ - used);
  const double v = (double)m * std::ldexp(1.0, shift);
  return neg_ ? -v : v;
}

int Mpf::cmpAbs(const Mpf& o) const {
  if (size_ == 0 || o.size_ == 0) {
    if (size_ == 0 && o.size_ == 0) return 0;
    return size_ == 0 ? -1 : 1;
  }
  const int ka = expBits(), kb = o.expBits();
  if (ka != kb) return ka < kb ? -1 : 1;
  const long e = std::min(e_, o.e_);
  std::vector<uint32_t> A, B;
  toAligned(*this, e, A);
  toAligned(o, e, B);
  return cmpMagVec(A, B);
}

int Mpf::compare(const Mpf& o) const {
  if (sgn() != o.sgn()) return sgn() < o.sgn() ? -1 : 1;
  if (sgn() == 0) return 0;
  const int c = cmpAbs(o);
  return neg_ ? -c : c;
}

void Mpf::add(Mpf& r, const Mpf& a, const Mpf& b) {
  const int prec = r.prec_;
  if (a.isZero()) {
    r = b;
    r.prec_ = prec;
    r.roundToPrec(prec);
    return;
  }
  if (b.isZero()) {
    r = a;
    r.prec_ = prec;
    r.roundToPrec(prec);
    return;
  }
  const long e = std::min(a.e_, b.e_);
  /* GMP 语义的捷径：量级差超过结果精度时，小项对舍入没有影响。 */
  const int ga = a.expBits(), gb = b.expBits();
  if (ga > gb + prec + 2 || gb > ga + prec + 2) {
    const Mpf& big = ga > gb ? a : b;
    r = big;
    r.prec_ = prec;
    r.roundToPrec(prec);
    return;
  }
  std::vector<uint32_t> A, B;
  toAligned(a, e, A);
  toAligned(b, e, B);
  if (a.neg_ == b.neg_) {
    fromLimbs(r, addMagVec(A, B), a.neg_, e, prec);
  } else {
    const int c = cmpMagVec(A, B);
    if (c == 0) {
      r.setZero();
      r.prec_ = prec;
      return;
    }
    if (c > 0) {
      fromLimbs(r, subMagVec(A, B), a.neg_, e, prec);
    } else {
      fromLimbs(r, subMagVec(B, A), b.neg_, e, prec);
    }
  }
}

void Mpf::sub(Mpf& r, const Mpf& a, const Mpf& b) {
  Mpf nb = b;
  nb.neg_ = nb.size_ ? !nb.neg_ : false;
  add(r, a, nb);
}

void Mpf::mul(Mpf& r, const Mpf& a, const Mpf& b) {
  const int prec = r.prec_;
  if (a.isZero() || b.isZero()) {
    r.setZero();
    r.prec_ = prec;
    return;
  }
  std::vector<uint32_t> M;
  mulMag(M, std::vector<uint32_t>(a.d_.begin(), a.d_.begin() + a.size_),
         std::vector<uint32_t>(b.d_.begin(), b.d_.begin() + b.size_));
  fromLimbs(r, std::move(M), a.neg_ != b.neg_, a.e_ + b.e_, prec);
}

void Mpf::mul2exp(Mpf& r, const Mpf& a, long bits) {
  const int prec = r.prec_;
  if (a.isZero()) {
    r.setZero();
    r.prec_ = prec;
    return;
  }
  std::vector<uint32_t> mag(a.d_.begin(), a.d_.begin() + a.size_);
  fromLimbs(r, std::move(mag), a.neg_, a.e_ + bits, prec);
}

void Mpf::neg(Mpf& r, const Mpf& a) {
  r = a;
  if (r.size_ != 0) r.neg_ = !r.neg_;
}

void Mpf::hi(Mpf& r, const Mpf& a, int cutLimbs) {
  const int prec = r.prec_;
  if (a.size_ == 0) {
    r.setZero();
    r.prec_ = prec;
    return;
  }
  cutLimbs = std::max(1, std::min(cutLimbs, a.size_));
  std::vector<uint32_t> mag(a.d_.begin() + (a.size_ - cutLimbs),
                            a.d_.begin() + a.size_);
  fromLimbs(r, std::move(mag), a.neg_, a.e_ + 32L * (a.size_ - cutLimbs), prec);
}

void Mpf::lo(Mpf& r, const Mpf& a, int cutLimbs) {
  const int prec = r.prec_;
  if (a.size_ == 0) {
    r.setZero();
    r.prec_ = prec;
    return;
  }
  cutLimbs = std::max(0, std::min(cutLimbs, a.size_));
  std::vector<uint32_t> mag(a.d_.begin(), a.d_.begin() + (a.size_ - cutLimbs));
  fromLimbs(r, std::move(mag), a.neg_, a.e_, prec);
}

/* --- COMPUTERGROUP --------------------------------------------------- */

void ComputerGroup::init(int ncomputer, int prec) {
  slots_.clear();
  slots_.resize((size_t)std::max(1, ncomputer));
  for (auto& s : slots_) s.setPrec(prec);
  ops_.clear();
  cReal_ = -1;
  cImag_ = -1;
}

void ComputerGroup::add(COp op, int dest, int in0, int in1) {
  Insn ins;
  ins.op = op;
  ins.dest = dest;
  ins.in0 = in0;
  ins.in1 = in1;
  ops_.push_back(ins);
}

void ComputerGroup::reset() {
  for (auto& s : slots_) {
    s.setZero();
    s.setPrecRaw(s.allocPrec());
  }
}

void ComputerGroup::setPrec(int bits) {
  for (auto& s : slots_) s.setPrec(bits);
}

void ComputerGroup::setRawPrec(int bits) {
  for (auto& s : slots_) s.setPrecRaw(bits);
}

void ComputerGroup::run() {
  Mpf t;
  for (const Insn& ins : ops_) {
    if (ins.dest < 0 || ins.dest >= (int)slots_.size()) continue;
    Mpf& d = slots_[(size_t)ins.dest];
    t.prec_ = d.prec();
    t.alloc_ = d.allocPrec();
    switch (ins.op) {
      case COp::Sqr:
        Mpf::sqr(t, slots_[(size_t)ins.in0]);
        break;
      case COp::Mul:
        Mpf::mul(t, slots_[(size_t)ins.in0], slots_[(size_t)ins.in1]);
        break;
      case COp::RealIter:
        Mpf::sub(t, slots_[(size_t)ins.in0], slots_[(size_t)ins.in1]);
        if (cReal_ >= 0) Mpf::add(t, t, slots_[(size_t)cReal_]);
        break;
      case COp::ImagIter2:
        Mpf::mul(t, slots_[(size_t)ins.in0], slots_[(size_t)ins.in1]);
        Mpf::mul2exp(t, t, 1);
        if (cImag_ >= 0) Mpf::add(t, t, slots_[(size_t)cImag_]);
        break;
      case COp::AddConst:
        if (cReal_ >= 0) Mpf::add(t, slots_[(size_t)ins.in0], slots_[(size_t)cReal_]);
        break;
      case COp::Neg:
        Mpf::neg(t, slots_[(size_t)ins.in0]);
        break;
    }
    t.prec_ = d.prec();
    d = t;
  }
}

}  // namespace mbc

namespace mbc {

bool precisionSelfTest(std::string& log) {
  bool ok = true;
  char buf[512];
  auto check = [&](bool cond, const char* name, const char* fmt, double v) {
    std::snprintf(buf, sizeof(buf), fmt, v);
    std::string line;
    line += cond ? "[prec] PASS " : "[prec] FAIL ";
    line += name;
    line += "  ";
    line += buf;
    line += "\n";
    log += line;
    std::fputs(line.c_str(), stdout);
    std::fflush(stdout);
    if (!cond) ok = false;
  };

  /* A. 基础算术（256 位，值都是 double 可精确表示的） */
  {
    Mpf a(256), b(256), r(256);
    a.setD(3.5);
    b.setD(-1.25);
    Mpf::add(r, a, b);
    check(std::fabs(r.toDouble() - 2.25) < 1e-15, "mpf_add", "3.5+(-1.25)=%.17g", r.toDouble());
    Mpf::sub(r, a, b);
    check(std::fabs(r.toDouble() - 4.75) < 1e-15, "mpf_sub", "3.5-(-1.25)=%.17g", r.toDouble());
    Mpf::mul(r, a, b);
    check(std::fabs(r.toDouble() + 4.375) < 1e-15, "mpf_mul", "3.5*(-1.25)=%.17g", r.toDouble());
    Mpf::mul2exp(r, a, -3);
    check(std::fabs(r.toDouble() - 0.4375) < 1e-15, "mpf_mul2exp", "3.5*2^-3=%.17g", r.toDouble());
  }

  /* A2. 十进制字符串：小数部分必须做定点除。朴素的整数除会把 0.332 变成 0，
   *     setStr() 曾经就是这样，参考轨道因此全为零而无人察觉。 */
  {
    Mpf x(256);
    x.setStr("0.332");
    check(std::fabs(x.toDouble() - 0.332) < 1e-15, "mpf_setstr_frac",
          "0.332 -> %.17g", x.toDouble());
    x.setStr("-0.743643887037158704752191506114774");
    check(std::fabs(x.toDouble() + 0.7436438870371587) < 1e-15,
          "mpf_setstr_long", "-0.7436... -> %.17g", x.toDouble());
    x.setStr("1e-20");
    check(std::fabs(x.toDouble() - 1e-20) < 1e-35, "mpf_setstr_exp",
          "1e-20 -> %.17g", x.toDouble());
    /* 30 位有效数字必须全部保留，否则深视点坐标会在拼接处断掉。 */
    x.setStr("0.123456789012345678901234567890");
    const double want = 0.123456789012345678901234567890;
    check(std::fabs(x.toDouble() - want) < 1e-17, "mpf_setstr_30digits",
          "%.17g", x.toDouble());
  }

  /* B. set_prec / set_prec_raw 语义：raw 不重分配，只改后续舍入位数 */
  {
    Mpf x(512);
    x.setD(1.0 / 3.0);
    const int alloc0 = x.allocPrec();
    x.setPrecRaw(128);
    const bool rawOk = x.allocPrec() == alloc0 && x.prec() == 128;
    Mpf y(128);
    Mpf::add(y, x, x);
    const bool roundOk = y.expBits() <= 128;
    x.setPrec(512);
    const bool growOk = x.allocPrec() == 512 && x.prec() == 512;
    check(rawOk && roundOk && growOk, "mpf_set_prec_raw",
          "raw(128)->alloc=%g", (double)x.allocPrec());
  }

  /* C. mpf_hi / mpf_lo：两段拼回去等于原值（600 位下精确） */
  {
    Mpf one(512), tiny(512), x(512), hi(600), lo(600), sum(600);
    one.setUi(1);
    tiny.setD(1.0);
    Mpf t2(512);
    Mpf::mul2exp(t2, tiny, -400);
    Mpf::add(x, one, t2);
    Mpf::hi(hi, x, 1);
    Mpf::lo(lo, x, 1);
    Mpf::add(sum, hi, lo);
    check(sum.compare(x) == 0, "mpf_hi_lo", "hi+lo-x=%.17g",
          sum.toDouble() - x.toDouble());
  }

  /* D. COMPUTERGROUP（iter 链）：与 Big 定点轨道逐步对比 */
  {
    const int bits = 320;
    const double cx = -0.75, cy = 0.0;
    ComputerGroup g;
    g.init(6, bits);
    g.slot(4).setD(cx);
    g.slot(5).setD(cy);
    g.setConstantSlots(4, 5);
    /* 顺序照抄 004f8d20 的链：先 sx=x²、sy=y²，再 ny=2xy+cy（读旧 x,y），
     * 最后 nx=sx-sy+cx。写成这样就不需要额外的交班槽。 */
    g.add(COp::Sqr, 2, 0, 0);
    g.add(COp::Sqr, 3, 1, 1);
    g.add(COp::ImagIter2, 1, 0, 1);
    g.add(COp::RealIter, 0, 2, 3);

    Big br = Big::fromDouble(0.0, bits), bi = Big::fromDouble(0.0, bits);
    const Big bcr = Big::fromDouble(cx, bits), bci = Big::fromDouble(cy, bits);
    double worst = 0.0;
    const int steps = 200;
    for (int n = 0; n < steps; ++n) {
      g.run();
      const Big zr2 = br.mul(br), zi2 = bi.mul(bi), zrzi = br.mul(bi);
      const Big nre = zr2.sub(zi2).add(bcr);
      const Big nim = zrzi.shifted(1).add(bci);
      br = nre;
      bi = nim;
      const double dr = std::fabs(g.slot(0).toDouble() - br.toDouble());
      const double di = std::fabs(g.slot(1).toDouble() - bi.toDouble());
      worst = std::max(worst, std::max(dr, di));
    }
    check(worst < 1e-12, "computergroup_orbit", "max|diff| vs Big @200 steps=%.3g",
          worst);
    std::snprintf(buf, sizeof(buf), "[prec] info computergroup ops=%d slots=%d\n",
                  g.ops(), g.size());
    log += buf;
    std::fputs(buf, stdout);
    std::fflush(stdout);
  }

  /* E. HF 原语：62 位尾数往返、复数平方、饱和 */
  {
    const HFloat a = hfFromDouble(0.1);
    const HFloat sq = hfMul(a, a);
    const double rel = std::fabs(hfToDouble(sq) - 0.1 * 0.1) / 0.01;
    check(rel < 1e-15, "hf_mul", "0.1^2 relerr=%.3g", rel);
    const HFComplex z = hfcFromDoubles(-0.75, 0.1);
    const HFComplex z2 = hfcSqr(z);
    double re = 0.0, im = 0.0;
    hfcToDoubles(z2, re, im);
    check(std::fabs(re - 0.5525) < 1e-16 && std::fabs(im + 0.15) < 1e-16,
          "hf_csqr", "(-0.75+0.1i)^2=(%.17g, %.17g)", re);
    HFloat s;
    s.m = kHfMax;
    s.e = kHfExpMax + 5;
    hfNorm(s);
    check(s.e == kHfExpMax, "hf_saturate", "exp=%.0f", (double)s.e);
  }

  /* F. 16384 位档：一次乘法的位数与耗时 */
  {
    Mpf p(16384), q(16384), r(16384), one(16384), tiny(16384);
    one.setUi(1);
    tiny.setD(1.0);
    Mpf::mul2exp(tiny, tiny, -16000);
    Mpf::add(p, one, tiny);
    Mpf::sub(q, one, tiny);
    const auto t0 = std::chrono::steady_clock::now();
    const int reps = 200;
    for (int i = 0; i < reps; ++i) Mpf::mul(r, p, q);
    const auto t1 = std::chrono::steady_clock::now();
    const double us = std::chrono::duration<double, std::micro>(t1 - t0).count() / reps;
    Mpf diff(16384);
    Mpf::sub(diff, p, one);
    /* 1 + 2^-16000 在 16384 位下不能被吞掉，才说明尾数真的到位。 */
    const bool bitsOk = !diff.isZero() && diff.expBits() < -15000;
    check(bitsOk, "mpf_16384", "diffExpBits=%g", (double)diff.expBits());
    std::snprintf(buf, sizeof(buf), "[prec] info mpf_mul@16384 = %.1f us/op\n", us);
    log += buf;
    std::fputs(buf, stdout);
    std::fflush(stdout);
  }

  /* G. Karatsuba 正确性：精确整数乘法（无舍入，可逐位比对） */
  {
    Mpf X(4200), Y(4200), Z(4200), E(4200), t(4200), t2(4200), t3(4200);
    X.setUi(3);
    t.setD(1.0);
    Mpf::mul2exp(t, t, 2048);
    Mpf::add(X, X, t);   // X = 2^2048 + 3
    Y.setUi(5);
    t2.setD(1.0);
    Mpf::mul2exp(t2, t2, 2048);
    Mpf::add(Y, Y, t2);  // Y = 2^2048 + 5
    Mpf::mul(Z, X, Y);   // = 2^4096 + 8*2^2048 + 15
    E.setUi(15);
    t3.setD(1.0);
    Mpf::mul2exp(t3, t3, 4096);
    Mpf::add(E, E, t3);
    t3.setD(8.0);
    Mpf::mul2exp(t3, t3, 2048);
    Mpf::add(E, E, t3);
    check(Z.compare(E) == 0, "karatsuba_exact", "2048bit product diff=%.3g",
          Z.toDouble() - E.toDouble());
  }

  /* H. 1K 位档的乘法耗时，便于看曲线 */
  {
    Mpf one(1024), tiny(1024), p(1024), q(1024), r(1024);
    one.setUi(1);
    tiny.setD(1.0);
    Mpf::mul2exp(tiny, tiny, -1000);
    Mpf::add(p, one, tiny);
    Mpf::sub(q, one, tiny);
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < 2000; ++i) Mpf::mul(r, p, q);
    const auto t1 = std::chrono::steady_clock::now();
    const double us = std::chrono::duration<double, std::micro>(t1 - t0).count() / 2000;
    std::snprintf(buf, sizeof(buf), "[prec] info mpf_mul@1024 = %.2f us/op\n", us);
    log += buf;
    std::fputs(buf, stdout);
    std::fflush(stdout);
  }

  return ok;
}

}  // namespace mbc
