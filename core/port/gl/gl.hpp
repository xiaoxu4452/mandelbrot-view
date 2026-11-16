// GLFW / GLAD equivalent layer (window-system-free).
//
// The original creates a GLFW window, loads GL entry points through GLAD and
// draws the fractal as a textured quad.  The headless replacement keeps the
// same object model — monitors, video modes, windows, key/error callbacks,
// a current context and a function-pointer loader — but presents into a
// software surface instead of a swap chain, so the call sequence is
// reproducible without a display server.
//
// Register every row with MSET_COV_ENTRY.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace mset::port::gl {

struct VideoMode {
    int width = 1920;
    int height = 1080;
    int red_bits = 8;
    int green_bits = 8;
    int blue_bits = 8;
    int refresh_hz = 60;
};

struct Monitor {
    int index = 0;
    std::string name;
    VideoMode mode;
};

struct Window;

using KeyCallback = void (*)(Window*, int key, int scancode, int action, int mods);
using ErrorCallback = void (*)(int code, const char* description);

struct Window {
    int width = 800;
    int height = 600;
    std::string title;
    bool visible = true;
    bool should_close = false;
    bool resized = false;
    std::uint32_t* framebuffer = nullptr;   // RGBA8 software surface
    Monitor* monitor = nullptr;
    KeyCallback key_callback = nullptr;
    void* user_pointer = nullptr;
};

// --- GLFW ----------------------------------------------------------------
bool init();
void terminate();
bool window_hint(int hint, int value);
Window* create_window(int width, int height, const char* title, Monitor* monitor,
                      Window* share);
void destroy_window(Window* window);
bool window_should_close(const Window* window);
void set_window_should_close(Window* window, bool value);
void poll_events();
void swap_buffers(Window* window);
void swap_interval(int interval);
void make_context_current(Window* window);
double get_time();
void get_framebuffer_size(const Window* window, int* width, int* height);
int get_key(Window* window, int key);
void set_key_callback(Window* window, KeyCallback callback);
void set_error_callback(ErrorCallback callback);
Monitor* get_primary_monitor();
const VideoMode* get_video_mode(Monitor* monitor);
void* get_win32_window(Window* window);

// --- GLAD ----------------------------------------------------------------
// The loader resolves names against the software renderer's entry table, so
// get_proc returns real callable pointers for the subset the app uses.
using Proc = void (*)();
Proc get_proc(const char* name);
Proc get_proc_core(const char* name, bool required);
int glad_load_glloader(Proc (*loader)(const char*));
int glad_load_gl();
bool find_core_gl();
std::vector<std::string> get_exts();

// --- software renderer entry points behind the loader --------------------
// glClear / glViewport / glTexSubImage2D equivalents that paint the window's
// software surface; they are exposed through the same names the GLAD shim
// resolves.
void gl_clear(uint32_t rgba);
void gl_viewport(int x, int y, int width, int height);
void gl_tex_sub_image_2d(int level, int x, int y, int width, int height,
                         const std::uint8_t* rgba);

}  // namespace mset::port::gl
