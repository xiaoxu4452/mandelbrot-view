// Minibrot nucleus finder.
//
// A deep view is impossible without a coordinate that is *known* to that many
// digits.  The shipped examples stop at 98 digits (1.54e73); zooming further
// around that truncated coordinate lands inside a smooth lobe and the frame is
// a flat colour.  The way out is the standard "Newton zoom": find the nucleus
// of the minibrot you are looking at -- the c where z_p(c) == 0 for the local
// period p -- which is known to arbitrary precision, then zoom again around a
// point near its boundary.
//
//   f(c)   = z_p(c)        with z_0 = 0, z_{n+1} = z_n^2 + c
//   f'(c)  = dz_p/dc       with dz_0 = 0, dz_{n+1} = 2 z_n dz_n + 1
//   c_next = c - f(c)/f'(c)
//
// Everything is done in GMP mpf at the requested precision.  The period comes
// from the atom domain: the n >= 1 that minimises |z_n| along the orbit.
#pragma once

#include <string>

struct NucleusResult {
    bool ok = false;
    std::string re, im;       // decimal, `digits` significant digits
    int period = 0;
    int newton_steps = 0;
    double log10_size = 0.0;  // log10 of the estimated minibrot radius
    double last_step_log10 = 0.0;
    std::string error;
};

/** n >= 1 minimising |z_n|; the local period of the minibrot containing c. */
int atom_domain_period(const std::string& cre, const std::string& cim, int digits,
                       int maxiter, std::string* error);

/** Newton-refine c to the period-p nucleus.  `period` <= 0 finds it first. */
NucleusResult find_nucleus(const std::string& cre, const std::string& cim, int period,
                           int digits, int max_newton, int maxiter);

struct MisiurewiczResult {
    bool ok = false;
    std::string re, im;       // decimal, `digits` significant digits
    int m = 0, p = 0;        // preperiod and period
    int newton_steps = 0;
    double last_step_log10 = 0.0;
    double log10_residual = 0.0;  // log10 |z_{m+p} - z_m| at the solution
    std::string error;
};

/**
 * Solve z_{m+p}(c) - z_m(c) = 0, i.e. find a Misiurewicz point: a parameter
 * whose critical orbit becomes exactly periodic after m steps.  Such a c is a
 * known algebraic number, so it can be written to arbitrary precision and its
 * neighbourhood has self-similar structure at ANY zoom.  c=i is the (m=2,p=2)
 * member and needs no computation at all.
 *
 * WARNING (measured): every period-p nucleus also satisfies g=0, so Newton can
 * converge back to an attracting cycle instead of the preperiodic point.  Start
 * near the Misiurewicz point and check the residual / preperiod afterwards.
 */
MisiurewiczResult find_misiurewicz(int m, int p, const std::string& cre,
                                   const std::string& cim, int digits, int max_newton);
