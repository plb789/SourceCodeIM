@echo off
chcp 936 >nul
setlocal
rem ============================================
rem 即时通讯 PC 客户端 dev 启动脚本（阶段一百四十四）
rem 流程：检查 Node -> 按需安装依赖 -> 关闭旧实例 -> electron 直载源码 main.js
rem 说明：dev 模式不走 app.asar 加密壳（loader.js 对 dev 明文直跑），改完 pc\*.js 重开本脚本即生效；
rem       web 界面资源经 SERVER_URL 直读 im-client\web\ 源码目录，改前端刷新即生效
rem 用法：双击运行，或在任意目录执行本脚本（路径自动取脚本所在目录，无硬编码）
rem ============================================

cd /d "%~dp0"

rem npmmirror 镜像加速（electron 二进制下载，与 build.bat 同源）
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo [1/4] 检查 Node 环境...
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20 或更高版本
    pause
    exit /b 1
)

echo [2/4] 准备依赖（node_modules 缺失时自动安装，首次约数分钟）...
if not exist "%~dp0node_modules\electron" (
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
) else (
    echo 依赖已就绪（node_modules\ 已存在，跳过安装）
)

echo [3/4] 关闭已运行的打包版客户端（避免单实例锁互踢）...
taskkill /f /t /im im-client.exe >nul 2>nul

echo [4/4] 启动 dev 客户端（明文入口 main.js，关闭窗口即退出）...
call npx electron main.js

rem electron 退出后暂停，便于查看启动报错/主进程异常输出
echo.
echo dev 客户端已退出（退出码 %errorlevel%）
pause
