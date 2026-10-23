@echo off
chcp 65001 >nul
title im-gateway 2008R2 兼容版一键编译
cd /d "%~dp0"

echo ============================================
echo   im-gateway 2008R2 兼容版一键编译
echo ============================================
echo.
echo 说明：Server2008R2/2012 需 Go 1.20 编译（Go 1.21+ 运行时已不支持该系统），
echo       本脚本使用独立 Go 1.20.14 工具链与 gateway-legacy 源码目录，不影响现有 Go 安装。
echo.

set "GOTOOLS=%LOCALAPPDATA%\go1.20.14"
set "GOROOT=%GOTOOLS%\go"
set "GOBIN=%GOROOT%\bin"
set "GOCACHE=%LOCALAPPDATA%\go1.20-build-cache"
set "CGO_ENABLED=0"

rem [0/3] 工具链检查：无则自动下载官方 Go 1.20.14 zip 并解压（不影响已安装的 Go）
if exist "%GOBIN%\go.exe" goto tools_ok
echo [0/3] 未找到 Go 1.20.14 工具链，开始自动下载（约 95MB，仅首次）...
set "ZIP=%TEMP%\go1.20.14.windows-amd64.zip"
if exist "%ZIP%" del "%ZIP%"
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri 'https://go.dev/dl/go1.20.14.windows-amd64.zip' -OutFile '%ZIP%' -UseBasicParsing"
if errorlevel 1 goto dl_fail
echo        下载完成，解压中...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%GOTOOLS%' -Force"
if errorlevel 1 goto unzip_fail
del "%ZIP%" 2>nul
if not exist "%GOBIN%\go.exe" goto inst_fail
:tools_ok
"%GOBIN%\go.exe" version
echo        OK: %GOROOT%
echo.

if not exist "gateway-legacy\go.mod" goto nodir

rem [1/1] 在 gateway-legacy（独立 module，go 1.20 + 依赖钉版）内编译
echo [1/1] 编译 2008R2 兼容版（Windows amd64）...
pushd gateway-legacy
"%GOBIN%\go.exe" build -ldflags "-s -w" -o "..\bin\im-gateway-2008r2.exe" .
if errorlevel 1 (
    popd
    echo.
    echo [错误] 2008R2 兼容版编译失败，请检查上方报错
    echo        提示：依赖版本被改动会破坏 go1.20 兼容（go.mod 已钉版，勿升级）
    pause
    exit /b 1
)
popd
echo        OK: bin\im-gateway-2008r2.exe
echo.
echo        部署：本 exe 与 gateway.yaml 拷到 Server2008R2/2012 机器同目录运行；
echo        功能与主版本一致（隧道+写库+Web后台），配置文件通用。
echo.

echo ============================================
echo   编译完成，全部网关产物：
echo ============================================
dir /b bin\im-gateway*
echo.
pause
exit /b 0

:dl_fail
echo.
echo [错误] 工具链下载失败，请检查网络后重试（或手动从 go.dev/dl 下载
echo        go1.20.14.windows-amd64.zip 解压到 %GOTOOLS%\go）
pause
exit /b 1

:unzip_fail
echo.
echo [错误] 工具链解压失败
pause
exit /b 1

:inst_fail
echo.
echo [错误] 工具链安装异常（未找到 %GOBIN%\go.exe）
pause
exit /b 1

:nodir
echo.
echo [错误] 未找到 gateway-legacy 源码目录（%cd%\gateway-legacy）
pause
exit /b 1
