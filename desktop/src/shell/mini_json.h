// ------------------------------------------------------------------
// mini_json.h — a JSON reader small enough to keep in the shell.
//
// The shell has to *look inside* a preset file to build the library index
// (position, zoom, colour table, whether a shader is attached), and it has to
// do so for a few hundred files at startup.  Pulling a full JSON library in
// for that would add more code than the renderer, so this is a plain
// recursive-descent reader over a parsed DOM: objects, arrays, numbers,
// strings, booleans and null, with \u escapes and no comments.
//
// It is deliberately not a writer: writing is done by the page, which already
// has JSON.stringify and needs to preserve the exact text of a 40-digit
// coordinate that this reader would turn into a double.
// ------------------------------------------------------------------
#pragma once

#include <cmath>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace mj {

struct Value;
using Array = std::vector<Value>;
using Object = std::vector<std::pair<std::string, Value>>;

struct Value {
  enum Type { Null, Bool, Num, Str, Arr, Obj } type = Null;
  bool b = false;
  double num = 0.0;
  std::string str;
  std::shared_ptr<Array> arr;
  std::shared_ptr<Object> obj;

  bool isObj() const { return type == Obj && obj; }
  bool isArr() const { return type == Arr && arr; }
  bool isStr() const { return type == Str; }
  bool isNum() const { return type == Num; }

  /** Member lookup; returns a shared null value when absent. */
  const Value& get(const char* key) const {
    static const Value kNull;
    if (!isObj()) return kNull;
    for (const auto& kv : *obj) {
      if (kv.first == key) return kv.second;
    }
    return kNull;
  }
  const Value& at(size_t i) const {
    static const Value kNull;
    if (!isArr() || i >= arr->size()) return kNull;
    return (*arr)[i];
  }
  size_t size() const {
    if (isArr()) return arr->size();
    if (isObj()) return obj->size();
    return 0;
  }
  /** Number as double, with a fallback for "missing" and "wrong type". */
  double n(double dflt = 0.0) const { return type == Num ? num : dflt; }
  /** Number or numeric string, whichever the file used. */
  double nd(double dflt = 0.0) const {
    if (type == Num) return num;
    if (type == Str && !str.empty()) {
      const double v = std::strtod(str.c_str(), nullptr);
      return std::isfinite(v) ? v : dflt;
    }
    return dflt;
  }
  std::string s(const std::string& dflt = std::string()) const {
    return type == Str ? str : (type == Num ? std::to_string(num) : dflt);
  }
  bool truthy() const {
    if (type == Bool) return b;
    if (type == Num) return num != 0.0;
    if (type == Str) return !str.empty() && str != "0";
    return false;
  }
};

namespace detail {

struct Parser {
  const char* p;
  const char* end;
  std::string err;

  void ws() {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) ++p;
  }
  bool fail(const char* m) {
    if (err.empty()) err = m;
    return false;
  }
  static void putUtf8(std::string& o, unsigned cp) {
    if (cp < 0x80) {
      o += (char)cp;
    } else if (cp < 0x800) {
      o += (char)(0xC0 | (cp >> 6));
      o += (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      o += (char)(0xE0 | (cp >> 12));
      o += (char)(0x80 | ((cp >> 6) & 0x3F));
      o += (char)(0x80 | (cp & 0x3F));
    } else {
      o += (char)(0xF0 | (cp >> 18));
      o += (char)(0x80 | ((cp >> 12) & 0x3F));
      o += (char)(0x80 | ((cp >> 6) & 0x3F));
      o += (char)(0x80 | (cp & 0x3F));
    }
  }
  bool string(std::string& out) {
    if (p >= end || *p != '"') return fail("expected string");
    ++p;
    out.clear();
    while (p < end) {
      const unsigned char c = (unsigned char)*p++;
      if (c == '"') return true;
      if (c != '\\') { out += (char)c; continue; }
      if (p >= end) break;
      const char e = *p++;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned cp = 0;
          for (int i = 0; i < 4 && p < end; ++i) {
            const char h = *p++;
            cp <<= 4;
            if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
            else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
          }
          putUtf8(out, cp);
          break;
        }
        default: out += e; break;
      }
    }
    return fail("unterminated string");
  }
  bool value(Value& v, int depth) {
    if (depth > 64) return fail("too deep");
    ws();
    if (p >= end) return fail("unexpected end");
    switch (*p) {
      case '{': {
        ++p;
        v.type = Value::Obj;
        v.obj = std::make_shared<Object>();
        ws();
        if (p < end && *p == '}') { ++p; return true; }
        for (;;) {
          ws();
          std::string k;
          if (!string(k)) return false;
          ws();
          if (p >= end || *p != ':') return fail("expected ':'");
          ++p;
          Value item;
          if (!value(item, depth + 1)) return false;
          v.obj->emplace_back(std::move(k), std::move(item));
          ws();
          if (p < end && *p == ',') { ++p; continue; }
          if (p < end && *p == '}') { ++p; return true; }
          return fail("expected ',' or '}'");
        }
      }
      case '[': {
        ++p;
        v.type = Value::Arr;
        v.arr = std::make_shared<Array>();
        ws();
        if (p < end && *p == ']') { ++p; return true; }
        for (;;) {
          Value item;
          if (!value(item, depth + 1)) return false;
          v.arr->push_back(std::move(item));
          ws();
          if (p < end && *p == ',') { ++p; continue; }
          if (p < end && *p == ']') { ++p; return true; }
          return fail("expected ',' or ']'");
        }
      }
      case '"':
        v.type = Value::Str;
        return string(v.str);
      case 't':
        if (end - p >= 4 && std::string(p, p + 4) == "true") {
          p += 4; v.type = Value::Bool; v.b = true; return true;
        }
        return fail("bad literal");
      case 'f':
        if (end - p >= 5 && std::string(p, p + 5) == "false") {
          p += 5; v.type = Value::Bool; v.b = false; return true;
        }
        return fail("bad literal");
      case 'n':
        if (end - p >= 4 && std::string(p, p + 4) == "null") {
          p += 4; v.type = Value::Null; return true;
        }
        return fail("bad literal");
      default: {
        char* stop = nullptr;
        const double d = std::strtod(p, &stop);
        if (stop == p) return fail("bad number");
        p = stop;
        v.type = Value::Num;
        v.num = d;
        return true;
      }
    }
  }
};

}  // namespace detail

/** Parse `text`; returns false and fills `err` on malformed input. */
inline bool Parse(const std::string& text, Value& out, std::string* err = nullptr) {
  detail::Parser ps{text.data(), text.data() + text.size(), {}};
  const bool ok = ps.value(out, 0);
  if (!ok && err) *err = ps.err;
  return ok;
}

}  // namespace mj
