@echo off
setlocal enabledelayedexpansion
rem ---------------------------------------------------------------------------
rem Rebuild third_party/musl/lib/mb_libm.lib from the checked-in upstream
rem sources.  zig's clang emits COFF objects; MSVC links them directly.
rem Every path is quoted because the project lives in "D:\mandelbrot view".
rem Set MB_ZIG if zig is not at the default location.
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
set "MUSL=%SRC%third_party\musl"
set "OBJ=%SRC%build\musl"
if "%MB_ZIG%"=="" set "MB_ZIG=D:\git\zig-x86_64-windows-0.17.0-dev.1756+613c03321\zig.exe"
if not exist "%MB_ZIG%" (
  echo [musl] zig not found: %MB_ZIG%
  exit /b 1
)
if not exist "%OBJ%" mkdir "%OBJ%"
if not exist "%MUSL%\lib" mkdir "%MUSL%\lib"

set N=0
for %%f in ("%MUSL%\src\math\*.c") do (
  "%MB_ZIG%" cc -target x86_64-windows-gnu -O2 -c "%%f" -o "%OBJ%\%%~nf.o" ^
    -include "%MUSL%\compat\prefix.h" ^
    -I "%MUSL%\compat" -I "%MUSL%\src\internal" ^
    -I "%MUSL%\src\math" -I "%MUSL%\arch\generic" -I "%MUSL%\arch\x86_64" || (
    echo [musl] FAILED on %%~nf.c
    exit /b 1
  )
  set /a N+=1
)
"%MB_ZIG%" cc -target x86_64-windows-gnu -O2 -c "%MUSL%\compat\musl_platform.c" -o "%OBJ%\musl_platform.o" ^
  -include "%MUSL%\compat\prefix.h" -I "%MUSL%\compat" -I "%MUSL%\arch\generic" -I "%MUSL%\arch\x86_64" || exit /b 1

set OBJS=
for %%o in ("%OBJ%\*.o") do set OBJS=!OBJS! "%%o"
"%MB_ZIG%" ar rcs "%MUSL%\lib\mb_libm.lib" %OBJS% || exit /b 1
echo [musl] OK: %N% upstream sources -^> "%MUSL%\lib\mb_libm.lib"

set "MIRROR=%SRC%..\..\desktop\src\third_party\musl\lib"
if not exist "%MIRROR%" mkdir "%MIRROR%"
copy /Y "%MUSL%\lib\mb_libm.lib" "%MIRROR%\mb_libm.lib" >nul
echo [musl] mirror synced
endlocal
