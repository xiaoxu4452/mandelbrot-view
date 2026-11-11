// ------------------------------------------------------------------
// mb_mpf.h — GMP `mpf_t` 语义的可变精度浮点，加上原版的 COMPUTER /
// COMPUTERGROUP 迭代链（伪代码 004f8160 / 004f8d20 / 004fc9e0 / 004fca50）。
//
// 设计只覆盖参考轨道需要的部分：init2 / set / set_ui / set_d / set_prec /
// set_prec_raw / add / sub / mul / sqr / mul_2exp / cmp / get_d，以及
// mpf_hi / mpf_lo 的视图语义。位指数用「位」为单位（GMP 用 limb），
// 数值统一规格化成 value = (-1)^neg * M * 2^e，M 的最高位为 1。
//
// 关键语义（和 GMP 一致，不是近似）：
//   set_prec(p)      —— 会重新分配，值按新精度舍入；
//   set_prec_raw(p)  —— 不重新分配，只改 _mp_prec；要求 p <= allocPrec()。
//                       之后参与运算时按 p 位舍入，这正是原版在轨道推进中
//                       逐步降精度的手段。
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
  int expBits() const;  // floor(log2 |v|) + 1；零为 0

  // --- GMP: mpf_add / sub / mul / sqr / mul_2exp / neg
  static void add(Mpf& r, const Mpf& a, const Mpf& b);
  static void sub(Mpf& r, const Mpf& a, const Mpf& b);
  static void mul(Mpf& r, const Mpf& a, const Mpf& b);
  static void sqr(Mpf& r, const Mpf& a) { mul(r, a, a); }
  static void mul2exp(Mpf& r, const Mpf& a, long bits);
  static void neg(Mpf& r, const Mpf& a);

  // --- GMP: mpf_hi / mpf_lo（同一条 limb 数组的高/低段视图语义）
  static void hi(Mpf& r, const Mpf& a, int cutLimbs);
  static void lo(Mpf& r, const Mpf& a, int cutLimbs);

 private:
  friend class ComputerGroup;
  std::vector<uint32_t> d_;  // 小端 magnitude
  int size_ = 0;             // limb 数，0 表示零
  bool neg_ = false;
  long e_ = 0;               // 位指数：|v| = sum d_[i] * 2^(e_ + 32*i)
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
// COMPUTER / COMPUTERGROUP：原版把一次曼德博迭代拆成若干 COMPUTER，
// 每个 COMPUTER 是一条 mpf 指令（004f4f90..004f5b70），组内按依赖顺序执行
// （004f8d20 `iter`）。多线程的 inputwait 调度属于原版的执行器，这里保留
// 指令语义和顺序，去掉线程调度。
// ------------------------------------------------------------------
enum class COp {
  Sqr,        // d[0] = d[0]^2                      (__sqrcomputer)
  Mul,        // d[0] = d[0] * in[0]                (__mulcomputer)
  RealIter,   // d[0] = in[0] - in[1]; d[0] += c    (__realitercomputer)
  ImagIter2,  // d[0] = in[0] * in[1]; <<= 1; += c  (__imagitercomputer2)
  AddConst,   // d[0] += c                        （求导链里 "+1" 用）
  Neg,        // d[0] = -d[0]                      （求导链的减项）
};

class ComputerGroup {
 public:
  // 对应 initcomputergroup(context, group, ncomputer, prec)
  void init(int ncomputer, int prec);
  // 追加一条指令：dest = op(in0, in1)；RealIter/ImagIter2 的常量取 cSlot
  void add(COp op, int dest, int in0, int in1);
  // RealIter 加 cx、ImagIter2 加 cy（原版是组内常量槽）
  void setConstantSlots(int realSlot, int imagSlot) {
    cReal_ = realSlot;
    cImag_ = imagSlot;
  }
  void reset();                       // resetcomputergroup：全部 set_ui(0)

  void setPrec(int bits);             // computergroupsetprecision（重分配）
  void setRawPrec(int bits);          // computergroupsetrawprecision（原地）

  Mpf& slot(int i) { return slots_[(size_t)i]; }
  const Mpf& slot(int i) const { return slots_[(size_t)i]; }
  int size() const { return (int)slots_.size(); }
  int ops() const { return (int)ops_.size(); }

  // 执行一遍指令（一次曼德博迭代）。常量 c 存在 slot cSlot 里。
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
// 精度库自测：mpf 链 / set_prec_raw / mpf_hi·lo / COMPUTERGROUP / HF 原语。
// 由 MB_PREC_TEST=1 触发（bench 与 shell 都可调），返回是否全部通过。
bool precisionSelfTest(std::string& log);
}  // namespace mbc
