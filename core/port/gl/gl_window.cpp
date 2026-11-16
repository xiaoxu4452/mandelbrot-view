// GLFW seed: init / create_window / get_time / window_should_close.
//
// glfwInit, glfwCreateWindow, glfwGetTime and glfwWindowShouldClose come
// from glfw3.dll.  The headless replacements below keep the object model
// (monitor enumeration, window creation with a software framebuffer,
// monotonic clock, close flag) so the reference call sites keep their
// meaning without a display server.

#include "gl.hpp"
#include "../port.hpp"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace mset::port::gl {

namespace {
bool g_initialised = false;
std::vector<Monitor> g_monitors;
std::vector<Window*> g_windows;

std::chrono::steady_clock::time_point& clock_origin() {
    static std::chrono::steady_clock::time_point origin = std::chrono::steady_clock::now();
    return origin;
}
}  // namespace

bool init() {
    if (g_initialised) return true;
    // Enumerate one logical monitor; the original queries it for the desktop
    // video mode when it sizes the initial window.
    Monitor primary;
    primary.index = 0;
    primary.name = "headless-0";
    primary.mode = VideoMode{};
    g_monitors.push_back(primary);
    g_initialised = true;
    return true;
}

void terminate() {
    for (Window* w : g_windows) destroy_window(w);
    g_windows.clear();
    g_monitors.clear();
    g_initialised = false;
}

Window* create_window(int width, int height, const char* title, Monitor* monitor,
                      Window* /*share*/) {
    if (!g_initialised && !init()) return nullptr;
    if (width <= 0 || height <= 0) return nullptr;
    Window* w = new Window();
    w->width = width;
    w->height = height;
    w->title = title ? title : "";
    w->monitor = monitor ? monitor : (g_monitors.empty() ? nullptr : &g_monitors[0]);
    w->framebuffer = static_cast<std::uint32_t*>(
        std::calloc(static_cast<std::size_t>(width) * height, sizeof(std::uint32_t)));
    if (!w->framebuffer) { delete w; return nullptr; }
    g_windows.push_back(w);
    return w;
}

void destroy_window(Window* window) {
    if (!window) return;
    for (std::size_t i = 0; i < g_windows.size(); ++i) {
        if (g_windows[i] == window) { g_windows.erase(g_windows.begin() + (long)i); break; }
    }
    std::free(window->framebuffer);
    delete window;
}

bool window_should_close(const Window* window) {
    return !window || window->should_close;
}

void set_window_should_close(Window* window, bool value) {
    if (!window) return;
    window->should_close = value;
}

double get_time() {
    auto now = std::chrono::steady_clock::now();
    return std::chrono::duration<double>(now - clock_origin()).count();
}

Monitor* get_primary_monitor() {
    if (!g_initialised && !init()) return nullptr;
    return g_monitors.empty() ? nullptr : &g_monitors[0];
}

const VideoMode* get_video_mode(Monitor* monitor) {
    if (!monitor) return nullptr;
    return &monitor->mode;
}


}  // namespace mset::port::gl

MSET_COV_ENTRY(e_glfwInit_0054b808, "0054b808", "glfwInit", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gl::init)
MSET_COV_ENTRY(e_glfwCreateWindow_0054b848, "0054b848", "glfwCreateWindow", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gl::create_window)
MSET_COV_ENTRY(e_glfwGetTime_0054b820, "0054b820", "glfwGetTime", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gl::get_time)
MSET_COV_ENTRY(e_glfwWindowShouldClose_0054b7b8, "0054b7b8", "glfwWindowShouldClose", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::gl::window_should_close)
