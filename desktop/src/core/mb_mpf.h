// ------------------------------------------------------------------
// mb_mpf.h — a variable-precision float with GMP `mpf_t` semantics, plus the
// original's COMPUTER / COMPUTERGROUP iteration chain (pseudocode 004f8160 /
// 004f8d20 / 004fc9e0 / 004fca50).
//
// The design only covers what the reference orbit needs: init2 / set / set_ui /
// set_d / set_prec / set_prec_raw / add / sub / mul / sqr / mul_2exp / cmp /
// get_d, plus the mpf_hi / mpf_lo view semantics.  The bit exponent is counted
// in bits (GMP counts limbs), and every value is normalised to
// value = (-1)^neg * M * 2^e with the top bit of M set.
//
// Key semantics (identical to GMP, not approximated):
//   set_prec(p)      — reallocates, rounding the value to the new precision;
//   set_prec_raw(p)  — does not reallocate, only rewrites _mp_prec; requires
//                      p <= allocPrec().  Later operations round to p bits,
//                      which is exactly how the original steps precision down
//                      as the orbit advances.
// ------------------------------------------------------------------
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mbc {

class Mpf {
 public:
  Mpf() = default;
  explicit Mpf(int precBits) : prec_(precBits), alloc_(precBits) {}

  // --- GMP: mpf_set_prec / mpf_set_prec_raw / mpf_init2
  void setPrec(int bits);
  void setPrecRaw(int bits);
  int prec() const { return prec_; }
  int allocPrec() const { return alloc_; }

  void setZero();
  void setUi(uint64_t v);
  void setD(double v);
  void setStr(const std::string& s);
  void set(const Mpf& o) { *this = o; }
  double toDouble() const;
  bool isZero() const { return size_ == 0; }
  bool isNeg() const { return neg_; }
  int sgn() const { return size_ == 0 ? 0 : (neg_ ? -1 : 1); }
  int compare(const Mpf& o) const;
  int cmpAbs(const Mpf& o) const;
  int expBits() const;  // floor(log2 |v|) + 1; zero gives 0

  // --- GMP: mpf_add / sub / mul / sqr / mul_2exp / neg
  static void add(Mpf& r, const Mpf& a, const Mpf& b);
  static void sub(Mpf& r, const Mpf& a, const Mpf& b);
  static void mul(Mpf& r, const Mpf& a, const Mpf& b);
  static void sqr(Mpf& r, const Mpf& a) { mul(r, a, a); }
  static void mul2exp(Mpf& r, const Mpf& a, long bits);
  static void neg(Mpf& r, const Mpf& a);

  // --- GMP: mpf_hi / mpf_lo (high/low view of the same limb array)
  static void hi(Mpf& r, const Mpf& a, int cutLimbs);
  static void lo(Mpf& r, const Mpf& a, int cutLimbs);

  // Raw leading limb of the exponent and magnitude limbs, for the Boost.Math
  // bridge (no lossy double conversion).
  long limbExponent() const { return e_; }
  const std::vector<uint32_t>& limbs() const { return d_; }

 private:
  friend class ComputerGroup;
  std::vector<uint32_t> d_;  // little-endian magnitude
  int size_ = 0;             // limb count; 0 means zero
  bool neg_ = false;
  long e_ = 0;               // bit exponent: |v| = sum d_[i] * 2^(e_ + 32*i)
  int prec_ = 64;
  int alloc_ = 64;

  void trim();
  void roundToPrec(int bits);
  void mulSmall(uint32_t k);
  void divSmall(uint32_t k);
  void addSmall(uint32_t k);
  static void toAligned(const Mpf& a, long e, std::vector<uint32_t>& out);
  static void fromLimbs(Mpf& r, std::vector<uint32_t>&& mag, bool neg, long e,
                        int prec);
};

// ------------------------------------------------------------------
// COMPUTER / COMPUTERGROUP: the original splits one Mandelbrot iteration into
// several COMPUTERs, each an mpf instruction (004f4f90..004f5b70), executed in
// dependency order inside the group (004f8d20 `iter`).  The multithreaded
// inputwait scheduling belongs to the original's executor; here the instruction
// semantics and order are kept, the thread scheduling is not.
// ------------------------------------------------------------------
enum class COp {
  Sqr,        // d[0] = d[0]^2                      (__sqrcomputer)
  Mul,        // d[0] = d[0] * in[0]                (__mulcomputer)
  RealIter,   // d[0] = in[0] - in[1]; d[0] += c    (__realitercomputer)
  ImagIter2,  // d[0] = in[0] * in[1]; <<= 1; += c  (__imagitercomputer2)
  AddConst,   // d[0] += c                        (the "+1" in derivative chains)
  Neg,        // d[0] = -d[0]                      (the subtract term in derivative chains)
};

class ComputerGroup {
 public:
  // Corresponds to initcomputergroup(context, group, ncomputer, prec)
  void init(int ncomputer, int prec);
  // Append one instruction: dest = op(in0, in1); RealIter/ImagIter2 take the
  // constant from cSlot
  void add(COp op, int dest, int in0, int in1);
  // RealIter adds cx, ImagIter2 adds cy (constant slots local to the group)
  void setConstantSlots(int realSlot, int imagSlot) {
    cReal_ = realSlot;
    cImag_ = imagSlot;
  }
  void reset();                       // resetcomputergroup: set_ui(0) everywhere

  void setPrec(int bits);             // computergroupsetprecision (reallocates)
  void setRawPrec(int bits);          // computergroupsetrawprecision (in place)

  Mpf& slot(int i) { return slots_[(size_t)i]; }
  const Mpf& slot(int i) const { return slots_[(size_t)i]; }
  int size() const { return (int)slots_.size(); }
  int ops() const { return (int)ops_.size(); }

  // Run the instruction list once (one Mandelbrot iteration).  The constant c
  // lives in slot cSlot.
  void run();

 private:
  struct Insn {
    COp op;
    int dest;
    int in0, in1;
  };
  std::vector<Mpf> slots_;
  std::vector<Insn> ops_;
  int cReal_ = -1;
  int cImag_ = -1;
};

}  // namespace mbc

namespace mbc {
// Precision-library self-test: the mpf chain / set_prec_raw / mpf_hi·lo /
// COMPUTERGROUP / HF primitives.  Triggered by MB_PREC_TEST=1 (callable from
// the bench and the shell); returns whether everything passed.
bool precisionSelfTest(std::string& log);
}  // namespace mbc
