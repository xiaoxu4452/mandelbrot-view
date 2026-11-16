#include "workspace.hpp"

#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <sstream>

namespace {

struct Parser {
    const std::string& s;
    size_t i = 0;
    std::string error;

    explicit Parser(const std::string& input) : s(input) {}

    void skip_ws() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
    }

    bool fail(const std::string& msg) {
        if (error.empty()) {
            std::ostringstream os;
            os << msg << " at byte " << i;
            error = os.str();
        }
        return false;
    }

    bool parse_string(std::string& out) {
        if (i >= s.size() || s[i] != '"') return fail("expected string");
        ++i;
        out.clear();
        while (i < s.size()) {
            char c = s[i++];
            if (c == '"') return true;
            if (c == '\\') {
                if (i >= s.size()) return fail("truncated escape");
                char e = s[i++];
                switch (e) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        if (i + 4 > s.size()) return fail("truncated \\u escape");
                        unsigned code = 0;
                        for (int k = 0; k < 4; ++k) {
                            char h = s[i++];
                            code <<= 4;
                            if (h >= '0' && h <= '9') code |= (unsigned)(h - '0');
                            else if (h >= 'a' && h <= 'f') code |= (unsigned)(h - 'a' + 10);
                            else if (h >= 'A' && h <= 'F') code |= (unsigned)(h - 'A' + 10);
                            else return fail("bad hex digit");
                        }
                        if (code < 0x80) out.push_back((char)code);
                        else if (code < 0x800) {
                            out.push_back((char)(0xC0 | (code >> 6)));
                            out.push_back((char)(0x80 | (code & 0x3F)));
                        } else {
                            out.push_back((char)(0xE0 | (code >> 12)));
                            out.push_back((char)(0x80 | ((code >> 6) & 0x3F)));
                            out.push_back((char)(0x80 | (code & 0x3F)));
                        }
                        break;
                    }
                    default: return fail("unknown escape");
                }
            } else {
                out.push_back(c);
            }
        }
        return fail("unterminated string");
    }

    bool parse_number(double& out) {
        size_t start = i;
        if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
        while (i < s.size() && (std::isdigit((unsigned char)s[i]) || s[i] == '.' ||
                                s[i] == 'e' || s[i] == 'E' || s[i] == '-' || s[i] == '+')) ++i;
        if (i == start) return fail("expected number");
        char* end = nullptr;
        out = std::strtod(s.c_str() + start, &end);
        if (end != s.c_str() + i) return fail("bad number");
        return true;
    }

    bool parse_value(JsonValue& v, int depth) {
        if (depth > 64) return fail("nesting too deep");
        skip_ws();
        if (i >= s.size()) return fail("unexpected end");
        char c = s[i];
        if (c == '{') {
            ++i;
            v.type = JsonValue::Type::Object;
            skip_ws();
            if (i < s.size() && s[i] == '}') { ++i; return true; }
            while (true) {
                skip_ws();
                std::string key;
                if (!parse_string(key)) return false;
                skip_ws();
                if (i >= s.size() || s[i] != ':') return fail("expected ':'");
                ++i;
                JsonValue child;
                if (!parse_value(child, depth + 1)) return false;
                v.object[key] = std::move(child);
                skip_ws();
                if (i < s.size() && s[i] == ',') { ++i; continue; }
                if (i < s.size() && s[i] == '}') { ++i; return true; }
                return fail("expected ',' or '}'");
            }
        }
        if (c == '[') {
            ++i;
            v.type = JsonValue::Type::Array;
            skip_ws();
            if (i < s.size() && s[i] == ']') { ++i; return true; }
            while (true) {
                JsonValue child;
                if (!parse_value(child, depth + 1)) return false;
                v.array.push_back(std::move(child));
                skip_ws();
                if (i < s.size() && s[i] == ',') { ++i; continue; }
                if (i < s.size() && s[i] == ']') { ++i; return true; }
                return fail("expected ',' or ']'");
            }
        }
        if (c == '"') {
            v.type = JsonValue::Type::String;
            return parse_string(v.text);
        }
        if (c == 't' && s.compare(i, 4, "true") == 0) {
            v.type = JsonValue::Type::Bool; v.boolean = true; i += 4; return true;
        }
        if (c == 'f' && s.compare(i, 5, "false") == 0) {
            v.type = JsonValue::Type::Bool; v.boolean = false; i += 5; return true;
        }
        if (c == 'n' && s.compare(i, 4, "null") == 0) {
            v.type = JsonValue::Type::Null; i += 4; return true;
        }
        v.type = JsonValue::Type::Number;
        return parse_number(v.number);
    }
};

void dump_string(std::ostream& os, const std::string& s) {
    os << '"';
    for (char c : s) {
        switch (c) {
            case '"': os << "\\\""; break;
            case '\\': os << "\\\\"; break;
            case '\b': os << "\\b"; break;
            case '\f': os << "\\f"; break;
            case '\n': os << "\\n"; break;
            case '\r': os << "\\r"; break;
            case '\t': os << "\\t"; break;
            default:
                if ((unsigned char)c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)(unsigned char)c);
                    os << buf;
                } else {
                    os << c;
                }
        }
    }
    os << '"';
}

void dump_value(std::ostream& os, const JsonValue& v, int indent, int level) {
    std::string pad((size_t)(indent * level), ' ');
    std::string pad2((size_t)(indent * (level + 1)), ' ');
    switch (v.type) {
        case JsonValue::Type::Null: os << "null"; break;
        case JsonValue::Type::Bool: os << (v.boolean ? "true" : "false"); break;
        case JsonValue::Type::Number: os << v.number; break;
        case JsonValue::Type::String: dump_string(os, v.text); break;
        case JsonValue::Type::Array:
            if (v.array.empty()) { os << "[]"; break; }
            os << "[\n";
            for (size_t k = 0; k < v.array.size(); ++k) {
                os << pad2;
                dump_value(os, v.array[k], indent, level + 1);
                if (k + 1 < v.array.size()) os << ',';
                os << '\n';
            }
            os << pad << ']';
            break;
        case JsonValue::Type::Object:
            if (v.object.empty()) { os << "{}"; break; }
            os << "{\n";
            size_t k = 0;
            for (const auto& [key, child] : v.object) {
                os << pad2;
                dump_string(os, key);
                os << ": ";
                dump_value(os, child, indent, level + 1);
                if (++k < v.object.size()) os << ',';
                os << '\n';
            }
            os << pad << '}';
            break;
    }
}

const char* color_mode_name(ColorMode m) {
    switch (m) {
        case ColorMode::Smooth: return "smooth";
        case ColorMode::Iteration: return "iteration";
        case ColorMode::Distance: return "distance";
        case ColorMode::Binary: return "binary";
    }
    return "smooth";
}

}  // namespace

const JsonValue* JsonValue::find(const std::string& key) const {
    auto it = object.find(key);
    return it == object.end() ? nullptr : &it->second;
}

double JsonValue::as_number(double fallback) const {
    return type == Type::Number ? number : fallback;
}
int JsonValue::as_int(int fallback) const {
    return type == Type::Number ? (int)std::llround(number) : fallback;
}
bool JsonValue::as_bool(bool fallback) const {
    return type == Type::Bool ? boolean : fallback;
}
std::string JsonValue::as_string(const std::string& fallback) const {
    return type == Type::String ? text : fallback;
}

bool parse_json(const std::string& input, JsonValue& out, std::string* error) {
    Parser p(input);
    out = JsonValue();
    if (!p.parse_value(out, 0)) {
        if (error) *error = p.error;
        return false;
    }
    p.skip_ws();
    if (p.i != input.size()) {
        if (error) *error = "trailing characters";
        return false;
    }
    return true;
}

std::string dump_json(const JsonValue& value, int indent) {
    std::ostringstream os;
    dump_value(os, value, indent, 0);
    return os.str();
}

bool load_workspace(const std::string& path, RenderRequest& req, std::string* error) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        if (error) *error = "cannot open " + path;
        return false;
    }
    std::string text{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
    JsonValue root;
    if (!parse_json(text, root, error)) return false;
    if (root.type != JsonValue::Type::Object) {
        if (error) *error = "workspace root must be an object";
        return false;
    }
    auto get = [&](const char* key) { return root.find(key); };
    if (auto v = get("center_re")) req.center_re = v->as_string(req.center_re);
    if (auto v = get("center_im")) req.center_im = v->as_string(req.center_im);
    if (auto v = get("zoom_mantissa")) req.zoom_mantissa = v->as_number(req.zoom_mantissa);
    if (auto v = get("zoom_exp10")) req.zoom_exp10 = (int64_t)v->as_number((double)req.zoom_exp10);
    if (auto v = get("width")) req.width = v->as_int(req.width);
    if (auto v = get("height")) req.height = v->as_int(req.height);
    if (auto v = get("maxiter")) req.maxiter = v->as_int(req.maxiter);
    if (auto v = get("precision_digits")) req.precision_digits = v->as_int(req.precision_digits);
    if (auto v = get("max_precision_digits")) req.max_precision_digits = v->as_int(req.max_precision_digits);
    if (auto v = get("threads")) req.threads = v->as_int(req.threads);
    if (auto v = get("tile_size")) req.tile_size = v->as_int(req.tile_size);
    if (auto v = get("sa_order")) req.sa_order = v->as_int(req.sa_order);
    if (auto v = get("use_sa")) req.use_sa = v->as_bool(req.use_sa);
    if (auto v = get("use_distance")) req.use_distance = v->as_bool(req.use_distance);
    if (auto v = get("exact")) req.exact = v->as_bool(req.exact);
    if (auto v = get("tile_rebase")) req.tile_rebase = v->as_bool(req.tile_rebase);
    if (auto v = get("invert")) req.invert = v->as_bool(req.invert);
    if (auto v = get("palette")) req.palette = v->as_string(req.palette);
    if (auto v = get("color_mode")) {
        std::string m = v->as_string(color_mode_name(req.color_mode));
        if (m == "smooth") req.color_mode = ColorMode::Smooth;
        else if (m == "iteration") req.color_mode = ColorMode::Iteration;
        else if (m == "distance") req.color_mode = ColorMode::Distance;
        else if (m == "binary") req.color_mode = ColorMode::Binary;
    }
    if (auto v = get("span")) req.span = v->as_number(req.span);
    if (auto v = get("palette_scale")) req.palette_scale = v->as_number(req.palette_scale);
    if (auto v = get("distance_param")) req.distance_param = v->as_number(req.distance_param);
    if (auto v = get("julia")) req.julia = v->as_bool(req.julia);
    if (auto v = get("julia_re")) req.julia_re = v->as_string(req.julia_re);
    if (auto v = get("julia_im")) req.julia_im = v->as_string(req.julia_im);
    if (auto v = get("interior_palette")) req.interior_palette = v->as_bool(req.interior_palette);
    return true;
}

bool save_workspace(const std::string& path, const RenderRequest& req, std::string* error) {
    JsonValue root;
    root.type = JsonValue::Type::Object;
    auto num = [](double d) { JsonValue v; v.type = JsonValue::Type::Number; v.number = d; return v; };
    auto str = [](const std::string& s) { JsonValue v; v.type = JsonValue::Type::String; v.text = s; return v; };
    auto boolean = [](bool b) { JsonValue v; v.type = JsonValue::Type::Bool; v.boolean = b; return v; };
    root.object["center_re"] = str(req.center_re);
    root.object["center_im"] = str(req.center_im);
    root.object["zoom_mantissa"] = num(req.zoom_mantissa);
    root.object["zoom_exp10"] = num((double)req.zoom_exp10);
    root.object["width"] = num((double)req.width);
    root.object["height"] = num((double)req.height);
    root.object["maxiter"] = num((double)req.maxiter);
    root.object["precision_digits"] = num((double)req.precision_digits);
    root.object["max_precision_digits"] = num((double)req.max_precision_digits);
    root.object["threads"] = num((double)req.threads);
    root.object["tile_size"] = num((double)req.tile_size);
    root.object["sa_order"] = num((double)req.sa_order);
    root.object["use_sa"] = boolean(req.use_sa);
    root.object["use_distance"] = boolean(req.use_distance);
    root.object["exact"] = boolean(req.exact);
    root.object["tile_rebase"] = boolean(req.tile_rebase);
    root.object["invert"] = boolean(req.invert);
    root.object["palette"] = str(req.palette);
    root.object["color_mode"] = str(color_mode_name(req.color_mode));
    root.object["span"] = num(req.span);
    root.object["palette_scale"] = num(req.palette_scale);
    root.object["distance_param"] = num(req.distance_param);
    root.object["julia"] = boolean(req.julia);
    root.object["julia_re"] = str(req.julia_re);
    root.object["julia_im"] = str(req.julia_im);
    root.object["interior_palette"] = boolean(req.interior_palette);

    std::ofstream out(path, std::ios::binary);
    if (!out) {
        if (error) *error = "cannot write " + path;
        return false;
    }
    out << dump_json(root, 2) << "\n";
    return (bool)out;
}
