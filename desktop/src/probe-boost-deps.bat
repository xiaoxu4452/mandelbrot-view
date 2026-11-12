@echo off
setlocal
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
cl /nologo /showIncludes /EHsc /std:c++17 /I "%SRC%third_party" /c "%SRC%gpu\probe_boost.cpp" /Fo"%SRC%build\probe_boost.obj" > "%SRC%build\boost-includes.txt" 2>&1
echo RC=%ERRORLEVEL%
endlocal
