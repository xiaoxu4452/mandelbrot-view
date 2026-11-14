#include "mb_noexcept.hpp"

namespace mbxx {
namespace {
std::string g_msg;
bool g_pending = false;
}  // namespace

void set_error(const char* msg) {
    g_msg = msg ? msg : "";
    g_pending = true;
}

bool take_error() {
    const bool p = g_pending;
    g_pending = false;
    g_msg.clear();
    return p;
}

void clear_error() {
    g_pending = false;
    g_msg.clear();
}

}  // namespace mbxx
