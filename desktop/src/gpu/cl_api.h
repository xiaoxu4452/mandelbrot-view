// ---------------------------------------------------------------------------
// cl_api.h — OpenCL capability layer built on the *official* Khronos headers
// (third_party/khronos/CL: cl.h, cl_ext.h, cl_gl.h, cl_icd.h, ...).
//
// The import library is generated from the system ICD by build-opencl-lib.bat
// and linked with /DELAYLOAD, so a machine without an OpenCL runtime still
// starts the program: capabilities() probes LoadLibrary first and never calls
// a cl* entry point when the DLL is absent.
// ---------------------------------------------------------------------------
#pragma once

// The Khronos headers hide pre-1.2 declarations unless the target version is
// stated.  300 keeps the full modern API visible while staying compatible with
// the AMD 2.1 ICD (which implements the 3.0 subset we use).
#ifndef CL_TARGET_OPENCL_VERSION
#define CL_TARGET_OPENCL_VERSION 300
#endif

#include <CL/cl.h>
#include <CL/cl_ext.h>
#include <CL/cl_gl.h>

#include <string>
#include <vector>

namespace ocl {

struct Caps {
  bool ok = false;
  bool fp64 = false;
  bool fp64CorrectlyRounded = false;
  bool glSharing = false;
  bool glSharingKhr = false;
  bool images = false;
  bool fp16 = false;
  bool atomics = false;
  std::string platform, platformVersion, platformVendor;
  std::string device, deviceVersion, driverVersion;
  std::string openclCVersion;
  cl_uint computeUnits = 0;
  cl_uint maxClockMHz = 0;
  cl_uint maxWorkItemDim = 0;
  size_t maxWorkGroup = 0;
  std::vector<size_t> maxWorkItemSizes;
  cl_ulong globalMem = 0, localMem = 0, maxMemAlloc = 0;
  cl_device_fp_config doubleFpConfig = 0;
  std::vector<std::string> platformExtensions;
  std::vector<std::string> deviceExtensions;
  cl_platform_id platformId = nullptr;
  cl_device_id deviceId = nullptr;
};

/** True when an fp64-capable GPU device exists.  Safe with no ICD installed. */
bool available();
const char* lastError();
const Caps& capabilities();

/** Split, sorted extension lists from the platform and the chosen device. */
std::vector<std::string> platformExtensions();
std::vector<std::string> deviceExtensions();
bool extensionSupported(const char* name);

/** Resolve any extension entry point (clGetExtensionFunctionAddressForPlatform
 *  when available, falling back to the ICD export table). */
void* extensionProc(const char* name);

/** True when CL can acquire a GL texture directly (zero-copy path). */
bool glSharingReady();

std::string infoString(void* obj, cl_uint param, bool device);

}  // namespace ocl
