#include "mb_precision.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace mbc {

namespace {
int msb32(uint32_t v) {
#if defined(_MSC_VER)
  unsigned long idx;
  _BitScanReverse(&idx, v);   // requires <intrin.h>
  return (int)idx;
#else
  int r = 31;
  while (r >= 0 && !(v & (1u << r))) --r;
  return r;
#endif
}

int topBit(uint32_t v) {
  if (!v) return -1;
#if defined(_MSC_VER)
  unsigned long idx;
  _BitScanReverse(&idx, v);
  return (int)idx;
#else
  int r = 31;
  while (r >= 0 && !(v & (1u << r))) --r;
  return r;
#endif
}
}  // namespace

void Big::normalize() {
  while (!limbs_.empty() && limbs_.back() == 0) limbs_.pop_back();
  if (limbs_.empty()) neg_ = false;
}

int Big::cmpMag(const std::vector<uint32_t>& a, const std::vector<uint32_t>& b) {
  if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
  for (size_t i = a.size(); i-- > 0;) {
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

std::vector<uint32_t> Big::addMag(const std::vector<uint32_t>& a,
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

std::vector<uint32_t> Big::subMag(const std::vector<uint32_t>& a,
                                  const std::vector<uint32_t>& b) {
  // a >= b assumed
  std::vector<uint32_t> r(a.size(), 0);
  uint64_t borrow = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    uint64_t av = a[i];
    uint64_t bv = (i < b.size() ? b[i] : 0) + borrow;
    if (av >= bv) { r[i] = (uint32_t)(av - bv); borrow = 0; }
    else { r[i] = (uint32_t)(av + 0x100000000ull - bv); borrow = 1; }
  }
  return r;
}

void Big::mulSmall(uint32_t k) {
  uint64_t carry = 0;
  for (size_t i = 0; i < limbs_.size(); ++i) {
    uint64_t v = (uint64_t)limbs_[i] * k + carry;
    limbs_[i] = (uint32_t)v;
    carry = v >> 32;
  }
  if (carry) limbs_.push_back((uint32_t)carry);
}

void Big::divSmall(uint32_t k) {
  uint64_t rem = 0;
  for (size_t i = limbs_.size(); i-- > 0;) {
    uint64_t cur = rem * 0x100000000ull + limbs_[i];
    limbs_[i] = (uint32_t)(cur / k);
    rem = cur % k;
  }
  normalize();
}

Big Big::fromMantissa(uint64_t mant, long long shift, bool neg, int frac) {
  Big r(frac);
  if (!mant) return r;
  if (shift < 0) {
    long long k = -shift;
    if (k >= 64) return r;
    if (k > 0) {
      uint64_t half = (k >= 1) ? (1ull << (k - 1)) : 0;
      mant = (mant + half) >> k;
      if (!mant) return r;
    }
    shift = 0;
  }
  const int word = (int)(shift >> 5);
  const int bit = (int)(shift & 31);
  auto addAt = [&](int idx, uint32_t v) {
    while (v) {
      if ((int)r.limbs_.size() <= idx) r.limbs_.resize(idx + 1, 0);
      uint64_t s = (uint64_t)r.limbs_[idx] + v;
      r.limbs_[idx] = (uint32_t)s;
      v = (uint32_t)(s >> 32);
      ++idx;
    }
  };
  const uint32_t lo = (uint32_t)(mant & 0xffffffffull);
  const uint32_t hi = (uint32_t)(mant >> 32);
  uint64_t loShift = (uint64_t)lo << bit;
  addAt(word, (uint32_t)loShift);
  addAt(word + 1, (uint32_t)(loShift >> 32));
  uint64_t hiShift = (uint64_t)hi << bit;
  addAt(word + 1, (uint32_t)hiShift);
  addAt(word + 2, (uint32_t)(hiShift >> 32));
  r.neg_ = neg;
  r.normalize();
  return r;
}

Big Big::fromInteger(long long v, int frac) {
  const bool n = v < 0;
  uint64_t m = n ? (uint64_t)(-v) : (uint64_t)v;
  return fromMantissa(m, frac, n, frac);
}

Big Big::fromDouble(double v, int frac) {
  Big r(frac);
  if (!std::isfinite(v) || v == 0.0) return r;
  uint64_t bits;
  std::memcpy(&bits, &v, 8);
  const bool neg = (bits >> 63) != 0;
  const int exp = (int)((bits >> 52) & 0x7ff);
  uint64_t mant = bits & 0x000fffffffffffffull;
  if (exp == 0) mant = mant;                       // subnormal (not used in practice)
  else mant |= 0x0010000000000000ull;
  long long shift = (long long)(exp ? exp - 1023 : -1022) - 52 + frac;
  return fromMantissa(mant, shift, neg, frac);
}

Big Big::fromString(const std::string& src, int frac) {
  std::string s;
  s.reserve(src.size());
  for (char c : src) if (!std::isspace((unsigned char)c)) s.push_back(c);
  if (s.empty()) return Big(frac);

  bool neg = false;
  size_t p = 0;
  if (s[p] == '+' || s[p] == '-') { neg = s[p] == '-'; ++p; }

  long long exp10 = 0;
  std::string digits;
  int fracDigits = 0;
  bool dot = false;
  for (; p < s.size(); ++p) {
    char c = s[p];
    if (c >= '0' && c <= '9') {
      digits.push_back(c);
      if (dot) ++fracDigits;
    } else if (c == '.') {
      dot = true;
    } else if (c == 'e' || c == 'E') {
      exp10 = std::strtoll(s.c_str() + p + 1, nullptr, 10);
      break;
    } else {
      break;
    }
  }
  if (digits.empty()) return Big(frac);
  exp10 -= fracDigits;

  // value = digits * 10^exp10 ; carry 64 guard bits so the decimal
  // division rounds well below the fixed-point resolution.
  const int guard = 64;
  std::vector<uint32_t> d;
  for (char c : digits) {
    uint32_t k = (uint32_t)(c - '0');
    uint64_t carry = k;
    for (size_t i = 0; i < d.size(); ++i) {
      uint64_t v = (uint64_t)d[i] * 10ull + carry;
      d[i] = (uint32_t)v;
      carry = v >> 32;
    }
    if (carry) d.push_back((uint32_t)carry);
  }

  Big r(frac);
  r.limbs_ = d;
  r.neg_ = neg;
  // multiply by 2^(frac+guard)
  Big scaled(frac);
  {
    // left shift limbs by (frac+guard)
    const int total = frac + guard;
    const int word = total >> 5;
    const int bit = total & 31;
    scaled.limbs_.assign(d.size() + word + 1, 0);
    for (size_t i = 0; i < d.size(); ++i) {
      uint64_t v = (uint64_t)d[i] << bit;
      scaled.limbs_[i + word] |= (uint32_t)v;
      scaled.limbs_[i + word + 1] |= (uint32_t)(v >> 32);
    }
  }
  // apply 10^exp10
  if (exp10 >= 0) {
    const int n = (int)std::min<long long>(exp10, 4000);
    for (int i = 0; i < n; ++i) scaled.mulSmall(10);
  } else {
    const int n = (int)std::min<long long>(-exp10, 40000);
    for (int i = 0; i < n; ++i) scaled.divSmall(10);
  }
  // drop guard bits with rounding
  r = scaled.shifted(-guard);
  r.frac_ = frac;
  r.neg_ = neg;
  r.normalize();
  return r;
}

Big Big::negated() const {
  Big r = *this;
  if (!r.limbs_.empty()) r.neg_ = !r.neg_;
  return r;
}

Big Big::add(const Big& o) const {
  Big b = o;
  if (b.frac_ != frac_) {
    // Re-express b on this grid: value must not change.
    const int d = frac_ - b.frac_;
    // b.limbs * 2^d, then interpret with frac_
    b = b.shifted(d);
    b.frac_ = frac_;
  }
  Big r(frac_);
  if (neg_ == b.neg_) {
    r.limbs_ = addMag(limbs_, b.limbs_);
    r.neg_ = neg_;
  } else {
    int c = cmpMag(limbs_, b.limbs_);
    if (c == 0) return Big(frac_);
    if (c > 0) { r.limbs_ = subMag(limbs_, b.limbs_); r.neg_ = neg_; }
    else { r.limbs_ = subMag(b.limbs_, limbs_); r.neg_ = b.neg_; }
  }
  r.normalize();
  return r;
}

Big Big::sub(const Big& o) const { return add(o.negated()); }

Big Big::mul(const Big& o) const {
  if (limbs_.empty() || o.limbs_.empty()) return Big(frac_);
  std::vector<uint32_t> prod(limbs_.size() + o.limbs_.size(), 0);
  for (size_t i = 0; i < limbs_.size(); ++i) {
    uint64_t carry = 0;
    const uint64_t ai = limbs_[i];
    for (size_t j = 0; j < o.limbs_.size(); ++j) {
      uint64_t cur = (uint64_t)prod[i + j] + ai * (uint64_t)o.limbs_[j] + carry;
      prod[i + j] = (uint32_t)cur;
      carry = cur >> 32;
    }
    size_t k = i + o.limbs_.size();
    while (carry) {
      if (k >= prod.size()) prod.push_back(0);
      uint64_t cur = (uint64_t)prod[k] + carry;
      prod[k] = (uint32_t)cur;
      carry = cur >> 32;
      ++k;
    }
  }
  Big p(frac_);
  p.limbs_ = std::move(prod);
  p.neg_ = neg_ != o.neg_;
  p.normalize();
  Big q = p.shifted(-frac_);       // M1*M2*2^-2f  ->  *2^-f
  q.neg_ = p.neg_;
  q.normalize();
  return q;
}

int Big::compare(const Big& o) const {
  const bool az = limbs_.empty(), bz = o.limbs_.empty();
  if (az && bz) return 0;
  if (!az && bz) return neg_ ? -1 : 1;
  if (az && !bz) return o.neg_ ? 1 : -1;
  if (neg_ != o.neg_) return neg_ ? -1 : 1;
  const int c = cmpMag(limbs_, o.limbs_);
  return neg_ ? -c : c;
}

Big Big::shifted(int bits) const {
  Big r(frac_);
  r.neg_ = neg_;
  if (bits == 0 || limbs_.empty()) return *this;
  const size_t n = limbs_.size();
  if (bits > 0) {
    const int word = bits >> 5;
    const int bit = bits & 31;
    r.limbs_.assign(n + word + 1, 0);
    for (size_t i = 0; i < n; ++i) {
      uint64_t v = (uint64_t)limbs_[i] << bit;
      r.limbs_[i + word] |= (uint32_t)v;
      r.limbs_[i + word + 1] |= (uint32_t)(v >> 32);
    }
  } else {
    const int k = -bits;
    const int word = k >> 5;
    const int bit = k & 31;
    std::vector<uint32_t> tmp = limbs_;
    if (bit) {
      // round to nearest
      uint64_t carry = 1ull << (bit - 1);
      for (size_t i = 0; i < tmp.size() && carry; ++i) {
        uint64_t v = (uint64_t)tmp[i] + carry;
        tmp[i] = (uint32_t)v;
        carry = v >> 32;
      }
      if (carry) tmp.push_back((uint32_t)carry);
    }
    if (word >= (int)tmp.size()) return Big(frac_);
    r.limbs_.assign(tmp.size() - word, 0);
    for (size_t i = word; i < tmp.size(); ++i) {
      uint32_t lo = tmp[i] >> bit;
      uint32_t hi = (i + 1 < tmp.size() && bit) ? (tmp[i + 1] << (32 - bit)) : 0;
      r.limbs_[i - word] = lo | hi;
    }
  }
  r.normalize();
  return r;
}

double Big::toDouble() const {
  if (limbs_.empty()) return 0.0;
  const int h = (int)limbs_.size() - 1;
  const int s = std::max(0, h - 2);
  double d = 0.0;
  for (int i = h; i >= s; --i) d = d * 4294967296.0 + (double)limbs_[i];
  const int exp = 32 * s - frac_;
  d = std::ldexp(d, exp);
  return neg_ ? -d : d;
}

void Big::toDoublePair(double& hi, double& lo) const {
  hi = toDouble();
  Big rem = sub(fromDouble(hi, frac_));
  lo = rem.toDouble();
}

int Big::bitLength() const {
  if (limbs_.empty()) return 0;
  const int h = (int)limbs_.size() - 1;
  return h * 32 + topBit(limbs_[h]) + 1;
}

}  // namespace mbc
