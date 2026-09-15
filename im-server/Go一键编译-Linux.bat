@echo off
title Go im-server (Linux)
setlocal
cd /d "%~dp0"

rem 架构参数：默认 amd64，可传入 arm64
set GOARCH=amd64
if /i "%~1"=="arm64" set GOARCH=arm64

rem 交叉编译 Linux 版：禁用 CGO，setlocal 保证退出后环境变量自动恢复，不污染当前窗口
set CGO_ENABLED=0
set GOOS=linux

if not exist bin-linux mkdir bin-linux

echo [1/1] 正在编译 Linux (%GOARCH%) 版 im-server...
go build -ldflags "-s -w" -o bin-linux\im-server main.go
if %errorlevel% neq 0 (
    echo 编译失败！请检查上方错误信息。
    pause
    exit /b 1
)

echo.
echo ========================================
echo 编译成功！
echo - 输出文件: %~dp0bin-linux\im-server (%GOARCH%)
echo - 上传到 Linux 服务器后先执行: chmod +x im-server
echo - 部署时需将 bin 目录下的 config.yaml 一并复制到同目录
echo - 启动方式: ./im-server （需在 im-server 根目录下运行）
echo ========================================
pause
