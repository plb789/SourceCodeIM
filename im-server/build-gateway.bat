@echo off
chcp 65001 >nul
title im-gateway 一键编译（Windows + Linux）
setlocal
cd /d "%~dp0"

echo ============================================
echo   im-gateway 一键编译（Windows + Linux）
echo ============================================
echo.

where go >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 go 命令，请先安装 Go 并加入 PATH
    pause
    exit /b 1
)

echo [1/2] 编译 Windows 版 ...
go build -trimpath -ldflags "-s -w" -o bin\im-gateway.exe .\gateway
if errorlevel 1 (
    echo.
    echo [错误] Windows 版编译失败，请检查上方报错
    pause
    exit /b 1
)
echo        OK: bin\im-gateway.exe

rem 交叉编译 Linux 版（静态无依赖，商户部署包直接收录；setlocal 保证 GOOS/GOARCH 不污染当前窗口）
echo [2/2] 交叉编译 Linux 版（amd64）...
set "CGO_ENABLED=0"
set "GOOS=linux"
set "GOARCH=amd64"
go build -trimpath -ldflags "-s -w" -o bin\im-gateway-linux .\gateway
if errorlevel 1 (
    echo.
    echo [错误] Linux 版编译失败，请检查上方报错
    pause
    exit /b 1
)
echo        OK: bin\im-gateway-linux

echo.
echo ============================================
echo   编译完成，产物：
echo ============================================
dir /b bin\im-gateway*
echo.
echo 提示：2008R2 兼容版请另跑 build-gateway-2008r2.bat；
echo       Linux ARM 版请另跑 build-gateway-linux.bat arm64。
echo.
pause
exit /b 0
