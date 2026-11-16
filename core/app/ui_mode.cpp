// app.ui mode machine: changemode.
//
// The application keeps one `mode` value and a set of mode-specific GUI
// sub-windows.  On a mode change each sub-window is shown/hidden according
// to whether its mode is the new one, and every visibility transition calls
// the window's parameter-change hook, which rebuilds that window's layout
// and parameters.  Modes: 2 (render parameters), 3 (menu), 4 (dialog),
// 6 (overlay), plus a trailing video-state block.
//
// The headless model keeps the same state machine: the sub-window flags live
// in AppState::params, the parameter-change hook counts invocations so tests
// can assert the transition sequence.

#include "app_state.hpp"
#include "ui_model.hpp"
#include "port/port.hpp"

#include <string>

namespace mset::app {

namespace {

// Modes that own a sub-window in the original: 2, 3, 4, 6 and the video block.
constexpr int kModeWindows[] = {2, 3, 4, 5, 6};

void param_change(AppState& app, int which) {
    app.params["param_change_" + std::to_string(which)] += 1.0;
    app.needs_redraw = true;
}

void set_window_visible(AppState& app, int which, bool visible) {
    const std::string key = "mode_win_" + std::to_string(which);
    bool before = app.params.count(key) != 0 && app.params[key] != 0.0;
    if (before == visible) return;
    app.params[key] = visible ? 1.0 : 0.0;
    param_change(app, which);
}

}  // namespace

void changemode(AppState& app, int new_mode) {
    // The 00418710 wrapper returns immediately when the mode is unchanged;
    // folding it in keeps both addresses behind one symbol.
    if (app.mode == new_mode) return;
    app.mode = new_mode;
    for (int which : kModeWindows) {
        set_window_visible(app, which, new_mode == which);
    }
    app.set_status(std::string("mode ") + app.mode_name());
    app.needs_redraw = true;
}

}  // namespace mset::app

MSET_COV_ENTRY(e_changemode_00418430, "00418430", "changemode", ::mset::cov::Impl::Application, mset::app::changemode)
MSET_COV_MEMBER(e_changemode_00418710, "00418710", "changemode", ::mset::cov::Impl::Application, mset::app::changemode)
