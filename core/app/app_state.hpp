// Headless application model.
//
// The model groups the engine's state — `mode`, `ntouches`, `highres`, `lock`,
// `debuginfo`, `juliamode`, the two viewports `vp`/`vpex` with their
// `nav_flags`, the palette state and the render context — into one explicit
// object, so every UI function can be called from tests without a window, a
// message loop or a GPU.
//
// Long-tail state used by a single function lives in `params` (numeric) and
// `strings` (text), so the model does not have to grow a field per variable.

#pragma once

#include "image.hpp"
#include "palette.hpp"
#include "render.hpp"
#include "viewport.hpp"
#include "port/platform/plt.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace mset::app {

// `mode` states derived from changemode/button0: 1 is the idle/normal
// state every action returns to; 6 is the toggled overlay state button0
// switches into.  The remaining values are reachable through changemode and
// are kept as plain ints so a reference call site keeps its literal.
inline constexpr int kModeStartup = 0;
inline constexpr int kModeNormal = 1;
inline constexpr int kModeBusy = 2;
inline constexpr int kModeMenu = 3;
inline constexpr int kModeDialog = 4;
inline constexpr int kModeVideo = 5;
inline constexpr int kModeOverlay = 6;
inline constexpr int kModeQuit = 7;

struct Message {
    unsigned id = 0;
    std::uintptr_t wparam = 0;
    std::intptr_t lparam = 0;
};

struct MenuItem {
    std::string label;
    int command = 0;
    bool checked = false;
    bool enabled = true;
    std::vector<MenuItem> children;
};

struct VideoState {
    bool recording = false;
    std::string path;
    int codec = 1;              // 1 = AVI/MJPEG
    int width = 0;
    int height = 0;
    int fps = 25;
    long long bitrate = 0;
    long frames = 0;
    double seconds = 0.0;
};

struct AppState {
    // --- globals derived from the design notes -----------------------------
    int mode = kModeNormal;
    int ntouches = 1;
    int juliamode = 0;          // 2 selects the secondary viewport (vpex)
    bool highres = false;
    bool lock = false;
    bool debuginfo = false;
    bool invert = false;
    bool autostop = true;
    bool presentation = false;
    bool trace = false;
    int nav_flags = 0x2000;     // togglehighres: highres*8 + 0x2000 (+0x1000 locked)
    int nav_flags_ex = 0x2000;
    int color_scheme = 0;
    std::string palette_name = "rainbow";

    // --- viewports ---------------------------------------------------------
    Viewport view;              // vp
    Viewport view_ex;           // vpex
    RenderRequest req;
    Palette palette;
    Image current_image;

    // --- window / redraw ---------------------------------------------------
    int window_width = 800;
    int window_height = 600;
    mset::port::plt::Rect client{0, 0, 800, 600};
    bool needs_redraw = false;
    bool needs_recalc = false;
    bool needs_render = false;
    long long dirty_pixels = 0;
    long long frames = 0;
    double fps = 0.0;
    double last_render_seconds = 0.0;
    std::string status;

    // --- input -------------------------------------------------------------
    int mouse_x = 0;
    int mouse_y = 0;
    int mouse_buttons = 0;
    std::vector<double> touch_x;
    std::vector<double> touch_y;
    int last_key = 0;
    int last_scancode = 0;
    int last_key_action = 0;

    // --- programme state ---------------------------------------------------
    std::vector<MenuItem> menu;
    std::map<std::string, double> params;
    std::map<std::string, std::string> strings;
    std::vector<std::string> log_lines;
    std::string clipboard;
    std::string last_url;
    std::string download_path;
    bool quit_requested = false;
    VideoState video;
    double started_at = 0.0;    // glfwGetTime() at start-up

    // --- helpers (defined in app_state.cpp) --------------------------------
    void invalidate(bool recalc_now);
    void set_status(std::string text);
    void apply_palette(const std::string& name);
    void center_on_pixel(int x, int y);
    void zoom_at_pixel(int x, int y, double factor);
    void pan_by(int dx, int dy);
    void reset_view();
    void fit_to_window();
    void set_mode(int new_mode);
    const char* mode_name() const;
    void touch_push(int x, int y);
    void touch_clear();
};

}  // namespace mset::app
