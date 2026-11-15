// BigFloat — arbitrary-precision decimal floating point, base 10^9.
//
// Representation:  value = sign * M * 10^s
//   * M is a little-endian limb vector in base 10^9, most significant limb nonzero.
//   * s is a multiple of 9 (so all numbers share decimal limb boundaries).
//   * precision is a thread-local limb budget; every arithmetic result is
//     truncated (not rounded) to the most significant `precision_limbs` limbs.
//
// The base-10^9 choice is deliberate: decimal input/output is exact O(n),
// and the precision planner can map zoom decades directly onto a limb budget.
// Multiplication uses schoolbook + Karatsuba above a small threshold.
//
// Part of the Retinamandelbrot reconstruction.  See docs/MATH.md.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

class BigFloat {
public:
    using limb_t = uint32_t;
    static constexpr limb_t BASE = 1000000000u;
    static constexpr int LIMB_DIGITS = 9;

    int sign = 0;                  // -1, 0, +1
    std::vector<limb_t> m;         // little-endian base 10^9
    int64_t s = 0;                 // value = sign * M * 10^s, s multiple of 9

    // Limb budget for all operations on this thread.  Set by the precision
    // planner before a reference orbit is built.
    static thread_local int precision_limbs;

    BigFloat() = default;
    explicit BigFloat(int64_t v);
    BigFloat(double v);

    static BigFloat from_string(const std::string& text);
    static BigFloat from_double(double v);
    static BigFloat from_floatexp(double mantissa, int64_t exp10);

    bool is_zero() const { return sign == 0 || m.empty(); }
    bool is_negative() const { return sign < 0; }

    double to_double() const;
    // value = mantissa * 10^exp10 with |mantissa| in [1,10)
    void to_floatexp(double& mantissa, int64_t& exp10) const;
    // decimal exponent of the leading digit
    int64_t magnitude_exp10() const;

    std::string to_scientific(int max_digits = 40) const;
    std::string to_fixed(int decimals = 20) const;

    BigFloat operator-() const;
    BigFloat abs() const;

    BigFloat add(const BigFloat& other) const;
    BigFloat sub(const BigFloat& other) const;
    BigFloat mul(const BigFloat& other) const;
    BigFloat mul_ui(uint32_t k) const;

    int compare_abs(const BigFloat& other) const;
    int compare(const BigFloat& other) const;

    void truncate_to_precision();
    void normalize();

private:
    void trim_high();
    void trim_low();
    void make_scale_multiple_of_nine();
    static std::vector<limb_t> mul_mag(const std::vector<limb_t>& a,
                                       const std::vector<limb_t>& b);
};

BigFloat operator+(const BigFloat& a, const BigFloat& b);
BigFloat operator-(const BigFloat& a, const BigFloat& b);
BigFloat operator*(const BigFloat& a, const BigFloat& b);
bool operator==(const BigFloat& a, const BigFloat& b);
bool operator<(const BigFloat& a, const BigFloat& b);
