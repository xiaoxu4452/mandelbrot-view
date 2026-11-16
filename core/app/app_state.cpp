#include "app_state.hpp"

#include <algorithm>
#include <cmath>

namespace mset::app {

void AppState::invalidate(bool recalc_now) {
    needs_redraw = true;
    if (recalc_now) {
        needs_recalc = true;
        view.recalc();
        view_ex.recalc();
    }
    dirty_pixels += (long long)view.width * (long long)view.height;
}

void AppState::set_status(std::string text) {
    if (status != text) {
        status = std::move(text);
        log_lines.push_back(status);
        if (log_lines.size() > 64) log_lines.erase(log_lines.begin());
    }
    needs_redraw = true;
}

void AppState::apply_palette(const std::string& name) {
    palette_name = name;
    palette = Palette::by_name(name);
    needs_redraw = true;
}

void AppState::center_on_pixel(int x, int y) {
    auto p = view.point_at(x, y);
    view.center_re = p.first;
    view.center_im = p.second;
    invalidate(true);
}

void AppState::zoom_at_pixel(int x, int y, double factor) {
    if (!(factor > 0.0)) return;
    // Zoom about the clicked point: move the centre so that the point keeps
    // its complex coordinate after the scale changes.
    auto before = view.point_at(x, y);
    view.zoom_by(factor);
    auto after = view.point_at(x, y);
    view.center_re = view.center_re + (before.first - after.first);
    view.center_im = view.center_im + (before.second - after.second);
    invalidate(true);
}

void AppState::pan_by(int dx, int dy) {
    view.pan_pixels((double)dx, (double)dy);
    invalidate(false);
}

void AppState::reset_view() {
    view.center_re = BigFloat(-0.6);
    view.center_im = BigFloat(0.0);
    view.zoom_mantissa = 1.0;
    view.zoom_exp10 = 0;
    view_ex = view;
    view.recalc();
    juliamode = 0;
    mode = kModeNormal;
    invalidate(true);
}

void AppState::fit_to_window() {
    view.width = std::max(1, client.right - client.left);
    view.height = std::max(1, client.bottom - client.top);
    view_ex.width = view.width;
    view_ex.height = view.height;
    invalidate(true);
}

void AppState::set_mode(int new_mode) {
    mode = new_mode;
}

const char* AppState::mode_name() const {
    switch (mode) {
        case kModeStartup: return "startup";
        case kModeNormal: return "normal";
        case kModeBusy: return "busy";
        case kModeMenu: return "menu";
        case kModeDialog: return "dialog";
        case kModeVideo: return "video";
        case kModeOverlay: return "overlay";
        case kModeQuit: return "quit";
        default: return "unknown";
    }
}

void AppState::touch_push(int x, int y) {
    touch_x.push_back((double)x);
    touch_y.push_back((double)y);
    ntouches = (int)touch_x.size();
}

void AppState::touch_clear() {
    touch_x.clear();
    touch_y.clear();
    ntouches = 1;
}

}  // namespace mset::app
