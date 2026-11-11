@echo off
setlocal
rem Command-line benchmark for the bundled core (no WebView2 needed).
call "%~dp0env-msvc.bat" || exit /b 1
set ROOT=%~dp0
if not exist "%ROOT%bin" mkdir "%ROOT%bin"

set CFLAGS=/nologo /O2 /Oi /Ot /Ob3 /MT /EHsc /std:c++17 /utf-8 /arch:AVX2 /W3 /DNDEBUG

cl %CFLAGS% /Fe:"%ROOT%bin\mb_bench.exe" /Fo:"%ROOT%bin\\" ^
   "%ROOT%core\mb_bench.cpp" "%ROOT%core\mb_orbit.cpp" "%ROOT%core\mb_kernels.cpp" "%ROOT%core\mb_palette.cpp" "%ROOT%core\mb_engine.cpp" "%ROOT%core\mb_precision.cpp" "%ROOT%core\mb_mpf.cpp" "%ROOT%core\mb_hf.cpp" ^
   /link /OPT:REF /OPT:ICF
if errorlevel 1 exit /b 1
echo [bench] built bin\mb_bench.exe
endlocal
