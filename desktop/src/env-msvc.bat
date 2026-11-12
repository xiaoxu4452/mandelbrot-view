@echo off
rem ---------------------------------------------------------------------------
rem env-msvc.bat - set the compiler environment WITHOUT vcvars64.bat.
rem
rem vcvars shells out to `reg.exe`, which is blocked on this machine, so it
rem returns success while leaving INCLUDE/LIB empty (the first failure is then
rem "cannot open crtdbg.h").  The toolchain here is a single known MSVC + SDK
rem pair, so the paths are spelled out instead of discovered.
rem ---------------------------------------------------------------------------
set "VSDIR=C:\Program Files\Microsoft Visual Studio\18\Community"
set "MSVCVER=14.51.36231"
set "SDKVER=10.0.26100.0"
set "SDKROOT=C:\Program Files (x86)\Windows Kits\10"

if not exist "%VSDIR%\VC\Tools\MSVC\%MSVCVER%\bin\Hostx64\x64\cl.exe" (
  echo [env] MSVC %MSVCVER% not found under %VSDIR%
  exit /b 1
)

set "PATH=%VSDIR%\VC\Tools\MSVC\%MSVCVER%\bin\Hostx64\x64;%SDKROOT%\bin\%SDKVER%\x64;%VSDIR%\Common7\IDE;%PATH%"
set "INCLUDE=%VSDIR%\VC\Tools\MSVC\%MSVCVER%\include;%SDKROOT%\Include\%SDKVER%\ucrt;%SDKROOT%\Include\%SDKVER%\um;%SDKROOT%\Include\%SDKVER%\shared;%SDKROOT%\Include\%SDKVER%\winrt;%SDKROOT%\Include\%SDKVER%\cppwinrt"
set "LIB=%VSDIR%\VC\Tools\MSVC\%MSVCVER%\lib\x64;%SDKROOT%\Lib\%SDKVER%\ucrt\x64;%SDKROOT%\Lib\%SDKVER%\um\x64"
exit /b 0
