// ------------------------------------------------------------------
// preset_lib.h — the preset folder that sits next to the exe.
//
// A preset is a file, not a row in a compiled table: the folder is what the
// user can back up, edit in a text editor, hand to someone else, or point the
// reference program at.  The shell owns the folder because a WebView2 page
// cannot read it, and it hands the page two things:
//
//   IndexJson()  a compact description of every file, enough to draw the grid
//                and a thumbnail without opening any of them
//   ReadText()   the file's text, verbatim, when the user picks it
//
// Both directions are name-based and the name is sanitised first, so a page
// message can never walk out of the folder.
// ------------------------------------------------------------------
#pragma once

#include <string>

namespace presetlib {

/** Point the library at `dir` (created on demand).  Empty = disabled. */
void SetRoot(const std::wstring& dir);
const std::wstring& Root();

/** Number of preset files currently in the folder. */
int Count();

/** `{"dir":"...","count":N,"items":[...]}` — one entry per file, sorted. */
std::string IndexJson();

/** A file name is a bare `*.json` inside the folder; anything else is rejected. */
bool ValidName(const std::string& name);

bool ReadText(const std::string& name, std::string& out);
bool WriteText(const std::string& name, const std::string& text);
bool Erase(const std::string& name);

/** A fresh, non-colliding file name for a user preset called `title`. */
std::string UniqueName(const std::string& title);

}  // namespace presetlib
