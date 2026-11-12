@echo off
setlocal
set "SRC=%~dp0"
call "%SRC%env-msvc.bat" || exit /b 1
set "L=%SRC%third_party\lcms2"
set "OBJ=%SRC%build\lcms2-msvc"
if not exist "%OBJ%" mkdir "%OBJ%"
cl /nologo /O2 /MT /TC /DNDEBUG /D_CRT_SECURE_NO_WARNINGS ^
  /I "%L%\include" /I "%L%\src" /Fo"%OBJ%\\" /c "%L%\src\*.c" || exit /b 1
lib /nologo /out:"%L%\lib\lcms2.lib" "%OBJ%\*.obj" || exit /b 1
echo [lcms2-msvc] OK
if not exist "%SRC%..\..\desktop\src\third_party\lcms2\lib" mkdir "%SRC%..\..\desktop\src\third_party\lcms2\lib"
copy /Y "%L%\lib\lcms2.lib" "%SRC%..\..\desktop\src\third_party\lcms2\lib\lcms2.lib" >nul
endlocal
