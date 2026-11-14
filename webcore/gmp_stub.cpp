// gmp_stub — wasm32-wasi stand-in for gmp_bridge.cpp.
//
// The desktop core selects its reference-orbit backend at runtime:
//   want_gmp = pin==1 ? gmpb::available()
//            : pin==0 ? false
//            : (!gmp_disabled() && digits>=min && gmpb::available())
// The web adapter pins backend 0 (self-contained BigFloat) before every
// render, and available() below is hard false, so orbit_gmp() is never
// entered. Every function here still exists so reference.cpp links.
// Behaviour is identical to the desktop build with the GMP DLL absent —
// the exact backend the B2 oracle tests were validated against.

#include "gmp_bridge.hpp"

namespace gmpb {

bool available() { return false; }
const char* error() { return "wasm build: GMP disabled, BigFloat backend"; }
const char* version() { return ""; }
const char* path() { return ""; }

void init(Mpf&, int) {}
void clear(Mpf&) {}
int prec(const Mpf&) { return 0; }

void set_str(Mpf&, const std::string&) {}
void set_d(Mpf&, double) {}
void set_ui(Mpf&, unsigned long) {}
void set(Mpf&, const Mpf&) {}

void add(Mpf&, const Mpf&, const Mpf&) {}
void sub(Mpf&, const Mpf&, const Mpf&) {}
void mul(Mpf&, const Mpf&, const Mpf&) {}
void div(Mpf&, const Mpf&, const Mpf&) {}
void mul_2exp(Mpf&, const Mpf&, unsigned long) {}

int cmp_d(const Mpf&, double) { return 0; }
int cmp(const Mpf&, const Mpf&) { return 0; }
double get_d(const Mpf&) { return 0.0; }

double get_d_2exp(int32_t* exp2, const Mpf&) {
    if (exp2) *exp2 = 0;
    return 0.0;
}

std::string to_decimal(const Mpf&, int) { return "0"; }

Num::~Num() {}

}  // namespace gmpb
