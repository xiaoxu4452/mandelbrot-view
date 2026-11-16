// CRT seed implementation — memory and string primitives.
//
// These are the routines the original executable calls through the MinGW
// import table (0055e298 memcpy, 0055e288 memset, 0055e290 memmove,
// 0055e230 strlen, 0055e240 strcpy, 0055e248 strcmp, 0055e258 strcat) plus the
// strsafe workers 00403a90 StringCopyWorkerA and 00403b30 StringCatWorkerA.
// The loops are written here rather than delegated to <cstring>: the point of
// the port is that the binary's dependency on the CRT is replaced by our own
// code with the same contract.

#include "crt.hpp"
#include "../port.hpp"

#include <cstddef>

namespace mset::port::crt {

void* mem_copy(void* dst, const void* src, std::size_t n) {
    // Overlap is undefined for memcpy; mem_move handles it.
    unsigned char* d = static_cast<unsigned char*>(dst);
    const unsigned char* s = static_cast<const unsigned char*>(src);
    for (std::size_t i = 0; i < n; ++i) d[i] = s[i];
    return dst;
}

void* mem_set(void* dst, int value, std::size_t n) {
    unsigned char* d = static_cast<unsigned char*>(dst);
    const unsigned char v = static_cast<unsigned char>(value);
    for (std::size_t i = 0; i < n; ++i) d[i] = v;
    return dst;
}

void* mem_move(void* dst, const void* src, std::size_t n) {
    unsigned char* d = static_cast<unsigned char*>(dst);
    const unsigned char* s = static_cast<const unsigned char*>(src);
    if (d == const_cast<unsigned char*>(s) || n == 0) return dst;
    if (d < s) {
        for (std::size_t i = 0; i < n; ++i) d[i] = s[i];
    } else {
        // Descending copy when the destination overlaps the tail of the source.
        for (std::size_t i = n; i > 0; --i) d[i - 1] = s[i - 1];
    }
    return dst;
}

int mem_cmp(const void* a, const void* b, std::size_t n) {
    const unsigned char* x = static_cast<const unsigned char*>(a);
    const unsigned char* y = static_cast<const unsigned char*>(b);
    for (std::size_t i = 0; i < n; ++i) {
        if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return 0;
}

std::size_t str_len(const char* s) {
    if (!s) return 0;
    std::size_t n = 0;
    while (s[n] != '\0') ++n;
    return n;
}

char* str_copy(char* dst, const char* src) {
    if (!dst || !src) return dst;
    std::size_t i = 0;
    while ((dst[i] = src[i]) != '\0') ++i;
    return dst;
}

char* str_cat(char* dst, const char* src) {
    if (!dst || !src) return dst;
    str_copy(dst + str_len(dst), src);
    return dst;
}

int str_cmp(const char* a, const char* b) {
    if (a == b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    while (*a && *a == *b) { ++a; ++b; }
    return (*a < *b) ? -1 : (*a > *b ? 1 : 0);
}

long str_copy_worker_a(char* dst, std::size_t cap, const char* src) {
    // strsafe StringCopyWorkerA: copy at most cap-1 characters, terminate,
    // and fail with STRSAFE_E_INSUFFICIENT_BUFFER when the source is longer.
    if (!dst || cap == 0) return static_cast<long>(0x80070057L);  // E_INVALIDARG
    if (!src) { dst[0] = '\0'; return static_cast<long>(0x80070057L); }
    std::size_t i = 0;
    for (; i + 1 < cap && src[i] != '\0'; ++i) dst[i] = src[i];
    bool truncated = src[i] != '\0';
    dst[i] = '\0';
    return truncated ? static_cast<long>(0x8007007AL) : 0L;
}

long str_cat_worker_a(char* dst, std::size_t cap, const char* src) {
    if (!dst || cap == 0 || !src) return static_cast<long>(0x80070057L);
    std::size_t used = str_len(dst);
    if (used >= cap) return static_cast<long>(0x8007007AL);
    long rc = str_copy_worker_a(dst + used, cap - used, src);
    return rc;
}

}  // namespace mset::port::crt

// --- address registry -----------------------------------------------------
// 00403a90/0054e3d0 StringCopyWorkerA and 00403b30/0054f1c0
// StringCatWorkerA are two inlined copies of the same strsafe routine in the
// original image; both addresses resolve to the single implementation above.
MSET_COV_ENTRY(e_memcpy_0055e298, "0055e298", "memcpy", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::mem_copy)
MSET_COV_ENTRY(e_memset_0055e288, "0055e288", "memset", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::mem_set)
MSET_COV_ENTRY(e_memmove_0055e290, "0055e290", "memmove", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::mem_move)
MSET_COV_ENTRY(e_strlen_0055e230, "0055e230", "strlen", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::str_len)
MSET_COV_ENTRY(e_strcpy_0055e240, "0055e240", "strcpy", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::str_copy)
MSET_COV_ENTRY(e_strcmp_0055e248, "0055e248", "strcmp", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::str_cmp)
MSET_COV_ENTRY(e_strcat_0055e258, "0055e258", "strcat", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::str_cat)
MSET_COV_ENTRY(e_strcopyworker_00403a90, "00403a90", "StringCopyWorkerA", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::str_copy_worker_a)
MSET_COV_ENTRY(e_strcatworker_00403b30, "00403b30", "StringCatWorkerA", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::crt::str_cat_worker_a)
