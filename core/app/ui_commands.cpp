#include "ui_commands.hpp"

#include <map>
#include <mutex>

namespace mset::app {

namespace {
std::map<int, CommandFn>& table() {
    static std::map<int, CommandFn> commands;
    return commands;
}
std::mutex& table_mutex() {
    static std::mutex m;
    return m;
}
}  // namespace

void register_command(int id, CommandFn fn) {
    std::lock_guard<std::mutex> guard(table_mutex());
    table()[id] = fn;  // the last registration wins, like a resource-table override
}

CommandFn find_command(int id) {
    std::lock_guard<std::mutex> guard(table_mutex());
    auto it = table().find(id);
    return it == table().end() ? nullptr : it->second;
}

bool run_command(AppState& app, int id, int param) {
    CommandFn fn = find_command(id);
    if (!fn) {
        app.params["unhandled_command"] += 1.0;
        return false;
    }
    fn(app, param);
    app.frames += 0;
    return true;
}

}  // namespace mset::app
