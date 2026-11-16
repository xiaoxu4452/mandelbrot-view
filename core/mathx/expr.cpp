// expr.cpp — see expr.hpp.
#include "expr.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <utility>

namespace mx {
namespace {

/* ------------------------------------------------------------------ lexer -- */

enum class T { End, Num, Ident, Op };

struct Tok {
    T t = T::End;
    std::string text;
    size_t pos = 0;
};

bool is_ident_start(char c) {
    return std::isalpha((unsigned char)c) != 0 || c == '_';
}
bool is_ident_char(char c) {
    return std::isalnum((unsigned char)c) != 0 || c == '_';
}

std::vector<Tok> lex(const std::string& s) {
    std::vector<Tok> out;
    size_t i = 0;
    const size_t n = s.size();
    while (i < n) {
        const char c = s[i];
        if (std::isspace((unsigned char)c)) { ++i; continue; }
        if (c == '#') {
            while (i < n && s[i] != '\n') ++i;
            continue;
        }
        if (std::isdigit((unsigned char)c) ||
            (c == '.' && i + 1 < n && std::isdigit((unsigned char)s[i + 1]))) {
            size_t j = i;
            while (j < n && (std::isdigit((unsigned char)s[j]) || s[j] == '.')) ++j;
            if (j < n && (s[j] == 'e' || s[j] == 'E')) {
                size_t k = j + 1;
                if (k < n && (s[k] == '+' || s[k] == '-')) ++k;
                if (k < n && std::isdigit((unsigned char)s[k])) {
                    while (k < n && std::isdigit((unsigned char)s[k])) ++k;
                    j = k;
                }
            }
            out.push_back({T::Num, s.substr(i, j - i), i});
            i = j;
            continue;
        }
        if (is_ident_start(c)) {
            size_t j = i;
            while (j < n && is_ident_char(s[j])) ++j;
            out.push_back({T::Ident, s.substr(i, j - i), i});
            i = j;
            continue;
        }
        if (i + 1 < n) {
            const std::string two = s.substr(i, 2);
            if (two == "<=" || two == ">=" || two == "==" || two == "!=" ||
                two == "&&" || two == "||" || two == "**") {
                out.push_back({T::Op, two == "**" ? "^" : two, i});
                i += 2;
                continue;
            }
        }
        if (std::strchr("+-*/^%(),<>?:!", c)) {
            out.push_back({T::Op, std::string(1, c), i});
            ++i;
            continue;
        }
        throw ExprError(std::string("unexpected character '") + c + "'", i);
    }
    out.push_back({T::End, "", n});
    return out;
}

/* --------------------------------------------------------------- function -- */

enum Fn1 {
    F_SIN, F_COS, F_TAN, F_COT, F_SEC, F_CSC,
    F_ASIN, F_ACOS, F_ATAN, F_ASINH, F_ACOSH, F_ATANH,
    F_SINH, F_COSH, F_TANH,
    F_EXP, F_EXP2, F_EXP10, F_LOG, F_LOG2, F_LOG10,
    F_SQRT, F_CBRT,
    F_ABS, F_ABS2, F_ARG, F_CONJ, F_RE, F_IM,
    F_FLOOR, F_CEIL, F_ROUND, F_TRUNC, F_FRAC, F_SIGN,
    F_NOT
};
enum Fn2 {
    F_POW, F_MIN, F_MAX, F_ATAN2, F_MOD, F_HYPOT, F_ROOT, F_LOGB,
    F_LAND, F_LOR
};
enum Fn3 { F_IF, F_CLAMP };

/* 0..5 comparison codes, stored in CMP.arg. */
enum Cmp { CMP_LT, CMP_LE, CMP_GT, CMP_GE, CMP_EQ, CMP_NE };

int fn1_id(const std::string& n) {
    if (n == "sin") return F_SIN;
    if (n == "cos") return F_COS;
    if (n == "tan") return F_TAN;
    if (n == "cot") return F_COT;
    if (n == "sec") return F_SEC;
    if (n == "csc") return F_CSC;
    if (n == "asin" || n == "arcsin") return F_ASIN;
    if (n == "acos" || n == "arccos") return F_ACOS;
    if (n == "atan" || n == "arctan") return F_ATAN;
    if (n == "asinh") return F_ASINH;
    if (n == "acosh") return F_ACOSH;
    if (n == "atanh") return F_ATANH;
    if (n == "sinh") return F_SINH;
    if (n == "cosh") return F_COSH;
    if (n == "tanh") return F_TANH;
    if (n == "exp") return F_EXP;
    if (n == "exp2") return F_EXP2;
    if (n == "exp10") return F_EXP10;
    if (n == "log" || n == "ln") return F_LOG;
    if (n == "log2") return F_LOG2;
    if (n == "log10") return F_LOG10;
    if (n == "sqrt") return F_SQRT;
    if (n == "cbrt") return F_CBRT;
    if (n == "abs" || n == "cabs" || n == "mag") return F_ABS;
    if (n == "abs2" || n == "norm" || n == "sqabs") return F_ABS2;
    if (n == "arg" || n == "phase") return F_ARG;
    if (n == "conj") return F_CONJ;
    if (n == "re" || n == "real") return F_RE;
    if (n == "im" || n == "imag") return F_IM;
    if (n == "floor") return F_FLOOR;
    if (n == "ceil") return F_CEIL;
    if (n == "round") return F_ROUND;
    if (n == "trunc") return F_TRUNC;
    if (n == "frac") return F_FRAC;
    if (n == "sign" || n == "sgn") return F_SIGN;
    return -1;
}

int fn2_id(const std::string& n) {
    if (n == "pow") return F_POW;
    if (n == "min") return F_MIN;
    if (n == "max") return F_MAX;
    if (n == "atan2") return F_ATAN2;
    if (n == "mod" || n == "fmod") return F_MOD;
    if (n == "hypot") return F_HYPOT;
    if (n == "root") return F_ROOT;
    if (n == "logb") return F_LOGB;
    return -1;
}

int fn3_id(const std::string& n) {
    if (n == "if" || n == "select") return F_IF;
    if (n == "clamp") return F_CLAMP;
    return -1;
}

/* ---------------------------------------------------------------- parser -- */

class Parser {
 public:
    Parser(std::vector<Tok> toks, Program& p, int digits)
        : t_(std::move(toks)), root_(&p), p_(&p), digits_(digits) {}

    void parse() {
        if (t_[0].t == T::End) throw ExprError("empty expression", 0);
        parseExpr();
        if (peek().t != T::End)
            throw ExprError("unexpected '" + peek().text + "'", peek().pos);
        root_->nvars = nvars_;
    }

 private:
    const Tok& peek(size_t ahead = 0) const {
        const size_t i = std::min(i_ + ahead, t_.size() - 1);
        return t_[i];
    }
    Tok take() { return t_[i_ < t_.size() - 1 ? i_++ : i_]; }
    bool is_op(const char* op) const {
        return peek().t == T::Op && peek().text == op;
    }
    void need(const char* op, const char* what) {
        if (!is_op(op)) throw ExprError(std::string("expected ") + what, peek().pos);
        take();
    }
    void emit(Program::Op op, int arg = 0, int aux = 0) {
        p_->code.push_back({(uint8_t)op, (int16_t)arg, (int16_t)aux});
    }

    void parseExpr() {
        parseOr();
        if (is_op("?")) {
            take();
            parseExpr();
            need(":", "':' in ?:");
            parseExpr();
            emit(Program::CALL3, F_IF);
        }
    }

    void parseOr() {
        parseAnd();
        while (is_op("||")) {
            take();
            parseAnd();
            emit(Program::CALL2, F_LOR);
        }
    }

    void parseAnd() {
        parseCompare();
        while (is_op("&&")) {
            take();
            parseCompare();
            emit(Program::CALL2, F_LAND);
        }
    }

    void parseCompare() {
        parseAdd();
        while (peek().t == T::Op &&
               (peek().text == "<" || peek().text == ">" || peek().text == "<=" ||
                peek().text == ">=" || peek().text == "==" || peek().text == "!=")) {
            const std::string op = take().text;
            parseAdd();
            int code = CMP_LT;
            if (op == "<") code = CMP_LT;
            else if (op == "<=") code = CMP_LE;
            else if (op == ">") code = CMP_GT;
            else if (op == ">=") code = CMP_GE;
            else if (op == "==") code = CMP_EQ;
            else code = CMP_NE;
            emit(Program::CMP, code);
        }
    }

    void parseAdd() {
        parseMul();
        while (is_op("+") || is_op("-")) {
            const bool plus = take().text == "+";
            parseMul();
            emit(plus ? Program::ADD : Program::SUB);
        }
    }

    bool starts_primary() const {
        const Tok& k = peek();
        return k.t == T::Num || k.t == T::Ident || (k.t == T::Op && k.text == "(");
    }

    void parseMul() {
        parseUnary();
        for (;;) {
            if (is_op("*") || is_op("/") || is_op("%")) {
                const std::string op = take().text;
                parseUnary();
                if (op == "*") emit(Program::MUL);
                else if (op == "/") { emit(Program::DIV); root_->transcendental = true; }
                else { emit(Program::CALL2, F_MOD); root_->holomorphic = false; }
            } else if (starts_primary()) {
                parseUnary();
                emit(Program::MUL);
            } else {
                break;
            }
        }
    }

    void parseUnary() {
        if (is_op("-")) {
            take();
            parseUnary();
            emit(Program::NEG);
            return;
        }
        if (is_op("+")) {
            take();
            parseUnary();
            return;
        }
        if (is_op("!")) {
            take();
            parseUnary();
            emit(Program::CALL1, F_NOT);
            return;
        }
        parsePow();
    }

    void parsePow() {
        parsePrimary();
        if (is_op("^")) {
            take();
            parseUnary();          // right associative, allows z^-1
            emit(Program::POW);
            root_->transcendental = true;
        }
    }

    BigFloat number(const Tok& k) {
        try {
            return BigFloat::from_string(k.text);
        } catch (const std::exception&) {
            throw ExprError("bad number '" + k.text + "'", k.pos);
        }
    }

    void emit_const(const BC& v) {
        p_->consts.push_back(v);
        emit(Program::CONST, (int)(p_->consts.size() - 1));
    }

    int param_slot(const std::string& name, size_t pos) {
        for (size_t i = 0; i < root_->params.size(); ++i)
            if (root_->params[i] == name) return (int)i;
        if (root_->params.size() >= 26)
            throw ExprError("too many parameters (limit 26)", pos);
        root_->params.push_back(name);
        return (int)(root_->params.size() - 1);
    }

    /* sum(k, a, b, body) / prod(...): the body is its own program, the bound
     * variable gets a dedicated slot so nesting works. */
    void parseLoop(bool isSum) {
        need("(", "'('");
        if (peek().t != T::Ident || peek().text.size() != 1)
            throw ExprError("loop variable must be a single letter", peek().pos);
        const Tok v = take();
        if (v.text == "z" || v.text == "c" || v.text == "n" || v.text == "i" ||
            v.text == "e" || v.text == "z")
            throw ExprError("'" + v.text + "' is reserved and cannot be a loop variable", v.pos);
        need(",", "',' after the loop variable");
        parseExpr();
        need(",", "',' after the loop start");
        parseExpr();
        need(",", "',' after the loop end");

        const int slot = nvars_++;
        Program* saved = p_;
        Program body;
        body.source = saved->source;
        p_ = &body;
        scopes_.push_back({v.text, slot});
        parseExpr();
        scopes_.pop_back();
        p_ = saved;
        if (!is_op(")")) throw ExprError("expected ')' to close the loop", peek().pos);
        take();

        saved->subs.push_back(std::move(body));
        const int idx = (int)saved->subs.size() - 1;
        emit(isSum ? Program::LOOP_SUM : Program::LOOP_PROD, idx, slot);
    }

    void parsePrimary() {
        const Tok k = take();
        if (k.t == T::Num) {
            emit_const(BC{number(k), BigFloat()});
            return;
        }
        if (k.t == T::Op && k.text == "(") {
            parseExpr();
            need(")", "')'");
            return;
        }
        if (k.t == T::Ident) {
            const std::string& name = k.text;
            if (is_op("(")) {
                take();
                if (name == "sum" || name == "prod") {
                    i_ -= 1;                     // step back onto '('
                    parseLoop(name == "sum");
                    return;
                }
                int args = 0;
                if (!is_op(")")) {
                    for (;;) {
                        parseExpr();
                        ++args;
                        if (is_op(",")) { take(); continue; }
                        break;
                    }
                }
                if (!is_op(")")) throw ExprError("expected ')' after arguments", peek().pos);
                take();
                const int f1 = fn1_id(name);
                const int f2 = fn2_id(name);
                const int f3 = fn3_id(name);
                if (args == 1 && f1 >= 0) {
                    emit(Program::CALL1, f1);
                    if (f1 == F_CONJ || f1 == F_RE || f1 == F_IM || f1 == F_ABS ||
                        f1 == F_ABS2 || f1 == F_ARG)
                        root_->holomorphic = false;
                    if (f1 != F_ABS && f1 != F_ABS2 && f1 != F_ARG && f1 != F_CONJ &&
                        f1 != F_RE && f1 != F_IM)
                        root_->transcendental = true;
                    return;
                }
                if (args == 2 && f2 >= 0) {
                    emit(Program::CALL2, f2);
                    if (f2 == F_ATAN2 || f2 == F_HYPOT || f2 == F_MOD)
                        root_->holomorphic = false;
                    if (f2 == F_POW || f2 == F_ROOT || f2 == F_LOGB || f2 == F_ATAN2)
                        root_->transcendental = true;
                    return;
                }
                if (args == 3 && f3 >= 0) {
                    emit(Program::CALL3, f3);
                    return;
                }
                if (f1 >= 0 || f2 >= 0 || f3 >= 0) {
                    const char* want = (args == 1) ? "1" : (args == 2) ? "2" : "3";
                    throw ExprError("'" + name + "' takes " + want + " argument(s), got " +
                                        std::to_string(args), k.pos);
                }
                throw ExprError("unknown function '" + name + "'", k.pos);
            }
            if (name == "z") { emit(Program::Z); return; }
            if (name == "c") { root_->uses_c = true; emit(Program::C); return; }
            if (name == "n") { root_->uses_n = true; emit(Program::N); return; }
            if (name == "z1" || name == "z_1" || name == "zp" || name == "zprev") {
                root_->uses_z1 = true;
                emit(Program::Z1);
                return;
            }
            if (name == "i") { emit_const(BC{BigFloat(), BigFloat((int64_t)1)}); return; }
            if (name == "pi") { emit_const(BC{bm::pi(), BigFloat()}); return; }
            if (name == "tau") {
                emit_const(BC{bm::pi().mul_ui(2), BigFloat()});
                return;
            }
            if (name == "e") {
                emit_const(BC{bm::exp(BigFloat((int64_t)1)), BigFloat()});
                return;
            }
            if (name == "phi") {
                const BigFloat r5 = bm::sqrt(BigFloat((int64_t)5));
                emit_const(BC{bm::div(BigFloat((int64_t)1).add(r5), BigFloat((int64_t)2)),
                              BigFloat()});
                return;
            }
            for (size_t si = scopes_.size(); si-- > 0;) {
                if (scopes_[si].first == name) {
                    emit(Program::VAR, 0, scopes_[si].second);
                    return;
                }
            }
            if (name.size() == 1 && std::isalpha((unsigned char)name[0])) {
                emit(Program::PARAM, param_slot(name, k.pos));
                return;
            }
            throw ExprError("unknown symbol '" + name + "'", k.pos);
        }
        if (k.t == T::End) throw ExprError("unexpected end of expression", k.pos);
        throw ExprError("unexpected '" + k.text + "'", k.pos);
    }

    std::vector<Tok> t_;
    Program* root_;
    Program* p_;
    int digits_;
    size_t i_ = 0;
    int nvars_ = 0;
    /* Loop variables are lexically scoped: innermost binding wins. */
    std::vector<std::pair<std::string, int>> scopes_;
};

/* ------------------------------------------------------------------ jets -- */

inline BigFloat bfd(double v) { return BigFloat::from_double(v); }
inline Jet jc(const BC& v) { Jet j; j.v = v; return j; }
inline Jet jnum(int64_t v) { return jc(BC{BigFloat(v), BigFloat()}); }

inline Jet jadd(const Jet& u, const Jet& v) {
    Jet o;
    o.v = bc_add(u.v, v.v);
    o.dz = bc_add(u.dz, v.dz);
    o.dzb = bc_add(u.dzb, v.dzb);
    o.dzz = bc_add(u.dzz, v.dzz);
    o.dzzb = bc_add(u.dzzb, v.dzzb);
    o.dzbb = bc_add(u.dzbb, v.dzbb);
    o.dc = bc_add(u.dc, v.dc);
    o.dzc = bc_add(u.dzc, v.dzc);
    o.dcc = bc_add(u.dcc, v.dcc);
    o.dz1 = bc_add(u.dz1, v.dz1);
    return o;
}
inline Jet jsub(const Jet& u, const Jet& v) {
    Jet o;
    o.v = bc_sub(u.v, v.v);
    o.dz = bc_sub(u.dz, v.dz);
    o.dzb = bc_sub(u.dzb, v.dzb);
    o.dzz = bc_sub(u.dzz, v.dzz);
    o.dzzb = bc_sub(u.dzzb, v.dzzb);
    o.dzbb = bc_sub(u.dzbb, v.dzbb);
    o.dc = bc_sub(u.dc, v.dc);
    o.dzc = bc_sub(u.dzc, v.dzc);
    o.dcc = bc_sub(u.dcc, v.dcc);
    o.dz1 = bc_sub(u.dz1, v.dz1);
    return o;
}
inline Jet jneg(const Jet& u) {
    Jet o;
    o.v = bc_neg(u.v);
    o.dz = bc_neg(u.dz);
    o.dzb = bc_neg(u.dzb);
    o.dzz = bc_neg(u.dzz);
    o.dzzb = bc_neg(u.dzzb);
    o.dzbb = bc_neg(u.dzbb);
    o.dc = bc_neg(u.dc);
    o.dzc = bc_neg(u.dzc);
    o.dcc = bc_neg(u.dcc);
    o.dz1 = bc_neg(u.dz1);
    return o;
}
inline Jet jscale(const Jet& u, const BigFloat& s) {
    Jet o;
    o.v = bc_scale(u.v, s);
    o.dz = bc_scale(u.dz, s);
    o.dzb = bc_scale(u.dzb, s);
    o.dzz = bc_scale(u.dzz, s);
    o.dzzb = bc_scale(u.dzzb, s);
    o.dzbb = bc_scale(u.dzbb, s);
    o.dc = bc_scale(u.dc, s);
    o.dzc = bc_scale(u.dzc, s);
    o.dcc = bc_scale(u.dcc, s);
    o.dz1 = bc_scale(u.dz1, s);
    return o;
}
inline Jet jhalf(const Jet& u) {
    Jet o;
    o.v = BC{bm::div_ui(u.v.re, 2), bm::div_ui(u.v.im, 2)};
    o.dz = BC{bm::div_ui(u.dz.re, 2), bm::div_ui(u.dz.im, 2)};
    o.dzb = BC{bm::div_ui(u.dzb.re, 2), bm::div_ui(u.dzb.im, 2)};
    o.dzz = BC{bm::div_ui(u.dzz.re, 2), bm::div_ui(u.dzz.im, 2)};
    o.dzzb = BC{bm::div_ui(u.dzzb.re, 2), bm::div_ui(u.dzzb.im, 2)};
    o.dzbb = BC{bm::div_ui(u.dzbb.re, 2), bm::div_ui(u.dzbb.im, 2)};
    o.dc = BC{bm::div_ui(u.dc.re, 2), bm::div_ui(u.dc.im, 2)};
    o.dzc = BC{bm::div_ui(u.dzc.re, 2), bm::div_ui(u.dzc.im, 2)};
    o.dcc = BC{bm::div_ui(u.dcc.re, 2), bm::div_ui(u.dcc.im, 2)};
    o.dz1 = BC{bm::div_ui(u.dz1.re, 2), bm::div_ui(u.dz1.im, 2)};
    return o;
}

/* w = u * v.  For a holomorphic program dzb / dzzb / dzbb are identically zero,
 * so the three cross terms are skipped: that is the common case and it makes
 * the reference orbit cheaper than the finite-difference code it replaces. */
void jmul(const Jet& u, const Jet& v, Jet& o, bool holo) {
    o.v = bc_mul(u.v, v.v);
    o.dz = bc_add(bc_mul(u.dz, v.v), bc_mul(u.v, v.dz));
    o.dzz = bc_add(bc_add(bc_mul(u.dzz, v.v), bc_mul(u.dz, v.dz)), bc_mul(u.v, v.dzz));
    o.dc = bc_add(bc_mul(u.dc, v.v), bc_mul(u.v, v.dc));
    o.dzc = bc_add(bc_add(bc_add(bc_mul(u.dzc, v.v), bc_mul(u.dz, v.dc)),
                          bc_mul(u.dc, v.dz)), bc_mul(u.v, v.dzc));
    o.dcc = bc_add(bc_add(bc_mul(u.dcc, v.v),
                          bc_scale(bc_mul(u.dc, v.dc), BigFloat((int64_t)2))),
                   bc_mul(u.v, v.dcc));
    o.dz1 = bc_add(bc_mul(u.dz1, v.v), bc_mul(u.v, v.dz1));
    if (holo) {
        o.dzb = BC{};
        o.dzzb = BC{};
        o.dzbb = BC{};
        return;
    }
    o.dzb = bc_add(bc_mul(u.dzb, v.v), bc_mul(u.v, v.dzb));
    o.dzzb = bc_add(bc_add(bc_add(bc_mul(u.dzzb, v.v), bc_mul(u.dz, v.dzb)),
                           bc_mul(u.dzb, v.dz)), bc_mul(u.v, v.dzzb));
    o.dzbb = bc_add(bc_add(bc_mul(u.dzbb, v.v), bc_mul(u.dzb, v.dzb)),
                    bc_mul(u.v, v.dzbb));
}

void jrecip(const Jet& u, Jet& o, bool holo) {
    const BC r = bc_div(bc_int(1), u.v);
    const BC r2 = bc_mul(r, r);
    const BC r3 = bc_mul(r2, r);
    o.v = r;
    o.dz = bc_neg(bc_mul(u.dz, r2));
    o.dzz = bc_add(bc_neg(bc_mul(u.dzz, r2)), bc_mul(bc_mul(u.dz, u.dz), r3));
    o.dc = bc_neg(bc_mul(u.dc, r2));
    /* d/dc of 1/u is -u_c/u^2; the second order adds 2 u_c^2/u^3 */
    o.dzc = bc_add(bc_neg(bc_mul(u.dzc, r2)),
                   bc_mul(bc_scale(bc_mul(u.dz, u.dc), BigFloat((int64_t)2)), r3));
    o.dcc = bc_add(bc_neg(bc_mul(u.dcc, r2)),
                   bc_mul(bc_scale(bc_mul(u.dc, u.dc), BigFloat((int64_t)2)), r3));
    o.dz1 = bc_neg(bc_mul(u.dz1, r2));
    if (holo) { o.dzb = BC{}; o.dzzb = BC{}; o.dzbb = BC{}; return; }
    o.dzb = bc_neg(bc_mul(u.dzb, r2));
    o.dzzb = bc_add(bc_neg(bc_mul(u.dzzb, r2)),
                    bc_mul(bc_scale(bc_mul(u.dz, u.dzb), BigFloat((int64_t)2)), r3));
    o.dzbb = bc_add(bc_neg(bc_mul(u.dzbb, r2)), bc_mul(bc_mul(u.dzb, u.dzb), r3));
}

void jdiv(const Jet& u, const Jet& v, Jet& o, bool holo) {
    Jet r;
    jrecip(v, r, holo);
    jmul(u, r, o, holo);
}

void jconj(const Jet& u, Jet& o) {
    o.v = bc_conj(u.v);
    o.dz = bc_conj(u.dzb);
    o.dzb = bc_conj(u.dz);
    o.dzz = bc_conj(u.dzbb);
    o.dzzb = bc_conj(u.dzzb);
    o.dzbb = bc_conj(u.dzz);
    o.dc = bc_conj(u.dc);
    o.dzc = bc_conj(u.dzc);
    o.dcc = bc_conj(u.dcc);
    o.dz1 = bc_conj(u.dz1);
}

/* f(u) with f' and f'' supplied by the caller. */
void jchain(const Jet& u, const BC& d1, const BC& d2, const BC& val, Jet& o,
            bool holo) {
    o.v = val;
    o.dz = bc_mul(d1, u.dz);
    o.dc = bc_mul(d1, u.dc);
    o.dzc = bc_add(bc_mul(d2, bc_mul(u.dz, u.dc)), bc_mul(d1, u.dzc));
    o.dcc = bc_add(bc_mul(d2, bc_mul(u.dc, u.dc)), bc_mul(d1, u.dcc));
    o.dz1 = bc_mul(d1, u.dz1);
    o.dzz = bc_add(bc_mul(d2, jhalf(jc(bc_mul(u.dz, u.dz))).v), bc_mul(d1, u.dzz));
    if (holo) { o.dzb = BC{}; o.dzzb = BC{}; o.dzbb = BC{}; return; }
    o.dzb = bc_mul(d1, u.dzb);
    o.dzzb = bc_add(bc_mul(d2, bc_mul(u.dz, u.dzb)), bc_mul(d1, u.dzzb));
    o.dzbb = bc_add(bc_mul(d2, jhalf(jc(bc_mul(u.dzb, u.dzb))).v), bc_mul(d1, u.dzbb));
}

/* True when f' and f'' exist in closed form for `f` (holomorphic functions). */
bool holo1(int f, const BC& x, BC& val, BC& d1, BC& d2) {
    switch (f) {
        case F_SIN:
            val = bc_sin(x);
            d1 = bc_cos(x);
            d2 = bc_neg(val);
            return true;
        case F_COS:
            val = bc_cos(x);
            d1 = bc_neg(bc_sin(x));
            d2 = bc_neg(val);
            return true;
        case F_TAN: {
            val = bc_tan(x);
            const BC t1 = bc_add(bc_int(1), bc_mul(val, val));
            d1 = t1;
            d2 = bc_scale(bc_mul(val, t1), BigFloat((int64_t)2));
            return true;
        }
        case F_SINH:
            val = bc_sinh(x);
            d1 = bc_cosh(x);
            d2 = val;
            return true;
        case F_COSH:
            val = bc_cosh(x);
            d1 = bc_sinh(x);
            d2 = val;
            return true;
        case F_TANH: {
            val = bc_tanh(x);
            const BC t1 = bc_sub(bc_int(1), bc_mul(val, val));
            d1 = t1;
            d2 = bc_scale(bc_mul(val, t1), BigFloat((int64_t)-2));
            return true;
        }
        case F_EXP:
            val = bc_exp(x);
            d1 = val;
            d2 = val;
            return true;
        case F_EXP2: {
            const BigFloat l2 = bm::log(BigFloat((int64_t)2));
            val = bc_exp(bc_scale(x, l2));
            d1 = bc_scale(val, l2);
            d2 = d1;
            return true;
        }
        case F_EXP10: {
            const BigFloat l10 = bm::ln10();
            val = bc_exp(bc_scale(x, l10));
            d1 = bc_scale(val, l10);
            d2 = d1;
            return true;
        }
        case F_LOG:
            val = bc_log(x);
            d1 = bc_div(bc_int(1), x);
            d2 = bc_neg(bc_mul(d1, d1));
            return true;
        case F_LOG2: {
            const BigFloat l2 = bm::log(BigFloat((int64_t)2));
            const BigFloat inv = bm::div(BigFloat((int64_t)1), l2);
            val = bc_scale(bc_log(x), inv);
            d1 = bc_scale(bc_div(bc_int(1), x), inv);
            d2 = bc_neg(bc_scale(bc_mul(d1, d1), l2));
            return true;
        }
        case F_LOG10: {
            const BigFloat l10 = bm::ln10();
            const BigFloat inv = bm::div(BigFloat((int64_t)1), l10);
            val = bc_scale(bc_log(x), inv);
            d1 = bc_scale(bc_div(bc_int(1), x), inv);
            d2 = bc_neg(bc_scale(bc_mul(d1, d1), l10));
            return true;
        }
        case F_SQRT: {
            val = bc_sqrt(x);
            const BC two_v = bc_scale(val, BigFloat((int64_t)2));
            d1 = bc_div(bc_int(1), two_v);
            /* f'' = -1 / (4 x^{3/2}) = -f' / (2x) */
            d2 = bc_neg(bc_div(d1, bc_scale(x, BigFloat((int64_t)2))));
            return true;
        }
        case F_CBRT: {
            const BigFloat third = bm::div(BigFloat((int64_t)1), BigFloat((int64_t)3));
            val = bc_exp(bc_scale(bc_log(x), third));
            const BC v2 = bc_mul(val, val);
            d1 = bc_div(bc_int(1), bc_scale(v2, BigFloat((int64_t)3)));
            const BC v3 = bc_mul(v2, val);
            d2 = bc_neg(bc_div(bc_int(2), bc_scale(v3, BigFloat((int64_t)9))));
            return true;
        }
        case F_ASIN: {
            val = bc_asin(x);
            const BC om = bc_sub(bc_int(1), bc_mul(x, x));
            const BC s = bc_sqrt(om);
            d1 = bc_div(bc_int(1), s);
            d2 = bc_div(x, bc_mul(om, s));
            return true;
        }
        case F_ACOS: {
            val = bc_acos(x);
            const BC om = bc_sub(bc_int(1), bc_mul(x, x));
            const BC s = bc_sqrt(om);
            d1 = bc_neg(bc_div(bc_int(1), s));
            d2 = bc_neg(bc_div(x, bc_mul(om, s)));
            return true;
        }
        case F_ATAN: {
            val = bc_atan(x);
            const BC den = bc_add(bc_int(1), bc_mul(x, x));
            d1 = bc_div(bc_int(1), den);
            d2 = bc_neg(bc_div(bc_scale(x, BigFloat((int64_t)2)), bc_mul(den, den)));
            return true;
        }
        case F_ASINH: {
            const BC om = bc_add(bc_int(1), bc_mul(x, x));
            const BC den = bc_sqrt(om);
            val = bc_log(bc_add(x, den));
            d1 = bc_div(bc_int(1), den);
            d2 = bc_neg(bc_div(x, bc_mul(om, den)));
            return true;
        }
        case F_ACOSH: {
            const BC om = bc_sub(bc_mul(x, x), bc_int(1));
            const BC den = bc_sqrt(om);
            val = bc_log(bc_add(x, den));
            d1 = bc_div(bc_int(1), den);
            d2 = bc_neg(bc_div(x, bc_mul(om, den)));
            return true;
        }
        case F_ATANH: {
            const BC den = bc_sub(bc_int(1), bc_mul(x, x));
            val = jhalf(jc(bc_log(bc_div(bc_add(bc_int(1), x), bc_sub(bc_int(1), x))))).v;
            d1 = bc_div(bc_int(1), den);
            d2 = bc_div(bc_scale(x, BigFloat((int64_t)2)), bc_mul(den, den));
            return true;
        }
        default: return false;
    }
}

void jabs2(const Jet& u, Jet& o) {
    Jet cj;
    jconj(u, cj);
    jmul(u, cj, o, false);
}
void jlog(const Jet& u, Jet& o) {
    BC val, d1, d2;
    holo1(F_LOG, u.v, val, d1, d2);
    jchain(u, d1, d2, val, o, false);
}
void jsqrt(const Jet& u, Jet& o) {
    BC val, d1, d2;
    holo1(F_SQRT, u.v, val, d1, d2);
    jchain(u, d1, d2, val, o, false);
}
void jabs(const Jet& u, Jet& o) {
    Jet q;
    jabs2(u, q);
    jsqrt(q, o);
}
void jarg(const Jet& u, Jet& o) {
    Jet l, cj, d;
    jlog(u, l);
    jconj(l, cj);
    d = jsub(l, cj);
    jmul(d, jc(BC{BigFloat(), bfd(-0.5)}), o, false);
}
void jre(const Jet& u, Jet& o) {
    Jet cj, s;
    jconj(u, cj);
    s = jadd(u, cj);
    o = jhalf(s);
}
void jim(const Jet& u, Jet& o) {
    Jet cj, d;
    jconj(u, cj);
    d = jsub(u, cj);
    jmul(d, jc(BC{BigFloat(), bfd(-0.5)}), o, false);
}

/* a^n for an integer n, exact and total at zero. */
void jpowi(const Jet& u, int64_t n, Jet& o, bool holo) {
    if (n == 0) { o = jnum(1); return; }
    const uint64_t e = (uint64_t)(n < 0 ? -n : n);
    Jet base = u, r = jnum(1);
    uint64_t k = e;
    while (k) {
        if (k & 1) {
            /* jmul must not alias its destination: o.v is written before the
             * derivative terms read u.v. */
            Jet t;
            jmul(r, base, t, holo);
            r = t;
        }
        k >>= 1;
        if (k) {
            Jet t;
            jmul(base, base, t, holo);
            base = t;
        }
    }
    if (n < 0) {
        Jet inv;
        jrecip(r, inv, holo);
        o = inv;
        return;
    }
    o = r;
}

void jpow(const Jet& u, const Jet& v, Jet& o, bool holo) {
    if (v.v.im.is_zero()) {
        const BigFloat t = bm::trunc(v.v.re);
        if (t.compare(v.v.re) == 0) {
            const int64_t n = bm::to_int64(v.v.re);
            if (n > -1000000 && n < 1000000) { jpowi(u, n, o, holo); return; }
        }
    }
    if (u.v.re.is_zero() && u.v.im.is_zero()) { o = jc(BC{}); return; }
    Jet l, m, r;
    jlog(u, l);
    jmul(v, l, m, holo);
    BC val, d1, d2;
    holo1(F_EXP, m.v, val, d1, d2);
    jchain(m, d1, d2, val, r, holo);
    o = r;
}

void apply1(int f, const Jet& u, Jet& o, bool holo) {
    BC val, d1, d2;
    if (holo1(f, u.v, val, d1, d2)) { jchain(u, d1, d2, val, o, holo); return; }
    switch (f) {
        case F_COT: {
            BC v2, d12, d22;
            holo1(F_TAN, u.v, v2, d12, d22);
            Jet t;
            jchain(u, d12, d22, v2, t, holo);
            jrecip(t, o, holo);
            break;
        }
        case F_SEC: {
            Jet c;
            BC v2, d12, d22;
            holo1(F_COS, u.v, v2, d12, d22);
            jchain(u, d12, d22, v2, c, holo);
            jrecip(c, o, holo);
            break;
        }
        case F_CSC: {
            Jet s;
            BC v2, d12, d22;
            holo1(F_SIN, u.v, v2, d12, d22);
            jchain(u, d12, d22, v2, s, holo);
            jrecip(s, o, holo);
            break;
        }
        case F_ABS: jabs(u, o); break;
        case F_ABS2: jabs2(u, o); break;
        case F_ARG: jarg(u, o); break;
        case F_CONJ: jconj(u, o); break;
        case F_RE: jre(u, o); break;
        case F_IM: jim(u, o); break;
        case F_FLOOR: o = jc(BC{bm::floor(u.v.re), bm::floor(u.v.im)}); break;
        case F_CEIL: {
            const BigFloat one((int64_t)1);
            o = jc(BC{bm::floor(u.v.re.add(one)).sub(one),
                      bm::floor(u.v.im.add(one)).sub(one)});
            break;
        }
        case F_ROUND: {
            const BigFloat half = bfd(0.5);
            o = jc(BC{bm::floor(u.v.re.add(half)), bm::floor(u.v.im.add(half))});
            break;
        }
        case F_TRUNC: o = jc(BC{bm::trunc(u.v.re), bm::trunc(u.v.im)}); break;
        case F_FRAC: {
            o = jc(BC{u.v.re.sub(bm::trunc(u.v.re)), u.v.im.sub(bm::trunc(u.v.im))});
            break;
        }
        case F_SIGN: o = jc(BC{bfd((double)u.v.re.sign), bfd((double)u.v.im.sign)}); break;
        case F_NOT: o = jnum((u.v.re.is_zero() && u.v.im.is_zero()) ? 1 : 0); break;
        default: o = jc(u.v); break;
    }
}

inline bool truthy(const BC& v) { return !(v.re.is_zero() && v.im.is_zero()); }

void apply2(int f, const Jet& a, const Jet& b, Jet& o, bool holo) {
    switch (f) {
        case F_POW: jpow(a, b, o, holo); break;
        case F_MIN: o = (a.v.re.compare(b.v.re) <= 0) ? a : b; break;
        case F_MAX: o = (a.v.re.compare(b.v.re) >= 0) ? a : b; break;
        case F_ATAN2: o = jc(BC{bm::atan2(a.v.im, a.v.re), BigFloat()}); break;
        case F_MOD: {
            /* Componentwise a - b*floor(a/b) on the real parts; the imaginary
             * part follows the same rule so a real formula stays real. */
            auto mod1 = [](const BigFloat& x, const BigFloat& y) -> BigFloat {
                if (y.is_zero()) return BigFloat();
                const BigFloat q = bm::floor(bm::div(x, y));
                return x.sub(y.mul(q));
            };
            o = jc(BC{mod1(a.v.re, b.v.re), mod1(a.v.im, b.v.im)});
            break;
        }
        case F_HYPOT: {
            const BigFloat s = bm::sqrt(bc_abs2(a.v).add(bc_abs2(b.v)));
            o = jc(BC{s, BigFloat()});
            break;
        }
        case F_ROOT: {
            const BigFloat one((int64_t)1);
            Jet inv = jc(BC{bm::div(one, b.v.re), BigFloat()});
            jpow(a, inv, o, holo);
            break;
        }
        case F_LOGB: {
            Jet la, lb;
            jlog(a, la);
            jlog(b, lb);
            jdiv(la, lb, o, holo);
            break;
        }
        case F_LAND: o = jnum(truthy(a.v) && truthy(b.v) ? 1 : 0); break;
        case F_LOR: o = jnum(truthy(a.v) || truthy(b.v) ? 1 : 0); break;
        default: o = jc(a.v); break;
    }
}

void apply3(int f, const Jet& a, const Jet& b, const Jet& c, Jet& o) {
    if (f == F_IF) {
        o = truthy(a.v) ? b : c;
        return;
    }
    /* clamp(x, lo, hi) */
    if (b.v.re.compare(c.v.re) > 0) { o = b; return; }
    if (a.v.re.compare(b.v.re) < 0) { o = b; return; }
    if (a.v.re.compare(c.v.re) > 0) { o = c; return; }
    o = a;
}

void evalProg(const Program& p, const Jet& z, const Jet& c, const Jet& z1,
              const Jet& n, const BigFloat* params, int nparams, Jet* vars, Jet& out) {
    std::vector<Jet> st;
    st.reserve(p.code.size() + 4);
    const bool holo = p.holomorphic;

    auto pop = [&]() -> Jet {
        Jet t = std::move(st.back());
        st.pop_back();
        return t;
    };

    for (const Program::Ins& in : p.code) {
        switch (in.op) {
            case Program::CONST: st.push_back(jc(p.consts[(size_t)in.arg])); break;
            case Program::Z: st.push_back(z); break;
            case Program::C: st.push_back(c); break;
            case Program::Z1: st.push_back(z1); break;
            case Program::N: st.push_back(n); break;
            case Program::PARAM: {
                const int idx = in.arg;
                const BC v = (params && idx >= 0 && idx < nparams)
                                 ? BC{params[idx], BigFloat()} : BC{};
                st.push_back(jc(v));
                break;
            }
            case Program::VAR: {
                const int idx = in.aux;
                st.push_back(vars && idx >= 0 ? vars[idx] : jc(BC{}));
                break;
            }
            case Program::ADD: {
                const Jet b = pop();
                const Jet a = pop();
                st.push_back(jadd(a, b));
                break;
            }
            case Program::SUB: {
                const Jet b = pop();
                Jet a = pop();
                st.push_back(jsub(a, b));
                break;
            }
            case Program::MUL: {
                const Jet b = pop();
                Jet a = pop();
                Jet o;
                jmul(a, b, o, holo);
                st.push_back(std::move(o));
                break;
            }
            case Program::DIV: {
                const Jet b = pop();
                Jet a = pop();
                Jet o;
                jdiv(a, b, o, holo);
                st.push_back(std::move(o));
                break;
            }
            case Program::POW: {
                const Jet b = pop();
                Jet a = pop();
                Jet o;
                jpow(a, b, o, holo);
                st.push_back(std::move(o));
                break;
            }
            case Program::NEG: {
                Jet a = pop();
                st.push_back(jneg(a));
                break;
            }
            case Program::CALL1: {
                Jet a = pop();
                Jet o;
                apply1(in.arg, a, o, holo);
                st.push_back(std::move(o));
                break;
            }
            case Program::CALL2: {
                const Jet b = pop();
                const Jet a = pop();
                Jet o;
                apply2(in.arg, a, b, o, holo);
                st.push_back(std::move(o));
                break;
            }
            case Program::CALL3: {
                const Jet c3 = pop();
                const Jet b2 = pop();
                const Jet a2 = pop();
                Jet o;
                apply3(in.arg, a2, b2, c3, o);
                st.push_back(std::move(o));
                break;
            }
            case Program::CMP: {
                const Jet b = pop();
                const Jet a = pop();
                const int cmp = a.v.re.compare(b.v.re);
                bool val = false;
                switch (in.arg) {
                    case CMP_LT: val = cmp < 0; break;
                    case CMP_LE: val = cmp <= 0; break;
                    case CMP_GT: val = cmp > 0; break;
                    case CMP_GE: val = cmp >= 0; break;
                    case CMP_EQ: val = cmp == 0; break;
                    default: val = cmp != 0; break;
                }
                st.push_back(jnum(val ? 1 : 0));
                break;
            }
            case Program::LOOP_SUM:
            case Program::LOOP_PROD: {
                const Jet hi = pop();
                const Jet lo = pop();
                int64_t a = bm::to_int64(lo.v.re);
                int64_t b = bm::to_int64(hi.v.re);
                if (b < a) { st.push_back(jnum(in.op == Program::LOOP_SUM ? 0 : 1)); break; }
                if (b - a > 4096) b = a + 4096;      // one pixel must not hang
                Jet acc = jnum(in.op == Program::LOOP_SUM ? 0 : 1);
                const int slot = in.aux;
                Jet local[1];
                Jet* slotPtr = (vars && slot >= 0) ? &vars[slot] : &local[0];
                Jet sub;
                for (int64_t k = a; k <= b; ++k) {
                    *slotPtr = jnum(k);
                    evalProg(p.subs[(size_t)in.arg], z, c, z1, n, params, nparams,
                             vars, sub);
                    if (in.op == Program::LOOP_SUM) {
                        acc = jadd(acc, sub);
                    } else {
                        Jet s;
                        jmul(acc, sub, s,
                             p.holomorphic && p.subs[(size_t)in.arg].holomorphic);
                        acc = std::move(s);
                    }
                }
                st.push_back(std::move(acc));
                break;
            }
            default: break;
        }
    }
    out = st.empty() ? jc(BC{}) : std::move(st.back());
}

}  // namespace

int Program::stack_depth() const {
    int d = 0, mx = 0;
    for (const Ins& i : code) {
        switch (i.op) {
            case CONST: case Z: case C: case Z1: case N: case PARAM: case VAR: ++d; break;
            case ADD: case SUB: case MUL: case DIV: case POW: --d; break;
            case CMP: --d; break;
            case LOOP_SUM: case LOOP_PROD: --d; break;
            case NEG: break;
            case CALL1: break;
            case CALL2: --d; break;
            case CALL3: d -= 2; break;
            default: break;
        }
        if (d > mx) mx = d;
    }
    return mx + 4;
}

Program compile(const std::string& source, int digits) {
    Program p;
    p.source = source;
    if (digits < 20) digits = 20;
    bm::ScopedPrecision guard(digits / 9 + 3);
    Parser parser(lex(source), p, digits);
    parser.parse();
    return p;
}

bool valid(const Program& p) { return !p.code.empty(); }

Jet evalJet(const Program& p, const BC& z, const BC& c, const BC& z1,
            const BigFloat& n, const BigFloat* params, int nparams, Jet* vars) {
    /* Each independent variable gets its own unit seed: the pixel offset can
     * live in z (a Julia view or an orbit point) or in c (a Mandelbrot view),
     * and a map with memory differentiates in z1 as well. */
    std::vector<Jet> slots;
    if (!vars && p.nvars > 0) {
        slots.assign((size_t)p.nvars, Jet{});
        vars = slots.data();
    }
    Jet zj = jc(z), cj = jc(c), z1j = jc(z1), nj = jc(BC{n, BigFloat()});
    zj.dz = bc_int(1);
    cj.dc = bc_int(1);
    z1j.dz1 = bc_int(1);
    Jet out;
    evalProg(p, zj, cj, z1j, nj, params, nparams, vars, out);
    return out;
}

BC run(const Program& p, const BC& z, const BC& c, const BC& z1,
       const BigFloat& n, const BigFloat* params, int nparams) {
    return evalJet(p, z, c, z1, n, params, nparams, nullptr).v;
}

}  // namespace mx
