// ---------------------------------------------------------------------------
// expr.hpp — an applied-mathematics expression language for fractal iteration.
//
//   z, c, n, z1        current value, constant term, iteration index, previous z
//   i, pi, e, tau, phi constants
//   any single letter  parameter (slider), except the reserved ones above
//
//   + - * / ^ %   unary + -   implicit multiplication (2z, 3(z+1), 2sin(z))
//   comparisons < <= > >= == !=   ternary cond ? a : b   logical && || !
//
//   sin cos tan cot sec csc      asin acos atan      asinh acosh atanh
//   sinh cosh tanh               exp exp2 exp10      log ln log2 log10
//   sqrt cbrt                    abs abs2 norm arg phase conj re im
//   floor ceil round trunc frac sign
//   pow(a,b) root(a,n) min(a,b) max(a,b) mod(a,b) hypot(a,b) atan2(y,x)
//   logb(x,b) clamp(x,lo,hi) if(cond,a,b)
//   sum(k,a,b,body) prod(k,a,b,body)          (k is a bound loop variable)
//
// The source is tokenised, parsed by recursive descent into a postfix program
// and evaluated on mx::BC (arbitrary-precision complex).  Compilation reports
// position-aware errors, which is what the formula panel shows the user.
//
// Two evaluators share one program:
//   run()      the value, nothing else
//   evalJet()  the value plus its first and second derivatives at the current
//              point, in Wirtinger form (see mx::Jet).  This is what the deep
//              renderer integrates: the coefficients come from differentiating
//              the expression itself, so a frame at 1e120 is as exact as one at
//              1e2 and a formula that is not holomorphic (conj, re, abs, ...)
//              still gets the right linear term.
//
// Evaluation is total: division by zero is zero, log(0) is zero, exp clamps.
// One divergent pixel must not abort a frame; the escape test classifies it.
// ---------------------------------------------------------------------------
#pragma once

#include "complex.hpp"

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace mx {

struct ExprError : std::runtime_error {
    size_t pos = 0;
    ExprError(const std::string& msg, size_t p)
        : std::runtime_error(msg), pos(p) {}
};

/* Second-order Taylor data at one point, in Wirtinger form.
 *
 *   v     f(z, zbar)
 *   dz    df/dz                     dzb  df/dzbar
 *   dzz   (1/2) d2f/dz2             dzzb d2f/dz dzbar       dzbb (1/2) d2f/dzbar2
 *   dc    df/dc
 *
 * For a holomorphic expression dzb, dzzb and dzbb are exactly zero, and the
 * renderer takes the two-term fast path.  Non-holomorphic primitives (conj,
 * re, im, abs, arg) have no derivative in z alone; carrying the conjugate
 * direction is what makes a formula such as "abs(z)^2 + c" perturb correctly
 * instead of drifting.  `dc` exists because a Mandelbrot view puts the pixel
 * offset in c, not in z0.
 */
struct Jet {
    BC v;
    BC dz, dzb;
    BC dzz, dzzb, dzbb;
    BC dc;      // d/dc          (Mandelbrot views vary c, not z0)
    BC dzc;     // d2f/dz dc
    BC dcc;     // (1/2) d2f/dc2
    BC dz1;     // d/dz1       (maps with memory, e.g. phoenix-style formulas)
};

struct Program {
    enum Op : uint8_t {
        CONST = 0, Z, C, Z1, N, PARAM, VAR,
        ADD, SUB, MUL, DIV, POW, NEG,
        CALL1, CALL2, CALL3,
        CMP, LOOP_SUM, LOOP_PROD
    };
    struct Ins {
        uint8_t op = 0;
        int16_t arg = 0;
        int16_t aux = 0;
    };
    std::vector<Ins> code;
    std::vector<BC> consts;
    std::vector<std::string> params;
    std::vector<Program> subs;     // loop bodies
    std::string source;
    int nvars = 0;                 // loop-variable slots
    bool uses_c = false;
    bool uses_z1 = false;
    bool uses_n = false;
    bool transcendental = false;   // any non-polynomial operation
    bool holomorphic = true;       // false once conj/re/im/abs/arg/... appear
    int degree = 0;                // polynomial degree in z, -1 when not one

    int stack_depth() const;
};

// `digits` is the decimal precision the literals and constants are built at;
// it must be at least the precision the orbit will be computed with.
Program compile(const std::string& source, int digits);

// True when `p` can be evaluated (used by the UI to enable the render button).
bool valid(const Program& p);

BC run(const Program& p, const BC& z, const BC& c, const BC& z1,
       const BigFloat& n, const BigFloat* params, int nparams);

/* Value plus first and second derivatives.  `vars` must hold p.nvars slots
 * when the program contains sum/prod; pass nullptr otherwise. */
Jet evalJet(const Program& p, const BC& z, const BC& c, const BC& z1,
            const BigFloat& n, const BigFloat* params, int nparams,
            Jet* vars = nullptr);

}  // namespace mx
