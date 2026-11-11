// ------------------------------------------------------------------
// mb_precision.h — fixed-point arbitrary-precision value used by the
// reference-orbit builder.
//
// Value = sign * M * 2^-fracBits, with M held in 32-bit limbs.
// Only the operations the Mandelbrot reference orbit needs are
// implemented (add / sub / mul / exact shifts / decimal parse), so the
// type stays small, portable and testable outside the shell.
// ------------------------------------------------------------------
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mbc {

class Big {
public:
  Big() : frac_(128) {}
  explicit Big(int fracBits) : frac_(fracBits) {}

  static Big fromString(const std::string& s, int fracBits);
  static Big fromDouble(double v, int fracBits);
  static Big fromInteger(long long v, int fracBits);

  bool isZero() const { return limbs_.empty(); }
  bool isNegative() const { return neg_; }
  int fracBits() const { return frac_; }

  Big negated() const;
  Big add(const Big& o) const;
  Big sub(const Big& o) const;
  Big mul(const Big& o) const;
  int compare(const Big& o) const;     // -1, 0, 1
  Big shifted(int bits) const;         // multiply by 2^bits (negative = divide, rounded)

  double toDouble() const;
  void toDoublePair(double& hi, double& lo) const;

  int bitLength() const;               // index of the most significant bit + 1

private:
  std::vector<uint32_t> limbs_;        // little-endian magnitude
  bool neg_ = false;
  int frac_ = 128;

  void normalize();
  void mulSmall(uint32_t k);
  void divSmall(uint32_t k);
  static Big fromMantissa(uint64_t mant, long long shift, bool neg, int frac);
  static int cmpMag(const std::vector<uint32_t>& a, const std::vector<uint32_t>& b);
  static std::vector<uint32_t> addMag(const std::vector<uint32_t>& a,
                                      const std::vector<uint32_t>& b);
  static std::vector<uint32_t> subMag(const std::vector<uint32_t>& a,
                                      const std::vector<uint32_t>& b);
};

}  // namespace mbc
