// CRT-equivalent layer: the subset of the MinGW runtime that the original
// executable actually calls, re-implemented here instead of linked from a
// system CRT.  Every routine keeps the original's observable contract
// (argument order, return value, truncation, error codes) but is written
// against our own loops/allocator so the conversion stands on its own.
//
// Register each row with MSET_COV_ENTRY (see src/port/port.hpp).  A re-used
// routine that the original linked in several copies (fprintf, sprintf,
// StringCopyWorkerA appear at many addresses) maps several addresses to the
// same symbol; that is recorded, not hidden.

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

namespace mset::port::crt {

// --- string.h -------------------------------------------------------------
void* mem_copy(void* dst, const void* src, std::size_t n);
void* mem_move(void* dst, const void* src, std::size_t n);
void* mem_set(void* dst, int value, std::size_t n);
int mem_cmp(const void* a, const void* b, std::size_t n);

std::size_t str_len(const char* s);
char* str_copy(char* dst, const char* src);
char* str_cat(char* dst, const char* src);
int str_cmp(const char* a, const char* b);
int str_ncmp(const char* a, const char* b, std::size_t n);
const char* str_chr(const char* s, int c);
const char* str_str(const char* haystack, const char* needle);

// StringCopyWorkerA / StringCatWorkerA from strsafe.h: bounded copy/append
// returning an HRESULT-style code (0 success, 0x80070057 invalid arg,
// 0x8007007A insufficient buffer).
long str_copy_worker_a(char* dst, std::size_t cap, const char* src);
long str_cat_worker_a(char* dst, std::size_t cap, const char* src);

// --- stdlib.h -------------------------------------------------------------
int str_to_int(const char* text, char** end, int base);
long str_to_long(const char* text, char** end, int base);
double str_to_double(const char* text, char** end);

// --- allocator ------------------------------------------------------------
// First-fit free-list over a bump arena.  Matches malloc/calloc/realloc/free
// semantics for the engine's allocation patterns (size 0 -> distinct pointer,
// multiplication overflow in calloc -> null).
void* heap_alloc(std::size_t bytes);
void* heap_calloc(std::size_t count, std::size_t bytes);
void* heap_realloc(void* block, std::size_t bytes);
void  heap_free(void* block);
std::size_t heap_live_bytes();

// --- stdio ----------------------------------------------------------------
// A minimal formatted-output engine (subset used by the original: %d %u %x
// %s %c %f %g %e %p %%, width/precision, '-' '0' '+' ' ' '#' flags).
std::string fmt_format(const char* format, ...);
void fmt_write(FILE* stream, const char* format, ...);

}  // namespace mset::port::crt
