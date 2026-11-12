/* Internal musl visibility/alias macros: on COFF these have no meaning, and
 * emitting weak aliases for prefixed symbols would create dangling names. */
#define hidden
#define weak_alias(o, n)
/* Prefix every public libm symbol so the static library can coexist with the
 * MSVC CRT (which also defines sin/log/exp/...). */
#define sin mbm_sin
#define cos mbm_cos
#define tan mbm_tan
#define asin mbm_asin
#define acos mbm_acos
#define atan mbm_atan
#define atan2 mbm_atan2
#define sinh mbm_sinh
#define cosh mbm_cosh
#define tanh mbm_tanh
#define exp mbm_exp
#define exp2 mbm_exp2
#define expm1 mbm_expm1
#define log mbm_log
#define log2 mbm_log2
#define log10 mbm_log10
#define log1p mbm_log1p
#define pow mbm_pow
#define cbrt mbm_cbrt
#define sqrt mbm_sqrt
#define hypot mbm_hypot
#define fma mbm_fma
#define fabs mbm_fabs
#define floor mbm_floor
#define ceil mbm_ceil
#define trunc mbm_trunc
#define round mbm_round
#define lround mbm_lround
#define rint mbm_rint
#define ldexp mbm_ldexp
#define frexp mbm_frexp
#define ilogb mbm_ilogb
#define scalbn mbm_scalbn
#define fmod mbm_fmod
#define remainder mbm_remainder
#define erf mbm_erf
#define erfc mbm_erfc
#define tgamma mbm_tgamma
#define lgamma mbm_lgamma
#define j0 mbm_j0
#define j1 mbm_j1
#define remquo mbm_remquo
#define copysign mbm_copysign

/* UCRT's math_err.obj defines these same internal helper names.  Prefixing
 * them keeps the two libms from colliding at link time. */
#define __math_oflow mbm___math_oflow
#define __math_uflow mbm___math_uflow
#define __math_divzero mbm___math_divzero
#define __math_invalid mbm___math_invalid
#define __math_xflow mbm___math_xflow
#define __math_oflowf mbm___math_oflowf
#define __math_uflowf mbm___math_uflowf
#define __math_divzerof mbm___math_divzerof
#define __math_invalidf mbm___math_invalidf
#define __math_xflowf mbm___math_xflowf
#define __fpclassify mbm___fpclassify
#define __isnan mbm___isnan
