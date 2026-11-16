// Port-layer registry.
//
// A lightweight coverage table: each entry records a stable identifier, the
// C++ symbol that implements it and the defining translation unit.  Each
// implementation unit registers its rows at start-up with the macros below:
//
//   MSET_COV_ENTRY (tag, "00403a90", "StringCopyWorkerA",
//                   ::mset::cov::Impl::ThirdPartyEquivalent, str_copy_worker_a)
//
// The registration binds the symbol by address (`&symbol`), so a row can only
// be registered for a symbol that really exists in the translation unit.
// Member functions use MSET_COV_MEMBER, which witnesses `&Type::method`
// without a function-pointer field (member-function pointers are not
// convertible to object pointers).
//
// `mset coverage --dump` prints the table for inspection.

#pragma once

#include <cstddef>

namespace mset::cov {

enum class Impl {
    CoreAlgorithm,        // an algorithm the fractal engine itself implements
    Application,          // application / UI / IO layer of the reference engine
    ThirdPartyEquivalent  // used subset of CRT, Win32, pthread, GMP, GLFW, FFmpeg
};

const char* impl_name(Impl impl);

struct Entry {
    const char* address;   // "00403a90" — stable 8-hex-digit identifier
    const char* function;  // original symbol name
    const char* symbol;    // C++ symbol that implements it
    const char* file;      // source file of the implementation
    Impl impl;
    const void* fn;        // non-null for free functions; nullptr for members
};

void add(const Entry& entry);
const Entry* begin();
const Entry* end();
std::size_t size();

// Normalised, stable source path ("src/port/crt/crt_memory.cpp").
const char* rel_file(const char* compiler_file);

}  // namespace mset::cov

#define MSET_COV_IMPL(tag, addr, fname, implcls, symbol, fnptr)                          \
    namespace {                                                                          \
        struct CovReg_##tag {                                                            \
            CovReg_##tag() {                                                             \
                static const ::mset::cov::Entry cov_entry{                               \
                    addr, fname, #symbol, ::mset::cov::rel_file(__FILE__), (implcls),    \
                    (fnptr)};                                                            \
                ::mset::cov::add(cov_entry);                                             \
            }                                                                            \
            static void witness() {                                                      \
                auto cov_addr = &symbol;                                                 \
                (void)cov_addr;                                                          \
            }                                                                            \
        };                                                                               \
        static CovReg_##tag cov_reg_##tag;                                               \
    }

// Free function: proves the symbol exists by taking its address.
#define MSET_COV_ENTRY(tag, addr, fname, implcls, symbol)                                \
    MSET_COV_IMPL(tag, addr, fname, implcls, symbol,                                     \
                  reinterpret_cast<const void*>(&symbol))

// Member function: witnesses the address but stores no function pointer.
#define MSET_COV_MEMBER(tag, addr, fname, implcls, symbol)                               \
    MSET_COV_IMPL(tag, addr, fname, implcls, symbol, nullptr)
