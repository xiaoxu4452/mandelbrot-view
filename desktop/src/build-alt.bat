@echo off
setlocal enabledelayedexpansion
rem ---------------------------------------------------------------------------
rem Desktop build ? everything it needs lives in this folder.
rem   core\    native renderer (mb_core / mb_precision)
rem   shell\   Win32 + WebView2 host, icon, generated ui_resources
rem   ui\      desktop UI snapshot (index.html, css, js)
rem   tools\   UI bundler
rem   third_party\webview2\  SDK headers + static loader lib
rem
rem Needs: MSVC x64 (VS 2022/2026), Node.js, WebView2 Evergreen runtime.
rem Output: ..\Mandelbrot View.exe  (single self-contained exe)
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
set "OUT=%~dp0..\Mandelbrot View.shade.exe"

rem Locate vcvars64: honour VCVARS if set, else vswhere, else the usual path.
if not defined VCVARS (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VS=%%i"
  if defined VS if exist "!VS!\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=!VS!\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS (
  echo [build] vcvars64.bat not found. Set VCVARS to its full path.
  exit /b 1
)

if not exist "%SRC%third_party\webview2\include\WebView2.h" (
  echo [build] WebView2 SDK missing under third_party\webview2
  exit /b 1
)

call "%VCVARS%" >nul || exit /b 1
set "WV=%SRC%third_party\webview2"

echo [build] bundling the desktop UI snapshot...
node "%SRC%tools\gen-ui-resources.mjs" || exit /b 1

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
  "%SRC%core\mb_core.cpp" ^
  "%SRC%core\mb_canvas.cpp" ^
  "%SRC%core\mb_color.cpp" ^
  "%SRC%core\mb_hp.cpp" ^
  "%SRC%core\mb_precision.cpp" ^
  "%SRC%build\app.res" ^
  /Fe"%OUT%" ^
  /link /SUBSYSTEM:WINDOWS /ENTRY:wWinMainCRTStartup /MANIFEST:NO /LTCG /OPT:REF /OPT:ICF ^
  /LIBPATH:"%WV%\x64" WebView2LoaderStatic.lib dwmapi.lib shlwapi.lib ole32.lib uuid.lib user32.lib gdi32.lib advapi32.lib d3d11.lib dxgi.lib d3dcompiler.lib windowscodecs.lib
if errorlevel 1 (
  echo [build] FAILED
  exit /b 1
)

echo [build] OK: "%OUT%"
endlocal

