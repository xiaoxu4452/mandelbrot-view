// Win32 geometry seed: SetRect / InflateRect / PtInRect / MapDialogRect.
//
// Addresses 0055ee10, 0055ee90, 0055ee60, 0055ee80 are imports from
// user32; the semantics below are the documented ones the engine relies on
// (rectangle normalisation, negative inflation clamping, dialog-unit mapping
// via the 8x16 base-unit of the MS Shell Dlg font).  The remaining geometry
// helpers (OffsetRect, CopyRect, IntersectRect, UnionRect, IsRectEmpty) back
// the GDI/dialog state in this layer and follow the same integer contract.

#include "plt.hpp"
#include "../port.hpp"

#include <algorithm>
#include <utility>

namespace mset::port::plt {

bool set_rect(Rect* rc, int32_t left, int32_t top, int32_t right, int32_t bottom) {
    if (!rc) return false;
    rc->left = left;
    rc->top = top;
    rc->right = right;
    rc->bottom = bottom;
    return true;
}

bool inflate_rect(Rect* rc, int32_t dx, int32_t dy) {
    if (!rc) return false;
    // InflateRect leaves an empty rectangle empty when the inflation would
    // cross it; that is the behaviour the palette widgets depend on.
    if (rc->left > rc->right || rc->top > rc->bottom) return true;
    rc->left -= dx;
    rc->top -= dy;
    rc->right += dx;
    rc->bottom += dy;
    if (rc->right < rc->left) { rc->right = rc->left; }
    if (rc->bottom < rc->top) { rc->bottom = rc->top; }
    return true;
}

bool offset_rect(Rect* rc, int32_t dx, int32_t dy) {
    if (!rc) return false;
    rc->left += dx;
    rc->right += dx;
    rc->top += dy;
    rc->bottom += dy;
    return true;
}

bool copy_rect(Rect* dst, const Rect* src) {
    if (!dst || !src) return false;
    *dst = *src;
    return true;
}

bool intersect_rect(Rect* dst, const Rect* a, const Rect* b) {
    if (!dst || !a || !b) return false;
    dst->left = std::max(a->left, b->left);
    dst->top = std::max(a->top, b->top);
    dst->right = std::min(a->right, b->right);
    dst->bottom = std::min(a->bottom, b->bottom);
    if (dst->left >= dst->right || dst->top >= dst->bottom) {
        *dst = Rect{};
        return false;
    }
    return true;
}

bool union_rect(Rect* dst, const Rect* a, const Rect* b) {
    if (!dst || !a || !b) return false;
    dst->left = std::min(a->left, b->left);
    dst->top = std::min(a->top, b->top);
    dst->right = std::max(a->right, b->right);
    dst->bottom = std::max(a->bottom, b->bottom);
    return true;
}

bool pt_in_rect(const Rect* rc, Point pt) {
    if (!rc) return false;
    // Right/bottom are exclusive, matching user32's PtInRect.
    return pt.x >= rc->left && pt.x < rc->right && pt.y >= rc->top && pt.y < rc->bottom;
}

bool is_rect_empty(const Rect* rc) {
    if (!rc) return true;
    return rc->left >= rc->right || rc->top >= rc->bottom;
}

bool map_dialog_rect(const Rect* dlg_units, int base_unit_x, int base_unit_y, Rect* pixels) {
    if (!dlg_units || !pixels) return false;
    // Horizontal dialog units are quarters of the average character width,
    // vertical units eighths of the character height.
    pixels->left = (dlg_units->left * base_unit_x) / 4;
    pixels->right = (dlg_units->right * base_unit_x) / 4;
    pixels->top = (dlg_units->top * base_unit_y) / 8;
    pixels->bottom = (dlg_units->bottom * base_unit_y) / 8;
    return true;
}

}  // namespace mset::port::plt

MSET_COV_ENTRY(e_setrect_0055ee10, "0055ee10", "SetRect", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::plt::set_rect)
MSET_COV_ENTRY(e_inflaterect_0055ee90, "0055ee90", "InflateRect", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::plt::inflate_rect)
MSET_COV_ENTRY(e_ptinrect_0055ee60, "0055ee60", "PtInRect", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::plt::pt_in_rect)
MSET_COV_ENTRY(e_mapdialogrect_0055ee80, "0055ee80", "MapDialogRect", ::mset::cov::Impl::ThirdPartyEquivalent, mset::port::plt::map_dialog_rect)
