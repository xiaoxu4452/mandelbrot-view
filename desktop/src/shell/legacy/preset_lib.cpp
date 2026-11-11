// ------------------------------------------------------------------
// preset_lib.cpp — scanning and serialising the preset folder.
//
// The index is deliberately small.  It carries exactly what a card needs to
// name and draw itself — position, zoom, the additive colour table, the two
// brightness values, and two flags saying "there is a shader" and "there is an
// animation" — and nothing else, because 282 files of full text is a megabyte
// the page would have to parse before it can show a grid.  The text itself is
// fetched per card, by name.
// ------------------------------------------------------------------
#include "preset_lib.h"

#include "mini_json.h"

#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace presetlib {
namespace {

std::wstring g_root;

std::string Narrow(const std::wstring& w) {
  if (w.empty()) return std::string();
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr,
                                    0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr,
                      nullptr);
  return s;
}

std::wstring Widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}

void AppendJsonString(std::string& o, const std::string& s) {
  o += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          std::snprintf(b, sizeof(b), "\\u%04x", c);
          o += b;
        } else {
          o += (char)c;
        }
    }
  }
  o += '"';
}

/** Shortest form that still round-trips a double at the precision a card needs. */
void AppendNum(std::string& o, double v, const char* fmt = "%.7g") {
  if (!(v == v)) { o += '0'; return; }
  char b[64];
  std::snprintf(b, sizeof(b), fmt, v);
  o += b;
}

bool ReadFileUtf8(const std::wstring& path, std::string& out) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER len{};
  if (!GetFileSizeEx(h, &len) || len.QuadPart > (16 << 20)) {
    CloseHandle(h);
    return false;
  }
  out.resize((size_t)len.QuadPart);
  DWORD got = 0;
  const bool ok = out.empty() ||
                  (ReadFile(h, &out[0], (DWORD)out.size(), &got, nullptr) != 0);
  CloseHandle(h);
  if (!ok) return false;
  out.resize(out.empty() ? 0 : (size_t)got);
  return true;
}

std::vector<std::string> ListJsonFiles() {
  std::vector<std::string> out;
  if (g_root.empty()) return out;
  WIN32_FIND_DATAW fd{};
  const std::wstring pat = g_root + L"\\*.json";
  HANDLE h = FindFirstFileW(pat.c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return out;
  do {
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
    out.push_back(Narrow(fd.cFileName));
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  std::sort(out.begin(), out.end());
  return out;
}

/** One card's worth of a preset file.  Missing fields fall back to the ones the
 *  reference program uses when a key is absent, so an older file still lists. */
void AppendIndexItem(std::string& o, const std::string& file, const mj::Value& v) {
  const mj::Value& p = v.get("parameters");
  const mj::Value& cs = p.get("colorscheme");
  const bool julia = v.get("flags").get("julia").truthy() ||
                     p.get("juliamode").nd(0) != 0.0;

  /* A Julia preset's *view* is julia_x/y at julia_zoom; a Mandelbrot preset's
   * is x/y at zoom.  The card has to draw the view the preset opens, not the
   * one it was derived from. */
  const double x = julia ? v.get("julia_x").nd(0.0) : v.get("x").nd(0.0);
  const double y = julia ? v.get("julia_y").nd(0.0) : v.get("y").nd(0.0);
  double zoom = julia ? v.get("julia_zoom").nd(2.0) : v.get("zoom").nd(1.0);
  double rot = julia ? v.get("julia_rotation").nd(0.0) : v.get("rotation").nd(0.0);
  if (!(zoom > 0.0)) zoom = 1.0;

  o += "{\"f\":";
  AppendJsonString(o, file);
  o += ",\"n\":";
  AppendJsonString(o, v.get("name").s(file));
  o += ",\"nz\":";
  AppendJsonString(o, v.get("nameZh").s(v.get("name").s(file)));
  o += ",\"c\":";
  AppendJsonString(o, v.get("category").s("reference"));
  o += ",\"m\":";
  AppendJsonString(o, julia ? "j" : "m");
  o += ",\"x\":";
  AppendNum(o, x, "%.12g");
  o += ",\"y\":";
  AppendNum(o, y, "%.12g");
  o += ",\"zo\":";
  AppendNum(o, zoom, "%.12g");
  o += ",\"r\":";
  AppendNum(o, rot, "%.9g");

  /* The additive table, as flat quintuples: [r,g,b,frequency,initial]. */
  o += ",\"col\":[";
  const mj::Value& cols = p.get("colors");
  const double schemeFreq = p.get("frequency").nd(0.0);
  for (size_t i = 0; i < cols.size(); ++i) {
    const mj::Value& c = cols.at(i);
    const mj::Value& rgb = c.get("rgb");
    if (i) o += ',';
    o += '[';
    AppendNum(o, rgb.at(0).nd(0.0), "%.5g");
    o += ',';
    AppendNum(o, rgb.at(1).nd(0.0), "%.5g");
    o += ',';
    AppendNum(o, rgb.at(2).nd(0.0), "%.5g");
    o += ',';
    AppendNum(o, c.get("frequency").nd(schemeFreq), "%.6g");
    o += ',';
    AppendNum(o, c.get("initial").nd(p.get("initial").nd(0.0)), "%.6g");
    o += ']';
  }
  o += ']';

  o += ",\"bf\":";
  AppendNum(o, p.get("brightnessfinite").nd(1.0), "%.5g");
  o += ",\"bi\":";
  AppendNum(o, p.get("brightnessinfinite").nd(1.0), "%.5g");
  o += ",\"sh\":";
  AppendJsonString(o, cs.get("name").s(""));
  o += ",\"cg\":";
  o += cs.get("codegl").s("").empty() ? '0' : '1';
  o += ",\"an\":";
  o += v.get("animation").isObj() ? '1' : '0';
  o += '}';
}

}  // namespace

void SetRoot(const std::wstring& dir) {
  g_root = dir;
  if (!g_root.empty()) CreateDirectoryW(g_root.c_str(), nullptr);
}

const std::wstring& Root() { return g_root; }

int Count() { return (int)ListJsonFiles().size(); }

std::string IndexJson() {
  std::string o = "{\"dir\":";
  AppendJsonString(o, Narrow(g_root));
  o += ",\"items\":[";
  const std::vector<std::string> files = ListJsonFiles();
  int n = 0;
  for (const std::string& f : files) {
    std::string text;
    if (!ReadFileUtf8(g_root + L"\\" + Widen(f), text)) continue;
    mj::Value v;
    if (!mj::Parse(text, v) || !v.isObj()) continue;
    if (n++) o += ',';
    AppendIndexItem(o, f, v);
  }
  o += "],\"count\":";
  o += std::to_string(n);
  o += '}';
  return o;
}

bool ValidName(const std::string& name) {
  if (name.empty() || name.size() > 120) return false;
  if (name.find('.') == std::string::npos) return false;
  if (name.size() < 5 || name.compare(name.size() - 5, 5, ".json") != 0) return false;
  for (char c : name) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' ||
                    c == ' ';
    if (!ok) return false;
  }
  if (name.find("..") != std::string::npos) return false;
  return true;
}

bool ReadText(const std::string& name, std::string& out) {
  if (g_root.empty() || !ValidName(name)) return false;
  return ReadFileUtf8(g_root + L"\\" + Widen(name), out);
}

bool WriteText(const std::string& name, const std::string& text) {
  if (g_root.empty() || !ValidName(name)) return false;
  CreateDirectoryW(g_root.c_str(), nullptr);
  HANDLE h = CreateFileW((g_root + L"\\" + Widen(name)).c_str(), GENERIC_WRITE, 0,
                         nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD put = 0;
  const bool ok = text.empty() ||
                  (WriteFile(h, text.data(), (DWORD)text.size(), &put, nullptr) != 0 &&
                   put == text.size());
  CloseHandle(h);
  return ok;
}

bool Erase(const std::string& name) {
  if (g_root.empty() || !ValidName(name)) return false;
  return DeleteFileW((g_root + L"\\" + Widen(name)).c_str()) != 0;
}

std::string UniqueName(const std::string& title) {
  std::string stem;
  for (char c : title) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9');
    stem += ok ? c : '-';
  }
  while (!stem.empty() && stem.front() == '-') stem.erase(stem.begin());
  while (!stem.empty() && stem.back() == '-') stem.pop_back();
  if (stem.empty()) stem = "preset";
  if (stem.size() > 64) stem.resize(64);
  std::string name = stem + ".json";
  for (int i = 2; i < 1000; ++i) {
    if (GetFileAttributesW((g_root + L"\\" + Widen(name)).c_str()) ==
        INVALID_FILE_ATTRIBUTES) {
      break;
    }
    name = stem + "-" + std::to_string(i) + ".json";
  }
  return name;
}

}  // namespace presetlib
