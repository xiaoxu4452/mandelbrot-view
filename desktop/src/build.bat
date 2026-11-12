@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Desktop build.  One renderer (core\mb_*.cpp: orbit/kernels/palette/engine),
rem one shell (Win32 + WebView2), one UI snapshot bundled into the exe.
rem Output: ..\Mandelbrot View.exe
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
set "OUT=%~dp0..\Mandelbrot View.exe"

call "%SRC%env-msvc.bat" || exit /b 1
set "WV=%SRC%third_party\webview2"

if not exist "%SRC%third_party\webview2\include\WebView2.h" (
  echo [build] WebView2 SDK missing under third_party\webview2
  exit /b 1
)

echo [build] bundling the desktop UI snapshot...
node "%SRC%tools\gen-ui-resources.mjs" || exit /b 1
echo [build] generating the preset library...
node "%SRC%tools\gen-presets.mjs" || exit /b 1
rem The other-set / studio libraries are probe-validated (each candidate
rem is rendered before it is kept), which costs ~30s.  Regenerate only
rem when the file is missing or the generator is newer than it.
if not exist "%SRC%ui\js\sets-data.js" node "%SRC%tools\gen-sets.mjs" || exit /b 1

if not exist "%SRC%build" mkdir "%SRC%build"
echo [build] compiling icon resource...
rc /nologo /fo "%SRC%build\app.res" "%SRC%shell\app.rc" || exit /b 1

echo [build] compiling...
rem The GPU halves link against the vendored Khronos headers, musl libm and
rem lcms2 (see third_party\).  OpenCL is delay-loaded so a machine without an
rem ICD still starts; the canvas then reports "no device" and the CPU engine
rem renders exactly as before.
set "KH=%SRC%third_party\khronos"
set "MUSL=%SRC%third_party\musl"
set "LCMS=%SRC%third_party\lcms2"
cl /nologo /O2 /Oi /Ot /Ob3 /GL /Gy /MT /EHsc /std:c++17 /utf-8 /DNDEBUG /arch:AVX2 /openmp ^
  /DNOMINMAX ^
  /I "%SRC%core" /I "%SRC%shell" /I "%SRC%gpu" /I "%WV%\include" ^
  /I "%KH%" /I "%LCMS%\include" ^
  /Fo"%SRC%build\\" ^
  "%SRC%shell\host.cpp" ^
  "%SRC%shell\native_canvas.cpp" ^
  "%SRC%shell\ui_resources.cpp" ^
  "%SRC%core\mb_orbit.cpp" ^
  "%SRC%core\mb_kernels.cpp" ^
  "%SRC%core\mb_palette.cpp" ^
  "%SRC%core\mb_engine.cpp" ^
  "%SRC%core\mb_precision.cpp" ^
  "%SRC%core\mb_mpf.cpp" ^
  "%SRC%core\mb_hf.cpp" ^
  "%SRC%gpu\cl_api.cpp" ^
  "%SRC%gpu\cl_field.cpp" ^
  "%SRC%gpu\gl_api.cpp" ^
  "%SRC%gpu\gl_canvas.cpp" ^
  "%SRC%gpu\gpu_render.cpp" ^
  "%SRC%gpu\mb_math.cpp" ^
  "%SRC%gpu\mb_color.cpp" ^
  "%SRC%build\app.res" ^
  /Fe"%OUT%" ^
  /link /SUBSYSTEM:WINDOWS /ENTRY:wWinMainCRTStartup /MANIFEST:NO /LTCG /OPT:REF /OPT:ICF ^
  /LIBPATH:"%WV%\x64" /LIBPATH:"%KH%\lib\x64" ^
  WebView2LoaderStatic.lib "%MUSL%\lib\mb_libm.lib" "%LCMS%\lib\lcms2.lib" ^
  OpenCL.lib delayimp.lib opengl32.lib ^
  dwmapi.lib shlwapi.lib shell32.lib ole32.lib uuid.lib user32.lib gdi32.lib advapi32.lib ^
  d3d11.lib dxgi.lib d3dcompiler.lib windowscodecs.lib ^
  /DELAYLOAD:OpenCL.dll
if errorlevel 1 (
  echo [build] FAILED
  exit /b 1
)

echo [build] OK: "%OUT%"
endlocal
