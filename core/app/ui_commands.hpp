// Command table for the headless UI.
//
// Buttons / menu items are dispatched through numeric command ids
// (WM_COMMAND).  The UI callbacks are written by two implementation slices,
// so a static table keyed by command id is what lets the message dispatcher
// (slice A) invoke a handler defined in slice B without either slice owning
// the other's declarations.
//
// Registration happens at start-up:
//   MSET_UI_COMMAND(reg_button1, 101, mset::app::button1)

#pragma once

#include "app_state.hpp"

namespace mset::app {

using CommandFn = void (*)(AppState&, int param);

void register_command(int id, CommandFn fn);
CommandFn find_command(int id);
// Returns false when the id has no handler, so the dispatcher can fall back
// to its default (message ignored) path instead of crashing.
bool run_command(AppState& app, int id, int param);

}  // namespace mset::app

#define MSET_UI_COMMAND(tag, id, fn)                                                     \
    namespace {                                                                          \
        struct UiCmdReg_##tag {                                                          \
            UiCmdReg_##tag() { ::mset::app::register_command((id), (fn)); }              \
        };                                                                               \
        static UiCmdReg_##tag ui_cmd_reg_##tag;                                          \
    }
