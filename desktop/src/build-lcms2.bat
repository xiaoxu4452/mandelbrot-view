@echo off
setlocal enabledelayedexpansion
set "SRC=%~dp0"
set "L=%SRC%third_party\lcms2"
set "OBJ=%SRC%build\lcms2"
if "%MB_ZIG%"=="" set "MB_ZIG=D:/git/zig-x86_64-windows-0.17.0-dev.1756+613c03321/zig.exe"
if not exist "%OBJ%" mkdir "%OBJ%"
for %%f in ("%L%\src\*.c") do (
  "%MB_ZIG%" cc -target x86_64-windows-gnu -O2 -c "%%f" -o "%OBJ%\%%~nf.o" -I "%L%\include" -I "%L%\src" -DCMS_NO_REGISTER_KEYWORD || exit /b 1
)
set OBJS=
for %%o in ("%OBJ%\*.o") do set OBJS=!OBJS! "%%o"
"%MB_ZIG%" ar rcs "%SRC%third_party\lcms2\lib\lcms2.lib" %OBJS% || exit /b 1
echo [lcms2] OK
if not exist "%SRC%..\..\desktop\src\third_party\lcms2\lib" mkdir "%SRC%..\..\desktop\src\third_party\lcms2\lib"
copy /Y "%SRC%third_party\lcms2\lib\lcms2.lib" "%SRC%..\..\desktop\src\third_party\lcms2\lib\lcms2.lib" >nul
endlocal
