// mb_noexcept — build-time exception shim for the wasm32-wasi target.
//
// zig's libc++ for wasm32-wasi ships without the Itanium unwinder, so C++
// exceptions cannot be linked. The desktop core throws exactly six times,
// all inside BigFloat::from_string for malformed input, and render.cpp
// catches those at its only two call sites. build.mjs rewrites those sites
// mechanically (see PATCHES there); this header is the contract both sides
// use. No other behaviour changes.

#pragma once

#include <string>

namespace mbxx {

/** Record a parse error (replaces `throw std::invalid_argument`). */
void set_error(const char* msg);

/** True if an error is pending; clears it either way. */
bool take_error();

/** Clear any pending error (called before every render). */
void clear_error();

}  // namespace mbxx

// Inside BigFloat::from_string: record and bail out with a zero value.
#define MB_BF_FAIL(msg)              \
    do {                             \
        ::mbxx::set_error(msg);      \
        return BigFloat();           \
    } while (0)
