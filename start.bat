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
rem 允许局域网通过本机 IP（如 http://192.168.x.x:5210）访问；如仅本机访问，注释掉下一行即可
set WORKTREE_MANAGER_HOST=0.0.0.0
echo 服务地址: http://127.0.0.1:5210 （本机）；局域网访问: http://%COMPUTERNAME%:5210 或本机 IP:5210
echo Ctrl+C 停止
echo.
start "" http://127.0.0.1:5210
node server\src\server.js
pause
