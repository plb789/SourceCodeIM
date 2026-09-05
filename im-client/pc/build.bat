@echo off
chcp 65001 >nul
setlocal
rem ============================================
rem 即时通讯 PC 端一键打包脚本（阶段三十七）
rem 流程：关闭旧进程 -> 安装依赖 -> electron-builder 打包 -> 部署到 im-client\bin\
rem 用法：双击运行，或在任意目录执行本脚本（路径均相对脚本所在目录，无硬编码）
rem ============================================

cd /d "%~dp0"

rem npmmirror 镜像加速（electron 与打包工具二进制下载）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

set "BIN_DIR=%~dp0..\bin"
set "UNPACKED_DIR=%~dp0dist\win-unpacked"

echo [1/4] 检查 Node 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本
    pause
    exit /b 1
)

echo [2/4] 安装依赖（首次较慢，之后秒级）...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
)

echo [3/4] 打包 win-unpacked...
call npx electron-builder --win --x64 --dir
if errorlevel 1 (
    echo [错误] 打包失败，请查看上方日志
    pause
    exit /b 1
)

echo [4/4] 部署到 im-client\bin ...
rem 先关闭正在运行的客户端，避免 exe 被占用导致清理失败（进程不存在时静默跳过）
taskkill /f /im im-client.exe >nul 2>nul
rem 删除旧 bin：杀毒软件对新 exe 的瞬时扫描锁可能导致单次删除失败，最多重试 5 次
set /a TRY=0
:RETRY_DEL
if not exist "%BIN_DIR%" goto DEL_OK
set /a TRY+=1
if %TRY% gtr 5 (
    echo [错误] 旧 bin 目录无法删除，请手动关闭 im-client.exe 后重试
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
rd /s /q "%BIN_DIR%" >nul 2>nul
goto RETRY_DEL
:DEL_OK
mkdir "%BIN_DIR%"
xcopy "%UNPACKED_DIR%\*" "%BIN_DIR%\" /e /y /q >nul
ren "%BIN_DIR%\即时通讯.exe" "im-client.exe"
if not exist "%BIN_DIR%\im-client.exe" (
    echo [错误] 部署失败，请检查 %BIN_DIR% 目录
    pause
    exit /b 1
)

echo.
echo [完成] 已生成 im-client\bin\im-client.exe（含最新主进程与 preload）
echo.
pause
