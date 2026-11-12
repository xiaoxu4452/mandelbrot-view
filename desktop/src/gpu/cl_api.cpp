// ---------------------------------------------------------------------------
// cl_api.cpp — capability probe over the official Khronos API.
// ---------------------------------------------------------------------------
#include "cl_api.h"

#include <windows.h>

#include <algorithm>
#include <cstring>

namespace ocl {
namespace {

Caps g_caps;
std::string g_error;
bool g_tried = false;

std::vector<std::string> splitExt(const std::string& s) {
  std::vector<std::string> out;
  size_t a = 0;
  while (a < s.size()) {
    const size_t b = s.find(' ', a);
    const std::string t = s.substr(a, b == std::string::npos ? b : b - a);
    if (!t.empty()) out.push_back(t);
    if (b == std::string::npos) break;
    a = b + 1;
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

template <typename T>
T info(void* obj, cl_uint param, bool device, cl_int* rcOut = nullptr) {
  T v{};
  size_t n = 0;
  const cl_int rc = device ? clGetDeviceInfo(static_cast<cl_device_id>(obj), param,
                                            sizeof(T), &v, &n)
                           : clGetPlatformInfo(static_cast<cl_platform_id>(obj), param,
                                               sizeof(T), &v, &n);
  if (rcOut) *rcOut = rc;
  if (rc != CL_SUCCESS) return T{};
  return v;
}

std::string strInfo(void* obj, cl_uint param, bool device) {
  char buf[16384] = {};
  size_t n = 0;
  const cl_int rc = device ? clGetDeviceInfo(static_cast<cl_device_id>(obj), param,
                                             sizeof(buf), buf, &n)
                           : clGetPlatformInfo(static_cast<cl_platform_id>(obj), param,
                                               sizeof(buf), buf, &n);
  if (rc != CL_SUCCESS) return {};
  size_t len = 0;
  while (len < sizeof(buf) && buf[len]) ++len;
  return std::string(buf, len);
}

void probe() {
  g_caps = Caps{};
  g_error.clear();

  // /DELAYLOAD means the first cl* call would raise if the ICD is missing.
  // LoadLibrary is the guard: no exception, no dialog, just "unavailable".
  HMODULE icd = ::LoadLibraryW(L"OpenCL.dll");
  if (!icd) {
    g_error = "OpenCL.dll is not installed (no ICD)";
    return;
  }

  cl_uint np = 0;
  cl_int rc = clGetPlatformIDs(0, nullptr, &np);
  if (rc != CL_SUCCESS || np == 0) {
    g_error = "no OpenCL platform (clGetPlatformIDs rc=" + std::to_string(rc) + ")";
    return;
  }
  std::vector<cl_platform_id> ps(np);
  if (clGetPlatformIDs(np, ps.data(), nullptr) != CL_SUCCESS) return;

  // Pick the first GPU that has fp64.  On an APU the integrated GPU shares
  // memory with the CPU, which is also the best CL/GL-sharing candidate.
  cl_platform_id chosen = nullptr;
  cl_device_id dev = nullptr;
  for (cl_platform_id p : ps) {
    cl_uint nd = 0;
    if (clGetDeviceIDs(p, CL_DEVICE_TYPE_GPU, 0, nullptr, &nd) != CL_SUCCESS || !nd)
      continue;
    std::vector<cl_device_id> ds(nd);
    if (clGetDeviceIDs(p, CL_DEVICE_TYPE_GPU, nd, ds.data(), nullptr) != CL_SUCCESS)
      continue;
    for (cl_device_id d : ds) {
      const auto ext = splitExt(strInfo(d, CL_DEVICE_EXTENSIONS, true));
      if (std::find(ext.begin(), ext.end(), "cl_khr_fp64") == ext.end()) continue;
      chosen = p;
      dev = d;
      break;
    }
    if (dev) break;
  }
  if (!dev) {
    g_error = "no GPU device with cl_khr_fp64";
    return;
  }

  Caps& c = g_caps;
  c.ok = true;
  c.fp64 = true;
  c.platformId = chosen;
  c.deviceId = dev;
  c.platform = strInfo(chosen, CL_PLATFORM_NAME, false);
  c.platformVersion = strInfo(chosen, CL_PLATFORM_VERSION, false);
  c.platformVendor = strInfo(chosen, CL_PLATFORM_VENDOR, false);
  c.device = strInfo(dev, CL_DEVICE_NAME, true);
  c.deviceVersion = strInfo(dev, CL_DEVICE_VERSION, true);
  c.driverVersion = strInfo(dev, CL_DRIVER_VERSION, true);
  c.openclCVersion = strInfo(dev, CL_DEVICE_OPENCL_C_VERSION, true);
  c.computeUnits = info<cl_uint>(dev, CL_DEVICE_MAX_COMPUTE_UNITS, true);
  c.maxClockMHz = info<cl_uint>(dev, CL_DEVICE_MAX_CLOCK_FREQUENCY, true);
  c.maxWorkGroup = info<size_t>(dev, CL_DEVICE_MAX_WORK_GROUP_SIZE, true);
  c.maxWorkItemDim = info<cl_uint>(dev, CL_DEVICE_MAX_WORK_ITEM_DIMENSIONS, true);
  c.globalMem = info<cl_ulong>(dev, CL_DEVICE_GLOBAL_MEM_SIZE, true);
  c.localMem = info<cl_ulong>(dev, CL_DEVICE_LOCAL_MEM_SIZE, true);
  c.maxMemAlloc = info<cl_ulong>(dev, CL_DEVICE_MAX_MEM_ALLOC_SIZE, true);
  c.doubleFpConfig = info<cl_device_fp_config>(dev, CL_DEVICE_DOUBLE_FP_CONFIG, true);
  c.fp64CorrectlyRounded =
      (c.doubleFpConfig & CL_FP_CORRECTLY_ROUNDED_DIVIDE_SQRT) != 0;
  c.images = info<cl_bool>(dev, CL_DEVICE_IMAGE_SUPPORT, true) != 0;

  c.platformExtensions = splitExt(strInfo(chosen, CL_PLATFORM_EXTENSIONS, false));
  c.deviceExtensions = splitExt(strInfo(dev, CL_DEVICE_EXTENSIONS, true));
  const auto has = [&](const char* n) {
    const std::string s(n);
    return std::binary_search(c.platformExtensions.begin(), c.platformExtensions.end(), s) ||
           std::binary_search(c.deviceExtensions.begin(), c.deviceExtensions.end(), s);
  };
  c.glSharing = has("cl_khr_gl_sharing");
  c.glSharingKhr = c.glSharing;
  c.fp16 = has("cl_khr_fp16");
  c.atomics = has("cl_khr_global_int32_base_atomics");
}

void ensure() {
  if (!g_tried) {
    g_tried = true;
    probe();
  }
}

}  // namespace

bool available() {
  ensure();
  return g_caps.ok;
}
const char* lastError() {
  ensure();
  return g_error.empty() ? "ok" : g_error.c_str();
}
const Caps& capabilities() {
  ensure();
  return g_caps;
}
std::vector<std::string> platformExtensions() {
  ensure();
  return g_caps.platformExtensions;
}
std::vector<std::string> deviceExtensions() {
  ensure();
  return g_caps.deviceExtensions;
}
bool extensionSupported(const char* name) {
  ensure();
  const std::string s(name);
  const auto& p = g_caps.platformExtensions;
  const auto& d = g_caps.deviceExtensions;
  return std::binary_search(p.begin(), p.end(), s) ||
         std::binary_search(d.begin(), d.end(), s);
}

void* extensionProc(const char* name) {
  ensure();
  if (!g_caps.ok) return nullptr;
  void* p = nullptr;
  // clGetExtensionFunctionAddressForPlatform is declared by cl.h (1.2 core).
  p = reinterpret_cast<void*>(
      clGetExtensionFunctionAddressForPlatform(g_caps.platformId, name));
  if (!p) {
    HMODULE icd = ::GetModuleHandleW(L"OpenCL.dll");
    if (icd) p = reinterpret_cast<void*>(::GetProcAddress(icd, name));
  }
  return p;
}

bool glSharingReady() {
  ensure();
  if (!g_caps.glSharing) return false;
  // clCreateFromGLTexture (1.2 core) or clCreateFromGLTexture2D (KHR ext).
  // Asking the ICD, not the header: a declared prototype is always non-null
  // and would claim readiness even on a driver without the entry point.
  return extensionProc("clCreateFromGLTexture") != nullptr ||
         extensionProc("clCreateFromGLTexture2D") != nullptr;
}

std::string infoString(void* obj, cl_uint param, bool device) {
  ensure();
  return strInfo(obj, param, device);
}

}  // namespace ocl
