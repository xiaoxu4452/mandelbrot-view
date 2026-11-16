// formulacore/core.cpp — independent C++/wasm core for arbitrary formula sets.
//
// This is the stage-1 engine.  It is deliberately a SEPARATE module from
// webcore/core.wasm: that one is the desktop's z^2+c perturbation core, whose
// reference-orbit / SA / glitch machinery is specific to polynomials.  Here the
// iteration map is an expression the user writes, so the engine is built around
// a complex elementary-function library and a compiled expression VM instead.
//
// Stage 1 provides:
//   * a self-contained complex number type and ~35 elementary functions
//     (trig / hyperbolic / inverse / exp / log / pow / sqrt / rounding ...),
//     composed from real libm so no complex-lib symbols are needed under wasi;
//   * a lexer + Pratt parser (implicit multiplication, right-associative ^,
//     variables z/c/n/p, constants i/pi/e/tau, parameters, nested calls) that
//     compiles to a stack bytecode;
//   * a whole-view renderer returning the SAME single-channel f32 smooth-
//     iteration field webcore's worker hands to shadeSmoothField (-1 = inside).
//
// Stage 2 (not in this file yet) replaces the double centre with the desktop's
// arbitrary-precision BigFloat reference orbit and adds jet (automatic-
// differentiation) perturbation, series approximation and glitch repair, which
// is what makes deep zoom exact for non-polynomial maps.  The ABI below is
// already shaped so that change stays inside this module.
//
// Build: node formulacore/build.mjs   Test: node formulacore/test.mjs

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// ---------------------------------------------------------------- complex --
struct C {
    double r = 0.0, i = 0.0;
};
static inline C mk(double r, double i = 0.0) { return C{r, i}; }
static inline C add(C a, C b) { return C{a.r + b.r, a.i + b.i}; }
static inline C sub(C a, C b) { return C{a.r - b.r, a.i - b.i}; }
static inline C mul(C a, C b) {
    return C{a.r * b.r - a.i * b.i, a.r * b.i + a.i * b.r};
}
static inline C neg(C a) { return C{-a.r, -a.i}; }
static inline C scale(C a, double k) { return C{a.r * k, a.i * k}; }
static inline double abs2(C a) { return a.r * a.r + a.i * a.i; }
static inline C divc(C a, C b) {
    const double d = abs2(b);
    if (d == 0.0) return C{0.0, 0.0};
    return C{(a.r * b.r + a.i * b.i) / d, (a.i * b.r - a.r * b.i) / d};
}
static inline C inv(C a) { return divc(C{1.0, 0.0}, a); }

static inline C cexp(C z) {
    const double e = std::exp(z.r);
    return C{e * std::cos(z.i), e * std::sin(z.i)};
}
static inline C clog(C z) {
    return C{std::log(std::max(std::hypot(z.r, z.i), 1e-300)),
             std::atan2(z.i, z.r)};
}
static inline C csqrt(C z) {
    const double m = std::hypot(z.r, z.i);
    const double a = std::sqrt(std::max(0.0, (m + z.r) * 0.5));
    const double b = std::sqrt(std::max(0.0, (m - z.r) * 0.5));
    return C{a, z.i < 0 ? -b : b};
}
static inline C cpow(C a, C b) {
    if (a.i == 0.0 && b.i == 0.0 && a.r >= 0.0)
        return C{std::pow(a.r, b.r), 0.0};
    if (b.i == 0.0 && b.r == static_cast<double>(static_cast<int>(b.r)) &&
        std::fabs(b.r) < 64.0) {
        // Exact integer power: avoids a branch cut for negative real bases.
        int n = static_cast<int>(b.r);
        if (n < 0) { a = inv(a); n = -n; }
        C out{1.0, 0.0};
        for (int k = 0; k < n; ++k) out = mul(out, a);
        return out;
    }
    return cexp(mul(b, clog(a)));
}
static inline C csin(C z) {
    return C{std::sin(z.r) * std::cosh(z.i), std::cos(z.r) * std::sinh(z.i)};
}
static inline C ccos(C z) {
    return C{std::cos(z.r) * std::cosh(z.i), -std::sin(z.r) * std::sinh(z.i)};
}
static inline C ctan(C z) { return divc(csin(z), ccos(z)); }
static inline C csinh(C z) {
    return C{std::sinh(z.r) * std::cos(z.i), std::cosh(z.r) * std::sin(z.i)};
}
static inline C ccosh(C z) {
    return C{std::cosh(z.r) * std::cos(z.i), std::sinh(z.r) * std::sin(z.i)};
}
static inline C ctanh(C z) { return divc(csinh(z), ccosh(z)); }

static inline C casin_impl(C z) {
    const C iz = C{-z.i, z.r};
    const C root = csqrt(sub(C{1.0, 0.0}, mul(z, z)));
    return mul(C{0.0, -1.0}, clog(add(iz, root)));
}
static inline C cacos_impl(C z) {
    const C root = csqrt(sub(C{1.0, 0.0}, mul(z, z)));
    return mul(C{0.0, -1.0}, clog(add(z, mul(C{0.0, 1.0}, root))));
}
static inline C catan_impl(C z) {
    // (i/2) log((i + z)/(i - z))
    const C I{0.0, 1.0};
    const C q = divc(add(I, z), sub(I, z));
    return mul(C{0.0, 0.5}, clog(q));
}
static inline C casinh_impl(C z) {
    return clog(add(z, csqrt(add(mul(z, z), C{1.0, 0.0}))));
}
static inline C cacosh_impl(C z) {
    return clog(add(z, csqrt(sub(mul(z, z), C{1.0, 0.0}))));
}
static inline C catanh_impl(C z) {
    return scale(clog(divc(add(C{1.0, 0.0}, z), sub(C{1.0, 0.0}, z))), 0.5);
}

static const double LN10 = 2.3025850929940456840179914546843642;

// ------------------------------------------------------------ function set --
enum Fn : uint8_t {
    F_SIN, F_COS, F_TAN, F_ASIN, F_ACOS, F_ATAN,
    F_SINH, F_COSH, F_TANH, F_ASINH, F_ACOSH, F_ATANH,
    F_EXP, F_LOG, F_LOG10, F_SQRT, F_CBRT,
    F_ABS, F_ARG, F_CONJ, F_RE, F_IM, F_SGN, F_INV, F_SQR, F_CUBE,
    F_FLOOR, F_CEIL, F_ROUND, F_SIGN, F_SQ, F_RECIP,
    F_POW, F_ATAN2, F_HYPOT, F_MIN, F_MAX, F_LOGBASE,
    F_COUNT
};

struct FnDef { const char* name; int arity; Fn id; };
static const FnDef FN_DEFS[] = {
    {"sin",1,F_SIN},   {"cos",1,F_COS},   {"tan",1,F_TAN},
    {"asin",1,F_ASIN}, {"acos",1,F_ACOS}, {"atan",1,F_ATAN},
    {"sinh",1,F_SINH}, {"cosh",1,F_COSH}, {"tanh",1,F_TANH},
    {"asinh",1,F_ASINH},{"acosh",1,F_ACOSH},{"atanh",1,F_ATANH},
    {"exp",1,F_EXP},   {"log",1,F_LOG},   {"ln",1,F_LOG},
    {"log10",1,F_LOG10},{"sqrt",1,F_SQRT},{"cbrt",1,F_CBRT},
    {"abs",1,F_ABS},   {"arg",1,F_ARG},   {"conj",1,F_CONJ},
    {"re",1,F_RE},     {"real",1,F_RE},   {"im",1,F_IM}, {"imag",1,F_IM},
    {"sgn",1,F_SGN},   {"inv",1,F_INV},   {"sqr",1,F_SQR},
    {"cube",1,F_CUBE}, {"floor",1,F_FLOOR},{"ceil",1,F_CEIL},
    {"round",1,F_ROUND},{"sign",1,F_SIGN},{"square",1,F_SQ},
    {"recip",1,F_RECIP},
    {"pow",2,F_POW},   {"atan2",2,F_ATAN2},{"hypot",2,F_HYPOT},
    {"min",2,F_MIN},   {"max",2,F_MAX},   {"logbase",2,F_LOGBASE},
};

static C callFn(Fn f, C a, C b) {
    switch (f) {
        case F_SIN: return csin(a);
        case F_COS: return ccos(a);
        case F_TAN: return ctan(a);
        case F_ASIN: return casin_impl(a);
        case F_ACOS: return cacos_impl(a);
        case F_ATAN: return catan_impl(a);
        case F_SINH: return csinh(a);
        case F_COSH: return ccosh(a);
        case F_TANH: return ctanh(a);
        case F_ASINH: return casinh_impl(a);
        case F_ACOSH: return cacosh_impl(a);
        case F_ATANH: return catanh_impl(a);
        case F_EXP: return cexp(a);
        case F_LOG: return clog(a);
        case F_LOG10: return scale(clog(a), 1.0 / LN10);
        case F_SQRT: return csqrt(a);
        case F_CBRT: return cexp(scale(clog(a), 1.0 / 3.0));
        case F_ABS: return C{std::hypot(a.r, a.i), 0.0};
        case F_ARG: return C{std::atan2(a.i, a.r), 0.0};
        case F_CONJ: return C{a.r, -a.i};
        case F_RE: return C{a.r, 0.0};
        case F_IM: return C{a.i, 0.0};
        case F_SGN: {
            const double m = std::hypot(a.r, a.i);
            return m > 0 ? scale(a, 1.0 / m) : C{0.0, 0.0};
        }
        case F_INV: case F_RECIP: return inv(a);
        case F_SQR: case F_SQ: return mul(a, a);
        case F_CUBE: return mul(mul(a, a), a);
        case F_FLOOR: return C{std::floor(a.r), std::floor(a.i)};
        case F_CEIL: return C{std::ceil(a.r), std::ceil(a.i)};
        case F_ROUND: return C{std::round(a.r), std::round(a.i)};
        case F_SIGN: return C{a.r < 0 ? -1.0 : (a.r > 0 ? 1.0 : 0.0),
                              a.i < 0 ? -1.0 : (a.i > 0 ? 1.0 : 0.0)};
        case F_POW: return cpow(a, b);
        case F_ATAN2: return C{std::atan2(a.r, b.r), 0.0};
        case F_HYPOT: return C{std::hypot(a.r, b.r), 0.0};
        case F_MIN: return abs2(a) <= abs2(b) ? a : b;
        case F_MAX: return abs2(a) >= abs2(b) ? a : b;
        case F_LOGBASE: return divc(clog(b), clog(a));
        default: return C{0.0, 0.0};
    }
}

// ------------------------------------------------------------- expression --
enum : uint8_t {
    OP_NUM, OP_Z, OP_C, OP_N, OP_P, OP_I, OP_PI, OP_E, OP_TAU, OP_PARAM,
    OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_POW, OP_NEG,
    OP_CALL1, OP_CALL2
};
struct Op {
    uint8_t code = 0;
    uint8_t fn = 0;
    int16_t arg = 0;
    C val{};
};
struct Program {
    std::vector<Op> ops;
    std::vector<std::string> params;
    bool ok = false;
};

enum TokKind : uint8_t { T_END, T_NUM, T_ID, T_OP, T_LP, T_RP, T_COMMA };
struct Tok {
    TokKind k = T_END;
    double num = 0.0;
    std::string id;
    char op = 0;
    int pos = 0;
};

static std::string g_error;

static std::vector<Tok> lex(const std::string& s, std::string& err) {
    std::vector<Tok> out;
    int p = 0;
    const int n = static_cast<int>(s.size());
    while (p < n) {
        const char ch = s[p];
        if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') { ++p; continue; }
        if ((ch >= '0' && ch <= '9') || (ch == '.' && p + 1 < n && s[p + 1] >= '0' && s[p + 1] <= '9')) {
            int q = p;
            while (q < n && ((s[q] >= '0' && s[q] <= '9') || s[q] == '.')) ++q;
            if (q < n && (s[q] == 'e' || s[q] == 'E')) {
                int k = q + 1;
                if (k < n && (s[k] == '+' || s[k] == '-')) ++k;
                if (k < n && s[k] >= '0' && s[k] <= '9') {
                    while (k < n && s[k] >= '0' && s[k] <= '9') ++k;
                    q = k;
                }
            }
            Tok t; t.k = T_NUM; t.pos = p; t.num = std::strtod(s.substr(p, q - p).c_str(), nullptr);
            out.push_back(std::move(t)); p = q; continue;
        }
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_') {
            int q = p;
            while (q < n && ((s[q] >= 'a' && s[q] <= 'z') || (s[q] >= 'A' && s[q] <= 'Z') ||
                             (s[q] >= '0' && s[q] <= '9') || s[q] == '_')) ++q;
            Tok t; t.k = T_ID; t.pos = p; t.id = s.substr(p, q - p);
            out.push_back(std::move(t)); p = q; continue;
        }
        if (ch == '+' || ch == '-' || ch == '*' || ch == '/' || ch == '^') {
            Tok t; t.k = T_OP; t.op = ch; t.pos = p; out.push_back(std::move(t)); ++p; continue;
        }
        if (ch == '(') { Tok t; t.k = T_LP; t.pos = p; out.push_back(std::move(t)); ++p; continue; }
        if (ch == ')') { Tok t; t.k = T_RP; t.pos = p; out.push_back(std::move(t)); ++p; continue; }
        if (ch == ',') { Tok t; t.k = T_COMMA; t.pos = p; out.push_back(std::move(t)); ++p; continue; }
        err = "unexpected character '" + std::string(1, ch) + "' at " + std::to_string(p);
        return {};
    }
    Tok e; e.k = T_END; e.pos = n; out.push_back(std::move(e));
    return out;
}

struct Compiler {
    std::vector<Tok> t;
    int p = 0;
    Program out;
    std::string err;

    const Tok& peek() const { return t[static_cast<size_t>(p)]; }
    Tok take() { return t[static_cast<size_t>(p++)]; }
    void emit(uint8_t code, uint8_t fn = 0, int arg = 0, C val = C{0.0, 0.0}) {
        Op o; o.code = code; o.fn = fn; o.arg = static_cast<int16_t>(arg); o.val = val;
        out.ops.push_back(o);
    }
    static bool startsValue(const Tok& x) {
        return x.k == T_NUM || x.k == T_ID || x.k == T_LP;
    }
    static int prec(char op) {
        switch (op) {
            case '+': case '-': return 10;
            case '*': case '/': return 20;
            case '^': return 30;
            default: return 0;
        }
    }
    static uint8_t binCode(char op) {
        switch (op) {
            case '+': return OP_ADD;
            case '-': return OP_SUB;
            case '*': return OP_MUL;
            case '/': return OP_DIV;
            case '^': return OP_POW;
            default: return OP_MUL;
        }
    }

    void expr(int minPrec) {
        prefix();
        if (!err.empty()) return;
        for (;;) {
            const Tok& nx = peek();
            int pr = 0;
            bool implicit = false;
            char op = '*';
            if (nx.k == T_OP) { op = nx.op; pr = prec(op); if (pr < minPrec) break; take(); }
            else if (startsValue(nx) && minPrec <= 20) { pr = 20; implicit = true; op = '*'; }
            else break;
            // '^' is right-associative; everything else is left-associative.
            expr(op == '^' ? pr : pr + 1);
            if (!err.empty()) return;
            emit(implicit ? OP_MUL : binCode(op));
        }
    }

    void prefix() {
        const Tok x = take();
        if (x.k == T_NUM) { emit(OP_NUM, 0, 0, C{x.num, 0.0}); return; }
        if (x.k == T_OP && (x.op == '-' || x.op == '+')) {
            expr(40);
            if (x.op == '-') emit(OP_NEG);
            return;
        }
        if (x.k == T_LP) {
            expr(0);
            if (err.empty()) {
                if (peek().k != T_RP) { err = "missing ')' at " + std::to_string(peek().pos); return; }
                take();
            }
            return;
        }
        if (x.k != T_ID) {
            err = "expected a value at " + std::to_string(x.pos);
            return;
        }
        if (peek().k == T_LP) {
            take();  // '('
            std::vector<Op> argOps;
            int arity = 0;
            if (peek().k != T_RP) {
                for (;;) {
                    const size_t before = out.ops.size();
                    expr(0);
                    if (!err.empty()) return;
                    if (out.ops.size() == before) { err = "empty argument"; return; }
                    ++arity;
                    if (peek().k == T_COMMA) { take(); continue; }
                    break;
                }
            }
            if (peek().k != T_RP) { err = "missing ')' after " + x.id; return; }
            take();
            int found = -1, fa = 0;
            for (const FnDef& d : FN_DEFS) {
                if (x.id == d.name) { found = static_cast<int>(d.id); fa = d.arity; break; }
            }
            if (found < 0) { err = "unknown function '" + x.id + "'"; return; }
            if (fa != arity) { err = x.id + " expects " + std::to_string(fa) + " argument(s)"; return; }
            emit(fa == 1 ? OP_CALL1 : OP_CALL2, static_cast<uint8_t>(found));
            return;
        }
        // Variables and constants.  Anything else is a named parameter.
        if (x.id == "z") { emit(OP_Z); return; }
        if (x.id == "c") { emit(OP_C); return; }
        if (x.id == "n") { emit(OP_N); return; }
        if (x.id == "p" || x.id == "zprev" || x.id == "z1") { emit(OP_P); return; }
        if (x.id == "i" || x.id == "I") { emit(OP_I, 0, 0, C{0.0, 1.0}); return; }
        if (x.id == "pi") { emit(OP_PI, 0, 0, C{3.14159265358979323846, 0.0}); return; }
        if (x.id == "e" || x.id == "E") { emit(OP_E, 0, 0, C{2.71828182845904523536, 0.0}); return; }
        if (x.id == "tau") { emit(OP_TAU, 0, 0, C{6.28318530717958647692, 0.0}); return; }
        int idx = -1;
        for (size_t k = 0; k < out.params.size(); ++k)
            if (out.params[k] == x.id) { idx = static_cast<int>(k); break; }
        if (idx < 0) { idx = static_cast<int>(out.params.size()); out.params.push_back(x.id); }
        emit(OP_PARAM, 0, idx);
    }
};

static std::vector<Program> g_programs;

// --------------------------------------------------------------------- VM --
static C runVM(const Program& P, C z, C c, double n, C prev,
               const double* params, int nparam) {
    C st[128];
    int sp = 0;
    for (const Op& o : P.ops) {
        switch (o.code) {
            case OP_NUM: st[sp++] = o.val; break;
            case OP_Z: st[sp++] = z; break;
            case OP_C: st[sp++] = c; break;
            case OP_N: st[sp++] = C{n, 0.0}; break;
            case OP_P: st[sp++] = prev; break;
            case OP_I: case OP_PI: case OP_E: case OP_TAU: st[sp++] = o.val; break;
            case OP_PARAM:
                st[sp++] = (o.arg < nparam && params) ? C{params[o.arg], 0.0} : C{0.0, 0.0};
                break;
            case OP_NEG: { C a = st[--sp]; st[sp++] = neg(a); break; }
            case OP_ADD: { C b = st[--sp], a = st[--sp]; st[sp++] = add(a, b); break; }
            case OP_SUB: { C b = st[--sp], a = st[--sp]; st[sp++] = sub(a, b); break; }
            case OP_MUL: { C b = st[--sp], a = st[--sp]; st[sp++] = mul(a, b); break; }
            case OP_DIV: { C b = st[--sp], a = st[--sp]; st[sp++] = divc(a, b); break; }
            case OP_POW: { C b = st[--sp], a = st[--sp]; st[sp++] = cpow(a, b); break; }
            case OP_CALL1: { C a = st[--sp]; st[sp++] = callFn(static_cast<Fn>(o.fn), a, C{0.0, 0.0}); break; }
            case OP_CALL2: { C b = st[--sp], a = st[--sp]; st[sp++] = callFn(static_cast<Fn>(o.fn), a, b); break; }
            default: break;
        }
        if (sp < 0) sp = 0;
        if (sp > 126) sp = 126;
    }
    return sp > 0 ? st[sp - 1] : C{0.0, 0.0};
}

// -------------------------------------------------------------- renderer ---
static std::vector<float> g_field;

extern "C" {

__attribute__((export_name("fc_version")))
int32_t fc_version(void) { return 1; }

__attribute__((export_name("fc_alloc")))
void* fc_alloc(int32_t n) { return std::malloc(n > 0 ? static_cast<size_t>(n) : 1); }

__attribute__((export_name("fc_free")))
void fc_free(void* p) { std::free(p); }

__attribute__((export_name("fc_error")))
const char* fc_error(void) { return g_error.c_str(); }

__attribute__((export_name("fc_compile")))
int32_t fc_compile(const char* src) {
    g_error.clear();
    if (!src) { g_error = "null expression"; return -1; }
    std::string lexErr;
    const std::vector<Tok> toks = lex(std::string(src), lexErr);
    if (!lexErr.empty()) { g_error = lexErr; return -1; }
    Compiler cp;
    cp.t = toks;
    cp.expr(0);
    if (cp.err.empty() && cp.peek().k != T_END)
        cp.err = "unexpected token at " + std::to_string(cp.peek().pos);
    if (cp.err.empty() && cp.out.ops.empty()) cp.err = "empty expression";
    if (!cp.err.empty()) { g_error = cp.err; return -1; }
    cp.out.ok = true;
    g_programs.push_back(std::move(cp.out));
    return static_cast<int32_t>(g_programs.size()) - 1;
}

__attribute__((export_name("fc_param_count")))
int32_t fc_param_count(int32_t prog) {
    if (prog < 0 || static_cast<size_t>(prog) >= g_programs.size()) return -1;
    return static_cast<int32_t>(g_programs[static_cast<size_t>(prog)].params.size());
}

__attribute__((export_name("fc_param_name")))
const char* fc_param_name(int32_t prog, int32_t k) {
    if (prog < 0 || static_cast<size_t>(prog) >= g_programs.size()) return "";
    const auto& v = g_programs[static_cast<size_t>(prog)].params;
    if (k < 0 || static_cast<size_t>(k) >= v.size()) return "";
    return v[static_cast<size_t>(k)].c_str();
}

/* Whole-view render.  The field is one f32 per pixel: the smooth iteration
 * for escaped pixels, -1 for interior — exactly what the page's
 * shadeSmoothField() consumes for core.wasm frames. */
__attribute__((export_name("fc_render")))
int32_t fc_render(int32_t prog,
                  const char* creS, const char* cimS,
                  double zoomMant, int32_t zoomExp10,
                  int32_t w, int32_t h, int32_t maxiter,
                  int32_t mode, const char* jrS, const char* jiS,
                  double bail2, int32_t nparam, const double* params,
                  double rotCos, double rotSin,
                  int32_t y0, int32_t y1) {
    g_error.clear();
    if (prog < 0 || static_cast<size_t>(prog) >= g_programs.size()) {
        g_error = "bad program id"; return 1;
    }
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || maxiter < 1 || maxiter > 2000000) {
        g_error = "bad frame dimensions"; return 2;
    }
    if (y0 < 0 || y1 > h || y1 <= y0) { g_error = "bad band"; return 4; }
    const double zoom = zoomMant * std::pow(10.0, static_cast<double>(zoomExp10));
    if (!(zoom > 0) || !std::isfinite(zoom)) {
        g_error = "depth exceeds stage-1 (double) engine"; return 3;
    }
    const double ps = 3.0 / zoom / static_cast<double>(w);
    const double cre = creS ? std::strtod(creS, nullptr) : 0.0;
    const double cim = cimS ? std::strtod(cimS, nullptr) : 0.0;
    const C jul{jrS ? std::strtod(jrS, nullptr) : 0.0,
                jiS ? std::strtod(jiS, nullptr) : 0.0};
    const double logBail = 0.5 * std::log(std::max(bail2, 1.0000001));
    const Program& P = g_programs[static_cast<size_t>(prog)];
    /* A band owns only its rows: N workers render disjoint strips into their
     * own instances, and clearing the whole field here would erase the other
     * bands' work in a shared instance. */
    const size_t total = static_cast<size_t>(w) * h;
    if (g_field.size() != total) g_field.assign(total, -1.0f);

    for (int y = y0; y < y1; ++y) {
        const double py = (static_cast<double>(y) + 0.5 - 0.5 * h) * ps;
        for (int x = 0; x < w; ++x) {
            const double px = (static_cast<double>(x) + 0.5 - 0.5 * w) * ps;
            // Same basis as the page's planeDelta(): screen y grows downward,
            // so the imaginary component of the offset is negated.
            const double X = px, Y = -py;
            const double u = X * rotCos - Y * rotSin;
            const double v = X * rotSin + Y * rotCos;
            const C pt{cre + u, cim + v};
            C z = (mode == 1) ? pt : C{0.0, 0.0};
            const C cc = (mode == 1) ? jul : pt;
            C prev{0.0, 0.0};
            /* Periodicity early-out, the same rule the page kernel uses: an
             * interior orbit returns to itself, so a checkpoint 52 iterations
             * back staying within 1e-10 means "never escapes".  exp(z)+c is
             * the case that paid for this -- its interior is a fixed point
             * reached in ~30 steps, and without the check 40 % of a 0.5 Mpx
             * frame ran the full 587-iteration budget (6.1 s at 0.5 Mpx). */
            double chkR = 0.0, chkI = 0.0;
            bool chkOn = false;
            float value = -1.0f;
            for (int it = 0; it < maxiter; ++it) {
                const C nz = runVM(P, z, cc, static_cast<double>(it), prev, params, nparam);
                prev = z;
                z = nz;
                const double z2 = abs2(z);
                if (!(z2 <= bail2)) {
                    double sm;
                    if (!std::isfinite(z2)) {
                        /* exp / sinh / cos of a large complex value overflows.
                         * There is no finite log|z| to smooth with, but the
                         * pixel did escape: report the iteration itself rather
                         * than letting NaN reach the field. */
                        sm = static_cast<double>(it) + 1.0;
                    } else {
                        const double logz = 0.5 * std::log(std::max(z2, 1e-300));
                        sm = static_cast<double>(it) + 1.0 -
                             std::log2(logz / logBail);
                    }
                    if (!(sm >= 0.0) || !std::isfinite(sm)) sm = 0.0;
                    value = static_cast<float>(sm);
                    break;
                }
                if (!std::isfinite(z2)) break;
                if (!chkOn) {
                    if (it >= 12) { chkR = z.r; chkI = z.i; chkOn = true; }
                } else if ((it & 63) == 0) {
                    const double dx = z.r - chkR, dy = z.i - chkI;
                    if (dx * dx + dy * dy < 1e-20) break;   // interior
                }
            }
            g_field[static_cast<size_t>(y) * w + x] = value;
        }
    }
    return 0;
}

__attribute__((export_name("fc_out_ptr")))
float* fc_out_ptr(void) { return g_field.empty() ? nullptr : g_field.data(); }

__attribute__((export_name("fc_out_size")))
int32_t fc_out_size(void) { return static_cast<int32_t>(g_field.size() * sizeof(float)); }

}  // extern "C"

/* ==========================================================================
 * Stage 2: perturbation rendering against an EXTERNAL, arbitrary-precision
 * reference orbit.
 *
 * The page / Node side builds ONE orbit with the project's high-precision
 * libraries (js/hpeval.js BigInt fixed point) and derives the jet (truncated
 * power series) coefficients along that orbit with js/jet.js automatic
 * differentiation.  Every pixel then advances a tiny offset delta in
 * float-exp form (mantissa + binary exponent), so a 10^-600 pixel scale never
 * underflows a double.  Precision cost grows with the single orbit, never with
 * the pixel count.
 *
 * Layout of coefA / coefB, both [orbitLen][K+1][2] doubles (re, im), where K
 * is the runtime jet order (1..JK_MAX) and stride = (K+1)*2:
 *   F(Z + eps, C + eta) = sum_k a_k eps^k + sum_k b_k eps^k eta  (+ O(eta^2))
 *   a_0 is Z_{n+1} and is already in the orbit, so the recurrence starts at
 *   k = 1.  For z^2+c: a_1 = 2 Z, a_2 = 1, b_0 = 1; for sin(z)+c the same
 *   arrays hold the Taylor coefficients produced by jet.js.
 *
 * y0/y1 render ONE horizontal band: N wasm instances can share the orbit and
 * each render a disjoint band without a lock.
 * ========================================================================== */

static constexpr int JK_MAX = 10;

struct FE {
    double m = 0.0;
    int e = 0;                 // value = m * 2^e
};
static inline FE fe_norm(double m, int e) {
    if (m == 0.0 || !std::isfinite(m)) return FE{0.0, 0};
    int k = 0;
    const double f = std::frexp(m, &k);
    return FE{f, e + k};
}
static inline FE fe_scale(FE a, double k) {
    if (k == 0.0 || a.m == 0.0) return FE{0.0, 0};
    return fe_norm(a.m * k, a.e);
}
static inline FE fe_add(FE a, FE b) {
    if (a.m == 0.0) return b;
    if (b.m == 0.0) return a;
    const int e = std::max(a.e, b.e);
    return fe_norm(std::ldexp(a.m, a.e - e) + std::ldexp(b.m, b.e - e), e);
}
static inline FE fe_sub(FE a, FE b) { return fe_add(a, fe_scale(b, -1.0)); }
static inline FE fe_mul(FE a, FE b) {
    if (a.m == 0.0 || b.m == 0.0) return FE{0.0, 0};
    return fe_norm(a.m * b.m, a.e + b.e);
}
static inline double fe_double(FE a) {
    if (a.m == 0.0 || a.e < -1070) return 0.0;
    if (a.e > 1020) return a.m > 0 ? 1e300 : -1e300;
    return std::ldexp(a.m, a.e);
}
struct C2 { FE r, i; };
static inline C2 c2_zero() { return C2{FE{0.0, 0}, FE{0.0, 0}}; }
static inline C2 c2_add(C2 a, C2 b) {
    return C2{fe_add(a.r, b.r), fe_add(a.i, b.i)};
}
static inline C2 c2_sub(C2 a, C2 b) {
    return C2{fe_sub(a.r, b.r), fe_sub(a.i, b.i)};
}
static inline C2 c2_mul(C2 a, C2 b) {
    return C2{fe_sub(fe_mul(a.r, b.r), fe_mul(a.i, b.i)),
              fe_add(fe_mul(a.r, b.i), fe_mul(a.i, b.r))};
}
static inline C2 c2_from(double r, double i) {
    return C2{fe_norm(r, 0), fe_norm(i, 0)};
}
static inline double c2_abs(C2 a) {
    return std::hypot(fe_double(a.r), fe_double(a.i));
}

/** Render band [y0,y1).  `rebaseOn` enables singleref glitch repair: when
 *  Z_n + delta cancels, re-anchor onto the orbit point closest to the pixel's
 *  z and continue from there instead of dropping the pixel as "interior". */
static int renderBand(int32_t w, int32_t h, int32_t maxiter,
                      int32_t mode, double bail2,
                      int32_t orbitLen,
                      const double* Zr, const double* Zi,
                      const double* coefA, const double* coefB,
                      int32_t K, int32_t stride,
                      double dMant, int32_t dExp2,
                      double rotCos, double rotSin,
                      int32_t y0, int32_t y1,
                      int32_t saSkip, const double* saAt,
                      int32_t rebaseOn) {
    const int N = std::min(maxiter, orbitLen);
    const double logBail = 0.5 * std::log(std::max(bail2, 1.0000001));
    const double glitchEps = std::ldexp(1.0, -20);
    const size_t total = static_cast<size_t>(w) * h;
    /* Do NOT clear the whole field: bands are rendered by separate instances
     * (or successive calls) and each owns only its own rows. */
    if (g_field.size() != total) g_field.assign(total, -1.0f);

    for (int y = y0; y < y1; ++y) {
        for (int x = 0; x < w; ++x) {
            const FE X = fe_norm((static_cast<double>(x) + 0.5 - 0.5 * w) * dMant, dExp2);
            const FE Y = fe_scale(fe_norm((static_cast<double>(y) + 0.5 - 0.5 * h) * dMant, dExp2), -1.0);
            const FE u = fe_add(fe_scale(X, rotCos), fe_scale(Y, -rotSin));
            const FE v = fe_add(fe_scale(X, rotSin), fe_scale(Y, rotCos));
            const C2 offset{u, v};
            /* Julia: the pixel IS z0, so the offset is delta-z and c is fixed.
             * Mandelbrot: every z0 is 0 and the offset is delta-c. */
            C2 dz = (mode == 1) ? offset : c2_zero();
            const C2 dc = (mode == 1) ? c2_zero() : offset;

            /* Series approximation: s_1(n+1) = a_1(n) s_1(n) + b_0(n) is a
             * LINEAR identity for ANY iteration map (the delta^2 term is
             * negligible while delta is tiny), so the ~690 growth iterations
             * at 10^-300 collapse to one polynomial evaluation.  It is
             * integrated once with the orbit, never per pixel. */
            int n = (mode == 0 && saAt && saSkip > 0 && saSkip < N) ? saSkip : 0;
            if (n > 0) {
                C2 sum = c2_zero(), pw = dc;
                for (int k = 1; k <= K; ++k) {
                    sum = c2_add(sum, c2_mul(c2_from(saAt[k * 2], saAt[k * 2 + 1]), pw));
                    pw = c2_mul(pw, dc);
                }
                dz = sum;
            }

            float value = -1.0f;
            int rebases = 0;
            const int maxSteps = 2 * N + 64;
            for (int steps = 0; steps < maxSteps && n < N; ++steps) {
                const C2 Z = c2_from(Zr[n], Zi[n]);
                const C2 z = c2_add(Z, dz);
                const double z2 = fe_double(fe_add(fe_mul(z.r, z.r), fe_mul(z.i, z.i)));
                if (!(z2 <= bail2)) {
                    double sm;
                    if (!std::isfinite(z2)) sm = static_cast<double>(n) + 1.0;
                    else {
                        const double logz = 0.5 * std::log(std::max(z2, 1e-300));
                        /* Match webcore's iterate_pixel_d() exactly: it
                         * reports n + 1 - log2(log|z| / log(bailout)) for
                         * z = Z_n + delta_n.  The page normalises by the
                         * frame's own escape range, but keeping the same
                         * convention means no adapter when this core replaces
                         * the JS fallback. */
                        sm = static_cast<double>(n) + 1.0 - std::log2(logz / logBail);
                    }
                    if (!(sm >= 0.0) || !std::isfinite(sm)) sm = 0.0;
                    value = static_cast<float>(sm);
                    break;
                }
                /* Cancellation: |Z + delta| << max(|Z|, |delta|). */
                const double az = c2_abs(z);
                const double aZ = std::hypot(Zr[n], Zi[n]);
                const double ad = c2_abs(dz);
                if (az < glitchEps * std::max(aZ, ad)) {
                    if (!rebaseOn || ++rebases > 12) break;   // unresolved
                    /* singleref rebase: z is close to SOME orbit point.  Use
                     * that point as the new reference, so delta stops cancelling
                     * and the iteration count continues from the aligned step. */
                    const double zr = fe_double(z.r), zi = fe_double(z.i);
                    int best = -1;
                    double bestD = 1e300;
                    for (int m = 0; m < N; ++m) {
                        if (m == n) continue;
                        const double d = std::hypot(Zr[m] - zr, Zi[m] - zi);
                        if (d < bestD) { bestD = d; best = m; }
                    }
                    if (best < 0) break;
                    dz = c2_sub(z, c2_from(Zr[best], Zi[best]));
                    n = best;
                    continue;
                }
                if (n + 1 >= N) break;

                /* delta' = sum_{k=1..K} a_k delta^k
                 *        + (b_0 + sum_{k=1..K} b_k delta^k) * delta_c
                 *
                 * A truncated Taylor series is exact for polynomials; for an
                 * entire function it is only valid while |delta| is small.
                 * That is precisely the deep-zoom regime perturbation is FOR:
                 * the host's `usable` contract keeps shallow/medium views on
                 * the direct double renderer (as the desktop core does). */
                const double* a = coefA + static_cast<size_t>(n) * stride;
                const double* b = coefB + static_cast<size_t>(n) * stride;
                C2 nd = c2_zero();
                C2 pw = dz;
                for (int k = 1; k <= K; ++k) {
                    nd = c2_add(nd, c2_mul(c2_from(a[k * 2], a[k * 2 + 1]), pw));
                    if (dc.r.m != 0.0 || dc.i.m != 0.0)
                        nd = c2_add(nd, c2_mul(c2_from(b[k * 2], b[k * 2 + 1]),
                                               c2_mul(pw, dc)));
                    pw = c2_mul(pw, dz);
                }
                nd = c2_add(nd, c2_mul(c2_from(b[0], b[1]), dc));
                dz = nd;
                ++n;
            }
            g_field[static_cast<size_t>(y) * w + x] = value;
        }
    }
    return 0;
}

/* ==========================================================================
 * Stage 3: the five non-holomorphic built-in families.
 *
 * tricorn / burning ship / celtic / perpendicular / phoenix are NOT
 * holomorphic in z, so jet.js can offer only a central-difference first-order
 * derivative, and that derivative is meaningless at a fold boundary (abs /
 * conj / sign).  They are, however, PIECEWISE QUADRATIC POLYNOMIALS in the
 * real and imaginary parts:
 *
 *   tricorn        z' = (x^2-y^2) + i(-2xy) + c
 *   burning ship   z' = (x^2-y^2) + i(2|x||y|) + c
 *   celtic         z' = |x^2-y^2| + i(2xy) + c
 *   perpendicular  z' = (x^2-y^2) + i|2xy| + c
 *   phoenix        z' = z^2 + c + p z_{n-1}
 *
 * With z = Z + d, A = X^2-Y^2 and B = 2XY on the reference orbit,
 *
 *   Dr = (2X+dr)dr - (2Y+di)di   = (x^2-y^2) - A
 *   Di = X di + Y dr + dr di     = xy - XY       (2Di = B_pix - B)
 *
 * every family's delta recurrence is an EXACT polynomial -- no truncated
 * Taylor series, no O(d^2) error, valid at ANY |d|, hence at any depth:
 *
 *   tricorn        d' = Dr + dc_r + i(-2Di + dc_i)
 *   burning ship   d' = Dr + dc_r + i((sp-sB)B + 2 sp Di + dc_i)
 *   celtic         d' = ((sp-sA)A + sp Dr) + dc_r + i(2Di + dc_i)
 *   perpendicular  d' = Dr + dc_r + i((sp-sB)B + 2 sp Di + dc_i)
 *   phoenix        d' = Dr + p dprev_r + dc_r + i(2Di + p dprev_i + dc_i)
 *
 * sp is the PIXEL's fold sign (of A+Dr or B+2Di); sA/sB are the REFERENCE's
 * signs, taken from the high-precision orbit as the exact values A and B
 * rather than subtracting two doubles (which would lose them near zero).
 * When sp != s the correction term is proportional to A (or B), which is
 * itself O(d) at a sign crossing -- so no O(1) discontinuity ever appears.
 *
 * The "wider reference ladder": instead of ONE orbit, the host builds R
 * arbitrary-precision orbits from centres spread over the frame.  A pixel
 * whose Z+d cancels re-anchors at the SAME iteration index onto whichever
 * orbit is closest; keeping the index fixed is what makes phoenix's z_{n-1}
 * term well defined.  All orbits share the frame centre's c, so only dc has
 * to be recomputed after a switch.
 * ========================================================================== */

static inline int fe_sgn(FE a) { return a.m < 0.0 ? -1 : (a.m > 0.0 ? 1 : 0); }

static int renderFamilyBand(
    int32_t kind, int32_t mode, int32_t w, int32_t h, int32_t maxiter,
    double bail2, int32_t R, int32_t stride,
    const double* Zr, const double* Zi,
    const double* foldA, const double* foldB,
    const double* offX, const double* offY,
    double dMant, int32_t dExp2,
    double rotCos, double rotSin, double phoenixP,
    int32_t y0, int32_t y1, int32_t smoothBias) {
    const size_t total = static_cast<size_t>(w) * h;
    if (g_field.size() != total) g_field.assign(total, -1.0f);
    const double logBail = 0.5 * std::log(std::max(bail2, 1.0000001));
    const double glitchEps = std::ldexp(1.0, -20);
    const int N = std::min(maxiter, stride);

    for (int y = y0; y < y1; ++y) {
        for (int x = 0; x < w; ++x) {
            const FE X = fe_norm((static_cast<double>(x) + 0.5 - 0.5 * w) * dMant, dExp2);
            const FE Y = fe_scale(fe_norm((static_cast<double>(y) + 0.5 - 0.5 * h) * dMant, dExp2), -1.0);
            const FE u = fe_add(fe_scale(X, rotCos), fe_scale(Y, -rotSin));
            const FE v = fe_add(fe_scale(X, rotSin), fe_scale(Y, rotCos));
            const C2 base{u, v};                    // pixel offset from frame centre

            auto epsOf = [&](int q) -> C2 {
                return C2{fe_norm(offX[q] * dMant, dExp2),
                          fe_norm(offY[q] * dMant, dExp2)};
            };
            /* Mandelbrot: z0 = 0 everywhere, c = centre + offset.
             * Julia:      c is fixed, z0 = centre + offset.
             * Either way d0 = offset - orbit_centre_offset. */
            const C2 d0 = c2_sub(base, epsOf(0));
            C2 dz = (mode == 1) ? d0 : c2_zero();
            C2 dc = (mode == 1) ? c2_zero() : d0;
            /* phoenix needs delta at step n-1.  It must be kept as a DELTA:
             * reconstructing it as (Z_{n-1}+delta) - Z_{n-1} would subtract
             * two O(1) doubles and throw away a 1e-20 delta entirely. */
            C2 dzPrev = c2_zero();
            int r = 0, n = 0, rebases = 0;
            float value = -1.0f;
            /* Interior pixels dominate a deep frame.  Without an early exit
             * every one of them walks the FULL iteration budget (14k x 500k
             * pixels = 7e9 steps, i.e. a frame that never lands).  The page's
             * own kernel uses exactly this periodicity check; for phoenix the
             * state is (z_n, delta_{n-1}), so compare both. */
            double chkR = 0.0, chkI = 0.0, chkDR = 0.0, chkDI = 0.0;
            bool chkOn = false;
            int steps = 0;

            while (n < N && ++steps <= N + 64) {
                const double* ZR = Zr + static_cast<size_t>(r) * stride;
                const double* ZI = Zi + static_cast<size_t>(r) * stride;
                const double* FA = foldA + static_cast<size_t>(r) * stride;
                const double* FB = foldB + static_cast<size_t>(r) * stride;
                const C2 Z = c2_from(ZR[n], ZI[n]);
                const C2 z = c2_add(Z, dz);
                const double zr = fe_double(z.r), zi = fe_double(z.i);
                const double z2 = zr * zr + zi * zi;
                if (!(z2 <= bail2)) {
                    const double logz = 0.5 * std::log(std::max(z2, 1e-300));
                    double sm = static_cast<double>(n + smoothBias) + 1.0 -
                                std::log2(logz / logBail);
                    if (!(sm >= 0.0) || !std::isfinite(sm)) sm = 0.0;
                    value = static_cast<float>(sm);
                    break;
                }
                if (!std::isfinite(z2)) break;
                if (n == 8) {
                    chkR = zr; chkI = zi;
                    chkDR = fe_double(dzPrev.r); chkDI = fe_double(dzPrev.i);
                    chkOn = true;
                } else if (chkOn && (n & 31) == 0) {
                    const double q1 = zr - chkR, q2 = zi - chkI;
                    const double q3 = fe_double(dzPrev.r) - chkDR;
                    const double q4 = fe_double(dzPrev.i) - chkDI;
                    if (q1 * q1 + q2 * q2 + q3 * q3 + q4 * q4 < 1e-30)
                        break;                       // periodic -> interior
                }

                const double aZ = std::hypot(ZR[n], ZI[n]);
                const double ad = c2_abs(dz);
                const double az = std::sqrt(z2);
                if (az < glitchEps * std::max(aZ, ad)) {
                    if (++rebases > 16) break;
                    /* Re-anchor at the SAME iteration onto the closest orbit.
                     * The host sorted the longest-lived orbit first, and all
                     * orbits are padded to the full budget, so no index shift
                     * is needed. */
                    int best = -1;
                    double bestD = ad;
                    for (int q = 0; q < R; ++q) {
                        if (q == r) continue;
                        const double* QR = Zr + static_cast<size_t>(q) * stride;
                        const double* QI = Zi + static_cast<size_t>(q) * stride;
                        const double d = std::hypot(QR[n] - zr, QI[n] - zi);
                        if (d < bestD) { bestD = d; best = q; }
                    }
                    if (best < 0) break;
                    const double* QR = Zr + static_cast<size_t>(best) * stride;
                    const double* QI = Zi + static_cast<size_t>(best) * stride;
                    /* Re-express the history delta against the new orbit:
                     * (Zold + dprev) - Znew = dprev + (Zold - Znew).  The
                     * shift is formed BEFORE the subtraction of near-equal
                     * values, so a 1e-20 delta survives. */
                    if (n > 0) {
                        const double* ORR = Zr + static_cast<size_t>(r) * stride;
                        const double* ORI = Zi + static_cast<size_t>(r) * stride;
                        dzPrev = c2_add(dzPrev,
                            C2{fe_sub(fe_norm(ORR[n - 1], 0), fe_norm(QR[n - 1], 0)),
                               fe_sub(fe_norm(ORI[n - 1], 0), fe_norm(QI[n - 1], 0))});
                    }
                    dz = c2_sub(z, c2_from(QR[n], QI[n]));
                    r = best;
                    if (mode == 0) dc = c2_sub(base, epsOf(r));
                    continue;                       // same z, a closer Z
                }
                if (n + 1 >= N) break;

                const FE FX = fe_norm(ZR[n], 0), FY = fe_norm(ZI[n], 0);
                const FE t1 = fe_add(fe_scale(FX, 2.0), dz.r);
                const FE t2 = fe_add(fe_scale(FY, 2.0), dz.i);
                /* Dr = (x^2-y^2) - A ; Di = xy - XY */
                const FE Dr = fe_sub(fe_mul(t1, dz.r), fe_mul(t2, dz.i));
                const FE Di = fe_add(fe_add(fe_mul(FX, dz.i), fe_mul(FY, dz.r)),
                                     fe_mul(dz.r, dz.i));
                const FE D2i = fe_scale(Di, 2.0);
                FE ndr, ndi;
                if (kind == 1) {                    /* tricorn */
                    ndr = fe_add(Dr, dc.r);
                    ndi = fe_add(fe_scale(D2i, -1.0), dc.i);
                } else if (kind == 2 || kind == 4) { /* burning ship / perpendicular */
                    const double B = FB[n];
                    const int sB = B < 0.0 ? -1 : 1;
                    const FE Bp = fe_add(fe_norm(B, 0), D2i);
                    const int sp = fe_sgn(Bp);
                    ndr = fe_add(Dr, dc.r);
                    ndi = fe_add(fe_add(fe_scale(D2i, static_cast<double>(sp)),
                                        fe_scale(fe_norm(B, 0), static_cast<double>(sp - sB))),
                                 dc.i);
                } else if (kind == 3) {            /* celtic */
                    const double A = FA[n];
                    const int sA = A < 0.0 ? -1 : 1;
                    const FE Ap = fe_add(fe_norm(A, 0), Dr);
                    const int sp = fe_sgn(Ap);
                    ndr = fe_add(fe_add(fe_scale(Dr, static_cast<double>(sp)),
                                        fe_scale(fe_norm(A, 0), static_cast<double>(sp - sA))),
                                 dc.r);
                    ndi = fe_add(D2i, dc.i);
                } else {                            /* phoenix */
                    ndr = fe_add(fe_add(Dr, dc.r), fe_scale(dzPrev.r, phoenixP));
                    ndi = fe_add(fe_add(D2i, dc.i), fe_scale(dzPrev.i, phoenixP));
                }
                dzPrev = dz;
                dz = C2{ndr, ndi};
                ++n;
            }
            g_field[static_cast<size_t>(y) * w + x] = value;
        }
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * Fast path: delta is stored in PIXEL UNITS (u = delta / ps), so every value
 * is an ordinary double.  This is valid while ps = dMant*2^dExp2 is
 * representable (dExp2 > -900, i.e. zoom up to ~1e270 -- every shipped preset
 * is far inside that).  The FE path above stays as the arbitrary-depth
 * fallback.
 *
 * In u units the quadratic terms gain a factor ps, and the fold arguments
 * gain 1/ps:
 *   Dr = (2X + ps*dr)dr - (2Y + ps*di)di      Di = X di + Y dr + ps dr di
 *   Bq = B/ps,  Aq = A/ps,  sp = sign(Bq + 2Di) / sign(Aq + Dr)
 *   d'_im = (sp-sB) Bq + 2 sp Di (+ dc)       d'_re = (sp-sA) Aq + sp Dr (+ dc)
 * Dropping frexp/ldexp from the inner loop is ~10x at 1e20: a 300x200 phoenix
 * frame went from 148 s to a couple of seconds.
 * -------------------------------------------------------------------------- */
static int renderFamilyBandScaled(
    int32_t kind, int32_t mode, int32_t w, int32_t h, int32_t maxiter,
    double bail2, int32_t R, int32_t stride,
    const double* Zr, const double* Zi,
    const double* foldA, const double* foldB,
    const double* offX, const double* offY,
    double dMant, int32_t dExp2,
    double rotCos, double rotSin, double phoenixP,
    int32_t y0, int32_t y1, int32_t smoothBias) {
    const size_t total = static_cast<size_t>(w) * h;
    if (g_field.size() != total) g_field.assign(total, -1.0f);
    const double logBail = 0.5 * std::log(std::max(bail2, 1.0000001));
    const double glitchEps = std::ldexp(1.0, -20);
    const double ps = std::ldexp(dMant, dExp2);
    const double invPs = 1.0 / ps;
    const int N = std::min(maxiter, stride);

    for (int y = y0; y < y1; ++y) {
        for (int x = 0; x < w; ++x) {
            const double ax = x + 0.5 - 0.5 * w;
            const double ay = -(y + 0.5 - 0.5 * h);
            const double u0r = ax * rotCos - ay * rotSin;
            const double u0i = ax * rotSin + ay * rotCos;
            const double q0r = u0r - offX[0], q0i = u0i - offY[0];
            double dr = (mode == 1) ? q0r : 0.0;
            double di = (mode == 1) ? q0i : 0.0;
            double dcr = (mode == 1) ? 0.0 : q0r;
            double dci = (mode == 1) ? 0.0 : q0i;
            double dpr = 0.0, dpi = 0.0;
            int r = 0, n = 0, rebases = 0;
            float value = -1.0f;
            double chkR = 0.0, chkI = 0.0, chkDR = 0.0, chkDI = 0.0;
            bool chkOn = false;
            int steps = 0;

            while (n < N && ++steps <= N + 64) {
                const double* ZR = Zr + static_cast<size_t>(r) * stride;
                const double* ZI = Zi + static_cast<size_t>(r) * stride;
                const double* FA = foldA + static_cast<size_t>(r) * stride;
                const double* FB = foldB + static_cast<size_t>(r) * stride;
                const double X = ZR[n], Y = ZI[n];
                const double pdr = ps * dr, pdi = ps * di;
                const double zr = X + pdr, zi = Y + pdi;
                const double z2 = zr * zr + zi * zi;
                if (!(z2 <= bail2)) {
                    const double logz = 0.5 * std::log(std::max(z2, 1e-300));
                    double sm = static_cast<double>(n + smoothBias) + 1.0 -
                                std::log2(logz / logBail);
                    if (!(sm >= 0.0) || !std::isfinite(sm)) sm = 0.0;
                    value = static_cast<float>(sm);
                    break;
                }
                if (!std::isfinite(z2)) break;
                if (n == 8) {
                    chkR = zr; chkI = zi; chkDR = ps * dpr; chkDI = ps * dpi;
                    chkOn = true;
                } else if (chkOn && (n & 31) == 0) {
                    const double q1 = zr - chkR, q2 = zi - chkI;
                    const double q3 = ps * dpr - chkDR, q4 = ps * dpi - chkDI;
                    if (q1 * q1 + q2 * q2 + q3 * q3 + q4 * q4 < 1e-30)
                        break;                       // periodic -> interior
                }
                /* Squared magnitudes: three hypot/sqrt calls per iteration
                 * used to dominate the whole kernel.  A glitch is
                 * |z| << max(|Z|,|delta|), which is exactly the same test on
                 * the squares. */
                const double aZ2 = X * X + Y * Y;
                const double ad2 = pdr * pdr + pdi * pdi;
                if (z2 < glitchEps * glitchEps * std::max(aZ2, ad2)) {
                    if (++rebases > 16) break;
                    int best = -1;
                    double bestD2 = ad2;
                    for (int q = 0; q < R; ++q) {
                        if (q == r) continue;
                        const double* QR = Zr + static_cast<size_t>(q) * stride;
                        const double* QI = Zi + static_cast<size_t>(q) * stride;
                        const double ex = QR[n] - zr, ey = QI[n] - zi;
                        const double d2 = ex * ex + ey * ey;
                        if (d2 < bestD2) { bestD2 = d2; best = q; }
                    }
                    if (best < 0) break;
                    const double* QR = Zr + static_cast<size_t>(best) * stride;
                    const double* QI = Zi + static_cast<size_t>(best) * stride;
                    if (n > 0) {
                        const double* ORR = Zr + static_cast<size_t>(r) * stride;
                        const double* ORI = Zi + static_cast<size_t>(r) * stride;
                        dpr += (ORR[n - 1] - QR[n - 1]) * invPs;
                        dpi += (ORI[n - 1] - QI[n - 1]) * invPs;
                    }
                    dr = (zr - QR[n]) * invPs;
                    di = (zi - QI[n]) * invPs;
                    r = best;
                    if (mode == 0) {
                        dcr = u0r - offX[r];
                        dci = u0i - offY[r];
                    }
                    continue;
                }
                if (n + 1 >= N) break;

                const double Dr = (2.0 * X + ps * dr) * dr -
                                  (2.0 * Y + ps * di) * di;
                const double Di = X * di + Y * dr + ps * dr * di;
                const double D2i = 2.0 * Di;
                double ndr, ndi;
                if (kind == 1) {
                    ndr = Dr + dcr;
                    ndi = -D2i + dci;
                } else if (kind == 2 || kind == 4) {
                    const double Bq = FB[n] * invPs;
                    const int sB = Bq < 0.0 ? -1 : 1;
                    const double Bp = Bq + D2i;
                    const int sp = Bp < 0.0 ? -1 : (Bp > 0.0 ? 1 : 0);
                    ndr = Dr + dcr;
                    ndi = static_cast<double>(sp - sB) * Bq +
                          static_cast<double>(sp) * D2i + dci;
                } else if (kind == 3) {
                    const double Aq = FA[n] * invPs;
                    const int sA = Aq < 0.0 ? -1 : 1;
                    const double Ap = Aq + Dr;
                    const int sp = Ap < 0.0 ? -1 : (Ap > 0.0 ? 1 : 0);
                    ndr = static_cast<double>(sp - sA) * Aq +
                          static_cast<double>(sp) * Dr + dcr;
                    ndi = D2i + dci;
                } else {
                    ndr = Dr + dcr + phoenixP * dpr;
                    ndi = D2i + dci + phoenixP * dpi;
                }
                dpr = dr; dpi = di;
                dr = ndr; di = ndi;
                ++n;
            }
            g_field[static_cast<size_t>(y) * w + x] = value;
        }
    }
    return 0;
}

extern "C" {

/** Render one horizontal band of a non-holomorphic built-in family against
 *  a ladder of R arbitrary-precision reference orbits. */
__attribute__((export_name("fc_render_family")))
int32_t fc_render_family(
    int32_t kind, int32_t mode, int32_t w, int32_t h, int32_t maxiter,
    double bail2, int32_t R, int32_t stride,
    const double* Zr, const double* Zi,
    const double* foldA, const double* foldB,
    const double* offX, const double* offY,
    double dMant, int32_t dExp2,
    double rotCos, double rotSin, double phoenixP,
    int32_t y0, int32_t y1, int32_t smoothBias) {
    g_error.clear();
    if (kind < 1 || kind > 5 || mode < 0 || mode > 1) { g_error = "bad family/mode"; return 1; }
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || maxiter < 1) {
        g_error = "bad frame dimensions"; return 2;
    }
    if (R < 1 || stride < maxiter + 1 || !Zr || !Zi || !foldA || !foldB ||
        !offX || !offY) { g_error = "missing reference ladder"; return 3; }
    if (y0 < 0 || y1 > h || y1 <= y0) { g_error = "bad band"; return 4; }
    /* Plain doubles cover every shipped depth and are ~10x faster than the
     * float-exp arithmetic.  Beyond 2^-900 the pixel scale underflows a
     * double, so the FE kernel above takes over (arbitrary depth, slower). */
    if (dExp2 > -900)
        return renderFamilyBandScaled(kind, mode, w, h, maxiter, bail2, R, stride,
                                      Zr, Zi, foldA, foldB, offX, offY,
                                      dMant, dExp2, rotCos, rotSin, phoenixP,
                                      y0, y1, smoothBias);
    return renderFamilyBand(kind, mode, w, h, maxiter, bail2, R, stride,
                            Zr, Zi, foldA, foldB, offX, offY,
                            dMant, dExp2, rotCos, rotSin, phoenixP,
                            y0, y1, smoothBias);
}

/** Legacy z^d+c entry point uses K = 4. */
__attribute__((export_name("fc_jet_order")))
int32_t fc_jet_order(void) { return 4; }

/** Highest jet order the general renderer can consume. */
__attribute__((export_name("fc_jet_max")))
int32_t fc_jet_max(void) { return JK_MAX; }

/** Legacy z^d+c entry point (K = 4, fixed stride).  Kept so the stage-2 part-1
 *  acceptance numbers remain reproducible byte for byte. */
__attribute__((export_name("fc_render_perturb")))
int32_t fc_render_perturb(int32_t prog,
                          int32_t w, int32_t h, int32_t maxiter,
                          int32_t mode, double bail2,
                          int32_t orbitLen,
                          const double* orbZr, const double* orbZi,
                          const double* coefA, const double* coefB,
                          double dMant, int32_t dExp2,
                          double rotCos, double rotSin,
                          int32_t y0, int32_t y1,
                          int32_t saSkip, const double* saAt) {
    g_error.clear();
    if (prog < 0 || static_cast<size_t>(prog) >= g_programs.size()) {
        g_error = "bad program id"; return 1;
    }
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || maxiter < 1) {
        g_error = "bad frame dimensions"; return 2;
    }
    if (orbitLen < 1 || !orbZr || !orbZi || !coefA || !coefB) {
        g_error = "missing reference orbit"; return 3;
    }
    if (y0 < 0 || y1 > h || y1 <= y0) { g_error = "bad band"; return 4; }
    return renderBand(w, h, maxiter, mode, bail2, orbitLen, orbZr, orbZi,
                      coefA, coefB, 4, 10, dMant, dExp2, rotCos, rotSin,
                      y0, y1, saSkip, saAt, 0);
}

/** General entry point: any expression, any jet order up to JK_MAX, optional
 *  singleref glitch rebase, and a band (y0..y1) for parallel workers. */
__attribute__((export_name("fc_render_jet")))
int32_t fc_render_jet(int32_t prog,
                      int32_t w, int32_t h, int32_t maxiter,
                      int32_t mode, double bail2,
                      int32_t orbitLen,
                      const double* orbZr, const double* orbZi,
                      const double* coefA, const double* coefB,
                      int32_t jetOrder, int32_t stride,
                      double dMant, int32_t dExp2,
                      double rotCos, double rotSin,
                      int32_t y0, int32_t y1,
                      int32_t saSkip, const double* saAt,
                      int32_t rebase) {
    g_error.clear();
    if (prog < 0 || static_cast<size_t>(prog) >= g_programs.size()) {
        g_error = "bad program id"; return 1;
    }
    if (w < 1 || h < 1 || w > 8192 || h > 8192 || maxiter < 1) {
        g_error = "bad frame dimensions"; return 2;
    }
    if (orbitLen < 1 || !orbZr || !orbZi || !coefA || !coefB) {
        g_error = "missing reference orbit"; return 3;
    }
    if (jetOrder < 1 || jetOrder > JK_MAX || stride < (jetOrder + 1) * 2) {
        g_error = "bad jet order/stride"; return 5;
    }
    if (y0 < 0 || y1 > h || y1 <= y0) { g_error = "bad band"; return 4; }
    return renderBand(w, h, maxiter, mode, bail2, orbitLen, orbZr, orbZi,
                      coefA, coefB, jetOrder, stride, dMant, dExp2,
                      rotCos, rotSin, y0, y1, saSkip, saAt, rebase);
}

}  // extern "C"
