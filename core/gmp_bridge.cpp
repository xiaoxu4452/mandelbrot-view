#include "gmp_bridge.hpp"

/* Cross-platform runtime binding to the system GMP.
 *
 * Windows : LoadLibraryA / GetProcAddress  (libgmp-10.dll next to the exe)
 * Linux   : dlopen / dlsym                (libgmp.so.10 from libgmp10 / libgmp-dev)
 * macOS   : dlopen / dlsym                (libgmp.10.dylib from Homebrew)
 *
 * GMP is never linked at build time.  When no shared library is found the
 * renderer falls back to its own base-10^9 BigFloat, so the CLI still builds
 * and runs without GMP installed (set MB_GMP=0 to force that path).
 */
#ifdef _WIN32
#  include <windows.h>
using Module = HMODULE;
#else
#  include <dlfcn.h>
#  include <unistd.h>
#  include <limits.h>
#  ifndef PATH_MAX
#    define PATH_MAX 4096
#  endif
using Module = void*;
#endif

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

namespace gmpb {
namespace {

/* --- the imported surface ------------------------------------------------ */
struct Api {
    void (*init2)(void*, unsigned long) = nullptr;
    void (*clear)(void*) = nullptr;
    int (*set_str)(void*, const char*, int) = nullptr;
    void (*set_d)(void*, double) = nullptr;
    void (*set_ui)(void*, unsigned long) = nullptr;
    void (*set)(void*, const void*) = nullptr;
    unsigned long (*get_prec)(const void*) = nullptr;
    void (*add)(void*, const void*, const void*) = nullptr;
    void (*sub)(void*, const void*, const void*) = nullptr;
    void (*mul)(void*, const void*, const void*) = nullptr;
    void (*div)(void*, const void*, const void*) = nullptr;
    void (*mul_2exp)(void*, const void*, unsigned long) = nullptr;
    void (*div_2exp)(void*, const void*, unsigned long) = nullptr;
    int (*cmp_d)(const void*, double) = nullptr;
    int (*cmp)(const void*, const void*) = nullptr;
    double (*get_d)(const void*) = nullptr;
    double (*get_d_2exp)(int32_t*, const void*) = nullptr;
    char* (*get_str)(char*, int32_t*, int, size_t, const void*) = nullptr;
};

Api g_api;
bool g_ok = false;
bool g_tried = false;
std::string g_err = "not loaded";
std::string g_path;
std::string g_version;

/* Candidate locations: the executable directory first, so a shipped copy
 * always wins over whatever happens to be on the system search path. */
std::vector<std::string> candidates() {
    std::vector<std::string> v;
#ifdef _WIN32
    char exe[MAX_PATH * 2];
    DWORD n = GetModuleFileNameA(nullptr, exe, (DWORD)sizeof(exe));
    if (n > 0 && n < sizeof(exe)) {
        std::string dir(exe, n);
        const size_t cut = dir.find_last_of("\\/");
        if (cut != std::string::npos) dir.resize(cut + 1);
        v.push_back(dir + "libgmp-10.dll");
        v.push_back(dir + "gmp-10.dll");
        v.push_back(dir + "libgmp.dll");
    }
    v.push_back("libgmp-10.dll");
    v.push_back("C:\\Program Files\\Git\\mingw64\\bin\\libgmp-10.dll");
    v.push_back("C:\\Program Files (x86)\\Git\\mingw64\\bin\\libgmp-10.dll");
    v.push_back("C:\\msys64\\mingw64\\bin\\libgmp-10.dll");
#else
    char exe[PATH_MAX + 1];
    ssize_t n = readlink("/proc/self/exe", exe, PATH_MAX);
    if (n > 0) {
        exe[n] = '\0';
        std::string dir(exe, (size_t)n);
        const size_t cut = dir.find_last_of('/');
        if (cut != std::string::npos) dir.resize(cut + 1);
        v.push_back(dir + "libgmp.so.10");
        v.push_back(dir + "libgmp.so");
        v.push_back(dir + "libgmp.10.dylib");
    }
    v.push_back("libgmp.so.10");
    v.push_back("libgmp.so");
    v.push_back("libgmp.10.dylib");
    v.push_back("/usr/lib/x86_64-linux-gnu/libgmp.so.10");
    v.push_back("/usr/lib64/libgmp.so.10");
    v.push_back("/usr/local/lib/libgmp.so.10");
    v.push_back("/opt/homebrew/lib/libgmp.10.dylib");
#endif
    return v;
}

template <typename T>
void bind(Module m, const char* name, T& fn, bool& ok) {
#ifdef _WIN32
    fn = reinterpret_cast<T>(reinterpret_cast<void*>(GetProcAddress(m, name)));
#else
    fn = reinterpret_cast<T>(dlsym(m, name));
#endif
    if (!fn) ok = false;
}

static Module openModule(const char* p) {
#ifdef _WIN32
    return LoadLibraryA(p);
#else
    return dlopen(p, RTLD_LAZY | RTLD_LOCAL);
#endif
}

static void closeModule(Module m) {
#ifdef _WIN32
    FreeLibrary(m);
#else
    dlclose(m);
#endif
}

static void* symbol(Module m, const char* name) {
#ifdef _WIN32
    return reinterpret_cast<void*>(GetProcAddress(m, name));
#else
    return dlsym(m, name);
#endif
}

bool doLoad() {
    for (const std::string& p : candidates()) {
        Module m = openModule(p.c_str());
        if (!m) continue;
        bool ok = true;
        bind(m, "__gmpf_init2", g_api.init2, ok);
        bind(m, "__gmpf_clear", g_api.clear, ok);
        bind(m, "__gmpf_set_str", g_api.set_str, ok);
        bind(m, "__gmpf_set_d", g_api.set_d, ok);
        bind(m, "__gmpf_set_ui", g_api.set_ui, ok);
        bind(m, "__gmpf_set", g_api.set, ok);
        bind(m, "__gmpf_get_prec", g_api.get_prec, ok);
        bind(m, "__gmpf_add", g_api.add, ok);
        bind(m, "__gmpf_sub", g_api.sub, ok);
        bind(m, "__gmpf_mul", g_api.mul, ok);
        bind(m, "__gmpf_div", g_api.div, ok);
        bind(m, "__gmpf_mul_2exp", g_api.mul_2exp, ok);
        bind(m, "__gmpf_div_2exp", g_api.div_2exp, ok);
        bind(m, "__gmpf_cmp_d", g_api.cmp_d, ok);
        bind(m, "__gmpf_cmp", g_api.cmp, ok);
        bind(m, "__gmpf_get_d", g_api.get_d, ok);
        bind(m, "__gmpf_get_d_2exp", g_api.get_d_2exp, ok);
        bind(m, "__gmpf_get_str", g_api.get_str, ok);
        if (!ok) {
            closeModule(m);
            g_err = "missing exports in " + p;
            continue;
        }
        g_path = p;
        /* `__gmp_version` is a *pointer* variable, not a string: read the
         * pointer out of the library and follow it. */
        const char** v = reinterpret_cast<const char**>(symbol(m, "__gmp_version"));
        g_version = (v && *v) ? *v : "unknown";
        g_ok = true;
        g_err.clear();
        return true;
    }
    if (g_err == "not loaded") {
#ifdef _WIN32
        g_err = "libgmp-10.dll not found";
#else
        g_err = "GMP shared library not found (install libgmp10 / libgmp-dev, or set MB_GMP=0)";
#endif
    }
    return false;
}

std::once_flag g_once;

}  // namespace

bool available() {
    std::call_once(g_once, [] {
        g_tried = true;
        doLoad();
    });
    return g_ok;
}

const char* error() { return g_err.c_str(); }
const char* version() { return g_version.c_str(); }
const char* path() { return g_path.c_str(); }

void init(Mpf& v, int bits) {
    if (!available()) return;
    std::memset(v.raw, 0, sizeof(v.raw));
    g_api.init2(v.raw, (unsigned long)(bits < 64 ? 64 : bits));
}

void clear(Mpf& v) {
    if (!available()) return;
    g_api.clear(v.raw);
    std::memset(v.raw, 0, sizeof(v.raw));
}

int prec(const Mpf& v) { return available() ? (int)g_api.get_prec(v.raw) : 0; }

/* GMP wants plain decimal; it accepts "1.5e-3" as well as "-0.25". */
void set_str(Mpf& v, const std::string& decimal) {
    if (available()) g_api.set_str(v.raw, decimal.c_str(), 10);
}
void set_d(Mpf& v, double x) {
    if (available()) g_api.set_d(v.raw, x);
}
void set_ui(Mpf& v, unsigned long x) {
    if (available()) g_api.set_ui(v.raw, x);
}
void set(Mpf& r, const Mpf& a) {
    if (available()) g_api.set(r.raw, a.raw);
}
void add(Mpf& r, const Mpf& a, const Mpf& b) {
    if (available()) g_api.add(r.raw, a.raw, b.raw);
}
void sub(Mpf& r, const Mpf& a, const Mpf& b) {
    if (available()) g_api.sub(r.raw, a.raw, b.raw);
}
void mul(Mpf& r, const Mpf& a, const Mpf& b) {
    if (available()) g_api.mul(r.raw, a.raw, b.raw);
}
void div(Mpf& r, const Mpf& a, const Mpf& b) {
    if (available()) g_api.div(r.raw, a.raw, b.raw);
}
void mul_2exp(Mpf& r, const Mpf& a, unsigned long bits) {
    if (available()) g_api.mul_2exp(r.raw, a.raw, bits);
}
int cmp_d(const Mpf& a, double d) { return available() ? g_api.cmp_d(a.raw, d) : 0; }
int cmp(const Mpf& a, const Mpf& b) { return available() ? g_api.cmp(a.raw, b.raw) : 0; }
double get_d(const Mpf& a) { return available() ? g_api.get_d(a.raw) : 0.0; }

double get_d_2exp(int32_t* exp2, const Mpf& a) {
    if (!available()) {
        if (exp2) *exp2 = 0;
        return 0.0;
    }
    int32_t e = 0;
    double m = g_api.get_d_2exp(&e, a.raw);
    if (exp2) *exp2 = e;
    return m;
}

std::string to_decimal(const Mpf& a, int digits) {
    if (!available()) return std::string();
    if (g_api.cmp_d(a.raw, 0.0) == 0) return "0";
    const int nd = digits > 0 ? digits : 1;
    std::vector<char> buf((size_t)nd + 8, '\0');
    int32_t e = 0;
    g_api.get_str(buf.data(), &e, 10, (size_t)nd, a.raw);
    const char* s = buf.data();
    std::string out;
    if (*s == '-') { out = "-"; ++s; }
    const size_t n = std::strlen(s);
    if (e <= 0) {
        out += "0.";
        out.append((size_t)(-e), '0');
        out.append(s, n);
    } else if ((size_t)e >= n) {
        out.append(s, n);
        out.append((size_t)e - n, '0');
    } else {
        out.append(s, (size_t)e);
        out += '.';
        out.append(s + e, n - (size_t)e);
    }
    return out;
}

Num::~Num() {
    if (live_) clear(v);
}

}  // namespace gmpb
