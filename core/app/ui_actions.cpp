// app.ui seed: the button / flag actions behind the UI callbacks.
//
// Actions and their state transitions:
//   button0        mode != 6 ? changemode(6) : changemode(1)
//   toggleinvert   invert = !invert
//   togglehighres  highres = !highres; nav_flags = highres*8 +
//                  (lock ? 0x3000 : 0x2000); changemode(1)
//   resetbutton    reset(); ntouches = 1
//   reset          drop buffers, clear caches, return to the default
//                  viewport and redraw
//
// Each function keeps the original's ordering: flip the flag, recompute the
// derived state, then request a redraw / mode change.

#include "app_state.hpp"
#include "ui_model.hpp"
#include "port/port.hpp"
#include "render.hpp"

#include <string>

namespace mset::app {

void button0(AppState& app, int /*param*/) {
    if (app.mode != kModeOverlay) {
        changemode(app, kModeOverlay);
        return;
    }
    changemode(app, kModeNormal);
}

void toggleinvert(AppState& app, int /*param*/) {
    app.invert = !app.invert;
    app.req.invert = app.invert;
    app.set_status(app.invert ? "colours inverted" : "colours normal");
    app.invalidate(false);
}

void togglehighres(AppState& app, int /*param*/) {
    app.highres = !app.highres;
    // nav_flags carries the render resolution class in bits 3..4 and the
    // locked state in bit 12, exactly as the reference assignment shows.
    int flags = (app.highres ? 8 : 0) + (app.lock ? 0x3000 : 0x2000);
    app.nav_flags = flags;
    app.nav_flags_ex = flags;
    changemode(app, kModeNormal);
}

void resetbutton(AppState& app, int /*param*/) {
    reset(app);
    app.ntouches = 1;
}

void reset(AppState& app) {
    // The original releases the two viewport canvases, the tile caches and
    // the reference hierarchies, then rebuilds the default view.  Here the
    // render state is rebuilt from the default request, which is the same
    // observable outcome for every caller (button, mode change, workspace
    // load).
    app.reset_view();
    app.current_image = Image();
    app.dirty_pixels = 0;
    app.needs_render = true;
    app.needs_recalc = true;
    app.needs_redraw = true;
    app.set_status("reset");
}

}  // namespace mset::app

MSET_COV_ENTRY(e_button0_004015d0, "004015d0", "button0", ::mset::cov::Impl::Application, mset::app::button0)
MSET_COV_ENTRY(e_toggleinvert_004016a0, "004016a0", "toggleinvert", ::mset::cov::Impl::Application, mset::app::toggleinvert)
MSET_COV_ENTRY(e_togglehighres_004016c0, "004016c0", "togglehighres", ::mset::cov::Impl::Application, mset::app::togglehighres)
MSET_COV_ENTRY(e_resetbutton_00406430, "00406430", "resetbutton", ::mset::cov::Impl::Application, mset::app::resetbutton)
MSET_COV_ENTRY(e_reset_00406070, "00406070", "reset", ::mset::cov::Impl::Application, mset::app::reset)
