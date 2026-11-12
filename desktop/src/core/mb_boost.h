// ------------------------------------------------------------------
// mb_boost.h — Boost.Math / Boost.Multiprecision bridge.
//
// The desktop reference orbit is produced by mbc::Big (fixed point) and
// mbc::Mpf (GMP-style floating point).  This module re-computes the same
// orbits with Boost.Multiprecision's cpp_bin_float at 800 decimal digits
// (≈2658 bits) and converts the native limbs exactly (no double round-trip),
// so the deep path is checked against an independent implementation.
//
// It also validates the 10-bit colour contract: 1024 levels per channel =
// 1024^3 = 1,073,741,824 addressable colours, packed exactly like
// GL_RGB10_A2 / GL_UNSIGNED_INT_2_10_10_10_REV.
//
// Triggered by MB_BOOSTCHECK=1 (mb_bench) or the shell's diagnostics.
// ------------------------------------------------------------------
#pragma once

#include <string>

namespace mbc {

// Returns true when every check passes.  `log` receives a multi-line report.
bool boostSelfTest(std::string& log);

}  // namespace mbc
