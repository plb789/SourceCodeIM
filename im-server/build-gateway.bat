@echo off
chcp 65001 >nul
title im-gateway 一键编译
cd /d "%~dp0"

echo ============================================
echo   im-gateway 一键编译
echo ============================================
echo.

where go >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 go 命令，请先安装 Go 并加入 PATH
    pause
    exit /b 1
)

echo [1/2] 编译 Windows 版 ...
go build -ldflags "-s -w" -o bin\im-gateway.exe .\gateway
if errorlevel 1 (
    echo.
    echo [错误] Windows 版编译失败，请检查上方报错
    pause
    exit /b 1
)
echo        OK: bin\im-gateway.exe

if /i "%~1"=="linux" (
    echo [2/2] 交叉编译 Linux 版（amd64，静态无依赖，可直接上传服务器运行）...
    set GOOS=linux
    set GOARCH=amd64
    set CGO_ENABLED=0
    go build -ldflags "-s -w" -o bin\im-gateway-linux .\gateway
    if errorlevel 1 (
        echo.
        echo [错误] Linux 版编译失败，请检查上方报错
        pause
        exit /b 1
    )
    echo        OK: bin\im-gateway-linux
) else (
    echo [2/2] 跳过 Linux 版（部署 Linux 网关时运行: build-gateway.bat linux）
)

echo.
echo ============================================
echo   编译完成，产物：
echo ============================================
dir /b bin\im-gateway*
echo.
pause
