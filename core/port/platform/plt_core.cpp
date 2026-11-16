// Shared process-wide state and encoding helpers for the platform layer.
//
// The real binary binds these routines to user32.dll / gdi32.dll / kernel32.dll
// through its IAT (thunks at 0054b8xx, 0055ecxx, 0055eexx).  Here the
// heaps, handle tables and per-thread state live in one registry guarded by a
// single mutex; theme translation units look handles up through
// plt_internal.hpp.  No system DLL is linked for these services.

#include "plt_internal.hpp"

#include <limits>

namespace mset::port::plt::detail {

namespace {

struct State {
    std::mutex mtx;
    std::map<Hobj, GdiObject> objects;
    std::map<Hdc, DcState> dcs;
    std::map<Hwnd, WindowState> windows;
    std::map<Hglob, GlobalBlock> globals;
    std::map<std::uint32_t, void*> tls;
    std::map<Htouch, std::vector<Point>> touch_inputs;
    std::map<Hfind, FindState> finds;
    std::map<Hmodule, Module> modules;

    bool clipboard_open = false;
    std::uint32_t clipboard_format = 0;
    std::vector<std::uint8_t> clipboard_data;

    std::uint32_t last_error = 0;
    void* exception_filter = nullptr;
    std::uint32_t message_time = 0;
    std::intptr_t message_extra = 0;
    UiRecord ui;

    std::uintptr_t next = 1;
};

State& state() {
    static State s;
    return s;
}

}  // namespace

std::mutex& state_mutex() { return state().mtx; }
std::map<Hobj, GdiObject>& objects() { return state().objects; }
std::map<Hdc, DcState>& dcs() { return state().dcs; }
std::map<Hwnd, WindowState>& windows() { return state().windows; }
std::map<Hglob, GlobalBlock>& globals() { return state().globals; }
std::map<std::uint32_t, void*>& tls() { return state().tls; }
std::map<Htouch, std::vector<Point>>& touch_inputs() { return state().touch_inputs; }
std::map<Hfind, FindState>& finds() { return state().finds; }
std::map<Hmodule, Module>& modules() { return state().modules; }

bool& clipboard_open() { return state().clipboard_open; }
std::uint32_t& clipboard_format() { return state().clipboard_format; }
std::vector<std::uint8_t>& clipboard_data() { return state().clipboard_data; }

std::uint32_t& last_error() { return state().last_error; }
void*& exception_filter() { return state().exception_filter; }
std::uint32_t& message_time() { return state().message_time; }
std::intptr_t& message_extra() { return state().message_extra; }
UiRecord& ui_record() { return state().ui; }

std::uintptr_t next_id() { return ++state().next; }

}  // namespace mset::port::plt::detail

namespace mset::port::plt {

// --- UTF-8 <-> UTF-16 conversion -------------------------------------------
//
// MultiByteToWideChar / WideCharToMultiByte accept CP_ACP (0) or CP_UTF8
// (65001).  The headless model treats both as UTF-8; surrogates are encoded
// like Windows does (pair of 16-bit code units).  When the output buffer is
// null or too small the functions return the required byte/char count without
// writing, matching the Win32 contract.

namespace {

int utf8_seq_len(std::uint8_t b) {
    if (b < 0x80) return 1;
    if ((b & 0xE0) == 0xC0) return 2;
    if ((b & 0xF0) == 0xE0) return 3;
    if ((b & 0xF8) == 0xF0) return 4;
    return 1;
}

}  // namespace

int utf8_to_wide(const char* s, int cb, wchar_t* out, int cch) {
    if (!s) return 0;
    const bool nul_term = cb < 0;
    std::vector<std::uint32_t> cps;
    int i = 0;
    while (true) {
        if (nul_term) {
            if (s[i] == '\0') break;
        } else if (i >= cb) {
            break;
        }
        std::uint8_t b = static_cast<std::uint8_t>(s[i]);
        int len = utf8_seq_len(b);
        if (len == 1 && (b & 0x80)) {
            cps.push_back(0xFFFD);
            ++i;
            continue;
        }
        std::uint32_t cp = 0;
        bool ok = true;
        if (len == 1) {
            cp = b;
        } else {
            cp = b & (0x7Fu >> len);
            for (int k = 1; k < len; ++k) {
                std::uint8_t c = static_cast<std::uint8_t>(s[i + k]);
                if ((c & 0xC0) != 0x80) { ok = false; break; }
                cp = (cp << 6) | (c & 0x3F);
            }
        }
        if (!ok) {
            cps.push_back(0xFFFD);
            ++i;
            continue;
        }
        cps.push_back(cp);
        i += len;
    }
    // Count UTF-16 code units.
    int units = 0;
    for (std::uint32_t cp : cps) {
        units += (cp > 0xFFFF) ? 2 : 1;
    }
    if (!out || cch == 0) return units;
    int j = 0;
    for (std::uint32_t cp : cps) {
        if (cp > 0xFFFF) {
            cp -= 0x10000;
            if (j + 1 >= cch) break;
            out[j++] = static_cast<wchar_t>(0xD800 + (cp >> 10));
            out[j++] = static_cast<wchar_t>(0xDC00 + (cp & 0x3FF));
        } else {
            if (j >= cch) break;
            out[j++] = static_cast<wchar_t>(cp);
        }
    }
    if (j < cch) out[j] = L'\0';
    return units;
}

int wide_to_utf8(const wchar_t* s, int cch, char* out, int cb) {
    if (!s) return 0;
    const bool nul_term = cch < 0;
    std::vector<std::uint32_t> cps;
    int i = 0;
    while (true) {
        if (nul_term) {
            if (s[i] == L'\0') break;
        } else if (i >= cch) {
            break;
        }
        std::uint32_t u = static_cast<std::uint16_t>(s[i]);
        if (u >= 0xD800 && u <= 0xDBFF) {
            std::uint32_t lo = static_cast<std::uint16_t>(s[i + 1]);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cps.push_back(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00));
                i += 2;
                continue;
            }
            cps.push_back(0xFFFD);
            ++i;
            continue;
        }
        if (u >= 0xDC00 && u <= 0xDFFF) {
            cps.push_back(0xFFFD);
            ++i;
            continue;
        }
        cps.push_back(u);
        ++i;
    }
    int bytes = 0;
    for (std::uint32_t cp : cps) {
        if (cp < 0x80) bytes += 1;
        else if (cp < 0x800) bytes += 2;
        else if (cp < 0x10000) bytes += 3;
        else bytes += 4;
    }
    if (!out || cb == 0) return bytes;
    int j = 0;
    for (std::uint32_t cp : cps) {
        char enc[4];
        int n = 0;
        if (cp < 0x80) {
            enc[n++] = static_cast<char>(cp);
        } else if (cp < 0x800) {
            enc[n++] = static_cast<char>(0xC0 | (cp >> 6));
            enc[n++] = static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            enc[n++] = static_cast<char>(0xE0 | (cp >> 12));
            enc[n++] = static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            enc[n++] = static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            enc[n++] = static_cast<char>(0xF0 | (cp >> 18));
            enc[n++] = static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            enc[n++] = static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            enc[n++] = static_cast<char>(0x80 | (cp & 0x3F));
        }
        for (int k = 0; k < n; ++k) {
            if (j >= cb) break;
            out[j++] = enc[k];
        }
    }
    if (j < cb) out[j] = '\0';
    return bytes;
}

std::wstring u8_to_w(const std::string& s) {
    int n = utf8_to_wide(s.c_str(), -1, nullptr, 0);
    std::wstring out;
    out.resize(static_cast<std::size_t>(n));
    if (n > 0) utf8_to_wide(s.c_str(), -1, out.data(), n + 1);
    return out;
}

std::string w_to_u8(const std::wstring& s) {
    int n = wide_to_utf8(s.c_str(), -1, nullptr, 0);
    std::string out;
    out.resize(static_cast<std::size_t>(n));
    if (n > 0) wide_to_utf8(s.c_str(), -1, out.data(), n + 1);
    return out;
}

}  // namespace mset::port::plt
