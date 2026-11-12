@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Standalone SDK / full-extension probe.  Uses the official Khronos headers
rem in third_party/khronos and the generated OpenCL import library.
rem /DELAYLOAD keeps the probe runnable on a machine with no OpenCL ICD.
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
set "KH=%SRC%third_party\khronos"
if not exist "%KH%\lib\x64\OpenCL.lib" (
  echo [caps] OpenCL.lib missing, run build-opencl-lib.bat first
  exit /b 1
)
if not exist "%SRC%build" mkdir "%SRC%build"
cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /DNDEBUG ^
  /I "%SRC%gpu" /I "%KH%" ^
  /Fo"%SRC%build\\" ^
  "%SRC%gpu\mb_caps.cpp" "%SRC%gpu\cl_api.cpp" "%SRC%gpu\gl_api.cpp" ^
  /Fe"%SRC%bin\mb_caps.exe" ^
  /link /SUBSYSTEM:CONSOLE ^
  "%KH%\lib\x64\OpenCL.lib" delayimp.lib opengl32.lib user32.lib gdi32.lib ^
  /DELAYLOAD:OpenCL.dll
if errorlevel 1 (
  echo [caps] BUILD FAILED
  exit /b 1
)
echo [caps] OK: "%SRC%bin\mb_caps.exe"
endlocal
