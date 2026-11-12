@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Generate OpenCL.lib from the system ICD's export table.
rem Run once when the SDK tree is installed; the result is checked in under
rem third_party/khronos/lib/x64 so CI / other machines need no OpenCL SDK.
rem ---------------------------------------------------------------------------
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
set "KH=%SRC%third_party\khronos"
if not exist "%SRC%build" mkdir "%SRC%build"
if not exist "%KH%\lib\x64" mkdir "%KH%\lib\x64"

echo [ocl] reading ICD exports...
dumpbin /nologo /exports "%WINDIR%\System32\OpenCL.dll" /out:"%SRC%build\opencl-exports.txt" >nul || exit /b 1
python "%SRC%tools\gen-opencl-def.py" "%SRC%build\opencl-exports.txt" "%SRC%build\OpenCL.def" || exit /b 1
lib /nologo /def:"%SRC%build\OpenCL.def" /machine:x64 /out:"%KH%\lib\x64\OpenCL.lib" || exit /b 1

rem Keep the git-tracked mirror in sync with the shipping tree.
set "MIRROR=%SRC%..\..\desktop\src\third_party\khronos\lib\x64"
if not exist "%MIRROR%" mkdir "%MIRROR%"
copy /Y "%KH%\lib\x64\OpenCL.lib" "%MIRROR%\OpenCL.lib" >nul
echo [ocl] OK: %KH%\lib\x64\OpenCL.lib
endlocal
