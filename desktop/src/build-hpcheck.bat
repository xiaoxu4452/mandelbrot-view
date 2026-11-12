@echo off
setlocal
rem ---------------------------------------------------------------------------
rem High-precision regression: Boost.Multiprecision vs the core's Mpf.
rem Boost is header-only here; no GMP/MPFR runtime is linked.
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
if not exist "%SRC%build" mkdir "%SRC%build"
cl /nologo /O2 /MT /EHsc /std:c++17 /utf-8 /DNDEBUG /arch:AVX2 ^
  /I "%SRC%gpu" /I "%SRC%core" /I "%SRC%third_party" ^
  /Fo"%SRC%build\\" ^
  "%SRC%gpu\mb_hpcheck.cpp" "%SRC%gpu\mb_hp.cpp" ^
  "%SRC%core\mb_mpf.cpp" "%SRC%core\mb_hf.cpp" "%SRC%core\mb_precision.cpp" ^
  /Fe"%SRC%bin\mb_hpcheck.exe" ^
  /link /SUBSYSTEM:CONSOLE
if errorlevel 1 (
  echo [hpcheck] BUILD FAILED
  exit /b 1
)
echo [hpcheck] OK
endlocal
