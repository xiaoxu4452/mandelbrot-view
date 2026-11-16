// Internal shared state for the platform equivalent layer.
//
// Every theme translation unit (gdi, window, dialog, clipboard, thread,
// system) shares one process-wide registry behind a single mutex, the way the
// real Win32/GDI heaps are process-wide.  Handles are opaque uintptr_t ids
// minted by detail::next_id(); an id that is not present in the relevant map
// is an invalid handle and the API returns the documented failure value.
//
// This header is internal to src/port/platform/; other slices must not
// include it.

#pragma once

#include "plt.hpp"

#include <condition_variable>
#include <filesystem>

namespace mset::port::plt::detail {

enum class GdiKind { Stock, Pen, Brush, Font, Bitmap };

struct GdiObject {
    GdiKind kind = GdiKind::Stock;
    int style = 0;
    int width = 1;
    Colorref color = 0;
    int height = 0;
    std::string face;
    int w = 0, h = 0;
    std::vector<std::uint8_t> pixels;  // RGBA8, top-down
};

struct DcState {
    int w = 1, h = 1;
    std::vector<std::uint8_t> pixels;  // RGBA8, top-down
    Hobj pen = 0;
    Hobj brush = 0;
    Hobj font = 0;
    Hobj bitmap = 0;
    Colorref text_color = 0;
    Colorref bk_color = 0;
    std::uint32_t text_align = 0;
    Point cur_pos;
};

struct Control {
    int id = 0;
    std::string text_a;
    std::wstring text_w;
    bool enabled = true;
    bool visible = true;
    std::uint32_t check = kBstUnchecked;
};

struct WindowState {
    Rect rect;
    bool enabled = true;
    bool visible = true;
    std::wstring title;
    std::map<int, std::intptr_t> wnd_long;
    std::map<int, long> class_long;
    void* dlg_proc = nullptr;
    std::vector<Control> controls;
    bool is_dialog = false;
    std::intptr_t dialog_result = -1;
    bool touch_registered = false;
    Hdc own_dc = 0;
};

struct GlobalBlock {
    std::vector<std::uint8_t> bytes;
    bool locked = false;
};

struct FindState {
    std::filesystem::directory_iterator it;
    std::wstring pattern;
    bool started = false;
};

struct Module {
    std::wstring name;
    int refs = 1;
};

struct UiRecord {
    // ShellExecuteW request.
    std::wstring op, file, params, dir;
    int show_cmd = 0;
    // MessageBoxA request.
    std::string message, caption;
    std::uint32_t msg_type = 0;
};

std::mutex& state_mutex();

std::map<Hobj, GdiObject>& objects();
std::map<Hdc, DcState>& dcs();
std::map<Hwnd, WindowState>& windows();
std::map<Hglob, GlobalBlock>& globals();
std::map<std::uint32_t, void*>& tls();
std::map<Htouch, std::vector<Point>>& touch_inputs();
std::map<Hfind, FindState>& finds();
std::map<Hmodule, Module>& modules();

bool& clipboard_open();
std::uint32_t& clipboard_format();
std::vector<std::uint8_t>& clipboard_data();

std::uint32_t& last_error();
void*& exception_filter();
std::uint32_t& message_time();
std::intptr_t& message_extra();
UiRecord& ui_record();

std::uintptr_t next_id();

}  // namespace mset::port::plt::detail
