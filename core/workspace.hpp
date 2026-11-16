// Minimal JSON DOM and workspace persistence.
//
// The reference engine stores its viewport and colour settings in JSON
// (savefractallink / the config loader).  This module is the readable C++
// equivalent: a strict recursive-descent parser, a deterministic writer,
// and a typed mapping onto RenderRequest.  It intentionally has no
// dependency on a JSON library.

#pragma once

#include "render.hpp"

#include <map>
#include <string>
#include <vector>

struct JsonValue {
    enum class Type { Null, Bool, Number, String, Array, Object };
    Type type = Type::Null;
    bool boolean = false;
    double number = 0.0;
    std::string text;
    std::vector<JsonValue> array;
    std::map<std::string, JsonValue> object;

    bool is_null() const { return type == Type::Null; }
    const JsonValue* find(const std::string& key) const;
    double as_number(double fallback = 0.0) const;
    int as_int(int fallback = 0) const;
    bool as_bool(bool fallback = false) const;
    std::string as_string(const std::string& fallback = "") const;
};

bool parse_json(const std::string& input, JsonValue& out, std::string* error);
std::string dump_json(const JsonValue& value, int indent = 2);

// Load the subset of the original workspace schema used by the headless
// engine.  Unknown keys are ignored; wrong types are reported.
bool load_workspace(const std::string& path, RenderRequest& req, std::string* error);
bool save_workspace(const std::string& path, const RenderRequest& req, std::string* error);
