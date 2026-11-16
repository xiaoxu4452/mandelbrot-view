// gmp_bridge — runtime binding to the system GMP (libgmp-10.dll).
//
// Why
// ---
// The reference orbit is the only part of the renderer whose cost grows with
// zoom depth: at 10^6000 the anchor needs ~20 000 bits, and the hand-written
// BigFloat multiplies in base 10^9 with Karatsuba plus an O(n) erase per
// truncated limb.  Measured: 4000 digits, 4000 steps = 2.7 s per orbit, and it
// grows as digits^1.6.  GMP is assembly, has no per-operation allocation, and
// switches to Toom/FFT for large operands, so the same orbit costs a fraction
// of that.
//
// GMP is *not* linked at build time.  The DLL ships next to the executable
// (new/dist/libgmp-10.dll, taken from the desktop build) and is looked up at
// runtime; when it is absent everything still works, just through BigFloat.
//
// The wrapper never looks inside `__mpf_struct`: GMP's layout on Win64 is
// 24 bytes (int prec, int size, long exp, limb*), and we allocate 32 with
// 16-byte alignment so a differently-built DLL still fits.  Every field is
// reached through the API.
#pragma once

#include <cstdint>
#include <string>

namespace gmpb {

/** True once the DLL is loaded and every entry point below is resolved. */
bool available();

/** Reason the last load attempt failed (empty when available()). */
const char* error();

/** Version string reported by the DLL, e.g. "6.3.0". */
const char* version();

/** Path the DLL was loaded from (empty when unavailable). */
const char* path();

/**
 * One arbitrary-precision float, as an opaque handle.  It owns a limb array
 * inside the DLL, so it must not be copied; the orbit builder keeps a fixed
 * set of them for the whole loop.
 */
struct Mpf {
    alignas(16) unsigned char raw[32];
};

void init(Mpf& v, int bits);
void clear(Mpf& v);
int prec(const Mpf& v);

void set_str(Mpf& v, const std::string& decimal);
void set_d(Mpf& v, double x);
void set_ui(Mpf& v, unsigned long x);
void set(Mpf& r, const Mpf& a);

void add(Mpf& r, const Mpf& a, const Mpf& b);
void sub(Mpf& r, const Mpf& a, const Mpf& b);
void mul(Mpf& r, const Mpf& a, const Mpf& b);
void div(Mpf& r, const Mpf& a, const Mpf& b);
void mul_2exp(Mpf& r, const Mpf& a, unsigned long bits);

int cmp_d(const Mpf& a, double d);
/** Exact three-way comparison of two high-precision values. */
int cmp(const Mpf& a, const Mpf& b);
double get_d(const Mpf& a);

/** value = mantissa * 2^exp with |mantissa| in [0.5,1); returns the mantissa.
 *  O(1): reads the top limbs only. */
double get_d_2exp(int32_t* exp2, const Mpf& a);

/** Plain decimal text with `digits` significant digits, e.g. "-0.7436438870". */
std::string to_decimal(const Mpf& a, int digits);

/** RAII owner; the orbit builder holds a handful of these per thread. */
class Num {
 public:
    Num() = default;
    explicit Num(int bits) {
        gmpb::init(v, bits);
        live_ = true;
    }
    ~Num();
    Num(const Num&) = delete;
    Num& operator=(const Num&) = delete;
    Num(Num&&) = delete;
    Num& operator=(Num&&) = delete;

    Mpf v;

 private:
    bool live_ = false;
};

}  // namespace gmpb
