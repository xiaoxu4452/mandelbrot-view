@echo off
chcp 65001 >nul
title MANDELBROT 精密分形观测台
cd /d "%~dp0"
echo.
echo   MANDELBROT · 精密分形观测台 / Precision Fractal Observatory
echo   ---------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   未找到 Node.js 18+，无法启动本地服务。
  echo   Node.js 18+ is required: https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo   [1/2] 本地渲染核心 / render core  -^>  http://127.0.0.1:8778
start "MANDELBROT render core" /min node "%~dp0server\render-server.mjs"
echo   [2/2] 静态页面服务 / static page  -^>  http://127.0.0.1:8777
start "MANDELBROT page" /min node "%~dp0server\static-server.mjs"
timeout /t 1 >nul
start "" http://127.0.0.1:8777/index.html
echo.
echo   两个服务已在后台运行，关闭对应窗口即停止。
echo   Both servers run in the background; close their windows to stop them.
timeout /t 3 >nul
