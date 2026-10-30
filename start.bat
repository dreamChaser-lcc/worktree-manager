@echo off
chcp 65001 >nul
cd /d %~dp0
title Worktree Manager

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Git，请先安装 Git。
  pause
  exit /b 1
)

if not exist "server\node_modules" (
  echo 首次运行：安装服务端依赖...
  call npm --prefix server install
)
if not exist "web\node_modules" (
  echo 首次运行：安装前端依赖...
  call npm --prefix web install
)
if not exist "web\dist" (
  echo 首次运行：构建前端...
  call npm --prefix web run build
)

echo.
echo 服务地址: http://127.0.0.1:5210 （仅本机可访问，Ctrl+C 停止）
echo.
start "" http://127.0.0.1:5210
node server\src\server.js
pause
