// Win32 / pthread equivalent layer.
//
// The original application is a Win32 GUI program: it calls GDI for its
// dialogs and palette widgets, user32 for messages, timers and clipboard, and
// msvcrt/pthreads for worker sync.  This layer re-implements the used subset
// with plain C++ structures so the same call sequences have the same
// observable effects without a window system:
//
//   * geometry helpers (SetRect, InflateRect, PtInRect, MapDialogRect, ...)
//     are exact integer semantics;
//   * GDI objects (pen, brush, font, bitmap, DC) become handle tables with
//     real allocation/selection/drawing into a software surface;
//   * dialog templates become an in-memory control table;
//   * user32 message circulation becomes an explicit event queue;
//   * pthread / critical-section sync is implemented on std::thread,
//     std::mutex and std::condition_variable while keeping the pthread return
//     convention (0 on success, positive error number otherwise);
//   * file search uses std::filesystem mapped onto WIN32_FIND_DATAW fields;
//   * Sleep uses std::this_thread::sleep_for.
//
// Register every row with MSET_COV_ENTRY.

#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace mset::port::plt {

// --- basic Win32 types -----------------------------------------------------

using Hd = std::uintptr_t;
using Hdc = Hd;
using Hobj = Hd;
using Hwnd = Hd;
using Hinst = Hd;
using Hglob = Hd;
using Hfind = Hd;
using Htouch = Hd;
using Hmodule = Hd;
using Hmenu = Hd;

using Colorref = std::uint32_t;  // 0x00BBGGRR

struct Rect {
    int32_t left = 0, top = 0, right = 0, bottom = 0;
};
struct Point {
    int32_t x = 0, y = 0;
};
struct Size {
    int32_t cx = 0, cy = 0;
};
struct FileTime {
    std::uint32_t dwLowDateTime = 0;
    std::uint32_t dwHighDateTime = 0;
};
struct SystemTime {
    std::uint16_t wYear = 0, wMonth = 0, wDayOfWeek = 0, wDay = 0;
    std::uint16_t wHour = 0, wMinute = 0, wSecond = 0, wMilliseconds = 0;
};

// --- Win32 constants mirrored from the headers the original imports --------

// GetStockObject indices.
constexpr int kWhiteBrush = 0;
constexpr int kLtGrayBrush = 1;
constexpr int kGrayBrush = 2;
constexpr int kDkGrayBrush = 3;
constexpr int kBlackBrush = 4;
constexpr int kNullBrush = 5;
constexpr int kWhitePen = 6;
constexpr int kBlackPen = 7;
constexpr int kNullPen = 8;
constexpr int kOemFixedFont = 10;
constexpr int kAnsiFixedFont = 11;
constexpr int kAnsiVarFont = 12;
constexpr int kDefaultGuiFont = 17;

// Pen styles.
constexpr int kPsSolid = 0;
constexpr int kPsDash = 1;
constexpr int kPsNull = 5;

// Button check state.
constexpr std::uint32_t kBstUnchecked = 0;
constexpr std::uint32_t kBstChecked = 1;
constexpr std::uint32_t kBstIndeterminate = 2;

// MessageBox return values / types.
constexpr std::uint32_t kMbOk = 0x00000000;
constexpr int kIdOk = 1;
constexpr int kIdCancel = 2;

// Code pages accepted by the conversion helpers (CP_ACP treated as UTF-8 in
// the headless model; the binary's own strings are UTF-8/ASCII).
constexpr std::uint32_t kCpAcp = 0;
constexpr std::uint32_t kCpUtf8 = 65001;

// GetSystemMetrics indices used by the dialog layout.
constexpr int kSmCxScreen = 0;
constexpr int kSmCyScreen = 1;

// --- reference ABI mirrors --------------------------------------------------

struct SystemInfo {
    std::uint32_t dwOemId = 0;
    std::uint32_t dwPageSize = 4096;
    void* lpMinimumApplicationAddress = nullptr;
    void* lpMaximumApplicationAddress = nullptr;
    std::uint32_t dwActiveProcessorMask = 0;
    std::uint32_t dwNumberOfProcessors = 1;
    std::uint32_t dwProcessorType = 0;
    std::uint32_t dwAllocationGranularity = 65536;
    std::uint16_t wProcessorLevel = 0;
    std::uint16_t wProcessorRevision = 0;
};

struct MemoryStatusEx {
    std::uint32_t dwLength = 64;
    std::uint32_t dwMemoryLoad = 0;
    std::uint64_t ullTotalPhys = 0;
    std::uint64_t ullAvailPhys = 0;
    std::uint64_t ullTotalPageFile = 0;
    std::uint64_t ullAvailPageFile = 0;
    std::uint64_t ullTotalVirtual = 0;
    std::uint64_t ullAvailVirtual = 0;
    std::uint64_t ullAvailExtendedVirtual = 0;
};

struct StartupInfoA {
    Rect rcDesktop;
    Rect rcWindow;
    Point dwXSize;
    Point dwYSize;
    std::string lpDesktop;
    std::string lpTitle;
    std::uint32_t dwX = 0, dwY = 0;
    std::uint32_t dwXSize = 0, dwYSize = 0;
    std::uint32_t dwXCountChars = 0, dwYCountChars = 0;
    std::uint32_t dwFillAttribute = 0, dwFlags = 0;
    std::uint16_t wShowWindow = 0;
};

struct BitmapInfoHeader {
    std::int32_t biSize = 40;
    std::int32_t biWidth = 0;
    std::int32_t biHeight = 0;
    std::uint16_t biPlanes = 1;
    std::uint16_t biBitCount = 32;
    std::uint32_t biCompression = 0;
    std::uint32_t biSizeImage = 0;
    std::int32_t biXPelsPerMeter = 0;
    std::int32_t biYPelsPerMeter = 0;
    std::uint32_t biClrUsed = 0;
    std::uint32_t biClrImportant = 0;
};

struct FindDataW {
    std::uint32_t dwFileAttributes = 0;
    FileTime ftCreationTime;
    FileTime ftLastAccessTime;
    FileTime ftLastWriteTime;
    std::uint32_t nFileSizeHigh = 0;
    std::uint32_t nFileSizeLow = 0;
    std::uint32_t dwReserved0 = 0;
    std::uint32_t dwReserved1 = 0;
    wchar_t cFileName[260] = {};
    wchar_t cAlternateFileName[14] = {};
};

struct OpenFileNameW {
    std::uint32_t lStructSize = 0;
    Hwnd hwndOwner = 0;
    Hinst hInstance = 0;
    const wchar_t* lpstrFilter = nullptr;
    wchar_t* lpstrCustomFilter = nullptr;
    std::uint32_t nMaxCustFilter = 0;
    std::uint32_t nFilterIndex = 0;
    wchar_t* lpstrFile = nullptr;
    std::uint32_t nMaxFile = 0;
    wchar_t* lpstrFileTitle = nullptr;
    std::uint32_t nMaxFileTitle = 0;
    const wchar_t* lpstrInitialDir = nullptr;
    const wchar_t* lpstrTitle = nullptr;
    std::uint32_t Flags = 0;
    std::uint16_t nFileOffset = 0;
    std::uint16_t nFileExtension = 0;
    const wchar_t* lpstrDefExt = nullptr;
    std::intptr_t lCustData = 0;
    void* lpfnHook = nullptr;
    const wchar_t* lpTemplateName = nullptr;
};

struct TimeZoneInformation {
    long Bias = 0;
    wchar_t StandardName[32] = {};
    SystemTime StandardDate;
    long StandardBias = 0;
    wchar_t DaylightName[32] = {};
    SystemTime DaylightDate;
    long DaylightBias = 0;
};

// --- pthread / critical-section mirrors -------------------------------------

struct PthreadAttr {
    std::size_t stacksize = 0;
};
struct PthreadMutex {
    std::mutex mtx;
    bool initialized = false;
};
struct PthreadCond {
    std::condition_variable cv;
    bool initialized = false;
};
struct PthreadThreadCtl {
    std::thread thread;
    bool joinable = false;
    void* retval = nullptr;
    std::mutex mtx;
    std::condition_variable done;
    bool finished = false;
};
using PthreadT = PthreadThreadCtl*;
struct CriticalSection {
    std::mutex mtx;
    bool initialized = false;
};

// --- encoding helpers (UTF-8 <-> UTF-16), implemented in plt_core.cpp ------

int utf8_to_wide(const char* s, int cb, wchar_t* out, int cch);
int wide_to_utf8(const wchar_t* s, int cch, char* out, int cb);
std::wstring u8_to_w(const std::string& s);
std::string w_to_u8(const std::wstring& s);

// --- geometry (seed implementations in plt_geom.cpp) -----------------------

bool set_rect(Rect* rc, int32_t left, int32_t top, int32_t right, int32_t bottom);
bool inflate_rect(Rect* rc, int32_t dx, int32_t dy);
bool offset_rect(Rect* rc, int32_t dx, int32_t dy);
bool copy_rect(Rect* dst, const Rect* src);
bool intersect_rect(Rect* dst, const Rect* a, const Rect* b);
bool union_rect(Rect* dst, const Rect* a, const Rect* b);
bool pt_in_rect(const Rect* rc, Point pt);
bool is_rect_empty(const Rect* rc);
bool map_dialog_rect(const Rect* dlg_units, int base_unit_x, int base_unit_y, Rect* pixels);

}  // namespace mset::port::plt
