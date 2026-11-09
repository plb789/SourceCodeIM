@echo off
chcp 65001 >nul
title im-gateway Linux ARM64 版一键编译
setlocal
cd /d "%~dp0"

echo ============================================
echo   im-gateway Linux ARM64 版一键编译
echo ============================================
echo.
echo 说明：交叉编译 Linux ARM64 网关（源码 gateway\，隧道+写库+Web 后台）。
echo       静态无依赖（CGO_ENABLED=0），上传服务器 chmod +x 即可运行。

set "CGO_ENABLED=0"
set "GOOS=linux"
set "GOARCH=arm64"

where go >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 未找到 go 命令，请先安装 Go 并加入 PATH
    pause
    exit /b 1
)
if not exist "gateway\main.go" goto nodir

set "OUT=bin\im-gateway-linux-arm64"

echo.
echo [1/1] 交叉编译 Linux ARM64 版网关...
go build -trimpath -ldflags "-s -w" -o "%OUT%" .\gateway
if errorlevel 1 (
    echo.
    echo [错误] Linux ARM64 版编译失败，请检查上方报错
    pause
    exit /b 1
)

echo.
echo ============================================
echo   编译完成
echo ============================================
for %%F in ("%OUT%") do echo 产物: %~dp0%OUT%  ^(%%~zF 字节^)
echo.
echo 部署：上传到服务器 chmod +x im-gateway-linux-arm64，
echo       同目录放 gateway.yaml，./im-gateway-linux-arm64 启动。
echo.
pause
exit /b 0

:nodir
echo.
echo [错误] 未找到网关源码目录（%cd%\gateway）
pause
exit /b 1
