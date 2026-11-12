// ---------------------------------------------------------------------------
// native_canvas.cpp — D3D11 child-window canvas for the shipping product.
// The implementation mirrors the verified spike (bitblt DISCARD swapchain,
// DEFAULT texture + UpdateSubresource, canvas child pushed to HWND_BOTTOM),
// with two additions the product needs:
//   · two textures: the finished pass is promoted only when the whole pass
//     has landed, so in-progress tiles never tear the visible image;
//   · a preview transform (scale + translate) applied in the pixel shader,
//     so wheel/drag feedback is produced on the GPU instead of via JS blits.
// ---------------------------------------------------------------------------
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dxgi1_3.h>
#include <d3dcompiler.h>

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>

#include "native_canvas.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "uuid.lib")

namespace {

struct Tex {
  ID3D11Texture2D* tex = nullptr;
  ID3D11ShaderResourceView* srv = nullptr;
  int w = 0, h = 0;
};

struct Gpu {
  ID3D11Device* dev = nullptr;
  ID3D11DeviceContext* ctx = nullptr;
  IDXGISwapChain1* sc = nullptr;
  ID3D11RenderTargetView* rtv = nullptr;
  ID3D11VertexShader* vs = nullptr;
  ID3D11PixelShader* ps = nullptr;
  ID3D11RasterizerState* rs = nullptr;
  ID3D11SamplerState* sm = nullptr;
  ID3D11Buffer* cb = nullptr;
  Tex slots[2];
  int display = -1;          // slot currently on screen, -1 = none yet
  int pendingSS = 1;
  int displaySS = 1;
  bool ready = false;
};

Gpu g;
HWND g_host = nullptr;
HWND g_hwnd = nullptr;
int g_w = 0, g_h = 0;

std::mutex g_mu;
double g_sx = 1.0, g_sy = 1.0, g_ox = 0.0, g_oy = 0.0;
double g_upMs = 0.0, g_prMs = 0.0;
int g_frames = 0;

struct CbData {
  float sx, sy, ox, oy;      // dest-normalised -> source-normalised
  float tw, th, ss, pad;
  float bgr, bgg, bgb, bga;
};
static_assert(sizeof(CbData) == 48, "cbuffer packing");
CbData g_cbData = {1, 1, 0, 0, 1, 1, 1, 0, 0.03137f, 0.03529f, 0.04314f, 1.0f};

const char* kHLSL =
    "Texture2D tex0 : register(t0);\n"
    "SamplerState samp0 : register(s0);\n"
    "cbuffer U : register(b0) {\n"
    "  float4 xf;   // sx, sy, ox, oy\n"
    "  float4 tex;  // texW, texH, ss, unused\n"
    "  float4 bg;\n"
    "};\n"
    "struct V { float4 p : SV_POSITION; float2 uv : TEXCOORD0; };\n"
    "V vsmain(uint id : SV_VertexID) {\n"
    "  float2 q = float2((float)((id << 1) & 2), (float)(id & 2));\n"
    "  V o; o.p = float4(q * 2.0f - 1.0f, 0.0f, 1.0f);\n"
    "  o.uv = float2(q.x, 1.0f - q.y); return o;\n"
    "}\n"
    "float4 psmain(V i) : SV_TARGET {\n"
    "  float2 uv = float2(xf.x * i.uv.x + xf.z, xf.y * i.uv.y + xf.w);\n"
    "  if (uv.x < 0.0f || uv.x > 1.0f || uv.y < 0.0f || uv.y > 1.0f) return bg;\n"
    "  float ss = tex.z;\n"
    "  if (ss < 1.5f) return tex0.SampleLevel(samp0, uv, 0);\n"
    "  float4 c = 0.0f;\n"
    "  int is = (int)ss;\n"
    "  for (int j = 0; j < 4; ++j) {\n"
    "    if (j >= is) break;\n"
    "    for (int k = 0; k < 4; ++k) {\n"
    "      if (k >= is) break;\n"
    "      float2 o = float2((j + 0.5f - 0.5f * ss) / tex.x,\n"
    "                        (k + 0.5f - 0.5f * ss) / tex.y);\n"
    "      c += tex0.SampleLevel(samp0, uv + o, 0);\n"
    "    }\n"
    "  }\n"
    "  return c / (ss * ss);\n"
    "}\n";

void Log(const char* fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  OutputDebugStringA(buf);
  OutputDebugStringA("\n");
  // The shell keeps its own log; mirror the important lines there via a hook
  // the host installs (see host.cpp: nc::SetLogHook is deliberately avoided;
  // the host logs the same numbers from PostFrame).
}

// Crash-localisation trace for the native canvas bring-up (MB_NC_LOG=1).
void NcLog(const char* s) {
  if (!std::getenv("MB_NC_LOG")) return;
  wchar_t dir[MAX_PATH] = {0};
  if (!GetEnvironmentVariableW(L"LOCALAPPDATA", dir, MAX_PATH)) return;
  std::wstring path = std::wstring(dir) + L"\\MandelbrotView\\nc.log";
  CreateDirectoryW((std::wstring(dir) + L"\\MandelbrotView").c_str(), nullptr);
  FILE* f = _wfopen(path.c_str(), L"ab");
  if (!f) return;
  SYSTEMTIME st{};
  GetLocalTime(&st);
  fprintf(f, "%02d:%02d:%02d %s\n", st.wHour, st.wMinute, st.wSecond, s);
  fclose(f);
}

double NowMs() {
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

void ReleaseTex(Tex& t) {
  if (t.srv) { t.srv->Release(); t.srv = nullptr; }
  if (t.tex) { t.tex->Release(); t.tex = nullptr; }
  t.w = t.h = 0;
}

// Common state for every full-window draw (the target and viewport differ only
// when the swapchain has not been created yet, which the callers exclude).
void SetupDraw() {
  D3D11_VIEWPORT vp = {0, 0, (float)g_w, (float)g_h, 0, 1};
  g.ctx->OMSetRenderTargets(1, &g.rtv, nullptr);
  g.ctx->RSSetViewports(1, &vp);
  g.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  g.ctx->VSSetShader(g.vs, nullptr, 0);
  g.ctx->PSSetShader(g.ps, nullptr, 0);
  g.ctx->PSSetConstantBuffers(0, 1, &g.cb);
  g.ctx->PSSetSamplers(0, 1, &g.sm);
  g.ctx->RSSetState(g.rs);
}

void DrawQuad(const Tex& t, float sx, float sy, float ox, float oy, float ss) {
  CbData cb = g_cbData;
  cb.sx = sx; cb.sy = sy; cb.ox = ox; cb.oy = oy;
  cb.tw = (float)t.w; cb.th = (float)t.h;
  cb.ss = ss;
  g.ctx->UpdateSubresource(g.cb, 0, nullptr, &cb, 0, 0);
  g.ctx->PSSetShaderResources(0, 1, &t.srv);
  g.ctx->Draw(3, 0);
}

void ClearToBg() {
  float bg[4] = {0.03137f, 0.03529f, 0.04314f, 1.0f};
  g.ctx->ClearRenderTargetView(g.rtv, bg);
}

/* Redraw whatever the canvas already owns (last committed pass, or the
 * background) at the *current* window size.
 *
 * A bitblt swapchain (SWAP_EFFECT_DISCARD) only paints the window DC in
 * Present().  Any invalidation — WM_PAINT, a resize, the WebView2 sibling
 * being re-composited, a DPI change — therefore leaves the client area
 * undefined until the *next* Present, which for a static view never comes:
 * that is what showed up as a black canvas on the real machine.  Re-presenting
 * on every invalidation keeps the window a pure function of the last pass. */
void RepaintNow() {
  if (!g.ready || !g.rtv) return;
  std::lock_guard<std::mutex> lk(g_mu);
  SetupDraw();
  if (g.display >= 0 && g.slots[g.display].srv) {
    DrawQuad(g.slots[g.display], (float)g_sx, (float)g_sy, (float)g_ox, (float)g_oy,
             (float)g.displaySS);
  } else {
    ClearToBg();
  }
  g.sc->Present(1, 0);
}

bool EnsureTex(Tex& t, int w, int h) {
  if (t.tex && t.w == w && t.h == h) return true;
  ReleaseTex(t);
  D3D11_TEXTURE2D_DESC td = {};
  td.Width = (UINT)w;
  td.Height = (UINT)h;
  td.MipLevels = 1;
  td.ArraySize = 1;
  td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  td.SampleDesc.Count = 1;
  td.Usage = D3D11_USAGE_DEFAULT;
  td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  if (FAILED(g.dev->CreateTexture2D(&td, nullptr, &t.tex) || !t.tex)) return false;
  D3D11_SHADER_RESOURCE_VIEW_DESC sd = {};
  sd.Format = td.Format;
  sd.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
  sd.Texture2D.MipLevels = 1;
  if (FAILED(g.dev->CreateShaderResourceView(t.tex, &sd, &t.srv) || !t.srv)) return false;
  t.w = w;
  t.h = h;
  return true;
}

LRESULT CALLBACK CanvasProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT ps;
      BeginPaint(hwnd, &ps);
      EndPaint(hwnd, &ps);
      // The bitblt swapchain owns the pixels: an invalidation does not restore
      // them by itself, so re-present the last pass (see RepaintNow).
      RepaintNow();
      return 0;
    }
    case WM_SIZE:
      // The swapchain is resized by SetBounds (which owns g_w/g_h); a bare
      // MoveWindow must not desynchronise those from the actual buffers.
      return 0;
    case WM_LBUTTONDOWN:
      SetFocus(hwnd);
      return 0;
    case WM_MOUSEWHEEL:
      // Standard Win32 input: in the shipping overlay the WebView2 panel sees
      // the gesture first, but the canvas still owns this path when it is the
      // deepest window under the cursor.
      if (g_host) PostMessageW(g_host, WM_APP + 6, wp, lp);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

bool CreateSwapchain() {
  NcLog("swapchain-start");
  IDXGIDevice* dxdev = nullptr;
  if (FAILED(g.dev->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxdev) || !dxdev)) return false;
  IDXGIAdapter* adapter = nullptr;
  dxdev->GetAdapter(&adapter);
  IDXGIFactory2* factory = nullptr;
  if (adapter) adapter->GetParent(__uuidof(IDXGIFactory2), (void**)&factory);
  NcLog(factory ? "factory-ok" : "factory-null");

  RECT rc = {0, 0, 1, 1};
  GetClientRect(g_hwnd, &rc);
  DXGI_SWAP_CHAIN_DESC1 d = {};
  d.Width = (UINT)(rc.right > 0 ? rc.right : 1);
  d.Height = (UINT)(rc.bottom > 0 ? rc.bottom : 1);
  d.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  d.SampleDesc.Count = 1;
  d.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  // A flip-model chain on a child HWND is never composited by DWM (spike:
  // black window).  The bitblt model (SWAP_EFFECT_DISCARD) is the supported
  // route and measured fast enough.
  d.BufferCount = 1;
  d.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  d.Scaling = DXGI_SCALING_STRETCH;
  d.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
  HRESULT hr = factory ? factory->CreateSwapChainForHwnd(g.dev, g_hwnd, &d, nullptr, nullptr, &g.sc)
                       : E_FAIL;
  if (factory) factory->Release();
  if (adapter) adapter->Release();
  dxdev->Release();
  if (FAILED(hr) || !g.sc) return false;

  IDXGISwapChain2* sc2 = nullptr;
  if (SUCCEEDED(g.sc->QueryInterface(__uuidof(IDXGISwapChain2), (void**)&sc2)) && sc2) {
    sc2->SetMaximumFrameLatency(1);
    sc2->Release();
  }
  ID3D11Texture2D* bb = nullptr;
  if (FAILED(g.sc->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb) || !bb)) return false;
  g.dev->CreateRenderTargetView(bb, nullptr, &g.rtv);
  bb->Release();
  g_w = (int)d.Width;
  g_h = (int)d.Height;
  return true;
}

bool CreateDevice() {
  D3D_FEATURE_LEVEL fl = {};
  const D3D_FEATURE_LEVEL want[] = {D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1};
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, want, 2,
                                 D3D11_SDK_VERSION, &g.dev, &fl, &g.ctx);
  NcLog("device");
  if (FAILED(hr)) return false;

  ID3DBlob* blob = nullptr;
  ID3DBlob* err = nullptr;
  HRESULT hrv = D3DCompile(kHLSL, strlen(kHLSL), nullptr, nullptr, nullptr, "vsmain", "vs_4_0",
                           0, 0, &blob, &err);
  NcLog(("vs compile hr=" + std::to_string((int)hrv)).c_str());
  if (FAILED(hrv) || !blob) return false;
  g.dev->CreateVertexShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &g.vs);
  blob->Release();
  err = nullptr;
  HRESULT hrp = D3DCompile(kHLSL, strlen(kHLSL), nullptr, nullptr, nullptr, "psmain", "ps_4_0",
                           0, 0, &blob, &err);
  NcLog(("ps compile hr=" + std::to_string((int)hrp)).c_str());
  if (FAILED(hrp) || !blob) return false;
  g.dev->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &g.ps);
  blob->Release();

  D3D11_RASTERIZER_DESC rd = {};
  rd.FillMode = D3D11_FILL_SOLID;
  rd.CullMode = D3D11_CULL_NONE;
  g.dev->CreateRasterizerState(&rd, &g.rs);

  D3D11_SAMPLER_DESC sd = {};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  g.dev->CreateSamplerState(&sd, &g.sm);

  D3D11_BUFFER_DESC bd = {};
  bd.ByteWidth = sizeof(CbData);
  bd.Usage = D3D11_USAGE_DEFAULT;
  bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  g.dev->CreateBuffer(&bd, nullptr, &g.cb);

  return g.vs && g.ps && g.rs && g.sm && g.cb;
}

void ResizeSwapchain(int w, int h) {
  if (!g.sc || w <= 0 || h <= 0) return;
  if (w == g_w && h == g_h && g.rtv) return;
  if (g.rtv) { g.rtv->Release(); g.rtv = nullptr; }
  if (SUCCEEDED(g.sc->ResizeBuffers(0, (UINT)w, (UINT)h, DXGI_FORMAT_UNKNOWN, 0))) {
    ID3D11Texture2D* bb = nullptr;
    if (SUCCEEDED(g.sc->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb)) && bb) {
      g.dev->CreateRenderTargetView(bb, nullptr, &g.rtv);
      bb->Release();
    }
  }
  g_w = w;
  g_h = h;
}

}  // namespace

namespace nc {

bool Init(HWND host) {
  NcLog("init-start");
  g_host = host;
  WNDCLASSEXW cc = {};
  cc.cbSize = sizeof(cc);
  cc.lpfnWndProc = CanvasProc;
  cc.hInstance = GetModuleHandleW(nullptr);
  cc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  cc.lpszClassName = L"MandCanvas";
  cc.style = CS_HREDRAW | CS_VREDRAW;
  RegisterClassExW(&cc);

  RECT rc;
  GetClientRect(host, &rc);
  g_hwnd = CreateWindowExW(0, L"MandCanvas", L"", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                           0, 0, rc.right > 0 ? rc.right : 1, rc.bottom > 0 ? rc.bottom : 1,
                           host, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!g_hwnd) return false;
  NcLog("window");
  SetWindowPos(g_hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

  if (!CreateDevice()) {
    DestroyWindow(g_hwnd);
    g_hwnd = nullptr;
    return false;
  }
  NcLog("device-ok");
  if (!CreateSwapchain()) {
    NcLog("swapchain-fail");
    DestroyWindow(g_hwnd);
    g_hwnd = nullptr;
    return false;
  }
  NcLog("swapchain-ok");
  // Paint the background once so a slow first render never shows garbage.
  D3D11_VIEWPORT vp = {0, 0, (float)g_w, (float)g_h, 0, 1};
  g.ctx->OMSetRenderTargets(1, &g.rtv, nullptr);
  g.ctx->RSSetViewports(1, &vp);
  float bg[4] = {0.03137f, 0.03529f, 0.04314f, 1.0f};
  g.ctx->ClearRenderTargetView(g.rtv, bg);
  g.sc->Present(1, 0);
  g.ready = true;
  NcLog("init-ok");
  return true;
}

bool Ready() { return g.ready; }

HWND Hwnd() { return g_hwnd; }

void SetBounds(int x, int y, int w, int h) {
  if (!g_hwnd) return;
  MoveWindow(g_hwnd, x, y, w, h, TRUE);
  if (!g.ready) return;
  ResizeSwapchain(w, h);
  // ResizeBuffers replaces the back buffer with an undefined one and does not
  // paint the newly exposed area.  Presenting the last pass here (identity
  // transform, stretched to the new window) is what the WM_SIZE comment in
  // host.cpp promises: the frame follows the window without a re-render.
  RepaintNow();
}

void BeginPass(int passW, int passH, int ss, int cw, int ch) {
  if (!g.ready || passW <= 0 || passH <= 0) return;
  std::lock_guard<std::mutex> lk(g_mu);
  const int slot = g.display < 0 ? 0 : 1 - g.display;
  if (!EnsureTex(g.slots[slot], passW, passH)) {
    Log("EnsureTex failed %dx%d", passW, passH);
    return;
  }
  if (ss < 1) ss = 1;
  if (ss > 4) ss = 4;
  g.pendingSS = ss;
  (void)cw;
  (void)ch;
}

void UploadTile(const uint8_t* frame, int frameW, int frameH,
                int x, int y, int w, int h) {
  if (!g.ready || !frame) return;
  std::lock_guard<std::mutex> lk(g_mu);
  const int slot = g.display < 0 ? 0 : 1 - g.display;
  Tex& t = g.slots[slot];
  if (!t.tex || x < 0 || y < 0 || x + w > t.w || y + h > t.h) return;
  if (x + w > frameW || y + h > frameH) return;
  D3D11_BOX box = {(UINT)x, (UINT)y, 0, (UINT)(x + w), (UINT)(y + h), 1};
  const uint8_t* src = frame + ((size_t)y * (size_t)frameW + (size_t)x) * 4;
  const double t0 = NowMs();
  g.ctx->UpdateSubresource(t.tex, 0, &box, src, (UINT)frameW * 4, 0);
  g_upMs = NowMs() - t0;
}

void ResetPreview() {
  std::lock_guard<std::mutex> lk(g_mu);
  g_sx = g_sy = 1.0;
  g_ox = g_oy = 0.0;
}

bool CommitPass() {
  if (!g.ready) return false;
  std::lock_guard<std::mutex> lk(g_mu);
  const int slot = g.display < 0 ? 0 : 1 - g.display;
  if (!g.slots[slot].tex) return false;
  g.display = slot;
  g.displaySS = g.pendingSS;
  g_sx = g_sy = 1.0;
  g_ox = g_oy = 0.0;
  ++g_frames;
  // Present with the lock held: Preview() also presents and must never
  // interleave with a slot swap.
  const double t0 = NowMs();
  SetupDraw();
  DrawQuad(g.slots[slot], 1.0f, 1.0f, 0.0f, 0.0f, (float)g.pendingSS);
  g.sc->Present(1, 0);
  g_prMs = NowMs() - t0;
  return true;
}

bool CommitPassWithPreview(double sx, double ox, double sy, double oy) {
  if (!g.ready) return false;
  std::lock_guard<std::mutex> lk(g_mu);
  const int slot = g.display < 0 ? 0 : 1 - g.display;
  if (!g.slots[slot].tex) return false;
  g.display = slot;
  g.displaySS = g.pendingSS;
  /* The new texture depicts the view as of the moment the pass STARTED.
   * Carry the gesture accumulated since then so the very first Present after
   * the commit already matches the CURRENT view.  Preview() keeps composing
   * on top of this base until the next commit. */
  g_sx = sx; g_ox = ox;
  g_sy = sy; g_oy = oy;
  ++g_frames;
  const double t0 = NowMs();
  SetupDraw();
  DrawQuad(g.slots[slot], (float)g_sx, (float)g_sy, (float)g_ox, (float)g_oy,
           (float)g.displaySS);
  g.sc->Present(1, 0);
  g_prMs = NowMs() - t0;
  return true;
}

void Preview(double scale, double dx, double dy, double cx, double cy) {
  if (!g.ready || g.display < 0 || scale <= 0) return;
  std::lock_guard<std::mutex> lk(g_mu);
  // Mirrors blitSnapshot: dest = c + scale*(src - c) + d, therefore
  // src = (dest - d - c)/scale + c.
  const double inv = 1.0 / scale;
  const double nsx = inv, nox = cx * (1.0 - inv) - dx * inv;
  const double nsy = inv, noy = cy * (1.0 - inv) - dy * inv;
  const double sxo = g_sx, oxo = g_ox;
  const double syo = g_sy, oyo = g_oy;
  g_sx = sxo * nsx;
  g_ox = sxo * nox + oxo;
  g_sy = syo * nsy;
  g_oy = syo * noy + oyo;

  SetupDraw();
  // Gesture feedback keeps the display pass's own reduction factor: the
  // texture is supersampled when the final pass is on screen.
  DrawQuad(g.slots[g.display], (float)g_sx, (float)g_sy, (float)g_ox, (float)g_oy,
           (float)g.displaySS);
  g.sc->Present(1, 0);
}

void SetPreview(double sx, double ox, double sy, double oy) {
  if (!g.ready || g.display < 0) return;
  std::lock_guard<std::mutex> lk(g_mu);
  g_sx = sx; g_ox = ox;
  g_sy = sy; g_oy = oy;
  SetupDraw();
  DrawQuad(g.slots[g.display], (float)g_sx, (float)g_sy, (float)g_ox, (float)g_oy,
           (float)g.displaySS);
  g.sc->Present(1, 0);
}

void Present() {
  if (!g.ready || !g.rtv) return;
  std::lock_guard<std::mutex> lk(g_mu);
  SetupDraw();
  ClearToBg();
  g.sc->Present(1, 0);
}

void Shutdown() {
  if (!g.ready && !g_hwnd) return;
  g.ready = false;
  std::lock_guard<std::mutex> lk(g_mu);
  for (int i = 0; i < 2; ++i) ReleaseTex(g.slots[i]);
  if (g.rtv) { g.rtv->Release(); g.rtv = nullptr; }
  if (g.sc) { g.sc->Release(); g.sc = nullptr; }
  if (g.cb) { g.cb->Release(); g.cb = nullptr; }
  if (g.sm) { g.sm->Release(); g.sm = nullptr; }
  if (g.rs) { g.rs->Release(); g.rs = nullptr; }
  if (g.ps) { g.ps->Release(); g.ps = nullptr; }
  if (g.vs) { g.vs->Release(); g.vs = nullptr; }
  if (g.ctx) { g.ctx->Release(); g.ctx = nullptr; }
  if (g.dev) { g.dev->Release(); g.dev = nullptr; }
  if (g_hwnd) { DestroyWindow(g_hwnd); g_hwnd = nullptr; }
  g.display = -1;
}

double LastUploadMs() { return g_upMs; }
double LastPresentMs() { return g_prMs; }
int FrameCount() { return g_frames; }

}  // namespace nc
