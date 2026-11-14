// mb_thread — single-threaded stand-in for <thread> on wasm32-wasi.
//
// wasi-libc does not ship pthreads and the web build always passes
// threads = 1, so every `std::vector<std::thread> pool` loop below spawns
// zero workers; this shim keeps those call sites compiling unchanged.
// hardware_concurrency() reports 1, matching the wasm execution model.

#pragma once

#include <utility>

namespace std {

class thread {
public:
    using id = int;
    using native_handle_type = void*;

    thread() = default;
    thread(thread&&) = default;
    thread& operator=(thread&&) = default;
    thread(const thread&) = delete;
    thread& operator=(const thread&) = delete;

    template <class F, class... Args>
    explicit thread(F&&, Args&&...) {}

    void join() {}
    void detach() {}
    bool joinable() const { return false; }
    id get_id() const { return 0; }
    static unsigned hardware_concurrency() { return 1; }
};

namespace this_thread {
inline void yield() {}
template <class Rep, class Period>
void sleep_for(const Rep&, const Period&) {}
}  // namespace this_thread

}  // namespace std
