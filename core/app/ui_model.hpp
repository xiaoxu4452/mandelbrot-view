// Shared UI entry points.
//
// The UI entry points are split across two implementation slices.  The
// structural ones — the message dispatcher, the mode machine, recalc and
// reset, the menu builder — live in slice A (src/app/ui_a_*.cpp) and are
// declared here so slice B can call them without owning a second definition.

#pragma once

#include "app_state.hpp"

#include <string>

namespace mset::app {

// Mode machine (changemode, 00418430 / 00418710).
void changemode(AppState& app, int new_mode);

// Full reset of the render state (reset, 00406070).
void reset(AppState& app);

// Recompute the precision plan and the reference context (recalc, 004036f0).
void recalc(AppState& app);

// Redraw both viewports into the software surface (recalcredraw, 00403730).
void recalcredraw(AppState& app);

// Render the current frame if the state is dirty (renderpath, 00402xxx).
void render_if_needed(AppState& app, std::string* error);

// Build the application menu from the documented menu labels.
void make_menu(AppState& app);

// Window message dispatch (WindowProc, 004018b0).
std::intptr_t dispatch_message(AppState& app, const Message& msg);

// Keyboard callback (key_callback, 00408860) and touch input (itouch).
void key_input(AppState& app, int key, int scancode, int action);
void touch_input(AppState& app, int count, const int* xs, const int* ys);

// Colour channel conversion used by the video path (YUVfromRGB, 00406750).
void yuv_from_rgb(double r, double g, double b, int* y, int* u, int* v);

// --- action callbacks (src/app/ui_actions.cpp) ---------------------------
void button0(AppState& app, int param);        // 004015d0
void toggleinvert(AppState& app, int param);   // 004016a0
void togglehighres(AppState& app, int param);  // 004016c0
void resetbutton(AppState& app, int param);    // 00406430

}  // namespace mset::app
