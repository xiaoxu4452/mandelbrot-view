// ---------------------------------------------------------------------------
// native_canvas.h — D3D11 swapchain child window used as the product canvas.
//
// The renderer (mbc::Engine) still writes plain RGBA into a CPU surface; this
// module owns the presentation side: a child HWND with a bitblt swapchain,
// a DEFAULT-usage texture fed by UpdateSubresource, a fullscreen-triangle
// shader that scales / supersample-reduces / preview-transforms the last pass,
// and the Present call.  WebView2 is layered on top with a transparent
// background and only draws the panels and text.
//
// Everything is optional: Init() returning false leaves the product on the
// original JS-canvas path, no blank window.
// ---------------------------------------------------------------------------
#pragma once
#include <windows.h>
#include <cstdint>

namespace nc {

/** Create the canvas child window and the D3D11 objects.  False = no path. */
bool Init(HWND host);
void Shutdown();
bool Ready();

/** Move the child window and resize the swapchain without re-rendering. */
void SetBounds(int x, int y, int w, int h);

/** Declare a new pass surface.  passW/passH are the engine bitmap dimensions,
 *  ss the supersampling factor, cw/ch the page canvas dimensions. */
void BeginPass(int passW, int passH, int ss, int cw, int ch);

/** Copy one finished tile into the staging texture (no present yet). */
void UploadTile(const uint8_t* frame, int frameW, int frameH,
                int x, int y, int w, int h);

/** Promote the staging texture to the visible one, reset the preview
 *  transform and present.  Returns false when there was no staging surface. */
bool CommitPass();

/** Promote the staging texture while KEEPING the gesture transform that
 *  accumulated while this pass was being computed (src = sx*dst + ox, in
 *  normalised units).  Without this, a live pass committed mid-gesture snaps
 *  the picture back to the view that existed when the pass started, which is
 *  the "zoom jumps / goes blurry again" symptom.  The page sends its own
 *  accumulated transform with the flush message. */
bool CommitPassWithPreview(double sx, double ox, double sy, double oy);

/** One gesture-preview step, mirroring the page's blitSnapshot(dx,dy,scale,
 *  cx,cy).  Coordinates are normalised by the canvas size. */
void Preview(double scale, double dx, double dy, double cx, double cy);

/** Drop the preview transform (new frame took over). */
void ResetPreview();

/** Present the current texture scaled to the window. */
void Present();

HWND Hwnd();
double LastUploadMs();
double LastPresentMs();
int FrameCount();

}  // namespace nc
