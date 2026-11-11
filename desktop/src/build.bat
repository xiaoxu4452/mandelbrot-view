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
cl /nologo /O2 /Oi /Ot /Ob3 /GL /Gy /MT /EHsc /std:c++17 /utf-8 /DNDEBUG /arch:AVX2 ^
  /I "%SRC%core" /I "%SRC%shell" /I "%WV%\include" ^
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
  "%SRC%build\app.res" ^
  /Fe"%OUT%" ^
  /link /SUBSYSTEM:WINDOWS /ENTRY:wWinMainCRTStartup /MANIFEST:NO /LTCG /OPT:REF /OPT:ICF ^
  /LIBPATH:"%WV%\x64" WebView2LoaderStatic.lib dwmapi.lib shlwapi.lib shell32.lib ole32.lib uuid.lib user32.lib gdi32.lib advapi32.lib d3d11.lib dxgi.lib d3dcompiler.lib windowscodecs.lib
if errorlevel 1 (
  echo [build] FAILED
  exit /b 1
)

echo [build] OK: "%OUT%"
endlocal
