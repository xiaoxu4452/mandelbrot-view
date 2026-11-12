@echo off
setlocal
rem ---------------------------------------------------------------------------
rem GPU regression: the CPU core vs the OpenCL kernel, field for field.
rem Links the same core the product ships, so the comparison is against the
rem real renderer rather than a reimplementation of it.
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
if not exist "%SRC%build" mkdir "%SRC%build"
if not exist "%SRC%bin" mkdir "%SRC%bin"
set "KH=%SRC%third_party\khronos"
set "MUSL=%SRC%third_party\musl"
cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /DNDEBUG /arch:AVX2 /DNOMINMAX ^
  /I "%SRC%gpu" /I "%SRC%core" /I "%KH%" ^
  /Fo"%SRC%build\\" ^
  "%SRC%gpu\mb_gpucheck.cpp" "%SRC%gpu\cl_field.cpp" "%SRC%gpu\cl_api.cpp" ^
  "%SRC%core\mb_orbit.cpp" "%SRC%core\mb_kernels.cpp" "%SRC%core\mb_palette.cpp" ^
  "%SRC%core\mb_engine.cpp" "%SRC%core\mb_precision.cpp" "%SRC%core\mb_mpf.cpp" ^
  "%SRC%core\mb_hf.cpp" ^
  /Fe"%SRC%bin\mb_gpucheck.exe" ^
  /link /SUBSYSTEM:CONSOLE /LIBPATH:"%KH%\lib\x64" ^
  OpenCL.lib delayimp.lib /DELAYLOAD:OpenCL.dll "%MUSL%\lib\mb_libm.lib"
if errorlevel 1 (
  echo [gpucheck] BUILD FAILED
  exit /b 1
)
echo [gpucheck] OK
endlocal
