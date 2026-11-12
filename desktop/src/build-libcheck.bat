@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Numerical regression for the GPU libraries.  Links the prefixed musl libm
rem static library; no Boost/GMP/MPFR runtime is required for this target.
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
set "MUSL=%SRC%third_party\musl"
if not exist "%MUSL%\lib\mb_libm.lib" (
  echo [libcheck] build-musl-libm.bat first
  exit /b 1
)
if not exist "%SRC%build" mkdir "%SRC%build"
cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /DNDEBUG /arch:AVX2 ^
  /I "%SRC%gpu" /I "%SRC%third_party\khronos" /I "%SRC%third_party\lcms2\include" ^
  /Fo"%SRC%build\\" ^
  "%SRC%gpu\mb_libcheck.cpp" "%SRC%gpu\mb_math.cpp" "%SRC%gpu\mb_color.cpp" "%SRC%gpu\gl_api.cpp" ^
  /Fe"%SRC%bin\mb_libcheck.exe" ^
  /link /SUBSYSTEM:CONSOLE "%MUSL%\lib\mb_libm.lib" "%SRC%third_party\lcms2\lib\lcms2.lib" opengl32.lib user32.lib gdi32.lib
if errorlevel 1 (
  echo [libcheck] BUILD FAILED
  exit /b 1
)
echo [libcheck] OK
endlocal
