@echo off
chcp 65001 >nul
title im-gateway Linux 版一键编译
setlocal
cd /d "%~dp0"

echo ============================================
echo   im-gateway Linux 版一键编译
echo ============================================
echo.
echo 说明：交叉编译 Linux 网关（源码 gateway\，隧道+写库+Web 后台，配置文件与 Windows 版通用）。
echo       静态无依赖（CGO_ENABLED=0），上传服务器即可运行；默认 amd64，传参 arm64 可编译 ARM 版。

rem 架构参数：默认 amd64，可传 arm64
set "GOARCH=amd64"
if /i "%~1"=="arm64" set "GOARCH=arm64"

rem setlocal 保证 GOOS/GOARCH/CGO 退出后自动恢复，不污染当前窗口
set "CGO_ENABLED=0"
set "GOOS=linux"

where go >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 未找到 go 命令，请先安装 Go 并加入 PATH
    pause
    exit /b 1
)
if not exist "gateway\main.go" goto nodir

rem 输出名：arm64 带后缀区分，amd64 沿用既有命名（与 build-gateway.bat linux 产物一致）
set "OUT=bin\im-gateway-linux"
if /i "%GOARCH%"=="arm64" set "OUT=bin\im-gateway-linux-arm64"

echo.
echo [1/1] 交叉编译 Linux (%GOARCH%) 版网关...
go build -trimpath -ldflags "-s -w" -o "%OUT%" .\gateway
if errorlevel 1 (
    echo.
    echo [错误] Linux 版网关编译失败，请检查上方报错
    pause
    exit /b 1
)

echo.
echo ============================================
echo   编译完成
echo ============================================
for %%F in ("%OUT%") do echo 产物: %~dp0%OUT%  ^(%%~zF 字节, %GOARCH%^)
echo 部署三步：
echo   1. 上传 im-gateway-linux 到服务器任意目录（如 /opt/im-gateway/），chmod +x im-gateway-linux
echo   2. 同目录放 gateway.yaml（可从 Windows 版部署包取模板；token_secret 与
echo      平台「网关地址簿」条目一致，Linux 上建议加 admin_password 以启用本机管理后台）
echo   3. ./im-gateway-linux 启动（建议注册 systemd 服务开机自启）；
echo      管理后台 admin_listen 仅监听本机，远程用 SSH 隧道访问
echo 提示：chmod 前请勿用文本方式 FTP 传输（会破坏二进制），用二进制方式或 scp/sftp。
echo.
pause
exit /b 0

:nodir
echo.
echo [错误] 未找到网关源码目录（%cd%\gateway）
pause
exit /b 1
